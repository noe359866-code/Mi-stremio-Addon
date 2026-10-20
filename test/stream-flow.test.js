'use strict';

/**
 * Test end-to-end del handler de streams con la red simulada.
 * Verifica que el addon NUNCA devuelve un torrent de otra película/serie/episodio.
 */

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const MAGNET = (hash, dn) =>
  `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce`;

const H = {
  avengers2012: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  ultron2015: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
  infinity2018: 'cccc3333cccc3333cccc3333cccc3333cccc3333',
  serieAvengers: 'dddd4444dddd4444dddd4444dddd4444dddd4444',
  bb0101: 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',
  bb0205: 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2',
  bb0206: 'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6',
  from0102: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
  naruto01: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0',
  naruto03: 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3'
};

const SEARCH = {
  'the avengers': [
    { title: 'Avengers: Age of Ultron', original_title: 'Avengers: Age of Ultron', slug: 'avengers-age-of-ultron', year: '2015', type: 'pelicula' },
    { title: 'Avengers: Infinity War', original_title: 'Avengers: Infinity War', slug: 'avengers-infinity-war', year: '2018', type: 'pelicula' },
    { title: 'Avengers: Los Vengadores', original_title: 'The Avengers', slug: 'avengers-los-vengadores', year: '2012', type: 'pelicula' },
    // Trampa: una serie con el mismo título; jamás debe usarse para una película
    { title: 'The Avengers', original_title: 'The Avengers', slug: 'the-avengers-serie', year: '1961', type: 'serie' }
  ],
  'breaking bad': [
    { title: 'Breaking Bad', original_title: 'Breaking Bad', slug: 'breaking-bad', year: '2008', type: 'serie' },
    { title: 'El Camino: Una película de Breaking Bad', original_title: 'El Camino: A Breaking Bad Movie', slug: 'el-camino', year: '2019', type: 'pelicula' }
  ],
  'from': [
    { title: 'From', original_title: 'FROM', slug: 'from', year: '2022', type: 'serie' }
  ],
  'naruto': [
    { title: 'Naruto', original_title: 'Naruto', slug: 'naruto', year: '2002', type: 'anime' }
  ],
  'akira': [
    { title: 'Akira', original_title: 'Akira', slug: 'akira', year: '1988', type: 'anime' }
  ],
  'dune': [
    { title: 'Dune: Parte Dos', original_title: 'Dune: Part Two', slug: 'dune-parte-dos', year: '2024', type: 'pelicula' }
  ]
};

