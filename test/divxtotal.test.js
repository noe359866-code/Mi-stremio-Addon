'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

const DivxTotal = require('../lib/divxtotal');
const addonInterface = require('../index');
const { normalizarConfig, fuentesActivas, aplicarConfig } = require('../lib/config');

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

function buildSampleTorrent({ name, length = 2147483648, files = null, pieceByte = 0x21 } = {}) {
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

function encodeShortInfo5xRot13(targetUrl) {
  let payload = DivxTotal.rot13(targetUrl);
  for (let i = 0; i < 5; i++) {
    payload = Buffer.from(payload, 'utf8').toString('base64');
  }
  return `https://short-info.link/s.php?i=${encodeURIComponent(payload)}`;
}

test('DivxTotal: decodificadores offline download_tt.php y short-info.link (5x Base64 + ROT13) sin llamadas externas', () => {
  const legacyUrl = 'https://www3.divxtotal.lol/wp-content/uploads/2026/02/Gigante-2026-4K.mkv.torrent';
  const b64 = Buffer.from(legacyUrl, 'utf8').toString('base64');

  const decodedTt = DivxTotal.decodeDownloadTt(
    `https://divxtotal.foo/download_tt.php?u=${encodeURIComponent(b64)}`,
    'https://divxtotal.foo'
  );
  assert.equal(decodedTt, 'https://divxtotal.foo/wp-content/uploads/2026/02/Gigante-2026-4K.mkv.torrent');

  const shortInfoHref = encodeShortInfo5xRot13(legacyUrl);
  const decodedShort = DivxTotal.decodeShortInfoLink(shortInfoHref, 'https://divxtotal.foo');
  assert.equal(decodedShort, 'https://divxtotal.foo/wp-content/uploads/2026/02/Gigante-2026-4K.mkv.torrent');

  assert.equal(
    DivxTotal.resolveDivxDownloadHref(shortInfoHref, 'https://divxtotal.foo'),
    'https://divxtotal.foo/wp-content/uploads/2026/02/Gigante-2026-4K.mkv.torrent'
  );
});

test('DivxTotal: parseSearchHtml filtra categorías no-vídeo y parseDetailHtml soporta películas y series rwd-table', () => {
  const searchHtml = `
    <html><body>
      <table class="table">
        <tbody>
          <tr>
            <td><a href="https://divxtotal.foo/peliculas-4k/gigante-2026/" title="Gigante (2026) 4K">Gigante (2026) 4K</a></td>
            <td>Peliculas 4K</td>
            <td>12-03-2026</td>
            <td>14.5 GB</td>
          </tr>
          <tr>
            <td><a href="https://divxtotal.foo/peliculas-hd/gigante-2026-hd/" title="Gigante (2026) (1080p) (DUAL)">Gigante (2026) (1080p) (DUAL)</a></td>
            <td>Peliculas HD</td>
            <td>12-03-2026</td>
            <td>4.2 GB</td>
          </tr>
          <tr>
            <td><a href="https://divxtotal.foo/programas/photoshop-2026/" title="Photoshop 2026">Photoshop 2026</a></td>
            <td>Programas</td>
            <td>12-03-2026</td>
            <td>2.1 GB</td>
          </tr>
        </tbody>
      </table>
    </body></html>
  `;

  const searchItems = DivxTotal.parseSearchHtml(searchHtml, { filterType: 'movie' });
  assert.equal(searchItems.length, 2);
  assert.equal(searchItems[0].slug, 'peliculas-4k/gigante-2026');
  assert.equal(searchItems[0].titulo, 'Gigante');
  assert.equal(searchItems[0].año, '2026');
  assert.equal(searchItems[0].calidad, '4K');
  assert.equal(searchItems[1].calidad, '1080p');
  assert.equal(searchItems[1].idioma, 'Latino/Inglés');

  const ep108Url = 'https://divxtotal.foo/wp-content/uploads/2019/07/Euphoria-Temporada-1-HDTVCap.108.avi.torrent';
  const ep107Url = 'https://divxtotal.foo/wp-content/uploads/2019/07/Euphoria-Temporada-1-HDTVCap.107.avi.torrent';
  const seriesHtml = `
    <html><body>
      <h1>Euphoria - serie</h1>
      <p>Titulo original: Euphoria (TV Series)</p>
      <p>Año: 2019</p>
      <h3>Temporada 1</h3>
      <table class="rwd-table">
        <tr>
          <td><img src="/images/ES.png" /> Euphoria1x08 FINAL TEMPORADA</td>
          <td><a class="linktorrent" href="${encodeShortInfo5xRot13(ep108Url)}">Descargar</a></td>
          <td><a class="opcion_2" href="/download_tt.php?u=${Buffer.from(ep108Url).toString('base64')}">Opcion 2</a></td>
        </tr>
        <tr>
          <td><img src="/images/LA.png" /> Euphoria1x07</td>
          <td><a class="linktorrent" href="${encodeShortInfo5xRot13(ep107Url)}">Descargar</a></td>
        </tr>
      </table>
    </body></html>
  `;

  const detail = DivxTotal.parseDetailHtml(seriesHtml, { slug: 'series/euphoria' });
  assert.equal(detail.tipo, 'serie');
  assert.equal(detail.titulo, 'Euphoria');
  assert.equal(detail.tituloOriginal, 'Euphoria');
  assert.equal(detail.año, '2019');
  assert.equal(detail.torrents.length, 2);

  const { exactos } = DivxTotal.filtrarPorEpisodio(detail.torrents, 1, 8);
  assert.equal(exactos.length, 1);
  assert.equal(exactos[0].season, 1);
  assert.equal(exactos[0].episode, 8);
  assert.equal(exactos[0].idioma, 'Castellano');
  assert.equal(exactos[0].downloadUrl, ep108Url);
});

test('DivxTotal: agrupa múltiples entradas por calidad, descarta soft-404 HTML y se integra de punta a punta con dt / es4', async () => {
  assert.deepEqual([...fuentesActivas({ fuentes: 'dt' })], ['dt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'es4' })], ['dt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'divxtotal' })], ['dt']);

  const t4k = buildSampleTorrent({
    name: 'Giant.2026.2160p.UHD.Castellano.mkv',
    length: 15569256448,
    pieceByte: 0x31
  });
  const t1080 = buildSampleTorrent({
    name: 'Giant.2026.1080p.BluRay.Dual.mkv',
    length: 4509715660,
    pieceByte: 0x32
  });

  const url4k = 'https://divxtotal.foo/wp-content/uploads/2026/03/Giant-2026-4K.torrent';
  const url1080 = 'https://divxtotal.foo/wp-content/uploads/2026/03/Giant-2026-1080p.torrent';
  const urlSoft404 = 'https://divxtotal.foo/wp-content/uploads/2026/03/Giant-2026-DVDRip-perdido.torrent';

  const origGet = axios.get;
  DivxTotal.clearCache();

  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('cinemeta-live.strem.io/meta/movie/tt9911001.json')) {
      return {
        status: 200,
        data: { meta: { id: 'tt9911001', name: 'Giant', year: '2026', type: 'movie' } }
      };
    }
    if (u.startsWith('https://divxtotal.foo/?s=')) {
      return {
        status: 200,
        data: `
          <table class="table"><tbody>
            <tr><td><a href="https://divxtotal.foo/peliculas-4k/gigante-2026/">Gigante (2026) 4K</a></td><td>Peliculas 4K</td><td>12-03-2026</td><td>14.5 GB</td></tr>
            <tr><td><a href="https://divxtotal.foo/peliculas-hd/gigante-2026-hd/">Gigante (2026) (1080p) (DUAL)</a></td><td>Peliculas HD</td><td>12-03-2026</td><td>4.2 GB</td></tr>
            <tr><td><a href="https://divxtotal.foo/peliculas/gigante-2026-dvdrip/">Gigante (2026) DVDRip</a></td><td>Peliculas</td><td>12-03-2026</td><td>1.4 GB</td></tr>
          </tbody></table>
        `
      };
    }
    if (u === 'https://divxtotal.foo/peliculas-4k/gigante-2026/') {
      return {
        status: 200,
        data: `
          <h1>Gigante (2026) 4K</h1>
          <p>Titulo original: Giant</p>
          <p>Año: 2026</p>
          <td><img src="/images/ES.png" /></td>
          <a class="opcion_2" href="/download_tt.php?u=${Buffer.from(url4k).toString('base64')}">Descargar</a>
        `
      };
    }
    if (u === 'https://divxtotal.foo/peliculas-hd/gigante-2026-hd/') {
      return {
        status: 200,
        data: `
          <h1>Gigante (2026) (1080p) (DUAL)</h1>
          <p>Titulo original: Giant</p>
          <p>Año: 2026</p>
          <a class="linktorrent" href="${encodeShortInfo5xRot13(url1080)}">Descargar</a>
        `
      };
    }
    if (u === 'https://divxtotal.foo/peliculas/gigante-2026-dvdrip/') {
      return {
        status: 200,
        data: `
          <h1>Gigante (2026) DVDRip</h1>
          <p>Titulo original: Giant</p>
          <p>Año: 2026</p>
          <a class="opcion_2" href="/download_tt.php?u=${Buffer.from(urlSoft404).toString('base64')}">Descargar</a>
        `
      };
    }
    if (u === url4k) return { status: 200, data: t4k.buffer };
    if (u === url1080) return { status: 200, data: t1080.buffer };
    if (u === urlSoft404) {
      // Soft-404 HTML devuelto con HTTP 200 cuando falta un upload antiguo
      return { status: 200, data: Buffer.from('<!doctype html><html><title>¿Te perdiste?</title></html>', 'utf8') };
    }
    const err = new Error(`404 ${u}`);
    err.response = { status: 404 };
    throw err;
  };

  try {
    const res = await addonInterface.get('stream', 'movie', 'tt9911001', {}, { fuentes: 'dt' });
    assert.equal(res.streams.length, 2);
    const hashes = res.streams.map(s => s.infoHash);
    assert.ok(hashes.includes(t4k.expectedHash));
    assert.ok(hashes.includes(t1080.expectedHash));
    for (const s of res.streams) {
      assert.match(s.name, /^DivxTotal\n/);
      assert.equal(s._meta, undefined);
      assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
    }

    // Resolución directa por id propio dt:
    const directRes = await addonInterface.get('stream', 'movie', 'dt:peliculas-4k/gigante-2026', {}, { fuentes: 'es4' });
    assert.equal(directRes.streams.length, 1);
    assert.equal(directRes.streams[0].infoHash, t4k.expectedHash);

    // Si el usuario elige explícitamente fuentes="ht,knaben,tcsv" (sin dt), ni siquiera se consulta DivxTotal
    const excludedFlow = await addonInterface.get('stream', 'movie', 'tt9911001', {}, { fuentes: 'ht,knaben,tcsv' });
    assert.equal(excludedFlow.streams.length, 0);

    // En aplicarConfig: sin fuentes explícitas se incluye junto a ht; con fuentes explícitas sin dt se filtra
    const htHash = 'a'.repeat(40);
    const htStream = {
      name: 'HackTorrent\n1080p',
      title: 'Gigante',
      infoHash: htHash,
      sources: [`dht:${htHash}`],
      _meta: { fuente: 'hacktorrent', idioma: 'Latino', calidad: '1080p', seeders: 0, pack: false }
    };
    const dtStream = {
      name: 'DivxTotal\n4K',
      title: 'Gigante',
      infoHash: t4k.expectedHash,
      sources: [`dht:${t4k.expectedHash}`],
      _meta: { fuente: 'divxtotal', idioma: 'Castellano', calidad: '4K', seeders: 0, pack: false }
    };
    assert.equal(aplicarConfig([htStream, dtStream], undefined).length, 2);
    assert.equal(aplicarConfig([htStream, dtStream], { fuentes: 'ht,knaben,tcsv' }).length, 1);
  } finally {
    axios.get = origGet;
    DivxTotal.clearCache();
  }
});
