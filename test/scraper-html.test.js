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

test('decryptAcortalink desencripta enlaces de acortalink.net offline (AES-256-CBC Salted__)', async () => {
  const crypto = require('crypto');
  const password = Buffer.from('fee631d2cffda38a78b96ee6d2dfb43a', 'utf8');
  const salt = Buffer.from('12345678', 'utf8');
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < 48) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, password, salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  const cipher = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
  const magnetOriginal = 'magnet:?xt=urn:btih:df0c7f2ffcefcfa83b0b8bd0de3d69b86b5aa5c4&dn=%5BHackstore.net%5D%20From%20S01E01%201080p&xl=1610612736';
  const encrypted = Buffer.concat([cipher.update(magnetOriginal, 'utf8'), cipher.final()]);
  const saltedB64 = Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
  const innerB64 = Buffer.from(saltedB64, 'utf8').toString('base64');
  const testUrl = `https://acortalink.net/s.php?i=${encodeURIComponent(innerB64)}`;

  const decrypted = Scraper.decryptAcortalink(testUrl);
  assert.strictEqual(decrypted, magnetOriginal);

  // Y resolverAcortalink lo resuelve sin hacer peticiones HTTP
  const resolved = await Scraper.resolverAcortalink(testUrl);
  assert.strictEqual(resolved, magnetOriginal);
  assert.strictEqual(Scraper._internals.formatSizeFromMagnet(resolved), '1.50 GB');
});

test('parseHtmlDetail desambigua encabezados reales concatenados ("Temporada 110 Episodios" y "Temporada 12 Episodios")', () => {
  // En hacktorrent.cc, <div><span>Temporada 1</span><span>10 Episodios</span></div> produce "Temporada 110 Episodios" en .text()
  const rows10 = Array.from({ length: 10 }, (_, idx) => {
    const ep = idx + 1;
    return `
      <tr>
        <td>${ep}</td>
        <td>1080p</td>
        <td>1.4 GB</td>
        <td>Si</td>
        <td>Latino/Ingles</td>
        <td>2024-05-0${Math.min(ep, 9)}</td>
        <td>
          <a href="magnet:?xt=urn:btih:${String(ep).padStart(40, 'a')}&dn=From.S01E${String(ep).padStart(2, '0')}.1080p">Descargar</a>
          <a href="https://hacktorrent.cc/serie/from/player/1/${ep}">Ver</a>
        </td>
      </tr>
    `;
  }).join('');

  // Y para una serie con 2 episodios en la Temporada 1 ("Temporada 12 Episodios")
  const rows2 = [1, 2].map(ep => `
    <tr>
      <td>${ep}</td>
      <td>1080p</td>
      <td>1.2 GB</td>
      <td>Si</td>
      <td>Latino</td>
      <td>2026-04-0${ep}</td>
      <td>
        <a href="magnet:?xt=urn:btih:${String(ep).padStart(40, 'b')}">Descargar</a>
        <a href="https://hacktorrent.cc/serie/phony-la-otra-madre/player/1/${ep}">Ver</a>
      </td>
    </tr>
  `).join('');

  const html = `
    <html>
      <body>
        <h1>From (2022)</h1>
        <div><div><span>Temporada 1</span><span>10 Episodios</span></div><table><tbody>${rows10}</tbody></table></div>
        <div><div><span>Temporada 1</span><span>2 Episodios</span></div><table><tbody>${rows2}</tbody></table></div>
      </body>
    </html>
  `;

  const detail = Scraper._parseHtmlDetail(html, { slug: 'from', tipo: 'serie', url: 'https://hacktorrent.cc/serie/from/' });
  assert.strictEqual(detail.torrents.length, 12);
  for (const t of detail.torrents) {
    assert.strictEqual(t.temporada, 1, `Temporada debe ser 1 y no ${t.temporada}`);
  }
  assert.strictEqual(detail.torrents[0].episodio, 1);
  assert.strictEqual(detail.torrents[9].episodio, 10);
});

test('normalizarMagnet y base32ToHex convierten magnets híbridos BitTorrent v2/v1 con hash Base32', () => {
  // Magnet híbrido real de hacktorrent.cc (/wp-json/wpreact/v1/anime/chainsmoker-cat)
  const hybridMagnet = 'magnet:?xt=urn:btmh:12206ff0ba03abce1bf3f610f729f2d56e7df3dd3e3e4d439340928426cb6cb2f2eb&xt=urn:btih:NR747Z6UZW3Y5BX74NUXA3X2B6F7H5B2&dn=%5BHackstore.net%5D%20Chainsmoker%20Cat%20S01E01&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce';
  assert.strictEqual(Scraper._internals.isValidMagnet(hybridMagnet), true);

  const normalized = Scraper.normalizarMagnet(hybridMagnet);
  assert.ok(normalized.startsWith('magnet:?xt=urn:btih:6c7fcfe7d4cdb78e86ffe369706efa0f8bf3f43a'));
  assert.ok(normalized.includes('dn='));
});

