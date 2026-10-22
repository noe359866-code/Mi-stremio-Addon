/**
 * lib/http.js
 * ---------------------------------------------------------------------------
 * Utilidades compartidas de red, caché LRU acotada y deduplicación en vuelo
 * para todos los scrapers del addon UniverTorrent.
 *
 *   - Agentes HTTP/HTTPS con Keep-Alive para reutilizar sockets TLS entre
 *     peticiones a un mismo dominio (reduce latencia en scraping de detalles).
 *   - Clasificación de errores transitorios (timeouts, resets, 429, 502-504,
 *     Cloudflare 520-524) frente a errores definitivos (404, stubs de tests).
 *   - Caché LRU sobre `Map` nativo con refresco real en lectura y TTL corto
 *     opcional para respuestas negativas/vacías.
 *   - Deduplicación `single-flight` para evitar ráfagas duplicadas concurrentes.
 * ---------------------------------------------------------------------------
 */

'use strict';

const http = require('http');
const https = require('https');

const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 15000
});

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 15000
});

// Evitar que sockets ociosos mantengan vivo el event loop al terminar tests CLI
if (typeof sharedHttpAgent.unref === 'function') sharedHttpAgent.unref();
if (typeof sharedHttpsAgent.unref === 'function') sharedHttpsAgent.unref();

/** Adjunta agentes Keep-Alive a una config de axios sin reemplazar agentes explícitos. */
function withKeepAlive(config = {}) {
  return {
    httpAgent: sharedHttpAgent,
    httpsAgent: sharedHttpsAgent,
    ...config
  };
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED'
]);

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Determina si un error de red/HTTP amerita reintento o failover de espejo.
 * Los errores 404, 400 o errores de validación/stubs NO son transitorios.
 */
function isTransientNetworkError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(String(err.code).toUpperCase())) return true;
  const status = err.response && Number(err.response.status);
  if (status && TRANSIENT_STATUS.has(status)) return true;
  const msg = String(err.message || '');
  if (/\b(timeout|ETIMEDOUT|ECONNRESET|socket hang up|network error)\b/i.test(msg)) return true;
  return false;
}

/** Extrae milisegundos de espera de una cabecera `Retry-After` (acotado a `maxMs`). */
function parseRetryAfterMs(headersOrValue, fallbackMs = 350, maxMs = 120000) {
  const raw = (headersOrValue && typeof headersOrValue === 'object')
    ? (headersOrValue['retry-after'] ?? headersOrValue['Retry-After'])
    : headersOrValue;
  if (raw === undefined || raw === null || raw === '') return fallbackMs;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(maxMs, Math.max(50, Math.round(secs * 1000)));
  }
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) {
    return Math.min(maxMs, Math.max(50, dateMs - Date.now()));
  }
  return fallbackMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Lee una entrada de un `Map` usado como caché `{ value, exp }` o `{ data, exp }`,
 * refrescando su posición LRU al final del `Map`.
 */
function lruGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.exp <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  // Refrescar orden LRU en el Map
  map.delete(key);
  map.set(key, hit);
  return Object.prototype.hasOwnProperty.call(hit, 'value') ? hit.value : hit.data;
}

/**
 * Inserta una entrada `{ value, exp }` en un `Map` acotado con política LRU.
 */
function lruSet(map, key, value, ttlMs, maxEntries = 300) {
  if (map.has(key)) map.delete(key);
  if (map.size >= maxEntries) {
    const now = Date.now();
    for (const [k, entry] of map.entries()) {
      if (!entry || entry.exp <= now) map.delete(k);
    }
    while (map.size >= maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, { value, data: value, exp: Date.now() + ttlMs });
  return value;
}

/**
 * Ejecuta `fn()` deduplicando llamadas concurrentes con la misma `key` en `inFlightMap`.
 */
function withSingleFlight(inFlightMap, key, fn) {
  const existing = inFlightMap.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      inFlightMap.delete(key);
    });
  inFlightMap.set(key, promise);
  return promise;
}

module.exports = {
  sharedHttpAgent,
  sharedHttpsAgent,
  withKeepAlive,
  isTransientNetworkError,
  parseRetryAfterMs,
  sleep,
  lruGet,
  lruSet,
  withSingleFlight
};
