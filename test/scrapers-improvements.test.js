'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

const Match = require('../lib/match');
const Release = require('../lib/release');
const Bencode = require('../lib/bencode');
const Http = require('../lib/http');
const Scraper = require('../lib/scraper');
const HT = require('../lib/hacktorrent');
const PelisPanda = require('../lib/pelispanda');
const SinSitio = require('../lib/sinsitio');
const Knaben = require('../lib/knaben');
const TorrentsCsv = require('../lib/torrentsCsv');
const BlackHoleBay = require('../lib/theblackholebay');
const addon = require('../index');

const originalAxiosGet = axios.get;

/** Codificador Bencode minimalista para construir buffers .torrent reales en tests. */
function bencodeEncode(val) {
  if (Buffer.isBuffer(val)) {
    return Buffer.concat([Buffer.from(`${val.length}:`, 'ascii'), val]);
  }
  if (typeof val === 'string') {
    const buf = Buffer.from(val, 'utf8');
    return Buffer.concat([Buffer.from(`${buf.length}:`, 'ascii'), buf]);
  }
  if (typeof val === 'number') {
    return Buffer.from(`i${Math.trunc(val)}e`, 'ascii');
  }
  if (Array.isArray(val)) {
    return Buffer.concat([
      Buffer.from('l', 'ascii'),
      ...val.map(bencodeEncode),
      Buffer.from('e', 'ascii')
    ]);
  }
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).sort();
    const parts = [Buffer.from('d', 'ascii')];
    for (const k of keys) {
      if (val[k] === undefined) continue;
      parts.push(bencodeEncode(k), bencodeEncode(val[k]));
    }
    parts.push(Buffer.from('e', 'ascii'));
    return Buffer.concat(parts);
  }
  throw new Error(`Tipo no soportado en bencodeEncode: ${typeof val}`);
}

