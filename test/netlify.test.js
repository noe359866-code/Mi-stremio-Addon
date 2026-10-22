'use strict';

/**
 * Adaptador de Netlify Functions (netlify/functions/addon.js).
 *
 * Se simulan los eventos que envía Netlify para comprobar que las rutas del
 * addon (incluida la configuración codificada en la URL) llegan intactas a
 * Express, sin necesidad de red.
 */

const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../manifest.json');
const { handler, _internals } = require('../netlify/functions/addon');

const HOST = 'mi-addon.netlify.app';

/**
 * Evento con la forma que entrega Netlify (API Gateway v1 + rawUrl).
 * @param {string} path ruta ya codificada (tal cual la pide el cliente)
 * @param {object} [extra]
 */
function eventoNetlify(path, extra = {}) {
  const { query = null, rawUrl, ...resto } = extra;
  const url = rawUrl || `https://${HOST}${path}${query ? `?${query}` : ''}`;
  const params = query ? Object.fromEntries(new URLSearchParams(query)) : null;
  return {
    path,
    httpMethod: 'GET',
    headers: { host: HOST, 'x-forwarded-proto': 'https', accept: '*/*' },
    queryStringParameters: params,
    multiValueQueryStringParameters: null,
    body: '',
    isBase64Encoded: false,
    rawUrl: url,
    rawQuery: query || '',
    ...resto
  };
}

function json(respuesta) {
  return JSON.parse(respuesta.body);
}

test('netlify: /health responde JSON', async () => {
  const res = await handler(eventoNetlify('/health'), {});
  assert.strictEqual(res.statusCode, 200);
  const cuerpo = json(res);
  assert.strictEqual(cuerpo.ok, true);
  assert.strictEqual(cuerpo.version, manifest.version);
});

test('netlify: / redirige a /configure', async () => {
  const res = await handler(eventoNetlify('/'), {});
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/configure');
});

test('netlify: /configure respeta la query recibida', async () => {
  const res = await handler(
    eventoNetlify('/configure', { query: 'idioma=ingles&fuentes=knaben&calidad=1080p' }),
    {}
  );
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /name="idioma" value="ingles" checked/);
  assert.match(res.body, /name="fuente" value="knaben" checked/);
  assert.match(res.body, /<option value="1080p" selected>/);
});

test('netlify: /manifest.json marca el addon como configurable', async () => {
  const res = await handler(eventoNetlify('/manifest.json'), {});
  assert.strictEqual(res.statusCode, 200);
  const cuerpo = json(res);
  assert.strictEqual(cuerpo.id, manifest.id);
  assert.strictEqual(cuerpo.behaviorHints.configurable, true);
});

test('netlify: la configuración codificada en la URL llega intacta al SDK', async () => {
  const cfg = encodeURIComponent(JSON.stringify({ idioma: 'latino', fuentes: 'ht' }));
  const res = await handler(eventoNetlify(`/${cfg}/manifest.json`), {});
  assert.strictEqual(res.statusCode, 200);
  const cuerpo = json(res);
  // Ya instalado: el SDK quita "configurable" de la copia con configuración.
  assert.ok(Array.isArray(cuerpo.config) && cuerpo.config.length >= 6);
  assert.strictEqual(cuerpo.behaviorHints.configurable, undefined);
});

test('netlify: llamar a /.netlify/functions/addon/... equivale a la raíz', async () => {
  const res = await handler(eventoNetlify('/.netlify/functions/addon/health'), {});
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).ok, true);

  const raiz = await handler(eventoNetlify('/.netlify/functions/addon'), {});
  assert.strictEqual(raiz.statusCode, 302);
  assert.strictEqual(raiz.headers.location, '/configure');

  const cfg = encodeURIComponent(JSON.stringify({ idioma: 'latino' }));
  const mf = await handler(
    eventoNetlify(`/.netlify/functions/addon/${cfg}/manifest.json`),
    {}
  );
  assert.strictEqual(mf.statusCode, 200);
  assert.strictEqual(json(mf).id, manifest.id);
});

test('netlify: si el evento no trae queryStringParameters se derivan de la URL', async () => {
  const res = await handler(
    eventoNetlify('/configure', {
      query: 'idioma=latino&fuentes=ht',
      queryStringParameters: null,
      multiValueQueryStringParameters: null
    }),
    {}
  );
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body, /name="idioma" value="latino" checked/);
});

test('netlify: normalizarEvento re-codifica paths que llegan decodificados', () => {
  const cfg = JSON.stringify({ idioma: 'ingles' });
  const ev = _internals.normalizarEvento({
    path: `/${cfg}/manifest.json`,
    httpMethod: 'GET',
    headers: {}
  });
  assert.ok(ev.path.includes('%7B'), `la ruta debe ir codificada (fue ${ev.path})`);
  assert.ok(ev.path.endsWith('/manifest.json'));
});

test('netlify: normalizarEvento conserva la codificación de rawUrl', () => {
  const cfg = encodeURIComponent(JSON.stringify({ fuentes: 'ht,tbb' }));
  const ev = _internals.normalizarEvento({
    path: '/.netlify/functions/addon/manifest.json',
    rawUrl: `https://${HOST}/${cfg}/manifest.json?x=1`,
    httpMethod: 'GET',
    headers: {}
  });
  assert.strictEqual(ev.path, `/${cfg}/manifest.json`);
  assert.strictEqual(ev.queryStringParameters.x, '1');
});

test('netlify: la respuesta de respaldo es válida para Stremio', () => {
  assert.deepStrictEqual(_internals.payloadVacio('/cfg/stream/movie/tt0848228.json'), { streams: [] });
  assert.deepStrictEqual(_internals.payloadVacio('/cfg/catalog/movie/x.json'), { metas: [] });
  assert.deepStrictEqual(_internals.payloadVacio('/cfg/meta/series/tt0903747.json'), { meta: null });

  const res = _internals.respuestaVacia('/cfg/stream/movie/tt0848228.json');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  assert.deepStrictEqual(JSON.parse(res.body), { streams: [] });
});
