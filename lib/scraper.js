/**
 * lib/scraper.js
 * ---------------------------------------------------------------------------
 * Módulo de scraping y consumo de API para HackTorrent (https://hacktorrent.cc)
 *
 * Basado en el análisis real del sitio (WordPress + tema React "wpreact"):
 *
 *  API REST Primaria (JSON limpio, sin Cloudflare challenge):
 *    - Búsqueda:  GET /wp-json/wpreact/v1/search?query={q}
 *                 → { results: [...], total, pages }
 *    - Películas: GET /wp-json/wpreact/v1/movies?page={n}
 *                 → { movies: [...], total }
 *    - Estrenos:  GET /wp-json/wpreact/v1/released?page={n}
 *                 → { movies: [...], total }
 *    - Series:    GET /wp-json/wpreact/v1/series?page={n}
 *                 → { series: [...], total }
 *    - Animes:    GET /wp-json/wpreact/v1/animes?page={n}
 *                 → { animes: [...], total }
 *    - Categoría: GET /wp-json/wpreact/v1/category?category={nombre}&page={n}
 *                 → { results: [...], total, pages }
 *    - Detalle:   GET /wp-json/wpreact/v1/movie/{slug}
 *                 GET /wp-json/wpreact/v1/serie/{slug}
 *                 GET /wp-json/wpreact/v1/anime/{slug}
 *                 → { id, slug, title, original_title, overview, duracion,
 *                     background_image, featured, year, years, actors,
 *                     director, genres, tmdb_id, imdb, type, language,
 *                     downloads: [{ quality, date, size, subs,
 *                                   download_type, download_link, language }],
 *                     related: [...] }
 *    - Lookup TMDB → Título en español en HackTorrent:
 *                 GET /?tmdb={tmdb_id}
 *                 → <a>Título en Español</a>
 *
 *  API REST Secundaria (fallback):
 *    - Home:      GET /wp-json/react/v1/home
 *    - Búsqueda:  GET /wp-json/react/v1/search?q={q}
 *    - Archivo:   GET /wp-json/react/v1/archive?post_type=peliculas&paged={n}
 *
 *  Fallback HTML (Cheerio):
 *    - Búsqueda:  GET /?s={q}
 *    - Detalle:   GET /pelicula/{slug}/ | /serie/{slug}/ | /anime/{slug}/
 *                 (En series, las tablas de episodios están en el HTML con
 *                  enlaces acortalink.net/s.php?i=... cifrados con OpenSSL
 *                  AES-256-CBC Salted__ y enlaces /player/{season}/{episode})
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('node:crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { timeout } = require('./timeouts');

const BASE_URL = (process.env.HACKTORRENT_URL || 'https://hacktorrent.cc').replace(/\/+$/, '');
const TMDB_IMG_W300 = 'https://image.tmdb.org/t/p/w300';
const TMDB_IMG_ORIG = 'https://image.tmdb.org/t/p/original';

// Clave AES-256-CBC (OpenSSL EVP_BytesToKey + MD5) usada por acortalink.net / acortalink.me
const ACORTALINK_AES_PASSPHRASE = Buffer.from('fee631d2cffda38a78b96ee6d2dfb43a', 'utf8');

// Headers realistas de navegador para evitar bloqueos 403/Cloudflare
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Referer': `${BASE_URL}/`,
  'Origin': BASE_URL
};

const HTTP_TIMEOUT_MS = parseInt(process.env.HACKTORRENT_TIMEOUT_MS || '10000', 10);
const CACHE_TTL_SEARCH_MS = 30 * 60 * 1000;      // 30 minutos
const CACHE_TTL_NEGATIVE_MS = 5 * 60 * 1000;     // 5 minutos para búsquedas vacías/errores
const CACHE_TTL_DETAIL_MS = 2 * 60 * 60 * 1000;  // 2 horas
const CACHE_TTL_CATALOG_MS = 20 * 60 * 1000;     // 20 minutos
const CACHE_TTL_SHORTLINK_MS = 12 * 60 * 60 * 1000; // 12 horas
const CACHE_MAX_ENTRIES = parseInt(process.env.HACKTORRENT_CACHE_MAX || '500', 10);

// Caché en memoria con TTL + expulsión LRU y deduplicación de peticiones en vuelo
const memoryCache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  if (memoryCache.has(key)) memoryCache.delete(key);
  while (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function runDedup(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Petición HTTP GET con reintentos exponenciales (máx 2 reintentos).
 */
async function httpGet(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: timeout(options.timeout || HTTP_TIMEOUT_MS),
        headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
        maxRedirects: options.maxRedirects !== undefined ? options.maxRedirects : 5,
        validateStatus: options.validateStatus || (status => status >= 200 && status < 400),
        responseType: options.responseType || 'json'
      });
      return response;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 451) break;
      if (attempt < retries) {
        const delay = 350 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ===========================================================================
// UTILIDADES DE NORMALIZACIÓN Y CRIPTOGRAFÍA
// ===========================================================================

function normalizeText(str) {
  if (!str) return '';
  return String(str).replace(/\s+/g, ' ').trim();
}

function normalizeSearchToken(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePosterUrl(rawUrl, isBackdrop = false) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let clean = rawUrl.trim();
  if (!clean) return null;

  clean = clean.replace(/https:\/\/image\.tmdb\.org\/t\/p\/(w\d+|original)\/\//g, (m, size) => {
    return `https://image.tmdb.org/t/p/${size}/`;
  });

  if (/^https?:\/\/image\.tmdb\.org\/t\/p\/(w\d+|original)\/?$/i.test(clean)) {
    return null;
  }

  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  if (clean.startsWith('//')) {
    return `https:${clean}`;
  }
  if (clean.startsWith('/')) {
    return `${isBackdrop ? TMDB_IMG_ORIG : TMDB_IMG_W300}${clean}`;
  }
  return `${BASE_URL}/${clean}`;
}

function extractYear(rawYear, fallbackYears) {
  for (const candidate of [rawYear, fallbackYears]) {
    if (!candidate) continue;
    let text = '';
    if (Array.isArray(candidate)) {
      text = candidate
        .map(v => (typeof v === 'object' && v ? (v.name || v.slug || v.year || '') : String(v || '')))
        .join(' ');
    } else if (typeof candidate === 'object') {
      text = String(candidate.name || candidate.slug || candidate.year || '');
    } else {
      text = String(candidate);
    }
    const match = text.match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Decodifica el campo `_guid` de `/wp-json/react/v1/*`:
 * ROT13 sobre Base64 del `tmdb_id` (ej. "ZGV0ZmL0" -> "MTI0MzY0" -> "124364").
 */
function decodeReactGuid(guid) {
  if (!guid || typeof guid !== 'string') return null;
  try {
    const unrot = guid.trim().replace(/[a-zA-Z]/g, ch => {
      const base = ch <= 'Z' ? 65 : 97;
      return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
    });
    const decoded = Buffer.from(unrot, 'base64').toString('utf8').trim();
    return /^\d+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Convierte un hash Base32 de 32 caracteres (RFC 4648) a hex de 40 caracteres.
 */
function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(b32 || '').toUpperCase().replace(/=+$/, '');
  if (clean.length !== 32) return null;
  let bits = '';
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val === -1) return null;
    bits += val.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.length === 40 ? hex.toLowerCase() : null;
}

/**
 * Comprueba si una cadena es un enlace magnet válido con btih.
 * Acepta tanto `magnet:?xt=urn:btih:...` como magnets híbridos v1/v2
 * `magnet:?xt=urn:btmh:...&xt=urn:btih:...`.
 */
function isValidMagnet(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  return /^magnet:\?/i.test(s) && /(?:[?&]|^)xt=urn:btih:[a-zA-Z0-9]+/i.test(s);
}

/**
 * Normaliza un enlace magnet:
 *  - Convierte btih en Base32 (32 chars) a hex de 40 chars si aplica.
 *  - Si el magnet es híbrido (`xt=urn:btmh:...&xt=urn:btih:...`), coloca
 *    `xt=urn:btih:<hash>` como primer parámetro para máxima compatibilidad con Stremio.
 */
function normalizarMagnet(rawMagnet) {
  if (!isValidMagnet(rawMagnet)) return null;
  let magnet = String(rawMagnet).trim();

  const m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32}|[a-fA-F0-9]{32})/i);
  if (!m) return magnet;

  let hash = m[1];
  if (hash.length === 32 && /^[A-Z2-7]{32}$/i.test(hash) && !/^[0-9a-f]{32}$/i.test(hash)) {
    const hex = base32ToHex(hash);
    if (hex) {
      magnet = magnet.replace(m[0], `urn:btih:${hex}`);
      hash = hex;
    }
  } else if (hash.length === 40 && /^[0-9a-f]{40}$/i.test(hash)) {
    hash = hash.toLowerCase();
    magnet = magnet.replace(m[0], `urn:btih:${hash}`);
  }

  // Si no empieza directamente por magnet:?xt=urn:btih:, reordenar para que btih vaya primero
  if (!/^magnet:\?xt=urn:btih:/i.test(magnet)) {
    const query = magnet.replace(/^magnet:\?/i, '');
    const parts = query.split('&').filter(Boolean);
    const btihIndex = parts.findIndex(p => /^xt=urn:btih:/i.test(p));
    if (btihIndex > 0) {
      const [btihPart] = parts.splice(btihIndex, 1);
      magnet = `magnet:?${[btihPart, ...parts].join('&')}`;
    }
  }

  return magnet;
}

