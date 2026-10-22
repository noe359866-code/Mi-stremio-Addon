/**
 * Tests unitarios y de integración para el scraper dedicado de PelisPanda (https://pelispanda.org/)
 * Ejecutar con: node --test test/pelispanda.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const PelisPanda = require('../lib/pelispanda');
const addonInterface = require('../index');
const { aplicarConfig } = require('../lib/config');

function mockHttp(routes) {
  return async (url) => {
    for (const [pattern, responder] of routes) {
      const match = typeof pattern === 'string' ? url === pattern : pattern.test(url);
      if (!match) continue;
      const value = typeof responder === 'function' ? await responder(url) : responder;
      if (value instanceof Error) throw value;
      return { status: 200, data: value };
    }
    const err = new Error(`Ruta no simulada en PelisPanda test: ${url}`);
    err.response = { status: 404 };
    throw err;
  };
}

test('PelisPanda: mapRawItemToResult sanea background_image vacío, imdb="0", géneros WP y URL /peliculas/', () => {
  const item = {
    ID: 16556,
    name: 'Masterplan',
    original_title: 'Masterplan',
    slug: 'masterplan',
    type: 'peliculas',
    url: 'https://pelispanda.org/peliculas/masterplan/',
    featured: 'https://image.tmdb.org/t/p/w300/67ef968152398952e7e7a5e8c26.jpg',
    background_image: 'https://image.tmdb.org/t/p/original/',
    overview: 'Un ladrón legendario planea su último golpe.',
    year: '2026',
    imdb: '0',
    genres: [
      { term_id: 24, name: 'Acción', slug: 'accion' },
      { term_id: 19, name: 'Comedia', slug: 'comedia' }
    ]
  };

  const res = PelisPanda.mapRawItemToResult(item);
  assert.strictEqual(res.fuente, 'pelispanda');
  assert.strictEqual(res.tipo, 'pelicula');
  assert.strictEqual(res.slug, 'masterplan');
  assert.strictEqual(res.url, 'https://pelispanda.org/pelicula/masterplan/');
  assert.strictEqual(res.poster, 'https://image.tmdb.org/t/p/w300/67ef968152398952e7e7a5e8c26.jpg');
  // El background roto (/t/p/original/ vacío) cae al póster válido
  assert.strictEqual(res.background, res.poster);
  assert.strictEqual(res.imdbRating, null);
  assert.deepStrictEqual(res.generos, ['Acción', 'Comedia']);
});

test('PelisPanda: búsqueda wpreact y fallback react/v1/search?q= (con wrapper data[] y _guid rot13+base64)', async () => {
  PelisPanda._clearCaches();
  const origGet = axios.get;

  axios.get = mockHttp([
    [
      'https://pelispanda.org/wp-json/wpreact/v1/search?query=Daredevil',
      { results: [] }
    ],
    [
      'https://pelispanda.org/wp-json/react/v1/search?q=Daredevil',
      {
        error: false,
        msg: '',
        data: [
          {
            id: 332,
            title: 'Daredevil: Born Again',
            slug: 'daredevil-born-again',
            img: 'https://pelispanda.org/wp-content/uploads/2025/03/daredevil.jpg',
            link: 'https://pelispanda.org/serie/daredevil-born-again/',
            year: [{ name: '2025', slug: '2025' }],
            _guid: 'ZwNlAGH1' // rot13('MjAyNTU1') -> base64('202555')
          }
        ]
      }
    ]
  ]);

  try {
    const res = await PelisPanda.buscarEnPelisPanda('Daredevil');
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].titulo, 'Daredevil: Born Again');
    assert.strictEqual(res[0].slug, 'daredevil-born-again');
    assert.strictEqual(res[0].tipo, 'serie');
    assert.strictEqual(res[0].año, 2025);
    assert.strictEqual(res[0].tmdbId, '202555');
    assert.strictEqual(res[0].fuente, 'pelispanda');
  } finally {
    axios.get = origGet;
  }
});

test('PelisPanda: buscarPorTmdb resuelve título en español en https://pelispanda.org/?tmdb={id}', async () => {
  PelisPanda._clearCaches();
  const origGet = axios.get;

  axios.get = mockHttp([
    [
      'https://pelispanda.org/?tmdb=106646',
      '<a href="">El Lobo de Wall Street</a><br />'
    ],
    [
      'https://pelispanda.org/wp-json/wpreact/v1/search?query=El%20Lobo%20de%20Wall%20Street',
      {
        results: [
          {
            title: 'El Lobo de Wall Street',
            original_title: 'The Wolf of Wall Street',
            slug: 'el-lobo-de-wall-street',
            type: 'movie',
            year: '2013',
            featured: '/wolf.jpg'
          }
        ]
      }
    ]
  ]);

  try {
    const res = await PelisPanda.buscarPorTmdb(106646);
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].titulo, 'El Lobo de Wall Street');
    assert.strictEqual(res[0].slug, 'el-lobo-de-wall-street');
    assert.strictEqual(res[0].tmdbId, '106646');
  } finally {
    axios.get = origGet;
  }
});

test('PelisPanda: extraerDetalleTorrent de película normaliza fecha YYYYMMDD, idioma "Latino - Inglés" y magnet hex', async () => {
  PelisPanda._clearCaches();
  const origGet = axios.get;

  axios.get = mockHttp([
    [
      'https://pelispanda.org/wp-json/wpreact/v1/movie/masterplan',
      {
        ID: 16556,
        title: 'Masterplan',
        original_title: 'Masterplan',
        slug: 'masterplan',
        overview: 'Sinopsis de Masterplan.',
        featured: 'https://image.tmdb.org/t/p/w300/masterplan.jpg',
        background_image: 'https://image.tmdb.org/t/p/original/',
        year: '2026',
        imdb: '0',
        genres: 'Acción, Comedia, Crimen',
        downloads: [
          {
            quality: '1080p',
            language: 'Latino - Inglés',
            size: '2.92 GB',
            date: '20261017',
            subs: true,
            download_link: 'magnet:?xt=urn:btih:DC49A9A6174208BE31A09CCBAED412894EABBAEF&dn=Masterplan.2026.1080p-dual-lat'
          }
        ],
        related: [
          {
            ID: 99,
            name: 'El Patriota',
            slug: 'el-patriota',
            type: 'movie',
            featured: '/patriota.jpg',
            genres: [{ term_id: 1, name: 'Acción', slug: 'accion' }]
          }
        ]
      }
    ]
  ]);

  try {
    const detalle = await PelisPanda.extraerDetalleTorrent('masterplan', 'pelicula');
    assert.ok(detalle);
    assert.strictEqual(detalle.fuente, 'pelispanda');
    assert.strictEqual(detalle.titulo, 'Masterplan');
    assert.strictEqual(detalle.background, 'https://image.tmdb.org/t/p/w300/masterplan.jpg');
    assert.strictEqual(detalle.imdbRating, null);
    assert.strictEqual(detalle.torrents.length, 1);

    const t = detalle.torrents[0];
    assert.strictEqual(t.calidad, '1080p');
    assert.strictEqual(t.idioma, 'Latino/Inglés');
    assert.strictEqual(t.fecha, '17/10/2026');
    assert.strictEqual(t.infoHash, 'dc49a9a6174208be31a09ccbaed412894eabbaef');
    assert.ok(t.magnet.startsWith('magnet:?xt=urn:btih:dc49a9a6174208be31a09ccbaed412894eabbaef'));
    assert.strictEqual(detalle.relacionados.length, 1);
    assert.deepStrictEqual(detalle.relacionados[0].generos, ['Acción']);
  } finally {
    axios.get = origGet;
  }
});

test('PelisPanda: extraerDetalleTorrent de serie fusiona wpreact/v1/serie con HTML y desambigua "Temporada 110 Episodios" y "Temporada 28 Episodios"', async () => {
  PelisPanda._clearCaches();
  const origGet = axios.get;

  // Simulamos exactamente la estructura real de https://pelispanda.org/serie/la-casa-del-dragon/
  let t1Rows = '';
  for (let ep = 1; ep <= 10; ep++) {
    const epPad = String(ep).padStart(2, '0');
    const hash = String(ep).padStart(40, 'A');
    t1Rows += `
      <tr>
        <td>${ep}</td>
        <td>Dual 1080p</td>
        <td>Latino / Inglés</td>
        <td>1.5 GB</td>
        <td><a href="magnet:?xt=urn:btih:${hash}&dn=La.casa.del.dragon.1x${epPad}.Dual.1080p-lat">Descargar</a></td>
        <td><a href="https://pelispanda.org/serie/la-casa-del-dragon/player/1/${ep}">Ver</a></td>
      </tr>`;
  }

  let t2Rows = '';
  for (let ep = 1; ep <= 8; ep++) {
    const epPad = String(ep).padStart(2, '0');
    const hash = String(ep).padStart(40, 'B');
    t2Rows += `
      <tr>
        <td>${ep}</td>
        <td>WEB-DL 1080p</td>
        <td>Latino / Inglés</td>
        <td>2.94 GB</td>
        <td><a href="magnet:?xt=urn:btih:${hash}&dn=La.casa.del.dragon.S02E${epPad}.1080p.WEB-DL">Descargar</a></td>
        <td><a href="https://pelispanda.org/serie/la-casa-del-dragon/player/2/${ep}">Ver</a></td>
      </tr>`;
  }

  const htmlSerie = `
    <html>
      <body>
        <h1>La casa del dragón</h1>
        <span>Duración: 0m</span>
        <div>
          <h4><span>Temporada 1</span><span>10 Episodios</span></h4>
          <table><tbody>${t1Rows}</tbody></table>
        </div>
        <div>
          <h4><span>Temporada 2</span><span>8 Episodios</span></h4>
          <table><tbody>${t2Rows}</tbody></table>
        </div>
        <div class="related">
          <a href="https://pelispanda.org/undefined/el-caballero-de-los-siete-reinos">
            <img src="https://image.tmdb.org/t/p/w300/caballero.jpg" />
            <h3>El caballero de los Siete Reinos</h3>
          </a>
        </div>
      </body>
    </html>
  `;

  axios.get = mockHttp([
    [
      'https://pelispanda.org/wp-json/wpreact/v1/serie/la-casa-del-dragon',
      {
        ID: 501,
        title: 'La casa del dragón',
        original_title: 'House of the Dragon',
        slug: 'la-casa-del-dragon',
        overview: 'Historia de la Casa Targaryen.',
        featured: 'https://image.tmdb.org/t/p/w300/hotd.jpg',
        years: '2022',
        imdb: '8.4',
        genres: 'Ciencia ficción, Drama, Acción'
      }
    ],
    [
      'https://pelispanda.org/serie/la-casa-del-dragon/',
      htmlSerie
    ]
  ]);

  try {
    const detalle = await PelisPanda.extraerDetalleTorrent('la-casa-del-dragon', 'serie');
    assert.ok(detalle);
    assert.strictEqual(detalle.titulo, 'La casa del dragón');
    assert.strictEqual(detalle.tituloOriginal, 'House of the Dragon');
    assert.strictEqual(detalle.año, 2022);
    assert.strictEqual(detalle.duracion, null); // "0m" descartado
    assert.strictEqual(detalle.torrents.length, 18);

    const t1e1 = detalle.torrents.find(t => t.temporada === 1 && t.episodio === 1);
    assert.ok(t1e1, 'Debe detectar Temporada 1 Episodio 1 (y no Temporada 110)');
    assert.strictEqual(t1e1.calidad, 'Dual 1080p');

    const t2e5 = detalle.torrents.find(t => t.temporada === 2 && t.episodio === 5);
    assert.ok(t2e5, 'Debe detectar Temporada 2 Episodio 5 (y no Temporada 28)');
    assert.strictEqual(t2e5.calidad, 'WEB-DL 1080p');

    assert.strictEqual(detalle.relacionados.length, 1);
    assert.strictEqual(detalle.relacionados[0].slug, 'el-caballero-de-los-siete-reinos');
  } finally {
    axios.get = origGet;
  }
});

test('PelisPanda + Addon: entrega únicamente streams de Torrents (sin catálogos ni meta)', async () => {
  PelisPanda._clearCaches();
  const origGet = axios.get;

  axios.get = mockHttp([
    [
      'https://pelispanda.org/wp-json/wpreact/v1/movie/masterplan',
      {
        ID: 16556,
        title: 'Masterplan',
        original_title: 'Masterplan',
        slug: 'masterplan',
        overview: 'Sinopsis de prueba.',
        featured: 'https://image.tmdb.org/t/p/w300/masterplan.jpg',
        background_image: 'https://image.tmdb.org/t/p/original/',
        year: '2026',
        imdb: '7.1',
        genres: 'Acción, Comedia',
        downloads: [
          {
            quality: '1080p',
            language: 'Latino - Inglés',
            size: '2.92 GB',
            date: '20261017',
            subs: true,
            download_link: 'magnet:?xt=urn:btih:DC49A9A6174208BE31A09CCBAED412894EABBAEF&dn=Masterplan.2026.1080p'
          }
        ]
      }
    ]
  ]);

  try {
    // 1. El addon NO expone catálogos ni meta
    await assert.rejects(() => addonInterface.get('catalog', 'movie', 'pelispanda-peliculas'), { noHandler: true });
    await assert.rejects(() => addonInterface.get('meta', 'movie', 'pp:masterplan'), { noHandler: true });

    // 2. Stream PelisPanda devuelve Torrent nativo (infoHash + sources, sin url)
    const streamRes = await addonInterface.get('stream', 'movie', 'pp:masterplan');
    assert.strictEqual(streamRes.streams.length, 1);
    assert.ok(streamRes.streams[0].name.includes('PelisPanda'));
    assert.strictEqual(streamRes.streams[0].infoHash, 'dc49a9a6174208be31a09ccbaed412894eabbaef');
    assert.strictEqual(streamRes.streams[0].url, undefined);
    assert.ok(Array.isArray(streamRes.streams[0].sources));

    // 3. Filtro de configuración con fuentes='pp'
    const filtrados = aplicarConfig(
      [
        PelisPanda.torrentToStream({
          calidad: '1080p',
          idioma: 'Dual (Latino/Inglés)',
          tamaño: '2.92 GB',
          magnet: 'magnet:?xt=urn:btih:dc49a9a6174208be31a09ccbaed412894eabbaef&dn=Masterplan'
        }, 'Masterplan')
      ],
      { fuentes: 'pp', idioma: 'latino' }
    );
    assert.strictEqual(filtrados.length, 1);
    assert.strictEqual(filtrados[0].infoHash, 'dc49a9a6174208be31a09ccbaed412894eabbaef');
    assert.strictEqual(filtrados[0].url, undefined);
  } finally {
    axios.get = origGet;
  }
});
