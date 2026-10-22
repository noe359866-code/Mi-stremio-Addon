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

const KNABEN_API = String(process.env.KNABEN_API || 'https://api.knaben.org/v2').replace(/\/+$/, '');
const { timeout } = require('./timeouts');
const KNABEN_TIMEOUT = timeout(parseInt(process.env.KNABEN_TIMEOUT || '9000', 10), 9000);
const KNABEN_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.KNABEN_ENABLED ?? '1'));
const KNABEN_LIMIT = Math.max(1, Math.min(50, parseInt(process.env.KNABEN_LIMIT || '15', 10) || 15));
const PAGE_SIZE = Math.max(10, Math.min(150, parseInt(process.env.KNABEN_PAGE_SIZE || '60', 10) || 60));

// Caché: evita repetir la misma búsqueda por cada episodio que pide Stremio
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 300;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next();
    if (!oldest.done) CACHE.delete(oldest.value);
  }
  CACHE.set(key, { value, exp: Date.now() + ttl });
}

/** Categorías de Knaben: sólo vídeo del tipo pedido. */
function categoriaCompatible(categoria, tipo) {
  const c = String(categoria || '');
  if (!c) return false;
  if (/xxx|adult|porn|audio|music|books?|comics?|games?|software|android|other/i.test(c)) return false;
  if (tipo === 'movie') return /^movies?\b/i.test(c);
  return /^(tv|anime)\b/i.test(c);
}

// Knaben pide moderación (hay límite de peticiones): espaciado global + cooldown
const MIN_INTERVALO_MS = Math.max(0, parseInt(process.env.KNABEN_MIN_INTERVAL_MS || '400', 10) || 0);
let ultimaConsulta = 0;
let bloqueadoHasta = 0;

const dormir = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Normaliza un hit de Knaben al formato compartido de lib/release.js */
function normalizarHit(hit) {
  return {
    name: hit.title || hit.name || '',
    hash: hit.hash || null,
    magnet: hit.magnetUrl && /^magnet:/i.test(hit.magnetUrl) ? hit.magnetUrl : null,
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
 * Consulta la API de Knaben (v2) con espaciado entre peticiones.
 * @returns {Promise<Array>} hits normalizados
 */
async function consultarKnaben(query, size = PAGE_SIZE) {
  if (Date.now() < bloqueadoHasta) {
    throw Object.assign(new Error('Knaben en cooldown por rate limit'), { cooldown: true });
  }

  const espera = MIN_INTERVALO_MS - (Date.now() - ultimaConsulta);
  if (espera > 0) await dormir(espera);
  ultimaConsulta = Date.now();

  const parametros = new URLSearchParams({
    q: query,
    sf: 'title',
    o: 'seeders',
    d: 'desc',
    s: String(size)
  });

  const url = `${KNABEN_API}/search?${parametros.toString()}`;
  let res;
  try {
    res = await axios.get(url, {
      timeout: KNABEN_TIMEOUT,
      headers: {
        'User-Agent': 'HackTorrent-Stremio-Addon/1.3 (+https://github.com/noe359866-code/Mi-stremio-Addon)',
        'Accept': 'application/json'
      },
      validateStatus: s => s >= 200 && s < 300
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || status === 503) {
      bloqueadoHasta = Date.now() + 60 * 1000;
      console.warn('[Knaben] ⚠️ Rate limit alcanzado, pausando 60s');
      err.cooldown = true;
    }
    throw err;
  }

  const hits = res.data?.hits;
  return Array.isArray(hits) ? hits.map(normalizarHit) : [];
}

/**
 * Busca en Knaben y devuelve streams de Stremio (inglés).
 *
 * @param {object} opciones { title, originalTitle, year, type, season, episode, limit }
 * @returns {Promise<Array>} streams
 */
async function buscarStreams(opciones = {}) {
  if (!KNABEN_ENABLED) return [];

  const {
    title,
    originalTitle = null,
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = KNABEN_LIMIT
  } = opciones;

  if (!title) return [];

  const esSerie = type === 'series';
  const cacheKey = [
    'knaben', normalizeTitle(title), normalizeTitle(originalTitle || ''),
    year || '', esSerie ? 'serie' : 'movie',
    season ?? '', episode ?? '', limit
  ].join('|');

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const conEpisodio = esSerie && Number.isFinite(season) && Number.isFinite(episode);
  const sufijoEp = conEpisodio
    ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  const hits = new Map();
  const agregar = (lista) => {
    for (const hit of lista) {
      if (!hit || !hit.name) continue;
      const clave = hit.hash || hit.magnet;
      if (!clave || hits.has(clave)) continue;
      hits.set(clave, hit);
    }
  };

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
      if (conEpisodio) {
        let exactos = 0;
        for (const hit of hits.values()) {
          const se = parseSeasonEpisode(hit.name);
          if (se.season === season && se.episode === episode) exactos++;
        }
        if (exactos >= Math.min(limit, 8)) return;
      }
    }
  };

  await recolectar(title);

  let resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
    title,
    originalTitle,
    year,
    type,
    season,
    episode,
    limit,
    aceptarCategoria: (hit) => categoriaCompatible(hit.category, esSerie ? 'series' : 'movie')
  });

  // Ronda 2 (sólo si no hubo nada válido): título original
  const tituloOriginalDistinto = originalTitle &&
    normalizeTitle(originalTitle) !== normalizeTitle(title);

  if (resultado.aceptados.length === 0 && tituloOriginalDistinto) {
    await recolectar(originalTitle);
    resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
      title,
      originalTitle,
      year,
      type,
      season,
      episode,
      limit,
      aceptarCategoria: (hit) => categoriaCompatible(hit.category, esSerie ? 'series' : 'movie')
    });
  }

  const streams = resultado.aceptados.map(aceptado =>
    R.formatearStream(aceptado, { nombreFuente: 'Knaben', claveFuente: 'knaben' })
  );

  console.log(`[Knaben] ✅ ${streams.length}/${hits.size} resultados válidos para "${title}${sufijoEp}"`);
  cacheSet(cacheKey, streams, streams.length > 0 ? CACHE_TTL : CACHE_TTL_EMPTY);
  return streams;
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
  _limpiarCache: () => CACHE.clear()
};
