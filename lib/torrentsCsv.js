/**
 * Torrents.csv: fuente de torrents públicos mediante su API JSON.
 *   GET https://torrents-csv.com/service/search?q=...&size=...&page=1
 *
 * Normaliza los resultados al formato compartido y aplica el mismo filtro
 * estricto de título, año y episodio que Knaben/TBB antes de devolver streams.
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

const API_BASE = String(process.env.TORRENTS_CSV_API || 'https://torrents-csv.com').replace(/\/+$/, '');
const TIMEOUT = timeout(parseInt(process.env.TORRENTS_CSV_TIMEOUT || '9000', 10), 9000);
const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.TORRENTS_CSV_ENABLED ?? '1'));
const LIMIT = Math.max(1, Math.min(50, parseInt(process.env.TORRENTS_CSV_LIMIT || '15', 10) || 15));
const PAGE_SIZE = Math.max(10, Math.min(100, parseInt(process.env.TORRENTS_CSV_PAGE_SIZE || '80', 10) || 80));
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const MIN_INTERVALO_MS = Math.max(0, parseInt(process.env.TORRENTS_CSV_MIN_INTERVAL_MS || '0', 10) || 0);
const NON_VIDEO_RELEASE = /\b(soundtrack|ost|discography|album|mp3|flac|audiobook|ebook|e-book|comic|comics|software|windows|linux|android|game|games|xxx|porn|adult)\b/i;

function isVideoRelease(hit) {
  const name = String(hit?.name || '');
  return !NON_VIDEO_RELEASE.test(name) && R.esReleaseVideo(name);
}

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 250;
const IN_FLIGHT = new Map();

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

function cacheGet(key) {
  return lruGet(CACHE, key);
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  lruSet(CACHE, key, value, ttl, CACHE_MAX);
}

function singleFlight(key, operation) {
  return withSingleFlight(IN_FLIGHT, key, operation);
}

function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  for (const value of [payload?.results, payload?.torrents, payload?.hits, payload?.data]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeHit(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name || item.title || item.filename || '').trim();
  if (!name) return null;

  const rawMagnet = item.magnet || item.magnet_uri || item.magnetUrl || item.magnet_link || null;
  const fromMagnet = typeof rawMagnet === 'string'
    ? R.extraerInfoHash(rawMagnet)
    : null;
  const hash = R.extraerInfoHash(item.infohash || item.info_hash || item.infoHash || item.hash) || fromMagnet;
  if (!hash) return null;

  const numericSize = Number(item.size ?? item.bytes ?? item.length);
  const size = Number.isFinite(numericSize) && numericSize >= 0 ? numericSize : null;
  // Evita que un magnet de la respuesta contradiga el infohash canónico.
  const magnet = fromMagnet === hash && typeof rawMagnet === 'string' && /^magnet:/i.test(rawMagnet)
    ? rawMagnet
    : R.construirMagnet(hash, name);

  return {
    name,
    hash,
    magnet,
    seeders: Number(item.seeders ?? item.seeds ?? 0) || 0,
    peers: Number(item.leechers ?? item.peers ?? item.peers_count ?? 0) || 0,
    size,
    sizeLabel: item.sizeLabel || item.size_label || R.bytesAHumano(size),
    tracker: item.source || item.tracker || null,
    category: item.category || null,
    fuente: 'Torrents.csv',
    _raw: item
  };
}

async function consultar(query, page = 1) {
  if (Date.now() < bloqueadoHasta) {
    throw Object.assign(new Error('Torrents.csv en cooldown por rate limit'), { cooldown: true });
  }

  await esperarTurno();

  const params = new URLSearchParams({ q: query, size: String(PAGE_SIZE), page: String(page), type: 'torrent' });
  let response;
  for (let intento = 0; intento < 2; intento++) {
    try {
      response = await axios.get(`${API_BASE}/service/search?${params}`, withKeepAlive({
        timeout: TIMEOUT,
        maxContentLength: MAX_CONTENT_LENGTH,
        headers: {
          'User-Agent': 'HackTorrent-Stremio-Addon/1.7 (+https://github.com/noe359866-code/Mi-stremio-Addon)',
          Accept: 'application/json'
        },
        validateStatus: status => status >= 200 && status < 300
      }));
      break;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || status === 503) {
        const retryMs = parseRetryAfterMs(err.response?.headers?.['retry-after'], 60 * 1000);
        bloqueadoHasta = Date.now() + retryMs;
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
  return extractRecords(response.data).map(normalizeHit).filter(Boolean);
}

async function buscarStreams(opciones = {}) {
  if (!ENABLED) return [];
  const {
    title,
    originalTitle = null,
    altTitles = [],
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = LIMIT
  } = opciones;
  if (!title) return [];

  const tieneEpisodio = Number.isFinite(season) && Number.isFinite(episode);
  const esSerie = type === 'series' || (type === 'anime' && tieneEpisodio);
  const conEpisodio = esSerie && tieneEpisodio;
  const sufijoEp = conEpisodio
    ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';
  const cacheKey = [
    'tcsv', normalizeTitle(title), normalizeTitle(originalTitle || ''), year || '',
    esSerie ? 'series' : 'movie', season ?? '', episode ?? '', limit
  ].join('|');
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  return singleFlight(cacheKey, async () => {
    const fromCache = cacheGet(cacheKey);
    if (fromCache !== undefined) return fromCache;

    const hits = new Map();
    const collect = async query => {
      try {
        for (const hit of await consultar(query)) {
          const key = hit.hash || hit.magnet;
          if (!key) continue;
          const prev = hits.get(key);
          if (!prev || (hit.seeders || 0) > (prev.seeders || 0)) {
            hits.set(key, hit);
          }
        }
      } catch (err) {
        console.error(`[Torrents.csv] Error buscando "${query}":`, err.message);
      }
    };

    const filterOpts = {
      title, originalTitle, altTitles, year, type, season, episode, limit,
      aceptarCategoria: isVideoRelease
    };

    await collect(`${title}${sufijoEp}`);
    let resultado = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);

    // Con episodio, una segunda búsqueda amplia permite recuperar packs de
    // temporada. El filtro compartido descarta cualquier capítulo incorrecto.
    if (conEpisodio && resultado.aceptados.length === 0) {
      await collect(title);
      resultado = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
    }

    const candidatosAlt = [originalTitle, ...(Array.isArray(altTitles) ? altTitles : [])]
      .filter(t => t && normalizeTitle(t) !== normalizeTitle(title));

    for (const alt of candidatosAlt.slice(0, 2)) {
      if (resultado.aceptados.length > 0) break;
      await collect(`${alt}${sufijoEp}`);
      resultado = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
      if (conEpisodio && resultado.aceptados.length === 0) {
        await collect(alt);
        resultado = R.filtrarYOrdenar(Array.from(hits.values()), filterOpts);
      }
    }

    const streams = resultado.aceptados.map(hit => R.formatearStream(hit, {
      nombreFuente: 'Torrents.csv', claveFuente: 'tcsv'
    }));
    console.log(`[Torrents.csv] ${streams.length}/${hits.size} resultados válidos para "${title}${sufijoEp}"`);
    cacheSet(cacheKey, streams, streams.length ? CACHE_TTL : CACHE_TTL_EMPTY);
    return streams;
  });
}

module.exports = {
  TORRENTS_CSV_ENABLED: ENABLED,
  TORRENTS_CSV_API: API_BASE,
  buscarStreams,
  // Helpers expuestos para pruebas.
  _normalizeHit: normalizeHit,
  _extractRecords: extractRecords,
  _limpiarCache: () => {
    CACHE.clear();
    IN_FLIGHT.clear();
    bloqueadoHasta = 0;
  }
};
