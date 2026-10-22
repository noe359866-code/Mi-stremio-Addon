/**
 * Scraper especializado para PelisPanda (https://pelispanda.org)
 * ---------------------------------------------------------------------------
 * Basado en la investigación real de https://pelispanda.org/:
 *   1. API REST principal: `/wp-json/wpreact/v1`
 *      - Búsqueda: `/wp-json/wpreact/v1/search?query={q}` → `{ results, total, pages }`
 *      - Catálogos (12 ítems/página):
 *        `/wp-json/wpreact/v1/movies?page={n}`
 *        `/wp-json/wpreact/v1/series?page={n}`
 *        `/wp-json/wpreact/v1/animes?page={n}`
 *        `/wp-json/wpreact/v1/released?page={n}` (estrenos)
 *        `/wp-json/wpreact/v1/category?category={genero}&page={n}`
 *      - Detalle Película: `/wp-json/wpreact/v1/movie/{slug}` → incluye `downloads[]` con `magnet:` directo
 *      - Detalle Anime:    `/wp-json/wpreact/v1/anime/{slug}` → incluye `downloads[]` con `season`, `episode` y `magnet:`
 *      - Detalle Serie:    `/wp-json/wpreact/v1/serie/{slug}` → devuelve metadatos (`tmdb_id`, `year`, `imdb`, `genres`),
 *                          PERO nunca incluye `downloads` (los torrents están en la tabla HTML de `/serie/{slug}/`).
 *   2. API REST secundaria: `/wp-json/react/v1/search?q={q}`
 *      - En PelisPanda sí está activa y devuelve `{ error: false, data: [...] }` con `_guid` = `rot13(base64(tmdb_id))`.
 *   3. Resolución de título en español por TMDB ID: `https://pelispanda.org/?tmdb={id}`
 *      - Devuelve `<a href="...">Título en Español</a>` (< 500 bytes), permitiendo encontrar títulos que Cinemeta
 *        entrega en inglés (ej. "The Wolf of Wall Street" → "El Lobo de Wall Street").
 *   4. Scraping HTML con Cheerio:
 *      - En `/serie/{slug}/`, `/pelicula/{slug}/`, `/peliculas/{slug}/`, `/anime/{slug}/` y `/{slug}/`
 *      - Los botones `Descargar` en las tablas HTML de PelisPanda contienen enlaces `magnet:?xt=urn:btih:...` directos
 *        (y soporte offline AES-256-CBC para enlaces `acortalink` si algún post antiguo los utiliza).
 *      - Desambigua encabezados concatenados (`Temporada 19 Episodios` → T1, `Temporada 110 Episodios` → T1,
 *        `Temporada 28 Episodios` → T2, `Temporada 38 Episodios` → T3) apoyándose en el conteo de filas,
 *        el enlace `/player/{s}/{e}` de cada fila y el `dn=` del magnet (`1x01`, `S02E01`).
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { timeout } = require('./timeouts');
const {
  decryptAcortalink,
  normalizarMagnet,
  base32ToHex,
  decodeReactGuid,
  extraerTemporadaEpisodio,
  _extraerTemporadaDeEncabezado: extraerTemporadaDeEncabezado
} = require('./scraper');
const {
  pickBestMatch,
  rankCandidates,
  similarity,
  torrentSeasonEpisode,
  normalizeTitle
} = require('./match');

const BASE_URL = (process.env.PELISPANDA_BASE_URL || 'https://pelispanda.org').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = 9000;

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/html, application/xhtml+xml, */*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Referer: `${BASE_URL}/`
};

// ---------------------------------------------------------------------------
// CACHÉ EN MEMORIA (LRU + TTL + deduplicación de peticiones en vuelo)
// ---------------------------------------------------------------------------
const CACHE_MAX_ENTRIES = 600;
const CACHE_TTL_SEARCH_MS = 15 * 60 * 1000;
const CACHE_TTL_DETAIL_MS = 30 * 60 * 1000;
const CACHE_TTL_CATALOG_MS = 10 * 60 * 1000;
const CACHE_TTL_NEGATIVE_MS = 3 * 60 * 1000;

const memoryCache = new Map();
const inFlight = new Map();

function cacheGet(key) {
  if (!memoryCache.has(key)) return undefined;
  const entry = memoryCache.get(key);
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value, ttlMs = CACHE_TTL_SEARCH_MS) {
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  } else if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    let purged = false;
    for (const [k, v] of memoryCache.entries()) {
      if (now > v.expiresAt) {
        memoryCache.delete(k);
        purged = true;
        break;
      }
    }
    if (!purged) {
      const oldestKey = memoryCache.keys().next().value;
      if (oldestKey !== undefined) memoryCache.delete(oldestKey);
    }
  }
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1000, ttlMs)
  });
  return value;
}

