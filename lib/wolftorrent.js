/**
 * lib/wolftorrent.js
 * ---------------------------------------------------------------------------
 * Scraper e integración dedicada para https://wolftorrent.com/ (WolfTorrent / WolfMax4K)
 *
 * Estructura verificada directamente contra el sitio en vivo:
 *  1. Búsqueda HTML unificada (`GET /buscar?q={query}`):
 *     - Devuelve tarjetas `<article class="wolf-card">` tanto para películas
 *       (`/pelicula/{code}`) como para series, animación y documentales
 *       (`/serie/{code}`, `/animacion/{code}`, `/documental/{code}`).
 *     - En películas, una única tarjeta agrupa todas las calidades disponibles
 *       (`HDRip`, `BluRay-720p`, `BluRay-1080p`, `4K`, `4KWebrip`) dentro de
 *       elementos `li.wolf-card-file`, cada uno con su tamaño (`.wolf-card-size`)
 *       y su código de descarga (`button.protected-download[data-content-code][data-tabla]`
 *       o enlace `/descarga/{tipo}/{code}`).
 *     - Decodifica el segmento Base64 de las carátulas (`/caratulas/{cat}/{b64}/...`)
 *       para extraer el año exacto `(YYYY)` y metadatos originales sin peticiones extra.
 *  2. Expansión de episodios de series:
 *     - Soporta tanto el endpoint AJAX `GET /api/episodios?type=serie&id={numId}&calidad=`
 *       (`details[data-wolf-episodes]`, cabecera `X-Requested-With: XMLHttpRequest`)
 *       como la lectura completa de la ficha `/serie/{code}` y `/serie/episodio/{code}`.
 *     - Parsea episodios simples (`Episodio 1x10 -`), listas (`Episodio 3x07 - 3x08.`,
 *       `Episodio 1x05 - 06 - 07.`), rangos (`Episodio 2x01 al 06.`, `4x01 al 4x08.`)
 *       y etiquetas `[Cap.108]`.
 *  3. Cadena completa de resolución de descarga (`POST /api/descargas` + PoW + Enlacito):
 *     - Enlaces directos `magnet:` o `.torrent` cuando están presentes.
 *     - API `/api/descargas`: `action: "generate"` → resolución SHA-256 Proof-of-Work
 *       (`challenge:round:nonce`) → `action: "validate"` conservando cookies de sesión.
 *     - Desencriptación nativa OpenSSL `Salted__` AES-256-CBC (`EVP_BytesToKey` MD5)
 *       para enlaces externos `enlacito.com/s.php?i=...` (`var link_out = "..."`).
 *     - Degradación rápida y limpia (con cortacircuitos temporal) cuando el sitio
 *       activa verificación humana Cloudflare Turnstile (`captcha_required`), con
 *       soporte opcional para FlareSolverr/Byparr (`WOLFTORRENT_SOLVER_URL` / `FLARESOLVERR_URL`).
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
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
  process.env.WOLFTORRENT_BASE_URL ||
  process.env.WOLFTORRENT_URL ||
  'https://wolftorrent.com'
).replace(/\/+$/, '');

const DEFAULT_MIRRORS = [
  'https://wolftorrent.com',
  'https://www.wolftorrent.com',
  'https://wolfmax4k.com'
];

const EXTRA_MIRRORS = (process.env.WOLFTORRENT_MIRRORS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const TORRENT_LINK_ENCRYPTION_KEY = 'fee631d2cffda38a78b96ee6d2dfb43a';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

// IDs de ficha WolfTorrent 2026: 4..20 alfanuméricos con al menos una letra (p. ej. r8e6a8, rytkrd, 5jbu5x)
const WOLF_CODE_RE = /^(?=[a-z0-9]{4,20}$)(?=.*[a-z])[a-z0-9]+$/i;
const DETAIL_PATH_RE = /^\/(pelicula|serie|animacion|documental)(?:\/(episodio))?\/([a-z0-9]{4,20})(?:\/([^/?#]+))?\/?$/i;
const DESCARGA_PATH_RE = /^\/descarga\/(peliculas?|series?|animacion|documental(?:es)?|episodio)\/([a-z0-9]{4,20})\/?$/i;
const LISTING_SEGMENTS_RE = /^(?:page|pagina|paged|categoria|categorias|calidad|calidades|genero|generos|idioma|orden|buscar|search|ultimos|estrenos|ayuda|api|torrents)$/i;

const CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000;
const TORRENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTCHA_CIRCUIT_TTL_MS = 2 * 60 * 1000;

const searchCache = new Map();
const detailCache = new Map();
const downloadCache = new Map();
const inFlight = new Map();

let activeMirror = null;
let activeMirrorExp = 0;
let captchaCircuitUntil = 0;

function getSolverUrl() {
  return String(
    process.env.WOLFTORRENT_SOLVER_URL ||
    process.env.FLARESOLVERR_URL ||
    ''
  ).trim().replace(/\/+$/, '');
}

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
  downloadCache.clear();
  inFlight.clear();
  activeMirror = null;
  activeMirrorExp = 0;
  captchaCircuitUntil = 0;
}

// ---------------------------------------------------------------------------
// 1. CRIPTOGRAFÍA Y PRUEBA DE TRABAJO (SHA-256 PoW + OpenSSL AES-256-CBC)
// ---------------------------------------------------------------------------

/**
 * Resuelve el desafío Proof-of-Work de `/api/descargas`:
 * para cada ronda `0..rounds-1`, encuentra el menor `nonce` cuyo
 * `SHA256("${challenge}:${round}:${nonce}")` en hex empiece por `difficulty` ceros.
 */
function computeProofOfWork(challenge, rounds = 1, difficulty = 3, maxIterationsPerRound = 2_000_000) {
  const ch = String(challenge || '');
  const totalRounds = Math.max(1, Math.min(16, Number(rounds) || 1));
  const diff = Math.max(1, Math.min(6, Number(difficulty) || 3));
  const prefix = '0'.repeat(diff);
  const nonces = [];

  for (let round = 0; round < totalRounds; round++) {
    let found = null;
    for (let nonce = 0; nonce < maxIterationsPerRound; nonce++) {
      const hex = crypto
        .createHash('sha256')
        .update(`${ch}:${round}:${nonce}`)
        .digest('hex');
      if (hex.startsWith(prefix)) {
        found = nonce;
        break;
      }
    }
    if (found === null) {
      throw new Error(`WolfTorrent PoW superó límite en ronda ${round}`);
    }
    nonces.push(found);
  }
  return nonces;
}

/**
 * Deriva `key` (32B) e `iv` (16B) según OpenSSL `EVP_BytesToKey` con MD5.
 */
