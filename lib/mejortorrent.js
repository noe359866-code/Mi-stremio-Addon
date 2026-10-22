/**
 * lib/mejortorrent.js
 * ---------------------------------------------------------------------------
 * Scraper e integración dedicada para https://www47.mejortorrent.eu/ (MejorTorrent)
 *
 * Estructura verificada directamente contra el sitio en vivo:
 *  1. Rotación de subdominios numerados (`www47.mejortorrent.eu`, `www46`,
 *     `www45`, `www44`, `www43`):
 *     - El dominio raíz `https://mejortorrent.eu/` sin subdominio falla al
 *       conectar; el sitio opera mediante subdominios `wwwNN.mejortorrent.eu`.
 *     - `isSameMejorTorrentHost` normaliza `www\d*.` para conservar enlaces
 *       absolutos tras redirecciones 301 entre espejos numerados.
 *  2. Búsqueda (`GET /busqueda?q={query}`):
 *     - Sanea caracteres fuera de Latin-1 (`> \u00FF`) para evitar HTTP 500
 *       en el buscador del sitio.
 *     - Agrupa múltiples fichas por calidad: cada calidad de una película
 *       (`/pelicula/{id}/{slug}`) y cada temporada+calidad de una serie
 *       (`/serie/{id}/{subid}/{slug}`, p. ej. `2ª Temporada [1080p]`) es una
 *       página independiente. El scraper filtra por `seasonHint` y resuelve
 *       en paralelo todas las calidades de la película o temporada pedida.
 *  3. Tablas de episodios (`tr.border`: `ID | Episodios | Fecha | Clave | Download`):
 *     - Soporta episodios simples (`1x05`), listas (`2x01 - 2x02.`), rangos
 *       (`2x01 al 2x13.`, `1x04 - 05.`), temporadas completas y `[Cap.105]`.
 *     - Detecta la columna `Clave`: conserva `Sin clave` y descarta archivos
 *       RAR protegidos con contraseña que Stremio no puede reproducir.
 *  4. Descarga directa `/torrents/{peliculas,series,documentales}/*.torrent`:
 *     - Extrae `infoHash` SHA-1, tamaño real exacto desde Bencode, trackers y
 *       `fileIdx` del capítulo pedido dentro de rangos/packs multifile.
 * ---------------------------------------------------------------------------
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const R = require('./release');
const { timeout } = require('./timeouts');
const {
  normalizeTitle,
  parseSeasonEpisode,
  rankCandidates,
  pickBestMatch,
  scoreCandidate,
  torrentSeasonEpisode,
  torrentMatchesEpisode
} = require('./match');
const {
  VIDEO_FILE_RE,
  isTorrentBuffer,
  parseTorrentBuffer,
  selectFileIdxForEpisode,
  selectLargestVideoFileIdx
} = require('./bencode');
const {
  withKeepAlive,
  isTransientNetworkError,
  sleep,
  lruGet,
  lruSet,
  withSingleFlight
} = require('./http');

const BASE_URL = (
  process.env.MEJORTORRENT_BASE_URL ||
  process.env.MEJORTORRENT_URL ||
  'https://www47.mejortorrent.eu'
).replace(/\/+$/, '');

const DEFAULT_MIRRORS = [
  'https://www47.mejortorrent.eu',
  'https://www46.mejortorrent.eu',
  'https://www45.mejortorrent.eu',
  'https://www44.mejortorrent.eu',
  'https://www43.mejortorrent.eu'
];

const EXTRA_MIRRORS = (process.env.MEJORTORRENT_MIRRORS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

const DETAIL_PATH_RE = /^\/(pelicula|serie|documental)\/(\d+(?:\/\d+)?\/[^/?#]+)\/?$/i;
const EXCLUDED_PATH_RE = /^\/(?:musica|juegos|variados|programas|torrents|busqueda|estrenos|contacto|legal)(?:\/|$)/i;
const ARCHIVE_ONLY_RE = /\.(rar|zip|7z|iso|tar|gz)$/i;

const CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000;
const TORRENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const searchCache = new Map();
const detailCache = new Map();
const torrentCache = new Map();
const inFlight = new Map();

let activeMirror = null;
let activeMirrorExp = 0;

function getMirrorPool() {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    const clean = String(u || '').trim().replace(/\/+$/, '');
    if (!clean || !/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    // Evitar el dominio desnudo mejortorrent.eu que rechaza conexión
    if (/^https?:\/\/mejortorrent\.eu$/i.test(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  if (activeMirror && activeMirrorExp > Date.now()) push(activeMirror);
  push(BASE_URL);
  for (const m of EXTRA_MIRRORS) push(m);
  for (const m of DEFAULT_MIRRORS) push(m);
  return out;
}

function clearCache() {
  searchCache.clear();
  detailCache.clear();
  torrentCache.clear();
  inFlight.clear();
  activeMirror = null;
  activeMirrorExp = 0;
}

// ---------------------------------------------------------------------------
// 1. NORMALIZACIÓN DE DOMINIO, CONSULTAS, TÍTULOS Y EPISODIOS
// ---------------------------------------------------------------------------

function normalizeMejorHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\d*\./i, '');
}

/**
 * Compara dos URLs aceptando rotación `wwwNN.mejortorrent.eu`.
 */
function isSameMejorTorrentHost(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    if (!/^https?:$/i.test(a.protocol) || !/^https?:$/i.test(b.protocol)) return false;
    return normalizeMejorHost(a.hostname) === normalizeMejorHost(b.hostname);
  } catch {
    return false;
  }
}

