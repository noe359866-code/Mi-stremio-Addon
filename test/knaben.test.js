'use strict';

/**
 * Tests de la fuente Knaben (inglés) con la API simulada.
 * Foco: filtrado estricto (título como frase, categoría de vídeo, año y SxxExx).
 */

const test = require('node:test');
const assert = require('node:assert');
process.env.KNABEN_MIN_INTERVAL_MS = '0';
const axios = require('axios');

const Knaben = require('../lib/knaben');

const axiosGetOriginal = axios.get;

function hit({ title, category = 'Movies / HD', hash, bytes = 2000000000, seeders = 10, peers = 2, magnet = undefined, tracker = 'The Pirate Bay' }) {
  return {
    title,
    category,
    categoryId: [2000000],
    bytes,
    hash: hash === undefined ? 'a'.repeat(40) : hash,
    magnetUrl: magnet === undefined ? (hash === null ? null : `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`) : magnet,
    seeders,
    peers,
    liveSeeders: seeders,
    livePeers: peers,
    tracker,
    details: 'https://knaben.xyz/x'
  };
}

/** Instala un stub que responde según la query. */
function stubKnaben(respuestasPorQuery) {
  axios.get = async (url) => {
    const u = String(url);
    if (!u.includes('api.knaben.org')) throw new Error(`stub sin ruta: ${u}`);
    const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
    const hits = typeof respuestasPorQuery === 'function'
      ? respuestasPorQuery(q)
      : (respuestasPorQuery[q] || []);
    return { status: 200, headers: {}, data: { hits } };
  };
  Knaben._limpiarCache();
}

test.afterEach(() => {
  axios.get = axiosGetOriginal;
  Knaben._limpiarCache();
});

// ------------------------- helpers de filtrado -------------------------

test('título como frase: acepta el título al inicio del release', () => {
  assert.strictEqual(Knaben._contieneTitulo('Breaking Bad', 'Breaking Bad S02E05 Breakage 2160p NF WEB-DL'), true);
  assert.strictEqual(Knaben._contieneTitulo('The Avengers', 'The.Avengers.2012.1080p.BluRay.DDP5.1.x265-GalaxyRG265'), true);
  assert.strictEqual(Knaben._contieneTitulo('From', 'From S01E02 1080p WEB-DL'), true);
});

test('título como frase: rechaza títulos que sólo comparten palabras', () => {
  // El caso real que devolvía Knaben al buscar "breaking bad s02e05"
  assert.strictEqual(Knaben._contieneTitulo('Breaking Bad', 'The Bad Guys Breaking In S02E05 1080p 10bit WEBRip'), false);
  assert.strictEqual(Knaben._contieneTitulo('The Avengers', 'Avengers Infinity War 2018 1080p'), false);
  assert.strictEqual(Knaben._contieneTitulo('Dune', 'Dune Part Two 2024 1080p'), true);
  // Título de una palabra: debe ser la primera palabra del release
  assert.strictEqual(Knaben._contieneTitulo('From', 'From S01E02 1080p WEB-DL'), true);
  assert.strictEqual(Knaben._contieneTitulo('From', 'Some Show From 2020 S01E02'), false);
});

test('categorías: sólo vídeo del tipo pedido', () => {
  assert.strictEqual(Knaben._categoriaCompatible('Movies / HD', 'movie'), true);
  assert.strictEqual(Knaben._categoriaCompatible('TV / HD', 'movie'), false);
  assert.strictEqual(Knaben._categoriaCompatible('TV / UHD', 'series'), true);
  assert.strictEqual(Knaben._categoriaCompatible('Anime', 'series'), true);
  assert.strictEqual(Knaben._categoriaCompatible('Audio / MP3', 'movie'), false);
  assert.strictEqual(Knaben._categoriaCompatible('Books / Ebooks', 'series'), false);
  assert.strictEqual(Knaben._categoriaCompatible('XXX', 'movie'), false);
});

test('calidad y tamaño legibles', () => {
  assert.strictEqual(Knaben._calidadDeNombre('X 2160p WEB-DL'), '4K');
  assert.strictEqual(Knaben._calidadDeNombre('X 1080p BluRay'), '1080p');
  assert.strictEqual(Knaben._calidadDeNombre('X 720p HDTV'), '720p');
  assert.strictEqual(Knaben._bytesAHumano(2362232012), '2.20 GB');
  assert.strictEqual(Knaben._ultimoAnio('The.Avengers.2012.1080p'), 2012);
});

// ------------------------- búsqueda de películas -------------------------

