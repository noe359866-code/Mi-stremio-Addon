'use strict';

/**
 * Tests de The Black Hole Bay (tercera fuente, desactivada por defecto).
 * Usa respuestas reales capturadas de https://theblackholebay.lol/api/search
 */

process.env.KNABEN_MIN_INTERVAL_MS = '0';
process.env.BLACKHOLEBAY_ENABLED = '1';
process.env.BLACKHOLEBAY_MIN_INTERVAL_MS = '0';

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const TBB = require('../lib/theblackholebay');

const axiosGetOriginal = axios.get;

const FIXTURES = {
  'the avengers': require('./fixtures/blackholebay-avengers.json'),
  'breaking bad s02e05': require('./fixtures/blackholebay-breaking-bad.json')
};

let consultas = [];

function stubTBB(resolver = (q) => FIXTURES[q.toLowerCase()] || { results: [] }) {
  consultas = [];
  axios.get = async (url) => {
    const u = String(url);
    if (!u.includes('theblackholebay.lol')) throw new Error(`stub sin ruta: ${u}`);
    const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
    consultas.push(q);
    return { status: 200, headers: {}, data: resolver(q) };
  };
  TBB._limpiarCache();
}

test.afterEach(() => {
  axios.get = axiosGetOriginal;
  TBB._limpiarCache();
});

test('siempre pide la categoría de vídeo (200)', async () => {
  let urlPedida = null;
  axios.get = async (url) => { urlPedida = String(url); return { status: 200, data: { results: [] } }; };
  await TBB.buscarStreams({ title: 'Dune', year: '2021', type: 'movie' });
  assert.ok(urlPedida.includes('category=200'));
});

test('categorías: sólo 200-299 son vídeo', () => {
  assert.strictEqual(TBB._esCategoriaVideo(200), true);
  assert.strictEqual(TBB._esCategoriaVideo(207), true);
  assert.strictEqual(TBB._esCategoriaVideo(208), true);
  assert.strictEqual(TBB._esCategoriaVideo(100), false); // música
  assert.strictEqual(TBB._esCategoriaVideo(500), false); // adulto
  assert.strictEqual(TBB._esCategoriaVideo('200'), true);
});

test('API real: película 2012 ignora secuelas, series homónimas y bandas sonoras', async () => {
  stubTBB();
  const streams = await TBB.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });

  const hashes = streams.map(s => s.infoHash);
  assert.deepStrictEqual(hashes.sort(), [
    '0bbca7584749d4e741747e32e6eb588aea03e40f', // 720p YIFY 2012
    'dd3753312f428b1e282000ccb684f462f62a5f54', // GalaxyRG 2012
    'e9f759b6a26113f3745311dad4bd332b4612eb60'  // 1080p YIFY 2012 (más seeders → primero)
  ].sort());

  assert.strictEqual(streams[0].infoHash, 'e9f759b6a26113f3745311dad4bd332b4612eb60');
  assert.ok(streams[0].title.includes('YIFY'));
  assert.ok(streams[0].name.startsWith('Black Hole Bay'));
  assert.ok(!hashes.includes('aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00'), 'no Age of Ultron (2015)');
  assert.ok(!hashes.includes('bb00bb00bb00bb00bb00bb00bb00bb00bb00bb00'), 'no Infinity War (2018)');
  assert.ok(!hashes.includes('cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00'), 'no la serie S01E01');
  assert.ok(!hashes.includes('dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00'), 'no la banda sonora (categoría Audio)');
});

test('API real: S02E05 sólo devuelve el episodio exacto o packs de la T2', async () => {
  stubTBB();
  const streams = await TBB.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 5
  });
  const hashes = streams.map(s => s.infoHash);

  assert.ok(hashes.includes('0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'), 'episodio exacto');
  assert.ok(!hashes.includes('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'), 'no "The Bad Guys Breaking In"');
  assert.ok(!hashes.includes('bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'), 'no S03E01');
  assert.strictEqual(streams[0].infoHash, '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
    'el episodio exacto va antes que los packs');

  // "Breaking Bad Season 2 Complete" es un pack de la T2 → válido, marcado como pack
  const packs = streams.filter(s => s.infoHash === '3b55ea2f9f5fa8d38894fe7fbe4d82db2a549ee5');
  assert.strictEqual(packs.length, 1);
  assert.ok(packs[0].title.includes('Temporada completa'));

  // Packs de otras temporadas quedan fuera
  assert.ok(!hashes.includes('b43df67a93863ea91f2f773f00361072da771dd3'), 'no S01-S05');
  assert.ok(!hashes.includes('33b1396389a7d76f57215ee618f0ce438126ebe4'), 'no S01-S05 MkvCage');
});

