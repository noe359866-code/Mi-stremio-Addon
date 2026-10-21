'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Scraper = require('../lib/scraper');

const MAGNET = (hash, dn) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;

const SERIE_HTML = `<!doctype html><html><head>
<meta property="og:title" content="Breaking Bad (2008) - HackTorrent" />
</head><body class="single-serie mt-4">
<h1>Breaking Bad</h1>
<h2>Temporada 1</h2>
<table class="table mt-4">
  <thead><tr><th>#</th><th>Formato</th><th>Tamaño</th><th>Subtítulos</th><th>Idioma</th><th>Fecha</th><th>Acciones</th></tr></thead>
  <tbody>
    <tr><td>1</td><td>WEB-DL 1080p</td><td>2.68 GB</td><td>Sí</td><td>Latino/Inglés</td><td>01/03/2024</td>
      <td><a href="${MAGNET('1111111111111111111111111111111111111111', 'Breaking.Bad.S01E01.1080p-Lat')}">Descargar</a></td></tr>
    <tr><td>2</td><td>WEB-DL 1080p</td><td>1.96 GB</td><td>Sí</td><td>Latino/Inglés</td><td>01/03/2024</td>
      <td><a href="${MAGNET('2222222222222222222222222222222222222222', 'Breaking.Bad.S01E02.1080p-Lat')}">Descargar</a></td></tr>
  </tbody>
</table>
<h2>Temporada 2</h2>
<table class="table mt-4">
  <thead><tr><th>#</th><th>Formato</th><th>Tamaño</th><th>Subtítulos</th><th>Idioma</th><th>Fecha</th><th>Acciones</th></tr></thead>
  <tbody>
    <tr><td>5</td><td>WEB-DL 720p</td><td>900 MB</td><td>No</td><td>Latino</td><td>02/03/2024</td>
      <td><a href="${MAGNET('5555555555555555555555555555555555555555', 'Breaking.Bad.S02E05.720p-Lat')}">Descargar</a></td></tr>
    <tr><td>6</td><td>WEB-DL 720p</td><td>910 MB</td><td>No</td><td>Latino</td><td>02/03/2024</td>
      <td><a href="${MAGNET('6666666666666666666666666666666666666666', 'Breaking.Bad.S02E06.720p-Lat')}">Descargar</a></td></tr>
  </tbody>
</table>
</body></html>`;

const MOVIE_HTML = `<!doctype html><html><head>
<meta property="og:title" content="El Proyecto Colibrí (2019) - HackTorrent" />
</head><body>
<h1>El Proyecto Colibrí</h1>
<table>
  <thead><tr><th>Formato</th><th>Idioma</th><th>Fecha</th><th>Tamaño</th><th>Subtítulos</th><th>Descargar</th></tr></thead>
  <tbody>
    <tr><td>WEB-DL 1080p</td><td>Latino</td><td>05/01/2024</td><td>3.70 GB</td><td>Sí</td>
      <td><a href="${MAGNET('a7a4b188eb86e5ae3023d64aa75c573dded4a015', 'El.Proyecto.Colibri.2019.1080p-Lat')}">Descargar</a></td></tr>
    <tr><td>720p</td><td>Latino</td><td>05/01/2024</td><td>1.01 GB</td><td>Sí</td>
      <td><a href="${MAGNET('889dfd64f9722a2067f4dc9f22cde7df33d78d2f', 'El.Proyecto.Colibri.2019.720p-Lat')}">Descargar</a></td></tr>
  </tbody>
</table>
</body></html>`;

test('HTML serie: cada fila queda en su temporada/episodio correcto', () => {
  const out = Scraper._parseHtmlDetail(SERIE_HTML, { slug: 'breaking-bad', tipo: 'serie', url: 'https://hacktorrent.cc/serie/breaking-bad/' });
  assert.strictEqual(out.titulo, 'Breaking Bad');
  assert.strictEqual(out.torrents.length, 4);

  const mapa = out.torrents.map(t => `${t.temporada}x${t.episodio}`);
  assert.deepStrictEqual(mapa, ['1x1', '1x2', '2x5', '2x6']);

  const s02e05 = out.torrents.find(t => t.temporada === 2 && t.episodio === 5);
  assert.ok(s02e05.magnet.includes('55555555'));
  assert.strictEqual(s02e05.calidad, 'WEB-DL 720p');
  assert.strictEqual(s02e05.tamaño, '900 MB');
});

