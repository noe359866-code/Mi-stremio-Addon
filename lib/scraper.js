/**
 * Scraper dedicado para https://hacktorrent.cc/
 * Usa Axios + Cheerio y la API JSON wpreact descubierta (reversa de la web).
 *
 * API pública del módulo:
 *  1) buscarEnHackTorrent(titulo, imdbId?) -> resultados
 *  2) extraerDetalleTorrent(slug, tipo) -> magnets + calidad + tamaño + temporada/episodio
 *  3) resolverAcortalink(url) -> magnet / .torrent
 *
 * Reglas importantes (evitan entregar el torrent equivocado):
 *  - La búsqueda NUNCA devuelve resultados que no coincidan con la query
 *    (antes, si el filtro fallaba, devolvía los 5 primeros de la home).
 *  - Los datos MOCK sólo se activan con HACKTORRENT_MOCK=1 (tests/sandbox).
 *    En producción es mejor devolver vacío que una película falsa.
 *  - Cada download se asocia a su temporada/episodio real, tomándolo de la API,
 *    de la tabla HTML o del propio nombre del torrent (`dn`).
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { parseSeasonEpisode, similarity } = require('./match');

const BASE_URL = 'https://hacktorrent.cc';
const MOCK_ENABLED = /^(1|true|yes|si|sí)$/i.test(String(process.env.HACKTORRENT_MOCK || ''));

// ------------------- CACHÉ EN MEMORIA -------------------
// Evita golpear el sitio una vez por episodio (Stremio pide S01E01..S01E10 seguido).
const CACHE = new Map();
const CACHE_MAX_ENTRIES = 400;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  if (CACHE.size >= CACHE_MAX_ENTRIES) {
    // Borrar la entrada más vieja (Map conserva orden de inserción)
    const oldest = CACHE.keys().next();
    if (!oldest.done) CACHE.delete(oldest.value);
  }
  CACHE.set(key, { value, exp: Date.now() + ttlMs });
}

// ------------------- CONFIG AXIOS CON HEADERS -------------------
const JSON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Referer': `${BASE_URL}/`,
  // Importante para evitar bloqueos de Cloudflare/WAF
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const HTML_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Referer': `${BASE_URL}/`,
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate'
};

const AXIOS_JSON_CONFIG = {
  timeout: 15000,
  headers: JSON_HEADERS,
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400
};

const AXIOS_HTML_CONFIG = {
  timeout: 15000,
  headers: HTML_HEADERS,
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400
};

// ------------------- UTILIDADES -------------------
function normalizeText(str) {
  if (!str) return '';
  return String(str).trim().replace(/\s+/g, ' ');
}

function absolutizeUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `${BASE_URL}${pathOrUrl}`;
  return `${BASE_URL}/${pathOrUrl}`;
}

/** Extrae tamaño legible a bytes si hace falta, y detecta calidad */
function parseCalidad(str) {
  if (!str) return 'Desconocido';
  const upper = String(str).toUpperCase();
  if (upper.includes('4K') || upper.includes('2160') || upper.includes('UHD')) return '4K';
  if (upper.includes('1080')) return '1080p';
  if (upper.includes('720')) return '720p';
  if (upper.includes('480')) return '480p';
  if (upper.includes('DVDRIP')) return 'DVDRip';
  if (upper.includes('CAM')) return 'CAMRip';
  return normalizeText(str);
}

/** Normaliza el tipo que devuelve el sitio a pelicula | serie | anime */
function mapTipo(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (['pelicula', 'peliculas', 'movie', 'movies', 'film', 'films'].includes(t)) return 'pelicula';
  if (['serie', 'series', 'tv', 'show', 'shows'].includes(t)) return 'serie';
  if (['anime', 'animes', 'anime-serie'].includes(t)) return 'anime';
  return null;
}

function tipoToEndpoint(tipo) {
  if (tipo === 'pelicula') return 'movie';
  if (tipo === 'anime') return 'anime';
  return 'serie';
}

function endpointToTipo(endpoint) {
  if (endpoint === 'movie') return 'pelicula';
  if (endpoint === 'anime') return 'anime';
  return 'serie';
}

function extractInfoHash(magnet) {
  if (!magnet || typeof magnet !== 'string') return null;
  const m = magnet.match(/btih:([a-fA-F0-9]{32,40})/);
  return m ? m[1].toLowerCase() : null;
}

