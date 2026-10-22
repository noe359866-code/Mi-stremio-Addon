'use strict';

/**
 * Tests integrales de regresión para:
 *  1. CORS universal en TODAS las rutas (`/manifest.json`, `/es/manifest.json`,
 *     `/en/manifest.json`, `/:config/manifest.json`, `/:config/stream/...`, `OPTIONS`)
 *     tanto en Express como en Netlify Functions.
 *  2. Ruta `/:config/configure` (botón ⚙️ Configurar dentro de Stremio) y soporte
 *     de cualquier codificación de configuración (`%7B...%7D`, `{...}`, `es`, `en`, `k=v&...`).
 *  3. Coherencia de `/configure` (JavaScript embebido válido, desactivación real de `pp`/`ss`,
 *     activación explícita de `tbb` sin requerir env, fallback de portapapeles e instalación Web,
 *     y ausencia total de subdominios `baby-beamup.club` inexistentes).
 *  4. Aislamiento por fuente (`ADDON_SOURCE_TIMEOUT_MS`): si una o varias fuentes se cuelgan
 *     o devuelven 403/timeout, las fuentes rápidas entregan sus streams intactos sin perderlos.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const axios = require('axios');

const addonInterface = require('../index');
const { createApp } = require('../lib/server');
const { renderConfigPage } = require('../lib/configPage');
const { handler: netlifyHandler } = require('../netlify/functions/addon');
const { aplicarConfig } = require('../lib/config');
const HT = require('../lib/hacktorrent');
const Scraper = require('../lib/scraper');
const PelisPanda = require('../lib/pelispanda');
const SinSitio = require('../lib/sinsitio');
const Knaben = require('../lib/knaben');
const TorrentsCsv = require('../lib/torrentsCsv');
const BlackHoleBay = require('../lib/theblackholebay');
const manifest = require('../manifest.json');

test('CORS universal y /:config/configure funcionan en todas las variantes de URL (Express + Netlify)', async () => {
  const app = createApp(addonInterface);
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cfgJson = encodeURIComponent(JSON.stringify({
      idioma: 'latino',
      fuentes: 'ht,knaben,tcsv',
      calidad: '1080p',
      orden: 'seeders',
      max: 40,
      packs: false
    }));

    // 1) Todas las rutas de manifest incluyen Access-Control-Allow-Origin: *
    for (const ruta of [
      '/manifest.json',
      '/es/manifest.json',
      '/en/manifest.json',
      `/${cfgJson}/manifest.json`,
      '/idioma=latino&calidad=1080p/manifest.json'
    ]) {
      const res = await fetch(`${base}${ruta}`, {
        headers: { Origin: 'https://web.stremio.com' }
      });
      assert.strictEqual(res.status, 200, `status inesperado en ${ruta}`);
      assert.strictEqual(
        res.headers.get('access-control-allow-origin'),
        '*',
        `falta CORS en ${ruta}`
      );
      const body = await res.json();
      assert.deepStrictEqual(body.resources, ['stream']);
      assert.deepStrictEqual(body.catalogs, []);
    }

    // 2) Preflight OPTIONS desde Stremio Web responde con CORS
    const preflight = await fetch(`${base}/${cfgJson}/manifest.json`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://web.stremio.com',
        'Access-Control-Request-Method': 'GET'
      }
    });
    assert.ok(preflight.status >= 200 && preflight.status < 300);
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), '*');

    // 3) Reconfiguración desde Stremio (`/:config/configure`) restaura los controles guardados
    const reconf = await fetch(`${base}/${cfgJson}/configure`);
    assert.strictEqual(reconf.status, 200);
    assert.match(reconf.headers.get('content-type') || '', /text\/html/);
    const html = await reconf.text();
    assert.ok(/name="idioma" value="latino" checked/.test(html));
    assert.ok(/name="fuente" value="ht" checked/.test(html));
    assert.ok(!/name="fuente" value="pp" checked/.test(html), 'pp fue desmarcado y debe permanecer desmarcado');
    assert.ok(!/name="fuente" value="ss" checked/.test(html), 'ss fue desmarcado y debe permanecer desmarcado');
    assert.ok(/name="fuente" value="knaben" checked/.test(html));
    assert.ok(/name="fuente" value="tcsv" checked/.test(html));
    assert.ok(/<option value="1080p" selected>/.test(html));
    assert.ok(/<option value="seeders" selected>/.test(html));
    assert.ok(/<option value="40" selected>/.test(html));
    assert.ok(!/name="packs" checked/.test(html));

    // 4) También en Netlify Functions: CORS en /:config/manifest.json y 200 en /:config/configure
    const nlManifest = await netlifyHandler({
      path: `/${cfgJson}/manifest.json`,
      rawUrl: `https://mi-addon.netlify.app/${cfgJson}/manifest.json`,
      httpMethod: 'GET',
      headers: { host: 'mi-addon.netlify.app', origin: 'https://web.stremio.com' }
    }, {});
    assert.strictEqual(nlManifest.statusCode, 200);
    assert.strictEqual(
      nlManifest.headers['access-control-allow-origin'] || nlManifest.headers['Access-Control-Allow-Origin'],
      '*'
    );

    const nlConfigure = await netlifyHandler({
      path: `/${cfgJson}/configure`,
      rawUrl: `https://mi-addon.netlify.app/${cfgJson}/configure`,
      httpMethod: 'GET',
      headers: { host: 'mi-addon.netlify.app' }
    }, {});
    assert.strictEqual(nlConfigure.statusCode, 200);
    assert.match(nlConfigure.body, /name="idioma" value="latino" checked/);
  } finally {
    server.close();
  }
});

test('/configure genera JS válido sin errores de sintaxis, con fallback de copia e instalación Stremio Web', () => {
  const html = renderConfigPage({ config: {}, manifest });

  assert.ok(html.includes('id="instalar-web"'), 'debe ofrecer botón directo para Stremio Web');
  assert.ok(html.includes('copiarConFallback'), 'debe incluir fallback de copia para iframes/WebViews');
  assert.ok(!html.includes('baby-beamup.club'), 'no debe contener dominios baby-beamup.club inexistentes');

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch, 'la página debe incluir su bloque <script>');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), 'el JS embebido en /configure debe compilar sin errores');
});

test('desmarcar pp y ss (`fuentes: "ht,knaben,tcsv"`) los excluye de verdad mientras que la config vacía los incluye', () => {
  const muestra = [
    {
      name: 'UniverTorrent\n1080p',
      title: 'PelisPanda stream',
      url: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      _meta: { fuente: 'pelispanda', idioma: 'Latino', calidad: '1080p', seeders: 20, pack: false }
    },
    {
      name: 'UniverTorrent\n1080p',
      title: 'SinSitio stream',
      url: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
      _meta: { fuente: 'sinsitio', idioma: 'Castellano', calidad: '1080p', seeders: 15, pack: false }
    },
    {
      name: 'UniverTorrent\n1080p',
      title: 'Knaben stream',
      url: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      _meta: { fuente: 'knaben', idioma: 'Inglés', calidad: '1080p', seeders: 100, pack: false }
    }
  ];

  // Sin `fuentes` explícito → PelisPanda, SinSitio y Knaben entran todos
  assert.strictEqual(aplicarConfig(muestra, {}).length, 3);

  // Con `fuentes: 'ht,knaben,tcsv'` explícito → PelisPanda y SinSitio quedan fuera
  const filtrados = aplicarConfig(muestra, { fuentes: 'ht,knaben,tcsv' });
  assert.deepStrictEqual(filtrados.map(s => s.title), ['Knaben stream']);
});

test('activar `tbb` en la configuración consulta BlackHoleBay aunque BLACKHOLEBAY_ENABLED no esté definida, y fuentes colgadas no bloquean al resto', async () => {
  const prevSourceTimeout = process.env.ADDON_SOURCE_TIMEOUT_MS;
  const origAxiosGet = axios.get;
  const origCinemeta = HT.getCinemeta;
  const origHtSearch = Scraper.buscarEnHackTorrent;
  const origPp = PelisPanda.buscarStreams;
  const origSs = SinSitio.buscarStreams;
  const origKnb = Knaben.buscarStreams;
  const origTcsv = TorrentsCsv.buscarStreams;

  process.env.ADDON_SOURCE_TIMEOUT_MS = '120';
  BlackHoleBay._limpiarCache();

  try {
    HT.getCinemeta = async () => ({
      name: 'Dune: Part Two',
      releaseInfo: '2024',
      moviedb_id: 693134
    });

    // Simulamos que HackTorrent, PelisPanda y SinSitio se quedan colgados indefinidamente
    Scraper.buscarEnHackTorrent = () => new Promise(() => {});
    PelisPanda.buscarStreams = () => new Promise(() => {});
    SinSitio.buscarStreams = () => new Promise(() => {});

    // Mientras tanto, Knaben, Torrents.csv y BlackHoleBay (`tbb` activado en config) responden rápido
    Knaben.buscarStreams = async () => ([{
      name: 'UniverTorrent\n1080p',
      title: 'Dune Part Two 2024 1080p WEB-DL',
      infoHash: 'd'.repeat(40),
      sources: [`dht:${'d'.repeat(40)}`],
      _meta: { fuente: 'knaben', idioma: 'Inglés', calidad: '1080p', seeders: 250, pack: false }
    }]);
    TorrentsCsv.buscarStreams = async () => ([{
      name: 'UniverTorrent\n4K',
      title: 'Dune Part Two 2024 2160p REMUX',
      infoHash: 'e'.repeat(40),
      sources: [`dht:${'e'.repeat(40)}`],
      _meta: { fuente: 'tcsv', idioma: 'Inglés', calidad: '4k', seeders: 180, pack: false }
    }]);
    axios.get = async () => ({
      data: {
        results: [{
          name: 'Dune Part Two 2024 1080p BluRay x264',
          info_hash: 'f'.repeat(40),
          category: 207,
          size: 8_500_000_000,
          seeders: 320,
          leechers: 14
        }]
      }
    });

    const inicio = Date.now();
    const respuesta = await addonInterface.get('stream', 'movie', 'tt15239678', {}, {
      fuentes: 'ht,pp,ss,knaben,tcsv,tbb'
    });
    const duracion = Date.now() - inicio;

    assert.ok(duracion < 1000, `las fuentes colgadas deben cortarse en ~120ms (tardó ${duracion}ms)`);
    assert.strictEqual(respuesta.streams.length, 3, 'debe conservar los streams de Knaben, Torrents.csv y BlackHoleBay');

    const hashes = respuesta.streams.map(s => s.infoHash).sort();
    assert.deepStrictEqual(hashes, ['d'.repeat(40), 'e'.repeat(40), 'f'.repeat(40)]);
    for (const s of respuesta.streams) {
      assert.strictEqual(s.url, undefined, 'nunca debe incluir url magnet');
      assert.ok(Array.isArray(s.sources) && s.sources.includes(`dht:${s.infoHash}`));
    }
  } finally {
    if (prevSourceTimeout === undefined) delete process.env.ADDON_SOURCE_TIMEOUT_MS;
    else process.env.ADDON_SOURCE_TIMEOUT_MS = prevSourceTimeout;
    axios.get = origAxiosGet;
    HT.getCinemeta = origCinemeta;
    Scraper.buscarEnHackTorrent = origHtSearch;
    PelisPanda.buscarStreams = origPp;
    SinSitio.buscarStreams = origSs;
    Knaben.buscarStreams = origKnb;
    TorrentsCsv.buscarStreams = origTcsv;
    BlackHoleBay._limpiarCache();
  }
});