/**
 * Sanea la consulta para `/busqueda?q=...`:
 * MejorTorrent devuelve HTTP 500 si recibe caracteres fuera de `\u0001-\u00FF`
 * y sólo espera el título base sin `S02E05`.
 */
function sanitizeSearchQuery(raw) {
  return String(raw || '')
    .replace(/\b[Ss]\d{1,2}[Ee]\d{1,3}\b/g, ' ')
    .replace(/\b(?:espa[ñn]ol|spanish|castellano|spa)\b/gi, ' ')
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, ' ')
    .replace(/[^\u0001-\u00FF]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function urlToSlug(urlOrSlug) {
  const raw = String(urlOrSlug || '').trim().replace(/^mt:/i, '');
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch { return null; }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (EXCLUDED_PATH_RE.test(pathname)) return null;

  const m = pathname.match(DETAIL_PATH_RE);
  if (!m) return null;
  return `${m[1].toLowerCase()}/${m[2].replace(/\/+$/, '')}`;
}

function slugToUrl(slug, baseUrl = BASE_URL) {
  const clean = urlToSlug(slug);
  if (!clean) return null;
  return `${String(baseUrl || BASE_URL).replace(/\/+$/, '')}/${clean}`;
}

function normalizeMejorQuality(rawQuality, fallbackText = '') {
  const combined = `${rawQuality || ''} ${fallbackText || ''}`.trim();
  if (!combined) return '720p';
  const detected = R.calidadDeNombre(combined);
  if (detected) return detected;
  if (/\b(4k|2160p|uhd)\b/i.test(combined)) return '4K';
  if (/\b(1080p|microhd|fullbluray|bdremux|bluray[\s-]*1080)\b/i.test(combined)) return '1080p';
  if (/\b(720p|bluray[\s-]*720|hdtv[\s-]*720)\b/i.test(combined)) return '720p';
  if (/\b(hdrip|bdrip|brrip)\b/i.test(combined)) return '720p';
  if (/\b(dvdrip|dvdr|xvid|hdtv|480p|screener|ts)\b/i.test(combined)) return '480p';
  return '720p';
}

function normalizeMejorLanguage(textHint = '') {
  const s = String(textHint || '');
  if (/\b(dual|multi|es-en)\b/i.test(s)) return 'Latino/Inglés';
  if (/\blatino\b/i.test(s)) return 'Latino';
  if (/\b(vose|subtitulad[oa]|subs?\.?\s*integrados)\b/i.test(s)) return 'Inglés';
  return 'Castellano';
}

/**
 * Limpia el título de búsqueda o ficha de MejorTorrent extrayendo título base,
 * temporada (`seasonHint`), calidad e idioma.
 * Ejemplos reales:
 *   "Bad Apples [4K] (4K)" -> { titulo: "Bad Apples", calidad: "4K", seasonHint: null }
 *   "Breaking Bad - 2ª Temporada [1080p] (HDTV-1080p)" -> { titulo: "Breaking Bad", seasonHint: 2, calidad: "1080p" }
 */
function parseMejorTitle(rawTitle, rawQuality = '', slug = '') {
  let text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (text.endsWith('.')) text = text.slice(0, -1).trim();

  let seasonHint = null;
  const seasonMatch = text.match(/(\d{1,2})\s*(?:ª|a|º)?\s*temporada/i) ||
    text.match(/temporada\s*(\d{1,2})/i) ||
    String(slug || '').match(/(?:^|-)(\d{1,2})a?-temporada(?:-|$)/i);
  if (seasonMatch) seasonHint = parseInt(seasonMatch[1], 10);

  let año = null;
  const yearMatch = text.match(/[\[(](19\d{2}|20\d{2})[\])]/);
  if (yearMatch) año = yearMatch[1];

  const idioma = normalizeMejorLanguage(`${text} ${rawQuality}`);
  const calidad = normalizeMejorQuality(rawQuality, `${text} ${slug}`);

  let clean = text
    .replace(/\s*-\s*\d{1,2}\s*(?:ª|a|º)?\s*temporada.*$/i, '')
    .replace(/\s*-\s*temporada\s*\d{1,2}.*$/i, '')
    .replace(/\s*\(\d{1,2}\s*(?:ª|a|º)?\s*temporada[^)]*\)/gi, '')
    .replace(/[\[(](?:4k|2160p|uhd|1080p?|720p?|480p?|hdrip|dvdrip|bdrip|microhd(?:-\d+p)?|bluray(?:-\d+p)?|fullbluray|hdtv(?:-\d+p)?|3d|dual|latino|vose|subs?\.?\s*integrados|19\d{2}|20\d{2})[\])]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.endsWith('.')) clean = clean.slice(0, -1).trim();

  return {
    titulo: clean || text,
    año,
    seasonHint,
    calidad,
    idioma
  };
}

/**
 * Verifica si el valor de `Clave` (o texto del episodio) indica contraseña RAR.
 * `"Sin clave"`, `""`, `"N/A"` o `"-"` significan archivo libre sin cifrar.
 */
