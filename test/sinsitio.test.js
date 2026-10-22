'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

const SinSitio = require('../lib/sinsitio');
const { normalizarConfig, aplicarConfig, fuentesActivas, BEAMUP_HOST, BEAMUP_ORIGIN } = require('../lib/config');
const { renderConfigPage } = require('../lib/configPage');
const manifest = require('../manifest.json');
const beamupConfig = require('../beamup.json');

/**
 * Codificador Bencode auxiliar para construir buffers .torrent sintéticos en los tests.
 */
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
  throw new Error('Tipo no soportado en bencodeEncode');
}

function buildSampleTorrent({ name = 'Runner.2026.1080p.WEB-DL.Latino.mp4', length = 1932735283, files = null } = {}) {
  const info = {
    name,
    'piece length': 262144,
    pieces: Buffer.alloc(20, 0xab)
  };
  if (Array.isArray(files)) {
    info.files = files;
  } else {
    info.length = length;
  }
  const infoEncoded = bencodeEncode(info);
  const expectedHash = crypto.createHash('sha1').update(infoEncoded).digest('hex').toLowerCase();
  const root = {
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    'announce-list': [
      ['udp://tracker.opentrackr.org:1337/announce'],
      ['udp://open.demonii.com:1337/announce']
    ],
    comment: '4:info fake marker inside comment',
    info
  };
  return {
    buffer: bencodeEncode(root),
    expectedHash
  };
}

test('SinSitio: parseTorrentBuffer calcula el infoHash SHA-1 exacto aunque exista "4:info" en un comentario previo', () => {
  const { buffer, expectedHash } = buildSampleTorrent({
    name: 'Sociedad.Secreta.De.Mentiras.1080p.Castellano.mkv',
    length: 1717986918
  });

  const parsed = SinSitio.parseTorrentBuffer(buffer);
  assert.equal(parsed.infoHash, expectedHash);
  assert.equal(parsed.name, 'Sociedad.Secreta.De.Mentiras.1080p.Castellano.mkv');
  assert.equal(parsed.length, 1717986918);
  assert.ok(parsed.magnet.startsWith(`magnet:?xt=urn:btih:${expectedHash}`));
  assert.ok(parsed.trackers.includes('udp://tracker.opentrackr.org:1337/announce'));
});

test('SinSitio: selectFileIdxForEpisode selecciona el archivo correcto en packs y episodios dobles (1x1x2)', () => {
  const { buffer } = buildSampleTorrent({
    name: 'Materia-oscura-1x1x2-hdtv-xvid-castellano',
    files: [
      { length: 120, path: ['Leeme.txt'] },
      { length: 450000000, path: ['Materia Oscura 1x01 Castellano.avi'] },
      { length: 460000000, path: ['Materia Oscura 1x02 Castellano.avi'] }
    ]
  });

  const parsed = SinSitio.parseTorrentBuffer(buffer);
  assert.equal(parsed.files.length, 3);
  assert.equal(SinSitio.selectFileIdxForEpisode(parsed.files, 1, 1), 1);
  assert.equal(SinSitio.selectFileIdxForEpisode(parsed.files, 1, 2), 2);
});

test('SinSitio: decodeSinsitioDownload decodifica enlaces reales ddlUrl.php?url=<base64>&name=...', () => {
  const liveHref =
    'https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9NzE0Mzc%3D&name=Sociedad%20Secreta%20De%20Mentiras%20Castellano%20H264%20Ac3%202%200%20Bdrip%20Hd%201080p';

  const decoded = SinSitio.decodeSinsitioDownload(liveHref);
  assert.ok(decoded);
  assert.equal(decoded.downloadUrl, 'https://www.sinsitio.site/index.php?do=download&id=71437');
  assert.equal(decoded.attachmentId, '71437');
  assert.equal(
    decoded.releaseName,
    'Sociedad Secreta De Mentiras Castellano H264 Ac3 2 0 Bdrip Hd 1080p'
  );

  // Enlace relativo también funciona
  const relDecoded = SinSitio.decodeSinsitioDownload(liveHref.replace('https://www.sinsitio.site', ''));
  assert.equal(relDecoded.downloadUrl, 'https://www.sinsitio.site/index.php?do=download&id=71437');
});

