'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Scraper = require('../lib/scraper');

test('caché HackTorrent conserva null y expulsa entradas LRU vencidas/menos usadas', async () => {
  Scraper._limpiarCache();
  Scraper._cacheSet('negative', null, 10_000);
  assert.equal(Scraper._cacheGet('negative'), null, 'null debe distinguirse de un miss');

  Scraper._limpiarCache();
  for (let i = 0; i < Scraper._cacheLimit; i++) {
    Scraper._cacheSet(`k${i}`, i, 10_000);
  }
  assert.equal(Scraper._cacheGet('k0'), 0, 'la lectura debe renovar la posición LRU');
  Scraper._cacheSet('new', true, 10_000);
  assert.equal(Scraper._cacheGet('k0'), 0, 'la entrada recientemente usada debe sobrevivir');
  assert.equal(Scraper._cacheGet('k1'), undefined, 'se expulsa la entrada menos usada');
  assert.equal(Scraper._cacheSize(), Scraper._cacheLimit);
});

test('búsquedas concurrentes equivalentes comparten una sola petición a HackTorrent', async () => {
  Scraper._limpiarCache();
  const originalGet = axios.get;
  let requests = 0;
  axios.get = async (url) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      data: {
        results: [{ title: 'The Matrix', slug: 'the-matrix', type: 'movie', year: '1999' }]
      }
    };
  };

  try {
    const [a, b] = await Promise.all([
      Scraper.buscarEnHackTorrent('The Matrix'),
      Scraper.buscarEnHackTorrent('  the matrix  ')
    ]);
    assert.equal(requests, 1);
    assert.equal(a[0].slug, 'the-matrix');
    assert.deepEqual(b, a);
  } finally {
    axios.get = originalGet;
    Scraper._limpiarCache();
  }
});

test('respuestas negativas de acortalink se cachean y no repiten la petición', async () => {
  Scraper._limpiarCache();
  const originalGet = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests++;
    return { status: 200, data: '<html>sin enlace de descarga</html>', headers: {} };
  };

  try {
    const url = 'https://acortalink.net/s.php?i=not-a-real-link';
    assert.equal(await Scraper.resolverAcortalink(url), null);
    assert.equal(await Scraper.resolverAcortalink(url), null);
    assert.equal(requests, 1);
  } finally {
    axios.get = originalGet;
    Scraper._limpiarCache();
  }
});
