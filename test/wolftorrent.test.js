'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

const WolfTorrent = require('../lib/wolftorrent');
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

function buildSampleTorrent({ name, length = 3221225472, files = null, pieceByte = 0x61 } = {}) {
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

function encryptOpenSslSalted(plainText, passphrase = WolfTorrent.TORRENT_LINK_ENCRYPTION_KEY, doubleBase64 = false) {
  const salt = Buffer.from('12345678', 'ascii');
  const { key, iv } = WolfTorrent.deriveOpenSslKeyAndIv(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  const salted = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, enc]);
  const b64 = salted.toString('base64');
  return doubleBase64 ? Buffer.from(b64, 'utf8').toString('base64') : b64;
}

test('WolfTorrent: Proof-of-Work SHA-256, desencriptación OpenSSL Salted__ Enlacito, carátulas Base64 e IDs de solo letras', () => {
  // 1) PoW SHA-256 real
  const challenge = 'wolf-test-challenge-2026';
  const nonces = WolfTorrent.computeProofOfWork(challenge, 2, 2);
  assert.equal(nonces.length, 2);
  for (let r = 0; r < 2; r++) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${r}:${nonces[r]}`).digest('hex');
    assert.ok(digest.startsWith('00'), `Ronda ${r} debe empezar por "00": ${digest}`);
  }

  // 2) Desencriptación AES-256-CBC OpenSSL Salted__ (1x y 2x Base64)
  const secretUrl = 'https://wolftorrent.com/torrents/peliculas/Bad-Apples-2025-4K.torrent';
  const payload1x = encryptOpenSslSalted(secretUrl, WolfTorrent.TORRENT_LINK_ENCRYPTION_KEY, false);
  const payload2x = encryptOpenSslSalted(secretUrl, WolfTorrent.TORRENT_LINK_ENCRYPTION_KEY, true);
  assert.equal(WolfTorrent.decryptEnlacitoPayload(payload1x), secretUrl);
  assert.equal(WolfTorrent.decryptEnlacitoPayload(payload2x), secretUrl);

  // 3) Carátula Base64 real de WolfTorrent -> año (2025)
  const b64Name = Buffer.from('Bad-Apples-(2025)-[BluRay-720p]-[DonTorrent]-[9acD].jpg', 'utf8').toString('base64');
  const hint = WolfTorrent.decodeCaratulaHint(`/caratulas/peliculas/${b64Name}/bad-apples.jpg`);
  assert.equal(hint.año, '2025');

  // 4) IDs alfanuméricos y de solo letras (p. ej. rytkrd) aceptados; rutas de listado rechazadas
  assert.equal(WolfTorrent.urlToSlug('/pelicula/rytkrd'), 'pelicula/rytkrd');
  assert.equal(WolfTorrent.urlToSlug('/pelicula/r8e6a8'), 'pelicula/r8e6a8');
  assert.equal(WolfTorrent.urlToSlug('/serie/episodio/5jdgc3'), 'serie/episodio/5jdgc3');
  assert.equal(WolfTorrent.urlToSlug('/pelicula/calidad'), null);
  assert.equal(WolfTorrent.urlToSlug('/serie/buscar'), null);
});

test('WolfTorrent: tarjetas multicalidad wolf-card, expansión AJAX /api/episodios, PoW + Enlacito y flujo Stremio wt / es6', async () => {
  assert.deepEqual([...fuentesActivas({ fuentes: 'wt' })], ['wt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'es6' })], ['wt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'wolftorrent' })], ['wt']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'wolfmax4k' })], ['wt']);

  const movie4k = buildSampleTorrent({
    name: 'Bad.Apples.2025.2160p.WEB-DL.Castellano.mkv',
    length: 12884901888,
    pieceByte: 0x71
  });
  const movie1080 = buildSampleTorrent({
    name: 'Bad.Apples.2025.1080p.BluRay.Castellano.mkv',
    length: 4294967296,
    pieceByte: 0x72
  });
  const serieEp02 = buildSampleTorrent({
    name: 'Materia.Oscura.1x02.1080p.WEB-DL.mkv',
    length: 2147483648,
    pieceByte: 0x73
  });

  const posterB64 = Buffer.from('Bad-Apples-(2025)-[BluRay-1080p].jpg', 'utf8').toString('base64');
  const encryptedMovie1080Link = encryptOpenSslSalted('https://wolftorrent.com/torrents/peliculas/Bad-Apples-1080p.torrent');

  const origGet = axios.get;
  const origPost = axios.post;
  WolfTorrent.clearCache();

  let episodesHeaderChecked = false;
  let validateCallsFor1080 = 0;

  axios.get = async (url, config = {}) => {
    const u = String(url);

    if (u.includes('cinemeta-live.strem.io/meta/movie/tt8822001.json')) {
      return {
        status: 200,
        data: { meta: { id: 'tt8822001', name: 'Bad Apples', year: '2025', type: 'movie' } }
      };
    }
    if (u.includes('cinemeta-live.strem.io/meta/series/tt8822002.json')) {
      return {
        status: 200,
        data: { meta: { id: 'tt8822002', name: 'Materia oscura', year: '2024', type: 'series' } }
      };
    }

    if (u.startsWith('https://wolftorrent.com/buscar?q=Bad')) {
      return {
        status: 200,
        data: `
          <article class="wolf-card">
            <div class="wolf-card-poster">
              <img data-original="/caratulas/peliculas/${posterB64}/bad-apples.jpg" />
            </div>
            <a class="wolf-card-main" href="/pelicula/rytkrd">Bad Apples</a>
            <ul class="wolf-card-files">
              <li class="wolf-card-file">
                <a class="wolf-card-format" href="/pelicula/rytkrd"><strong>4KWebrip</strong></a>
                <span class="wolf-card-size">12,00 GB</span>
                <button class="protected-download" data-content-code="rytkrd" data-tabla="peliculas">Descargar</button>
              </li>
              <li class="wolf-card-file">
                <a class="wolf-card-format" href="/pelicula/r8e6a8"><strong>BluRay-1080p</strong></a>
                <span class="wolf-card-size">4,00 GB</span>
                <button class="protected-download" data-content-code="r8e6a8" data-tabla="peliculas">Descargar</button>
              </li>
            </ul>
          </article>
        `
      };
    }

    if (u.startsWith('https://wolftorrent.com/buscar?q=Materia')) {
      return {
        status: 200,
        data: `
          <article class="wolf-card">
            <a class="wolf-card-main" href="/serie/5jbu5x">Materia oscura - 1ª Temporada</a>
            <ul class="wolf-card-files">
              <li class="wolf-card-file">
                <a class="wolf-card-format" href="/serie/episodio/5jdgc9"><strong>Episodio 1x09 -</strong><span>HDTV-1080p</span></a>
                <span class="wolf-card-size">1,95 GB</span>
                <button class="protected-download" data-content-code="5jdgc9" data-tabla="series">Descargar</button>
              </li>
            </ul>
            <details data-wolf-episodes="/api/episodios?type=serie&id=715963&after=716195&calidad="></details>
          </article>
        `
      };
    }

    if (u === 'https://wolftorrent.com/api/episodios?type=serie&id=715963&calidad=') {
      assert.equal(config?.headers?.['X-Requested-With'], 'XMLHttpRequest');
      episodesHeaderChecked = true;
      return {
        status: 200,
        data: JSON.stringify({
          success: true,
          html: `
            <li class="wolf-card-file">
              <a class="wolf-card-format" href="/serie/episodio/5jdgc2"><strong>Episodio 1x01 - 02.</strong><span>HDTV-1080p</span></a>
              <span class="wolf-card-size">2,00 GB</span>
              <button class="protected-download" data-content-code="5jdgc2" data-tabla="series">Descargar</button>
            </li>
          `,
          next_after: null
        })
      };
    }

    if (u === 'https://enlacito.com/s.php?i=tok1080') {
      return {
        status: 200,
        headers: { 'set-cookie': ['PHPSESSID=enlacito123; Path=/'] },
        data: `<form method="post" action="/s.php?i=tok1080"><input type="hidden" name="linkser" value="1"/><input type="hidden" name="flow" value="abc"/></form>`
      };
    }

    if (u === 'https://wolftorrent.com/torrents/peliculas/Bad-Apples-4K.torrent') {
      return { status: 200, data: movie4k.buffer };
    }
    if (u === 'https://wolftorrent.com/torrents/peliculas/Bad-Apples-1080p.torrent') {
      return { status: 200, data: movie1080.buffer };
    }
    if (u === 'https://wolftorrent.com/torrents/series/Materia-Oscura-1x01-02.torrent') {
      return { status: 200, data: serieEp02.buffer };
    }

    const err = new Error(`404 ${u}`);
    err.response = { status: 404 };
    throw err;
  };

  axios.post = async (url, body, config = {}) => {
    const u = String(url);
    if (u === 'https://wolftorrent.com/api/descargas') {
      const payload = typeof body === 'string' ? JSON.parse(body) : body;
      if (payload.action === 'generate') {
        return {
          status: 200,
          headers: { 'set-cookie': [`WT_SESS=${payload.code}; Path=/`] },
          data: {
            success: true,
            challenge: `chal-${payload.code}`,
            pow: { rounds: 2, difficulty: 2, min_duration_ms: 0 }
          }
        };
      }
      if (payload.action === 'validate') {
        assert.ok(Array.isArray(payload.nonces) && payload.nonces.length === 2);
        assert.match(String(config?.headers?.Cookie || ''), /WT_SESS=/);

        if (payload.challenge === 'chal-rytkrd') {
          return {
            status: 200,
            data: { success: true, download_url: '//wolftorrent.com/torrents/peliculas/Bad-Apples-4K.torrent', external: false }
          };
        }
        if (payload.challenge === 'chal-r8e6a8') {
          validateCallsFor1080++;
          if (validateCallsFor1080 === 1) {
            return { status: 200, data: { status: 'pow_pending', retry_after_ms: 10 } };
          }
          return {
            status: 200,
            data: { success: true, download_url: 'https://enlacito.com/s.php?i=tok1080', external: true }
          };
        }
        if (payload.challenge === 'chal-5jdgc2') {
          return {
            status: 200,
            data: { success: true, download_url: '/torrents/series/Materia-Oscura-1x01-02.torrent', external: false }
          };
        }
      }
    }

    if (u === 'https://enlacito.com/s.php?i=tok1080') {
      assert.match(String(config?.headers?.Cookie || ''), /PHPSESSID=enlacito123/);
      return {
        status: 200,
        data: `<script>var link_out = "${encryptedMovie1080Link}";</script>`
      };
    }

    throw new Error(`Unexpected POST ${u}`);
  };

  try {
    // 1) Película multicalidad (4KWebrip directo + BluRay-1080p vía Enlacito AES + reintento pow_pending)
    const movieRes = await addonInterface.get('stream', 'movie', 'tt8822001', {}, { fuentes: 'wt' });
    assert.equal(movieRes.streams.length, 2);
    const movieHashes = movieRes.streams.map(s => s.infoHash);
    assert.ok(movieHashes.includes(movie4k.expectedHash));
    assert.ok(movieHashes.includes(movie1080.expectedHash));

    // 2) Serie expandiendo /api/episodios sin &after= y con X-Requested-With: XMLHttpRequest
    const seriesRes = await addonInterface.get('stream', 'series', 'tt8822002:1:2', {}, { fuentes: 'es6' });
    assert.equal(episodesHeaderChecked, true);
    assert.equal(seriesRes.streams.length, 1);
    assert.equal(seriesRes.streams[0].infoHash, serieEp02.expectedHash);
    assert.match(seriesRes.streams[0].name, /^WolfTorrent\n/);
  } finally {
    axios.get = origGet;
    axios.post = origPost;
    WolfTorrent.clearCache();
  }
});

test('WolfTorrent: degrada limpiamente y activa cortacircuitos temporal cuando /api/descargas exige Turnstile (captcha_required)', async () => {
  const origGet = axios.get;
  const origPost = axios.post;
  WolfTorrent.clearCache();

  let postCount = 0;
  axios.get = async () => ({
    status: 200,
    data: `
      <article class="wolf-card">
        <a class="wolf-card-main" href="/pelicula/r8e6a8">Bad Apples (2025)</a>
        <ul class="wolf-card-files">
          <li class="wolf-card-file">
            <a class="wolf-card-format" href="/pelicula/r8e6a8"><strong>BluRay-1080p</strong></a>
            <button class="protected-download" data-content-code="r8e6a8" data-tabla="peliculas">Descargar</button>
          </li>
        </ul>
      </article>
    `
  });
  axios.post = async () => {
    postCount++;
    return {
      status: 403,
      data: { success: false, status: 'captcha_required', error: 'Completa la verificación humana Turnstile' }
    };
  };

  try {
    const first = await WolfTorrent.buscarStreams({ title: 'Bad Apples', year: '2025', type: 'movie' });
    assert.deepEqual(first, []);
    assert.equal(postCount, 1);

    // La segunda llamada inmediata debe respetar el cortacircuitos sin volver a golpear /api/descargas
    const second = await WolfTorrent.buscarStreams({ title: 'Bad Apples', year: '2025', type: 'movie' });
    assert.deepEqual(second, []);
    assert.equal(postCount, 1);
  } finally {
    axios.get = origGet;
    axios.post = origPost;
    WolfTorrent.clearCache();
  }
});