function deriveOpenSslKeyAndIv(passphrase, salt) {
  const passBuf = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(String(passphrase), 'utf8');
  const chunks = [];
  let total = 0;
  let prev = Buffer.alloc(0);

  while (total < 48) {
    prev = crypto
      .createHash('md5')
      .update(Buffer.concat([prev, passBuf, salt]))
      .digest();
    chunks.push(prev);
    total += prev.length;
  }

  const derived = Buffer.concat(chunks);
  return {
    key: derived.slice(0, 32),
    iv: derived.slice(32, 48)
  };
}

/**
 * Desencripta el payload `link_out` de `enlacito.com` (1x o 2x Base64 sobre `Salted__`).
 */
function decryptEnlacitoPayload(rawPayload, passphrase = TORRENT_LINK_ENCRYPTION_KEY) {
  if (!rawPayload || typeof rawPayload !== 'string') return null;

  let cipherBuf = null;
  let candidate = rawPayload.trim();

  for (let depth = 0; depth < 2; depth++) {
    let buf;
    try {
      buf = Buffer.from(candidate, 'base64');
    } catch {
      break;
    }
    if (!buf || buf.length < 17) break;
    if (buf.slice(0, 8).toString('ascii') === 'Salted__') {
      cipherBuf = buf;
      break;
    }
    candidate = buf.toString('utf8').trim();
  }

  if (!cipherBuf || cipherBuf.length <= 16) return null;

  try {
    const salt = cipherBuf.slice(8, 16);
    const encrypted = cipherBuf.slice(16);
    const { key, iv } = deriveOpenSslKeyAndIv(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').trim();
    return decrypted || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. HELPERS DE METADATOS, CARÁTULAS, EPISODIOS Y FORMATO
// ---------------------------------------------------------------------------

/**
 * Decodifica el nombre original embebido en Base64 dentro de las carátulas:
 * `/caratulas/peliculas/QmFkLUFwcGxlcy0oMjAyNSktW0JsdVJheS03MjBwXS1bRG9uVG9ycmVudF0tWzlhY0RdLmpwZw/...`
 * → `"Bad-Apples-(2025)-[BluRay-720p]-[DonTorrent]-[9acD].jpg"`
 */
function decodeCaratulaHint(imgUrl) {
  const s = String(imgUrl || '').trim();
  const m = s.match(/\/caratulas\/[^/]+\/([A-Za-z0-9+/_=-]{12,})\//);
  if (!m) return null;
  try {
    const normalized = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    if (!decoded || decoded.includes('\uFFFD')) return null;
    const yearMatch = decoded.match(/\((\d{4})\)/) || decoded.match(/\b((?:19|20)\d{2})\b/);
    return {
      rawName: decoded,
      año: yearMatch ? yearMatch[1] : null
    };
  } catch {
    return null;
  }
}

function normalizeWolfTabla(rawTabla, sectionHint = '') {
  const t = String(rawTabla || sectionHint || '').toLowerCase().trim();
  if (t.startsWith('pelicula')) return 'peliculas';
  if (t.startsWith('serie') || t === 'episodio') return 'series';
  if (t.startsWith('animacion')) return 'animacion';
  if (t.startsWith('documental')) return 'documentales';
  return 'peliculas';
}

function normalizeWolfQuality(rawQuality, fallbackText = '') {
  const q = String(rawQuality || '').trim();
  if (/^4kwebrip$/i.test(q)) return '4K';
  const combined = `${q} ${fallbackText || ''}`.trim();
  const detected = R.calidadDeNombre(combined);
  if (detected) return detected;
  if (/\b(4k|2160p|uhd)\b/i.test(combined)) return '4K';
  if (/\b(1080p|bluray[\s-]*1080|microhd|bdremux)\b/i.test(combined)) return '1080p';
  if (/\b(720p|bluray[\s-]*720|hdtv[\s-]*720)\b/i.test(combined)) return '720p';
  if (/\b(hdrip|bdrip)\b/i.test(combined)) return '720p';
  if (/\b(dvdrip|hdtv|480p|xvid|cam|screener)\b/i.test(combined)) return '480p';
  return '720p';
}

function normalizeWolfSize(rawSize) {
  const s = String(rawSize || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i);
  if (!m) return null;
  return `${m[1].replace(',', '.')} ${m[2].toUpperCase()}`;
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

function urlToSlug(urlOrSlug) {
  const raw = String(urlOrSlug || '').trim().replace(/^wt:/i, '');
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch { return null; }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const m = pathname.match(DETAIL_PATH_RE);
  if (!m) return null;
  const section = m[1].toLowerCase();
  const epSeg = m[2] ? `${m[2].toLowerCase()}/` : '';
  const code = m[3];
  const extraSlug = m[4] ? `/${m[4]}` : '';

  if (LISTING_SEGMENTS_RE.test(code)) return null;
  if (!extraSlug && !WOLF_CODE_RE.test(code)) return null;
  return `${section}/${epSeg}${code}${extraSlug}`;
}

function slugToUrl(slug, baseUrl = BASE_URL) {
  const clean = urlToSlug(slug);
  if (!clean) return null;
  return `${String(baseUrl || BASE_URL).replace(/\/+$/, '')}/${clean}`;
}

/**
 * Limpia el título de tarjeta o ficha en WolfTorrent extrayendo título base,
 * temporada (`seasonHint`), año e idioma.
 * Ejemplos reales:
 *   "Materia oscura - 1ª Temporada" -> { titulo: "Materia oscura", seasonHint: 1 }
 *   "Bad Apples"                    -> { titulo: "Bad Apples", seasonHint: null }
 */
function parseWolfTitle(rawTitle, extraHint = '') {
  let text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (text.endsWith('.')) text = text.slice(0, -1).trim();

  let seasonHint = null;
  const sm = text.match(/(\d{1,2})\s*(?:ª|a|º)?\s*temporada/i) || text.match(/temporada\s*(\d{1,2})/i);
  if (sm) seasonHint = parseInt(sm[1], 10);

  let año = null;
  const ym = `${text} ${extraHint}`.match(/[\[(]((?:19|20)\d{2})[\])]/) ||
    text.match(/\b((?:19|20)\d{2})\s*$/);
  if (ym) año = ym[1];

  const combined = `${text} ${extraHint}`;
  let idioma = 'Castellano';
  if (/\b(dual|multi|es-en)\b/i.test(combined)) idioma = 'Latino/Inglés';
  else if (/\blatino\b/i.test(combined)) idioma = 'Latino';
  else if (/\b(vose|subtitulad[oa])\b/i.test(combined)) idioma = 'Inglés';

  const clean = text
    .replace(/\s*[-–]?\s*\(?\d{1,2}\s*(?:ª|a|º)?\s*temporada\)?.*$/i, '')
    .replace(/\s*\[(?:esp|spanish|castellano|4k|2160p|1080p|720p|bluray[^\]]*|hdtv[^\]]*|cap\.?\s*\d+)\]/gi, ' ')
    .replace(/\(?wolf(?:max4k|torrent)\.(?:com|org|net)\)?/gi, ' ')
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    titulo: clean || text,
    año,
    seasonHint,
    idioma
  };
}

/**
 * Parsea el texto de episodio de WolfTorrent (`li.wolf-card-file` o tabla):
 *   "Episodio 2x01 al 06."          -> { season: 2, episode: null, episodes: [1..6], esPack: true }
 *   "Episodio 4x01 al 4x08."        -> { season: 4, episode: null, episodes: [1..8], esPack: true }
 *   "Episodio 3x07 - 3x08."         -> { season: 3, episode: 7, episodes: [7, 8], esPack: false }
 *   "Episodio 1x05 - 06 - 07 - 08." -> { season: 1, episode: 5, episodes: [5,6,7,8], esPack: false }
 *   "Episodio 1x10 -"               -> { season: 1, episode: 10, episodes: [10], esPack: false }
 */
function parseWolfEpisodeText(rawEpisodeText, fallbackSeason = null) {
  const text = String(rawEpisodeText || '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (!text) return { season: fallbackSeason, episode: null, episodes: [], esPack: false };

  // Rango con "al": "Episodio 2x01 al 06" o "Episodio 4x01 al 4x08"
  const rangeMatch = text.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})\s+al\s+(?:\d{1,2}\s*[xX×]\s*)?(\d{1,3})\b/i);
  if (rangeMatch) {
    const season = parseInt(rangeMatch[1], 10);
    const startEp = parseInt(rangeMatch[2], 10);
    const endEp = parseInt(rangeMatch[3], 10);
    if (endEp >= startEp && endEp - startEp <= 60) {
      const episodes = [];
      for (let e = startEp; e <= endEp; e++) episodes.push(e);
      const esPack = startEp === 1 && episodes.length >= 6;
      return { season, episode: esPack ? null : startEp, episodes, esPack };
    }
  }

  // Lista con guiones: "Episodio 1x05 - 06 - 07" o "Episodio 3x07 - 3x08"
  const listHeader = text.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})((?:\s*-\s*(?:\d{1,2}\s*[xX×]\s*)?\d{1,3})+)/i);
  if (listHeader) {
    const season = parseInt(listHeader[1], 10);
    const firstEp = parseInt(listHeader[2], 10);
    const extraNums = [...listHeader[3].matchAll(/(?:\d{1,2}\s*[xX×]\s*)?(\d{1,3})/g)]
      .map(m => parseInt(m[1], 10))
      .filter(Number.isFinite);
    const episodes = [...new Set([firstEp, ...extraNums])];
    return { season, episode: firstEp, episodes, esPack: false };
  }

  // Episodio simple: "Episodio 1x10 -" o "1x08"
  const singleMatch = text.match(/(\d{1,2})\s*[xX×]\s*(\d{1,3})(?!\d)/);
  if (singleMatch) {
    const season = parseInt(singleMatch[1], 10);
    const episode = parseInt(singleMatch[2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  const capMatch = text.match(/\[?Cap\.?\s*(\d{1,2})(\d{2})\]?/i);
  if (capMatch) {
    const season = parseInt(capMatch[1], 10);
    const episode = parseInt(capMatch[2], 10);
    return { season, episode, episodes: [episode], esPack: false };
  }

  if (/\b(?:temporada\s*completa|completa)\b/i.test(text)) {
    return { season: fallbackSeason, episode: null, episodes: [], esPack: true };
  }

  return { season: fallbackSeason, episode: null, episodes: [], esPack: false };
}

// ---------------------------------------------------------------------------
// 3. PARSERS HTML (`article.wolf-card`, `/api/episodios` Y FICHAS DE DETALLE)
// ---------------------------------------------------------------------------

/**
 * Extrae las filas `li.wolf-card-file` (tanto de una tarjeta de búsqueda como
 * de la respuesta HTML de `/api/episodios` o de una ficha de detalle).
 */
function parseWolfFileItems($, fileNodes, { section = 'pelicula', seasonHint = null, idiomaDefault = 'Castellano', baseUrl = BASE_URL } = {}) {
  const entries = [];
  const esSerie = section === 'serie' || section === 'animacion' || section === 'documental';

  $(fileNodes).each((_, li) => {
    const $li = $(li);
    const $format = $li.find('.wolf-card-format, a[href]').first();
    const formatHref = $format.attr('href') || '';
    const detailSlug = urlToSlug(formatHref);

    const strongText = $format.find('strong').first().text().replace(/\s+/g, ' ').trim();
    const spanText = $format.find('span').first().text().replace(/\s+/g, ' ').trim();
    const rawFormatText = $format.text().replace(/\s+/g, ' ').trim();

    // En series: strong = "Episodio 1x10 -", span = "HDTV"
    // En películas: strong = "BluRay-1080p" (sin span)
    const hasEpisodeMarker = /\b(?:episodio|\d{1,2}\s*[xX×]\s*\d{1,3}|cap\.?\s*\d+)/i.test(strongText || rawFormatText);
    const episodeText = (esSerie || hasEpisodeMarker) ? (strongText || rawFormatText) : '';
    const rawQuality = spanText || (!hasEpisodeMarker ? strongText : '') || rawFormatText;
    const sizeText = normalizeWolfSize($li.find('.wolf-card-size').first().text());

    // Localizar credenciales de descarga: button.protected-download o enlace /descarga/{tipo}/{code} o magnet/.torrent
    const $btn = $li.find('button.protected-download, [data-content-code], [data-content-id]').first();
    let contentCode = $btn.attr('data-content-code') || $btn.attr('data-content-id') || null;
    let tabla = $btn.attr('data-tabla') || null;
    let directDownloadUrl = null;
    let magnet = null;

    $li.find('a[href], button[data-magnet], button[data-href]').each((__, el) => {
      const h = $(el).attr('href') || $(el).attr('data-magnet') || $(el).attr('data-href') || '';
      if (!h) return;
      if (/^magnet:\?xt=urn:btih:/i.test(h)) {
        magnet = h.trim();
        return;
      }
      if (/\.torrent(?:[?#]|$)/i.test(h)) {
        try { directDownloadUrl = new URL(h, baseUrl).toString(); } catch { /* ignore */ }
        return;
      }
      try {
        const u = new URL(h, baseUrl);
        const dm = u.pathname.match(DESCARGA_PATH_RE);
        if (dm && !contentCode) {
          tabla = normalizeWolfTabla(dm[1], section);
          contentCode = dm[2];
        }
      } catch {
        // Ignorar href inválido
      }
    });

    // Si la fila apunta a /pelicula/{code} o /serie/episodio/{code} pero el botón está dentro de la ficha,
    // extraer el code de la propia ruta de detalle como respaldo
    if (!contentCode && detailSlug) {
      const parts = detailSlug.split('/');
      const lastSeg = parts[parts.length - 1];
      if (WOLF_CODE_RE.test(lastSeg)) {
        contentCode = lastSeg;
        tabla = normalizeWolfTabla(tabla, section);
      }
    }

    if (!magnet && !directDownloadUrl && !contentCode) return;

    const epInfo = (esSerie || hasEpisodeMarker)
      ? parseWolfEpisodeText(episodeText, seasonHint)
      : { season: null, episode: null, episodes: [], esPack: false };

    const calidad = normalizeWolfQuality(rawQuality);
    entries.push({
      contentCode,
      tabla: normalizeWolfTabla(tabla, section),
      detailSlug: detailSlug || null,
      downloadUrl: directDownloadUrl,
      magnet,
      calidad,
      calidadRaw: rawQuality || null,
      idioma: idiomaDefault,
      subtitulos: idiomaDefault === 'Inglés' ? 'Integrados' : 'No',
      tamaño: sizeText,
      season: epInfo.season,
      episode: epInfo.episode,
      episodes: epInfo.episodes,
      esPack: epInfo.esPack,
      label: episodeText || rawQuality || ''
    });
  });

  return entries;
}

/**
 * Parsea la página de resultados `/buscar?q={query}` de WolfTorrent.
 */
function parseSearchHtml(html, { baseUrl = BASE_URL, filterType = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const $ = cheerio.load(html);
  const results = [];
  const seenSlugs = new Set();

  $('article.wolf-card').each((_, card) => {
    const $card = $(card);
    const $main = $card.find('a.wolf-card-main, h2 a[href], h3 a[href]').first();
    const href = $main.attr('href') || '';
    const slug = urlToSlug(href);
    if (!slug || seenSlugs.has(slug)) return;

    const section = slug.split('/')[0];
    const esSerie = section === 'serie' || section === 'documental' ||
      (section === 'animacion' && /\b(?:temporada|episodio|\d+x\d+)\b/i.test($card.text()));

    if (filterType === 'series' && !esSerie && section !== 'animacion') return;
    if (filterType === 'movie' && esSerie && section !== 'animacion') return;

    const posterSrc = $card.find('.wolf-card-poster img, img').first().attr('data-original') ||
      $card.find('.wolf-card-poster img, img').first().attr('src') || '';
    const caratula = decodeCaratulaHint(posterSrc);
    const rawTitle = $main.text().replace(/\s+/g, ' ').trim();
    const parsedTitle = parseWolfTitle(rawTitle, caratula?.rawName || '');
    if (!parsedTitle.titulo) return;

    const episodesApiAttr = $card.find('details[data-wolf-episodes]').attr('data-wolf-episodes') || null;
    const torrents = parseWolfFileItems($, $card.find('li.wolf-card-file'), {
      section: esSerie ? 'serie' : 'pelicula',
      seasonHint: parsedTitle.seasonHint,
      idiomaDefault: parsedTitle.idioma,
      baseUrl
    });

    seenSlugs.add(slug);
    results.push({
      id: `wt:${slug}`,
      slug,
      url: slugToUrl(slug, baseUrl),
      titulo: parsedTitle.titulo,
      tituloOriginal: null,
      año: parsedTitle.año || caratula?.año || null,
      tipo: esSerie ? 'serie' : (section === 'animacion' ? 'anime' : 'pelicula'),
      seasonHint: parsedTitle.seasonHint,
      idioma: parsedTitle.idioma,
      episodesApiPath: episodesApiAttr,
      torrents
    });
  });

  // Fallback para plantillas clásicas sin article.wolf-card
  if (results.length === 0) {
    $('a[href]').each((_, el) => {
      const $a = $(el);
      if ($a.closest('nav, header, footer').length > 0) return;
      const slug = urlToSlug($a.attr('href') || '');
      if (!slug || seenSlugs.has(slug)) return;
      const section = slug.split('/')[0];
      if (section === 'serie' && slug.includes('/episodio/')) return;
      const esSerie = section === 'serie' || section === 'documental';
      if (filterType === 'series' && !esSerie && section !== 'animacion') return;
      if (filterType === 'movie' && esSerie && section !== 'animacion') return;

      const text = $a.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2 || /^(?:ver\s+ficha|descargar|todas)$/i.test(text)) return;
      const parsed = parseWolfTitle(text);
      if (!parsed.titulo) return;

      seenSlugs.add(slug);
      results.push({
        id: `wt:${slug}`,
        slug,
        url: slugToUrl(slug, baseUrl),
        titulo: parsed.titulo,
        tituloOriginal: null,
        año: parsed.año,
        tipo: esSerie ? 'serie' : 'pelicula',
        seasonHint: parsed.seasonHint,
        idioma: parsed.idioma,
        episodesApiPath: null,
        torrents: []
      });
    });
  }

  return results;
}

/**
 * Parsea una ficha de detalle `/pelicula/{code}`, `/serie/{code}` o `/serie/episodio/{code}`.
 */
function parseDetailHtml(html, { slug = '', url = '', baseUrl = BASE_URL } = {}) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const $ = cheerio.load(html);
  $('nav, header, footer, #comentarios, .comments, .related, .relacionados, .related-torrents').remove();

  const effectiveSlug = urlToSlug(slug || url) || String(slug || '').trim();
  const section = effectiveSlug.split('/')[0] || 'pelicula';
  const esSerie = section === 'serie' || section === 'documental' || effectiveSlug.includes('/episodio/');

  const rawH1 = $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('title').first().text().split('·')[0].split('|')[0].replace(/\s+/g, ' ').trim();

  const posterSrc = $('img[src*="/caratulas/"], img[data-original*="/caratulas/"]').first().attr('data-original') ||
    $('img[src*="/caratulas/"]').first().attr('src') || '';
  const caratula = decodeCaratulaHint(posterSrc);

  // Extraer pares <dt>/<dd> (en vivo vienen sin dos puntos: <dt>Calidad</dt><dd>BluRay-720p</dd>)
  let tituloOriginal = null;
  let añoFicha = null;
  let calidadFicha = null;
  let tamanoFicha = null;
  let idiomaFicha = null;

  $('dt').each((_, dt) => {
    const label = $(dt).text().replace(/:\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const val = $(dt).next('dd').text().replace(/\s+/g, ' ').trim();
    if (!val) return;
    if (/^t[ií]tulo\s+original$/i.test(label) && !tituloOriginal) tituloOriginal = val;
    else if (/^a[ñn]o$/i.test(label) && !añoFicha) {
      const ym = val.match(/\b((?:19|20)\d{2})\b/);
      if (ym) añoFicha = ym[1];
    } else if (/^(?:calidad|formato|resoluci[oó]n)$/i.test(label) && !calidadFicha) {
      calidadFicha = val;
    } else if (/^(?:tama[ñn]o|peso)$/i.test(label) && !tamanoFicha) {
      tamanoFicha = normalizeWolfSize(val);
    } else if (/^(?:idioma|audio)$/i.test(label) && !idiomaFicha) {
      idiomaFicha = val;
    }
  });

  const parsedHeader = parseWolfTitle(rawH1, `${caratula?.rawName || ''} ${idiomaFicha || ''}`);
  const titulo = parsedHeader.titulo || rawH1;
  const año = añoFicha || parsedHeader.año || caratula?.año || null;
  const idioma = idiomaFicha ? parseWolfTitle('', idiomaFicha).idioma : parsedHeader.idioma;

  let torrents = parseWolfFileItems($, $('li.wolf-card-file'), {
    section: esSerie ? 'serie' : 'pelicula',
    seasonHint: parsedHeader.seasonHint,
    idiomaDefault: idioma,
    baseUrl
  });

  // Si la ficha es de una versión única (p. ej. /pelicula/r8e6a8 o /serie/episodio/5jdgc3)
  // o una tabla clásica de episodios sin li.wolf-card-file:
  if (torrents.length === 0) {
    const seenKeys = new Set();

    // Filas de episodios en tablas o enlaces a /serie/episodio/{code}
    if (esSerie && !effectiveSlug.includes('/episodio/')) {
      $('tr, .episode, .episodio, li').each((_, row) => {
        const $row = $(row);
        const $epLink = $row.find('a[href*="/episodio/"], a[href*="/descarga/"], a[href^="magnet:"], a[href$=".torrent"]').first();
        if (!$epLink.length) return;
        const href = $epLink.attr('href') || '';
        const rowText = $row.text().replace(/\s+/g, ' ').trim();
        const epInfo = parseWolfEpisodeText(rowText, parsedHeader.seasonHint);
        if (epInfo.season === null && epInfo.episode === null && !epInfo.esPack) return;

        let contentCode = $row.find('[data-content-code]').attr('data-content-code') || null;
        let tabla = $row.find('[data-tabla]').attr('data-tabla') || 'series';
        let magnet = /^magnet:\?xt=urn:btih:/i.test(href) ? href : null;
        let downloadUrl = /\.torrent(?:[?#]|$)/i.test(href) ? new URL(href, baseUrl).toString() : null;

        if (!contentCode && !magnet && !downloadUrl) {
          const dm = href.match(DESCARGA_PATH_RE);
          if (dm) {
            tabla = normalizeWolfTabla(dm[1], 'serie');
            contentCode = dm[2];
          } else {
            const epSlug = urlToSlug(href);
            if (epSlug) {
              const last = epSlug.split('/').pop();
              if (WOLF_CODE_RE.test(last)) contentCode = last;
            }
          }
        }

        const key = magnet || downloadUrl || `${tabla}:${contentCode}`;
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);

        torrents.push({
          contentCode,
          tabla: normalizeWolfTabla(tabla, 'serie'),
          detailSlug: urlToSlug(href),
          downloadUrl,
          magnet,
          calidad: normalizeWolfQuality(calidadFicha, rowText),
          idioma,
          subtitulos: idioma === 'Inglés' ? 'Integrados' : 'No',
          tamaño: normalizeWolfSize(rowText) || tamanoFicha,
          season: epInfo.season,
          episode: epInfo.episode,
          episodes: epInfo.episodes,
          esPack: epInfo.esPack,
          label: rowText
        });
      });
    }

    // Botón/enlace principal de descarga de la propia ficha (/pelicula/r8e6a8 o /serie/episodio/5jdgc3)
    if (torrents.length === 0) {
      let contentCode = $('button.protected-download, [data-content-code]').first().attr('data-content-code') || null;
      let tabla = $('button.protected-download, [data-tabla]').first().attr('data-tabla') || null;
      let magnet = $('a[href^="magnet:"]').first().attr('href') || null;
      let downloadUrl = null;

      const torrentAnchor = $('a[href$=".torrent"], a[href*="/torrents/"]').first().attr('href');
      if (torrentAnchor) {
        try { downloadUrl = new URL(torrentAnchor, baseUrl).toString(); } catch { /* ignore */ }
      }

      if (!contentCode && !magnet && !downloadUrl) {
        $('a[href*="/descarga/"]').each((_, a) => {
          const h = $(a).attr('href') || '';
          try {
            const u = new URL(h, baseUrl);
            const dm = u.pathname.match(DESCARGA_PATH_RE);
            if (dm && !contentCode) {
              tabla = normalizeWolfTabla(dm[1], section);
              contentCode = dm[2];
            }
          } catch { /* ignore */ }
        });
      }

      if (!contentCode && !magnet && !downloadUrl) {
        const last = effectiveSlug.split('/').pop() || '';
        if (WOLF_CODE_RE.test(last)) {
          contentCode = last;
          tabla = normalizeWolfTabla(tabla, section);
        }
      }

      if (contentCode || magnet || downloadUrl) {
        const epInfo = esSerie ? parseWolfEpisodeText(rawH1, parsedHeader.seasonHint) : { season: null, episode: null, episodes: [], esPack: false };
        torrents.push({
          contentCode,
          tabla: normalizeWolfTabla(tabla, section),
          detailSlug: effectiveSlug,
          downloadUrl,
          magnet,
          calidad: normalizeWolfQuality(calidadFicha, `${rawH1} ${caratula?.rawName || ''}`),
          idioma,
          subtitulos: idioma === 'Inglés' ? 'Integrados' : 'No',
          tamaño: tamanoFicha,
          season: epInfo.season,
          episode: epInfo.episode,
          episodes: epInfo.episodes,
          esPack: epInfo.esPack,
          label: rawH1
        });
      }
    }
  }

  return {
    slug: effectiveSlug,
    url: url || slugToUrl(effectiveSlug, baseUrl),
    titulo,
    tituloOriginal,
    año,
    seasonHint: parsedHeader.seasonHint,
    tipo: esSerie ? 'serie' : 'pelicula',
    torrents
  };
}

// ---------------------------------------------------------------------------
// 4. CAPA DE RED, `/api/episodios`, `/api/descargas` Y `enlacito.com`
// ---------------------------------------------------------------------------

function extractCookiesHeader(setCookieHeader, existingCookies = '') {
  const jar = new Map();
  if (existingCookies) {
    for (const pair of existingCookies.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : (typeof setCookieHeader === 'string' ? [setCookieHeader] : []);
  for (const raw of list) {
    const first = String(raw || '').split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchHtml(pathOrUrl, { referer = null, timeoutMs = 12000, extraHeaders = {} } = {}) {
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
            ...(referer ? { Referer: referer } : {}),
            ...extraHeaders
          },
          responseType: 'text',
          maxRedirects: 5
        }));
        if (mirror) {
          activeMirror = mirror;
          activeMirrorExp = Date.now() + 15 * 60 * 1000;
        }
        return typeof res?.data === 'string' ? res.data : JSON.stringify(res?.data ?? '');
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
  throw lastErr || new Error(`WolfTorrent: fallo al descargar ${pathOrUrl}`);
}

/**
 * Expande todos los capítulos ocultos de una tarjeta de serie usando
 * `GET /api/episodios?type=serie&id=<numId>&calidad=` con `X-Requested-With: XMLHttpRequest`.
 */
async function fetchHiddenCardEpisodes(episodesApiPath, { seasonHint = null, idioma = 'Castellano', baseUrl = BASE_URL } = {}) {
  if (!episodesApiPath) return null;
  const cleanPath = String(episodesApiPath).replace(/&after=\d+/i, '');
  const allItems = [];
  let afterSuffix = '';

  for (let page = 0; page < 5; page++) {
    try {
      const raw = await fetchHtml(`${cleanPath}${afterSuffix}`, {
        referer: `${baseUrl}/`,
        timeoutMs: 8000,
        extraHeaders: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!json || !json.success || typeof json.html !== 'string') return allItems.length > 0 ? allItems : null;

      const $ = cheerio.load(`<ul>${json.html}</ul>`);
      const parsed = parseWolfFileItems($, $('li.wolf-card-file'), {
        section: 'serie',
        seasonHint,
        idiomaDefault: idioma,
        baseUrl
      });
      allItems.push(...parsed);

      if (!json.next_after) break;
      afterSuffix = `&after=${encodeURIComponent(String(json.next_after))}`;
    } catch {
      return allItems.length > 0 ? allItems : null;
    }
  }

  return allItems;
}

/**
 * Resuelve el protector `https://enlacito.com/s.php?i=...` sin navegador:
 * 1) GET `s.php?i=...` (guarda cookie `PHPSESSID` y campos `linkser` + `flow`).
 * 2) POST al `action` del formulario → extrae `var link_out = "..."`.
 * 3) Desencripta con AES-256-CBC (`fee631d2cffda38a78b96ee6d2dfb43a`).
 */
async function resolveEnlacitoUrl(enlacitoUrl, { referer = `${BASE_URL}/` } = {}) {
  const step1 = await axios.get(enlacitoUrl, withKeepAlive({
    timeout: timeout(10000),
    headers: {
      ...DEFAULT_HEADERS,
      Referer: referer
    },
    responseType: 'text',
    maxRedirects: 5
  }));

  const html1 = typeof step1?.data === 'string' ? step1.data : '';
  if (!html1) return null;

  // Si ya contiene link_out directamente en el primer paso
  const directOut = html1.match(/var\s+link_out\s*=\s*["']([^"']+)["']/);
  if (directOut) {
    return decryptEnlacitoPayload(directOut[1]);
  }

  const cookies = extractCookiesHeader(step1.headers?.['set-cookie']);
  const $ = cheerio.load(html1);
  const $form = $('form').first();
  if (!$form.length) return null;

  const actionAttr = $form.attr('action') || enlacitoUrl;
  const postUrl = new URL(actionAttr, enlacitoUrl).toString().split('#')[0];
  const params = new URLSearchParams();
  $form.find('input[name]').each((_, inp) => {
    const name = $(inp).attr('name');
    const val = $(inp).attr('value') ?? '';
    if (name) params.append(name, val);
  });

  const step2 = await axios.post(postUrl, params.toString(), withKeepAlive({
    timeout: timeout(10000),
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: enlacitoUrl,
      ...(cookies ? { Cookie: cookies } : {})
    },
    responseType: 'text',
    maxRedirects: 5
  }));

  const html2 = typeof step2?.data === 'string' ? step2.data : '';
  const matchOut = html2.match(/var\s+link_out\s*=\s*["']([^"']+)["']/);
  if (!matchOut) return null;

  return decryptEnlacitoPayload(matchOut[1]);
}

async function fetchTorrentMetainfo(torrentUrl, { referer = `${BASE_URL}/`, cookies = '', season = null, episode = null, isMovie = false } = {}) {
  const res = await axios.get(torrentUrl, withKeepAlive({
    timeout: timeout(10000),
    headers: {
      ...DEFAULT_HEADERS,
      Accept: 'application/x-bittorrent,*/*;q=0.8',
      Referer: referer,
      ...(cookies ? { Cookie: cookies } : {})
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

  if (!buf || !isTorrentBuffer(buf)) return null;

  const parsed = parseTorrentBuffer(buf);
  const hasVideo = parsed.files.some(f => VIDEO_FILE_RE.test(f.name || f.path || '')) ||
    R.esReleaseVideo(parsed.name || '');
  if (!hasVideo) return null;

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
    tamaño: formatBytes(chosenSize || parsed.totalSize),
    ...(Number.isInteger(fileIdx) && fileIdx >= 0 ? { fileIdx } : {})
  };
}

/**
 * Ejecuta el flujo completo de resolución de una descarga en WolfTorrent:
 * magnet directo -> .torrent directo -> POST /api/descargas (PoW + validate) -> Enlacito AES -> Bencode.
 */
async function resolverDescargaWolfTorrent(item, { season = null, episode = null, isMovie = false } = {}) {
  if (!item) return null;

  if (item.magnet && R.extraerInfoHash(item.magnet)) {
    return {
      infoHash: R.extraerInfoHash(item.magnet),
      magnet: item.magnet,
      dn: item.dn || null,
      tamaño: item.tamaño || null
    };
  }

  const base = activeMirror || BASE_URL;

  if (item.downloadUrl) {
    const cacheKey = `url:${item.downloadUrl}`;
    const hit = lruGet(downloadCache, cacheKey);
    if (hit) return hit.invalid ? null : hit;

    try {
      const targetUrl = item.downloadUrl.includes('enlacito.')
        ? await resolveEnlacitoUrl(item.downloadUrl, { referer: `${base}/` })
        : item.downloadUrl;
      if (!targetUrl) return null;
      if (/^magnet:\?xt=urn:btih:/i.test(targetUrl)) {
        const infoHash = R.extraerInfoHash(targetUrl);
        const val = { infoHash, magnet: targetUrl, dn: null, tamaño: item.tamaño || null };
        lruSet(downloadCache, cacheKey, val, TORRENT_CACHE_TTL_MS, 2000);
        return val;
      }
      const meta = await fetchTorrentMetainfo(targetUrl, { referer: `${base}/`, season, episode, isMovie });
      lruSet(downloadCache, cacheKey, meta || { invalid: true }, meta ? TORRENT_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS, 2000);
      return meta;
    } catch {
      return null;
    }
  }

  if (!item.contentCode) return null;
  const tabla = normalizeWolfTabla(item.tabla);
  const codeKey = `code:${tabla}:${item.contentCode}`;
  const cached = lruGet(downloadCache, codeKey);
  if (cached) {
    if (cached.invalid) return null;
    return cached;
  }

  // Cortacircuitos si el sitio exige captcha interactivo Turnstile y no hay solver configurado
  const solverUrl = getSolverUrl();
  if (captchaCircuitUntil > Date.now() && !solverUrl) {
    return null;
  }

  return withSingleFlight(inFlight, `dl:${codeKey}`, async () => {
    const again = lruGet(downloadCache, codeKey);
    if (again) return again.invalid ? null : again;

    const apiUrl = `${base}/api/descargas`;
    const referer = item.detailSlug ? slugToUrl(item.detailSlug, base) : `${base}/`;

    try {
      const genRes = await axios.post(
        apiUrl,
        { action: 'generate', code: item.contentCode, tabla },
        withKeepAlive({
          timeout: timeout(8000),
          headers: {
            ...DEFAULT_HEADERS,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Referer: referer
          },
          validateStatus: s => s >= 200 && s < 500
        })
      );

      let cookies = extractCookiesHeader(genRes.headers?.['set-cookie']);
      const genData = typeof genRes.data === 'string' ? JSON.parse(genRes.data) : (genRes.data || {});

      if (genData.status === 'captcha_required' || /turnstile|captcha/i.test(String(genData.error || ''))) {
        if (!solverUrl) {
          if (captchaCircuitUntil <= Date.now()) {
            console.warn('[WolfTorrent] /api/descargas requiere verificación humana Turnstile; degradando limpiamente.');
          }
          captchaCircuitUntil = Date.now() + CAPTCHA_CIRCUIT_TTL_MS;
          return null;
        }
        // Delegación opcional a Byparr / FlareSolverr si el usuario configuró WOLFTORRENT_SOLVER_URL
        const solved = await resolveViaSolver(solverUrl, `${base}/descarga/${tabla === 'peliculas' ? 'pelicula' : 'serie'}/${item.contentCode}`);
        if (solved) {
          lruSet(downloadCache, codeKey, solved, TORRENT_CACHE_TTL_MS, 2000);
          return solved;
        }
        return null;
      }

      if (!genData.success && genData.status !== 'pow_pending' && !genData.download_url) {
        lruSet(downloadCache, codeKey, { invalid: true }, NEGATIVE_CACHE_TTL_MS, 2000);
        return null;
      }

      let valData = genData;

      // Resolver Proof-of-Work si el servidor devuelve un desafío SHA-256
      if (!valData.download_url && genData.challenge) {
        const pow = genData.pow || {};
        const rounds = Number(pow.rounds) || 1;
        const difficulty = Number(pow.difficulty) || 3;
        const minDurationMs = Math.min(2500, Math.max(0, Number(pow.min_duration_ms) || 0));

        const started = Date.now();
        const nonces = computeProofOfWork(genData.challenge, rounds, difficulty);
        const remainingWait = minDurationMs - (Date.now() - started);
        if (remainingWait > 0) await sleep(remainingWait);

        for (let attempt = 0; attempt < 3; attempt++) {
          const valRes = await axios.post(
            apiUrl,
            { action: 'validate', challenge: genData.challenge, nonces },
            withKeepAlive({
              timeout: timeout(8000),
              headers: {
                ...DEFAULT_HEADERS,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Referer: referer,
                ...(cookies ? { Cookie: cookies } : {})
              },
              validateStatus: s => s >= 200 && s < 500
            })
          );
          cookies = extractCookiesHeader(valRes.headers?.['set-cookie'], cookies);
          valData = typeof valRes.data === 'string' ? JSON.parse(valRes.data) : (valRes.data || {});
          if (valData.status !== 'pow_pending') break;
          await sleep(Math.min(1500, Math.max(100, Number(valData.retry_after_ms) || 300)));
        }
      }

      if (!valData || !valData.download_url) {
        lruSet(downloadCache, codeKey, { invalid: true }, NEGATIVE_CACHE_TTL_MS, 2000);
        return null;
      }

      let targetUrl = new URL(valData.download_url, `${base}/`).toString();
      if (valData.external || targetUrl.includes('enlacito.')) {
        targetUrl = await resolveEnlacitoUrl(targetUrl, { referer: `${base}/` });
      }
      if (!targetUrl) return null;

      if (/^magnet:\?xt=urn:btih:/i.test(targetUrl)) {
        const infoHash = R.extraerInfoHash(targetUrl);
        if (!infoHash) return null;
        const resolved = { infoHash, magnet: targetUrl, dn: null, tamaño: item.tamaño || null };
        lruSet(downloadCache, codeKey, resolved, TORRENT_CACHE_TTL_MS, 2000);
        return resolved;
      }

      const meta = await fetchTorrentMetainfo(targetUrl, {
        referer: `${base}/`,
        cookies,
        season,
        episode,
        isMovie
      });
      lruSet(downloadCache, codeKey, meta || { invalid: true }, meta ? TORRENT_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS, 2000);
      return meta;
    } catch {
      return null;
    }
  });
}

async function resolveViaSolver(solverUrl, pageUrl) {
  try {
    const res = await axios.post(
      `${solverUrl}/v1`,
      { cmd: 'request.get', url: pageUrl, maxTimeout: 20000 },
      withKeepAlive({ timeout: timeout(15000) })
    );
    const html = res?.data?.solution?.response || '';
    if (!html) return null;
    const magnetMatch = html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"'<>]*/i);
    if (magnetMatch) {
      const infoHash = R.extraerInfoHash(magnetMatch[0]);
      if (infoHash) return { infoHash, magnet: magnetMatch[0], dn: null, tamaño: null };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolverMagnetsEnLote(torrents, opts = {}) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 3));
  const season = opts.season ?? null;
  const episode = opts.episode ?? null;
  const isMovie = Boolean(opts.isMovie);

  const out = new Array(torrents.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < torrents.length) {
      const idx = cursor++;
      const item = torrents[idx];
      if (!item) continue;

      const meta = await resolverDescargaWolfTorrent(item, {
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
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, torrents.length) }, () => worker()));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// 5. API PÚBLICA DEL SCRAPER (buscarEnWolfTorrent / extraerDetalleTorrent / buscarStreams)
// ---------------------------------------------------------------------------

async function buscarEnWolfTorrent(query, tipoObjetivo = null) {
  const cleanQ = String(query || '')
    .replace(/\b[Ss]\d{1,2}[Ee]\d{1,3}\b/g, ' ')
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:espa[ñn]ol|spanish|castellano|spa)\b/gi, ' ')
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
      const path = `/buscar?q=${encodeURIComponent(cleanQ)}`;
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
    const matchKind = torrentMatchesEpisode(t, s, e);
    if (matchKind === 'exact') {
      exactos.push(t);
    } else if (matchKind === 'pack') {
      if (Array.isArray(t.episodes) && t.episodes.length > 0 && !t.episodes.includes(e)) {
        continue;
      }
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

  const baseName = extra.titulo || tituloFallback || 'WolfTorrent';
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
    name: `WolfTorrent\n${calidad}`,
    title: lineas.join('\n'),
    infoHash,
    sources: R.construirSources(infoHash, torrent.magnet),
    behaviorHints: {
      bingeGroup: `wolftorrent-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      ...(dn ? { filename: dn } : {})
    },
    _meta: {
      fuente: 'wolftorrent',
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
 * Busca y resuelve streams en WolfTorrent aprovechando las calidades embebidas
 * en `article.wolf-card` y expandiendo `/api/episodios` o la ficha cuando hace falta.
 */
async function buscarStreams({ title, originalTitle, altTitles = [], year, type, season = null, episode = null } = {}) {
  if (captchaCircuitUntil > Date.now() && !getSolverUrl()) {
    return [];
  }

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

  let allCandidates = [];
  const seenSlugs = new Set();
  const settled = await Promise.allSettled(
    queries.slice(0, 3).map(q => buscarEnWolfTorrent(q, tipoObjetivo))
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

  if (esSerie && season !== null) {
    const targetSeason = Number(season);
    const matchingSeason = allCandidates.filter(
      c => c.seasonHint === null || c.seasonHint === undefined || c.seasonHint === targetSeason
    );
    if (matchingSeason.length > 0) allCandidates = matchingSeason;
  }

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

  // En películas, WolfTorrent mete todas las calidades en 1 tarjeta; en series hay 1 tarjeta por temporada+calidad
  const maxInspect = esSerie ? 4 : 2;
  const toInspect = (mejores.length > 0 ? mejores : ranked).slice(0, maxInspect).map(r => r.cand);

  const exactQueue = [];
  const packQueue = [];

  for (const cand of toInspect) {
    let torrents = Array.isArray(cand.torrents) ? [...cand.torrents] : [];
    let resolvedTitle = cand.titulo;
    let resolvedOrig = cand.tituloOriginal;
    let resolvedYear = cand.año;

    // Si la tarjeta tiene capítulos ocultos en /api/episodios y no vemos aún el episodio pedido, expandirlos
    if (esSerie && conEpisodio && cand.episodesApiPath) {
      const preCheck = filtrarPorEpisodio(torrents, season, episode);
      if (preCheck.exactos.length === 0) {
        const expanded = await fetchHiddenCardEpisodes(cand.episodesApiPath, {
          seasonHint: cand.seasonHint,
          idioma: cand.idioma,
          baseUrl: activeMirror || BASE_URL
        });
        if (Array.isArray(expanded) && expanded.length > 0) {
          torrents = expanded;
        }
      }
    }

    // Si aún no hay torrents en la tarjeta o falta verificar año/título original, abrir la ficha
    const initialScore = scoreCandidate(cand, esSerie ? { ...target, year: null } : target);
    const missingMovieYear = !esSerie && Boolean(year) && !cand.año;
    const needDetail = torrents.length === 0 || initialScore.score < MIN_SCORE || missingMovieYear;
    if (needDetail) {
      const detalle = await extraerDetalleTorrent(cand.slug);
      if (detalle) {
        resolvedTitle = detalle.titulo || resolvedTitle;
        resolvedOrig = detalle.tituloOriginal || resolvedOrig;
        resolvedYear = detalle.año || resolvedYear;
        if (torrents.length === 0 && Array.isArray(detalle.torrents)) {
          torrents = detalle.torrents;
        }
      }
    }

    const verified = scoreCandidate({
      ...cand,
      titulo: resolvedTitle,
      tituloOriginal: resolvedOrig,
      año: resolvedYear
    }, esSerie ? { ...target, year: null } : target);

    if (verified.score < MIN_SCORE) continue;

    if (esSerie && conEpisodio) {
      const { exactos, packs } = filtrarPorEpisodio(torrents, season, episode);
      for (const t of exactos) exactQueue.push({ torrent: t, titulo: resolvedTitle, esPack: false });
      for (const t of packs) packQueue.push({ torrent: t, titulo: resolvedTitle, esPack: true });
    } else if (!esSerie) {
      for (const t of torrents) {
        const se = torrentSeasonEpisode(t);
        if (se.season === null && se.episode === null && !se.isPack) {
          exactQueue.push({ torrent: t, titulo: resolvedTitle, esPack: false });
        }
      }
    }
  }

  const chosen = exactQueue.length > 0 ? exactQueue : packQueue;
  if (chosen.length === 0) return [];

  const resolved = await resolverMagnetsEnLote(
    chosen.map(e => ({ ...e.torrent, _titulo: e.titulo, _esPack: e.esPack })),
    {
      season,
      episode,
      isMovie: !esSerie
    }
  );

  const streams = [];
  const seenHashes = new Set();
  for (const r of resolved) {
    const stream = torrentToStream(r, r._titulo || title, {
      titulo: r._titulo || title,
      season: esSerie ? season : null,
      episode: esSerie ? (r._esPack ? null : episode) : null,
      esPack: Boolean(r._esPack)
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
  TORRENT_LINK_ENCRYPTION_KEY,
  computeProofOfWork,
  deriveOpenSslKeyAndIv,
  decryptEnlacitoPayload,
  decodeCaratulaHint,
  urlToSlug,
  slugToUrl,
  parseWolfTitle,
  parseWolfEpisodeText,
  parseSearchHtml,
  parseDetailHtml,
  resolveEnlacitoUrl,
  resolverDescargaWolfTorrent,
  buscarEnWolfTorrent,
  extraerDetalleTorrent,
  resolverMagnetsEnLote,
  filtrarPorEpisodio,
  torrentToStream,
  buscarStreams,
  clearCache
};
