/**
 * netlify/functions/addon.js
 * ---------------------------------------------------------------------------
 * Adaptador Netlify Functions para el addon (Express + stremio-addon-sdk).
 *
 * Netlify ejecuta funciones serverless: no hay proceso "encendido", así que no
 * existe el arranque en frío de 30–60 s de un servicio gratuito de Render. A
 * cambio, cada petición tiene un presupuesto de tiempo y hay que responder
 * dentro de él.
 *
 * Qué hace este archivo:
 *   1. Reconstruye la ruta original de la petición (Netlify la pasa en
 *      `event.rawUrl` / `event.path`), conservando la codificación de la
 *      configuración que viaja en la URL.
 *   2. Quita el prefijo `/.netlify/functions/addon` si se llamó directamente a
 *      la función (sin el rewrite de `netlify.toml`).
 *   3. Entrega la petición a Express con `serverless-http`.
 *   4. Si el trabajo se pasa del presupuesto (`NETLIFY_ADDON_DEADLINE_MS`,
 *      9 s por defecto) devuelve una respuesta vacía **válida para Stremio**
 *      (`{ streams: [] }`, `{ metas: [] }`…) en lugar de un 504.
 *
 * Variables de entorno opcionales:
 *   ADDON_CACHE_MAX_AGE          segundos de caché para las respuestas .json (1 h)
 *   NETLIFY_ADDON_DEADLINE_MS    presupuesto máximo por petición (9000 ms)
 *   ADDON_HTTP_TIMEOUT_MS        tope de las peticiones salientes (ver lib/timeouts.js)
 * ---------------------------------------------------------------------------
 */

'use strict';

const serverless = require('serverless-http');
const addonInterface = require('../../index');
const { createApp } = require('../../lib/server');

function entero(valor, porDefecto) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

// 1 h por defecto: el CDN de Netlify cachea las respuestas .json del addon.
const CACHE_SEGUNDOS = entero(process.env.ADDON_CACHE_MAX_AGE, 60 * 60);

// Presupuesto por petición. El plan gratuito de Netlify corta a los 10 s en
// cuentas antiguas, así que dejamos 1 s de margen para contestar con dignidad.
const PRESUPUESTO_MS = entero(process.env.NETLIFY_ADDON_DEADLINE_MS, 9000);

const app = createApp(addonInterface, { cacheMaxAge: CACHE_SEGUNDOS });
const lambda = serverless(app);

// Rutas con las que se puede invocar la función directamente.
const PREFIJOS_FUNCION = [
  '/.netlify/functions/addon',
  '/.netlify/functions/addon.js',
  '/.netlify/functions/hacktorrent'
];

/** Payload vacío pero válido para el recurso que pidió Stremio. */
function payloadVacio(pathname = '') {
  const ruta = String(pathname);
  if (/\/stream\//.test(ruta)) return { streams: [] };
  if (/\/catalog\//.test(ruta)) return { metas: [] };
  if (/\/meta\//.test(ruta)) return { meta: null };
  return { err: 'timeout' };
}

/** Respuesta 200 con el payload vacío (Stremio la trata como "sin resultados"). */
function respuestaVacia(pathname) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payloadVacio(pathname))
  };
}

/**
 * Normaliza el evento de Netlify al formato que espera serverless-http
 * (evento de AWS API Gateway v1), preservando la ruta codificada.
 */
function normalizarEvento(event = {}) {
  const ev = { ...event };

  let pathname = null;
  let search = typeof ev.rawQuery === 'string' ? ev.rawQuery.replace(/^\?/, '') : '';

  // `rawUrl` es la fuente más fiable: conserva los %XX de la configuración.
  if (typeof ev.rawUrl === 'string' && /^https?:\/\//i.test(ev.rawUrl)) {
    try {
      const url = new URL(ev.rawUrl);
      pathname = url.pathname;
      if (!search) search = url.search.replace(/^\?/, '');
    } catch {
      // rawUrl inválida: se usa event.path
    }
  }

  if (pathname === null) {
    const bruto = String(ev.path || '/');
    // Netlify suele entregar la ruta original; si viene decodificada (con
    // llaves o comillas) hay que volver a codificarla para Express.
    pathname = bruto.includes('%') ? bruto : encodeURI(bruto);
  }

  // Invocación directa a la función: quitamos el prefijo para obtener la ruta
  // que pidió el cliente (/configure, /manifest.json, /{config}/stream/…).
  for (const prefijo of PREFIJOS_FUNCION) {
    if (pathname === prefijo) { pathname = '/'; break; }
    if (pathname.startsWith(`${prefijo}/`)) {
      pathname = pathname.slice(prefijo.length) || '/';
      break;
    }
  }

  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  ev.path = pathname;
  ev.rawPath = pathname;
  ev.rawQueryString = search;
  ev.httpMethod = ev.httpMethod || ev.requestContext?.http?.method || 'GET';
  ev.headers = ev.headers || {};

  // Si Netlify no entrega los parámetros ya parseados, los sacamos de la URL.
  if (!ev.queryStringParameters && search) {
    const params = new URLSearchParams(search);
    ev.queryStringParameters = Object.fromEntries(params);
    if (!ev.multiValueQueryStringParameters) {
      const multi = {};
      for (const clave of new Set(params.keys())) multi[clave] = params.getAll(clave);
      ev.multiValueQueryStringParameters = multi;
    }
  }

  if (ev.body === undefined || ev.body === null) ev.body = '';
  return ev;
}

/**
 * Ejecuta el handler de Express con un presupuesto de tiempo.
 * Si se agota, responde con una lista vacía en lugar de un 504.
 */
async function conPresupuesto(evento, contexto) {
  const tarea = lambda(evento, contexto);
  // Evita un unhandled rejection si ganamos la carrera del timeout.
  tarea.catch(() => {});

  if (!(PRESUPUESTO_MS > 0)) return tarea;

  let temporizador;
  const limite = new Promise((resolve) => {
    temporizador = setTimeout(() => resolve(null), PRESUPUESTO_MS);
    if (typeof temporizador.unref === 'function') temporizador.unref();
  });

  try {
    const respuesta = await Promise.race([tarea, limite]);
    if (respuesta) return respuesta;
    console.warn(`[Netlify] Presupuesto de ${PRESUPUESTO_MS} ms agotado en ${evento.path}`);
    return respuestaVacia(evento.path);
  } finally {
    clearTimeout(temporizador);
  }
}

exports.handler = async (event, context) => conPresupuesto(normalizarEvento(event), context || {});

// Utilidades expuestas para los tests (sin red).
exports._internals = { normalizarEvento, payloadVacio, respuestaVacia, PREFIJOS_FUNCION };
