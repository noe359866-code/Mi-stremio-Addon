'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Scraper = require('../lib/scraper');

const originalGet = axios.get;

test.afterEach(() => {
  axios.get = originalGet;
  Scraper._limpiarCache();
});

test('búsqueda wpreact normaliza resultados anidados y deduce tipo/slug desde la URL', async () => {
  Scraper._limpiarCache();
  axios.get = async () => ({
    data: {
      data: {
        results: [{
          title: 'Better Call Saul',
          link: 'https://hacktorrent.cc/serie/better-call-saul/',
          year: '2015-02-08',
          featured: '/poster.jpg',
          background_image: '/backdrop.jpg'
        }]
      }
    }
  });

  const [result] = await Scraper.buscarEnHackTorrent('Better Call Saul');
  assert.equal(result.slug, 'better-call-saul');
  assert.equal(result.tipo, 'serie');
  assert.equal(result.año, '2015');
  assert.equal(result.url, 'https://hacktorrent.cc/serie/better-call-saul/');
  assert.equal(result.poster, 'https://image.tmdb.org/t/p/w300/poster.jpg');
  assert.equal(result.background, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
});

test('fallback React prueba q y s y admite respuestas con envoltorios distintos', async () => {
  Scraper._limpiarCache();
  const urls = [];
  axios.get = async (url) => {
    urls.push(url);
    if (url.includes('/wpreact/')) return { data: { results: [] } };
    if (url.includes('?q=')) return { data: { data: { results: [] } } };
    return {
      data: {
        data: [{
          title: 'From',
          link: '/serie/from/',
          imdb: '8.2',
          image: '/from-poster.jpg'
        }]
      }
    };
  };

  const results = await Scraper.buscarEnHackTorrent('From');
  assert.equal(urls.length, 3);
  assert.match(urls[1], /react\/v1\/search\?q=From/);
  assert.match(urls[2], /react\/v1\/search\?s=From/);
  assert.equal(results.length, 1);
  assert.equal(results[0].slug, 'from');
  assert.equal(results[0].tipo, 'serie');
  assert.equal(results[0].imdbRating, '8.2');
  assert.equal(results[0].poster, 'https://image.tmdb.org/t/p/w300/from-poster.jpg');
});

test('decodeReactGuid decodifica _guid (rot13+base64) de react/v1 a tmdbId y filtra ruido de ?s=', async () => {
  // En react/v1, _guid = "ZGR5BQL1AN==" -> rot13("MTE5ODY1NA==") -> base64("1198654")
  assert.equal(Scraper.decodeReactGuid('ZGR5BQL1AN=='), '1198654');

  axios.get = async (url) => {
    if (url.includes('/wpreact/v1/search')) return { data: { results: [] } };
    if (url.includes('/react/v1/search?q=')) return { data: [] };
    if (url.includes('/react/v1/search?s=')) {
      return {
        data: [
          { title: 'Película Irrelevante de Portada', link: 'https://hacktorrent.cc/pelicula/irrelevante/', _guid: 'ZGR5BQL1AN==' },
          { title: 'Caballos lentos', link: 'https://hacktorrent.cc/serie/caballos-lentos/', _guid: 'OTU0ODA=' }
        ]
      };
    }
    return { data: '' };
  };

  const results = await Scraper.buscarEnHackTorrent('Caballos lentos');
  assert.equal(results.length, 1);
  assert.equal(results[0].slug, 'caballos-lentos');
  assert.equal(results[0].tipo, 'serie');
});

test('buscarPorTmdb resuelve el título en español desde /?tmdb={id} y consulta wpreact', async () => {
  axios.get = async (url) => {
    if (url.includes('/?tmdb=106646')) {
      return {
        data: '<p>The link has moved to <a href="">El lobo de Wall Street</a></p>'
      };
    }
    if (url.includes('/wpreact/v1/search?query=El%20lobo%20de%20Wall%20Street')) {
      return {
        data: {
          results: [{
            slug: 'el-lobo-de-wall-street',
            title: 'El lobo de Wall Street',
            original_title: 'The Wolf of Wall Street',
            tmdb_id: '106646',
            type: 'movie',
            year: '2013'
          }]
        }
      };
    }
    return { data: { results: [] } };
  };

  const results = await Scraper.buscarPorTmdb('106646');
  assert.equal(results.length, 1);
  assert.equal(results[0].slug, 'el-lobo-de-wall-street');
  assert.equal(results[0].tmdbId, '106646');
  assert.equal(results[0].tituloOriginal, 'The Wolf of Wall Street');
});

test('extraerDetalleTorrent fusiona metadatos de /wpreact/v1/serie/{slug} con tabla HTML de episodios', async () => {
  axios.get = async (url) => {
    if (url.includes('/wp-json/wpreact/v1/serie/from')) {
      return {
        data: {
          id: 42,
          slug: 'from',
          title: 'From',
          original_title: 'From',
          tmdb_id: '124364',
          overview: 'Un pueblo misterioso atrapa a todos los que entran.',
          years: '2022',
          imdb: '7.8',
          featured: '/from-poster.jpg',
          background_image: '/from-bg.jpg',
          genres: 'Misterio, Drama, Terror',
          language: 'Latino/Ingles'
          // Nota: /wpreact/v1/serie/{slug} nunca incluye downloads en hacktorrent.cc
        }
      };
    }
    if (url.includes('https://hacktorrent.cc/serie/from/')) {
      return {
        data: `
          <html><body>
            <h1>From</h1>
            <div><span>Temporada 1</span><span>10 Episodios</span></div>
            <table><tbody>
              <tr>
                <td>1</td><td>1080p</td><td>1.4 GB</td><td>Si</td><td>Latino/Ingles</td><td>2024-01-01</td>
                <td>
                  <a href="magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=From.S01E01.1080p">Descargar</a>
                  <a href="https://hacktorrent.cc/serie/from/player/1/1">Ver</a>
                </td>
              </tr>
            </tbody></table>
          </body></html>
        `
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const detail = await Scraper.extraerDetalleTorrent('from', 'serie');
  assert.ok(detail);
  assert.equal(detail.titulo, 'From');
  assert.equal(detail.tmdbId, '124364');
  assert.equal(String(detail.año), '2022');
  assert.equal(detail.imdbRating, '7.8');
  assert.deepEqual(detail.generos, ['Misterio', 'Drama', 'Terror']);
  assert.equal(detail.torrents.length, 1);
  assert.equal(detail.torrents[0].temporada, 1);
  assert.equal(detail.torrents[0].episodio, 1);
});