function hasRarPassword(claveText = '', episodeText = '') {
  if (/contrase[ñn]a\s*:/i.test(String(episodeText || ''))) return true;
  const clean = String(claveText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (/^(?:sin\s+clave|n\/?a|-|ninguna|no|free)$/i.test(clean)) return false;
  return true;
}

/**
 * Parsea la celda `Episodios` de MejorTorrent:
 *   "2x01 al 2x13."            -> { season: 2, episode: null, episodes: [1..13], esPack: true }
 *   "5x08 al 5x13."            -> { season: 5, episode: 8, episodes: [8..13], esPack: false }
 *   "2x01 - 2x02 - 2x03."      -> { season: 2, episode: 1, episodes: [1, 2, 3], esPack: false }
 *   "1x04 - 05."               -> { season: 1, episode: 4, episodes: [4, 5], esPack: false }
 *   "Temporada 1 Completa"     -> { season: 1, episode: null, episodes: [], esPack: true }
 *   "1x05" / "[Cap.105]"       -> { season: 1, episode: 5, episodes: [5], esPack: false }
 */
function parseMejorEpisodeCell(cellText, torrentHref = '', fallbackSeason = null) {
  const raw = String(cellText || '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const combined = `${raw} ${decodeURIComponent(String(torrentHref || ''))}`;

  if (/\btemporada\s*(\d{1,2})\s*completa\b/i.test(raw) || /^completa$/i.test(raw)) {
    const m = raw.match(/temporada\s*(\d{1,2})/i);
    return {
      season: m ? parseInt(m[1], 10) : fallbackSeason,
      episode: null,
      episodes: [],
      esPack: true
    };
  }

  // Rango con "al": "2x01 al 2x13" o "2x01 al 13"
  const rangeMatch = raw.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})\s+al\s+(?:\d{1,2}\s*[xX×]\s*)?(\d{1,3})\b/i);
  if (rangeMatch) {
    const season = parseInt(rangeMatch[1], 10);
    const startEp = parseInt(rangeMatch[2], 10);
    const endEp = parseInt(rangeMatch[3], 10);
    if (endEp >= startEp && endEp - startEp <= 60) {
      const episodes = [];
      for (let e = startEp; e <= endEp; e++) episodes.push(e);
      const esPack = startEp === 1 && episodes.length >= 6;
      return {
        season,
        episode: esPack ? null : startEp,
        episodes,
        esPack
      };
    }
  }

  // Lista explícita de varios NxMM: "2x01 - 2x02 - 2x03"
  const multiMatches = [...raw.matchAll(/(\d{1,2})\s*[xX×]\s*(\d{1,3})/g)];
  if (multiMatches.length > 1) {
    const season = parseInt(multiMatches[0][1], 10);
    const episodes = [...new Set(multiMatches.map(m => parseInt(m[2], 10)).filter(Number.isFinite))];
    return {
      season,
      episode: episodes[0] ?? null,
      episodes,
      esPack: false
    };
  }

  // Par corto "1x04 - 05"
  const shortPair = raw.match(/^(\d{1,2})\s*[xX×]\s*(\d{1,3})\s*[-–/]\s*(\d{1,3})$/);
  if (shortPair) {
    const season = parseInt(shortPair[1], 10);
    const ep1 = parseInt(shortPair[2], 10);
    const ep2 = parseInt(shortPair[3], 10);
    const episodes = [];
    if (ep2 >= ep1 && ep2 - ep1 <= 10) {
      for (let e = ep1; e <= ep2; e++) episodes.push(e);
    } else {
      episodes.push(ep1, ep2);
    }
    return { season, episode: ep1, episodes, esPack: false };
  }

  // Episodio simple "1x05" o "1x05 - Título"
  if (multiMatches.length === 1) {
    const season = parseInt(multiMatches[0][1], 10);
    const episode = parseInt(multiMatches[0][2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  // Respaldo por nombre del archivo .torrent: "[Cap.105]" o "Cap.1204"
  const capMatch = combined.match(/\[?Cap\.?\s*(\d{1,2})(\d{2})\]?/i);
  if (capMatch) {
    const season = parseInt(capMatch[1], 10);
    const episode = parseInt(capMatch[2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  const parsed = parseSeasonEpisode(combined);
  if (parsed.season !== null || parsed.episode !== null || parsed.isPack) {
    return {
      season: parsed.season ?? fallbackSeason,
      episode: parsed.episode,
      episodes: parsed.episodes || (parsed.episode !== null ? [parsed.episode] : []),
      esPack: Boolean(parsed.isPack)
    };
  }

  return { season: fallbackSeason, episode: null, episodes: [], esPack: false };
}

function resolveMejorDownloadUrl(href, pageUrl, baseUrl = BASE_URL) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null;
  if (/^magnet:\?xt=urn:btih:/i.test(raw)) return raw;

  try {
    const resolved = new URL(raw, pageUrl || baseUrl);
    if (!isSameMejorTorrentHost(resolved.toString(), pageUrl || baseUrl)) return null;
    if (!/\.torrent(?:[?#]|$)/i.test(resolved.pathname) && !/^\/torrents\//i.test(resolved.pathname)) {
      return null;
    }
    // Reescribir al espejo activo para evitar subdominios caídos
    const active = new URL(baseUrl);
    resolved.protocol = active.protocol;
    resolved.host = active.host;
    return resolved.toString();
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / (1024 ** 2);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function buildMagnet(infoHash, displayName, trackers = []) {
  const hash = String(infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  const parts = [`magnet:?xt=urn:btih:${hash}`];
  if (displayName) parts.push(`dn=${encodeURIComponent(String(displayName).trim())}`);
  const seen = new Set();
  for (const tr of [...trackers, ...(R.TRACKERS || [])]) {
    const clean = String(tr || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    parts.push(`tr=${encodeURIComponent(clean)}`);
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// 2. PARSERS HTML (BÚSQUEDA `/busqueda?q=...` Y FICHA DE DETALLE)
// ---------------------------------------------------------------------------

function parseSearchHtml(html, { baseUrl = BASE_URL, filterType = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  $('a[href]').each((_, el) => {
    const $a = $(el);
    if ($a.closest('nav, header, footer').length > 0) return;
    const href = $a.attr('href') || '';
    const slug = urlToSlug(href);
    if (!slug || seenSlugs.has(slug)) return;

    const esSerie = slug.startsWith('serie/') || slug.startsWith('documental/');
    const tipo = esSerie ? 'serie' : 'pelicula';
    if (filterType === 'series' && !esSerie) return;
    if (filterType === 'movie' && esSerie) return;

    const fullText = $a.text().replace(/\s+/g, ' ').trim();
    if (!fullText) return;

    // En MejorTorrent la calidad va dentro de un <span> o paréntesis final: "Bad Apples (BluRay-1080p)"
    let qualitySpan = $a.find('span').last().text().trim();
    let titlePart = fullText;
    if (qualitySpan && titlePart.endsWith(qualitySpan)) {
      titlePart = titlePart.slice(0, titlePart.length - qualitySpan.length).trim();
    } else {
      const parenMatch = fullText.match(/\(([^()]+)\)\s*$/);
      if (parenMatch) {
        qualitySpan = parenMatch[1].trim();
        titlePart = fullText.slice(0, parenMatch.index).trim();
      }
    }

    const parsed = parseMejorTitle(titlePart, qualitySpan, slug);
    if (!parsed.titulo) return;

    seenSlugs.add(slug);
    results.push({
      id: `mt:${slug}`,
      slug,
      url: slugToUrl(slug, baseUrl),
      titulo: parsed.titulo,
      tituloOriginal: null,
      año: parsed.año,
      tipo,
      seasonHint: parsed.seasonHint,
      calidad: parsed.calidad,
      calidadRaw: qualitySpan || null,
      idioma: parsed.idioma
    });
  });

  return results;
}

function parseDetailHtml(html, { slug = '', url = '', baseUrl = BASE_URL } = {}) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const $ = cheerio.load(html);
  $('nav, header, footer, #comentarios, .comments').remove();

  const effectiveSlug = urlToSlug(slug || url) || String(slug || '').trim();
  const pageUrl = url || slugToUrl(effectiveSlug, baseUrl) || `${baseUrl}/`;
  const esSerie = effectiveSlug.startsWith('serie/') ||
    effectiveSlug.startsWith('documental/') ||
    $('tr.border').length > 0;

  const rawH1 = $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('title').first().text().split('|')[0].replace(/\s+/g, ' ').trim();

  // Extraer Año y Formato de la ficha técnica
  let año = null;
  let formatoFicha = null;

  $('p, div, li, td').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 160) return;
    if (!año) {
      const ym = txt.match(/\ba[ñn]o\s*:?\s*((?:19|20)\d{2})\b/i);
      if (ym) año = ym[1];
    }
    if (!formatoFicha) {
      const fm = txt.match(/\b(?:formato|calidad)\s*:?\s*([^\n|]+)/i);
      if (fm && fm[1].trim().length < 40) formatoFicha = fm[1].trim();
    }
  });

  if (!año) {
    const yearLink = $('a[href*="/anio/"], div.border-b p a').filter((_, a) => /^(?:19|20)\d{2}$/.test($(a).text().trim())).first();
    if (yearLink.length) año = yearLink.text().trim();
  }

  const parsedHeader = parseMejorTitle(rawH1, formatoFicha || '', effectiveSlug);
  const titulo = parsedHeader.titulo || rawH1;
  const effectiveYear = año || parsedHeader.año || null;

  const torrents = [];
  const seenDownloads = new Set();

  if (esSerie) {
    const rows = $('tr.border').length > 0 ? $('tr.border').toArray() : $('table tbody tr, table tr').toArray();
    for (const tr of rows) {
      const $tr = $(tr);
      const tds = $tr.find('td');
      if (tds.length < 2) continue;

      let downloadHref = '';
      $tr.find('a[href]').each((_, a) => {
        const h = $(a).attr('href') || '';
        if (h.includes('/torrents/') || /\.torrent(?:[?#]|$)/i.test(h) || /^magnet:/i.test(h)) {
          downloadHref = h;
        }
      });
      if (!downloadHref) continue;

      const resolvedUrl = resolveMejorDownloadUrl(downloadHref, pageUrl, baseUrl);
      if (!resolvedUrl || seenDownloads.has(resolvedUrl)) continue;

      const epCell = $(tds[1]).text().replace(/\s+/g, ' ').trim();
      const dateCell = tds.length >= 3 ? $(tds[2]).text().replace(/\s+/g, ' ').trim() : null;
      const claveCell = tds.length >= 4 ? $(tds[3]).text().replace(/\s+/g, ' ').trim() : '';

      const tienePassword = hasRarPassword(claveCell, epCell);
      const epInfo = parseMejorEpisodeCell(epCell, resolvedUrl, parsedHeader.seasonHint);
      if (epInfo.season === null && epInfo.episode === null && !epInfo.esPack) continue;

      seenDownloads.add(resolvedUrl);
      const fileHint = decodeURIComponent(resolvedUrl.split('/').pop() || '');
      const calidad = normalizeMejorQuality(formatoFicha || parsedHeader.calidad, `${rawH1} ${fileHint}`);
      const idioma = normalizeMejorLanguage(`${rawH1} ${epCell} ${fileHint}`);

      torrents.push({
        downloadUrl: resolvedUrl,
        magnet: /^magnet:\?/i.test(resolvedUrl) ? resolvedUrl : null,
        calidad,
        idioma,
        subtitulos: idioma === 'Inglés' ? 'Integrados' : 'No',
        tamaño: null,
        fecha: dateCell || null,
        clave: claveCell || 'Sin clave',
        tienePassword,
        season: epInfo.season,
        episode: epInfo.episode,
        episodes: epInfo.episodes,
        esPack: epInfo.esPack,
        label: epCell
      });
    }
  } else {
    $('a[href*="/torrents/"], a[href$=".torrent"], a.ml-2[href], a[href^="magnet:"]').each((_, a) => {
      const rawHref = $(a).attr('href') || '';
      const resolvedUrl = resolveMejorDownloadUrl(rawHref, pageUrl, baseUrl);
      if (!resolvedUrl || seenDownloads.has(resolvedUrl)) return;
      seenDownloads.add(resolvedUrl);

      const fileHint = decodeURIComponent(resolvedUrl.split('/').pop() || '');
      const calidad = normalizeMejorQuality(formatoFicha || parsedHeader.calidad, `${rawH1} ${fileHint}`);
      const idioma = normalizeMejorLanguage(`${rawH1} ${formatoFicha || ''} ${fileHint}`);

      torrents.push({
        downloadUrl: resolvedUrl,
        magnet: /^magnet:\?/i.test(resolvedUrl) ? resolvedUrl : null,
        calidad,
        idioma,
        subtitulos: idioma === 'Inglés' ? 'Integrados' : 'No',
        tamaño: null,
        clave: 'Sin clave',
        tienePassword: false,
        season: null,
        episode: null,
        episodes: [],
        esPack: false,
        label: rawH1
      });
    });
  }

  return {
    slug: effectiveSlug,
    url: pageUrl,
    titulo,
    tituloOriginal: null,
    año: effectiveYear,
    seasonHint: parsedHeader.seasonHint,
    tipo: esSerie ? 'serie' : 'pelicula',
    torrents
  };
}

// ---------------------------------------------------------------------------
// 3. CAPA DE RED CON FAILOVER `wwwNN.mejortorrent.eu` + BENCODE
// ---------------------------------------------------------------------------

function looksBlockedHtml(html) {
  if (typeof html !== 'string') return false;
  const head = html.slice(0, 6000).toLowerCase();
  return head.includes('cf-browser-verification') ||
    head.includes('id="challenge-form"') ||
    head.includes('<title>just a moment');
}

async function fetchHtml(pathOrUrl, { referer = null, timeoutMs = 12000 } = {}) {
  const mirrors = getMirrorPool();
  const isRelative = !/^https?:\/\//i.test(pathOrUrl);
  const candidates = isRelative
    ? mirrors.map(m => ({ mirror: m, url: `${m}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}` }))
    : [{ mirror: null, url: pathOrUrl }];

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const { mirror, url } = candidates[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await axios.get(url, withKeepAlive({
          timeout: timeout(timeoutMs),
          headers: {
            ...DEFAULT_HEADERS,
            ...(referer ? { Referer: referer } : {})
          },
          responseType: 'text',
          maxRedirects: 5
        }));

        if (typeof res?.data !== 'string') return '';
        if (looksBlockedHtml(res.data) && i + 1 < candidates.length) {
          lastErr = new Error(`Cloudflare/WAF block en ${url}`);
          break;
        }

        // Si el servidor redirigió a un nuevo wwwNN.mejortorrent.eu vivo, aprenderlo
        const finalUrl = res?.request?.res?.responseUrl;
        if (finalUrl && isSameMejorTorrentHost(finalUrl, url)) {
          try {
            const u = new URL(finalUrl);
            if (/^www\d+\./i.test(u.hostname)) {
              activeMirror = `${u.protocol}//${u.host}`;
              activeMirrorExp = Date.now() + 15 * 60 * 1000;
            }
          } catch {
            // Ignorar URL inválida
          }
        } else if (mirror) {
          activeMirror = mirror;
          activeMirrorExp = Date.now() + 15 * 60 * 1000;
        }
        return res.data;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        if (status === 404 || status === 400 || status === 410) {
          throw err;
        }
        if (attempt === 0 && isTransientNetworkError(err)) {
          await sleep(120);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error(`MejorTorrent: fallo al descargar ${pathOrUrl}`);
}

async function fetchAndParseTorrent(torrentUrl, { referer = `${BASE_URL}/`, season = null, episode = null, isMovie = false } = {}) {
  const cleanUrl = String(torrentUrl || '').trim();
  if (!cleanUrl) return null;

  const cacheHit = lruGet(torrentCache, cleanUrl);
  let parsed = cacheHit || null;

  if (!parsed) {
    parsed = await withSingleFlight(inFlight, `torrent:${cleanUrl}`, async () => {
      const again = lruGet(torrentCache, cleanUrl);
      if (again) return again;

      const res = await axios.get(cleanUrl, withKeepAlive({
        timeout: timeout(12000),
        headers: {
          ...DEFAULT_HEADERS,
          Accept: 'application/x-bittorrent,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {})
        },
        responseType: 'arraybuffer',
        maxContentLength: 8 * 1024 * 1024,
        maxRedirects: 5
      }));

      const buf = Buffer.isBuffer(res?.data)
        ? res.data
        : (res?.data instanceof ArrayBuffer || ArrayBuffer.isView(res?.data))
          ? Buffer.from(res.data)
          : null;

      if (!buf || !isTorrentBuffer(buf)) {
        lruSet(torrentCache, cleanUrl, { invalid: true }, NEGATIVE_CACHE_TTL_MS, 2000);
        return { invalid: true };
      }

      const info = parseTorrentBuffer(buf);
      // Descartar torrents que sólo contienen archivos comprimidos (.rar/.zip) sin vídeo reproducible
      const hasVideoFile = info.files.some(f => VIDEO_FILE_RE.test(f.name || f.path || ''));
      const onlyArchives = info.files.length > 0 && info.files.every(f => ARCHIVE_ONLY_RE.test(f.name || f.path || ''));
      const valid = !onlyArchives && (hasVideoFile || R.esReleaseVideo(info.name || ''));

      const val = valid ? info : { invalid: true };
      lruSet(torrentCache, cleanUrl, val, valid ? TORRENT_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS, 2000);
      return val;
    });
  }

  if (!parsed || parsed.invalid || !parsed.infoHash) return null;

  let fileIdx = null;
  let chosenSize = parsed.totalSize;
  let chosenName = parsed.name;

  if (Array.isArray(parsed.files) && parsed.files.length > 1) {
    if (episode !== null && Number.isFinite(Number(episode))) {
      const sel = selectFileIdxForEpisode(
        parsed.files,
        season !== null ? Number(season) : null,
        Number(episode)
      );
      if (sel) {
        fileIdx = sel.fileIdx;
        if (sel.file?.length) chosenSize = sel.file.length;
        if (sel.file?.name) chosenName = sel.file.name;
      }
    } else if (isMovie) {
      const sel = selectLargestVideoFileIdx(parsed.files);
      if (sel) {
        fileIdx = sel.fileIdx;
        if (sel.file?.length) chosenSize = sel.file.length;
        if (sel.file?.name) chosenName = sel.file.name;
      }
    }
  }

  return {
    infoHash: parsed.infoHash,
    magnet: buildMagnet(parsed.infoHash, parsed.name, parsed.trackers),
    dn: chosenName || parsed.name || null,
    sizeBytes: chosenSize || parsed.totalSize || 0,
    tamaño: formatBytes(chosenSize || parsed.totalSize),
    trackers: parsed.trackers,
    ...(Number.isInteger(fileIdx) && fileIdx >= 0 ? { fileIdx } : {})
  };
}

async function resolverMagnetsEnLote(torrents, opts = {}) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  const concurrency = Math.max(1, Math.min(5, Number(opts.concurrency) || 4));
  const season = opts.season ?? null;
  const episode = opts.episode ?? null;
  const isMovie = Boolean(opts.isMovie);
  const referer = opts.referer || `${BASE_URL}/`;

  // Filtrar entradas protegidas con contraseña RAR antes de descargar ningún .torrent
  const candidates = torrents.filter(t => t && !t.tienePassword);
  if (candidates.length === 0) return [];

  const out = new Array(candidates.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const item = candidates[idx];

      if (item.magnet && R.extraerInfoHash(item.magnet)) {
        const infoHash = R.extraerInfoHash(item.magnet);
        out[idx] = { ...item, infoHash };
        continue;
      }

      if (!item.downloadUrl) continue;
      try {
        const meta = await fetchAndParseTorrent(item.downloadUrl, {
          referer,
          season: season ?? item.season ?? null,
          episode: episode ?? item.episode ?? null,
          isMovie
        });
        if (!meta || !meta.infoHash) continue;

        const refinedCalidad = R.calidadDeNombre(meta.dn || '') || item.calidad || '720p';
        const refinedIdioma = R.idiomaDeNombre(meta.dn || '', item.idioma || 'Castellano');

        out[idx] = {
          ...item,
          infoHash: meta.infoHash,
          magnet: meta.magnet,
          dn: meta.dn || item.dn || null,
          calidad: refinedCalidad,
          idioma: refinedIdioma,
          tamaño: item.tamaño || meta.tamaño || null,
          ...(Number.isInteger(meta.fileIdx) ? { fileIdx: meta.fileIdx } : {})
        };
      } catch {
        // Ignorar .torrent caído
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// 4. API PÚBLICA DEL SCRAPER (buscarEnMejorTorrent / extraerDetalleTorrent / buscarStreams)
// ---------------------------------------------------------------------------

async function buscarEnMejorTorrent(query, tipoObjetivo = null) {
  const cleanQ = sanitizeSearchQuery(query);
  if (cleanQ.length < 2) return [];

  const filterType = tipoObjetivo === 'series' || tipoObjetivo === 'serie'
    ? 'series'
    : (tipoObjetivo === 'movie' || tipoObjetivo === 'pelicula' ? 'movie' : null);

  const cacheKey = `${filterType || 'all'}:${cleanQ.toLowerCase()}`;
  const cached = lruGet(searchCache, cacheKey);
  if (cached !== undefined) return cached;

  return withSingleFlight(inFlight, `search:${cacheKey}`, async () => {
    const hit = lruGet(searchCache, cacheKey);
    if (hit !== undefined) return hit;

    try {
      const path = `/busqueda?q=${encodeURIComponent(cleanQ)}`;
      const html = await fetchHtml(path, { referer: `${BASE_URL}/` });
      const items = parseSearchHtml(html, {
        baseUrl: activeMirror || BASE_URL,
        filterType
      });
      lruSet(
        searchCache,
        cacheKey,
        items,
        items.length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
        1000
      );
      return items;
    } catch {
      return [];
    }
  });
}

async function extraerDetalleTorrent(slugOrUrl) {
  const slug = urlToSlug(slugOrUrl);
  if (!slug) return null;

  const cached = lruGet(detailCache, slug);
  if (cached !== undefined) return cached;

  return withSingleFlight(inFlight, `detail:${slug}`, async () => {
    const hit = lruGet(detailCache, slug);
    if (hit !== undefined) return hit;

    try {
      const base = activeMirror || BASE_URL;
      const html = await fetchHtml(`/${slug}`, { referer: `${base}/` });
      const detail = parseDetailHtml(html, {
        slug,
        url: slugToUrl(slug, base),
        baseUrl: activeMirror || base
      });
      lruSet(
        detailCache,
        slug,
        detail,
        detail && detail.torrents.length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS,
        1000
      );
      return detail;
    } catch {
      return null;
    }
  });
}

function filtrarPorEpisodio(torrents, season, episode) {
  if (!Array.isArray(torrents) || season === null || episode === null) {
    return { exactos: torrents || [], packs: [] };
  }
  const s = Number(season);
  const e = Number(episode);
  const exactos = [];
  const packs = [];

  for (const t of torrents) {
    if (!t || t.tienePassword) continue;
    const matchKind = torrentMatchesEpisode(t, s, e);
    if (matchKind === 'exact') {
      exactos.push(t);
    } else if (matchKind === 'pack') {
      // Si el rango es explícito (p. ej. 2x01 al 2x13) verificar que incluya el episodio pedido
      if (Array.isArray(t.episodes) && t.episodes.length > 0 && !t.episodes.includes(e)) {
        continue;
      }
      packs.push(t);
    }
  }
  return { exactos, packs };
}

function torrentToStream(torrent, tituloFallback, extra = {}) {
  if (!torrent || torrent.tienePassword) return null;
  const infoHash = R.extraerInfoHash(torrent.infoHash) || R.extraerInfoHash(torrent.magnet);
  if (!infoHash) return null;

  const calidad = torrent.calidad || '720p';
  const idioma = torrent.idioma || 'Castellano';
  const subs = torrent.subtitulos || 'No';
  const tamaño = torrent.tamaño || null;
  const dn = torrent.dn || null;

  const se = torrentSeasonEpisode(torrent);
  const season = extra.season ?? se.season;
  const episode = extra.episode ?? se.episode;
  const esPack = extra.esPack === true || torrent.esPack === true;

  const baseName = extra.titulo || tituloFallback || 'MejorTorrent';
  const displayName = (season !== null && season !== undefined && episode !== null && episode !== undefined)
    ? `${baseName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : baseName;

  const lineas = [
    displayName,
    `🎞️ ${calidad} | 💾 ${tamaño || '?'} | 🗣️ ${idioma} | Subs: ${subs}`
  ];
  if (esPack) lineas.push('📦 Temporada completa (pack)');
  if (dn) lineas.push(`📄 ${dn}`);
  if (torrent.fecha) lineas.push(`📅 ${torrent.fecha}`);

  const stream = {
    name: `MejorTorrent\n${calidad}`,
    title: lineas.join('\n'),
    infoHash,
    sources: R.construirSources(infoHash, torrent.magnet),
    behaviorHints: {
      bingeGroup: `mejortorrent-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      ...(dn ? { filename: dn } : {})
    },
    _meta: {
      fuente: 'mejortorrent',
      idioma,
      calidad,
      seeders: 0,
      pack: esPack === true
    }
  };

  if (Number.isInteger(torrent.fileIdx) && torrent.fileIdx >= 0) {
    stream.fileIdx = torrent.fileIdx;
  }
  return stream;
}

/**
 * Busca y resuelve streams en MejorTorrent agrupando todas las calidades
 * disponibles de la película o de la temporada solicitada.
 */
async function buscarStreams({ title, originalTitle, altTitles = [], year, type, season = null, episode = null } = {}) {
  const conEpisodio = season !== null && episode !== null;
  const esSerie = type === 'series' || type === 'serie' || (type === 'anime' && conEpisodio);
  const tipoObjetivo = esSerie ? 'series' : 'movie';

  const queries = [];
  const seenNorm = new Set();
  const pushQuery = (q) => {
    const clean = sanitizeSearchQuery(q);
    if (clean.length < 2) return;
    const norm = normalizeTitle(clean);
    if (!norm || seenNorm.has(norm)) return;
    seenNorm.add(norm);
    queries.push(clean);
  };

  pushQuery(title);
  pushQuery(originalTitle);
  for (const alt of (Array.isArray(altTitles) ? altTitles : [])) pushQuery(alt);
  for (const base of [title, originalTitle]) {
    if (base && /[:\-–]/.test(base)) {
      const head = base.split(/[:\-–]/)[0].trim();
      if (head.length >= 4) pushQuery(head);
    }
  }
  if (queries.length === 0) return [];

  let allCandidates = [];
  const seenSlugs = new Set();
  const settled = await Promise.allSettled(
    queries.slice(0, 3).map(q => buscarEnMejorTorrent(q, tipoObjetivo))
  );
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const c of r.value) {
      if (!c || !c.slug || seenSlugs.has(c.slug)) continue;
      seenSlugs.add(c.slug);
      allCandidates.push(c);
    }
  }
  if (allCandidates.length === 0) return [];

  // Para series con temporada conocida, filtrar antes las fichas de otras temporadas
  // (p. ej. quedarse sólo con las fichas "2ª Temporada [720p]", "2ª Temporada [1080p]", "2ª Temporada [4K]")
  if (esSerie && season !== null) {
    const targetSeason = Number(season);
    const matchingSeason = allCandidates.filter(
      c => c.seasonHint === null || c.seasonHint === undefined || c.seasonHint === targetSeason
    );
    if (matchingSeason.length > 0) allCandidates = matchingSeason;
  }

  // En MejorTorrent las filas de búsqueda de películas rara vez llevan el año en el título
  // (el año está dentro de la ficha de detalle), así que puntuamos primero sin penalizar ausencia de año
  // y verificamos el año exacto tras abrir las fichas.
  const target = {
    title: title || originalTitle,
    originalTitle: originalTitle || title,
    altTitles: Array.isArray(altTitles) ? altTitles : [],
    year,
    type: tipoObjetivo
  };

  const MIN_SCORE = 0.6;
  const ranked = rankCandidates(allCandidates, target);
  const picked = pickBestMatch(allCandidates, target, { minScore: MIN_SCORE });
  let mejores = picked.ranked.filter(r => r.score >= MIN_SCORE);
  if (mejores.length === 0 && picked.best && picked.match) {
    mejores = [picked.match];
  }

  const maxInspect = esSerie ? 4 : 6;
  const toInspect = (mejores.length > 0 ? mejores : ranked).slice(0, maxInspect).map(r => r.cand);

  const detailResults = await Promise.allSettled(
    toInspect.map(cand => extraerDetalleTorrent(cand.slug).then(detalle => ({ cand, detalle })))
  );

  // Recoger candidatos verificados (para series preferimos capítulos exactos de cualquier calidad sobre packs)
  const exactQueue = [];
  const packQueue = [];

  for (const item of detailResults) {
    if (item.status !== 'fulfilled' || !item.value?.detalle) continue;
    const { cand, detalle } = item.value;
    if (!Array.isArray(detalle.torrents) || detalle.torrents.length === 0) continue;

    // En series de MejorTorrent, el campo "Año" de una ficha "2ª Temporada" puede ser el año de esa temporada
    // (p. ej. 2009 en lugar del estreno 2008 de Cinemeta), mientras que en películas el año es exacto.
    const verifyTarget = esSerie ? { ...target, year: null } : target;
    const verified = scoreCandidate({
      ...cand,
      titulo: detalle.titulo || cand.titulo,
      año: detalle.año || cand.año,
      tipo: detalle.tipo || cand.tipo
    }, verifyTarget);

    if (verified.score < MIN_SCORE) continue;

    if (esSerie && conEpisodio) {
      const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
      for (const t of exactos) exactQueue.push({ torrent: t, detalle, esPack: false });
      for (const t of packs) packQueue.push({ torrent: t, detalle, esPack: true });
    } else if (!esSerie) {
      for (const t of detalle.torrents) {
        if (t.tienePassword) continue;
        const se = torrentSeasonEpisode(t);
        if (se.season === null && se.episode === null && !se.isPack) {
          exactQueue.push({ torrent: t, detalle, esPack: false });
        }
      }
    }
  }

  const chosenEntries = exactQueue.length > 0 ? exactQueue : packQueue;
  if (chosenEntries.length === 0) return [];

  const resolvedTorrents = await resolverMagnetsEnLote(
    chosenEntries.map(e => ({ ...e.torrent, _detalle: e.detalle, _esPack: e.esPack })),
    {
      season,
      episode,
      isMovie: !esSerie,
      referer: chosenEntries[0].detalle.url || `${BASE_URL}/`
    }
  );

  const streams = [];
  const seenHashes = new Set();
  for (const r of resolvedTorrents) {
    const detalle = r._detalle || chosenEntries[0].detalle;
    const esPack = Boolean(r._esPack);
    const stream = torrentToStream(r, detalle.titulo, {
      titulo: detalle.titulo,
      season: esSerie ? season : null,
      episode: esSerie ? (esPack ? null : episode) : null,
      esPack
    });
    if (stream && !seenHashes.has(stream.infoHash)) {
      seenHashes.add(stream.infoHash);
      streams.push(stream);
    }
  }

  return streams;
}

module.exports = {
  BASE_URL,
  DEFAULT_MIRRORS,
  isSameMejorTorrentHost,
  sanitizeSearchQuery,
  urlToSlug,
  slugToUrl,
  parseMejorTitle,
  hasRarPassword,
  parseMejorEpisodeCell,
  resolveMejorDownloadUrl,
  parseSearchHtml,
  parseDetailHtml,
  buscarEnMejorTorrent,
  extraerDetalleTorrent,
  resolverMagnetsEnLote,
  filtrarPorEpisodio,
  torrentToStream,
  buscarStreams,
  clearCache
};
