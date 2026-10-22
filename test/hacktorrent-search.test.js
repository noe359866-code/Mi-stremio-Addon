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