/**
 * Descifra el payload `Salted__` (OpenSSL AES-256-CBC con MD5 EVP_BytesToKey)
 * utilizado por `acortalink.net/s.php?i=...` y `acortalink.me/s.php?i=...`.
 *
 * No realiza ninguna petición de red (< 0.1 ms).
 *
 * @param {string} encoded Valor del parámetro `i` o URL completa de acortalink
 * @returns {string|null} Enlace magnet descifrado o null
 */
function decryptAcortalink(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;

  let candidate = encoded.trim();
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const u = new URL(candidate);
      candidate =
        u.searchParams.get('i') ||
        u.searchParams.get('u') ||
        u.searchParams.get('url') ||
        u.searchParams.get('s') ||
        u.searchParams.get('target') ||
        u.searchParams.get('data') ||
        '';
    } catch {
      const m = candidate.match(/[?&](?:i|u|url|s|target|data)=([^&#]+)/i);
      candidate = m ? decodeURIComponent(m[1]) : '';
    }
  }

  candidate = candidate.trim().replace(/\s+/g, '');
  if (!candidate || candidate.length < 16) return null;

  // Normalizar Base64 URL-safe si aplica
  const toStdB64 = str => str.replace(/-/g, '+').replace(/_/g, '/');

  try {
    const step1Buf = Buffer.from(toStdB64(candidate), 'base64');
    let rawBuf = null;

    if (step1Buf.length >= 16 && step1Buf.subarray(0, 8).toString('ascii') === 'Salted__') {
      rawBuf = step1Buf;
    } else {
      const innerStr = step1Buf.toString('ascii').trim();
      if (innerStr.startsWith('U2FsdGVkX1')) {
        const step2Buf = Buffer.from(toStdB64(innerStr), 'base64');
        if (step2Buf.length >= 16 && step2Buf.subarray(0, 8).toString('ascii') === 'Salted__') {
          rawBuf = step2Buf;
        }
      }
    }

    if (!rawBuf || rawBuf.length <= 16) return null;

    const salt = rawBuf.subarray(8, 16);
    const encrypted = rawBuf.subarray(16);

    // OpenSSL EVP_BytesToKey (MD5) → 32 bytes key + 16 bytes IV = 48 bytes
    let dtot = Buffer.alloc(0);
    let d = Buffer.alloc(0);
    while (dtot.length < 48) {
      d = crypto
        .createHash('md5')
        .update(Buffer.concat([d, ACORTALINK_AES_PASSPHRASE, salt]))
        .digest();
      dtot = Buffer.concat([dtot, d]);
    }

    const key = dtot.subarray(0, 32);
    const iv = dtot.subarray(32, 48);

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
      .toString('utf8')
      .trim();

    if (isValidMagnet(decrypted)) {
      return normalizarMagnet(decrypted);
    }
    return null;
  } catch {
    return null;
  }
}

function normalizarTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim();
  if (t === 'movie' || t === 'movies' || t === 'pelicula' || t === 'peliculas' || t === 'película') {
    return 'pelicula';
  }
  if (t === 'serie' || t === 'series' || t === 'tv' || t === 'show') {
    return 'serie';
  }
  if (t === 'anime' || t === 'animes') {
    return 'anime';
  }
  return 'pelicula';
}

function tipoToEndpoint(tipo) {
  const norm = normalizarTipo(tipo);
  if (norm === 'pelicula') return 'movie';
  if (norm === 'serie') return 'serie';
  if (norm === 'anime') return 'anime';
  return 'movie';
}

function tipoToHtmlPath(tipo) {
  const norm = normalizarTipo(tipo);
  if (norm === 'pelicula') return 'pelicula';
  if (norm === 'serie') return 'serie';
  if (norm === 'anime') return 'anime';
  return 'pelicula';
}

function slugAndTypeFromPath(urlOrPath) {
  const s = String(urlOrPath || '');
  const m = s.match(/\/(peliculas?|movies?|series?|animes?)\/([^/?#]+)/i);
  if (m) {
    return { tipo: normalizarTipo(m[1]), slug: decodeURIComponent(m[2]) };
  }
  const clean = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
  if (clean && !clean.includes('/')) {
    return { tipo: null, slug: decodeURIComponent(clean) };
  }
  return { tipo: null, slug: '' };
}

function normalizeCalidad(raw, fallbackText = '') {
  const s = normalizeText(raw);
  if (s) {
    const low = s.toLowerCase();
    if (low.includes('2160') || low.includes('4k') || low.includes('uhd')) return s;
    if (low.includes('1080')) return s;
    if (low.includes('720')) return s;
    if (low.includes('480')) return s;
    if (low.includes('cam') || low.includes('ts') || low.includes('hdrip') || low.includes('bluray') || low.includes('web')) {
      return s;
    }
  }
  const fb = normalizeText(fallbackText).toLowerCase();
  if (fb.includes('2160p') || fb.includes('4k') || fb.includes('uhd')) return '4K';
  if (fb.includes('1080p')) return 'WEB-DL 1080p';
  if (fb.includes('720p')) return '720p';
  if (fb.includes('480p')) return '480p';
  return s || 'HD';
}

function normalizeTamaño(raw, magnet = null) {
  const s = normalizeText(raw);
  if (s && s !== '0' && s.toLowerCase() !== 'desconocido' && s.toLowerCase() !== 'n/a') {
    return s;
  }
  if (magnet) {
    const xlMatch = String(magnet).match(/[?&]xl=(\d+)/i);
    if (xlMatch) {
      const bytes = Number(xlMatch[1]);
      if (Number.isFinite(bytes) && bytes > 0) {
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(2)} GB`;
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(0)} MB`;
      }
    }
  }
  return 'Desconocido';
}

function normalizeIdioma(raw) {
  const s = normalizeText(raw).toLowerCase().replace(/_/g, ' ');
  if (!s) return 'Latino';
  const hasEsp = s.includes('latino') || s.includes('español') || s.includes('espanol') || s.includes('castellano');
  const hasIng = s.includes('ingl') || s.includes('english');
  const hasJap = s.includes('japon') || s.includes('jap');
  if (hasEsp && hasIng) return 'Latino/Inglés';
  if (hasEsp && hasJap) return 'Latino/Japonés';
  if (hasEsp && (s.includes('dual') || s.includes('/'))) return 'Latino/Inglés';
  if (s.includes('latino')) return 'Latino';
  if (s.includes('castellano') || s.includes('español') || s.includes('espanol')) return 'Castellano';
  if (s.includes('sub') || s.includes('vose')) return 'Subtitulado';
  if (hasIng) return 'Inglés';
  if (hasJap) return 'Japonés';
  return normalizeText(raw);
}

function normalizeSubs(raw) {
  if (raw === 1 || raw === '1' || raw === true) return 'Sí';
  if (raw === 0 || raw === '0' || raw === false) return 'No';
  const s = normalizeText(raw).toLowerCase();
  if (!s) return null;
  if (s === 'si' || s === 'sí' || s === 'yes' || s.includes('forzado') || s.includes('esp') || s.includes('srt')) {
    return 'Sí';
  }
  if (s === 'no' || s === 'none') return 'No';
  return normalizeText(raw);
}

/**
 * Extrae temporada y episodio desde el nombre del magnet (`dn=...`) o texto libre.
 * Soporta formatos: S01E02, S1E2, 1x02, Temporada 1 Capitulo 2, Cap 102, E05, etc.
 */
function extraerTemporadaEpisodio(texto, defaultSeason = 1) {
  const s = String(texto || '');
  if (!s) return { temporada: null, episodio: null };

  // S01E02 / s1e2 / S01.E02 / T01E02
  let m = s.match(/\b[ST](\d{1,2})[\s._-]*E(\d{1,3})\b/i);
  if (m) {
    return { temporada: parseInt(m[1], 10), episodio: parseInt(m[2], 10) };
  }

  // 1x02 / 01x02
  m = s.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) {
    return { temporada: parseInt(m[1], 10), episodio: parseInt(m[2], 10) };
  }

  // Temporada 1 Episodio 2 / Temp 1 Cap 2
  m = s.match(/(?:temporada|temp|season)\s*(\d{1,2}).*?(?:episodio|ep|cap(?:itulo|ítulo)?|episode)\s*(\d{1,3})/i);
  if (m) {
    return { temporada: parseInt(m[1], 10), episodio: parseInt(m[2], 10) };
  }

  // Solo episodio explícito: "Cap 5" / "Episodio 05"
  m = s.match(/\b(?:episodio|episode|cap(?:itulo|ítulo)?)\s*(\d{1,3})\b/i);
  if (m) {
    return { temporada: defaultSeason, episodio: parseInt(m[1], 10) };
  }

  // Solo temporada completa (pack): "S01.Completa" / "Temporada 1 Completa"
  m = s.match(/\b(?:[ST](\d{1,2})|(?:temporada|season)\s*(\d{1,2}))\b/i);
  if (m && /(?:completa|complete|pack|full)/i.test(s)) {
    return { temporada: parseInt(m[1] || m[2], 10), episodio: null };
  }

  return { temporada: null, episodio: null };
}

function parseMagnetDn(magnet) {
  if (!magnet) return '';
  const m = String(magnet).match(/[?&]dn=([^&]+)/i);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return m[1];
  }
}