/** Convierte 20 bytes (Buffer) a Base32 RFC 4648 (32 chars). */
function bytesToBase32(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

test.afterEach(() => {
  axios.get = originalAxiosGet;
  Scraper._limpiarCache();
  PelisPanda._clearCaches();
  SinSitio.clearCache();
  Knaben._limpiarCache();
  TorrentsCsv._limpiarCache();
  BlackHoleBay._limpiarCache();
});

// ---------------------------------------------------------------------------
// 1. lib/match.js
// ---------------------------------------------------------------------------

test('match: alinea palabras compuestas con guion y secuelas romanas/en palabras', () => {
  assert.ok(Match.similarity('Spider-Man: Homecoming', 'Spiderman Homecoming') >= 0.95);
  assert.ok(Match.similarity('Gladiator II', 'Gladiator 2') >= 0.95);
  assert.ok(Match.similarity('Dune: Part Two', 'Dune Part 2') >= 0.95);
});

test('match: detecta multi-episodios y distingue packs de 1 temporada vs multi-temporada', () => {
  const multiEp = Match.parseSeasonEpisode('Dark.Matter.S01E01E02.1080p.WEB-DL');
  assert.equal(multiEp.season, 1);
  assert.deepEqual(multiEp.episodes, [1, 2]);
  assert.equal(multiEp.isPack, false);

  assert.equal(Match.torrentMatchesEpisode({ dn: 'Show.S01E01E02.1080p' }, 1, 1), 'exact');
  assert.equal(Match.torrentMatchesEpisode({ dn: 'Show.S01E01E02.1080p' }, 1, 2), 'exact');
  assert.equal(Match.torrentMatchesEpisode({ dn: 'Show.S01E01E02.1080p' }, 1, 3), null);

  const singlePack = Match.parseSeasonEpisode('Breaking Bad Temporada 2 Completa 1080p');
  assert.equal(singlePack.isPack, true);
  assert.equal(singlePack.isMultiSeasonPack, false);
  assert.equal(Match.torrentMatchesEpisode({ dn: 'Breaking Bad Temporada 2 Completa 1080p' }, 2, 5), 'pack');

  const multiPack = Match.parseSeasonEpisode('Breaking Bad S01-S05 Complete 1080p');
  assert.equal(multiPack.isMultiSeasonPack, true);
  assert.equal(Match.torrentMatchesEpisode({ dn: 'Breaking Bad S01-S05 Complete 1080p' }, 1, 2), null);
});

// ---------------------------------------------------------------------------
// 2. lib/release.js
// ---------------------------------------------------------------------------

test('release: soporta nombres separados por guiones bajos, magnets Base32 y etiquetas de idioma limpias', () => {
  const rawBytes = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex');
  const b32 = bytesToBase32(rawBytes);
  const b32Magnet = `magnet:?xt=urn:btih:${b32}&dn=The_Avengers_2012_2160p_WEB-DL_DUAL_LATINO`;

  assert.equal(Release.extraerInfoHash(b32Magnet), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(Release.ultimoAnio('The_Avengers_2012_2160p_WEB-DL_DUAL_LATINO'), 2012);
  assert.equal(Release.calidadDeNombre('The_Avengers_2012_2160p_WEB-DL_DUAL_LATINO'), '4K');
  assert.equal(Release.idiomaDeNombre('The_Avengers_2012_2160p_WEB-DL_DUAL_LATINO'), 'Latino/Inglés');
  assert.equal(Release.esReleaseVideo('The Avengers 2012 OST Soundtrack FLAC'), false);
  assert.equal(Release.esReleaseVideo('The_Avengers_2012_1080p_BluRay.mkv'), true);

  const res = Release.filtrarYOrdenar([
    {
      name: 'El_Lobo_de_Wall_Street_2013_1080p_BluRay_DUAL_LATINO',
      magnet: b32Magnet,
      seeders: 45,
      size: 4_000_000_000
    }
  ], {
    title: 'The Wolf of Wall Street',
    altTitles: ['El lobo de Wall Street'],
    year: 2013,
    type: 'movie'
  });

  assert.equal(res.aceptados.length, 1);
  const stream = Release.formatearStream(res.aceptados[0], { nombreFuente: 'Knaben', claveFuente: 'knaben' });
  assert.equal(stream.infoHash, '0123456789abcdef0123456789abcdef01234567');
  assert.ok(stream.title.includes('Latino/Inglés'));
  assert.ok(!stream.title.includes('(VO)'), 'no debe añadir (VO) cuando el release es Dual/Latino');
});

// ---------------------------------------------------------------------------
// 3. lib/bencode.js
// ---------------------------------------------------------------------------

test('bencode: calcula SHA-1 exacto e ignora samples/trailers al elegir fileIdx', () => {
  const infoDict = {
    name: 'Serie.Pack.S01',
    'piece length': 262144,
    pieces: Buffer.alloc(20, 7),
    files: [
      { length: 45_000_000, path: ['Sample', 'Serie.S01E02.sample.mkv'] },
      { length: 950_000_000, path: ['Serie.S01E01.1080p.mkv'] },
      { length: 980_000_000, path: ['Serie.S01E02.1080p.mkv'] },
      { length: 50_000, path: ['Subs', 'Serie.S01E02.es.srt'] }
    ]
  };
  const expectedHash = crypto.createHash('sha1').update(bencodeEncode(infoDict)).digest('hex');
  const torrentBuf = bencodeEncode({
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    info: infoDict
  });

  assert.equal(Bencode.isTorrentBuffer(torrentBuf), true);
  const parsed = Bencode.parseTorrentBuffer(torrentBuf);
  assert.equal(parsed.infoHash, expectedHash);

  const epSel = Bencode.selectFileIdxForEpisode(parsed.files, 1, 2);
  assert.equal(epSel.fileIdx, 2, 'debe elegir el archivo real S01E02 (índice 2) y no el sample (índice 0)');

  const movieInfo = {
    name: 'Pelicula.2024.1080p',
    'piece length': 262144,
    pieces: Buffer.alloc(20, 3),
    files: [
      { length: 80_000_000, path: ['Pelicula.2024.Trailer.mp4'] },
      { length: 3_500_000_000, path: ['Pelicula.2024.1080p.mkv'] },
      { length: 90_000, path: ['Pelicula.2024.es.srt'] }
    ]
  };
  const parsedMovie = Bencode.parseTorrentBuffer(bencodeEncode({ info: movieInfo }));
  const largest = Bencode.selectLargestVideoFileIdx(parsedMovie.files);
  assert.equal(largest.fileIdx, 1);
});

// ---------------------------------------------------------------------------
// 4. lib/scraper.js (HackTorrent) & lib/hacktorrent.js
// ---------------------------------------------------------------------------

test('scraper HackTorrent: parsea columnas dinámicas, múltiples enlaces por fila, packs y .torrent Bencode', async () => {
  const hashPack = '1'.repeat(40);
  const hashEp1 = '2'.repeat(40);
  const html = `
    <html><body>
      <h1>Materia Oscura (2024)</h1>
      <p>Título original: Dark Matter</p>
      <p>Duración: 55 min</p>
      <a href="https://www.themoviedb.org/tv/196322">TMDB</a>
      <h3>Temporada 1</h3>
      <table>
        <thead>
          <tr><th>Audio</th><th>Episodio</th><th>Calidad</th><th>Peso</th><th>Enlace</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Dual</td><td>1</td><td>1080p</td><td>1.8 GB</td>
            <td>
              <a href="magnet:?xt=urn:btih:${hashEp1}&dn=Dark.Matter.S01E01E02.1080p">Magnet</a>
              <a href="/downloads/dark-matter-s01e01e02.torrent">Torrent</a>
            </td>
          </tr>
          <tr>
            <td>Latino</td><td>Temporada Completa</td><td>1080p</td><td>14 GB</td>
            <td><a href="magnet:?xt=urn:btih:${hashPack}&dn=Dark.Matter.S01.Completa.1080p">Pack</a></td>
          </tr>
        </tbody>
      </table>
    </body></html>
  `;

  const parsed = Scraper._parseHtmlDetail(html, 'materia-oscura', 'serie');
  assert.equal(parsed.tituloOriginal, 'Dark Matter');
  assert.equal(parsed.tmdbId, '196322');
  assert.equal(parsed.torrents.length, 3);

  const epRow = parsed.torrents.find(t => t.magnet && t.magnet.includes(hashEp1));
  assert.equal(epRow.idioma, 'Dual');
  assert.equal(epRow.temporada, 1);
  assert.deepEqual(epRow.episodios, [1, 2]);

  const packRow = parsed.torrents.find(t => t.magnet && t.magnet.includes(hashPack));
  assert.equal(packRow.esPack, true);
  assert.equal(packRow.episodio, null, 'el pack de temporada no debe recibir un número de episodio falso');

  // Resolución de acortalink que entrega un binario .torrent directo
  const infoDict = {
    name: ' Pelicula.Especial.2024.1080p.mkv',
    length: 2_100_000_000,
    'piece length': 262144,
    pieces: Buffer.alloc(20, 9)
  };
  const expectedHash = crypto.createHash('sha1').update(bencodeEncode(infoDict)).digest('hex');
  const torrentBuf = bencodeEncode({
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    info: infoDict
  });

  axios.get = async (url) => {
    if (String(url).includes('acortalink.me/test-torrent')) {
      return { status: 200, headers: { 'content-type': 'application/x-bittorrent' }, data: torrentBuf };
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const resolvedMagnet = await Scraper.resolverAcortalink('https://acortalink.me/test-torrent');
  assert.ok(resolvedMagnet && resolvedMagnet.includes(`btih:${expectedHash}`));
});

test('hacktorrent getCinemeta: deduplica peticiones simultáneas (single-flight)', async () => {
  let calls = 0;
  axios.get = async (url) => {
    calls++;
    await Http.sleep(25);
    return {
      status: 200,
      data: {
        meta: {
          id: 'tt9998887',
          name: 'Test SingleFlight Movie',
          releaseInfo: '2024',
          moviedb_id: 777111
        }
      }
    };
  };

  const [a, b, c] = await Promise.all([
    HT.getCinemeta('movie', 'tt9998887'),
    HT.getCinemeta('pelicula', 'tt9998887'),
    HT.getCinemeta('movie', 'tt9998887')
  ]);
  assert.equal(calls, 1, 'tres llamadas simultáneas al mismo IMDb deben compartir 1 sola petición HTTP');
  assert.equal(a.name, 'Test SingleFlight Movie');
  assert.equal(b.moviedb_id, 777111);
  assert.equal(c.releaseInfo, '2024');
});

// ---------------------------------------------------------------------------
// 5. lib/pelispanda.js
// ---------------------------------------------------------------------------

test('PelisPanda: buscarPorTmdb ignora portada HTML completa y buscarStreams resuelve archivos .torrent con fileIdx', async () => {
  // 1) Guardia de portada HTML completa en buscarPorTmdb
  axios.get = async () => ({
    status: 200,
    headers: {},
    data: '<html><body><nav><a href="/">Inicio</a></nav><h1>PelisPanda</h1><table></table></body></html>'
  });
  const emptyFromHomepage = await PelisPanda.buscarPorTmdb('555123');
  assert.deepEqual(emptyFromHomepage, [], 'no debe tomar el texto del navbar como título de película');
  PelisPanda._clearCaches();

  // 2) Pack sin episodio falso en _parseHtmlDetail + resolución .torrent en buscarStreams
  const infoDict = {
    name: 'Arcane.S01.1080p.Pack',
    'piece length': 262144,
    pieces: Buffer.alloc(20, 5),
    files: [
      { length: 30_000_000, path: ['Sample', 'Arcane.S01E03.sample.mkv'] },
      { length: 1_200_000_000, path: ['Arcane.S01E02.1080p.mkv'] },
      { length: 1_250_000_000, path: ['Arcane.S01E03.1080p.mkv'] }
    ]
  };
  const expectedHash = crypto.createHash('sha1').update(bencodeEncode(infoDict)).digest('hex');
  const torrentBuf = bencodeEncode({
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    info: infoDict
  });

  const detailHtml = `
    <html><body>
      <h1>Arcane (2021)</h1>
      <p>Título original: Arcane</p>
      <h3>Temporada 1</h3>
      <table>
        <thead><tr><th>#</th><th>Formato</th><th>Tamaño</th><th>Subtítulos</th><th>Idioma</th><th>Enlace</th></tr></thead>
        <tbody>
          <tr>
            <td>Pack Completo</td><td>1080p</td><td>10 GB</td><td>Sí</td><td>Latino</td>
            <td><a href="https://pelispanda.org/torrents/arcane-s01.torrent">Descargar</a></td>
          </tr>
        </tbody>
      </table>
    </body></html>
  `;

  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('/wp-json/wpreact/v1/search')) {
      return {
        status: 200,
        data: { results: [{ slug: 'arcane', title: 'Arcane', type: 'series', year: '2021' }] }
      };
    }
    if (u.includes('/wp-json/wpreact/v1/serie/arcane')) {
      return { status: 200, data: { slug: 'arcane', title: 'Arcane', year: '2021' } };
    }
    if (u.includes('/serie/arcane/')) {
      return { status: 200, data: detailHtml };
    }
    if (u.endsWith('/torrents/arcane-s01.torrent')) {
      return { status: 200, data: torrentBuf };
    }
    throw new Error(`PelisPanda URL inesperada: ${u}`);
  };

  const streams = await PelisPanda.buscarStreams({
    title: 'Arcane',
    year: 2021,
    type: 'series',
    season: 1,
    episode: 3
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].infoHash, expectedHash);
  assert.equal(streams[0].fileIdx, 2, 'debe seleccionar el archivo S01E03 (índice 2) dentro del .torrent del pack');
  assert.ok(streams[0]._meta.pack === true);
});

// ---------------------------------------------------------------------------
// 6. lib/sinsitio.js
// ---------------------------------------------------------------------------

test('SinSitio: ignora samples en selectFileIdxForEpisode, asigna fileIdx en películas multi-archivo y rechaza packs multi-temporada', async () => {
  const epFiles = [
    { index: 0, length: 25_000_000, path: 'Sample/From.1x04.sample.mkv' },
    { index: 1, length: 900_000_000, path: 'From.1x03.1080p.mkv' },
    { index: 2, length: 920_000_000, path: 'From.1x04.1080p.mkv' }
  ];
  assert.equal(SinSitio.selectFileIdxForEpisode(epFiles, 1, 4), 2);

  // Pack multi-temporada no debe colarse en filtrarPorEpisodio
  const { exactos, packs } = SinSitio.filtrarPorEpisodio([
    { dn: 'Breaking Bad Temporadas 1-5 Completa', temporada: null, episodio: null, esPack: true },
    { dn: 'Breaking Bad Temporada 2 Completa', temporada: 2, episodio: null, esPack: true }
  ], 2, 4);
  assert.equal(exactos.length, 0);
  assert.equal(packs.length, 1);
  assert.ok(packs[0].dn.includes('Temporada 2'));

  // Encabezado de temporada con cualquier emoji + película multi-archivo con sample
  const serieHtml = `
    <html><body>
      <h1>🔥 La Casa del Dragón Castellano</h1>
      <p>Título original: House of the Dragon</p>
      <p>Año: 2022</p>
      <p>🐉 Temporada 2 (2024)</p>
      <a href="/index.php?do=download&id=8801">La Casa del Dragon 2x03 1080p 2.1 GB</a>
    </body></html>
  `;
  const detSerie = SinSitio.parseDetailHtml(serieHtml, 'https://www.sinsitio.site/series/8801-la-casa-del-dragon.html');
  assert.equal(detSerie.torrents.length, 1);
  assert.equal(detSerie.torrents[0].temporada, 2);
  assert.equal(detSerie.torrents[0].episodio, 3);

  const movieTorrent = bencodeEncode({
    announce: 'udp://tracker.opentrackr.org:1337/announce',
    info: {
      name: 'Amelie.2001.1080p',
      'piece length': 262144,
      pieces: Buffer.alloc(20, 4),
      files: [
        { length: 35_000_000, path: ['Sample', 'sample.mkv'] },
        { length: 4_100_000_000, path: ['Amelie.2001.1080p.Castellano.mkv'] },
        { length: 80_000, path: ['Subs.srt'] }
      ]
    }
  });

  axios.get = async (url) => {
    if (String(url).includes('do=download&id=9901')) {
      return { status: 200, data: movieTorrent };
    }
    throw new Error(`SinSitio URL inesperada: ${url}`);
  };

  const resueltos = await SinSitio.resolverMagnetsEnLote([
    {
      calidad: '1080p',
      idioma: 'Castellano',
      downloadUrl: 'https://www.sinsitio.site/index.php?do=download&id=9901',
      dn: 'Amelie 2001 1080p'
    }
  ]);
  assert.equal(resueltos.length, 1);
  assert.equal(resueltos[0].fileIdx, 1, 'debe apuntar al archivo principal de vídeo (índice 1) y no al sample');
});

// ---------------------------------------------------------------------------
// 7. Indexadores externos + fusión sin mutación en index.js
// ---------------------------------------------------------------------------

test('BlackHoleBay y TorrentsCsv: ronda de respaldo con originalTitle/altTitles y hashes Base32', async () => {
  const rawBytes = Buffer.from('abcdef0123456789abcdef0123456789abcdef01', 'hex');
  const b32 = bytesToBase32(rawBytes);

  const queriesTbb = [];
  axios.get = async (url) => {
    const u = new URL(String(url));
    const q = u.searchParams.get('q');
    queriesTbb.push(q);
    if (q === 'Sociedad secreta') {
      return { status: 200, data: { results: [] } };
    }
    if (q === 'Secret Society') {
      return {
        status: 200,
        data: {
          results: [
            {
              name: 'Secret Society 2024 1080p WEB-DL',
              info_hash: b32,
              seeders: 31,
              leechers: 4,
              size: 2_400_000_000,
              category: 207
            }
          ]
        }
      };
    }
    return { status: 200, data: { results: [] } };
  };

  const streams = await BlackHoleBay.buscarStreams({
    title: 'Sociedad secreta',
    originalTitle: 'Secret Society',
    year: 2024,
    type: 'movie',
    force: true
  });

  assert.deepEqual(queriesTbb, ['Sociedad secreta', 'Secret Society']);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].infoHash, 'abcdef0123456789abcdef0123456789abcdef01');
});

