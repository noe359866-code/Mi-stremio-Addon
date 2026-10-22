/**
 * lib/theblackholebay.js
 * ---------------------------------------------------------------------------
 * Tercera fuente (opcional, inglés): The Black Hole Bay.
 *   Docs: https://theblackholebay.lol/api
 *   GET https://theblackholebay.lol/api/search?q=...&category=200
 *
 * Es un buscador DHT que agrega The Pirate Bay, 1337x, YTS + su propio índice
 * local y torrents subidos por usuarios. No requiere autenticación.
 *
 * NOTAS REALES DE LA API (verificadas):
 *  - `category` es numérica: 0=todo, 100=Audio, 200=Vídeo, 300=Apps,
 *    400=Juegos, 500=Adulto, 600=Otros. Pedimos SIEMPRE 200 (vídeo).
 *  - Los resultados traen `category` con subcódigo (207, 208…) y
 *    `_searchRelevance`; no hay `year` ni `season`, así que el filtrado usa el
 *    nombre del release (igual que Knaben, ver lib/release.js).
 *  - La respuesta incluye magnets larguísimos (decenas de trackers): se limita
 *    el tamaño de respuesta para no reventar memoria.
 *  - Su portada avisa "LIVE API UNAVAILABLE - SERVING FROM LOCAL INDEX" cuando
 *    el índice remoto falla: en ese caso devuelve menos resultados (y más
 *    antiguos). Por eso está DESACTIVADA por defecto (`BLACKHOLEBAY_ENABLED=0`)
 *    y su contenido se solapa mucho con Knaben.
 * ---------------------------------------------------------------------------
 */

'use strict';

const axios = require('axios');
const { timeout } = require('./timeouts');
const { normalizeTitle } = require('./match');
const R = require('./release');
const {
  withKeepAlive,
  isTransientNetworkError,
  parseRetryAfterMs,
  lruGet,
  lruSet,
  withSingleFlight
} = require('./http');

const BASE = String(process.env.BLACKHOLEBAY_API || 'https://theblackholebay.lol/api').replace(/\/+$/, '');
const TIMEOUT = timeout(parseInt(process.env.BLACKHOLEBAY_TIMEOUT || '9000', 10), 9000);
// Desactivada por defecto: se solapa con Knaben y su índice puede degradarse.
const ENABLED = /^(1|true|yes|si|sí)$/i.test(String(process.env.BLACKHOLEBAY_ENABLED || '0'));
const LIMIT = Math.max(1, Math.min(50, parseInt(process.env.BLACKHOLEBAY_LIMIT || '10', 10) || 10));
const MAX_CONTENIDO = Math.max(1, parseInt(process.env.BLACKHOLEBAY_MAX_BYTES || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024);
const MIN_INTERVALO_MS = Math.max(0, parseInt(process.env.BLACKHOLEBAY_MIN_INTERVAL_MS || '300', 10) || 0);

const CACHE = new Map();
const IN_FLIGHT = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 200;

function cacheGet(key) {
  const val = lruGet(CACHE, key);
  return val === undefined ? null : val;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  lruSet(CACHE, key, value, ttl, CACHE_MAX);
}

let ultimaConsulta = 0;
let bloqueadoHasta = 0;
let colaRateLimit = Promise.resolve();
const dormir = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function esperarTurno() {
  if (MIN_INTERVALO_MS <= 0) return Promise.resolve();
  const turno = colaRateLimit.then(async () => {
    const espera = MIN_INTERVALO_MS - (Date.now() - ultimaConsulta);
    if (espera > 0) await dormir(espera);
    ultimaConsulta = Date.now();
  });
  colaRateLimit = turno.catch(() => {});
  return turno;
}

/** Categoría numérica de vídeo (200-299). */
function esCategoriaVideo(categoria) {
  const n = Number(categoria);
  // 200 = Vídeo; las subcategorías vistas en la API vienen como 207, 208…
  if (Number.isFinite(n) && n >= 200 && n < 300) return true;
  // Algunas respuestas del índice local devuelven la categoría raíz como string
  return String(categoria) === '200';
}

/** Normaliza un resultado de la API al formato compartido. */
function normalizarHit(item) {
  const size = Number(item.size);
  const rawMagnet = item.magnet && /^magnet:/i.test(item.magnet) ? item.magnet : null;
  const hash = R.extraerInfoHash(item.info_hash || item.infoHash || item.hash) || R.extraerInfoHash(rawMagnet) || null;
  return {
    name: item.name || item.title || '',
    hash,
    magnet: rawMagnet,
    seeders: Number(item.seeders) || 0,
    peers: Number(item.leechers) || 0,
    size: Number.isFinite(size) ? size : null,
    sizeLabel: item.sizeLabel || R.bytesAHumano(size),
    tracker: item.source || null,
    category: item.category,
    fuente: 'Black Hole Bay',
    _raw: item
  };
}

/**
 * Consulta /api/search de The Black Hole Bay con cola atómica.
 * @returns {Promise<Array>} hits normalizados
 */
async function consultar(query) {
  if (Date.now() < bloqueadoHasta) {
    throw Object.assign(new Error('Black Hole Bay en cooldown'), { cooldown: true });
  }

  await esperarTurno();

  const url = `${BASE}/search?q=${encodeURIComponent(query)}&category=200`;
  let res;
  for (let intento = 0; intento < 2; intento++) {
    try {
      res = await axios.get(url, withKeepAlive({
        timeout: TIMEOUT,
        maxContentLength: MAX_CONTENIDO,
        headers: {
          'User-Agent': 'HackTorrent-Stremio-Addon/1.7 (+https://github.com/noe359866-code/Mi-stremio-Addon)',
          'Accept': 'application/json'
        },
        validateStatus: s => s >= 200 && s < 300
      }));
      break;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || status === 503) {
        const retryMs = parseRetryAfterMs(err.response?.headers?.['retry-after'], 60 * 1000);
        bloqueadoHasta = Date.now() + retryMs;
        console.warn(`[BlackHoleBay] ⚠️ Rate limit alcanzado, pausando ${Math.round(retryMs / 1000)}s`);
        err.cooldown = true;
        throw err;
      }
      if (intento === 0 && isTransientNetworkError(err)) {
        await dormir(120);
        continue;
      }
      throw err;
    }
  }

  const resultados = res.data?.results;
  if (!Array.isArray(resultados)) return [];
  return resultados.map(normalizarHit);
}