/**
 * Normaliza un objeto de película/serie/anime proveniente de `wpreact/v1` o `react/v1`.
 */
function mapRawItemToResult(item, tipoFallback = null) {
  if (!item || typeof item !== 'object') return null;

  const linkRaw = item.link || item.url || item.permalink || '';
  const fromPath = slugAndTypeFromPath(linkRaw);

  const slug = String(item.slug || item.post_name || fromPath.slug || '').trim();
  const titulo = normalizeText(item.title?.rendered || item.title || item.name || item.post_title || '');
  if (!slug || !titulo) return null;

  const tipoNorm = normalizarTipo(item.type || item.post_type || fromPath.tipo || tipoFallback || 'pelicula');
  const año = extractYear(item.year, item.years || item.release_date || item.date);

  const poster = normalizePosterUrl(
    item.featured || item.poster || item.image || item.thumbnail || item.poster_path,
    false
  );
  const background = normalizePosterUrl(
    item.background_image || item.backdrop || item.backdrop_path,
    true
  );

  let generos = [];
  if (Array.isArray(item.genres)) {
    generos = item.genres
      .map(g => (typeof g === 'string' ? g.trim() : normalizeText(g?.name || g?.title || '')))
      .filter(Boolean);
  } else if (typeof item.genres === 'string' && item.genres.trim()) {
    generos = item.genres.split(',').map(g => g.trim()).filter(Boolean);
  }

  const actores = typeof item.actors === 'string' && item.actors.trim()
    ? item.actors.split(',').map(a => a.trim()).filter(Boolean)
    : [];

  const director = typeof item.director === 'string' && item.director.trim()
    ? item.director.split(',').map(d => d.trim()).filter(Boolean)
    : [];

  const tmdbId = item.tmdb_id
    ? String(item.tmdb_id).trim()
    : decodeReactGuid(item._guid || item.guid);

  const htmlPath = tipoToHtmlPath(tipoNorm);

  return {
    id: item.id || item._id || slug,
    slug,
    titulo,
    tituloOriginal: normalizeText(item.original_title || item.originalTitle || ''),
    tipo: tipoNorm,
    año,
    duracion: normalizeText(item.duracion || item.runtime || ''),
    imdbRating: item.imdb && item.imdb !== '0' ? String(item.imdb) : null,
    tmdbId: tmdbId || null,
    idioma: normalizeIdioma(item.language || 'Latino'),
    generos,
    actores,
    director,
    sinopsis: normalizeText(item.overview || item.synopsis || item.excerpt || ''),
    poster,
    background,
    url: linkRaw
      ? (linkRaw.startsWith('http') ? linkRaw : `${BASE_URL}${linkRaw.startsWith('/') ? '' : '/'}${linkRaw}`)
      : `${BASE_URL}/${htmlPath}/${slug}/`
  };
}

// ===========================================================================
// Datos de respaldo cuando HackTorrent no es accesible desde este entorno
// ===========================================================================
const MOCK_ENABLED = process.env.HACKTORRENT_MOCK !== '0';

const MOCK_ITEMS = [
  {
    slug: 'el-lobo-de-wall-street',
    titulo: 'El Lobo de Wall Street',
    tituloOriginal: 'The Wolf of Wall Street',
    tipo: 'pelicula',
    año: '2013',
    duracion: '180m',
    imdbRating: '8.0',
    tmdbId: '106646',
    idioma: 'Castellano',
    generos: ['Crimen', 'Drama', 'Comedia'],
    actores: ['Leonardo DiCaprio', 'Jonah Hill', 'Margot Robbie'],
    director: ['Martin Scorsese'],
    sinopsis: 'Película basada en hechos reales del corredor de bolsa neoyorquino Jordan Belfort.',
    poster: 'https://image.tmdb.org/t/p/w300/qTu16kpDi8rXQ5co7K5i2sd3xj.jpg',
    background: 'https://image.tmdb.org/t/p/original/63y4XSVTZ7mRzAzkqwi3o0ajDZZ.jpg',
    torrents: [
      {
        calidad: '4K Ultra HD',
        tamaño: '71.7 GB',
        idioma: 'Castellano',
        subtitulos: 'No',
        fecha: '20240105',
        temporada: null,
        episodio: null,
        magnet: 'magnet:?xt=urn:btih:4E9DAF6EEA8B88CD0AFDC1E3175C1796D6D19438&dn=El%20lobo%20de%20Wall%20Street%20%5b4K%20UHDremux%202160p%5d&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a80%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce',
        acortalink: null,
        dn: 'El lobo de Wall Street [4K UHDremux 2160p]'
      }
    ]
  },
  {
    slug: 'el-proyecto-colibri',
    titulo: 'El Proyecto Colibrí',
    tituloOriginal: 'The Hummingbird Project',
    tipo: 'pelicula',
    año: '2019',
    duracion: '111m',
    imdbRating: '6.2',
    tmdbId: '507076',
    idioma: 'Latino',
    generos: ['Suspense', 'Drama'],
    actores: ['Jesse Eisenberg', 'Alexander Skarsgård', 'Salma Hayek'],
    director: ['Kim Nguyen'],
    sinopsis: 'Dos primos de Nueva York intentan construir un cable de fibra óptica en línea recta entre Kansas y Nueva Jersey.',
    poster: 'https://image.tmdb.org/t/p/w300/uRRuhlqmzGnxugvA257Rt3dzvaz.jpg',
    background: 'https://image.tmdb.org/t/p/original/f3s2c2A61U6A7L9mF0C1hB5pB6.jpg',
    torrents: [
      {
        calidad: 'WEB-DL 1080p',
        tamaño: '3.70 GB',
        idioma: 'Latino',
        subtitulos: 'Sí',
        fecha: '20240105',
        temporada: null,
        episodio: null,
        magnet: 'magnet:?xt=urn:btih:a7a4b188eb86e5ae3023d64aa75c573dded4a015&dn=El.Proyecto.Colibri.2019.1080p-Dual-Lat&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a80%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce',
        acortalink: null,
        dn: 'El.Proyecto.Colibri.2019.1080p-Dual-Lat'
      },
      {
        calidad: '720p',
        tamaño: '1.01 GB',
        idioma: 'Latino',
        subtitulos: 'Sí',
        fecha: '20240105',
        temporada: null,
        episodio: null,
        magnet: 'magnet:?xt=urn:btih:889dfd64f9722a2067f4dc9f22cde7df33d78d2f&dn=El.Proyecto.Colibri.2019.720p-Lat&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a80%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce',
        acortalink: null,
        dn: 'El.Proyecto.Colibri.2019.720p-Lat'
      }
    ]
  },
  {
    slug: 'from',
    titulo: 'From',
    tituloOriginal: 'FROM',
    tipo: 'serie',
    año: '2022',
    duracion: '50m',
    imdbRating: '8.2',
    tmdbId: '124364',
    idioma: 'Latino/Inglés',
    generos: ['Misterio', 'Drama', 'Sci-Fi & Fantasy'],
    actores: ['Harold Perrineau', 'Catalina Sandino Moreno', 'Eion Bailey'],
    director: ['Jack Bender'],
    sinopsis: 'Desvela el misterio de un pueblo de pesadilla en el centro de América que atrapa a todos los que entran.',
    poster: 'https://image.tmdb.org/t/p/w300/cjXLrg4R7FRPFafvuQ3SSznQOd9.jpg',
    background: 'https://image.tmdb.org/t/p/original/6gN8DYnIEln8v7OhRy61c57w0Xy.jpg',
    torrents: [
      {
        calidad: 'WEB-DL 1080p',
        tamaño: '2.33 GB',
        idioma: 'Latino/Inglés',
        subtitulos: 'Sí',
        fecha: '20240105',
        temporada: 1,
        episodio: 1,
        magnet: 'magnet:?xt=urn:btih:449cd19d1ee326767a0bf47d4bd8dc4ba29ccc69&dn=From.S01E01.2022.WEB-DL.1080p-Dual-Lat&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a80%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce',
        acortalink: null,
        dn: 'From.S01E01.2022.WEB-DL.1080p-Dual-Lat'
      }
    ]
  }
];

// ===========================================================================
// 1. BÚSQUEDA EN HACKTORRENT (3 NIVELES DE FALLBACK + LOOKUP TMDB)
// ===========================================================================

function extractArrayFromPayload(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload.data && Array.isArray(payload.data[key])) return payload.data[key];
  }

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.posts)) return payload.posts;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

/**
 * Verifica si un resultado de fallback (`?s=`) guarda relación con la consulta,
 * evitando que el sitio devuelva la portada o los últimos posts cuando no hay coincidencias.
 */