const DETAILS = {
  'movie/avengers-los-vengadores': {
    slug: 'avengers-los-vengadores', title: 'Avengers: Los Vengadores', original_title: 'The Avengers', type: 'pelicula', year: '2012',
    downloads: [
      { quality: 'WEB-DL 1080p', size: '5.66 GB', language: 'Latino', subs: 1, download_link: MAGNET(H.avengers2012, 'Avengers.Los.Vengadores.2012.1080p-Lat') }
    ]
  },
  'movie/avengers-age-of-ultron': {
    slug: 'avengers-age-of-ultron', title: 'Avengers: Era de Ultrón', original_title: 'Avengers: Age of Ultron', type: 'pelicula', year: '2015',
    downloads: [{ quality: '1080p', size: '4 GB', language: 'Latino', subs: 1, download_link: MAGNET(H.ultron2015, 'Avengers.Age.of.Ultron.2015.1080p') }]
  },
  'movie/avengers-infinity-war': {
    slug: 'avengers-infinity-war', title: 'Avengers: Infinity War', original_title: 'Avengers: Infinity War', type: 'pelicula', year: '2018',
    downloads: [{ quality: '1080p', size: '4 GB', language: 'Latino', subs: 1, download_link: MAGNET(H.infinity2018, 'Avengers.Infinity.War.2018.1080p') }]
  },
  'serie/the-avengers-serie': {
    slug: 'the-avengers-serie', title: 'The Avengers', type: 'serie', year: '1961',
    downloads: [{ quality: '480p', size: '300 MB', language: 'Inglés', subs: 0, season: 1, episode: 1, download_link: MAGNET(H.serieAvengers, 'The.Avengers.S01E01.480p') }]
  },
  'serie/breaking-bad': {
    slug: 'breaking-bad', title: 'Breaking Bad', original_title: 'Breaking Bad', type: 'serie', year: '2008',
    downloads: [
      { quality: 'WEB-DL 1080p', size: '2.68 GB', language: 'Latino/Inglés', subs: 1, season: 1, episode: 1, download_link: MAGNET(H.bb0101, 'Breaking.Bad.S01E01.1080p-Lat') },
      { quality: 'WEB-DL 720p', size: '900 MB', language: 'Latino', subs: 1, season: 2, episode: 5, download_link: MAGNET(H.bb0205, 'Breaking.Bad.S02E05.720p-Lat') },
      { quality: 'WEB-DL 1080p', size: '1.2 GB', language: 'Latino', subs: 1, season: 2, episode: 6, download_link: MAGNET(H.bb0206, 'Breaking.Bad.S02E06.1080p-Lat') }
    ]
  },
  // Sin campos season/episode: sólo el nombre del magnet indica el episodio
  'serie/from': {
    slug: 'from', title: 'From', original_title: 'FROM', type: 'serie', year: '2022',
    downloads: [
      { quality: 'WEB-DL 1080p', size: '2.1 GB', language: 'Latino/Inglés', subs: 1, download_link: MAGNET(H.from0102, 'From.S01E02.1080p-Lat') }
    ]
  },
  // Serie que sólo ofrece packs de temporada
  'serie/pack-show': {
    slug: 'pack-show', title: 'Pack Show', original_title: 'Pack Show', type: 'serie', year: '2021',
    downloads: [
      { quality: 'WEB-DL 1080p', size: '12 GB', language: 'Latino', subs: 1, download_link: MAGNET('9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f', 'Pack.Show.Temporada.2.Completa.1080p-Lat') }
    ]
  },
  // Película de anime catalogada como "anime" (sin episodios)
  'anime/akira': {
    slug: 'akira', title: 'Akira', original_title: 'Akira', type: 'anime', year: '1988',
    downloads: [
      { quality: '1080p', size: '8 GB', language: 'Latino', subs: 1, download_link: MAGNET('abababababababababababababababababababab', 'Akira.1988.1080p-Lat') }
    ]
  },
  'anime/naruto': {
    slug: 'naruto', title: 'Naruto', original_title: 'Naruto', type: 'anime', year: '2002',
    downloads: [
      { quality: '1080p', size: '1 GB', language: 'Latino', subs: 1, season: 1, episode: 1, download_link: MAGNET(H.naruto01, 'Naruto.S01E01.1080p-Lat') },
      { quality: '1080p', size: '1 GB', language: 'Latino', subs: 1, season: 1, episode: 3, download_link: MAGNET(H.naruto03, 'Naruto.S01E03.1080p-Lat') }
    ]
  }
};

const CINEMETA = {
  'movie/tt0848228': { name: 'The Avengers', releaseInfo: '2012', type: 'movie' },
  'movie/tt1160419': { name: 'Dune', releaseInfo: '2021', type: 'movie' },
  'series/tt0903747': { name: 'Breaking Bad', releaseInfo: '2008-01-20', type: 'series' },
  'series/tt1243640': { name: 'From', releaseInfo: '2022-02-20', type: 'series' },
  'movie/tt0090605': { name: 'Akira', releaseInfo: '1988', type: 'movie' },
  'movie/tt0409591': { name: 'Naruto', releaseInfo: '2002', type: 'movie' }
};

function parseQuery(url) {
  try {
    const u = new URL(url);
    return (u.searchParams.get('query') || u.searchParams.get('q') || u.searchParams.get('s') || '').toLowerCase();
  } catch {
    return '';
  }
}