/**
 * Busca en The Black Hole Bay y devuelve streams de Stremio.
 * @param {object} opciones { title, originalTitle, altTitles, year, type, season, episode, limit, force }
 * @returns {Promise<Array>} streams
 */
async function buscarStreams(opciones = {}) {
  const {
    title,
    originalTitle = null,
    altTitles = [],
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = LIMIT,
    force = false
  } = opciones;

  const envRaw = process.env.BLACKHOLEBAY_ENABLED;
  const desactivadoPorEnv = envRaw !== undefined && /^(0|false|no|off)$/i.test(String(envRaw).trim());
  const activadoPorEnv = envRaw !== undefined && /^(1|true|yes|si|sí)$/i.test(String(envRaw).trim());
  if (desactivadoPorEnv || (!ENABLED && !activadoPorEnv && !force)) return [];

  if (!title) return [];

  const tieneEpisodio = Number.isFinite(season) && Number.isFinite(episode);
  const esSerie = type === 'series' || (type === 'anime' && tieneEpisodio);
  const cacheKey = [
    'tbb', normalizeTitle(title), normalizeTitle(originalTitle || ''),
    year || '', esSerie ? 'serie' : 'movie', season ?? '', episode ?? '', limit
  ].join('|');

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  return withSingleFlight(IN_FLIGHT, cacheKey, async () => {
    const fromCache = cacheGet(cacheKey);
    if (fromCache) return fromCache;

    const conEpisodio = esSerie && tieneEpisodio;
    const sufijoEp = conEpisodio
      ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : '';

    const hits = new Map();
    const agregar = (lista) => {
      for (const hit of lista) {
        if (!hit || !hit.name) continue;
        const clave = hit.hash || hit.magnet;
        if (!clave) continue;
        const previo = hits.get(clave);
        if (!previo || (hit.seeders || 0) > (previo.seeders || 0)) {
          hits.set(clave, hit);
        }
      }
    };

    const aceptarHit = (hit) => esCategoriaVideo(hit.category) && R.esReleaseVideo(hit.name);
    const filterOpts = {
      title, originalTitle, altTitles, year, type, season, episode, limit,
      aceptarCategoria: aceptarHit
    };

    try {
      agregar(await consultar(`${title}${sufijoEp}`));
      // Packs de temporada / resultados sin SxxExx
      if (sufijoEp) {
        const parcial = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
        if (parcial.aceptados.length === 0) agregar(await consultar(title));
      }
    } catch (err) {
      console.error(`[BlackHoleBay] ❌ Error buscando "${title}${sufijoEp}":`, err.message);
    }

    let evaluacion = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);

    // Ronda 2 con título original o altTitle cuando el título localizado no devolvió nada
    const candidatosAlt = [originalTitle, ...(Array.isArray(altTitles) ? altTitles : [])]
      .filter(t => t && normalizeTitle(t) !== normalizeTitle(title));

    for (const alt of candidatosAlt.slice(0, 2)) {
      if (evaluacion.aceptados.length > 0) break;
      try {
        agregar(await consultar(`${alt}${sufijoEp}`));
        evaluacion = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
        if (sufijoEp && evaluacion.aceptados.length === 0) {
          agregar(await consultar(alt));
          evaluacion = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
        }
      } catch (err) {
        console.error(`[BlackHoleBay] ❌ Error buscando "${alt}${sufijoEp}":`, err.message);
        if (err.cooldown) break;
      }
    }

    const { aceptados, total } = evaluacion;
    const streams = aceptados.map(aceptado =>
      R.formatearStream(aceptado, { nombreFuente: 'Black Hole Bay', claveFuente: 'tbb' })
    );

    console.log(`[BlackHoleBay] ✅ ${streams.length}/${total} resultados válidos para "${title}${sufijoEp}"`);
    cacheSet(cacheKey, streams, streams.length > 0 ? CACHE_TTL : CACHE_TTL_EMPTY);
    return streams;
  });
}

module.exports = {
  BLACKHOLEBAY_ENABLED: ENABLED,
  BLACKHOLEBAY_API: BASE,
  buscarStreams,
  // helpers para tests
  _esCategoriaVideo: esCategoriaVideo,
  _normalizarHit: normalizarHit,
  _limpiarCache: () => {
    CACHE.clear();
    IN_FLIGHT.clear();
    bloqueadoHasta = 0;
  }
};
