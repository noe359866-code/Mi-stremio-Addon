'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

const MejorTorrent = require('../lib/mejortorrent');
const addonInterface = require('../index');
const { fuentesActivas } = require('../lib/config');

function bencodeEncode(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`, 'ascii'), value]);
  }
  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${buf.length}:`, 'ascii'), buf]);
  }
  if (typeof value === 'number') {
    return Buffer.from(`i${Math.trunc(value)}e`, 'ascii');
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l', 'ascii'),
      ...value.map(bencodeEncode),
      Buffer.from('e', 'ascii')
    ]);
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from('d', 'ascii')];
    for (const k of keys) {
      parts.push(bencodeEncode(k), bencodeEncode(value[k]));
    }
    parts.push(Buffer.from('e', 'ascii'));
    return Buffer.concat(parts);
  }
  throw new Error('Unsupported value in bencodeEncode');
}

function buildSampleTorrent({ name, length = 1825361100, files = null, pieceByte = 0x44 } = {}) {
  const info = {
    name,
    'piece length': 262144,
    pieces: Buffer.alloc(20, pieceByte)
  };
  if (Array.isArray(files)) {
    info.files = files;
  } else {
    info.length = length;
  }
  const infoEncoded = bencodeEncode(info);
  const expectedHash = crypto.createHash('sha1').update(infoEncoded).digest('hex').toLowerCase();
  const rootEncoded = bencodeEncode({
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    info
  });
  return { buffer: rootEncoded, expectedHash };
}

test('MejorTorrent: rotación de subdominios wwwNN, saneado Latin-1, rangos de episodios y rechazo de contraseñas RAR', () => {
  assert.equal(
    MejorTorrent.isSameMejorTorrentHost('https://www47.mejortorrent.eu/pelicula/1/foo', 'https://www45.mejortorrent.eu/torrents/peliculas/foo.torrent'),
    true
  );
  assert.equal(
    MejorTorrent.isSameMejorTorrentHost('https://www47.mejortorrent.eu/pelicula/1/foo', 'https://evil.example.com/foo.torrent'),
    false
  );

  // Elimina caracteres fuera de Latin-1 (> \u00FF), S02E05, año final y etiquetas de idioma
  const sanitized = MejorTorrent.sanitizeSearchQuery('Shōgun — Breaking Bad S02E05 (2024) Castellano');
  assert.ok(!/[^\u0001-\u00FF]/.test(sanitized));
  assert.ok(!/S02E05/i.test(sanitized));
  assert.ok(!/2024/.test(sanitized));
  assert.ok(!/castellano/i.test(sanitized));

  // Títulos con temporada y calidad
  const parsedSeason = MejorTorrent.parseMejorTitle('Breaking Bad - 2ª Temporada [1080p]', 'HDTV-1080p', 'serie/26871/breaking-bad-2a-temporada-1080p');
  assert.equal(parsedSeason.titulo, 'Breaking Bad');
  assert.equal(parsedSeason.seasonHint, 2);
  assert.equal(parsedSeason.calidad, '1080p');

  // Expansión de rangos y listas de episodios
  const packRange = MejorTorrent.parseMejorEpisodeCell('2x01 al 2x13.');
  assert.equal(packRange.season, 2);
  assert.equal(packRange.esPack, true);
  assert.equal(packRange.episodes.length, 13);

  const pairList = MejorTorrent.parseMejorEpisodeCell('2x04 - 2x05.');
  assert.equal(pairList.season, 2);
  assert.deepEqual(pairList.episodes, [4, 5]);
  assert.equal(pairList.esPack, false);

  // Detección de contraseña RAR
  assert.equal(MejorTorrent.hasRarPassword('Sin clave'), false);
  assert.equal(MejorTorrent.hasRarPassword(''), false);
  assert.equal(MejorTorrent.hasRarPassword('www.mejortorrent.eu'), true);
  assert.equal(MejorTorrent.hasRarPassword('Sin clave', '1x03 CONTRASEÑA: abc'), true);
});