function withInFlight(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// UTILIDADES DE NORMALIZACIÓN ESPECÍFICAS DE PELISPANDA
// ---------------------------------------------------------------------------

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidMagnet(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (!/^magnet:\?/i.test(s)) return false;
  return /xt=urn:(?:btih:[a-zA-Z0-9]{32,40}|btmh:[a-zA-Z0-9]+)/i.test(s);
}

function isAcortalinkUrl(str) {
  if (typeof str !== 'string') return false;
  return /acortalink\.(?:net|me)\/(?:s\.php\?i=|[^\s"'<>]+)/i.test(str);
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

/**
 * Extrae `{ tipo, slug }` desde enlaces de PelisPanda.
 * Ignora enlaces rotos `/undefined/{slug}` presentes en la sección "También te puede interesar" de PelisPanda.
 */
function slugAndTypeFromPath(urlOrPath) {
  const s = String(urlOrPath || '');
  if (!s || /\/undefined\//i.test(s)) {
    return { tipo: null, slug: '' };
  }
  const m = s.match(/\/(peliculas?|movies?|series?|animes?)\/([^/?#]+)/i);
  if (m) {
    return { tipo: normalizarTipo(m[1]), slug: decodeURIComponent(m[2]) };
  }
  const clean = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
  if (clean && !clean.includes('/') && !/^(ayuda|category|director|actors|page|wp-json|wp-admin|wp-content)$/i.test(clean)) {
    return { tipo: null, slug: decodeURIComponent(clean) };
  }
  return { tipo: null, slug: '' };
}

/**
 * Normaliza URLs de imágenes TMDB en PelisPanda.
 * Filtra el bug de PelisPanda donde `background_image` viene como
 * `"https://image.tmdb.org/t/p/original/"` (sin nombre de archivo).
 */
function normalizePosterUrl(rawUrl, isBackground = false) {
  const s = normalizeText(rawUrl);
  if (!s) return null;

  // Descartar URLs TMDB truncadas sin archivo al final (ej. ".../t/p/original/" o ".../t/p/w300/")
  if (/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\/?$/i.test(s)) {
    return null;
  }

  if (s.startsWith('http://') || s.startsWith('https://')) {
    return s.replace(/(image\.tmdb\.org\/t\/p\/[^/]+)\/+/i, '$1/');
  }
  if (s.startsWith('//')) {
    return `https:${s}`;
  }
  if (s.startsWith('/')) {
    const cleanPath = s.replace(/^\/+/, '/');
    if (cleanPath.length <= 1 || !/\.(jpg|jpeg|png|webp|gif)$/i.test(cleanPath)) {
      return null;
    }
    const size = isBackground ? 'original' : 'w300';
    return `https://image.tmdb.org/t/p/${size}${cleanPath}`;
  }
  return s;
}

/**
 * Normaliza `duracion` corrigiendo el bug de PelisPanda donde el HTML muestra `"107mm"`, `"25mm"` o `"m"`,
 * y la API devuelve `"0m"` cuando no hay dato.
 */
function normalizeDuracion(raw) {
  const s = normalizeText(raw);
  if (!s) return '';
  const m = s.match(/(\d+)\s*m(?:m|in)?\b/i) || s.match(/^(\d+)$/);
  if (!m) return '';
  const mins = parseInt(m[1], 10);
  if (!Number.isFinite(mins) || mins <= 0) return '';
  return `${mins}m`;
}

/**
 * Normaliza `imdbRating` descartando `"0"` o `"0.0"` que PelisPanda devuelve cuando no hay nota.
 */
function normalizeImdb(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return null;
  return s;
}

/**
 * Normaliza fechas `YYYYMMDD` (ej. `"20261017"` en la API de PelisPanda) a `"17/10/2026"`.
 */
function normalizeFecha(raw) {
  const s = normalizeText(raw);
  if (!s) return '';
  const m = s.match(/^((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
  if (m) {
    return `${m[3]}/${m[2]}/${m[1]}`;
  }
  return s;
}

function normalizeCalidad(raw, fallbackText = '') {
  const s = normalizeText(raw);
  if (s) {
    const low = s.toLowerCase();
    if (low.includes('2160') || low.includes('4k') || low.includes('uhd')) return s;
    if (low.includes('1080')) return s;
    if (low.includes('720')) return s;
    if (low.includes('480')) return s;
    if (low.includes('cam') || low.includes('ts') || low.includes('hdrip') || low.includes('dvdrip') || low.includes('bluray') || low.includes('web')) {
      return s;
    }
  }
  const fb = normalizeText(fallbackText).toLowerCase();
  if (fb.includes('2160p') || fb.includes('4k') || fb.includes('uhd')) return '4K';
  if (fb.includes('1080p')) return 'WEB-DL 1080p';
  if (fb.includes('720p')) return '720p';
  if (fb.includes('480p')) return '480p';
  if (fb.includes('dvdrip')) return 'DVDRip';
  if (fb.includes('camrip') || fb.includes('hdcam')) return 'CAMRip';
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

/**
 * Normaliza etiquetas de idioma de PelisPanda:
 * - `"Latino - Inglés"`, `"Latino/Inglés"`, `"Dual"` → `"Latino/Inglés"`
 * - `"Latino/Japones"`, `"Latino - Japonés"` → `"Latino/Japonés"`
 * - `"Latino"` → `"Latino"`
 * - `"Castellano"` → `"Castellano"`
 * - `"Ingles"`, `"Inglés"` → `"Inglés"`
 */
function normalizeIdioma(raw) {
  const s = normalizeText(raw).toLowerCase().replace(/_/g, ' ');
  if (!s) return 'Latino';
  const hasEsp = s.includes('latino') || s.includes('español') || s.includes('espanol') || s.includes('castellano');
  const hasIng = s.includes('ingl') || s.includes('english');
  const hasJap = s.includes('japon') || s.includes('jap');
  if (hasEsp && hasIng) return 'Latino/Inglés';
  if (hasEsp && hasJap) return 'Latino/Japonés';
  if (hasEsp && (s.includes('dual') || s.includes('/') || s.includes('-'))) return 'Latino/Inglés';
  if (s.includes('dual')) return 'Latino/Inglés';
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

function extractYear(rawYear, rawYears) {
  for (const candidate of [rawYear, rawYears]) {
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
    const m = text.match(/\b(19\d{2}|20\d{2})\b/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function splitList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        if (typeof item === 'string') return normalizeText(item);
        if (item && typeof item === 'object') return normalizeText(item.name || item.title || item.slug || '');
        return '';
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && Array.isArray(raw.items)) {
    return splitList(raw.items);
  }
  return String(raw)
    .split(',')
    .map(s => normalizeText(s))
    .filter(Boolean);
}

/**
 * Extrae el arreglo de resultados desde distintos envoltorios de `wpreact/v1` y `react/v1`
 * (incluyendo `payload.data` que usa `/wp-json/react/v1/search?q=` en PelisPanda).
 */
function extractArrayFromPayload(payload, preferredKeys = ['results', 'data', 'movies', 'series', 'animes', 'slider', 'posts', 'items']) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      for (const subKey of ['items', 'results', 'posts', 'data']) {
        if (Array.isArray(payload[key][subKey])) return payload[key][subKey];
      }
    }
  }
  return [];
}

function mapRawItemToResult(item, defaultType = null) {
  if (!item || typeof item !== 'object') return null;

  const nested = item.post || item.data || item.item || null;
  const src = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...item, ...nested } : item;

  const linkInfo = slugAndTypeFromPath(src.link || src.url || src.permalink || '');
  const rawSlug = src.slug || src.post_name || linkInfo.slug || '';
  const slug = normalizeText(rawSlug).replace(/^\/+|\/+$/g, '');
  if (!slug || slug === 'undefined') return null;

  const rawType = src.type || src.post_type || src.tipo || linkInfo.tipo || defaultType || 'pelicula';
  const tipo = normalizarTipo(rawType);

  const titulo = normalizeText(src.title?.rendered || src.title || src.post_title || src.name || slug.replace(/-/g, ' '));
  if (!titulo) return null;

  const tituloOriginal = normalizeText(src.original_title || src.originalTitle || '');
  const año = extractYear(src.year, src.years || src.release_date || src.date);
  const tmdbId = src.tmdb_id
    ? String(src.tmdb_id).trim()
    : src.tmdbId
      ? String(src.tmdbId).trim()
      : decodeReactGuid(src._guid);

  const poster = normalizePosterUrl(
    src.featured || src.image || src.poster || src.poster_path || src.thumbnail,
    false
  );
  const background = normalizePosterUrl(
    src.background_image || src.backdrop || src.backdrop_path || src.background,
    true
  ) || poster;

  const relacionados = Array.isArray(src.related)
    ? src.related.map(r => mapRawItemToResult(r, tipo)).filter(Boolean)
    : undefined;

  const result = {
    id: src.id || src._id || slug,
    slug,
    titulo,
    tituloOriginal,
    tipo,
    año,
    duracion: normalizeDuracion(src.duracion || src.runtime || '') || null,
    imdbRating: normalizeImdb(src.imdb ?? src.imdbRating ?? src.rating ?? null),
    tmdbId: tmdbId || null,
    idioma: normalizeIdioma(src.language || src.idioma || 'Latino'),
    generos: splitList(src.genres || src.generos),
    actores: splitList(src.actors || src.reparto),
    director: splitList(src.director),
    sinopsis: normalizeText(src.overview || src.sinopsis || src.excerpt?.rendered || src.content?.rendered || ''),
    poster,
    background,
    fuente: 'pelispanda',
    url: `${BASE_URL}/${tipoToHtmlPath(tipo)}/${slug}/`
  };
  if (relacionados) result.relacionados = relacionados;
  return result;
}

function matchesSearchQuery(item, query) {
  const qNorm = normalizeTitle(query);
  if (!qNorm) return true;
  const qTokens = qNorm.split(' ').filter(t => t.length >= 2);
  if (qTokens.length === 0) return true;

  const fields = [
    normalizeTitle(item.titulo || item.title || ''),
    normalizeTitle(item.tituloOriginal || item.original_title || ''),
    normalizeTitle(String(item.slug || '').replace(/-/g, ' '))
  ].filter(Boolean);

  for (const f of fields) {
    if (f.includes(qNorm) || qNorm.includes(f)) return true;
    const matched = qTokens.filter(t => f.split(' ').includes(t));
    if (matched.length >= Math.ceil(qTokens.length * 0.6)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PETICIONES HTTP
// ---------------------------------------------------------------------------

async function httpGet(url, extraConfig = {}) {
  const reqTimeout = timeout(extraConfig.timeout || DEFAULT_TIMEOUT_MS);
  return axios.get(url, {
    timeout: reqTimeout,
    headers: {
      ...DEFAULT_HEADERS,
      ...(extraConfig.headers || {})
    },
    ...extraConfig
  });
}

// ---------------------------------------------------------------------------
// 1. BÚSQUEDA EN PELISPANDA (3 niveles + resolución por TMDB ID)
// ---------------------------------------------------------------------------

async function searchWpreact(query) {
  const url = `${BASE_URL}/wp-json/wpreact/v1/search?query=${encodeURIComponent(query)}`;
  try {
    const res = await httpGet(url);
    const list = extractArrayFromPayload(res.data, ['results', 'data', 'movies', 'series', 'animes']);
    const mapped = list.map(item => mapRawItemToResult(item)).filter(Boolean);
    if (mapped.length > 0) {
      console.log(`[PelisPanda] ✅ wpreact devolvió ${mapped.length} resultados para "${query}"`);
      return mapped;
    }
    return null;
  } catch (err) {
    console.warn(`[PelisPanda] ❌ Error wpreact search "${query}": ${err.message}`);
    return null;
  }
}

async function searchReactFallback(query) {
  for (const param of ['q', 's']) {
    const url = `${BASE_URL}/wp-json/react/v1/search?${param}=${encodeURIComponent(query)}`;
    try {
      const res = await httpGet(url);
      if (res.data && res.data.error === true) continue;
      const list = extractArrayFromPayload(res.data, ['data', 'results', 'items', 'posts']);
      if (list.length > 0) {
        let mapped = list.map(item => mapRawItemToResult(item)).filter(Boolean);
        if (param === 's') {
          mapped = mapped.filter(item => matchesSearchQuery(item, query));
        }
        if (mapped.length > 0) {
          console.log(`[PelisPanda] ✅ react (${param}) devolvió ${mapped.length} resultados para "${query}"`);
          return mapped;
        }
      }
    } catch (err) {
      console.warn(`[PelisPanda] ❌ Error react search (${param}) "${query}": ${err.message}`);
    }
  }
  return null;
}

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
      if (/\/undefined\//i.test(href)) return;
      const m = href.match(/\/(peliculas?|movies?|series?|animes?)\/([^/?#]+)/i);
      if (!m) return;

      const tipo = normalizarTipo(m[1]);
      const slug = decodeURIComponent(m[2]).trim();
      if (!slug || slug === 'page' || slug === 'undefined' || seen.has(`${tipo}:${slug}`)) return;

      const $card = $(el).closest('article, li, .item, .post, .TPost, .movie-card, div');
      let titulo =
        normalizeText($(el).attr('title')) ||
        normalizeText($card.find('h1, h2, h3, h4, .title, .Title').first().text()) ||
        normalizeText($(el).text());

      titulo = titulo
        .replace(/^(ver|descargar)\s+/i, '')
        .replace(/\s*-\s*Lat$/i, '')
        .replace(/\s*\(\d{4}\)\s*$/, '')
        .trim();
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
        fuente: 'pelispanda',
        url: `${BASE_URL}/${tipoToHtmlPath(tipo)}/${slug}/`
      };

      if (!matchesSearchQuery(candidate, query)) return;

      seen.add(`${tipo}:${slug}`);
      results.push(candidate);
    });

    return results;
  } catch (err) {
    console.warn(`[PelisPanda] ❌ Error HTML search "${query}": ${err.message}`);
    return [];
  }
}

/**
 * Busca en PelisPanda con cascada `wpreact/v1` → `react/v1` → HTML.
 *
 * @param {string} query
 * @param {string|null} [tipo]
 * @returns {Promise<Array>}
 */
async function buscarEnPelisPanda(query, tipo = null) {
  const cleanQuery = normalizeText(query);
  if (!cleanQuery || /^(tt\d+|kitsu:\d+)$/i.test(cleanQuery)) return [];

  const tipoNorm = tipo ? normalizarTipo(tipo) : null;
  const cacheKey = `pp:search:${cleanQuery.toLowerCase()}:${tipoNorm || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return withInFlight(cacheKey, async () => {
    const ReCached = cacheGet(cacheKey);
    if (ReCached !== undefined) return ReCached;

    console.log(`[PelisPanda] 🔍 Buscando en PelisPanda: "${cleanQuery}"`);

    let items = await searchWpreact(cleanQuery);
    if (!items || items.length === 0) {
      items = await searchReactFallback(cleanQuery);
    }
    if (!items || items.length === 0) {
      items = await scrapeHtmlSearch(cleanQuery);
    }

    if (!items || items.length === 0) {
      cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
      return [];
    }

    const filtered = tipoNorm
      ? items.filter(it => {
        if (tipoNorm === 'serie') return it.tipo === 'serie' || it.tipo === 'anime';
        return it.tipo === tipoNorm;
      })
      : items;

    const finalResults = filtered.length > 0 ? filtered : items;
    cacheSet(cacheKey, finalResults, CACHE_TTL_SEARCH_MS);
    return finalResults;
  });
}

/**
 * Resuelve el título exacto en español en PelisPanda a partir del TMDB ID (`/?tmdb={id}`)
 * y devuelve los candidatos encontrados.
 *
 * @param {string|number} tmdbId
 * @returns {Promise<Array>}
 */
async function buscarPorTmdb(tmdbId) {
  const idStr = String(tmdbId || '').trim();
  if (!/^\d+$/.test(idStr)) return [];

  const cacheKey = `pp:tmdb:${idStr}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return withInFlight(cacheKey, async () => {
    try {
      const url = `${BASE_URL}/?tmdb=${encodeURIComponent(idStr)}`;
      const res = await httpGet(url, {
        responseType: 'text',
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400
      });

      const body = typeof res.data === 'string' ? res.data : String(res.data || '');
      const $ = cheerio.load(body);
      const anchorText = normalizeText($('a').first().text());
      if (!anchorText || anchorText.length < 2) {
        cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
        return [];
      }

      console.log(`[PelisPanda] 🎯 TMDB ${idStr} → título en PelisPanda: "${anchorText}"`);
      const results = await buscarEnPelisPanda(anchorText);
      const normTarget = normalizeTitle(anchorText);
      const enriched = results.map(r => {
        if (!r.tmdbId && normalizeTitle(r.titulo) === normTarget) {
          return { ...r, tmdbId: idStr };
        }
        return r;
      });
      const exactTmdb = enriched.filter(r => r.tmdbId && String(r.tmdbId) === idStr);
      const final = exactTmdb.length > 0 ? exactTmdb : enriched;
      cacheSet(cacheKey, final, CACHE_TTL_SEARCH_MS);
      return final;
    } catch {
      cacheSet(cacheKey, [], CACHE_TTL_NEGATIVE_MS);
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// 2. EXTRACCIÓN DE TORRENTS Y DETALLE (JSON wpreact + Tablas HTML)
// ---------------------------------------------------------------------------

function collectDownloads(data, tipo = 'pelicula') {
  if (!data || typeof data !== 'object') return [];

  const esPelicula = normalizarTipo(tipo) === 'pelicula';
  const out = [];
  const seen = new Set();

  function toIntOrNull(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function addItem(rawObj, ctx = {}) {
    if (!rawObj) return;
    const obj = typeof rawObj === 'string' ? { download_link: rawObj } : rawObj;
    const rawUrl =
      obj.download_link ||
      obj.magnet ||
      obj.link ||
      obj.url ||
      obj.href ||
      obj.file ||
      '';

    const urlStr = String(rawUrl || '').trim();
    if (!urlStr) return;

    let magnet = null;
    if (isValidMagnet(urlStr)) {
      magnet = normalizarMagnet(urlStr);
    } else if (isAcortalinkUrl(urlStr)) {
      magnet = decryptAcortalink(urlStr);
    } else if (!/\.torrent($|\?)/i.test(urlStr)) {
      return;
    }

    const dn = parseMagnetDn(magnet || urlStr);
    const calidad = normalizeCalidad(obj.quality || obj.calidad || obj.format || ctx.quality, dn);

    let temporada = null;
    let episodio = null;

    if (!esPelicula) {
      temporada = toIntOrNull(obj.season ?? obj.temporada ?? ctx.season);
      episodio = toIntOrNull(obj.episode ?? obj.episodio ?? obj.chapter ?? obj.capitulo ?? ctx.episode);

      if (temporada === null || episodio === null) {
        const parsed = extraerTemporadaEpisodio(
          `${dn} ${obj.title || ''} ${obj.name || ''} ${ctx.label || ''}`,
          temporada || 1
        );
        if (temporada === null && parsed.temporada !== null) temporada = parsed.temporada;
        if (episodio === null && parsed.episodio !== null) episodio = parsed.episodio;
      }

      if (episodio !== null && temporada === null) {
        temporada = 1;
      }
    }

    const dedupKey = `${magnet || urlStr}|${temporada ?? ''}|${episodio ?? ''}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    const hm = magnet ? magnet.match(/btih:([0-9a-f]{40})/i) : null;

    out.push({
      calidad,
      tamaño: normalizeTamaño(obj.size || obj.tamaño || obj.peso || ctx.size, magnet),
      idioma: normalizeIdioma(obj.language || obj.idioma || data.language || ctx.language || 'Latino'),
      subtitulos: normalizeSubs(obj.subs ?? obj.subtitles ?? obj.subtitulos ?? ctx.subs),
      fecha: normalizeFecha(obj.date || obj.fecha || ''),
      temporada,
      episodio,
      magnet: magnet || null,
      infoHash: hm ? hm[1].toLowerCase() : null,
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

    if (
      node.download_link ||
      node.magnet ||
      ((node.link || node.url) && (isValidMagnet(node.link || node.url || '') || isAcortalinkUrl(node.link || node.url || '')))
    ) {
      addItem(node, nextCtx);
    }

    for (const key of ['downloads', 'torrents', 'links', 'files', 'sources', 'mirrors']) {
      const val = node[key];
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
      }
    }

    for (const key of ['episodes', 'episodios', 'chapters', 'capitulos']) {
      const val = node[key];
      if (Array.isArray(val)) {
        val.forEach((eNode, idx) => {
          const eNum = toIntOrNull(eNode?.episode ?? eNode?.episodio ?? eNode?.episode_number ?? eNode?.number ?? eNode?.chapter) ?? (idx + 1);
          walk(eNode, { ...nextCtx, episode: eNum });
        });
      }
    }
  }

  walk(data, {});
  return out;
}

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

function detectTableSeason($, $table, numFilasTabla) {
  const candidates = [];

  const caption = elementTextWithSpaces($, $table.find('caption'));
  if (caption) candidates.push(caption);

  let $curr = $table;
  for (let depth = 0; depth < 4 && $curr && $curr.length; depth++) {
    const $prevs = $curr.prevAll();
    $prevs.each((_, prevEl) => {
      const tag = (prevEl.tagName || '').toLowerCase();
      if (tag === 'table') return false;
      const txt = elementTextWithSpaces($, prevEl);
      if (txt) candidates.push(txt);
      $(prevEl).find('h1, h2, h3, h4, h5, span, p, strong, div').each((__, child) => {
        const cTxt = elementTextWithSpaces($, child);
        if (cTxt && /(?:temporada|season)/i.test(cTxt)) {
          candidates.push(cTxt);
        }
      });
    });
    $curr = $curr.parent();
  }

  for (const cand of candidates) {
    const s = extraerTemporadaDeEncabezado(cand, numFilasTabla);
    if (s !== null) return s;
  }
  return null;
}

/**
 * Parsea el HTML de una página de PelisPanda (`/pelicula/{slug}/`, `/serie/{slug}/`, `/anime/{slug}/`).
 * Soporta enlaces `magnet:` directos (el formato estándar en las tablas HTML de PelisPanda),
 * enlaces `acortalink` (con desencriptación AES offline) y extracción de temporada/episodio
 * desde `/player/{season}/{episode}`, encabezados `Temporada X Y Episodios` y `dn=` del magnet.
 */
function parseHtmlDetail(html, meta = {}) {
  const $ = cheerio.load(String(html || ''));
  const slug = meta.slug || '';
  const tipo = normalizarTipo(meta.tipo || 'pelicula');
  const esPelicula = tipo === 'pelicula';

  const h1Text = normalizeText($('h1').first().text());
  const ogTitle = normalizeText($('meta[property="og:title"]').attr('content') || '');
  const rawTitle = h1Text || ogTitle.replace(/\s*-\s*Pelispanda.*$/i, '').replace(/\s*-\s*Ver y Descargar.*$/i, '');
  const titulo = rawTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim() || slug.replace(/-/g, ' ');

  const año = extractYear(ogTitle, $('body').text());
  const poster = normalizePosterUrl(
    $('meta[property="og:image"]').attr('content') || $('img[ alt ]').first().attr('src'),
    false
  );

  // Extraer metadatos adicionales de la lista de detalles de PelisPanda (- Género:, - Año:, - Duración:, - Director:, - Reparto:)
  const generos = [];
  $('a[href*="/category/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    // Ignorar enlaces de "También te puede interesar" que apuntan a hacktorrent.men
    if (/hacktorrent\.men/i.test(href)) return;
    const g = normalizeText($(a).text());
    if (g && !generos.includes(g)) generos.push(g);
  });

  const directores = [];
  $('a[href*="/director/"]').each((_, a) => {
    const d = normalizeText($(a).text());
    if (d && !directores.includes(d)) directores.push(d);
  });

  const actores = [];
  $('a[href*="/actors/"]').each((_, a) => {
    const act = normalizeText($(a).text());
    if (act && !actores.includes(act)) actores.push(act);
  });

  const bodyText = $('body').text() || '';
  const mDur = bodyText.match(/Duraci[oó]n\s*:\s*([^\n\r|-]+)/i);
  const duracionHtml = normalizeDuracion(mDur ? mDur[1] : '') || null;

  const relacionados = [];
  const seenRel = new Set();
  $('.related a[href], a[href*="/undefined/"], a[href*="/pelicula/"], a[href*="/peliculas/"], a[href*="/serie/"], a[href*="/anime/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href.includes('/undefined/') && !$(a).closest('.related').length) return;
    let relSlug = '';
    let relTipo = tipo;
    const undefMatch = href.match(/\/undefined\/([^/?#]+)/i);
    if (undefMatch) {
      relSlug = decodeURIComponent(undefMatch[1]).trim();
    } else {
      const info = slugAndTypeFromPath(href);
      relSlug = info.slug;
      if (info.tipo) relTipo = info.tipo;
    }
    if (!relSlug || seenRel.has(relSlug)) return;
    const relTitle = normalizeText($(a).find('h3, h4, .title').text() || $(a).attr('title') || $(a).text());
    if (!relTitle) return;
    seenRel.add(relSlug);
    relacionados.push({
      slug: relSlug,
      titulo: relTitle,
      tipo: normalizarTipo(relTipo),
      poster: normalizePosterUrl($(a).find('img').attr('src'), false)
    });
  });

  const torrents = [];
  const seen = new Set();

  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headers = [];
    $table.find('thead th, tr:first-child th').each((_, th) => {
      headers.push(normalizeText($(th).text()).toLowerCase());
    });

    const $rows = $table.find('tbody tr').length > 0
      ? $table.find('tbody tr')
      : $table.find('tr').filter((_, tr) => $(tr).find('td').length > 0);

    const numFilas = $rows.length;
    if (numFilas === 0) return;

    const idxEp = headers.findIndex(h => h === '#' || h.includes('episodio') || h.includes('cap'));
    const idxFormato = headers.findIndex(h => h.includes('formato') || h.includes('calidad'));
    const idxTamaño = headers.findIndex(h => h.includes('tama') || h.includes('peso') || h.includes('size'));
    const idxSubs = headers.findIndex(h => h.includes('subt'));
    const idxIdioma = headers.findIndex(h => h.includes('idioma') || h.includes('audio'));
    const idxFecha = headers.findIndex(h => h.includes('fecha') || h.includes('date'));

    const tableSeason = !esPelicula
      ? (detectTableSeason($, $table, numFilas) ?? (tableIdx + 1))
      : null;

    $rows.each((rowIdx, trEl) => {
      const $tr = $(trEl);
      const $tds = $tr.find('td');
      if ($tds.length === 0) return;

      let downloadHref = '';
      let playerSeason = null;
      let playerEpisode = null;

      $tr.find('a[href]').each((_, aEl) => {
        const href = String($(aEl).attr('href') || '').trim();
        if (!href) return;

        const mPlayer = href.match(/\/player\/(\d{1,2})\/(\d{1,3})(?:\/|$|\?|#)/i);
        if (mPlayer) {
          playerSeason = parseInt(mPlayer[1], 10);
          playerEpisode = parseInt(mPlayer[2], 10);
          return;
        }

        if (isValidMagnet(href) || isAcortalinkUrl(href) || /\.torrent($|\?)/i.test(href)) {
          if (!downloadHref || isValidMagnet(href)) {
            downloadHref = href;
          }
        }
      });

      if (!downloadHref) return;

      let magnet = null;
      let torrentUrl = null;
      if (isValidMagnet(downloadHref)) {
        magnet = normalizarMagnet(downloadHref);
      } else if (isAcortalinkUrl(downloadHref)) {
        magnet = decryptAcortalink(downloadHref);
      } else if (/\.torrent($|\?)/i.test(downloadHref)) {
        torrentUrl = downloadHref.startsWith('http')
          ? downloadHref
          : `${BASE_URL}/${downloadHref.replace(/^\/+/, '')}`;
      }

      const cell = idx => (idx >= 0 && idx < $tds.length ? normalizeText($($tds[idx]).text()) : '');
      const hasEpisodeCol = !esPelicula && (idxEp === 0 || ($tds.length >= 6 && /^\d{1,3}$/.test(normalizeText($($tds[0]).text()))));

      const rawEpText = hasEpisodeCol ? normalizeText($($tds[idxEp >= 0 ? idxEp : 0]).text()) : '';
      const rawCalidad = idxFormato >= 0
        ? cell(idxFormato)
        : normalizeText($($tds[hasEpisodeCol ? 1 : 0]).text());
      const rawTamaño = idxTamaño >= 0
        ? cell(idxTamaño)
        : normalizeText($($tds[hasEpisodeCol ? 2 : 3]).text());
      const rawSubs = idxSubs >= 0
        ? cell(idxSubs)
        : normalizeText($($tds[hasEpisodeCol ? 3 : 4]).text());
      const rawIdioma = idxIdioma >= 0
        ? cell(idxIdioma)
        : normalizeText($($tds[hasEpisodeCol ? 4 : 1]).text());
      const rawFecha = idxFecha >= 0
        ? cell(idxFecha)
        : normalizeText($($tds[hasEpisodeCol ? 5 : 2]).text());

      const dn = parseMagnetDn(magnet || downloadHref);
      const dnSE = !esPelicula ? extraerTemporadaEpisodio(dn, tableSeason || 1) : { temporada: null, episodio: null };

      let temporada = null;
      let episodio = null;

      if (!esPelicula) {
        if (playerSeason !== null && playerEpisode !== null) {
          temporada = playerSeason;
          episodio = playerEpisode;
        } else {
          const epFromCol = /^\d{1,3}$/.test(rawEpText) ? parseInt(rawEpText, 10) : null;
          episodio = epFromCol ?? dnSE.episodio ?? (rowIdx + 1);
          temporada = tableSeason ?? dnSE.temporada ?? 1;
          if (dnSE.temporada !== null && tableSeason !== null && tableSeason > 10 && dnSE.temporada <= 10) {
            temporada = dnSE.temporada;
          }
        }
      }

      const key = `${magnet || torrentUrl || downloadHref}|${temporada ?? ''}|${episodio ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      const hm = magnet ? magnet.match(/btih:([0-9a-f]{40})/i) : null;

      torrents.push({
        calidad: normalizeCalidad(rawCalidad, dn),
        tamaño: normalizeTamaño(rawTamaño, magnet),
        idioma: normalizeIdioma(rawIdioma || 'Latino'),
        subtitulos: normalizeSubs(rawSubs),
        fecha: normalizeFecha(rawFecha),
        temporada,
        episodio,
        magnet: magnet || null,
        infoHash: hm ? hm[1].toLowerCase() : null,
        torrentUrl: torrentUrl || undefined,
        acortalink: magnet || torrentUrl ? null : downloadHref,
        dn: dn || null
      });
    });
  });

  return {
    slug,
    titulo,
    tituloOriginal: meta.tituloOriginal || '',
    tipo,
    año: meta.año || año,
    duracion: normalizeDuracion(meta.duracion || '') || duracionHtml || null,
    imdbRating: meta.imdbRating || null,
    tmdbId: meta.tmdbId || null,
    idioma: meta.idioma || 'Latino',
    generos: meta.generos?.length ? meta.generos : generos,
    actores: meta.actores?.length ? meta.actores : actores,
    director: meta.director?.length ? meta.director : directores,
    sinopsis: meta.sinopsis || '',
    poster: meta.poster || poster,
    background: meta.background || poster || null,
    relacionados: meta.relacionados?.length ? meta.relacionados : relacionados,
    fuente: 'pelispanda',
    url: meta.url || `${BASE_URL}/${tipoToHtmlPath(tipo)}/${slug}/`,
    torrents
  };
}

function mergeMetadataWithHtmlDetail(apiDetail, htmlDetail) {
  if (!apiDetail) return htmlDetail;
  if (!htmlDetail) return apiDetail;
  return {
    ...htmlDetail,
    ...apiDetail,
    titulo: apiDetail.titulo || htmlDetail.titulo,
    tituloOriginal: apiDetail.tituloOriginal || htmlDetail.tituloOriginal,
    año: apiDetail.año || htmlDetail.año,
    duracion: apiDetail.duracion || htmlDetail.duracion || null,
    imdbRating: apiDetail.imdbRating || htmlDetail.imdbRating,
    tmdbId: apiDetail.tmdbId || htmlDetail.tmdbId,
    poster: apiDetail.poster || htmlDetail.poster,
    background: apiDetail.background || htmlDetail.background,
    sinopsis: apiDetail.sinopsis || htmlDetail.sinopsis,
    generos: apiDetail.generos?.length ? apiDetail.generos : htmlDetail.generos,
    actores: apiDetail.actores?.length ? apiDetail.actores : htmlDetail.actores,
    director: apiDetail.director?.length ? apiDetail.director : htmlDetail.director,
    relacionados: apiDetail.relacionados?.length ? apiDetail.relacionados : htmlDetail.relacionados,
    torrents: (apiDetail.torrents && apiDetail.torrents.length > 0)
      ? apiDetail.torrents
      : (htmlDetail.torrents || [])
  };
}

/**
 * Extrae el detalle y la lista de torrents de un ítem de PelisPanda.
 * Combina `/wp-json/wpreact/v1/{movie|serie|anime}/{slug}` con las tablas HTML
 * de `https://pelispanda.org/{pelicula|peliculas|serie|anime}/{slug}/` (y `/{slug}/`).
 *
 * @param {string} slug
 * @param {string} [tipoPreferido='pelicula']
 * @returns {Promise<object|null>}
 */
async function extraerDetalleTorrent(slug, tipoPreferido = 'pelicula') {
  const cleanSlug = normalizeText(slug).replace(/^\/+|\/+$/g, '');
  if (!cleanSlug || cleanSlug === 'undefined') return null;

  const tipoInicial = normalizarTipo(tipoPreferido);
  const cacheKey = `pp:detail:${tipoInicial}:${cleanSlug}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return withInFlight(cacheKey, async () => {
    const ReCached = cacheGet(cacheKey);
    if (ReCached !== undefined) return ReCached;

    console.log(`[PelisPanda] 📄 Extrayendo detalle: slug="${cleanSlug}" tipo="${tipoInicial}"`);

    const ordenTipos = [
      tipoInicial,
      ...['pelicula', 'serie', 'anime'].filter(t => t !== tipoInicial)
    ];

    let metadataFromApi = null;

    // 1) Intentar API wpreact/v1/{movie|serie|anime}/{slug}
    for (const t of ordenTipos) {
      const endpoint = tipoToEndpoint(t);
      const url = `${BASE_URL}/wp-json/wpreact/v1/${endpoint}/${encodeURIComponent(cleanSlug)}`;
      try {
        const res = await httpGet(url);
        const data = res.data;
        if (!data || typeof data !== 'object' || data.code || data.error) continue;

        const baseMeta = mapRawItemToResult({ ...data, slug: data.slug || cleanSlug }, t);
        if (!baseMeta) continue;

        const torrents = collectDownloads(data, baseMeta.tipo);
        const detailObj = {
          ...baseMeta,
          torrents
        };

        if (torrents.length > 0) {
          cacheSet(cacheKey, detailObj, CACHE_TTL_DETAIL_MS);
          return detailObj;
        }

        if (!metadataFromApi) {
          metadataFromApi = detailObj;
        }
        break;
      } catch {
        // 404 en este tipo → probar el siguiente
      }
    }

    // 2) Scraping HTML (obligatorio para todas las series en PelisPanda y respaldo para películas/animes)
    const tiposHtml = metadataFromApi
      ? [metadataFromApi.tipo, ...ordenTipos.filter(t => t !== metadataFromApi.tipo)]
      : ordenTipos;

    const candidateHtmlUrls = [];
    for (const t of tiposHtml) {
      const pathType = tipoToHtmlPath(t);
      candidateHtmlUrls.push({ tipo: t, url: `${BASE_URL}/${pathType}/${encodeURIComponent(cleanSlug)}/` });
      if (t === 'pelicula') {
        candidateHtmlUrls.push({ tipo: t, url: `${BASE_URL}/peliculas/${encodeURIComponent(cleanSlug)}/` });
      }
    }
    // En PelisPanda algunas películas antiguas están en la raíz `https://pelispanda.org/{slug}/`
    candidateHtmlUrls.push({ tipo: 'pelicula', url: `${BASE_URL}/${encodeURIComponent(cleanSlug)}/` });

    for (const { tipo: t, url: htmlUrl } of candidateHtmlUrls) {
      try {
        const res = await httpGet(htmlUrl, { responseType: 'text' });
        const html = typeof res.data === 'string' ? res.data : String(res.data || '');
        if (!html || html.length < 200) continue;

        const parsed = parseHtmlDetail(html, {
          ...(metadataFromApi || {}),
          slug: cleanSlug,
          tipo: metadataFromApi?.tipo || t,
          url: htmlUrl
        });

        if (parsed.torrents.length > 0) {
          const merged = mergeMetadataWithHtmlDetail(metadataFromApi, parsed);
          cacheSet(cacheKey, merged, CACHE_TTL_DETAIL_MS);
          return merged;
        }
      } catch {
        // Probar siguiente ruta HTML
      }
    }

    if (metadataFromApi) {
      cacheSet(cacheKey, metadataFromApi, CACHE_TTL_NEGATIVE_MS);
      return metadataFromApi;
    }

    cacheSet(cacheKey, null, CACHE_TTL_NEGATIVE_MS);
    return null;
  });
}

// ---------------------------------------------------------------------------
// 3. CATÁLOGOS DE PELISPANDA (peliculas, series, animes, estrenos, categoría)
// ---------------------------------------------------------------------------

async function obtenerCatalogo(tipo = 'peliculas', page = 1, genero = null) {
  const t = String(tipo || 'peliculas').toLowerCase().trim();
  const esSeries = t === 'series' || t === 'serie';
  const esAnimes = t === 'animes' || t === 'anime';
  const esEstrenos = t === 'estrenos' || t === 'released';
  const tipoFallback = esAnimes ? 'anime' : esSeries ? 'serie' : 'pelicula';
  const generoClean = genero && genero !== 'Todos' ? normalizeText(genero) : null;

  const cacheKey = `pp:catalog:${t}:p${page}:g${generoClean || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return withInFlight(cacheKey, async () => {
    if (generoClean) {
      const catUrl = `${BASE_URL}/wp-json/wpreact/v1/category?category=${encodeURIComponent(generoClean)}&page=${page}`;
      try {
        const res = await httpGet(catUrl);
        const rawList = extractArrayFromPayload(res.data, ['results', 'data', 'movies', 'series', 'animes']);
        if (rawList.length > 0) {
          const mapped = rawList
            .map(item => mapRawItemToResult(item, tipoFallback))
            .filter(Boolean)
            .filter(item => {
              if (esAnimes) return item.tipo === 'anime';
              if (esSeries) return item.tipo === 'serie' || item.tipo === 'anime';
              return item.tipo === 'pelicula';
            });
          cacheSet(cacheKey, mapped, CACHE_TTL_CATALOG_MS);
          return mapped;
        }
      } catch (err) {
        console.warn(`[PelisPanda] Error catálogo categoría (${generoClean} p${page}): ${err.message}`);
      }
    }

    const endpoint = esAnimes
      ? 'animes'
      : esSeries
        ? 'series'
        : esEstrenos
          ? 'released'
          : 'movies';
    const url = `${BASE_URL}/wp-json/wpreact/v1/${endpoint}?page=${page}`;
    try {
      const res = await httpGet(url);
      const rawList = extractArrayFromPayload(res.data, ['movies', 'series', 'animes', 'results', 'data']);
      if (rawList.length > 0) {
        const mapped = rawList
          .map(item => mapRawItemToResult(item, tipoFallback))
          .filter(Boolean);
        cacheSet(cacheKey, mapped, CACHE_TTL_CATALOG_MS);
        return mapped;
      }
    } catch (err) {
      console.warn(`[PelisPanda] Error catálogo wpreact (${endpoint} p${page}): ${err.message}`);
    }

    return [];
  });
}

// ---------------------------------------------------------------------------
// 4. RESOLUCIÓN DE STREAMS DE STREMIO DESDE PELISPANDA
// ---------------------------------------------------------------------------

function torrentToStream(torrent, tituloFallback, extra = {}) {
  const rawMagnet = torrent.magnet || torrent.torrentUrl;
  if (!rawMagnet) return null;
  const magnet = normalizarMagnet(rawMagnet) || rawMagnet;

  const calidad = torrent.calidad || 'Desconocido';
  const tamaño = torrent.tamaño || torrent.size || '';
  const idioma = torrent.idioma || torrent.language || 'Latino';
  const subs = torrent.subtitulos || (torrent.subs ? 'Sí' : 'No');

  let infoHash = torrent.infoHash || null;
  if (!infoHash && magnet.startsWith('magnet:')) {
    const m = magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32}|[a-fA-F0-9]{32})/i);
    if (m) {
      const raw = m[1];
      infoHash = (raw.length === 32 && /^[A-Z2-7]{32}$/i.test(raw) && !/^[0-9a-f]{32}$/i.test(raw))
        ? (base32ToHex(raw) || raw.toLowerCase())
        : raw.toLowerCase();
    }
  }

  const dn = torrent.dn || parseMagnetDn(magnet) || null;
  const se = torrentSeasonEpisode(torrent);
  const season = extra.season ?? se.season;
  const episode = extra.episode ?? se.episode;
  const esPack = extra.esPack === true;

  const lineas = [];
  const displayName = (season !== null && season !== undefined && episode !== null && episode !== undefined)
    ? `${extra.titulo || tituloFallback} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : (extra.titulo || tituloFallback || 'PelisPanda');
  lineas.push(displayName);
  lineas.push(`🐼 ${calidad} | 💾 ${tamaño || '?'} | 🗣️ ${idioma} | Subs: ${subs}`);
  if (esPack) lineas.push('📦 Temporada completa (pack)');
  if (dn) lineas.push(`📄 ${dn}`);
  if (torrent.fecha) lineas.push(`📅 ${torrent.fecha}`);

  const stream = {
    name: `PelisPanda\n${calidad}`,
    title: lineas.join('\n'),
    url: magnet,
    behaviorHints: {
      bingeGroup: `pelispanda-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      videoHash: infoHash ? `${infoHash}:${calidad}` : undefined,
      filename: dn || undefined
    },
    _meta: {
      fuente: 'pelispanda',
      idioma,
      calidad,
      seeders: 0,
      pack: esPack === true
    }
  };
  if (infoHash) stream.infoHash = infoHash;
  return stream;
}

function filtrarPorEpisodio(torrents, season, episode) {
  const exactos = [];
  const packs = [];

  for (const t of torrents) {
    const se = torrentSeasonEpisode(t);
    if (se.season === season && se.episode === episode) {
      exactos.push(t);
    } else if (se.season === season && (se.episode === null || se.episode === undefined) && se.isPack) {
      packs.push(t);
    }
  }

  return { exactos, packs };
}

function variantesDeBusqueda(info) {
  const out = [];
  const push = q => {
    const v = String(q || '').trim();
    if (v.length < 2) return;
    if (/^(tt\d+|kitsu:\d+)$/i.test(v)) return;
    if (!out.some(x => normalizeTitle(x) === normalizeTitle(v))) out.push(v);
  };

  push(info.title);
  push(info.originalTitle);
  if (Array.isArray(info.altTitles)) {
    for (const alt of info.altTitles) push(alt);
  }
  if (info.title) {
    push(String(info.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' '));
    push(String(info.title).replace(/\s*\((19|20)\d{2}\)\s*$/, ''));
    const antesDeDosPuntos = String(info.title).split(':')[0].trim();
    if (antesDeDosPuntos.split(' ').length >= 2) push(antesDeDosPuntos);
  }
  return out.slice(0, 4);
}

/**
 * Busca streams en PelisPanda validando título, título original, TMDB ID, año, tipo y temporada/episodio.
 *
 * @param {object} opts { title, originalTitle, year, type, season, episode, tmdbId, altTitles }
 * @returns {Promise<Array>}
 */
async function buscarStreams({ title, originalTitle, year, type, season = null, episode = null, tmdbId = null, altTitles = [] } = {}) {
  if (!title && !originalTitle && !tmdbId) return [];

  const esSerie = type === 'series' || type === 'serie' || type === 'anime';
  const tipoObjetivo = esSerie ? 'series' : 'movie';
  const info = {
    title,
    originalTitle,
    year,
    tmdbId: tmdbId ? String(tmdbId) : null,
    altTitles: Array.isArray(altTitles) ? [...altTitles] : []
  };

  const variantes = variantesDeBusqueda(info);
  const todos = new Map();

  for (const q of variantes) {
    try {
      const resultados = await buscarEnPelisPanda(q, null);
      for (const r of resultados || []) {
        if (!r || !r.slug) continue;
        if (!todos.has(r.slug)) todos.set(r.slug, r);
      }
    } catch (e) {
      console.warn(`[PelisPanda] Búsqueda "${q}" falló:`, e.message);
    }
    if (todos.size >= 8) break;
  }

  let lista = Array.from(todos.values());
  let ranked = lista.length > 0
    ? rankCandidates(lista, {
      title: info.title,
      originalTitle: info.originalTitle,
      altTitles: info.altTitles,
      tmdbId: info.tmdbId,
      year: info.year,
      type: tipoObjetivo
    })
    : [];

  const mejorScoreInicial = ranked[0]?.score || 0;
  if (info.tmdbId && mejorScoreInicial < 0.78) {
    try {
      const porTmdb = await buscarPorTmdb(info.tmdbId);
      for (const r of porTmdb || []) {
        if (!r || !r.slug) continue;
        const t = r.titulo || r.title;
        if (t && !info.altTitles.includes(t)) info.altTitles.push(t);
        if (!todos.has(r.slug)) todos.set(r.slug, r);
      }
      if (porTmdb && porTmdb.length > 0) {
        lista = Array.from(todos.values());
        ranked = rankCandidates(lista, {
          title: info.title,
          originalTitle: info.originalTitle,
          altTitles: info.altTitles,
          tmdbId: info.tmdbId,
          year: info.year,
          type: tipoObjetivo
        });
      }
    } catch (e) {
      console.warn(`[PelisPanda] Búsqueda TMDB ${info.tmdbId} falló:`, e.message);
    }
  }

  if (ranked.length === 0) return [];

  const elegidos = pickBestMatch(ranked.map(r => r.cand), {
    title: info.title,
    originalTitle: info.originalTitle,
    altTitles: info.altTitles,
    tmdbId: info.tmdbId,
    year: info.year,
    type: tipoObjetivo
  });

  const MIN_SCORE = 0.6;
  let mejores = elegidos.ranked.filter(r => r.score >= MIN_SCORE);
  if (mejores.length === 0 && elegidos.best && elegidos.match) {
    mejores = [elegidos.match];
  }

  const maxCandidatos = Math.min(mejores.length, 3);
  for (let i = 0; i < maxCandidatos; i++) {
    const { cand, score } = mejores[i];
    if (!cand?.slug || score < 0.4) continue;

    const tipoContenido = cand.tipo === 'pelicula' ? 'pelicula'
      : cand.tipo === 'anime' ? 'anime'
      : cand.tipo === 'serie' ? 'serie'
      : (esSerie ? 'serie' : 'pelicula');

    let detalle;
    try {
      detalle = await extraerDetalleTorrent(cand.slug, tipoContenido);
    } catch {
      continue;
    }

    if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) {
      continue;
    }

    // Verificar coherencia del detalle
    if (detalle.tmdbId && info.tmdbId && String(detalle.tmdbId) !== String(info.tmdbId)) {
      continue;
    }

    if (esSerie && season !== null && episode !== null) {
      const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
      if (exactos.length === 0 && packs.length === 0) continue;
      if (exactos.length > 0) {
        return exactos
          .map(t => torrentToStream(t, detalle.titulo, { titulo: detalle.titulo, season, episode }))
          .filter(Boolean);
      }
      return packs
        .map(t => torrentToStream(t, detalle.titulo, { titulo: detalle.titulo, season, episode: null, esPack: true }))
        .filter(Boolean);
    }

    const filtrados = !esSerie
      ? detalle.torrents.filter(t => {
        const se = torrentSeasonEpisode(t);
        return se.season === null && se.episode === null;
      })
      : detalle.torrents;

    const streams = filtrados
      .map(t => torrentToStream(t, detalle.titulo, { titulo: detalle.titulo, season: null, episode: null }))
      .filter(Boolean);

    if (streams.length > 0) return streams;
  }

  return [];
}

async function resolverMagnetsEnLote(torrents) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  return torrents.map(t => {
    if (t.magnet) return t;
    const acorta = t.acortalink || t.acortarUrl || null;
    if (acorta) {
      const dec = decryptAcortalink(acorta);
      if (dec) {
        const hm = dec.match(/btih:([0-9a-f]{40})/i);
        return { ...t, magnet: dec, infoHash: hm ? hm[1].toLowerCase() : null };
      }
    }
    return t;
  });
}

const clearCaches = () => {
  memoryCache.clear();
  inFlight.clear();
};

module.exports = {
  BASE_URL,
  buscarEnPelisPanda,
  buscarPorTmdb,
  extraerDetalleTorrent,
  obtenerCatalogo,
  buscarStreams,
  torrentToStream,
  resolverMagnetsEnLote,
  mapRawItemToResult,
  normalizarMagnet,
  base32ToHex,
  decryptAcortalink,
  decodeReactGuid,
  _parseHtmlDetail: parseHtmlDetail,
  _collectDownloads: collectDownloads,
  _normalizePosterUrl: normalizePosterUrl,
  _normalizeDuracion: normalizeDuracion,
  _normalizeImdb: normalizeImdb,
  _normalizeFecha: normalizeFecha,
  _limpiarCache: clearCaches,
  _clearCaches: clearCaches
};
