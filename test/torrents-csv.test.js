'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const TorrentsCsv = require('../lib/torrentsCsv');

const originalGet = axios.get;
const HASH_2012 = 'a'.repeat(40);
const HASH_2018 = 'b'.repeat(40);

function csvRecord(name, infohash, extra = {}) {
  return { name, infohash, seeders: 23, leechers: 4, size: 2_000_000_000, ...extra };
}

test.afterEach(() => {
  axios.get = originalGet;
  TorrentsCsv._limpiarCache();
});

test('consulta la API Torrents.csv y filtra películas por año antes de crear streams', async () => {
  let requestedUrl;
  axios.get = async url => {
    requestedUrl = String(url);
    return {
      status: 200,
      data: [
        csvRecord('The Avengers (2012) 1080p BluRay', HASH_2012),
        csvRecord('The Avengers Infinity War (2018) 1080p BluRay', HASH_2018),
        csvRecord('The Avengers (2012) soundtrack FLAC', 'f'.repeat(40)),
        csvRecord('The Avengers (2012) 1080p', 'bad-hash')
      ]
    };
  };

  const streams = await TorrentsCsv.buscarStreams({
    title: 'The Avengers', year: 2012, type: 'movie'
  });

  assert.match(requestedUrl, /^https:\/\/torrents-csv\.com\/service\/search\?/);
  const params = new URL(requestedUrl).searchParams;
  assert.equal(params.get('q'), 'The Avengers');
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('type'), 'torrent');
  assert.ok(Number(params.get('size')) >= 10);
  assert.deepEqual(streams.map(stream => stream.infoHash), [HASH_2012]);
  assert.match(streams[0].name, /^Torrents\.csv/);
  assert.match(streams[0].url, /btih:a{40}/);
  assert.ok(streams[0]._meta.seeders === 23);
});

test('series devuelve sólo el episodio solicitado, nunca otro capítulo', async () => {
  axios.get = async () => ({
    status: 200,
    data: {
      results: [
        csvRecord('Breaking Bad S02E05 1080p WEB-DL', 'c'.repeat(40)),
        csvRecord('Breaking Bad S02E06 1080p WEB-DL', 'd'.repeat(40))
      ]
    }
  });

  const streams = await TorrentsCsv.buscarStreams({
    title: 'Breaking Bad', year: 2008, type: 'series', season: 2, episode: 5
  });
  assert.equal(streams.length, 1);
  assert.match(streams[0].title, /S02E05/);
  assert.equal(streams[0].infoHash, 'c'.repeat(40));
});

test('la integración respeta la selección de fuente `tcsv` y etiqueta sus streams', async () => {
  const addon = require('../index');
  axios.get = async () => ({
    status: 200,
    data: [csvRecord('Dune (2021) 1080p WEB-DL', 'e'.repeat(40))]
  });

  const streams = await addon._internals.buscarEnFuentesExternas({
    title: 'Dune', year: 2021, type: 'movie', config: { fuentes: 'tcsv' }
  });
  assert.equal(streams.length, 1);
  assert.match(streams[0].name, /^Torrents\.csv/);
  assert.equal(streams[0]._meta.fuente, 'tcsv');
});