function extractDn(magnet) {
  if (!magnet || typeof magnet !== 'string') return null;
  const m = magnet.match(/[?&]dn=([^&]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

/** Deduplica torrents por infoHash/magnet/url y, si falta, por calidad+episodio. */
function dedupeTorrents(torrents) {
  const seen = new Set();
  const out = [];
  for (const t of torrents) {
    const key = (t.infoHash || t.magnet || t.torrentUrl || t.acortarUrl || '') +
      `|${t.calidad || ''}|${t.temporada ?? ''}|${t.episodio ?? ''}`;
    if (t.infoHash && seen.has(t.infoHash)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.infoHash) seen.add(t.infoHash);
    out.push(t);
  }
  return out;
}

// ------------------- 1) FUNCIÓN DE BÚSQUEDA -------------------
/**
 * Busca en HackTorrent por título (o IMDb ID como último recurso).
 *
 * @param {string} titulo - Ej: "Avengers", "El Proyecto Colibrí", "Breaking Bad"
 * @param {string} [imdbId] - Opcional: "tt0848228"
 * @returns {Promise<Array<{titulo, tituloOriginal, slug, url, tipo, año, poster, descripcion}>>}
 */
async function buscarEnHackTorrent(titulo, imdbId = null) {
  if (!titulo && !imdbId) {
    console.warn('[Scraper] buscarEnHackTorrent(): se requiere titulo o imdbId');
    return [];
  }

  const query = normalizeText(titulo) || normalizeText(imdbId);
  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  console.log(`[Scraper] 🔍 Buscando en HackTorrent: "${query}"${imdbId ? ` (IMDb: ${imdbId})` : ''}`);

  // ---- A) API wpreact (principal) ----
  try {
    const url = `${BASE_URL}/wp-json/wpreact/v1/search?query=${encodeURIComponent(query)}`;
    const res = await axios.get(url, AXIOS_JSON_CONFIG);
    const raw = res.data?.results || res.data?.data || res.data;
    const arr = Array.isArray(raw) ? raw : [];

    if (arr.length > 0) {
      const mapped = arr.map(item => {
        const tipo = mapTipo(item.type || item.tipo);
        return {
          titulo: item.title || item.titulo || item.name,
          tituloOriginal: item.original_title || item.originalTitle || item.title || item.titulo || '',
          slug: item.slug,
          url: absolutizeUrl(`/${tipoToEndpoint(tipo || 'pelicula')}/${item.slug}/`),
          urlFinal: absolutizeUrl(`/${tipoToEndpoint(tipo || 'pelicula')}/${item.slug}/`),
          año: item.year || item.año || (item.years ? String(item.years).slice(0, 4) : null),
          tipo: tipo || 'pelicula',
          tmdbId: item.tmdb_id || null,
          poster: item.featured
            ? (String(item.featured).startsWith('/') ? `https://image.tmdb.org/t/p/w300${item.featured}` : item.featured)
            : (item.image || null),
          background: item.background_image
            ? (String(item.background_image).startsWith('/') ? `https://image.tmdb.org/t/p/original${item.background_image}` : item.background_image)
            : null,
          descripcion: item.overview || '',
          _origen: 'wpreact'
        };
      }).filter(r => r.slug);

      console.log(`[Scraper] ✅ wpreact devolvió ${mapped.length} resultados`);
      cacheSet(cacheKey, mapped, 10 * 60 * 1000);
      return mapped;
    }
    console.log('[Scraper] wpreact sin resultados, probando fallback react...');
  } catch (err) {
    console.error(`[Scraper] ❌ Error wpreact search "${query}":`, err.message);
  }

  // ---- B) Fallback API react ----
  try {
    const urlReact = `${BASE_URL}/wp-json/react/v1/search?q=${encodeURIComponent(query)}`;
    const resReact = await axios.get(urlReact, AXIOS_JSON_CONFIG);
    const dataReact = resReact.data?.data || resReact.data;
    const arrReact = Array.isArray(dataReact) ? dataReact : [];

    if (arrReact.length > 0) {
      const mappedReact = arrReact.map(item => {
        const slug = String(item.link || item.slug || '')
          .replace(/^https?:\/\/[^/]+/i, '')
          .replace(/^\/(pelicula|serie|anime)\//, '')
          .replace(/\//g, '');
        const linkTipo = /\/pelicula\//.test(item.link || '') ? 'pelicula'
          : /\/anime\//.test(item.link || '') ? 'anime'
          : /\/serie\//.test(item.link || '') ? 'serie'
          : null;
        const tipo = mapTipo(item.type) || linkTipo || 'pelicula';
        return {
          titulo: item.title || item.titulo || item.name,
          tituloOriginal: item.original_title || item.title || '',
          slug,
          url: absolutizeUrl(item.link || `/${tipoToEndpoint(tipo)}/${slug}/`),
          urlFinal: absolutizeUrl(item.link || `/${tipoToEndpoint(tipo)}/${slug}/`),
          año: item.year || item.año || null,
          tipo,
          imdbRating: item.imdb || null,
          poster: item.image
            ? (String(item.image).startsWith('/') ? `https://image.tmdb.org/t/p/w300${item.image}` : item.image)
            : null,
          background: item.backdrop
            ? (String(item.backdrop).startsWith('/') ? `https://image.tmdb.org/t/p/original${item.backdrop}` : item.backdrop)
            : null,
          descripcion: item.overview || '',
          _origen: 'react'
        };
      }).filter(r => r.slug);

      if (mappedReact.length > 0) {
        console.log(`[Scraper] ✅ react devolvió ${mappedReact.length} resultados`);
        cacheSet(cacheKey, mappedReact, 10 * 60 * 1000);
        return mappedReact;
      }
    }
    console.log('[Scraper] react sin resultados, probando scraping HTML...');
  } catch (err) {
    console.error(`[Scraper] ❌ Error react search "${query}":`, err.message);
  }

  // ---- C) Fallback scraping HTML con Cheerio ----
  try {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const resHtml = await axios.get(searchUrl, AXIOS_HTML_CONFIG);
    const $ = cheerio.load(resHtml.data);

    const resultados = [];
    const seen = new Set();

    $('a[href*="/pelicula/"], a[href*="/serie/"], a[href*="/anime/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (/\/(category|director|actors|tag|genero)\//.test(href)) return;

      const slugMatch = href.match(/\/(pelicula|serie|anime)\/([^/?#]+)\/?/);
      if (!slugMatch) return;

      const tipo = mapTipo(slugMatch[1]) || 'pelicula';
      const slug = slugMatch[2];
      if (seen.has(slug)) return;
      seen.add(slug);

      let tituloExtraido = $(el).attr('title') || $(el).find('img').attr('alt') || normalizeText($(el).text());
      if (!tituloExtraido || tituloExtraido.length < 2) {
        const parent = $(el).parent();
        tituloExtraido = parent.find('h3, h2, .title').first().text() || '';
        if (!tituloExtraido) {
          const next = $(el).closest('div').next().find('a').first().text();
          tituloExtraido = next || slug.replace(/-/g, ' ');
        }
      }
      tituloExtraido = normalizeText(tituloExtraido) || slug.replace(/-/g, ' ');

      const img = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null;
      const yearText = normalizeText($(el).closest('div, article, li').text()).match(/\b(19|20)\d{2}\b/);

      resultados.push({
        titulo: tituloExtraido,
        tituloOriginal: tituloExtraido,
        slug,
        url: absolutizeUrl(href),
        urlFinal: absolutizeUrl(href),
        año: yearText ? yearText[0] : null,
        tipo,
        poster: img,
        descripcion: '',
        _origen: 'html'
      });
    });

    // Filtro ESTRICTO: si el sitio ignoró el parámetro ?s= y devolvió la home,
    // NO devolvemos resultados ajenos (eso era la causa de "me da otra película").
    const queryNorm = String(query).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const queryTokens = queryNorm.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const filtrados = resultados.filter(r => {
      const t = String(r.titulo).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const s = String(r.slug).toLowerCase().replace(/-/g, ' ');
      if (t.includes(queryNorm) || s.includes(queryNorm.replace(/\s+/g, ' '))) return true;
      if (queryTokens.length === 0) return false;
      const matched = queryTokens.filter(tok => t.includes(tok) || s.includes(tok)).length;
      return matched / queryTokens.length >= 0.6;
    });

    const finales = filtrados.slice(0, 10);
    if (finales.length > 0) {
      console.log(`[Scraper] ✅ HTML scraping devolvió ${finales.length} resultados relevantes`);
      cacheSet(cacheKey, finales, 10 * 60 * 1000);
      return finales;
    }

    console.log(`[Scraper] HTML scraping sin resultados relevantes para "${query}"`);
    cacheSet(cacheKey, [], 5 * 60 * 1000);
    return [];
  } catch (err) {
    console.error(`[Scraper] ❌ Error HTML search "${query}":`, err.message);
  }

  // ---- MOCK (sólo con HACKTORRENT_MOCK=1, para tests/sandbox) ----
  if (MOCK_ENABLED) {
    const mocks = buscarEnMocks(query);
    if (mocks.length > 0) {
      console.log(`[Scraper] 🧪 MOCK: ${mocks.length} resultados para "${query}"`);
      return mocks;
    }
  }

  cacheSet(cacheKey, [], 2 * 60 * 1000);
  return [];
}

// ------------------- 2) DETALLE (MAGNET + CALIDAD + TAMAÑO + TEMPORADA/EPISODIO) -------------------
/**
 * Entra a la página/API de detalle del torrent y extrae magnets.
 *
 * @param {string} slugOrUrl - "el-proyecto-colibri" o URL completa
 * @param {string} [tipo] - "pelicula" | "serie" | "anime" | "auto"
 * @returns {Promise<{titulo, slug, url, tipo, año, descripcion, poster, torrents: Array}>}
 */
async function extraerDetalleTorrent(slugOrUrl, tipo = 'auto') {
  if (!slugOrUrl) throw new Error('extraerDetalleTorrent(): slugOrUrl es requerido');

  const { slug, tipoSolicitado } = normalizarSlugYTipo(slugOrUrl, tipo);
  const cacheKey = `detail:${tipoSolicitado}:${slug}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const endpoints = endpointsParaTipo(tipoSolicitado);
  console.log(`[Scraper] 📄 Detalle slug="${slug}" tipo="${tipoSolicitado}" endpoints=[${endpoints.join(', ')}]`);

  // ---- 1) API wpreact ----
  for (const endpoint of endpoints) {
    try {
      const apiUrl = `${BASE_URL}/wp-json/wpreact/v1/${endpoint}/${encodeURIComponent(slug)}`;
      const res = await axios.get(apiUrl, AXIOS_JSON_CONFIG);
      const data = res.data;
      if (!data || typeof data !== 'object') continue;
      const dataSlug = data.slug || slug;

      const torrents = collectDownloads(data, endpoint);
      if (torrents.length > 0) {
        // La API puede devolver magnets directos o acortalinks: resolvemos estos últimos
        const finales = torrents.some(t => t._needsResolve)
          ? await resolverTorrents(torrents)
          : torrents;
        if (finales.length > 0) {
          const detalle = buildDetalle(data, dataSlug, endpoint, finales);
          console.log(`[Scraper] ✅ Detalle wpreact (${endpoint}/${slug}): ${finales.length} torrents`);
          cacheSet(cacheKey, detalle, 30 * 60 * 1000);
          return detalle;
        }
        console.log(`[Scraper] ⚠️ wpreact (${endpoint}/${slug}): downloads no resolubles`);
      }
      console.log(`[Scraper] ⚠️ wpreact (${endpoint}/${slug}) sin downloads utilizables`);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        console.log(`[Scraper] ℹ️ wpreact (${endpoint}/${slug}) → 404, probando siguiente tipo`);
      } else {
        console.error(`[Scraper] ❌ Error wpreact detalle ${endpoint}/${slug}:`, err.message);
      }
    }
  }

  // ---- 2) Fallback: scraping HTML de la tabla de torrents ----
  for (const tipoCand of endpoints.map(endpointToTipo)) {
    try {
      const detailUrl = `${BASE_URL}/${tipoToEndpoint(tipoCand)}/${encodeURIComponent(slug)}/`;
      console.log(`[Scraper] 🌐 Fallback HTML: ${detailUrl}`);
      const resHtml = await axios.get(detailUrl, {
        ...AXIOS_HTML_CONFIG,
        validateStatus: (s) => s >= 200 && s < 500
      });
      if (resHtml.status !== 200 || typeof resHtml.data !== 'string') {
        console.log(`[Scraper] ℹ️ HTML ${detailUrl} → HTTP ${resHtml.status}`);
        continue;
      }

      const parsed = parseHtmlDetail(resHtml.data, { slug, tipo: tipoCand, url: detailUrl });
      if (parsed.torrents.length === 0) {
        console.log(`[Scraper] ⚠️ HTML ${detailUrl} sin torrents`);
        continue;
      }

      const torrents = await resolverTorrents(parsed.torrents);
      if (torrents.length === 0) {
        console.log(`[Scraper] ⚠️ HTML ${detailUrl}: magnets no resolubles`);
        continue;
      }

      const detalle = {
        titulo: parsed.titulo,
        slug,
        url: detailUrl,
        tipo: tipoCand,
        año: parsed.año,
        descripcion: parsed.descripcion,
        poster: parsed.poster,
        torrents
      };
      console.log(`[Scraper] ✅ HTML ${slug}: ${torrents.length}/${parsed.torrents.length} torrents resueltos`);
      cacheSet(cacheKey, detalle, 30 * 60 * 1000);
      return detalle;
    } catch (err) {
      console.error(`[Scraper] ❌ Error HTML detalle ${slug}:`, err.message);
    }
  }

  // ---- 3) MOCK (sólo si se habilita explícitamente) ----
  if (MOCK_ENABLED) {
    const mock = MOCK_DETALLES[slug];
    if (mock) {
      console.log(`[Scraper] 🧪 MOCK detalle para ${slug}`);
      return mock;
    }
  }

  // Nada encontrado: devolvemos un detalle vacío (nunca contenido ajeno).
  const vacio = {
    titulo: slug.replace(/-/g, ' '),
    slug,
    url: absolutizeUrl(`/${tipoToEndpoint(tipoSolicitado === 'auto' ? 'serie' : tipoSolicitado)}/${slug}/`),
    tipo: tipoSolicitado === 'auto' ? 'serie' : tipoSolicitado,
    torrents: []
  };
  cacheSet(cacheKey, vacio, 2 * 60 * 1000);
  return vacio;
}

/** Normaliza entrada (slug o URL) y decide tipos a probar. */
function normalizarSlugYTipo(slugOrUrl, tipo) {
  let slug = String(slugOrUrl).trim();
  let tipoSolicitado = mapTipo(tipo) || 'auto';

  if (/^https?:\/\//i.test(slug)) {
    try {
      const u = new URL(slug);
      const m = u.pathname.match(/\/(pelicula|serie|anime)\/([^/?#]+)\/?/);
      if (m) {
        tipoSolicitado = mapTipo(m[1]) || tipoSolicitado;
        slug = m[2];
      } else {
        const parts = u.pathname.split('/').filter(Boolean);
        slug = parts.pop() || slug;
      }
    } catch { /* no es URL válida: se trata como slug */ }
  }

  slug = slug.split('?')[0].split('#')[0].replace(/\/+$/, '');
  // Si el slug trae prefijo de tipo ("serie/foo"), limpiarlo
  const pref = slug.match(/^(pelicula|serie|anime)\/(.+)$/i);
  if (pref) {
    tipoSolicitado = mapTipo(pref[1]) || tipoSolicitado;
    slug = pref[2];
  }
  if (tipoSolicitado === 'auto') {
    if (/\/anime\//.test(String(slugOrUrl))) tipoSolicitado = 'anime';
    else if (/\/serie\//.test(String(slugOrUrl))) tipoSolicitado = 'serie';
    else tipoSolicitado = 'auto';
  }
  return { slug, tipoSolicitado };
}

function endpointsParaTipo(tipo) {
  switch (tipo) {
    case 'pelicula': return ['movie'];
    case 'serie': return ['serie', 'anime'];
    case 'anime': return ['anime', 'serie'];
    default: return ['movie', 'serie', 'anime'];
  }
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

const DOWNLOAD_KEYS = /download|episode|episod|season|temporada|capitulo|cap[ií]tulo|link|file|torrent|source|media|players?|options?|items?|data|quality|calidad|^\d+$|\d{3,4}p$/i;

function looksLikeLink(value) {
  return typeof value === 'string' && (/^magnet:/i.test(value) || /\.torrent(\?|$)/i.test(value) || /acortalink\./i.test(value) || /^https?:\/\//i.test(value));
}

/** Sólo magnet, .torrent o acortalink (descarta páginas web normales) */
function isTorrentish(value) {
  return typeof value === 'string' && (/^magnet:/i.test(value) || /\.torrent(\?|$)/i.test(value) || /acortalink\./i.test(value));
}

/**
 * Recorre la respuesta de la API (forma variable según el tipo de contenido) y
 * extrae todos los downloads con su temporada/episodio.
 */
function collectDownloads(root, endpoint) {
  const found = [];

  const pushDownload = (node, ctx) => {
    const rawLink = node.download_link || node.downloadLink || node.magnet || node.magnet_link ||
      node.torrent || node.torrent_url || node.url_download || node.download_url ||
      (looksLikeLink(node.download) ? node.download : null) ||
      (looksLikeLink(node.link) ? node.link : null) ||
      (isTorrentish(node.url) ? node.url : null) ||
      (isTorrentish(node.href) ? node.href : null);
    const link = typeof rawLink === 'string' ? rawLink : (rawLink?.url || rawLink?.href || null);
    if (!link) return;

    const nombre = node.name || node.file_name || node.filename || node.title || '';
    const parsedName = parseSeasonEpisode([nombre, extractDn(link) || ''].join(' '));
    const season = toInt(node.season ?? node.season_number ?? node.temporada ?? node.number_season) ?? ctx.season ?? parsedName.season;
    const episode = toInt(node.episode ?? node.episode_number ?? node.episodio ?? node.number_episode ?? node.ep) ?? ctx.episode ?? parsedName.episode;
    const calidad = node.quality || node.calidad || node.format || node.formato || ctx.calidad || 'Desconocida';
    const tamaño = node.size || node.tamaño || node.tamano || node.filesize || null;
    const idioma = node.language || node.idioma || node.lang || '';
    const subsRaw = node.subs ?? node.subtitles ?? node.subtitulos;
    const subtitulos = (subsRaw === 1 || subsRaw === true || subsRaw === '1' ||
      /^(si|sí|yes|true)$/i.test(String(subsRaw))) ? 'Sí' : 'No';

    const isTorrent = /\.torrent(\?|$)/i.test(link);
    const magnet = /^magnet:/i.test(link) ? link : null;

    found.push({
      calidad: normalizeText(calidad) || 'Desconocida',
      calidadNormalizada: parseCalidad(calidad),
      tamaño: normalizeText(tamaño),
      idioma: normalizeText(idioma),
      subtitulos,
      fecha: node.date || node.fecha || null,
      magnet,
      torrentUrl: !magnet && isTorrent ? link : null,
      acortarUrl: !magnet && !isTorrent ? link : null,
      infoHash: extractInfoHash(magnet || ''),
      dn: extractDn(magnet || '') || normalizeText(nombre) || null,
      temporada: season,
      episodio: episode,
      _origen: `wpreact-${endpoint}`,
      _needsResolve: !magnet && !isTorrent
    });
  };

  const visit = (node, ctx, depth) => {
    if (!node || depth > 10) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, ctx, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    // ¿Este objeto es un download?
    if (node.quality || node.calidad || node.download_link || node.downloadLink ||
        node.magnet || node.torrent || isTorrentish(node.url) || isTorrentish(node.href)) {
      pushDownload(node, ctx);
    }

    // Contexto de temporada/episodio que baja a los hijos
    const nameParsed = parseSeasonEpisode(node.name || node.title || node.episode_title || '');
    const childCtx = {
      season: toInt(node.season ?? node.season_number ?? node.temporada ?? node.number_season) ?? nameParsed.season ?? ctx.season,
      episode: toInt(node.episode ?? node.episode_number ?? node.numero_episodio) ?? ctx.episode,
      calidad: node.quality || node.calidad || ctx.calidad
    };

    for (const key of Object.keys(node)) {
      if (!DOWNLOAD_KEYS.test(key)) continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value, childCtx, depth + 1);
      else if (looksLikeLink(value) && /magnet|torrent|download|link|quality|\d{3,4}p/i.test(key)) {
        visit({
          download_link: value,
          quality: /^\d{3,4}p$/i.test(key) ? key : undefined
        }, childCtx, depth + 1);
      }
    }
  };

  visit(root, { season: null, episode: null }, 0);
  return dedupeTorrents(found);
}

function buildDetalle(data, slug, endpoint, torrents) {
  const tipo = mapTipo(data.type) || endpointToTipo(endpoint);
  return {
    titulo: data.title || data.titulo || data.name || slug.replace(/-/g, ' '),
    tituloOriginal: data.original_title || data.originalTitle || null,
    slug: data.slug || slug,
    url: `${BASE_URL}/${tipoToEndpoint(tipo)}/${slug}/`,
    tipo,
    año: data.year || data.año || data.years || null,
    descripcion: data.overview || data.description || '',
    poster: data.featured
      ? (String(data.featured).startsWith('/') ? `https://image.tmdb.org/t/p/w300${data.featured}` : data.featured)
      : (data.image || null),
    background: data.background_image
      ? (String(data.background_image).startsWith('/') ? `https://image.tmdb.org/t/p/original${data.background_image}` : data.background_image)
      : null,
    torrents: torrents.sort(ordenarTorrents)
  };
}

function ordenarTorrents(a, b) {
  const sa = a.temporada ?? 0, sb = b.temporada ?? 0;
  if (sa !== sb) return sa - sb;
  const ea = a.episodio ?? 0, eb = b.episodio ?? 0;
  return ea - eb;
}

/**
 * Parseo HTML del detalle. Usa la cabecera real de cada tabla (en películas y
 * series el orden de columnas es distinto) y detecta la temporada por el
 * encabezado o el contenedor de la tabla.
 */
function parseHtmlDetail(html, { slug, tipo, url }) {
  const $ = cheerio.load(html);

  const tituloPagina = normalizeText($('h1').first().text()) ||
    normalizeText(($('meta[property="og:title"]').attr('content') || '').split('|')[0]) ||
    normalizeText($('title').text().split(' - ')[0]) ||
    slug.replace(/-/g, ' ');

  const poster = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || null;
  const añoMeta = ($('meta[property="og:title"]').attr('content') || '') + ' ' + tituloPagina;
  const añoMatch = añoMeta.match(/\b(19|20)\d{2}\b/);

  const torrents = [];
  let temporadaActual = 1;
  let tabDetectada = 1;

  const temporadaDesdeContenedor = ($el) => {
    let encontrada = null;
    $el.parents().each((i, parent) => {
      if (encontrada) return;
      const el = $(parent);
      const idClass = `${el.attr('id') || ''} ${el.attr('class') || ''} ${el.attr('data-season') || ''}`;
      const m = idClass.match(/(?:^|[^a-z0-9])(?:temporada|season|temp|t)[-_ ]?(\d{1,2})(?![0-9])/i);
      if (m) encontrada = parseInt(m[1], 10);
    });
    return encontrada;
  };

  // Recorrido en orden de documento: encabezados de temporada + tablas
  $('h1, h2, h3, h4, h5, table').each((i, el) => {
    const $el = $(el);
    const tag = (el.tagName || '').toLowerCase();

    if (tag !== 'table') {
      const txt = normalizeText($el.text());
      const m = txt.match(/temporada\s*(\d{1,2})/i) || txt.match(/season\s*(\d{1,2})/i) ||
        txt.match(/^(?:temp|t)\s*(\d{1,2})$/i);
      if (m) temporadaActual = parseInt(m[1], 10);
      return;
    }

    // Es una tabla: ¿tabla de descargas?
    const headerCells = $el.find('thead th').toArray().map(th => normalizeText($(th).text()).toLowerCase());
    const headerTxt = headerCells.join(' ') || normalizeText($el.find('th').text()).toLowerCase();
    if (!headerTxt.includes('formato') && !headerTxt.includes('tamaño') && !headerTxt.includes('tamano')) return;

    const idx = {
      numero: findHeader(headerCells, ['#', 'nº', 'no', 'numero', 'ep', 'episodio']),
      formato: findHeader(headerCells, ['formato', 'calidad', 'quality']),
      tamaño: findHeader(headerCells, ['tamaño', 'tamano', 'size', 'peso']),
      subtitulos: findHeader(headerCells, ['subtitulo', 'subtítulos', 'subs']),
      idioma: findHeader(headerCells, ['idioma', 'language', 'audio']),
      fecha: findHeader(headerCells, ['fecha', 'date', 'agregado'])
    };

    // Temporada: contenedor > encabezado previo > contador
    let temporadaTabla = temporadaDesdeContenedor($el);
    if (temporadaTabla === null) {
      const prevHeading = $el.prevAll('h1, h2, h3, h4, h5').first().text();
      const mPrev = normalizeText(prevHeading).match(/(?:temporada|season)\s*(\d{1,2})/i);
      if (mPrev) temporadaTabla = parseInt(mPrev[1], 10);
    }
    if (temporadaTabla === null) {
      // A veces la temporada está en el selector de tabs (aria-controls/id) de la tabla
      const tabId = `${$el.attr('id') || ''} ${$el.attr('class') || ''} ${$el.attr('data-tab') || ''}`;
      const mTab = tabId.match(/(?:^|[^a-z0-9])(?:temporada|season|temp)[-_ ]?(\d{1,2})(?![0-9])/i);
      if (mTab) temporadaTabla = parseInt(mTab[1], 10);
    }
    if (temporadaTabla === null) temporadaTabla = temporadaActual;

    const filasTabla = [];
    $el.find('tbody tr').each((ri, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      if (cells.length < 3) return;

      const texto = normalizeText($row.text());
      const cellText = (i2) => (i2 === null || i2 === undefined || i2 < 0 || i2 >= cells.length)
        ? '' : normalizeText($(cells[i2]).text());

      // Enlaces del torrent (magnet directo > acortalink > .torrent)
      let magnetDirecto = null, acortarUrl = null, torrentUrl = null;
      $row.find('a[href]').each((ai, a) => {
        const href = $(a).attr('href') || '';
        if (/^magnet:/i.test(href) && !magnetDirecto) magnetDirecto = href;
        else if (/acortalink\./i.test(href) && !acortarUrl) acortarUrl = href;
        else if (/\.torrent(\?|$)/i.test(href) && !torrentUrl) torrentUrl = href;
      });
      if (!acortarUrl) {
        const mm = (($row.html() || '').match(/https?:\/\/acortalink\.[^"'<> ]+/i) ||
          ($row.html() || '').match(/https?:\/\/[^"'<> ]+\.torrent/i));
        if (mm) acortarUrl = mm[0].replace(/&amp;/g, '&');
      }

      let calidad = cellText(idx.formato);
      let tamaño = cellText(idx.tamaño);
      let idioma = cellText(idx.idioma);
      let subtitulos = cellText(idx.subtitulos);
      let fecha = cellText(idx.fecha);
      let episodio = toInt(cellText(idx.numero));

      // Sin cabeceras reconocibles: heurística por número de columnas
      //  película: Formato | Idioma | Fecha | Tamaño | Subs | Descargar
      //  serie:    # | Formato | Tamaño | Subs | Idioma | Fecha | Acciones
      if (idx.formato === null && idx.idioma === null) {
        if (cells.length === 6) {
          calidad = cellText(0); idioma = cellText(1); fecha = cellText(2);
          tamaño = cellText(3); subtitulos = cellText(4);
        } else if (cells.length >= 7) {
          episodio = toInt(cellText(0)); calidad = cellText(1); tamaño = cellText(2);
          subtitulos = cellText(3); idioma = cellText(4); fecha = cellText(5);
        }
      }

      if (!magnetDirecto && !acortarUrl && !torrentUrl) return;
      if (!calidad) calidad = 'Desconocida';

      // Episodio: celda "#" > nombre del magnet > texto de la fila
      let parsed = parseSeasonEpisode([magnetDirecto || acortarUrl || torrentUrl || '', texto].join(' '));
      if (episodio === null) episodio = parsed.episode;
      let temporadaFila = toInt(parsed.season);
      if (temporadaFila === null) temporadaFila = temporadaTabla;

      filasTabla.push({
        calidad,
        calidadNormalizada: parseCalidad(calidad),
        tamaño,
        idioma,
        subtitulos,
        fecha,
        magnet: magnetDirecto,
        torrentUrl: torrentUrl || null,
        acortarUrl: acortarUrl || null,
        infoHash: extractInfoHash(magnetDirecto || ''),
        temporada: tipo === 'pelicula' ? null : temporadaFila,
        episodio: tipo === 'pelicula' ? null : episodio,
        _origen: 'html',
        _needsResolve: !magnetDirecto && !torrentUrl
      });
    });

    // Una única fila sin número de episodio = pack de temporada
    if (tipo !== 'pelicula' && filasTabla.length === 1 && filasTabla[0].episodio === null) {
      filasTabla[0].esPack = true;
    }
    torrents.push(...filasTabla);

    if (tipo !== 'pelicula') temporadaActual = temporadaTabla;
    tabDetectada = temporadaActual;
  });

  // Si no hay tablas con cabecera, buscar magnets/acortalinks sueltos
  if (torrents.length === 0) {
    $('a[href*="acortalink"], a[href*=".torrent"], a[href^="magnet:"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const row = $(el).closest('tr');
      const cells = row.find('td');
      let calidad = 'Desconocida', tamaño = '', episodio = null;
      if (cells.length >= 2) {
        const parsed = parseSeasonEpisode(normalizeText(row.text()));
        episodio = parsed.episode;
        const map = cells.toArray().map(c => normalizeText($(c).text()));
        calidad = map.find(t => /(1080|720|480|4k|2160|dvdrip|cam)/i.test(t)) || 'Desconocida';
        tamaño = map.find(t => /\d+(\.\d+)?\s*(GB|MB)/i.test(t)) || '';
      }
      torrents.push({
        calidad,
        calidadNormalizada: parseCalidad(calidad),
        tamaño,
        idioma: '',
        subtitulos: '',
        fecha: '',
        magnet: /^magnet:/i.test(href) ? href : null,
        torrentUrl: /\.torrent/i.test(href) ? href : null,
        acortarUrl: /acortalink/i.test(href) ? href : null,
        infoHash: extractInfoHash(href),
        temporada: tipo === 'pelicula' ? null : (episodio ? 1 : null),
        episodio,
        _origen: 'html-fallback',
        _needsResolve: /acortalink/i.test(href)
      });
    });
  }

  return {
    titulo: tituloPagina,
    año: añoMatch ? añoMatch[0] : null,
    descripcion: normalizeText($('meta[name="description"]').attr('content') || ''),
    poster,
    torrents,
    _temporadaDetectada: tabDetectada
  };
}

function findHeader(headers, needles) {
  for (let i = 0; i < headers.length; i++) {
    if (needles.some(n => headers[i] === n || headers[i].includes(n))) return i;
  }
  return null;
}

/** Resuelve los acortalinks de forma controlada (concurrencia 4). */
async function resolverTorrents(torrents) {
  const salida = new Array(torrents.length);
  let cursor = 0;

  async function worker() {
    while (cursor < torrents.length) {
      const i = cursor++;
      const t = torrents[i];
      try {
        if (t.magnet || !t.acortarUrl) {
          salida[i] = { ...t, _needsResolve: false };
          continue;
        }
        const resuelto = await resolverAcortalink(t.acortarUrl);
        if (!resuelto) {
          salida[i] = { ...t, magnet: null, torrentUrl: null, _needsResolve: false, _error: 'no-resuelto' };
        } else if (/^magnet:/i.test(resuelto)) {
          salida[i] = {
            ...t, magnet: resuelto, torrentUrl: null, acortarUrl: t.acortarUrl,
            infoHash: extractInfoHash(resuelto),
            dn: extractDn(resuelto) || t.dn || null,
            _needsResolve: false
          };
        } else if (/\.torrent(\?|$)/i.test(resuelto)) {
          salida[i] = { ...t, magnet: null, torrentUrl: resuelto, _needsResolve: false };
        } else {
          salida[i] = { ...t, magnet: resuelto, _needsResolve: false };
        }
      } catch (err) {
        salida[i] = { ...t, _needsResolve: false, _error: err.message };
      }
    }
  }

  const workers = Array.from({ length: Math.min(4, torrents.length) }, () => worker());
  await Promise.all(workers);
  return salida.filter(t => t && (t.magnet || t.torrentUrl));
}

// ------------------- 3) RESOLVER ACORTALINK -> MAGNET -------------------
/**
 * Resuelve https://acortalink.net/s.php?i=... a su magnet/.torrent real.
 */
async function resolverAcortalink(acortarUrl) {
  if (!acortarUrl) return null;
  if (/^magnet:/i.test(acortarUrl)) return acortarUrl;
  if (/\.torrent(\?|$)/i.test(acortarUrl)) return acortarUrl;

  const cacheKey = `acortalink:${acortarUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const res = await axios.get(acortarUrl, {
      ...AXIOS_HTML_CONFIG,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500
    });

    // 1) Redirect final a magnet
    const finalUrl = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || '';
    if (finalUrl && /^magnet:/i.test(finalUrl)) {
      cacheSet(cacheKey, finalUrl, 6 * 60 * 60 * 1000);
      return finalUrl;
    }
    // 2) Location header
    if (res.headers?.location && /^magnet:/i.test(res.headers.location)) {
      cacheSet(cacheKey, res.headers.location, 6 * 60 * 60 * 1000);
      return res.headers.location;
    }
    // 3) Magnet en el body
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    const hrefMatch = body.match(/href="(magnet:[^"]+)"/i);
    if (hrefMatch) {
      const magnet = hrefMatch[1].replace(/&amp;/g, '&');
      cacheSet(cacheKey, magnet, 6 * 60 * 60 * 1000);
      return magnet;
    }
    const magnetMatch = body.match(/magnet:\?xt=urn:btih:[^"'<>\s]+/i);
    if (magnetMatch) {
      const magnet = magnetMatch[0].replace(/&amp;/g, '&');
      cacheSet(cacheKey, magnet, 6 * 60 * 60 * 1000);
      return magnet;
    }
    // 4) Archivo .torrent
    const torrentMatch = body.match(/https?:\/\/[^"'<>\s]+\.torrent/i);
    if (torrentMatch) {
      cacheSet(cacheKey, torrentMatch[0], 6 * 60 * 60 * 1000);
      return torrentMatch[0];
    }
    // 5) Parámetro i en base64 (simple o doble)
    try {
      const u = new URL(acortarUrl);
      const iParam = u.searchParams.get('i');
      if (iParam) {
        const decoded = Buffer.from(iParam, 'base64').toString('utf-8');
        if (/^magnet:/i.test(decoded) || decoded.includes('btih:')) {
          cacheSet(cacheKey, decoded, 6 * 60 * 60 * 1000);
          return decoded;
        }
        const second = Buffer.from(decoded, 'base64').toString('utf-8');
        if (/^magnet:/i.test(second)) {
          cacheSet(cacheKey, second, 6 * 60 * 60 * 1000);
          return second;
        }
      }
    } catch { /* ignore */ }

    console.warn(`[Scraper] resolverAcortalink no encontró magnet en ${acortarUrl}`);
    cacheSet(cacheKey, null, 5 * 60 * 1000);
    return null;
  } catch (err) {
    console.error(`[Scraper] ❌ resolverAcortalink error ${acortarUrl}:`, err.message);
    return null;
  }
}

// ------------------- MOCKS (sólo con HACKTORRENT_MOCK=1) -------------------
const MOCK_CATALOGO = [
  {
    titulo: 'El Proyecto Colibrí', tituloOriginal: 'The Hummingbird Project', slug: 'el-proyecto-colibri',
    año: '2019', tipo: 'pelicula',
    filas: [
      { calidad: 'WEB-DL 1080p', tamaño: '3.70 GB', idioma: 'Latino', sub: 'Sí', infoHash: 'a7a4b188eb86e5ae3023d64aa75c573dded4a015' },
      { calidad: '720p', tamaño: '1.01 GB', idioma: 'Latino', sub: 'Sí', infoHash: '889dfd64f9722a2067f4dc9f22cde7df33d78d2f' }
    ]
  },
  {
    titulo: 'Avengers: Los Vengadores', tituloOriginal: 'The Avengers', slug: 'avengers-los-vengadores',
    año: '2012', tipo: 'pelicula',
    filas: [
      { calidad: 'WEB-DL 1080p', tamaño: '5.66 GB', idioma: 'Latino', sub: 'Sí', infoHash: '33c328b31bc6b6ab37af2c46ae2c59282ca803ba' }
    ]
  },
  {
    titulo: 'Avengers: Infinity War', tituloOriginal: 'Avengers: Infinity War', slug: 'avengers-infinity-war',
    año: '2018', tipo: 'pelicula',
    filas: [
      { calidad: 'WEB-DL 1080p', tamaño: '4.5 GB', idioma: 'Latino', sub: 'Sí', infoHash: 'abcdef1234567890abcdef1234567890abcdef12' }
    ]
  },
  {
    titulo: 'Breaking Bad', tituloOriginal: 'Breaking Bad', slug: 'breaking-bad',
    año: '2008', tipo: 'serie',
    filas: [
      { calidad: 'WEB-DL 1080p', tamaño: '2.68 GB', idioma: 'Latino/Inglés', sub: 'Sí', infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', temporada: 1, episodio: 1, dn: 'Breaking.Bad.S01E01.1080p-Latino' },
      { calidad: 'WEB-DL 1080p', tamaño: '1.96 GB', idioma: 'Latino/Inglés', sub: 'Sí', infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', temporada: 1, episodio: 2, dn: 'Breaking.Bad.S01E02.1080p-Latino' }
    ]
  },
  {
    titulo: 'From', tituloOriginal: 'FROM', slug: 'from',
    año: '2022', tipo: 'serie',
    filas: [
      { calidad: 'WEB-DL 1080p', tamaño: '2.10 GB', idioma: 'Latino/Inglés', sub: 'Sí', infoHash: 'cccccccccccccccccccccccccccccccccccccccc', temporada: 1, episodio: 1, dn: 'From.S01E01.1080p-Latino' }
    ]
  }
];

function mockToResultado(m) {
  const tipo = m.tipo;
  return {
    titulo: m.titulo,
    tituloOriginal: m.tituloOriginal,
    slug: m.slug,
    url: absolutizeUrl(`/${tipoToEndpoint(tipo)}/${m.slug}/`),
    urlFinal: absolutizeUrl(`/${tipoToEndpoint(tipo)}/${m.slug}/`),
    año: m.año,
    tipo,
    poster: null,
    descripcion: '',
    _origen: 'mock'
  };
}

function buscarEnMocks(query) {
  return MOCK_CATALOGO
    .map(m => ({ m, score: Math.max(similarity(m.titulo, query), similarity(m.tituloOriginal, query)) }))
    .filter(x => x.score >= 0.6)
    .map(x => mockToResultado(x.m));
}

const MOCK_DETALLES = MOCK_CATALOGO.reduce((acc, m) => {
  acc[m.slug] = {
    titulo: m.titulo,
    tituloOriginal: m.tituloOriginal,
    slug: m.slug,
    url: absolutizeUrl(`/${tipoToEndpoint(m.tipo)}/${m.slug}/`),
    tipo: m.tipo,
    año: m.año,
    descripcion: '',
    poster: null,
    torrents: m.filas.map(f => ({
      calidad: f.calidad,
      calidadNormalizada: parseCalidad(f.calidad),
      tamaño: f.tamaño,
      idioma: f.idioma,
      subtitulos: f.sub,
      fecha: null,
      magnet: `magnet:?xt=urn:btih:${f.infoHash}&dn=${encodeURIComponent(f.dn || m.titulo)}&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce`,
      torrentUrl: null,
      infoHash: f.infoHash,
      dn: f.dn || m.titulo,
      temporada: f.temporada ?? null,
      episodio: f.episodio ?? null,
      _origen: 'mock'
    }))
  };
  return acc;
}, {});

// ------------------- EXPORTS -------------------
module.exports = {
  BASE_URL,
  buscarEnHackTorrent,
  extraerDetalleTorrent,
  resolverAcortalink,
  // Aliases para compatibilidad con código previo
  searchHackTorrent: buscarEnHackTorrent,
  getMovieDetail: (slug) => extraerDetalleTorrent(slug, 'pelicula'),
  getSerieDetail: (slug) => extraerDetalleTorrent(slug, 'serie'),
  getAnimeDetail: (slug) => extraerDetalleTorrent(slug, 'anime'),
  scrapeSeriesPage: (slug) => extraerDetalleTorrent(slug, 'serie').then(r => ({
    title: r.titulo,
    torrents: r.torrents.map(t => ({
      season: t.temporada,
      episode: t.episodio,
      quality: t.calidad,
      size: t.tamaño,
      subs: t.subtitulos?.toLowerCase() === 'sí',
      language: t.idioma,
      date: t.fecha,
      acortarUrl: t.magnet || t.torrentUrl || t.acortarUrl
    }))
  })),
  resolveAcortalink: resolverAcortalink,
  // Helpers internos expuestos para tests
  _parseHtmlDetail: parseHtmlDetail,
  _collectDownloads: collectDownloads,
  _normalizarSlugYTipo: normalizarSlugYTipo,
  _limpiarCache: () => CACHE.clear(),
  _AXIOS_JSON_CONFIG: AXIOS_JSON_CONFIG,
  _AXIOS_HTML_CONFIG: AXIOS_HTML_CONFIG
};

// ------------------- DEMO EJECUTABLE -------------------
// node lib/scraper.js "Avengers"
if (require.main === module) {
  (async () => {
    const query = process.argv[2] || 'Avengers';
    console.log(`\n🧪 DEMO Scraper HackTorrent para query: "${query}"\n`);
    const resultados = await buscarEnHackTorrent(query);
    console.log(`\n📋 Resultados (${resultados.length}):`);
    console.log(JSON.stringify(resultados.slice(0, 2), null, 2));

    if (resultados.length > 0) {
      const r = resultados[0];
      console.log(`\n📄 Extrayendo detalle de "${r.slug}" (${r.tipo})...`);
      const detalle = await extraerDetalleTorrent(r.slug, r.tipo);
      console.log(`\nTítulo: ${detalle.titulo} | Torrents: ${detalle.torrents.length}`);
      console.log(JSON.stringify(detalle.torrents.slice(0, 2), null, 2));
    }
  })();
}