const axiosGetOriginal = axios.get;
axios.get = async (url) => {
  const u = String(url);

  // Cinemeta
  const metaMatch = u.match(/\/meta\/(movie|series)\/(tt\d+)\.json/);
  if (metaMatch) {
    const key = `${metaMatch[1]}/${metaMatch[2]}`;
    if (CINEMETA[key]) return { status: 200, data: { meta: CINEMETA[key] }, headers: {} };
    throw Object.assign(new Error('cinemeta 404'), { response: { status: 404 } });
  }

  // Kitsu
  if (u.includes('kitsu.io/api/edge/anime/')) {
    return {
      status: 200,
      headers: {},
      data: { data: { attributes: { canonicalTitle: 'Naruto', startDate: '2002-10-03', titles: { en: 'Naruto', en_jp: 'Naruto' } } } }
    };
  }

  // Búsqueda HackTorrent
  if (u.includes('/wp-json/wpreact/v1/search')) {
    const q = parseQuery(u);
    const results = SEARCH[q] || [];
    return { status: 200, data: { results }, headers: {} };
  }

  // Detalle HackTorrent
  const detailMatch = u.match(/\/wp-json\/wpreact\/v1\/(movie|serie|anime)\/([^/?#]+)/);
  if (detailMatch) {
    const key = `${detailMatch[1]}/${decodeURIComponent(detailMatch[2])}`;
    if (DETAILS[key]) return { status: 200, data: DETAILS[key], headers: {} };
    throw Object.assign(new Error('detail 404'), { response: { status: 404 } });
  }

  // Cualquier otra cosa (HTML, acortalink, etc.) → no disponible
  throw Object.assign(new Error(`stub sin ruta: ${u}`), { response: { status: 404 } });
};

process.env.HACKTORRENT_MOCK = '0'; // sin datos falsos
const addon = require('../index');

test.after(() => { axios.get = axiosGetOriginal; });

function hashes(streams) {
  return streams.map(s => (s.url.match(/btih:([a-zA-Z0-9]+)/) || [])[1]);
}

test('película: elige la de 2012 y no las secuelas ni la serie homónima', async () => {
  const { streams } = await addon.get('stream', 'movie', 'tt0848228');
  assert.strictEqual(streams.length, 1);
  assert.deepStrictEqual(hashes(streams), [H.avengers2012]);
  assert.ok(streams[0].title.includes('Avengers.Los.Vengadores.2012.1080p-Lat'));
});

test('serie: devuelve SOLO el episodio pedido (S02E05)', async () => {
  const { streams } = await addon.get('stream', 'series', 'tt0903747:2:5');
  assert.strictEqual(streams.length, 1);
  assert.deepStrictEqual(hashes(streams), [H.bb0205]);
  assert.ok(streams[0].title.includes('S02E05'));
});

test('serie: si el episodio no existe devuelve vacío (nunca otro capítulo)', async () => {
  const { streams } = await addon.get('stream', 'series', 'tt0903747:2:9');
  assert.deepStrictEqual(streams, []);
});

test('serie: usa el nombre del magnet cuando la API no trae season/episode', async () => {
  const ok = await addon.get('stream', 'series', 'tt1243640:1:2');
  assert.strictEqual(ok.streams.length, 1);
  assert.deepStrictEqual(hashes(ok.streams), [H.from0102]);

  const no = await addon.get('stream', 'series', 'tt1243640:1:3');
  assert.deepStrictEqual(no.streams, []);
});

test('película: si sólo hay un título parecido de otro año, no devuelve nada', async () => {
  // Dune (2021) — el sitio sólo tiene "Dune: Parte Dos" (2024)
  const { streams } = await addon.get('stream', 'movie', 'tt1160419');
  assert.deepStrictEqual(streams, []);
});

test('serie: si no hay episodio exacto usa el pack de ESA temporada (y sólo de esa)', async () => {
  const t2 = await addon.get('stream', 'series', 'ht:pack-show:2:5');
  assert.strictEqual(t2.streams.length, 1);
  assert.ok(t2.streams[0].title.includes('Temporada completa'));

  const t1 = await addon.get('stream', 'series', 'ht:pack-show:1:5');
  assert.deepStrictEqual(t1.streams, []);
});

test('película: acepta películas de anime catalogadas como anime', async () => {
  const { streams } = await addon.get('stream', 'movie', 'tt0090605');
  assert.strictEqual(streams.length, 1);
  assert.ok(streams[0].url.includes('abababab'));
});

test('película: NO acepta una serie de anime con el mismo nombre', async () => {
  const { streams } = await addon.get('stream', 'movie', 'tt0409591');
  assert.deepStrictEqual(streams, []);
});

test('anime vía kitsu: sólo el episodio solicitado', async () => {
  const { streams } = await addon.get('stream', 'series', 'kitsu:123:1:3');
  assert.strictEqual(streams.length, 1);
  assert.deepStrictEqual(hashes(streams), [H.naruto03]);
});

test('id propio ht: respeta temporada/episodio', async () => {
  const { streams } = await addon.get('stream', 'series', 'ht:breaking-bad:2:5');
  assert.strictEqual(streams.length, 1);
  assert.deepStrictEqual(hashes(streams), [H.bb0205]);
});

test('búsqueda de catálogo filtra por tipo (películas no traen series)', async () => {
  const { metas } = await addon.get('catalog', 'movie', 'hacktorrent-peliculas', { search: 'The Avengers' });
  assert.ok(metas.length >= 1);
  assert.ok(metas.every(m => m.type === 'movie'));
  assert.ok(!metas.some(m => (m.name || '').includes('1961')));
});