function matchesSearchQuery(item, query) {
  if (!item || !query) return false;
  const qNorm = normalizeSearchToken(query);
  if (!qNorm) return true;

  const qTokens = qNorm.split(' ').filter(t => t.length >= 2 || /^\d+$/.test(t));
  const checkTokens = qTokens.length > 0 ? qTokens : qNorm.split(' ').filter(Boolean);

  const candidates = [
    item.titulo,
    item.tituloOriginal,
    String(item.slug || '').replace(/-/g, ' ')
  ]
    .map(normalizeSearchToken)
    .filter(Boolean);

  for (const cand of candidates) {
    if (cand.includes(qNorm) || qNorm.includes(cand)) return true;
    const candWords = new Set(cand.split(' '));
    const matched = checkTokens.filter(t => candWords.has(t));
    if (matched.length > 0 && matched.length >= Math.ceil(checkTokens.length * 0.5)) {
      return true;
    }
  }
  return false;
}

/**
 * Nivel 1: Búsqueda mediante `/wp-json/wpreact/v1/search?query=...`
 */
async function fetchWpreactSearch(query) {
  const url = `${BASE_URL}/wp-json/wpreact/v1/search?query=${encodeURIComponent(query)}`;
  try {
    const res = await httpGet(url);
    const items = extractArrayFromPayload(res.data, ['results', 'movies', 'series', 'animes']);
    if (!items.length) return [];
    return items.map(item => mapRawItemToResult(item)).filter(Boolean);
  } catch (err) {
    console.warn(`[Scraper] ❌ Error wpreact search "${query}": ${err.message}`);
    return null;
  }
}

/**
 * Nivel 2: Búsqueda mediante `/wp-json/react/v1/search?q=...` (y fallback `?s=...`)
 */
async function fetchReactSearch(query) {
  for (const param of ['q', 's']) {
    const url = `${BASE_URL}/wp-json/react/v1/search?${param}=${encodeURIComponent(query)}`;
    try {
      const res = await httpGet(url);
      if (res.data && res.data.error === true) continue;
      const rawList = extractArrayFromPayload(res.data, ['data', 'results', 'posts', 'items']);
      if (rawList.length > 0) {
        let mapped = rawList.map(item => mapRawItemToResult(item)).filter(Boolean);
        // En el sitio real, `?s=` sin `?q=` devuelve los últimos posts sin filtrar.
        if (param === 's') {
          mapped = mapped.filter(item => matchesSearchQuery(item, query));
        }
        if (mapped.length > 0) {
          console.log(`[Scraper] ✅ react (${param}) devolvió ${mapped.length} resultados`);
          return mapped;
        }
      }
    } catch (err) {
      console.warn(`[Scraper] ❌ Error react search (${param}) "${query}": ${err.message}`);
    }
  }
  return null;
}

/**
 * Nivel 3: Scraping HTML directo con Cheerio sobre `/?s=...`
 */