test('API real: sin episodio disponible devuelve [] (no otro capítulo)', async () => {
  stubTBB();
  const streams = await TBB.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 4, episode: 9
  });
  assert.deepStrictEqual(streams, []);
});

test('sólo consulta el título si la primera búsqueda no dio nada válido', async () => {
  stubTBB((q) => (q.toLowerCase().includes('s02e05') ? { results: [] } : FIXTURES['breaking bad s02e05']));
  await TBB.buscarStreams({ title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 5 });
  assert.deepStrictEqual(consultas, ['Breaking Bad S02E05', 'Breaking Bad']);
});

test('no repite la búsqueda genérica si la primera ya fue válida', async () => {
  stubTBB();
  await TBB.buscarStreams({ title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 5 });
  assert.deepStrictEqual(consultas, ['Breaking Bad S02E05']);
});

test('desactivada por defecto: no hace ninguna petición', async () => {
  // Se evalúa el flag al cargar el módulo; aquí comprobamos el valor por defecto real
  const { execFileSync } = require('node:child_process');
  const salida = execFileSync(process.execPath, ['-e', `
    delete process.env.BLACKHOLEBAY_ENABLED;
    const m = require('./lib/theblackholebay');
    process.stdout.write(String(m.BLACKHOLEBAY_ENABLED));
  `], { cwd: process.cwd() }).toString();
  assert.strictEqual(salida, 'false');
});

test('si la API falla, devuelve [] y no rompe', async () => {
  axios.get = async () => { throw new Error('ETIMEDOUT'); };
  const streams = await TBB.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.deepStrictEqual(streams, []);
});

test('acepta info_hash sin magnet y lo completa con trackers', async () => {
  stubTBB(() => ({
    results: [{
      id: 'idx_1', name: 'The Avengers 2012 1080p BRrip', info_hash: 'AB'.repeat(20),
      magnet: null, seeders: 10, leechers: 1, size: 2000000000, category: 207, source: 'DHT'
    }]
  }));
  const streams = await TBB.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(streams.length, 1);
  assert.ok(streams[0].url.startsWith('magnet:?xt=urn:btih:' + 'AB'.repeat(20)));
  assert.ok(streams[0].url.includes('tr='));
  assert.strictEqual(streams[0].infoHash, 'ab'.repeat(20));
});

test('fusiona las tres fuentes sin duplicar el mismo infoHash', async () => {
  const { buscarEnFuentesExternas } = require('../index')._internals;
  // Knaben y TBB comparten el hash del YIFY 2012 → debe aparecer una sola vez
  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('api.knaben.org')) {
      return {
        status: 200, data: { hits: [{
          title: 'The Avengers 2012 1080p BRrip X264 - 2.2GB - YIFY', category: 'Movies / HD',
          bytes: 2358615969, hash: 'E9F759B6A26113F3745311DAD4BD332B4612EB60',
          magnetUrl: 'magnet:?xt=urn:btih:E9F759B6A26113F3745311DAD4BD332B4612EB60',
          seeders: 500, peers: 10, liveSeeders: 500, livePeers: 10
        }] }
      };
    }
    if (u.includes('theblackholebay')) return { status: 200, data: FIXTURES['the avengers'] };
    throw new Error('ruta inesperada');
  };

  const { _limpiarCache } = require('../lib/knaben');
  _limpiarCache();
  TBB._limpiarCache();

  const streams = await buscarEnFuentesExternas({
    title: 'The Avengers', year: '2012', type: 'movie'
  });

  const hashes = streams.map(s => s.infoHash);
  assert.strictEqual(new Set(hashes).size, hashes.length, 'sin duplicados entre fuentes');
  assert.strictEqual(hashes.filter(h => h === 'e9f759b6a26113f3745311dad4bd332b4612eb60').length, 1);
  assert.ok(streams.some(s => s.name.startsWith('Knaben')));
  assert.ok(streams.some(s => s.name.startsWith('Black Hole Bay')));
});