test('película: filtra por año, categoría y título; ignora audios y series', async () => {
  const YIFY = 'E9F759B6A26113F3745311DAD4BD332B4612EB60';
  stubKnaben({
    'The Avengers': [
      hit({ title: 'The Avengers 2012 1080p BRrip X264 - 2.2GB - YIFY', hash: YIFY, seeders: 560 }),
      hit({ title: 'The Avengers Age of Ultron 2015 1080p BluRay', hash: 'b'.repeat(40), seeders: 300 }),
      hit({ title: 'The Avengers Infinity War 2018 1080p WEB-DL', hash: 'c'.repeat(40), seeders: 200 }),
      hit({ title: 'The Avengers S01E01 1080p', category: 'TV / HD', hash: 'd'.repeat(40), seeders: 100 }),
      hit({ title: 'The Avengers 2012 MP3', category: 'Audio / MP3', hash: 'e'.repeat(40), seeders: 50 })
    ]
  });

  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(streams.length, 1);
  assert.strictEqual(streams[0].url, undefined);
  assert.strictEqual(streams[0].infoHash, YIFY.toLowerCase());
  assert.ok(streams[0].sources.includes(`dht:${YIFY.toLowerCase()}`));
  assert.ok(streams[0].title.includes('YIFY'));
  assert.ok(streams[0].name.startsWith('Knaben'));
  assert.ok(streams[0].title.includes('Inglés'));
});

test('película: sin magnet ni hash no se devuelve nada', async () => {
  stubKnaben({
    'The Avengers': [hit({ title: 'The Avengers 2012 1080p', hash: null, magnet: null })]
  });
  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.deepStrictEqual(streams, []);
});

test('película: si sólo hay hits de hash, construye el stream Torrent con infoHash y trackers', async () => {
  const HASH = 'F'.repeat(40);
  stubKnaben({
    'The Avengers': [hit({ title: 'The Avengers 2012 1080p BluRay', hash: HASH, magnet: null })]
  });
  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(streams.length, 1);
  assert.strictEqual(streams[0].url, undefined);
  assert.strictEqual(streams[0].infoHash, HASH.toLowerCase());
  assert.ok(streams[0].sources.some(s => s.startsWith('tracker:')));
  assert.ok(streams[0].sources.includes(`dht:${HASH.toLowerCase()}`));
});

// ------------------------- búsqueda de series -------------------------

test('serie: sólo el episodio exacto o packs de ESA temporada', async () => {
  stubKnaben((q) => {
    if (/s02e05/i.test(q)) {
      return [
        hit({ title: 'Breaking Bad S02E05 Breakage 2160p NF WEB-DL DDP5 1 H 265-XEBEC', category: 'TV / UHD', hash: '1'.repeat(40), seeders: 34 }),
        hit({ title: 'The Bad Guys Breaking In S02E05 1080p WEB-DL', category: 'TV / HD', hash: '2'.repeat(40), seeders: 3 }),
        hit({ title: 'Breaking Bad S02E06 1080p WEB-DL', category: 'TV / HD', hash: '3'.repeat(40), seeders: 40 }),
        hit({ title: 'Breaking Bad S01 COMPLETE 1080p', category: 'TV / HD', hash: '4'.repeat(40), seeders: 700 })
      ];
    }
    // búsqueda sin episodio (para packs)
    return [
      hit({ title: 'Breaking Bad Season 2 COMPLETE 1080p BluRay', category: 'TV / HD', hash: '5'.repeat(40), seeders: 120 }),
      hit({ title: 'Breaking Bad (2008) Season 1-5 S01-S05 1080p', category: 'TV / HD', hash: '6'.repeat(40), seeders: 500 })
    ];
  });

  const streams = await Knaben.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 5
  });

  const hashes = streams.map(s => s.infoHash);
  assert.ok(hashes.includes('1'.repeat(40)), 'debe incluir el episodio exacto');
  assert.ok(!hashes.includes('2'.repeat(40)), 'no debe incluir otra serie con el mismo patrón');
  assert.ok(!hashes.includes('3'.repeat(40)), 'no debe incluir otro episodio');
  assert.ok(!hashes.includes('4'.repeat(40)), 'no debe incluir otra temporada');
  assert.ok(hashes.includes('5'.repeat(40)), 'debe incluir el pack de la temporada 2');
  assert.ok(!hashes.includes('6'.repeat(40)), 'no debe incluir packs de temporadas mezcladas');

  // El episodio exacto va primero
  assert.strictEqual(streams[0].infoHash, '1'.repeat(40));
  // El pack se marca como tal
  const pack = streams.find(s => s.infoHash === '5'.repeat(40));
  assert.ok(pack.title.includes('Temporada completa'));
});

test('serie sin episodio (ficha/temporada): devuelve los matches del título', async () => {
  stubKnaben({
    'Breaking Bad': [
      hit({ title: 'Breaking Bad S02E05 1080p', category: 'TV / HD', hash: '7'.repeat(40) }),
      hit({ title: 'Better Call Saul S01E01 1080p', category: 'TV / HD', hash: '8'.repeat(40) })
    ]
  });
  const streams = await Knaben.buscarStreams({ title: 'Breaking Bad', year: '2008', type: 'series' });
  assert.deepStrictEqual(streams.map(s => s.infoHash), ['7'.repeat(40)]);
});