test('SinSitio: parseAnchorNameAndSize separa el tamaño pegado al final del texto del enlace', () => {
  // Caso real de "From (2022-26)" donde "Temporada 1" + "807.24 MB" se pegaban como "Temporada 1807.24 MB"
  const fromRes = SinSitio.parseAnchorNameAndSize(
    '🎬 From 2022 26 Temporada 1807.24 MB',
    'From 2022 26 Temporada 1'
  );
  assert.equal(fromRes.title, 'From 2022 26 Temporada 1');
  assert.equal(fromRes.size, '807.24 MB');

  // Caso real donde "1080p" + "8 GB" se pegaban como "1080p8 GB"
  const movieRes = SinSitio.parseAnchorNameAndSize(
    '🎬 Tu Corazn Ser Destrozado Lat Rus Subt Esp H264 E Ac3 5 1 Bdrip Hd 1080p8 GB',
    'Tu Corazn Ser Destrozado Lat Rus Subt Esp H264 E Ac3 5 1 Bdrip Hd 1080p'
  );
  assert.equal(movieRes.title, 'Tu Corazn Ser Destrozado Lat Rus Subt Esp H264 E Ac3 5 1 Bdrip Hd 1080p');
  assert.equal(movieRes.size, '8 GB');
});

test('SinSitio: parseSeasonEpisodes soporta episodios simples, dobles (1x1x2, 1x5x6) y packs', () => {
  const dual = SinSitio.parseSeasonEpisodes('Materia-oscura-1x1x2-hdtv-xvid-castellano');
  assert.equal(dual.season, 1);
  assert.deepEqual(dual.episodes, [1, 2]);
  assert.equal(dual.isPack, false);

  const dual2 = SinSitio.parseSeasonEpisodes('Daredevil-born-again-1x5x6-hdtv-xvid-castellano');
  assert.equal(dual2.season, 1);
  assert.deepEqual(dual2.episodes, [5, 6]);

  const pack = SinSitio.parseSeasonEpisodes('From 2022 26 Temporada 3');
  assert.equal(pack.season, 3);
  assert.deepEqual(pack.episodes, []);
  assert.equal(pack.isPack, true);
});

test('SinSitio: parseListingHtml filtra categorías no-video (/musica/, /xxx/, /detodounpoco/, pedidos)', () => {
  const sampleSearchHtml = `
    <div class="content">
      <a href="https://www.sinsitio.site/series/14275-materia-oscura-t1.html" title="Materia Oscura T1 T2">
        <img src="/uploads/posts/2026-08/medium/dark_matter.jpg" alt="Materia Oscura T1 T2">
        <h4>Materia Oscura T1 T2</h4>
      </a>
      <a href="https://www.sinsitio.site/dvdrip-bdrip/36723-malas-manzanas-bad-apples-bdrip-xvid-castellano.html" title="Malas manzanas (Bad Apples) BDrip XviD Castellano">
        <h4>Malas manzanas (Bad Apples) BDrip XviD Castellano</h4>
      </a>
      <a href="https://www.sinsitio.site/musica/2993-melodic-amp-deep-vol07-2020-mp3-320-kbps.html" title="Melodic & Deep Vol.07 (2020) MP3">
        <h4>Melodic & Deep Vol.07 (2020) MP3</h4>
      </a>
      <a href="https://www.sinsitio.site/xxx/15356-private-special-1080p.html" title="Private Special">
        <h4>Private Special</h4>
      </a>
      <a href="https://www.sinsitio.site/detodounpoco/28206-grilla-2026-de-series-.html" title="Grilla 2026 de series !!">
        <h4>Grilla 2026 de series !!</h4>
      </a>
      <a href="https://www.sinsitio.site/estrenos/19619-haz-tu-pedido-aqu.html" title="Haz Tu Pedido Aquí">
        <h4>Haz Tu Pedido Aquí</h4>
      </a>
    </div>
  `;

  const items = SinSitio.parseListingHtml(sampleSearchHtml);
  assert.equal(items.length, 2);

  assert.equal(items[0].slug, 'series__14275-materia-oscura-t1');
  assert.equal(items[0].titulo, 'Materia Oscura');
  assert.equal(items[0].tipo, 'serie');
  assert.equal(items[0].poster, 'https://www.sinsitio.site/uploads/posts/2026-08/medium/dark_matter.jpg');

  assert.equal(items[1].slug, 'dvdrip-bdrip__36723-malas-manzanas-bad-apples-bdrip-xvid-castellano');
  assert.equal(items[1].titulo, 'Malas manzanas');
  assert.equal(items[1].tituloOriginal, 'Bad Apples');
  assert.equal(items[1].tipo, 'pelicula');
});

