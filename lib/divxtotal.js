/**
 * lib/divxtotal.js
 * ---------------------------------------------------------------------------
 * Scraper e integración dedicada para https://divxtotal.foo/ (DivxTotal)
 *
 * Estructura verificada directamente contra el sitio en vivo:
 *  1. Búsqueda WordPress HTML (`GET /?s={query}` y `/page/{n}/?s={query}`):
 *     - `/wp-json/wp/v2/posts` devuelve `[]` porque películas y series usan
 *       custom post types; toda búsqueda real pasa por `/?s={query}`.
 *     - Una misma película se publica en entradas separadas por calidad:
 *       `/peliculas/` (HDRip/DVDRip), `/peliculas-hd/` (720p/1080p),
 *       `/peliculas-4k/` (4K UHD), `/peliculas-dvdr/` (DVDR) y `/peliculas-3-d/`.
 *       El scraper agrupa todas las entradas válidas de la película para
 *       entregar todas las calidades disponibles en una sola consulta.
 *  2. Decodificación 100 % offline de ambos enlaces de descarga (sin pasar
 *     por acortadores publicitarios):
 *     - Opción 2 (`download_tt.php?u={base64}`): 1 ronda Base64 → URL directa
 *       `/wp-content/uploads/YYYY/MM/*.torrent` reescrita al espejo activo.
 *     - Opción 1 (`short-info.link/s.php?i={payload}`): 5 rondas Base64 + ROT13
 *       → exactamente la misma URL estática `.torrent` o `magnet:`.
 *  3. Series multi-temporada (`/series/{slug}/`):
 *     - Tablas `table.rwd-table` agrupadas bajo cabeceras `Temporada N` con
 *       etiquetas pegadas al título (`Euphoria1x08 FINAL TEMPORADA`,
 *       `Vicios ocultos1x5`, `Outlander6x02`), banderas de idioma (`ES.png`,
 *       `LA.png`, `EN.png`) y respaldo `[Cap.108]` en el nombre del `.torrent`.
 *  4. Extracción Bencode nativa (`lib/bencode.js`):
 *     - Verifica `isTorrentBuffer` para descartar páginas HTML 404 suaves
 *       (`¿Te perdiste?`), calcula el `infoHash` SHA-1 exacto, tamaño real y
 *       `fileIdx` en packs multifile.
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
  process.env.DIVXTOTAL_BASE_URL ||
  process.env.DIVXTOTAL_URL ||
  'https://divxtotal.foo'
).replace(/\/+$/, '');

const DEFAULT_MIRRORS = [
  'https://divxtotal.foo',
  'https://divxtotal.io',
  'https://www3.divxtotal.lol'
];

const EXTRA_MIRRORS = (process.env.DIVXTOTAL_MIRRORS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

const MOVIE_SECTION_RE = /^\/(peliculas|peliculas-hd(?:-\d+)?|peliculas-4k|peliculas-dvdr|peliculas-3-d)\/([^/?#]+)\/?$/i;
const SERIES_SECTION_RE = /^\/(series(?:-\d+)?)\/([^/?#]+)\/?$/i;
const EXCLUDED_PATH_RE = /^\/(?:programas|juegos|musica|otros|xxx|adultos|category|tag|author|page|wp-admin|wp-content|wp-json|feed)(?:\/|$)/i;

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
// 1. DECODIFICADORES OFFLINE (download_tt.php + short-info.link)
// ---------------------------------------------------------------------------

function rot13(str) {
  return String(str || '').replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function safeBase64Decode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length < 8 || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + '='.repeat(padLen);
  try {
    const buf = Buffer.from(padded, 'base64');
    if (!buf || buf.length === 0) return null;
    const text = buf.toString('utf8');
    if (text.includes('\uFFFD')) return null;
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Normaliza una URL de `.torrent` decodificada para que apunte al dominio activo
 * de DivxTotal cuando proviene de un espejo antiguo (`www.divxtotal.foo`,
 * `divxtotal.lol`, `divxtotal.io`, `www.divxtotal.ms`, etc.).
 */