async function scrapeHtmlSearch(query) {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  try {
    const res = await httpGet(url, { responseType: 'text' });
    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (!html) return [];

    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/(peliculas?|movies?|series?|animes?)\/([^/?#]+)/i);
      if (!m) return;

      const tipo = normalizarTipo(m[1]);
      const slug = decodeURIComponent(m[2]).trim();
      if (!slug || slug === 'page' || seen.has(`${tipo}:${slug}`)) return;

      const $card = $(el).closest('article, li, .item, .post, .TPost, .movie-card, div');
      let titulo =
        normalizeText($(el).attr('title')) ||
        normalizeText($card.find('h1, h2, h3, h4, .title, .Title').first().text()) ||
        normalizeText($(el).text());

      titulo = titulo.replace(/^(ver|descargar)\s+/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (!titulo || titulo.length < 2) return;

      const img =
        $card.find('img').attr('data-src') ||
        $card.find('img').attr('src') ||
        $(el).find('img').attr('src') ||
        null;

      const cardText = $card.text();
      const año = extractYear(cardText);

      const candidate = {
        id: slug,
        slug,
        titulo,
        tituloOriginal: '',
        tipo,
        año,
        duracion: '',
        imdbRating: null,
        tmdbId: null,
        idioma: 'Latino',
        generos: [],
        actores: [],
        director: [],
        sinopsis: '',
        poster: normalizePosterUrl(img, false),
        background: null,
        url: `${BASE_URL}/${tipoToHtmlPath(tipo)}/${slug}/`
      };

      if (!matchesSearchQuery(candidate, query)) return;

      seen.add(`${tipo}:${slug}`);
      results.push(candidate);
    });

    console.log(`[Scraper] ✅ HTML search devolvió ${results.length} resultados para "${query}"`);
    return results;
  } catch (err) {
    console.warn(`[Scraper] ❌ Error HTML search "${query}": ${err.message}`);
    return [];
  }
}

/**
 * Busca contenido en HackTorrent por texto.
 */
async function buscarEnHackTorrent(query) {
  const q = normalizeText(query);
  if (!q) return [];

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return runDedup(cacheKey, async () => {
    console.log(`[Scraper] 🔍 Buscando en HackTorrent: "${q}"`);

    const l1 = await fetchWpreactSearch(q);
    if (l1 && l1.length > 0) {
      console.log(`[Scraper] ✅ wpreact devolvió ${l1.length} resultados`);
      cacheSet(cacheKey, l1, CACHE_TTL_SEARCH_MS);
      return l1;
    }

    console.log(`[Scraper] wpreact sin resultados, probando fallback react...`);
    const l2 = await fetchReactSearch(q);
    if (l2 && l2.length > 0) {
      cacheSet(cacheKey, l2, CACHE_TTL_SEARCH_MS);
      return l2;
    }

    console.log(`[Scraper] react sin resultados, probando scraping HTML...`);
    const l3 = await scrapeHtmlSearch(q);
    const out = l3 || [];
    cacheSet(cacheKey, out, out.length > 0 ? CACHE_TTL_SEARCH_MS : CACHE_TTL_NEGATIVE_MS);
    return out;
  });
}

/**
 * Resuelve un TMDB ID (`moviedb_id` de Cinemeta) al título en español indexado
 * por HackTorrent mediante `GET /?tmdb={tmdbId}` y devuelve los candidatos
 * encontrados en HackTorrent.
 *
 * Esto soluciona el caso en que Cinemeta entrega el título en inglés
 * (ej. "The Wolf of Wall Street", "Slow Horses", "The Shawshank Redemption")
 * pero HackTorrent sólo indexa el título en español ("El Lobo de Wall Street",
 * "Caballos lentos", "Sueño de fuga").
 *
 * @param {string|number} tmdbId
 * @returns {Promise<Array>} Lista de resultados de HackTorrent
 */
async function buscarPorTmdb(tmdbId) {
  const cleanId = String(tmdbId || '').trim();
  if (!/^\d+$/.test(cleanId)) return [];

  const cacheKey = `tmdb:${cleanId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return runDedup(cacheKey, async () => {
    try {
      const url = `${BASE_URL}/?tmdb=${encodeURIComponent(cleanId)}`;
      const res = await httpGet(url, { responseType: 'text', timeout: 6000 }, 1);
      const html = typeof res.data === 'string' ? res.data : String(res.data || '');
      if (!html || html.length > 20000) {
        cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
        return [];
      }

      const $ = cheerio.load(html);
      // Si devolvió la página completa en vez del snippet `<a>Título</a>`, ignorar
      if ($('table, nav, footer, h1').length > 0) {
        cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
        return [];
      }

      const titles = [];
      $('a').each((_, el) => {
        const t = normalizeText($(el).text());
        if (t && !titles.includes(t)) titles.push(t);
      });
      if (titles.length === 0) {
        const bodyText = normalizeText($.root().text());
        if (bodyText && bodyText.length < 160) titles.push(bodyText);
      }

      if (titles.length === 0) {
        cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
        return [];
      }

      const combined = [];
      const seenSlugs = new Set();

      for (const esTitle of titles.slice(0, 2)) {
        console.log(`[Scraper] 🎯 TMDB ${cleanId} → título en HackTorrent: "${esTitle}"`);
        const found = await buscarEnHackTorrent(esTitle);
        for (const item of found || []) {
          const key = `${item.tipo}:${item.slug}`;
          if (seenSlugs.has(key)) continue;
          seenSlugs.add(key);
          // Si el ítem de wpreact coincide en tmdbId o en título exacto, asegurar tmdbId
          if (!item.tmdbId && normalizeSearchToken(item.titulo) === normalizeSearchToken(esTitle)) {
            item.tmdbId = cleanId;
          }
          combined.push(item);
        }
      }

      cacheSet(cacheKey, combined, combined.length > 0 ? CACHE_TTL_SEARCH_MS : CACHE_TTL_NEGATIVE_MS);
      return combined;
    } catch {
      cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
      return [];
    }
  });
}

// ===========================================================================
// 2. EXTRACCIÓN DE DETALLE Y TORRENTS (API + FALLBACK HTML + DESCIFRADO AES)
// ===========================================================================

function orderedEndpointsForType(tipo) {
  const norm = normalizarTipo(tipo);
  if (norm === 'serie') return ['serie', 'anime', 'movie'];
  if (norm === 'anime') return ['anime', 'serie', 'movie'];
  return ['movie', 'anime', 'serie'];
}

function orderedHtmlPathsForType(tipo) {
  const norm = normalizarTipo(tipo);
  if (norm === 'serie') return ['serie', 'anime', 'pelicula'];
  if (norm === 'anime') return ['anime', 'serie', 'pelicula'];
  return ['pelicula', 'anime', 'serie'];
}

/**
 * Obtiene el JSON de detalle desde `/wp-json/wpreact/v1/{movie|serie|anime}/{slug}`.
 */
async function fetchWpreactDetail(slug, tipo) {
  const endpoints = orderedEndpointsForType(tipo);

  for (const ep of endpoints) {
    const url = `${BASE_URL}/wp-json/wpreact/v1/${ep}/${encodeURIComponent(slug)}`;
    try {
      const res = await httpGet(url);
      if (res.data && typeof res.data === 'object' && (res.data.slug || res.data.title || res.data.id)) {
        return res.data;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.warn(`[Scraper] Error detalle wpreact (${ep}/${slug}): ${err.message}`);
      }
    }
  }
  return null;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isAcortalinkUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  return /acortalink\.(?:net|me|com|org)|\/s\.php\?i=/i.test(urlStr);
}

/**
 * Recolecta todos los enlaces de descarga de cualquier estructura que devuelva la API.
 * Descifra al vuelo cualquier enlace `acortalink` sin llamadas de red.
 */
function collectDownloads(data, tipo) {
  if (!data || typeof data !== 'object') return [];
  const esContenidoEpisodico = tipo === 'serie' || tipo === 'series' || tipo === 'anime';
  const out = [];
  const seen = new Set();

  function addItem(raw, ctx = {}) {
    if (!raw) return;
    const link = typeof raw === 'string'
      ? raw
      : (raw.download_link || raw.link || raw.url || raw.magnet || raw.href || raw.file || '');
    if (!link || typeof link !== 'string') return;

    const urlStr = link.trim();
    const isShort = isAcortalinkUrl(urlStr);
    let magnet = isValidMagnet(urlStr) ? normalizarMagnet(urlStr) : null;

    if (!magnet && isShort) {
      magnet = tryDecodeAcortalinkParam(urlStr);
    }

    if (!magnet && !isShort && !/\.torrent(\?|$)/i.test(urlStr)) return;

    const obj = typeof raw === 'object' ? raw : {};
    const dn = magnet ? parseMagnetDn(magnet) : '';
    const labelText = [dn, obj.title, obj.name, obj.episode_title, obj.label, ctx.label]
      .filter(Boolean).join(' ');

    let temporada = toIntOrNull(
      obj.season ?? obj.temporada ?? obj.season_number ?? obj.s ?? ctx.season
    );
    let episodio = toIntOrNull(
      obj.episode ?? obj.episodio ?? obj.episode_number ?? obj.chapter ?? obj.capitulo ?? obj.ep ?? obj.e ?? ctx.episode
    );

    if (esContenidoEpisodico && (temporada === null || episodio === null)) {
      const parsed = extraerTemporadaEpisodio(labelText, temporada || 1);
      if (temporada === null && parsed.temporada !== null) temporada = parsed.temporada;
      if (episodio === null && parsed.episodio !== null) episodio = parsed.episodio;
    }

    if (tipo === 'pelicula' || tipo === 'movie') {
      temporada = null;
      episodio = null;
    }

    const calidad = normalizeCalidad(obj.quality || obj.calidad || obj.format || ctx.quality, dn);
    const dedupKey = `${magnet || urlStr}#${temporada ?? ''}:${episodio ?? ''}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    out.push({
      calidad,
      tamaño: normalizeTamaño(obj.size || obj.tamaño || obj.peso || ctx.size, magnet),
      idioma: normalizeIdioma(obj.language || obj.idioma || data.language || ctx.language || 'Latino'),
      subtitulos: normalizeSubs(obj.subs ?? obj.subtitles ?? obj.subtitulos ?? ctx.subs),
      fecha: normalizeText(obj.date || obj.fecha || ''),
      temporada,
      episodio,
      magnet: magnet || null,
      acortalink: magnet ? null : urlStr,
      dn: dn || normalizeText(obj.title || obj.name || '') || null
    });
  }

  function walk(node, ctx = {}) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx);
      return;
    }

    const nextCtx = {
      ...ctx,
      season: toIntOrNull(node.season ?? node.temporada ?? node.season_number ?? node.number) ?? ctx.season,
      episode: toIntOrNull(node.episode ?? node.episodio ?? node.episode_number ?? node.chapter ?? node.capitulo) ?? ctx.episode,
      quality: node.quality || node.calidad || ctx.quality,
      language: node.language || node.idioma || ctx.language,
      size: node.size || node.tamaño || ctx.size,
      subs: node.subs ?? ctx.subs,
      label: node.title || node.name || ctx.label
    };

    if (node.download_link || node.magnet ||
        ((node.link || node.url) && (isValidMagnet(node.link || node.url || '') || isAcortalinkUrl(node.link || node.url || '')))) {
      addItem(node, nextCtx);
    }

    for (const key of ['downloads', 'torrents', 'links', 'files', 'sources', ' mirrors']) {
      const k = key.trim();
      const val = node[k];
      if (Array.isArray(val)) {
        for (const d of val) addItem(d, nextCtx);
      } else if (val && typeof val === 'object') {
        for (const [subKey, subVal] of Object.entries(val)) {
          const qCtx = /\b(4k|2160p|1080p|720p|480p)\b/i.test(subKey)
            ? { ...nextCtx, quality: subKey }
            : nextCtx;
          if (typeof subVal === 'string') addItem(subVal, qCtx);
          else walk(subVal, qCtx);
        }
      }
    }

    for (const key of ['seasons', 'temporadas']) {
      const val = node[key];
      if (Array.isArray(val)) {
        val.forEach((sNode, idx) => {
          const sNum = toIntOrNull(sNode?.season ?? sNode?.temporada ?? sNode?.season_number ?? sNode?.number) ?? (idx + 1);
          walk(sNode, { ...nextCtx, season: sNum, episode: null });
        });
      } else if (val && typeof val === 'object') {
        for (const [sKey, sNode] of Object.entries(val)) {
          const m = sKey.match(/(\d+)/);
          const sNum = m ? parseInt(m[1], 10) : nextCtx.season;
          walk(sNode, { ...nextCtx, season: sNum, episode: null });
        }
      }
    }

    for (const key of ['episodes', 'episodios', 'chapters', 'capitulos']) {
      const val = node[key];
      if (Array.isArray(val)) {
        val.forEach((eNode, idx) => {
          const eNum = toIntOrNull(eNode?.episode ?? eNode?.episodio ?? eNode?.episode_number ?? eNode?.number ?? eNode?.chapter) ?? (idx + 1);
          walk(eNode, { ...nextCtx, episode: eNum });
        });
      } else if (val && typeof val === 'object') {
        for (const [eKey, eNode] of Object.entries(val)) {
          const m = eKey.match(/(\d+)/);
          const eNum = m ? parseInt(m[1], 10) : nextCtx.episode;
          walk(eNode, { ...nextCtx, episode: eNum });
        }
      }
    }
  }

  walk(data, {});
  return out;
}

/**
 * Extrae el texto de un elemento Cheerio insertando espacios entre nodos hijos
 * para evitar que `Temporada 1<span>10 Episodios</span>` se concatene como
 * `"Temporada 110 Episodios"`.
 */
function elementTextWithSpaces($, el) {
  const parts = [];
  $(el).contents().each((_, node) => {
    if (node.type === 'text') {
      if (node.data) parts.push(node.data);
    } else if (node.type === 'tag') {
      parts.push(' ', elementTextWithSpaces($, node), ' ');
    }
  });
  return normalizeText(parts.join(''));
}

/**
 * Extrae el número de temporada desde un encabezado de HackTorrent.
 * Maneja tanto encabezados normales ("Temporada 2", "Temporada 1 10 Episodios")
 * como encabezados pegados sin espacio ("Temporada 110 Episodios",
 * "Temporada 12 Episodios", "Temporada 18 Episodios") usando el número real
 * de filas de la tabla (`numFilasTabla`) cuando está disponible.
 */