test('MejorTorrent: failover entre espejos wwwNN, agrupación multicalidad por temporada, fileIdx multifile y exclusión RAR', async () => {
  assert.deepEqual([...fuentesActivas({ fuentes: 'mt' })], ['mt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'es5' })], ['mt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'mejortorrent' })], ['mt']);

  const ep1080Pack = buildSampleTorrent({
    name: 'Breaking.Bad.T2.1080p.Castellano',
    files: [
      { length: 1500000000, path: ['Breaking.Bad.2x04.1080p.mkv'] },
      { length: 1620000000, path: ['Breaking.Bad.2x05.1080p.mkv'] }
    ],
    pieceByte: 0x51
  });
  const ep720Exact = buildSampleTorrent({
    name: 'Breaking.Bad.2x05.720p.HDTV.mkv',
    length: 890000000,
    pieceByte: 0x52
  });
  const rarOnlyTorrent = buildSampleTorrent({
    name: 'Breaking.Bad.2x05.RAR',
    files: [
      { length: 900000000, path: ['Breaking.Bad.2x05.part1.rar'] }
    ],
    pieceByte: 0x53
  });

  const origGet = axios.get;
  MejorTorrent.clearCache();

  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('cinemeta-live.strem.io/meta/series/tt0903747.json')) {
      return {
        status: 200,
        data: { meta: { id: 'tt0903747', name: 'Breaking Bad', year: '2008', type: 'series' } }
      };
    }

    // Simular caída de red en www47 para comprobar el failover automático a www46
    if (u.startsWith('https://www47.mejortorrent.eu/')) {
      const netErr = new Error('connect ECONNREFUSED www47');
      netErr.code = 'ECONNREFUSED';
      throw netErr;
    }

    if (u.startsWith('https://www46.mejortorrent.eu/busqueda?q=')) {
      return {
        status: 200,
        data: `
          <div class="w-11/12">
            <a href="/serie/1001/breaking-bad-1a-temporada-1080p">Breaking Bad - 1ª Temporada [1080p] <span>(HDTV-1080p)</span></a>
            <a href="/serie/2001/breaking-bad-2a-temporada-1080p">Breaking Bad - 2ª Temporada [1080p] <span>(HDTV-1080p)</span></a>
            <a href="/serie/2002/breaking-bad-2a-temporada-720p">Breaking Bad - 2ª Temporada [720p] <span>(HDTV-720p)</span></a>
          </div>
        `
      };
    }

    if (u === 'https://www46.mejortorrent.eu/serie/2001/breaking-bad-2a-temporada-1080p') {
      return {
        status: 200,
        data: `
          <h1>Breaking Bad - 2ª Temporada [1080p]</h1>
          <p>Año: 2009</p>
          <p>Formato: HDTV-1080p</p>
          <table>
            <tr class="border">
              <td>1</td>
              <td>2x04 - 2x05.</td>
              <td>2009-04-05</td>
              <td>Sin clave</td>
              <td><a href="https://www45.mejortorrent.eu/torrents/series/Breaking-Bad-2x04-05-1080p.torrent">Descargar</a></td>
            </tr>
            <tr class="border">
              <td>2</td>
              <td>2x05.</td>
              <td>2009-04-05</td>
              <td>clave-secreta-123</td>
              <td><a href="/torrents/series/Breaking-Bad-2x05-con-clave.torrent">Descargar</a></td>
            </tr>
          </table>
        `
      };
    }

    if (u === 'https://www46.mejortorrent.eu/serie/2002/breaking-bad-2a-temporada-720p') {
      return {
        status: 200,
        data: `
          <h1>Breaking Bad - 2ª Temporada [720p]</h1>
          <p>Año: 2009</p>
          <p>Formato: HDTV-720p</p>
          <table>
            <tr class="border">
              <td>1</td>
              <td>2x05.</td>
              <td>2009-04-05</td>
              <td>Sin clave</td>
              <td><a href="/torrents/series/Breaking-Bad-2x05-720p.torrent">Descargar</a></td>
            </tr>
            <tr class="border">
              <td>2</td>
              <td>2x05.</td>
              <td>2009-04-05</td>
              <td>Sin clave</td>
              <td><a href="/torrents/series/Breaking-Bad-2x05-solo-rar.torrent">Descargar</a></td>
            </tr>
          </table>
        `
      };
    }

    if (u === 'https://www46.mejortorrent.eu/torrents/series/Breaking-Bad-2x04-05-1080p.torrent') {
      return { status: 200, data: ep1080Pack.buffer };
    }
    if (u === 'https://www46.mejortorrent.eu/torrents/series/Breaking-Bad-2x05-720p.torrent') {
      return { status: 200, data: ep720Exact.buffer };
    }
    if (u === 'https://www46.mejortorrent.eu/torrents/series/Breaking-Bad-2x05-solo-rar.torrent') {
      return { status: 200, data: rarOnlyTorrent.buffer };
    }

    const err = new Error(`404 ${u}`);
    err.response = { status: 404 };
    throw err;
  };

  try {
    const res = await addonInterface.get('stream', 'series', 'tt0903747:2:5', {}, { fuentes: 'mt' });
    assert.equal(res.streams.length, 2);

    const byHash = new Map(res.streams.map(s => [s.infoHash, s]));
    assert.ok(byHash.has(ep1080Pack.expectedHash), 'Debe incluir el torrent 1080p multiepisodio');
    assert.ok(byHash.has(ep720Exact.expectedHash), 'Debe incluir también la variante 720p');
    assert.ok(!byHash.has(rarOnlyTorrent.expectedHash), 'No debe incluir archivos exclusivamente .rar');

    // En el torrent multifile [2x04, 2x05], Stremio debe apuntar exactamente al índice 1 (2x05)
    assert.equal(byHash.get(ep1080Pack.expectedHash).fileIdx, 1);
  } finally {
    axios.get = origGet;
    MejorTorrent.clearCache();
  }
});
