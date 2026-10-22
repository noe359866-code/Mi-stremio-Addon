/**
 * lib/knaben.js
 * ---------------------------------------------------------------------------
 * Fuente secundaria en INGLÉS: API pública de Knaben (meta-indexer).
 *
 *   GET https://api.knaben.org/v2/search?q=...&sf=title&o=seeders&d=desc&s=60
 *   https://knaben.org/api/v2/
 *
 * La v2 es GET y no requiere clave (la v1 sólo acepta POST y está limitada por
 * ancho de banda). El filtrado estricto vive en lib/release.js, compartido con
 * el resto de fuentes externas.
 * ---------------------------------------------------------------------------
 */

'use strict';

const axios = require('axios');
const { normalizeTitle, parseSeasonEpisode } = require('./match');
const R = require('./release');
const {
  withKeepAlive,
  isTransientNetworkError,
  parseRetryAfterMs,
  lruGet,
  lruSet,
  withSingleFlight
} = require('./http');

const KNABEN_API = String(process.env.KNABEN_API || 'https://api.knaben.org/v2').replace(/\/+$/, '');
const { timeout } = require('./timeouts');
const KNABEN_TIMEOUT = timeout(parseInt(process.env.KNABEN_TIMEOUT || '9000', 10), 9000);
const KNABEN_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.KNABEN_ENABLED ?? '1'));
const KNABEN_LIMIT = Math.max(1, Math.min(50, parseInt(process.env.KNABEN_LIMIT || '15', 10) || 15));
const PAGE_SIZE = Math.max(10, Math.min(150, parseInt(process.env.KNABEN_PAGE_SIZE || '60', 10) || 60));

// Caché LRU + deduplicación en vuelo
const CACHE = new Map();
const IN_FLIGHT = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 300;

function cacheGet(key) {
  const val = lruGet(CACHE, key);
  return val === undefined ? null : val;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  lruSet(CACHE, key, value, ttl, CACHE_MAX);
}

/** Categorías de Knaben: sólo vídeo del tipo pedido. */
function categoriaCompatible(categoria, tipo) {
  const c = String(categoria || '');
  if (!c) return false;
  if (/xxx|adult|porn|audio|music|books?|comics?|games?|software|android|other/i.test(c)) return false;
  if (tipo === 'movie') return /^movies?\b/i.test(c);
  if (tipo === 'anime-movie') return /^(movies?|anime)\b/i.test(c);
  return /^(tv|anime)\b/i.test(c);
}

// Knaben pide moderación (hay límite de peticiones): cola atómica + cooldown
const MIN_INTERVALO_MS = Math.max(0, parseInt(process.env.KNABEN_MIN_INTERVAL_MS || '400', 10) || 0);
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

/** Normaliza un hit de Knaben al formato compartido de lib/release.js */
function normalizarHit(hit) {
  const rawMagnet = hit.magnetUrl && /^magnet:/i.test(hit.magnetUrl) ? hit.magnetUrl : null;
  const hash = R.extraerInfoHash(hit.hash) || R.extraerInfoHash(rawMagnet) || null;
  return {
    name: hit.title || hit.name || '',
    hash,
    magnet: rawMagnet,
    seeders: hit.liveSeeders ?? hit.seeders ?? 0,
    peers: hit.livePeers ?? hit.peers ?? 0,
    size: hit.bytes,
    sizeLabel: R.bytesAHumano(hit.bytes),
    tracker: hit.tracker || null,
    category: hit.category,
    fuente: 'Knaben',
    _raw: hit
  };
}

/**
 * Consulta la API de Knaben (v2) con espaciado atómico entre peticiones.
 * @returns {Promise<Array>} hits normalizados
 */