test('HTML serie: no se deja engañar por clases CSS con números (mt-4)', () => {
  const out = Scraper._parseHtmlDetail(SERIE_HTML, { slug: 'breaking-bad', tipo: 'serie', url: 'x' });
  assert.ok(out.torrents.some(t => t.temporada === 1 && t.episodio === 1));
  assert.ok(!out.torrents.some(t => t.temporada === 4));
});

test('HTML película: no inventa temporada/episodio', () => {
  const out = Scraper._parseHtmlDetail(MOVIE_HTML, { slug: 'el-proyecto-colibri', tipo: 'pelicula', url: 'x' });
  assert.strictEqual(out.titulo, 'El Proyecto Colibrí');
  assert.strictEqual(out.torrents.length, 2);
  for (const t of out.torrents) {
    assert.strictEqual(t.temporada, null);
    assert.strictEqual(t.episodio, null);
  }
  assert.strictEqual(out.torrents[0].calidad, 'WEB-DL 1080p');
  assert.strictEqual(out.torrents[0].tamaño, '3.70 GB');
  assert.strictEqual(out.torrents[0].idioma, 'Latino');
});

// ------------------- collectDownloads: formas variables de la API -------------------
const M = (hash, dn) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}`;

test('API: temporadas → episodios → downloads anidados', () => {
  const payload = {
    slug: 'x', title: 'X', type: 'serie',
    seasons: [
      {
        season: 1,
        episodes: [
          { episode: 1, downloads: [{ quality: '1080p', size: '1 GB', download_link: M('a'.repeat(40), 'X.S01E01') }] },
          { episode: 2, downloads: [{ quality: '720p', size: '700 MB', download_link: M('b'.repeat(40), 'X.S01E02') }] }
        ]
      },
      {
        season: 2,
        episodes: [
          { episode: 5, downloads: [{ quality: '1080p', size: '1 GB', download_link: M('c'.repeat(40), 'X.S02E05') }] }
        ]
      }
    ]
  };
  const out = Scraper._collectDownloads(payload, 'serie');
  assert.deepStrictEqual(out.map(t => `${t.temporada}x${t.episodio}`).sort(), ['1x1', '1x2', '2x5']);
});

test('API: mapa de calidades dentro de cada episodio', () => {
  const payload = {
    slug: 'y', title: 'Y', type: 'serie',
    episodes: [
      { episode: 4, links: { '1080p': M('d'.repeat(40), 'Y.S01E04.1080p'), '720p': M('e'.repeat(40), 'Y.S01E04.720p') } }
    ]
  };
  const out = Scraper._collectDownloads(payload, 'serie');
  assert.strictEqual(out.length, 2);
  // La temporada se recupera del nombre del magnet (Y.S01E04)
  assert.ok(out.every(t => t.temporada === 1 && t.episodio === 4));
  assert.deepStrictEqual(out.map(t => t.calidad).sort(), ['1080p', '720p']);
});

test('API: sin season/episode usa el nombre del magnet', () => {
  const payload = {
    slug: 'z', title: 'Z', type: 'serie',
    downloads: [{ quality: 'WEB-DL 1080p', download_link: M('f'.repeat(40), 'Z.S03E07.1080p-Lat') }]
  };
  const out = Scraper._collectDownloads(payload, 'serie');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].temporada, 3);
  assert.strictEqual(out[0].episodio, 7);
  assert.strictEqual(out[0].dn, 'Z.S03E07.1080p-Lat');
});

test('API: película no recibe temporada/episodio inventados', () => {
  const payload = {
    slug: 'p', title: 'P', type: 'pelicula',
    downloads: [
      { quality: '1080p', download_link: M('1'.repeat(40), 'P.2019.1080p-Lat') },
      { quality: '720p', download_link: M('2'.repeat(40), 'P.2019.720p-Lat') }
    ]
  };
  const out = Scraper._collectDownloads(payload, 'movie');
  assert.strictEqual(out.length, 2);
  assert.ok(out.every(t => t.temporada === null && t.episodio === null));
});

test('API: descarta enlaces web que no son torrents', () => {
  const payload = {
    slug: 'q', title: 'Q', type: 'pelicula',
    related: [{ title: 'Otra', link: 'https://hacktorrent.cc/pelicula/otra/' }],
    downloads: [{ quality: '1080p', download_link: M('3'.repeat(40), 'Q.2020.1080p') }]
  };
  const out = Scraper._collectDownloads(payload, 'movie');
  assert.strictEqual(out.length, 1);
});