test('index.fusionarStreams: consolida sources, fileIdx y seeders sin mutar los streams originales', () => {
  const hash = 'c'.repeat(40);
  const propio = {
    name: 'HackTorrent\n1080p',
    title: 'Pelicula',
    infoHash: hash,
    sources: [`dht:${hash}`, 'tracker:udp://one:1337/announce'],
    _meta: { fuente: 'hacktorrent', idioma: 'Latino', calidad: '1080p', seeders: 0, pack: false }
  };
  const externo = {
    name: 'Knaben\n1080p',
    title: 'Pelicula',
    infoHash: hash,
    fileIdx: 1,
    sources: [`dht:${hash}`, 'tracker:udp://two:6969/announce'],
    _meta: { fuente: 'knaben', idioma: 'Inglés', calidad: '1080p', seeders: 85, pack: false }
  };

  const propiosSnapshot = JSON.stringify(propio);
  const fusionados = addon._internals.fusionarStreams([propio], [externo]);

  assert.equal(JSON.stringify(propio), propiosSnapshot, 'no debe mutar el objeto stream de entrada');
  assert.equal(fusionados.length, 1);
  assert.equal(fusionados[0].fileIdx, 1, 'debe heredar fileIdx si el duplicado lo resolvió');
  assert.equal(fusionados[0]._meta.seeders, 85, 'debe conservar el mayor conteo de seeders conocido');
  assert.ok(fusionados[0].sources.includes('tracker:udp://one:1337/announce'));
  assert.ok(fusionados[0].sources.includes('tracker:udp://two:6969/announce'));
});