function normalizeDivxTorrentUrl(rawUrl, baseUrl = BASE_URL) {
  const s = String(rawUrl || '').trim();
  if (!s) return null;
  if (/^magnet:\?/i.test(s)) return s;
  if (s.startsWith('/wp-content/uploads/') && /\.torrent(?:[?#]|$)/i.test(s)) {
    return `${String(baseUrl || BASE_URL).replace(/\/+$/, '')}${s}`;
  }
  try {
    const parsed = new URL(s);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (/(?:^|\.)divxtotal\.[a-z0-9-]+$/i.test(host) && parsed.pathname.startsWith('/wp-content/uploads/')) {
      const active = new URL(String(baseUrl || BASE_URL));
      parsed.protocol = active.protocol;
      parsed.host = active.host;
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Decodifica `download_tt.php?u=<base64>` hacia la URL directa del `.torrent`.
 */
function decodeDownloadTt(href, baseUrl = BASE_URL) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  let uParam = null;
  const qMatch = raw.match(/[?&]u=([^&#\s]+)/i);
  if (qMatch) {
    try { uParam = decodeURIComponent(qMatch[1]); } catch { uParam = qMatch[1]; }
  } else if (!raw.includes('/') && !raw.includes(':')) {
    uParam = raw;
  }
  if (!uParam) return null;

  if (/^https?:\/\/[^\s"'<>]+\.torrent(?:[?#]|$)/i.test(uParam) || /^magnet:\?/i.test(uParam)) {
    return normalizeDivxTorrentUrl(uParam, baseUrl);
  }

  const decoded = safeBase64Decode(uParam);
  if (!decoded) return null;
  if (/^magnet:\?/i.test(decoded) || /\.torrent(?:[?#]|$)/i.test(decoded)) {
    return normalizeDivxTorrentUrl(decoded, baseUrl);
  }
  return null;
}

/**
 * Decodifica offline el protector `short-info.link/s.php?i=<payload>` (y variantes
 * equivalentes de 1..8 capas Base64 + ROT13) sin hacer peticiones al acortador.
 */
function decodeShortInfoLink(href, baseUrl = BASE_URL) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  let token = null;
  const iMatch = raw.match(/[?&]i=([^&#\s]+)/i);
  if (iMatch) {
    try { token = decodeURIComponent(iMatch[1]); } catch { token = iMatch[1]; }
  } else if (!raw.includes('/') && !raw.includes(':')) {
    token = raw;
  }
  if (!token) return null;

  const isTarget = (candidate) => {
    if (!candidate) return false;
    return /^magnet:\?xt=urn:btih:/i.test(candidate) ||
      /^https?:\/\/[^\s"'<>]+\.torrent(?:[?#]|$)/i.test(candidate) ||
      /^\/wp-content\/uploads\/[^\s"'<>]+\.torrent(?:[?#]|$)/i.test(candidate);
  };

  let cur = token;
  for (let round = 0; round < 8; round++) {
    if (isTarget(cur)) return normalizeDivxTorrentUrl(cur, baseUrl);
    const rotated = rot13(cur);
    if (isTarget(rotated)) return normalizeDivxTorrentUrl(rotated, baseUrl);

    const next = safeBase64Decode(cur);
    if (!next || next === cur) break;
    cur = next;
  }

  const finalRot = rot13(cur);
  if (isTarget(finalRot)) return normalizeDivxTorrentUrl(finalRot, baseUrl);
  return null;
}

/**
 * Unifica cualquier atributo `href`/`data-src` de DivxTotal a una URL `.torrent` o `magnet:`.
 */
function resolveDivxDownloadHref(href, baseUrl = BASE_URL) {
  const s = String(href || '').trim();
  if (!s || s.startsWith('javascript:') || s.startsWith('#') || s.startsWith('??')) return null;

  if (/^magnet:\?xt=urn:btih:/i.test(s)) return s;
  if (s.includes('download_tt.php') || /[?&]u=/i.test(s)) {
    const dec = decodeDownloadTt(s, baseUrl);
    if (dec) return dec;
  }
  if (s.includes('s.php?i=') || s.includes('short-info.link') || s.includes('acortame')) {
    const dec = decodeShortInfoLink(s, baseUrl);
    if (dec) return dec;
  }
  if (/\.torrent(?:[?#]|$)/i.test(s)) {
    if (s.startsWith('/')) return normalizeDivxTorrentUrl(`${baseUrl}${s}`, baseUrl);
    return normalizeDivxTorrentUrl(s, baseUrl);
  }
  const genericB64 = decodeDownloadTt(s, baseUrl) || decodeShortInfoLink(s, baseUrl);
  return genericB64 || null;
}

// ---------------------------------------------------------------------------
// 2. HELPERS DE SLUG, METADATOS Y FORMATO
// ---------------------------------------------------------------------------

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

function urlToSlug(urlOrSlug) {
  const raw = String(urlOrSlug || '').trim().replace(/^dt:/i, '');
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch { return null; }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (EXCLUDED_PATH_RE.test(pathname)) return null;

  const mMovie = pathname.match(MOVIE_SECTION_RE);
  if (mMovie) return `${mMovie[1].toLowerCase()}/${mMovie[2]}`;
  const mSeries = pathname.match(SERIES_SECTION_RE);
  if (mSeries) return `${mSeries[1].toLowerCase()}/${mSeries[2]}`;
  return null;
}

function slugToUrl(slug, baseUrl = BASE_URL) {
  const clean = urlToSlug(slug);
  if (!clean) return null;
  return `${String(baseUrl || BASE_URL).replace(/\/+$/, '')}/${clean}/`;
}

function sectionQualityFallback(slugOrUrl) {
  const s = String(slugOrUrl || '').toLowerCase();
  if (s.includes('peliculas-4k')) return '4K';
  if (s.includes('peliculas-hd') || s.includes('peliculas-3-d')) return '1080p';
  if (s.includes('peliculas-dvdr')) return '480p';
  return null;
}

/**
 * Limpia el título publicado en DivxTotal extrayendo año, calidad e idioma.
 * Ejemplos reales:
 *   "Gigante (2026) 4K" -> { titulo: "Gigante", año: "2026", calidad: "4K" }
 *   "Mascotas 2 4K (1080p) (DUAL)" -> { titulo: "Mascotas 2", calidad: "1080p", idioma: "Latino/Inglés" }
 *   "Vicios ocultos - serie" -> { titulo: "Vicios ocultos" }
 */
function limpiarTituloPost(rawTitle, slugOrUrl = '') {
  let text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!text) return { titulo: '', año: null, calidad: null, idioma: null };

  // Quitar prefijo redundante "Pelicula " / "Película " en tablas relacionadas/listados
  text = text.replace(/^(?:pel[ií]cula|serie)\s+/i, '');

  let año = null;
  const yearMatch = text.match(/[\[(](19\d{2}|20\d{2})[\])]/) || text.match(/\b(19\d{2}|20\d{2})\s*$/);
  if (yearMatch) año = yearMatch[1];

  const upper = text.toUpperCase();
  let idioma = null;
  if (/\b(DUAL|ES-EN|MULTI)\b/.test(upper)) idioma = 'Latino/Inglés';
  else if (/\bLATINO\b/.test(upper)) idioma = 'Latino';
  else if (/\b(VOSE|SUBTITULAD[OA])\b/.test(upper)) idioma = 'Inglés';
  else if (/\b(INGL[EÉ]S|ENGLISH)\b/.test(upper)) idioma = 'Inglés';

  let calidad = null;
  if (/\b(4K|2160P|UHD)\b/.test(upper)) calidad = '4K';
  else if (/\b(1080P|MICROHD|FULLBLURAY|BDREMUX|BLURAY)\b/.test(upper)) calidad = '1080p';
  else if (/\b720P\b/.test(upper)) calidad = '720p';
  else if (/\b(DVDR|DVD5|DVD9|DVDRIP|HDRIP|480P|XVID)\b/.test(upper)) calidad = '480p';
  else calidad = sectionQualityFallback(slugOrUrl);

  const clean = text
    .replace(/\s*-\s*(?:pel[ií]cula(?:\s+torrent)?|serie(?:\s+torrent)?|descargar\s+torrent)\s*$/i, '')
    .replace(/[\[(](?:19\d{2}|20\d{2}|4k|2160p|uhd|1080p?|720p?|480p?|hdrip|dvdrip|bdrip|brrip|microhd|bluray|fullbluray|dvd[r59]?|3d|sbs|dual|es-en|castellano|espa[ñn]ol|latino|vose|subtitulad[oa]|hd-?cam|ts-?screener|br-?screener|reparado|proper)[\])]/gi, ' ')
    .replace(/\s+(?:4K|UHD|HDRip|DVDRip|MicroHD|3D)\s*$/i, '')
    .replace(/\s*[-–]\s*Temporadas?\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    titulo: clean || text,
    año,
    calidad,
    idioma
  };
}

function idiomaDeBanderaOTexto(flagSrc = '', textHint = '') {
  const flag = String(flagSrc || '').toUpperCase();
  if (/\/LA\.(?:PNG|JPG|WEBP)/i.test(flag) || /LATINO/.test(flag)) return 'Latino';
  if (/\/VOSE\.(?:PNG|JPG|WEBP)/i.test(flag)) return 'Inglés';
  if (/\/EN\.(?:PNG|JPG|WEBP)/i.test(flag)) return 'Inglés';
  if (/\/ES\.(?:PNG|JPG|WEBP)/i.test(flag)) return 'Castellano';

  const hint = String(textHint || '').trim();
  if (/\b(dual|es-en|multi)\b/i.test(hint)) return 'Latino/Inglés';
  if (/\blatino\b/i.test(hint)) return 'Latino';
  if (/\b(vose|subtitulad[oa])\b/i.test(hint)) return 'Inglés';
  if (/\b(ingl[eé]s|english)\b/i.test(hint)) return 'Inglés';
  if (/\b(castellano|espa[ñn]ol|cast|spa)\b/i.test(hint)) return 'Castellano';
  return 'Castellano';
}

function calidadDePistas(...hints) {
  for (const h of hints) {
    const raw = String(h || '').trim();
    if (!raw || /^n\/?a$/i.test(raw) || raw === '-') continue;
    const detected = R.calidadDeNombre(raw);
    if (detected) return detected;
    if (/\b(4k|2160p|uhd)\b/i.test(raw)) return '4K';
    if (/\b(1080p|microhd|bluray|bdremux)\b/i.test(raw)) return '1080p';
    if (/\b720p\b/i.test(raw)) return '720p';
    if (/\b(hdrip|bdrip)\b/i.test(raw)) return '720p';
    if (/\b(dvdrip|dvdr|dvd[59]|xvid|hdtv|480p|cam|screener)\b/i.test(raw)) return '480p';
  }
  return '720p';
}

/**
 * Extrae temporada y episodio(s) de una fila de serie de DivxTotal.
 * Ejemplos reales:
 *   "Euphoria1x08 FINAL TEMPORADA" -> { season: 1, episode: 8, episodes: [8], esPack: false }
 *   "Outlander6x3"                 -> { season: 6, episode: 3, episodes: [3], esPack: false }
 *   "Serie 1x01 al 1x06"           -> { season: 1, episode: 1, episodes: [1..6], esPack: false }
 *   "...Cap.108.avi.torrent"       -> { season: 1, episode: 8, episodes: [8], esPack: false }
 */
function parseDivxEpisodeLabel(labelText, fallbackUrl = '', fallbackSeason = null) {
  const text = String(labelText || '').replace(/\s+/g, ' ').trim();
  const combined = `${text} ${decodeURIComponent(String(fallbackUrl || ''))}`;

  // Rango explícito: 1x01 al 1x06 / 2x01 al 06
  const rangeMatch = combined.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})\s*(?:al|a|-)\s*(?:\d{1,2}\s*[xX×]\s*)?(\d{1,3})\b/i);
  if (rangeMatch) {
    const season = parseInt(rangeMatch[1], 10);
    const startEp = parseInt(rangeMatch[2], 10);
    const endEp = parseInt(rangeMatch[3], 10);
    if (endEp >= startEp && endEp - startEp <= 40) {
      const episodes = [];
      for (let e = startEp; e <= endEp; e++) episodes.push(e);
      const esPack = startEp === 1 && episodes.length >= 6;
      return { season, episode: esPack ? null : startEp, episodes, esPack };
    }
  }

  // Formato pegado al título en DivxTotal: "Euphoria1x08", "Outlander6x3"
  const sxeMatch = text.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})(?!\d)/) ||
    combined.match(/[Ss](\d{1,2})[Ee](\d{1,3})(?!\d)/);
  if (sxeMatch) {
    const season = parseInt(sxeMatch[1], 10);
    const episode = parseInt(sxeMatch[2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  // Formato español clásico en archivo .torrent: Cap.108 -> S01E08, Cap.1204 -> S12E04
  const capMatch = combined.match(/\bCap\.?\s*(\d{1,2})(\d{2})\b/i);
  if (capMatch) {
    const season = parseInt(capMatch[1], 10);
    const episode = parseInt(capMatch[2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  if (/\b(?:temporada\s*\d+\s*completa|pack\s*temporada|completa)\b/i.test(text)) {
    const sm = text.match(/temporada\s*(\d{1,2})/i);
    const season = sm ? parseInt(sm[1], 10) : fallbackSeason;
    return { season, episode: null, episodes: [], esPack: true };
  }

  const parsed = parseSeasonEpisode(text);
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

// ---------------------------------------------------------------------------
// 3. PARSERS HTML (BÚSQUEDA Y FICHA DE DETALLE)
// ---------------------------------------------------------------------------

/**
 * Parsea el HTML de resultados de `/?s={query}` o de catálogos de DivxTotal.
 */
function parseSearchHtml(html, { baseUrl = BASE_URL, filterType = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  const pushCandidate = (href, rawTitle, sizeText = '', dateText = '') => {
    const slug = urlToSlug(href);
    if (!slug || seenSlugs.has(slug)) return;

    const esSerie = slug.startsWith('series');
    const tipo = esSerie ? 'serie' : 'pelicula';
    if (filterType === 'series' && !esSerie) return;
    if (filterType === 'movie' && esSerie) return;

    const parsed = limpiarTituloPost(rawTitle, slug);
    if (!parsed.titulo) return;

    seenSlugs.add(slug);
    const cleanSize = (!sizeText || /^n\/?a$/i.test(sizeText) || sizeText === '-') ? null : sizeText.trim();
    results.push({
      id: `dt:${slug}`,
      slug,
      url: slugToUrl(slug, baseUrl),
      titulo: parsed.titulo,
      tituloOriginal: null,
      año: parsed.año,
      tipo,
      calidad: parsed.calidad,
      idioma: parsed.idioma,
      tamaño: cleanSize,
      fecha: dateText || null
    });
  };

  // Layout principal de búsqueda: <table class="table"><tbody><tr>...
  $('table.table tbody tr, table.table tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.find('th').length > 0) return;
    const $a = $tr.find('a[href]').first();
    if (!$a.length) return;
    const href = $a.attr('href') || '';
    const rawTitle = ($a.attr('title') || $a.text() || '').trim();
    const tds = $tr.find('td');
    const dateText = tds.length >= 3 ? $(tds[2]).text().trim() : '';
    const sizeText = tds.length >= 4 ? $(tds[3]).text().trim() : '';
    pushCandidate(href, rawTitle, sizeText, dateText);
  });

  // Fallback para vistas de rejilla / bloques de tarjetas
  if (results.length === 0) {
    $('a[href*="/peliculas"], a[href*="/series"]').each((_, el) => {
      const $a = $(el);
      if ($a.closest('nav, header, footer, #bloque_cat, .pagination').length > 0) return;
      const href = $a.attr('href') || '';
      const rawTitle = ($a.attr('title') || $a.text() || '').trim();
      if (!rawTitle || rawTitle.length < 2) return;
      pushCandidate(href, rawTitle);
    });
  }

  return results;
}

/**
 * Extrae metadatos clave/valor de la ficha técnica de DivxTotal.
 * Soporta tanto pares `<dt>/<dd>` o `<p>Label</p><p>Valor</p>` como texto `Label: Valor`.
 */
function extractTechnicalMetadata($) {
  let tituloOriginal = null;
  let año = null;
  let formato = null;
  let calidad = null;
  let idioma = null;

  const cleanOrig = (val) => String(val || '')
    .replace(/\((?:tv\s*series|serie\s*de\s*tv|miniserie|pel[ií]cula)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Recorrer etiquetas en tablas/bloques de ficha técnica
  $('th, td, dt, p, li, strong, b, span').each((_, el) => {
    const $el = $(el);
    const own = $el.text().replace(/\s+/g, ' ').trim();
    if (!own || own.length > 140) return;

    const inlineOrig = own.match(/^t[ií]tulo\s+original\s*:\s*(.+)$/i);
    if (inlineOrig && !tituloOriginal) {
      tituloOriginal = cleanOrig(inlineOrig[1]);
      return;
    }
    if (/^t[ií]tulo\s+original\s*:?$/i.test(own) && !tituloOriginal) {
      const nextText = $el.next().text().replace(/\s+/g, ' ').trim();
      if (nextText && nextText.length < 160) tituloOriginal = cleanOrig(nextText);
      return;
    }

    const inlineYear = own.match(/^a[ñn]o\s*:\s*((?:19|20)\d{2})\b/i);
    if (inlineYear && !año) {
      año = inlineYear[1];
      return;
    }
    if (/^a[ñn]o\s*:?$/i.test(own) && !año) {
      const nextYear = $el.next().text().match(/\b((?:19|20)\d{2})\b/);
      if (nextYear) año = nextYear[1];
      return;
    }

    const inlineQual = own.match(/^calidad\s*:\s*(.+)$/i);
    if (inlineQual && !calidad && !/^n\/?a$/i.test(inlineQual[1].trim())) {
      calidad = inlineQual[1].trim();
      return;
    }
    if (/^calidad\s*:?$/i.test(own) && !calidad) {
      const nextQual = $el.next().text().trim();
      if (nextQual && !/^n\/?a$/i.test(nextQual)) calidad = nextQual;
      return;
    }

    const inlineFmt = own.match(/^formato\s*:\s*(.+)$/i);
    if (inlineFmt && !formato && !/^n\/?a$/i.test(inlineFmt[1].trim())) {
      formato = inlineFmt[1].trim();
      return;
    }
    if (/^formato\s*:?$/i.test(own) && !formato) {
      const nextFmt = $el.next().text().trim();
      if (nextFmt && !/^n\/?a$/i.test(nextFmt)) formato = nextFmt;
      return;
    }

    const inlineLang = own.match(/^idioma\s*:\s*(.+)$/i);
    if (inlineLang && !idioma && !/^n\/?a$/i.test(inlineLang[1].trim())) {
      idioma = inlineLang[1].trim();
      return;
    }
    if (/^idioma\s*:?$/i.test(own) && !idioma) {
      const nextLang = $el.next().text().trim();
      if (nextLang && !/^n\/?a$/i.test(nextLang)) idioma = nextLang;
    }
  });

  return { tituloOriginal, año, formato, calidad, idioma };
}

/**
 * Parsea el HTML completo de una ficha de película o serie en DivxTotal.
 */
function parseDetailHtml(html, { slug = '', url = '', baseUrl = BASE_URL } = {}) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const $ = cheerio.load(html);

  // Eliminar navegación, comentarios y bloques de "Películas Relacionadas"
  $('nav, header, footer, #comentarios, .comments, .related, .relacionados').remove();
  $('h2, h3, h4').each((_, h) => {
    const txt = $(h).text().trim();
    if (/relacionad[oa]s/i.test(txt)) {
      $(h).nextAll('table, div.table-responsive').first().remove();
      $(h).remove();
    }
  });

  const effectiveSlug = urlToSlug(slug || url) || String(slug || '').trim();
  const esSerie = effectiveSlug.startsWith('series') || $('table.rwd-table').length > 0;
  const rawH1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const cleanedH1 = limpiarTituloPost(rawH1, effectiveSlug);
  const meta = extractTechnicalMetadata($);

  const titulo = cleanedH1.titulo || rawH1;
  const año = meta.año || cleanedH1.año || null;
  const tituloOriginal = meta.tituloOriginal || null;
  const sectionQual = sectionQualityFallback(effectiveSlug || url);
  const torrents = [];
  const seenUrls = new Set();

  if (esSerie) {
    // Recorrer cada tabla de temporada (`table.rwd-table` o tablas con enlaces de episodio)
    const tables = $('table.rwd-table').length > 0
      ? $('table.rwd-table').toArray()
      : $('div.fichseriecapitulos table, table').toArray();

    for (const tbl of tables) {
      const $tbl = $(tbl);
      // Buscar cabecera de temporada inmediatamente anterior (<h3>Temporada N</h3> o .titulotemporada)
      let seasonFromHeading = null;
      const prevHeading = $tbl.prevAll('h3, h2, .titulotemporada').first().text() ||
        $tbl.closest('div').prevAll('h3, h2, .titulotemporada').first().text() || '';
      const sm = prevHeading.match(/temporada\s*(\d{1,2})/i);
      if (sm) seasonFromHeading = parseInt(sm[1], 10);

      $tbl.find('tr').each((_, tr) => {
        const $tr = $(tr);
        if ($tr.find('th').length > 0 && $tr.find('td').length === 0) return;

        // Extraer enlaces candidatos de la fila (priorizando download_tt.php sobre short-info.link)
        const rawLinks = [];
        $tr.find('a[href], a[data-src]').each((__, a) => {
          const h = $(a).attr('href') || $(a).attr('data-src') || '';
          if (h) rawLinks.push({ href: h, cls: $(a).attr('class') || '', text: $(a).text().trim() });
        });
        if (rawLinks.length === 0) return;

        // Ordenar para evaluar primero download_tt.php (1x Base64 directo)
        rawLinks.sort((a, b) => {
          const score = (x) => (x.href.includes('download_tt.php') ? 0 : 1);
          return score(a) - score(b);
        });

        let resolvedUrl = null;
        for (const item of rawLinks) {
          const target = resolveDivxDownloadHref(item.href, baseUrl);
          if (target) {
            resolvedUrl = target;
            break;
          }
        }
        if (!resolvedUrl || seenUrls.has(resolvedUrl)) return;

        const firstTd = $tr.find('td').first();
        const epText = (firstTd.text() || $tr.text() || '').replace(/\s+/g, ' ').trim();
        const flagSrc = $tr.find('img[src*="/images/"], img[src*="flags/"]').first().attr('src') || '';
        const epInfo = parseDivxEpisodeLabel(epText, resolvedUrl, seasonFromHeading);
        if (epInfo.season === null && epInfo.episode === null && !epInfo.esPack) return;

        seenUrls.add(resolvedUrl);
        const fileHint = decodeURIComponent(resolvedUrl.split('/').pop() || '');
        const calidad = calidadDePistas(fileHint, epText, meta.calidad, meta.formato, cleanedH1.calidad);
        const idioma = idiomaDeBanderaOTexto(flagSrc, `${epText} ${fileHint} ${meta.idioma || ''}`);

        torrents.push({
          downloadUrl: resolvedUrl,
          magnet: /^magnet:\?/i.test(resolvedUrl) ? resolvedUrl : null,
          calidad,
          idioma,
          subtitulos: idioma === 'Inglés' ? 'Sí' : 'No',
          tamaño: null,
          season: epInfo.season,
          episode: epInfo.episode,
          episodes: epInfo.episodes,
          esPack: epInfo.esPack,
          label: epText
        });
      });
    }
  } else {
    // Ficha de película: extraer tamaño/calidad/idioma de tabla técnica y decodificar enlaces
    let tableSize = null;
    let tableQuality = null;
    let flagSrc = $('td img[src*="/images/"], img[src*="/css/images/"]').first().attr('src') || '';

    $('td[data-th]').each((_, td) => {
      const th = String($(td).attr('data-th') || '').toLowerCase();
      const val = $(td).text().trim();
      if (!val || /^n\/?a$/i.test(val) || val === '-') return;
      if (th.includes('peso') || th.includes('tama')) tableSize = val;
      if (th.includes('calidad')) tableQuality = val;
      if (th.includes('idioma') && !flagSrc) {
        flagSrc = $(td).find('img').attr('src') || '';
      }
    });

    const candidateLinks = [];
    $('a[href*="download_tt.php"], a.opcion_2[href], a.linktorrent[href], a.linktorrent[data-src], a[href*="short-info.link"], a[href^="magnet:"], a[href$=".torrent"]').each((_, a) => {
      const href = $(a).attr('href') || $(a).attr('data-src') || '';
      if (href) candidateLinks.push(href);
    });

    // Priorizar download_tt.php antes que short-info.link; deduplicar por URL final
    candidateLinks.sort((a, b) => (a.includes('download_tt.php') ? -1 : 1) - (b.includes('download_tt.php') ? -1 : 1));

    for (const rawHref of candidateLinks) {
      const resolvedUrl = resolveDivxDownloadHref(rawHref, baseUrl);
      if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);

      const fileHint = decodeURIComponent(resolvedUrl.split('/').pop() || '');
      const calidad = calidadDePistas(
        tableQuality,
        meta.calidad,
        cleanedH1.calidad,
        fileHint,
        sectionQual,
        meta.formato
      );
      const idioma = idiomaDeBanderaOTexto(
        flagSrc,
        `${cleanedH1.idioma || ''} ${meta.idioma || ''} ${rawH1} ${fileHint}`
      );

      torrents.push({
        downloadUrl: resolvedUrl,
        magnet: /^magnet:\?/i.test(resolvedUrl) ? resolvedUrl : null,
        calidad,
        idioma,
        subtitulos: idioma === 'Inglés' || idioma === 'Latino/Inglés' ? 'Integrados' : 'No',
        tamaño: tableSize || null,
        season: null,
        episode: null,
        episodes: [],
        esPack: false,
        label: rawH1
      });
    }
  }

  return {
    slug: effectiveSlug,
    url: url || slugToUrl(effectiveSlug, baseUrl),
    titulo,
    tituloOriginal,
    año,
    tipo: esSerie ? 'serie' : 'pelicula',
    torrents
  };
}

// ---------------------------------------------------------------------------
// 4. CAPA DE RED CON ESPEJOS, KEEP-ALIVE Y RESOLUCIÓN .TORRENT
// ---------------------------------------------------------------------------

function looksBlockedHtml(html) {
  if (typeof html !== 'string') return false;
  const head = html.slice(0, 6000).toLowerCase();
  return head.includes('cf-browser-verification') ||
    head.includes('id="challenge-form"') ||
    head.includes('<title>just a moment') ||
    head.includes('error establishing a redis connection');
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
          lastErr = new Error(`WAF/Redis block en ${url}`);
          break;
        }
        if (mirror) {
          activeMirror = mirror;
          activeMirrorExp = Date.now() + 15 * 60 * 1000;
        }
        return res.data;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        // 404 es definitivo: no reintentar ni rotar espejos
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
  throw lastErr || new Error(`DivxTotal: fallo al descargar ${pathOrUrl}`);
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
        // Soft-404 HTML ("Página no encontrada") u otro cuerpo no-torrent
        lruSet(torrentCache, cleanUrl, { invalid: true }, NEGATIVE_CACHE_TTL_MS, 2000);
        return { invalid: true };
      }

      const info = parseTorrentBuffer(buf);
      const hasVideo = info.files.some(f => VIDEO_FILE_RE.test(f.name || f.path || '')) ||
        R.esReleaseVideo(info.name || '');
      const val = hasVideo ? info : { invalid: true };
      lruSet(torrentCache, cleanUrl, val, hasVideo ? TORRENT_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS, 2000);
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

/**
 * Resuelve en paralelo (concurrencia acotada) los archivos `.torrent` de una lista.
 */
async function resolverMagnetsEnLote(torrents, opts = {}) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  const concurrency = Math.max(1, Math.min(5, Number(opts.concurrency) || 4));
  const season = opts.season ?? null;
  const episode = opts.episode ?? null;
  const isMovie = Boolean(opts.isMovie);
  const referer = opts.referer || `${BASE_URL}/`;

  const out = new Array(torrents.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < torrents.length) {
      const idx = cursor++;
      const item = torrents[idx];
      if (!item) continue;

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
        // Archivo .torrent caído o inaccesible → omitir limpiamente
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, torrents.length) }, () => worker()));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// 5. API PÚBLICA DEL SCRAPER (buscarEnDivxTotal / extraerDetalleTorrent / buscarStreams)
// ---------------------------------------------------------------------------

async function buscarEnDivxTotal(query, tipoObjetivo = null) {
  const cleanQ = String(query || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      const path = `/?s=${encodeURIComponent(cleanQ)}`;
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
      const html = await fetchHtml(`/${slug}/`, { referer: `${BASE_URL}/` });
      const base = activeMirror || BASE_URL;
      const detail = parseDetailHtml(html, {
        slug,
        url: slugToUrl(slug, base),
        baseUrl: base
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
    const matchKind = torrentMatchesEpisode(t, s, e);
    if (matchKind === 'exact') {
      exactos.push(t);
    } else if (matchKind === 'pack') {
      packs.push(t);
    }
  }
  return { exactos, packs };
}

function torrentToStream(torrent, tituloFallback, extra = {}) {
  if (!torrent) return null;
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

  const baseName = extra.titulo || tituloFallback || 'DivxTotal';
  const displayName = (season !== null && season !== undefined && episode !== null && episode !== undefined)
    ? `${baseName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : baseName;

  const lineas = [
    displayName,
    `🎞️ ${calidad} | 💾 ${tamaño || '?'} | 🗣️ ${idioma} | Subs: ${subs}`
  ];
  if (esPack) lineas.push('📦 Temporada completa (pack)');
  if (dn) lineas.push(`📄 ${dn}`);

  const stream = {
    name: `DivxTotal\n${calidad}`,
    title: lineas.join('\n'),
    infoHash,
    sources: R.construirSources(infoHash, torrent.magnet),
    behaviorHints: {
      bingeGroup: `divxtotal-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      ...(dn ? { filename: dn } : {})
    },
    _meta: {
      fuente: 'divxtotal',
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
 * Busca y resuelve streams en DivxTotal para una película, serie o anime.
 */
async function buscarStreams({ title, originalTitle, altTitles = [], year, type, season = null, episode = null } = {}) {
  const conEpisodio = season !== null && episode !== null;
  const esSerie = type === 'series' || type === 'serie' || (type === 'anime' && conEpisodio);
  const tipoObjetivo = esSerie ? 'series' : 'movie';

  const queries = [];
  const seenNorm = new Set();
  const pushQuery = (q) => {
    const clean = String(q || '')
      .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

  const allCandidates = [];
  const seenSlugs = new Set();
  const settled = await Promise.allSettled(
    queries.slice(0, 3).map(q => buscarEnDivxTotal(q, tipoObjetivo))
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

  // En películas, DivxTotal crea 1 post por calidad (/peliculas/, /peliculas-hd/, /peliculas-4k/),
  // así que inspeccionamos hasta 5 candidatos válidos en paralelo y unimos sus calidades.
  const maxInspect = esSerie ? 3 : 5;
  const toInspect = (mejores.length > 0 ? mejores : ranked).slice(0, maxInspect).map(r => r.cand);

  const detailResults = await Promise.allSettled(
    toInspect.map(cand => extraerDetalleTorrent(cand.slug).then(detalle => ({ cand, detalle })))
  );

  const allStreams = [];
  const seenHashes = new Set();

  for (const item of detailResults) {
    if (item.status !== 'fulfilled' || !item.value?.detalle) continue;
    const { cand, detalle } = item.value;
    if (!Array.isArray(detalle.torrents) || detalle.torrents.length === 0) continue;

    const verified = scoreCandidate({
      ...cand,
      titulo: detalle.titulo || cand.titulo,
      tituloOriginal: detalle.tituloOriginal || cand.tituloOriginal,
      año: detalle.año || cand.año,
      tipo: detalle.tipo || cand.tipo
    }, target);

    if (verified.score < MIN_SCORE) {
      const uniqueExactYear = allCandidates.length === 1 && verified.yearDelta === 0 && verified.titleScore >= 0.45;
      if (!uniqueExactYear) continue;
    }

    let elegidos = detalle.torrents;
    let esPack = false;
    if (esSerie && conEpisodio) {
      const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
      if (exactos.length === 0 && packs.length === 0) continue;
      elegidos = exactos.length > 0 ? exactos : packs;
      esPack = exactos.length === 0 && packs.length > 0;
    } else if (!esSerie) {
      elegidos = detalle.torrents.filter(t => {
        const se = torrentSeasonEpisode(t);
        return se.season === null && se.episode === null && !se.isPack;
      });
    }

    const resueltos = await resolverMagnetsEnLote(elegidos, {
      season,
      episode,
      isMovie: !esSerie,
      referer: detalle.url || `${BASE_URL}/`
    });

    for (const r of resueltos) {
      const stream = torrentToStream(r, detalle.titulo, {
        titulo: detalle.titulo,
        season: esSerie ? season : null,
        episode: esSerie ? (esPack ? null : episode) : null,
        esPack
      });
      if (stream && !seenHashes.has(stream.infoHash)) {
        seenHashes.add(stream.infoHash);
        allStreams.push(stream);
      }
    }

    // En series, en cuanto la ficha principal ya entregó el episodio exacto no hace falta otra serie
    if (esSerie && allStreams.length > 0) break;
  }

  return allStreams;
}

module.exports = {
  BASE_URL,
  DEFAULT_MIRRORS,
  rot13,
  decodeDownloadTt,
  decodeShortInfoLink,
  resolveDivxDownloadHref,
  normalizeDivxTorrentUrl,
  urlToSlug,
  slugToUrl,
  limpiarTituloPost,
  parseDivxEpisodeLabel,
  parseSearchHtml,
  parseDetailHtml,
  buscarEnDivxTotal,
  extraerDetalleTorrent,
  resolverMagnetsEnLote,
  filtrarPorEpisodio,
  torrentToStream,
  buscarStreams,
  clearCache
};