test('SinSitio: parseDetailHtml extrae ficha técnica, encabezados de temporada y expande episodios dobles', () => {
  const detailHtml = `
    <html>
      <body>
        <h1>Materia Oscura T1 T2</h1>
        <img src="/uploads/posts/2026-08/medium/dark%20matter%20large.jpg">
        <p>Título original\n    Dark Matter</p>
        <p>Año\n    2024</p>
        <p>Género\n    Serie de TV. Ciencia ficción. Intriga | Viajes en el tiempo</p>
        <p>Sinopsis\n    El físico Jason Dessen acaba en una versión alternativa de su vida.</p>
        <p><strong>T1</strong></p>
        <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9MjMzMTc%3D&name=Materia-oscura-1x1x2-hdtv-xvid-castellano">🎬 Materia-oscura-1x1x2-hdtv-xvid-castellano</a>
        <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9MjMzMTg%3D&name=Materia-oscura-1x3-hdtv-xvid-castellano">🎬 Materia-oscura-1x3-hdtv-xvid-castellano</a>
        <p><strong>T2</strong></p>
        <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9NjcxOTA%3D&name=Materia%20Oscura%202x1%20Hdtv%20Xvid%20Castellano">🎬 Materia Oscura 2x1 Hdtv Xvid Castellano699.7 MB</a>
        <div id="dle-comments-list">
          <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9OTk5OTk%3D&name=Spam">Spam</a>
        </div>
      </body>
    </html>
  `;

  const parsed = SinSitio.parseDetailHtml(
    detailHtml,
    'https://www.sinsitio.site/series/14275-materia-oscura-t1.html'
  );

  assert.equal(parsed.titulo, 'Materia Oscura');
  assert.equal(parsed.tituloOriginal, 'Dark Matter');
  assert.equal(parsed.año, '2024');
  assert.equal(parsed.tipo, 'serie');
  // 1x1x2 genera 2 entradas (ep 1 y ep 2) + 1x3 (ep 3) + 2x1 (T2 ep 1) = 4 entradas (el comentario fue ignorado)
  assert.equal(parsed.torrents.length, 4);
  assert.equal(parsed.torrents[0].temporada, 1);
  assert.equal(parsed.torrents[0].episodio, 1);
  assert.equal(parsed.torrents[1].temporada, 1);
  assert.equal(parsed.torrents[1].episodio, 2);
  assert.equal(parsed.torrents[2].temporada, 1);
  assert.equal(parsed.torrents[2].episodio, 3);
  assert.equal(parsed.torrents[3].temporada, 2);
  assert.equal(parsed.torrents[3].episodio, 1);
  assert.equal(parsed.torrents[3].tamaño, '699.7 MB');
});

test('SinSitio: buscarStreams empareja por título original en inglés, pre-filtra el episodio y envía el Referer de la ficha al descargar el .torrent', async () => {
  SinSitio.clearCache();
  const origGet = axios.get;

  const { buffer: ep2Buffer, expectedHash } = buildSampleTorrent({
    name: 'Materia.Oscura.2x01.HDTV.Castellano.avi',
    length: 733693952
  });

  const requests = [];
  axios.get = async (url, config = {}) => {
    requests.push({ url, headers: config.headers || {} });
    if (url.includes('do=search')) {
      return {
        data: `
          <a href="https://www.sinsitio.site/series/14275-materia-oscura-t1.html" title="Materia Oscura T1 T2">
            <h4>Materia Oscura T1 T2</h4>
          </a>
        `
      };
    }
    if (url.endsWith('14275-materia-oscura-t1.html')) {
      return {
        data: `
          <h1>Materia Oscura T1 T2</h1>
          <p>Título original: Dark Matter</p>
          <p>Año: 2024</p>
          <p><strong>T1</strong></p>
          <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9MjMzMTc%3D&name=Materia-oscura-1x1x2-hdtv-xvid-castellano">🎬 Materia-oscura-1x1x2-hdtv-xvid-castellano</a>
          <p><strong>T2</strong></p>
          <a href="https://www.sinsitio.site/ddlUrl.php?url=aHR0cHM6Ly93d3cuc2luc2l0aW8uc2l0ZS9pbmRleC5waHA%2FZG89ZG93bmxvYWQmaWQ9NjcxOTA%3D&name=Materia%20Oscura%202x1%20Hdtv%20Xvid%20Castellano">🎬 Materia Oscura 2x1 Hdtv Xvid Castellano699.7 MB</a>
        `
      };
    }
    if (url.includes('do=download&id=67190')) {
      return { data: ep2Buffer };
    }
    throw new Error(`URL inesperada en mock: ${url}`);
  };

  try {
    const streams = await SinSitio.buscarStreams({
      title: 'Dark Matter',
      originalTitle: 'Dark Matter',
      year: 2024,
      type: 'series',
      season: 2,
      episode: 1
    });

    assert.equal(streams.length, 1);
    assert.equal(streams[0].infoHash, expectedHash);
    assert.match(streams[0].name, /^SinSitio/);
    assert.match(streams[0].title, /Materia Oscura S02E01/);
    assert.match(streams[0].title, /699\.7 MB/);
    assert.equal(streams[0]._meta.fuente, 'sinsitio');

    // Verificar que SÓLO se descargó el .torrent del episodio 2x1 (id=67190) y NO el de 1x1x2 (id=23317),
    // y que incluyó el Referer de la ficha HTML para evitar el rebote de DLE.
    const downloadReqs = requests.filter(r => r.url.includes('do=download'));
    assert.equal(downloadReqs.length, 1);
    assert.equal(downloadReqs[0].url, 'https://www.sinsitio.site/index.php?do=download&id=67190');
    assert.equal(
      downloadReqs[0].headers.Referer,
      'https://www.sinsitio.site/series/14275-materia-oscura-t1.html'
    );
  } finally {
    axios.get = origGet;
    SinSitio.clearCache();
  }
});

