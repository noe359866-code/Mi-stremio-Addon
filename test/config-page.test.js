'use strict';

/**
 * Página /configure y rutas del servidor.
 */

const test = require('node:test');
const assert = require('node:assert');
const { renderConfigPage } = require('../lib/configPage');
const { createApp } = require('../lib/server');
const manifest = require('../manifest.json');

test('la página contiene todos los controles de configuración', () => {
  const html = renderConfigPage({ config: {}, manifest });

  // Idioma
  for (const valor of ['ambos', 'latino', 'ingles']) {
    assert.ok(html.includes(`name="idioma" value="${valor}"`), `falta la opción de idioma ${valor}`);
  }
  // Fuentes
  for (const valor of ['ht', 'knaben', 'tbb', 'tcsv']) {
    assert.ok(html.includes(`name="fuente" value="${valor}"`), `falta la fuente ${valor}`);
  }
  // Calidad, orden y máximo
  for (const valor of ['cualquiera', '720p', '1080p', '4k']) {
    assert.ok(html.includes(`value="${valor}"`), `falta la calidad ${valor}`);
  }
  for (const valor of ['latino', 'seeders', 'calidad']) {
    assert.ok(html.includes(`value="${valor}"`), `falta el orden ${valor}`);
  }
  assert.ok(html.includes('name="max"'));
  assert.ok(html.includes('name="packs"'));
  // Acciones
  assert.ok(html.includes('Instalar en Stremio'));
  assert.ok(html.includes('Copiar URL'));
  assert.ok(html.includes('stremio://'));
});

test('la página respeta la configuración recibida (query)', () => {
  const html = renderConfigPage({
    config: { idioma: 'latino', fuentes: 'ht,tbb', calidad: '1080p', orden: 'seeders', max: '40', packs: '0' },
    manifest
  });

  assert.ok(/name="idioma" value="latino" checked/.test(html));
  assert.ok(/name="fuente" value="ht" checked/.test(html));
  assert.ok(!/name="fuente" value="knaben" checked/.test(html));
  assert.ok(/name="fuente" value="tbb" checked/.test(html));
  assert.ok(/<option value="1080p" selected>/.test(html));
  assert.ok(/<option value="seeders" selected>/.test(html));
  assert.ok(/<option value="40" selected>/.test(html));
  assert.ok(!/name="packs" checked/.test(html), 'packs debe quedar desmarcado');
});

test('la página construye la URL con la config codificada (protocolo Stremio)', () => {
  const html = renderConfigPage({ config: {}, manifest });
  assert.ok(html.includes("encodeURIComponent(json)"));
  assert.ok(html.includes("'/manifest.json'"));
  assert.ok(html.includes('window.location.origin'), 'debe usar el origen real (detrás de proxy)');
  assert.ok(!html.includes('http://localhost'), 'no debe apuntar a localhost');
  assert.ok(!html.includes('127.0.0.1'), 'no debe apuntar a 127.0.0.1');
});

test('la página escapa el contenido del manifest', () => {
  const html = renderConfigPage({
    config: {},
    manifest: { name: '<script>alert(1)</script>', version: '1.4.0' }
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('servidor: / redirige a /configure, /health responde y /configure sirve HTML', async () => {
  const addonInterface = require('../index');
  const app = createApp(addonInterface);
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const raiz = await fetch(`${base}/`, { redirect: 'follow' });
    assert.strictEqual(raiz.status, 200);
    assert.ok(raiz.url.endsWith('/configure'), `debería acabar en /configure (fue ${raiz.url})`);

    const conf = await fetch(`${base}/configure?idioma=ingles&fuentes=knaben`);
    assert.strictEqual(conf.status, 200);
    assert.match(conf.headers.get('content-type') || '', /text\/html/);
    const html = await conf.text();
    assert.ok(/name="idioma" value="ingles" checked/.test(html));
    assert.ok(/name="fuente" value="knaben" checked/.test(html));

    const salud = await fetch(`${base}/health`);
    assert.strictEqual(salud.status, 200);
    const json = await salud.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.version, manifest.version);

    const mf = await fetch(`${base}/manifest.json`);
    assert.strictEqual(mf.status, 200);
    const manifestServido = await mf.json();
    assert.strictEqual(manifestServido.behaviorHints.configurable, true);
    assert.ok(Array.isArray(manifestServido.config) && manifestServido.config.length >= 6);
  } finally {
    server.close();
  }
});

test('servidor: manifest con configuración en la URL y stream con config', async () => {
  const addonInterface = require('../index');
  const app = createApp(addonInterface);
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfg = encodeURIComponent(JSON.stringify({ idioma: 'latino', fuentes: 'ht' }));

    const mf = await fetch(`${base}/${cfg}/manifest.json`);
    assert.strictEqual(mf.status, 200);
    const manifestServido = await mf.json();
    // Ya instalado: el SDK quita "configurable" para no reconfigurar desde la app
    assert.ok(manifestServido.config);

    const stream = await fetch(`${base}/${cfg}/stream/movie/tt0848228.json`);
    assert.strictEqual(stream.status, 200);
    const payload = await stream.json();
    assert.ok(Array.isArray(payload.streams));

    // Rutas dedicadas en Español (/es/manifest.json) e Inglés (/en/manifest.json)
    const mfEs = await (await fetch(`${base}/es/manifest.json`)).json();
    assert.strictEqual(mfEs.name, 'UniverTorrent');
    assert.ok(mfEs.description.includes('Español'));

    const mfEn = await (await fetch(`${base}/en/manifest.json`)).json();
    assert.strictEqual(mfEn.name, 'UniverTorrent');
    assert.ok(mfEn.description.includes('English'));
    assert.ok(mfEn.catalogs.some(c => c.name === 'UniverTorrent - Movies'));
  } finally {
    server.close();
  }
});