async function consultarKnaben(query, size = PAGE_SIZE) {
  if (Date.now() < bloqueadoHasta) {
    throw Object.assign(new Error('Knaben en cooldown por rate limit'), { cooldown: true });
  }

  await esperarTurno();

  const parametros = new URLSearchParams({
    q: query,
    sf: 'title',
    o: 'seeders',
    d: 'desc',
    s: String(size)
  });

  const url = `${KNABEN_API}/search?${parametros.toString()}`;
  let res;
  for (let intento = 0; intento < 2; intento++) {
    try {
      res = await axios.get(url, withKeepAlive({
        timeout: KNABEN_TIMEOUT,
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
        console.warn(`[Knaben] ⚠️ Rate limit alcanzado, pausando ${Math.round(retryMs / 1000)}s`);
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

  const hits = res.data?.hits;
  return Array.isArray(hits) ? hits.map(normalizarHit) : [];
}

/**
 * Busca en Knaben y devuelve streams de Stremio (inglés).
 *
 * @param {object} opciones { title, originalTitle, altTitles, year, type, season, episode, limit }
 * @returns {Promise<Array>} streams
 */
async function buscarStreams(opciones = {}) {
  if (!KNABEN_ENABLED) return [];

  const {
    title,
    originalTitle = null,
    altTitles = [],
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = KNABEN_LIMIT
  } = opciones;

  if (!title) return [];

  const conEpisodio = Number.isFinite(season) && Number.isFinite(episode);
  const esSerie = type === 'series' || (type === 'anime' && conEpisodio);
  const tipoCategoria = esSerie
    ? 'series'
    : (type === 'anime' ? 'anime-movie' : 'movie');

  const cacheKey = [
    'knaben', normalizeTitle(title), normalizeTitle(originalTitle || ''),
    year || '', tipoCategoria,
    season ?? '', episode ?? '', limit
  ].join('|');

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  return withSingleFlight(IN_FLIGHT, cacheKey, async () => {
    const fromCache = cacheGet(cacheKey);
    if (fromCache) return fromCache;

    const sufijoEp = (esSerie && conEpisodio)
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

    const aceptarHit = (hit) =>
      categoriaCompatible(hit.category, tipoCategoria) && R.esReleaseVideo(hit.name);

    /** Con episodio se consulta "Serie S02E05" y "Serie" (packs). */
    const recolectar = async (titulo) => {
      const consultas = [`${titulo}${sufijoEp}`];
      if (sufijoEp) consultas.push(titulo);

      for (const q of consultas) {
        try {
          agregar(await consultarKnaben(q));
        } catch (err) {
          console.error(`[Knaben] ❌ Error buscando "${q}":`, err.message);
          if (err.cooldown) return;
        }
        if (esSerie && conEpisodio) {
          let exactos = 0;
          for (const hit of hits.values()) {
            const se = parseSeasonEpisode(hit.name);
            const eps = Array.isArray(se.episodes) ? se.episodes : (se.episode !== null ? [se.episode] : []);
            if (se.season === season && eps.includes(episode)) exactos++;
          }
          if (exactos >= Math.min(limit, 8)) return;
        }
      }
    };

    await recolectar(title);

    let resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
      title,
      originalTitle,
      altTitles,
      year,
      type,
      season,
      episode,
      limit,
      aceptarCategoria: aceptarHit
    });

    // Ronda 2 (sólo si no hubo nada válido): título original o altTitle principal
    const candidatosRonda2 = [originalTitle, ...(Array.isArray(altTitles) ? altTitles : [])]
      .filter(t => t && normalizeTitle(t) !== normalizeTitle(title));

    for (const alt of candidatosRonda2.slice(0, 2)) {
      if (resultado.aceptados.length > 0) break;
      await recolectar(alt);
      resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
        title,
        originalTitle,
        altTitles,
        year,
        type,
        season,
        episode,
        limit,
        aceptarCategoria: aceptarHit
      });
    }

    const streams = resultado.aceptados.map(aceptado =>
      R.formatearStream(aceptado, { nombreFuente: 'Knaben', claveFuente: 'knaben' })
    );

    console.log(`[Knaben] ✅ ${streams.length}/${hits.size} resultados válidos para "${title}${sufijoEp}"`);
    cacheSet(cacheKey, streams, streams.length > 0 ? CACHE_TTL : CACHE_TTL_EMPTY);
    return streams;
  });
}

module.exports = {
  KNABEN_ENABLED,
  KNABEN_API,
  buscarStreams,
  // helpers expuestos para tests (implementados en lib/release.js)
  _contieneTitulo: R.contieneTitulo,
  _categoriaCompatible: categoriaCompatible,
  _calidadDeNombre: R.calidadDeNombre,
  _ultimoAnio: R.ultimoAnio,
  _construirMagnet: R.construirMagnet,
  _bytesAHumano: R.bytesAHumano,
  _normalizarHit: normalizarHit,
  _limpiarCache: () => {
    CACHE.clear();
    IN_FLIGHT.clear();
    bloqueadoHasta = 0;
  }
};