test('UniverTorrent, SinSitio y Beamup: manifest sin nombres de proveedores, config Español/Inglés y subdominio baby-beamup.club', () => {
  // 1) Configuración acepta ss / sinsitio y alias Español / Inglés
  assert.deepEqual([...fuentesActivas({ fuentes: 'ss' })], ['ss']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'sinsitio,pelispanda' })], ['pp', 'ss']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'espanol' })], ['ht', 'pp', 'ss']);
  assert.deepEqual([...fuentesActivas({ fuentes: 'ingles' })], ['knaben', 'tcsv']);

  const cfgEs = normalizarConfig('es');
  assert.equal(cfgEs.idioma, 'latino');
  assert.equal(cfgEs.fuentes, 'ht,pp,ss');

  const cfgEn = normalizarConfig('en');
  assert.equal(cfgEn.idioma, 'ingles');
  assert.equal(cfgEn.fuentes, 'knaben,tcsv');
  assert.equal(cfgEn.orden, 'seeders');

  // 2) Por defecto, los streams de SinSitio están permitidos y priorizados como hispanos
  const sampleStreams = [
    {
      name: 'SinSitio\n1080p',
      title: 'Pelea de profes',
      url: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
      _meta: { fuente: 'sinsitio', idioma: 'Castellano', calidad: '1080p', seeders: 0, pack: false }
    }
  ];
  const filtered = aplicarConfig(sampleStreams, normalizarConfig(undefined));
  assert.equal(filtered.length, 1);

  // 3) Manifest se llama UniverTorrent, no expone nombres de proveedores y tiene catálogos limpios
  assert.equal(manifest.name, 'UniverTorrent');
  assert.equal(manifest.id, 'com.univertorrent.addon');
  const rawManifestText = JSON.stringify(manifest).toLowerCase();
  for (const proveedor of ['hacktorrent', 'pelispanda', 'sinsitio', 'knaben', 'torrents.csv', 'blackholebay', 'black hole bay']) {
    assert.ok(!rawManifestText.includes(proveedor), `manifest.json no debe mostrar el proveedor "${proveedor}"`);
  }

  const catIds = manifest.catalogs.map(c => c.id);
  assert.ok(catIds.includes('univertorrent-cine-esp'));
  assert.ok(catIds.includes('univertorrent-series-esp'));
  assert.ok(manifest.idPrefixes.includes('ss'));

  // 4) Subdominio baby-beamup.club configurado en beamup.json y en /configure (sin nombres de proveedores)
  assert.match(BEAMUP_HOST, /\.baby-beamup\.club$/);
  assert.equal(beamupConfig.subdomain, BEAMUP_HOST);
  assert.equal(beamupConfig.manifestUrl, `${BEAMUP_ORIGIN}/manifest.json`);

  const html = renderConfigPage({ config: {}, manifest });
  assert.ok(html.includes('UniverTorrent'));
  assert.ok(html.includes('name="fuente" value="ss"'));
  assert.ok(html.includes(BEAMUP_HOST));
  assert.ok(html.includes('data-ui="es"'));
  assert.ok(html.includes('data-ui="en"'));
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase();
  for (const proveedor of ['hacktorrent', 'pelispanda', 'sinsitio', 'knaben', 'torrents.csv', 'blackholebay', 'black hole bay']) {
    assert.ok(!visibleText.includes(proveedor), `/configure no debe mostrar el nombre del proveedor "${proveedor}"`);
  }
});
