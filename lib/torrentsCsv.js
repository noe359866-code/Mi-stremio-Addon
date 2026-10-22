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

const API_BASE = String(process.env.TORRENTS_CSV_API || 'https://torrents-csv.com').replace(/\/+$/, '');
const TIMEOUT = timeout(parseInt(process.env.TORRENTS_CSV_TIMEOUT || '9000', 10), 9000);
const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.TORRENTS_CSV_ENABLED ?? '1'));
const LIMIT = Math.max(1, Math.min(50, parseInt(process.env.TORRENTS_CSV_LIMIT || '15', 10) || 15));
const PAGE_SIZE = Math.max(10, Math.min(100, parseInt(process.env.TORRENTS_CSV_PAGE_SIZE || '80', 10) || 80));
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const NON_VIDEO_RELEASE = /\b(soundtrack|ost|discography|album|mp3|flac|audiobook|ebook|e-book|comic|comics|software|windows|linux|android|game|games|xxx|porn|adult)\b/i;

function isVideoRelease(hit) {
  return !NON_VIDEO_RELEASE.test(String(hit?.name || ''));
}

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 250;
const IN_FLIGHT = new Map();

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.exp) {
    CACHE.delete(key);
    return undefined;
  }
  CACHE.delete(key);
  CACHE.set(key, hit);
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  const now = Date.now();
  for (const [cacheKey, entry] of CACHE) {
    if (now >= entry.exp) CACHE.delete(cacheKey);
  }
  CACHE.delete(key);
  while (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { value, exp: now + ttl });
}

function singleFlight(key, operation) {
  const running = IN_FLIGHT.get(key);
  if (running) return running;
  const promise = Promise.resolve().then(operation);
  IN_FLIGHT.set(key, promise);
  const clear = () => {
    if (IN_FLIGHT.get(key) === promise) IN_FLIGHT.delete(key);
  };
  promise.then(clear, clear);
  return promise;
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
    ? rawMagnet.match(/btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase()
    : null;
  const hash = String(item.infohash || item.info_hash || item.infoHash || item.hash || fromMagnet || '')
    .trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;

  const numericSize = Number(item.size ?? item.bytes ?? item.length);
  const size = Number.isFinite(numericSize) && numericSize >= 0 ? numericSize : null;
  // Evita que un magnet de la respuesta contradiga el infohash canónico.
  const magnet = fromMagnet === hash
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
  const params = new URLSearchParams({ q: query, size: String(PAGE_SIZE), page: String(page), type: 'torrent' });
  const response = await axios.get(`${API_BASE}/service/search?${params}`, {
    timeout: TIMEOUT,
    maxContentLength: MAX_CONTENT_LENGTH,
    headers: {
      'User-Agent': 'HackTorrent-Stremio-Addon/1.5 (+https://github.com/noe359866-code/Mi-stremio-Addon)',
      Accept: 'application/json'
    },
    validateStatus: status => status >= 200 && status < 300
  });
  return extractRecords(response.data).map(normalizeHit).filter(Boolean);
}

async function buscarStreams(opciones = {}) {
  if (!ENABLED) return [];
  const {
    title,
    originalTitle = null,
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = LIMIT
  } = opciones;
  if (!title) return [];

  const esSerie = type === 'series';
  const conEpisodio = esSerie && Number.isFinite(season) && Number.isFinite(episode);
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
          if (key && !hits.has(key)) hits.set(key, hit);
        }
      } catch (err) {
        console.error(`[Torrents.csv] Error buscando "${query}":`, err.message);
      }
    };

    await collect(`${title}${sufijoEp}`);
    let resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
      title, originalTitle, year, type, season, episode, limit,
      aceptarCategoria: isVideoRelease
    });

    // Con episodio, una segunda búsqueda amplia permite recuperar packs de
    // temporada. El filtro compartido descarta cualquier capítulo incorrecto.
    if (conEpisodio && resultado.aceptados.length === 0) {
      await collect(title);
      resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
        title, originalTitle, year, type, season, episode, limit,
        aceptarCategoria: isVideoRelease
      });
    }

    if (resultado.aceptados.length === 0 && originalTitle &&
        normalizeTitle(originalTitle) !== normalizeTitle(title)) {
      await collect(`${originalTitle}${sufijoEp}`);
      if (conEpisodio && resultado.aceptados.length === 0) await collect(originalTitle);
      resultado = R.filtrarYOrdenar(Array.from(hits.values()), {
        title, originalTitle, year, type, season, episode, limit,
        aceptarCategoria: isVideoRelease
      });
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
  _limpiarCache: () => CACHE.clear()
};