function extraerTemporadaDeEncabezado(texto, numFilasTabla = 0) {
  const txt = normalizeText(texto);
  if (!txt) return null;

  // Caso 1: "Temporada 1 10 Episodios" (separado por espacio)
  let m = txt.match(/(?:temporada|season)\s*(\d{1,2})\s+\d+\s*episodios?/i);
  if (m) return parseInt(m[1], 10);

  // Caso 2: "Temporada 110 Episodios" o "Temporada 12 Episodios" (pegado sin espacio)
  m = txt.match(/(?:temporada|season)\s*(\d+)\s*episodios?/i);
  if (m) {
    const rawDigits = m[1];
    if (numFilasTabla > 0) {
      const epStr = String(numFilasTabla);
      if (rawDigits.length > epStr.length && rawDigits.endsWith(epStr)) {
        const prefix = parseInt(rawDigits.slice(0, -epStr.length), 10);
        if (Number.isFinite(prefix) && prefix > 0) return prefix;
      }
    }
    if (rawDigits.length >= 2) {
      const firstDigit = parseInt(rawDigits[0], 10);
      if (Number.isFinite(firstDigit) && firstDigit > 0) return firstDigit;
    }
    return parseInt(rawDigits, 10);
  }

  // Caso 3: "Temporada 1" / "Season 2" / "Temp 3"
  m = txt.match(/(?:temporada|season)\s*(\d{1,2})\b/i) ||
      txt.match(/^(?:temp|t)\s*(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);

  return null;
}

/**
 * Fallback HTML: descarga la página `/pelicula/{slug}/`, `/serie/{slug}/` o `/anime/{slug}/`
 * y extrae la tabla de torrents con Cheerio.
 */
async function scrapeHtmlDetail(slug, tipo, knownType = null) {
  const paths = knownType
    ? [tipoToHtmlPath(knownType)]
    : orderedHtmlPathsForType(tipo);

  for (const p of paths) {
    const url = `${BASE_URL}/${p}/${encodeURIComponent(slug)}/`;
    try {
      const res = await httpGet(url, { responseType: 'text' });
      const html = typeof res.data === 'string' ? res.data : '';
      if (!html || html.length < 200) continue;

      const parsed = parseHtmlDetail(html, { slug, tipo: normalizarTipo(p), url });
      if (parsed && parsed.torrents.length > 0) {
        return parsed;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.warn(`[Scraper] Error HTML detail (${p}/${slug}): ${err.message}`);
      }
    }
  }
  return null;
}

function parseHtmlDetail(html, { slug, tipo, url }) {
  const $ = cheerio.load(html);

  const rawTitle =
    normalizeText($('h1').first().text()) ||
    normalizeText($('meta[property="og:title"]').attr('content')) ||
    slug;

  const titulo = rawTitle
    .replace(/^descargar\s+/i, '')
    .replace(/\s+en\s+(latino|castellano|español|hd).*$/i, '')
    .replace(/\s*[-|]\s*ver y descargar.*$/i, '')
    .replace(/\s*[-|]\s*hacktorrent.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();

  const poster = normalizePosterUrl(
    $('meta[property="og:image"]').attr('content') ||
    $('.poster img, .movie-poster img, article img').first().attr('src'),
    false
  );

  const sinopsis = normalizeText(
    $('meta[property="og:description"]').attr('content') ||
    $('.overview, .synopsis, .description, .entry-content p').first().text()
  );

  // Extraer metadatos adicionales de la lista <li> (Género, Año, Duración, Director, Reparto)
  const generos = [];
  const actores = [];
  const director = [];
  let duracion = '';
  let añoMeta = null;

  $('li').each((_, li) => {
    const txt = normalizeText($(li).text());
    if (/^g[eé]nero\s*:/i.test(txt)) {
      $(li).find('a').each((__, a) => {
        const g = normalizeText($(a).text());
        if (g && !generos.includes(g)) generos.push(g);
      });
    } else if (/^a[nñ]o\s*:/i.test(txt)) {
      añoMeta = extractYear(txt);
    } else if (/^duraci[oó]n\s*:/i.test(txt)) {
      duracion = txt.replace(/^duraci[oó]n\s*:\s*/i, '').replace(/mm$/i, 'm').trim();
      if (duracion === 'm' || duracion === '0m') duracion = '';
    } else if (/^director\s*:/i.test(txt)) {
      $(li).find('a').each((__, a) => {
        const d = normalizeText($(a).text());
        if (d && !director.includes(d)) director.push(d);
      });
    } else if (/^reparto\s*:/i.test(txt)) {
      $(li).find('a').each((__, a) => {
        const act = normalizeText($(a).text());
        if (act && !/^ver m[aá]s$/i.test(act) && !actores.includes(act)) actores.push(act);
      });
    }
  });

  const año = añoMeta || extractYear(rawTitle) || extractYear($('body').text());

  const torrents = [];
  const esContenidoEpisodico = tipo === 'serie' || tipo === 'anime';
  let temporadaActual = null;

  // Recorremos encabezados de temporada y tablas en orden de documento
  $('h1, h2, h3, h4, h5, .season-title, .temporada, button, [data-season], table').each((_, el) => {
    const tag = (el.tagName || el.name || '').toLowerCase();
    const $el = $(el);

    if (tag !== 'table') {
      const dataSeason = $el.attr('data-season') || $el.attr('data-temporada');
      if (dataSeason && /^\d+$/.test(dataSeason)) {
        temporadaActual = parseInt(dataSeason, 10);
        return;
      }
      const txt = elementTextWithSpaces($, el);
      const parsedSeason = extraerTemporadaDeEncabezado(txt, 0);
      if (parsedSeason !== null) {
        temporadaActual = parsedSeason;
      }
      return;
    }

    const $rows = $el.find('tbody tr').length ? $el.find('tbody tr') : $el.find('tr');
    const numFilas = $rows.length;

    const headers = [];
    $el.find('thead th, tr:first-child th').each((i, th) => {
      headers.push(normalizeText($(th).text()).toLowerCase());
    });

    let temporadaTabla = temporadaActual;

    const prevHeadingEl = $el.prevAll('h1, h2, h3, h4, h5, div, p, span').first();
    if (prevHeadingEl.length) {
      const prevTxt = elementTextWithSpaces($, prevHeadingEl[0]);
      const mPrev = extraerTemporadaDeEncabezado(prevTxt, numFilas);
      if (mPrev !== null) temporadaTabla = mPrev;
    }

    const parentSeason = $el.closest('[data-season], [data-temporada], [id*="temporada" i], [id*="season" i]');
    if (parentSeason.length) {
      const ds = parentSeason.attr('data-season') || parentSeason.attr('data-temporada') || parentSeason.attr('id') || '';
      const mDs = ds.match(/(?:temporada|season)[-_]?(\d{1,2})|^(\d{1,2})$/i);
      if (mDs) temporadaTabla = parseInt(mDs[1] || mDs[2], 10);
    }

    $rows.each((__, tr) => {
      const $tds = $(tr).find('td');
      if ($tds.length < 2) return;

      let acortalink = null;
      let magnetDirecto = null;
      let playerSeason = null;
      let playerEpisode = null;

      $(tr).find('a[href]').each((___, a) => {
        const href = ($(a).attr('href') || '').trim();
        if (isValidMagnet(href) && !magnetDirecto) {
          magnetDirecto = normalizarMagnet(href);
        } else if (isAcortalinkUrl(href) && !acortalink) {
          acortalink = href;
        }
        // Enlace [Ver](https://hacktorrent.cc/serie/{slug}/player/{season}/{episode})
        const mPlayer = href.match(/\/player\/(\d{1,2})\/(\d{1,3})(?:\/|$|\?|#)/i);
        if (mPlayer) {
          playerSeason = parseInt(mPlayer[1], 10);
          playerEpisode = parseInt(mPlayer[2], 10);
        }
      });

      // Descifrar acortalink offline inmediatamente (< 0.1 ms)
      if (!magnetDirecto && acortalink) {
        magnetDirecto = tryDecodeAcortalinkParam(acortalink);
      }

      if (!magnetDirecto && !acortalink) return;

      const cells = $tds.map((i, td) => normalizeText($(td).text())).get();
      const esTablaSerie = headers[0] === '#' || /^\d{1,3}$/.test(cells[0]);

      let temporada = esContenidoEpisodico ? temporadaTabla : null;
      let episodio = null;
      let calidad = 'HD';
      let tamaño = 'Desconocido';
      let subtitulos = null;
      let idioma = 'Latino';
      let fecha = '';

      if (esContenidoEpisodico && esTablaSerie && cells.length >= 5) {
        // Serie/Anime: # | Formato | Tamaño | Subtítulos | Idioma | Fecha | Acciones
        episodio = parseInt(cells[0], 10) || null;
        calidad = normalizeCalidad(cells[1]);
        tamaño = normalizeTamaño(cells[2], magnetDirecto);
        subtitulos = normalizeSubs(cells[3]);
        idioma = normalizeIdioma(cells[4]);
        fecha = cells[5] || '';
      } else {
        // Película: Formato | Idioma | Fecha | Tamaño | Subtítulos | Descargar
        calidad = normalizeCalidad(cells[0]);
        idioma = normalizeIdioma(cells[1]);
        fecha = cells[2] || '';
        tamaño = normalizeTamaño(cells[3], magnetDirecto);
        subtitulos = normalizeSubs(cells[4]);
      }

      const dn = magnetDirecto ? parseMagnetDn(magnetDirecto) : '';

      if (esContenidoEpisodico) {
        // Prioridad 1: enlace /player/{season}/{episode} de la misma fila
        if (playerSeason !== null) temporada = playerSeason;
        if (playerEpisode !== null && episodio === null) episodio = playerEpisode;

        // Prioridad 2: SxxExx explícito en el nombre del archivo (dn) del magnet
        if (magnetDirecto) {
          const se = extraerTemporadaEpisodio(dn || magnetDirecto, temporada || 1);
          if (temporada === null && se.temporada !== null) temporada = se.temporada;
          if (episodio === null && se.episodio !== null) episodio = se.episodio;
        }

        if (temporada === null) temporada = 1;
      } else {
        temporada = null;
        episodio = null;
      }

      torrents.push({
        calidad: normalizeCalidad(calidad, dn),
        tamaño: normalizeTamaño(tamaño, magnetDirecto),
        idioma,
        subtitulos,
        fecha,
        temporada,
        episodio,
        magnet: magnetDirecto,
        acortalink: magnetDirecto ? null : acortalink,
        dn: dn || null
      });
    });
  });

  return {
    id: slug,
    slug,
    titulo,
    tituloOriginal: '',
    tipo,
    año,
    duracion,
    imdbRating: null,
    tmdbId: null,
    idioma: torrents[0]?.idioma || 'Latino',
    generos,
    actores,
    director,
    sinopsis,
    poster,
    background: null,
    url,
    torrents,
    relacionados: []
  };
}

// ===========================================================================
// 3. RESOLUCIÓN DE ACORTALINK (DESCIFRADO AES OFFLINE + FALLBACK HTTP)
// ===========================================================================

/**
 * Intenta descifrar o decodificar localmente el parámetro `i=` de `acortalink.net/s.php?i=...`
 * sin realizar peticiones de red:
 *   1. Descifrado AES-256-CBC OpenSSL (`Salted__` + clave `fee631d2cffda38a78b96ee6d2dfb43a`).
 *   2. Decodificación Base64 simple o doble si contiene un `magnet:` en texto plano.
 */
function tryDecodeAcortalinkParam(acortalinkUrl) {
  // 1. Descifrado AES-256-CBC (formato real de acortalink.net / acortalink.me)
  const decrypted = decryptAcortalink(acortalinkUrl);
  if (decrypted) return decrypted;

  // 2. Fallback: Base64 directo (1 o 2 pasadas)
  try {
    const u = new URL(acortalinkUrl);
    const iParam = u.searchParams.get('i') || u.searchParams.get('url') || u.searchParams.get('u');
    if (!iParam) return null;

    const step1 = Buffer.from(iParam, 'base64').toString('utf8').trim();
    if (isValidMagnet(step1)) return normalizarMagnet(step1);

    if (/^[A-Za-z0-9+/=_-]{20,}$/.test(step1)) {
      const step2 = Buffer.from(step1, 'base64').toString('utf8').trim();
      if (isValidMagnet(step2)) return normalizarMagnet(step2);
    }
  } catch {
    // ignorar
  }
  return null;
}

/**
 * Resuelve un enlace de `acortalink.net` hacia su `magnet:?xt=urn:btih:...` final.
 */
async function resolverAcortalink(acortalinkUrl) {
  if (!acortalinkUrl) return null;
  if (isValidMagnet(acortalinkUrl)) return normalizarMagnet(acortalinkUrl);

  const cached = cacheGet(`short:${acortalinkUrl}`);
  if (cached !== undefined) return cached;

  // Paso 1: Descifrado / decodificación local instantánea (0 ms, sin red)
  const localDecoded = tryDecodeAcortalinkParam(acortalinkUrl);
  if (localDecoded) {
    cacheSet(`short:${acortalinkUrl}`, localDecoded, CACHE_TTL_SHORTLINK_MS);
    return localDecoded;
  }

  return runDedup(`short:${acortalinkUrl}`, async () => {
    try {
      const res = await axios.get(acortalinkUrl, {
        timeout: timeout(8000),
        maxRedirects: 0,
        headers: { ...DEFAULT_HEADERS, Referer: `${BASE_URL}/` },
        validateStatus: s => s >= 200 && s < 400
      });

      const location = res.headers?.location || '';
      if (isValidMagnet(location)) {
        const norm = normalizarMagnet(location);
        cacheSet(`short:${acortalinkUrl}`, norm, CACHE_TTL_SHORTLINK_MS);
        return norm;
      }

      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
      const magnetMatch = body.match(/magnet:\?[^\s"'<>]+/i);
      if (magnetMatch && isValidMagnet(magnetMatch[0])) {
        const cleanMagnet = normalizarMagnet(magnetMatch[0].replace(/&amp;/g, '&'));
        cacheSet(`short:${acortalinkUrl}`, cleanMagnet, CACHE_TTL_SHORTLINK_MS);
        return cleanMagnet;
      }

      // Buscar payloads cifrados U2FsdGVkX1 o VTJGc2RHVmtY dentro del HTML del acortador
      const encMatch = body.match(/\b(VTJGc2RHVmtY[A-Za-z0-9+/=]{20,}|U2FsdGVkX1[A-Za-z0-9+/=]{20,})\b/);
      if (encMatch) {
        const dec = decryptAcortalink(encMatch[1]);
        if (dec) {
          cacheSet(`short:${acortalinkUrl}`, dec, CACHE_TTL_SHORTLINK_MS);
          return dec;
        }
      }

      console.warn(`[Scraper] resolverAcortalink no encontró magnet en ${acortalinkUrl}`);
      cacheSet(`short:${acortalinkUrl}`, null, CACHE_TTL_NEGATIVE_MS);
      return null;
    } catch (err) {
      const loc = err.response?.headers?.location || '';
      if (isValidMagnet(loc)) {
        const norm = normalizarMagnet(loc);
        cacheSet(`short:${acortalinkUrl}`, norm, CACHE_TTL_SHORTLINK_MS);
        return norm;
      }
      console.warn(`[Scraper] ❌ Error resolviendo acortalink: ${err.message}`);
      cacheSet(`short:${acortalinkUrl}`, null, CACHE_TTL_NEGATIVE_MS);
      return null;
    }
  });
}

// ===========================================================================
// 4. FUNCIÓN PRINCIPAL DE EXTRACCIÓN DE DETALLE + TORRENTS
// ===========================================================================

function normalizarSlugYTipo(slugOrUrl, tipoHint = 'pelicula') {
  const s = String(slugOrUrl || '').trim();
  if (!s) return { slug: '', tipo: normalizarTipo(tipoHint) };

  if (/^https?:\/\//i.test(s) || s.includes('/')) {
    const m = s.match(/\/(peliculas?|movies?|series?|animes?)\/([^/?#]+)/i);
    if (m) {
      return { tipo: normalizarTipo(m[1]), slug: decodeURIComponent(m[2]) };
    }
    const parts = s.replace(/\/+$/, '').split('/').filter(Boolean);
    return { slug: decodeURIComponent(parts[parts.length - 1] || ''), tipo: normalizarTipo(tipoHint) };
  }

  return { slug: s.replace(/^\/+|\/+$/g, ''), tipo: normalizarTipo(tipoHint) };
}

/**
 * Combina los metadatos enriquecidos de la API `wpreact` con el detalle extraído por HTML.
 * En HackTorrent, `/wp-json/wpreact/v1/serie/{slug}` devuelve todos los metadatos
 * (título original, TMDB ID, backdrop HD, IMDb, reparto, sinopsis), mientras que
 * la tabla de episodios está en el HTML `/serie/{slug}/`.
 */
function mergeMetadataWithHtmlDetail(apiMeta, htmlDetail) {
  if (!apiMeta) return htmlDetail;
  if (!htmlDetail) return null;

  return {
    ...htmlDetail,
    id: apiMeta.id || htmlDetail.id,
    slug: apiMeta.slug || htmlDetail.slug,
    titulo: apiMeta.titulo || htmlDetail.titulo,
    tituloOriginal: apiMeta.tituloOriginal || htmlDetail.tituloOriginal || '',
    tipo: apiMeta.tipo || htmlDetail.tipo,
    año: apiMeta.año || htmlDetail.año,
    duracion: apiMeta.duracion || htmlDetail.duracion || '',
    imdbRating: apiMeta.imdbRating || htmlDetail.imdbRating || null,
    tmdbId: apiMeta.tmdbId || htmlDetail.tmdbId || null,
    idioma: htmlDetail.torrents?.[0]?.idioma || apiMeta.idioma || htmlDetail.idioma || 'Latino',
    generos: apiMeta.generos?.length ? apiMeta.generos : (htmlDetail.generos || []),
    actores: apiMeta.actores?.length ? apiMeta.actores : (htmlDetail.actores || []),
    director: apiMeta.director?.length ? apiMeta.director : (htmlDetail.director || []),
    sinopsis: apiMeta.sinopsis || htmlDetail.sinopsis || '',
    poster: apiMeta.poster || htmlDetail.poster || null,
    background: apiMeta.background || htmlDetail.background || null,
    url: htmlDetail.url || apiMeta.url
  };
}

/**
 * Extrae metadatos completos y lista de torrents de una película, serie o anime.
 */
async function extraerDetalleTorrent(slugOrUrl, tipoHint = 'pelicula') {
  const norm = normalizarSlugYTipo(slugOrUrl, tipoHint);
  if (!norm.slug) return null;

  const cacheKey = `detail:${norm.tipo}:${norm.slug}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return runDedup(cacheKey, async () => {
    console.log(`[Scraper] 📄 Extrayendo detalle: slug="${norm.slug}" tipo="${norm.tipo}"`);

    let apiMeta = null;
    let apiRelacionados = [];

    // 1. Intentar API primaria wpreact
    const data = await fetchWpreactDetail(norm.slug, norm.tipo);
    if (data) {
      const tipoReal = normalizarTipo(data.type || norm.tipo);
      apiMeta = mapRawItemToResult(data, tipoReal);
      apiRelacionados = Array.isArray(data.related)
        ? data.related.map(r => mapRawItemToResult(r, tipoReal)).filter(Boolean)
        : [];

      const torrents = collectDownloads(data, tipoReal);
      if (torrents.length > 0) {
        const detalle = {
          ...(apiMeta || {}),
          id: data.id || norm.slug,
          slug: data.slug || norm.slug,
          titulo: normalizeText(data.title || norm.slug),
          tituloOriginal: normalizeText(data.original_title || ''),
          tipo: tipoReal,
          url: `${BASE_URL}/${tipoToHtmlPath(tipoReal)}/${norm.slug}/`,
          torrents,
          relacionados: apiRelacionados
        };
        cacheSet(cacheKey, detalle, CACHE_TTL_DETAIL_MS);
        return detalle;
      }
      console.log(`[Scraper] wpreact detail sin torrents para ${norm.slug}, obteniendo tabla HTML...`);
    }

    // 2. Scraping HTML de la página de detalle (usado por todas las series en hacktorrent.cc)
    const htmlDetail = await scrapeHtmlDetail(norm.slug, norm.tipo, apiMeta?.tipo || null);
    if (htmlDetail && htmlDetail.torrents && htmlDetail.torrents.length > 0) {
      const merged = mergeMetadataWithHtmlDetail(apiMeta, htmlDetail);
      if (apiRelacionados.length > 0 && (!merged.relacionados || merged.relacionados.length === 0)) {
        merged.relacionados = apiRelacionados;
      }
      cacheSet(cacheKey, merged, CACHE_TTL_DETAIL_MS);
      return merged;
    }

    // 3. Si el entorno bloquea la red, usar datos mock de respaldo si coinciden
    if (MOCK_ENABLED) {
      const mock = MOCK_ITEMS.find(m => m.slug === norm.slug);
      if (mock) {
        console.log(`[Scraper] ⚠️ Usando mock de respaldo para "${norm.slug}"`);
        return { ...mock, url: `${BASE_URL}/${tipoToHtmlPath(mock.tipo)}/${mock.slug}/`, relacionados: [] };
      }
    }

    // Si al menos teníamos metadatos de wpreact aunque sin torrents, devolverlos
    if (apiMeta) {
      const fallbackDetalle = {
        ...apiMeta,
        torrents: [],
        relacionados: apiRelacionados
      };
      cacheSet(cacheKey, fallbackDetalle, CACHE_TTL_NEGATIVE_MS);
      return fallbackDetalle;
    }

    cacheSet(cacheKey, null, CACHE_TTL_NEGATIVE_MS);
    return null;
  });
}

/**
 * Resuelve en paralelo los magnets de una lista de torrents (por si alguno aún tiene acortalink).
 */
async function resolverMagnetsEnLote(torrents) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  return Promise.all(
    torrents.map(async t => {
      if (t.magnet && isValidMagnet(t.magnet)) {
        const norm = normalizarMagnet(t.magnet);
        const dn = t.dn || parseMagnetDn(norm) || null;
        return { ...t, magnet: norm, dn };
      }
      if (t.acortalink) {
        const magnet = await resolverAcortalink(t.acortalink);
        const dn = magnet ? (t.dn || parseMagnetDn(magnet) || null) : t.dn;
        return { ...t, magnet: magnet || null, dn };
      }
      return t;
    })
  );
}

// ===========================================================================
// 5. CATÁLOGOS PAGINADOS (PELÍCULAS, SERIES, ANIMES, ESTRENOS Y CATEGORÍAS)
// ===========================================================================

/**
 * Obtiene una página del catálogo de HackTorrent.
 *
 * @param {'peliculas'|'series'|'animes'|'estrenos'} tipo
 * @param {number} page Número de página (1-based)
 * @param {string|null} [genero] Género opcional (ej. "Terror", "Acción")
 */
async function obtenerCatalogo(tipo = 'peliculas', page = 1, genero = null) {
  const tLow = String(tipo || 'peliculas').toLowerCase();
  const esSeries = tLow === 'series' || tLow === 'serie';
  const esAnimes = tLow === 'animes' || tLow === 'anime';
  const esEstrenos = tLow === 'estrenos' || tLow === 'released';
  const generoClean = normalizeText(genero);

  const cacheKey = `cat:${tLow}:${generoClean.toLowerCase() || 'all'}:p${page}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return runDedup(cacheKey, async () => {
    const tipoFallback = esAnimes ? 'anime' : esSeries ? 'serie' : 'pelicula';

    // Si el usuario filtró por género en Stremio, usar `/wp-json/wpreact/v1/category`
    if (generoClean) {
      const catUrl = `${BASE_URL}/wp-json/wpreact/v1/category?category=${encodeURIComponent(generoClean)}&page=${page}`;
      try {
        const res = await httpGet(catUrl);
        const rawList = extractArrayFromPayload(res.data, ['results', 'movies', 'series', 'animes']);
        if (rawList.length > 0) {
          const mapped = rawList
            .map(item => mapRawItemToResult(item, tipoFallback))
            .filter(Boolean)
            .filter(item => {
              if (esAnimes) return item.tipo === 'anime';
              if (esSeries) return item.tipo === 'serie' || item.tipo === 'anime';
              return item.tipo === 'pelicula' || item.tipo === 'movie';
            });
          cacheSet(cacheKey, mapped, CACHE_TTL_CATALOG_MS);
          return mapped;
        }
      } catch (err) {
        console.warn(`[Scraper] Error catálogo categoría (${generoClean} p${page}): ${err.message}`);
      }
    }

    // Nivel 1: wpreact/v1/{movies|series|animes|released}
    const endpoint = esAnimes
      ? 'animes'
      : esSeries
        ? 'series'
        : esEstrenos
          ? 'released'
          : 'movies';
    const url1 = `${BASE_URL}/wp-json/wpreact/v1/${endpoint}?page=${page}`;
    try {
      const res = await httpGet(url1);
      const rawList = extractArrayFromPayload(res.data, ['movies', 'series', 'animes', 'results']);
      if (rawList.length > 0) {
        const mapped = rawList
          .map(item => mapRawItemToResult(item, tipoFallback))
          .filter(Boolean);
        cacheSet(cacheKey, mapped, CACHE_TTL_CATALOG_MS);
        return mapped;
      }
    } catch (err) {
      console.warn(`[Scraper] Error catálogo wpreact (${endpoint} p${page}): ${err.message}`);
    }

    // Nivel 2: react/v1/archive
    const postType = esAnimes ? 'animes' : esSeries ? 'series' : 'peliculas';
    const url2 = `${BASE_URL}/wp-json/react/v1/archive?post_type=${postType}&paged=${page}`;
    try {
      const res = await httpGet(url2);
      const rawList = extractArrayFromPayload(res.data, ['results', 'posts', 'items']);
      if (rawList.length > 0) {
        const mapped = rawList
          .map(item => mapRawItemToResult(item, tipoFallback))
          .filter(Boolean);
        cacheSet(cacheKey, mapped, CACHE_TTL_CATALOG_MS);
        return mapped;
      }
    } catch (err) {
      console.warn(`[Scraper] Error catálogo react (${postType} p${page}): ${err.message}`);
    }

    // Nivel 3: Mock de respaldo
    if (MOCK_ENABLED && page === 1 && !generoClean) {
      return MOCK_ITEMS.filter(m =>
        esAnimes ? m.tipo === 'anime' : esSeries ? m.tipo === 'serie' : m.tipo === 'pelicula'
      ).map(m => ({
        ...m,
        url: `${BASE_URL}/${tipoToHtmlPath(m.tipo)}/${m.slug}/`
      }));
    }

    return [];
  });
}

module.exports = {
  BASE_URL,
  buscarEnHackTorrent,
  buscarPorTmdb,
  extraerDetalleTorrent,
  resolverAcortalink,
  resolverMagnetsEnLote,
  obtenerCatalogo,
  extraerTemporadaEpisodio,
  decryptAcortalink,
  normalizarMagnet,
  base32ToHex,
  decodeReactGuid,
  // Internals expuestos para tests unitarios (sin red)
  _parseHtmlDetail: parseHtmlDetail,
  _collectDownloads: collectDownloads,
  _extraerTemporadaDeEncabezado: extraerTemporadaDeEncabezado,
  _internals: {
    parseHtmlDetail,
    collectDownloads,
    extraerTemporadaDeEncabezado,
    isValidMagnet,
    formatSizeFromMagnet: (magnet) => normalizeTamaño('', magnet),
    normalizeTamaño,
    decryptAcortalink,
    normalizarMagnet,
    base32ToHex,
    decodeReactGuid
  },
  _cacheGet: cacheGet,
  _cacheSet: cacheSet,
  _cacheSize: () => memoryCache.size,
  _cacheLimit: CACHE_MAX_ENTRIES,
  _limpiarCache: () => {
    memoryCache.clear();
    inFlight.clear();
  }
};