test('deduplica el mismo torrent servido por dos trackers', async () => {
  const HASH = '9'.repeat(40);
  stubKnaben({
    'The Avengers': [
      hit({ title: 'The Avengers 2012 1080p', hash: HASH, seeders: 100 }),
      hit({ title: 'The Avengers 2012 1080p', hash: HASH, seeders: 100, tracker: '1337x' })
    ]
  });
  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(streams.length, 1);
});

test('si Knaben falla, devuelve [] y no rompe', async () => {
  axios.get = async () => { throw new Error('ETIMEDOUT'); };
  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });
  assert.deepStrictEqual(streams, []);
});

test('fusiona resultados de HackTorrent + Knaben sin duplicar infoHash', () => {
  const { fusionarStreams } = require('../index')._internals;
  const ht = [
    { name: 'HackTorrent\n1080p', infoHash: 'a'.repeat(40) },
    { name: 'HackTorrent\n720p', infoHash: 'b'.repeat(40) }
  ];
  const knaben = [
    { name: 'Knaben\n1080p', infoHash: 'a'.repeat(40) },
    { name: 'Knaben\n4K', infoHash: 'c'.repeat(40) }
  ];
  const fusion = fusionarStreams(ht, knaben);
  assert.strictEqual(fusion.length, 3);
  assert.strictEqual(fusion[0].name.startsWith('HackTorrent'), true, 'los de HackTorrent van primero');
  assert.strictEqual(fusion[2].name.startsWith('Knaben'), true);
});

// ------------------- respuestas REALES capturadas de api.knaben.org/v2 -------------------
const FIXTURES = {
  'the avengers': require('./fixtures/knaben-avengers.json').hits,
  'breaking bad s02e05': require('./fixtures/knaben-breaking-bad-s02e05.json').hits,
  'breaking bad': require('./fixtures/knaben-breaking-bad-packs.json').hits
};

test('API real: "The Avengers" 2012 acepta sólo releases de esa película', async () => {
  stubKnaben((q) => FIXTURES[q.toLowerCase()] || []);
  const streams = await Knaben.buscarStreams({ title: 'The Avengers', year: '2012', type: 'movie' });

  const hashes = streams.map(s => s.infoHash);
  assert.deepStrictEqual(hashes.sort(), [
    '71b582cddc2bc4c780ff7eaa6fa7ef4d71bb5f62', // RuTracker (doblada, mismo año)
    'dd3753312f428b1e282000ccb684f462f62a5f54', // GalaxyRG 2012
    'e9f759b6a26113f3745311dad4bd332b4612eb60'  // YIFY 2012 (más seeders, primero)
  ].sort());
  assert.strictEqual(streams[0].infoHash, 'e9f759b6a26113f3745311dad4bd332b4612eb60');
  assert.ok(streams[0].title.includes('1080p'));
  assert.ok(/Inglés|Castellano|Latino/.test(streams[0].title));
});

test('API real: "Breaking Bad" S02E05 descarta "The Bad Guys Breaking In"', async () => {
  stubKnaben((q) => FIXTURES[q.toLowerCase()] || []);
  const streams = await Knaben.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 5
  });
  const hashes = streams.map(s => s.infoHash);
  assert.ok(!hashes.includes('8c25abf46cb9496faa201f85ea895bb70084e0db'), 'no debe colar otra serie');
  assert.ok(hashes.includes('f0dad5c765ff1c579db67a6465041896e5b10cff'), '2160p de Breaking Bad S02E05');
  assert.ok(hashes.includes('8d8d78e9d6fe8384abcdd30c5045e75d0b639ed1'), 'HDTV de Breaking Bad S02E05');
});

test('API real: packs de otras temporadas no se usan para S02E05', async () => {
  stubKnaben((q) => FIXTURES[q.toLowerCase()] || []);
  const streams = await Knaben.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 3, episode: 1
  });
  // Sólo hay S02E05 y packs de S01/Season 2/1-5 → nada válido para S03E01
  assert.deepStrictEqual(streams, []);
});

test('API real: para la temporada 2 se acepta el pack "Season 2"', async () => {
  stubKnaben((q) => FIXTURES[q.toLowerCase()] || []);
  const streams = await Knaben.buscarStreams({
    title: 'Breaking Bad', year: '2008', type: 'series', season: 2, episode: 8
  });
  const hashes = streams.map(s => s.infoHash);
  assert.ok(hashes.includes('450de97a0c347ad8fd641f45b2d045bf67c7e740'), 'pack de la temporada 2');
  assert.ok(!hashes.includes('6bbad06245a0d631b0a5e47c8cd6e5abc9a70211'), 'pack de la temporada 1');
  assert.ok(!hashes.includes('b43df67a93863ea91f2f773f00361072da771dd3'), 'pack de temporadas 1-5');
  assert.ok(streams.every(s => s.title.includes('Temporada completa')));
});
