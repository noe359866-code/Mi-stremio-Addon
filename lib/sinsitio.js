/**
 * lib/sinsitio.js
 * ---------------------------------------------------------------------------
 * Scraper e integración dedicada para https://www.sinsitio.site/ (SinSitio)
 *
 * Arquitectura verificada contra el sitio en vivo (DataLife Engine / flat-cinema):
 *  1. Búsqueda DLE:
 *     - GET /index.php?do=search&subaction=search&story={query}
 *     - Busca tanto en el título en español como dentro de la ficha técnica
 *       (incluyendo "Título original: ..."), permitiendo encontrar películas y
 *       series directamente por su título en inglés o español.
 *  2. Catálogos HTML paginados (/page/{n}/):
 *     - Películas: /estrenos/, /dvdrip-bdrip/, /audiolatino/, /bluray/,
 *       /cine-clsico-de-todos-los-tiempos/, /reliberacion/, /peliculas-con-subtitulos-srt/
 *     - Series: /series/, /series-mkv/, /series-que-ya-son-clasicos/
 *     - Exclusión estricta de categorías no-video (/musica/, /xxx/, /detodounpoco/, etc.).
 *  3. Fichas de detalle (/{categoria}/{id}-{slug}.html):
 *     - Extracción de ficha técnica (Título original, Título en España, Año,
 *       Duración, País, Dirección, Reparto, Género, Sinopsis, MEDIA INFO).
 *     - Decodificación de enlaces ddlUrl.php?url={base64}&name={releaseName}
 *       hacia el adjunto público /index.php?do=download&id={dlId}.
 *     - Separación limpia del tamaño pegado al texto del enlace
 *       (p. ej. "Temporada 1807.24 MB" → nombre "Temporada 1", tamaño "807.24 MB").
 *     - Soporte para episodios simples (1x03), episodios múltiples (1x1x2, 1x5x6)
 *       y packs de temporada (Temporada 1, T1 Completa).
 *  4. Conversión nativa .torrent → magnet + infoHash SHA-1 + fileIdx:
 *     - Descarga del .torrent enviando `Referer: {detailUrl}` (requisito de DLE
 *       para no rebotar a la ficha HTML).
 *     - Decodificador Bencode propio sin dependencias externas; calcula el SHA-1
 *       exacto sobre los bytes crudos del diccionario `info`, extrae trackers y
 *       selecciona `fileIdx` cuando el .torrent contiene múltiples archivos de video.
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const R_EXTRA = require('./release');
const { timeout } = require('./timeouts');
const {
  normalizeTitle,
  parseSeasonEpisode,
  rankCandidates,
  pickBestMatch,
  scoreCandidate,
  torrentSeasonEpisode,
  torrentMatchesEpisode
} = require('./match');
const { selectLargestVideoFileIdx } = require('./bencode');
const { isTransientNetworkError } = require('./http');

const BASE_URL = (process.env.SINSITIO_BASE_URL || 'https://www.sinsitio.site').replace(/\/+$/, '');
const DEFAULT_MIRRORS = ['https://www.sinsitio.site', 'https://sinsitio.site'];
const EXTRA_MIRRORS = (process.env.SINSITIO_MIRRORS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

// Pool de conexiones Keep-Alive para soportar alta concurrencia de usuarios
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 30000 });

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://explodie.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce'
];

// Categorías excluidas (no son películas ni series reproducibles)
const EXCLUDED_CATEGORIES = new Set([
  'musica',
  'xxx',
  'adultos',
  'detodounpoco',
  'juegos',
  'pc-games',
  'programas',
  'software',
  'libros',
  'revistas',
  'tutoriales',
  'ayuda'
]);

// Categorías de series en SinSitio
const SERIES_CATEGORIES = new Set([
  'series',
  'series-mkv',
  'series-que-ya-son-clasicos',
  'series-clasicas',
  'series-hd',
  'miniseries'
]);

// Categorías de películas en SinSitio
const MOVIE_CATEGORIES = [
  'estrenos',
  'dvdrip-bdrip',
  'audiolatino',
  'dvdrip-bdrip-latino',
  'bluray',
  'peliculas-con-subtitulos-srt',
  'cine-clsico-de-todos-los-tiempos',
  'reliberacion',
  'documentales',
  'peliculas-breves-cortos'
];

// Cachés en memoria de alta capacidad para múltiples usuarios concurrentes
const CACHE_TTL_MS = 30 * 60 * 1000;          // 30 min para búsquedas y fichas
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000;  // 3 min para búsquedas vacías
const TORRENT_CACHE_TTL_MS = 24 * 3600 * 1000; // 24 h para metainfo .torrent (inmutable por id)
const MAX_CACHE_ENTRIES = 3000;
const MAX_TORRENT_CACHE_ENTRIES = 6000;

const searchCache = new Map();
const detailCache = new Map();
const catalogCache = new Map();
const torrentCache = new Map();
const inFlightRequests = new Map();

function getCached(map, key, ttl = CACHE_TTL_MS) {
  const entry = map.get(key);
  if (!entry) return null;
  const effectiveTtl = entry.ttl ?? ttl;
  if (Date.now() - entry.ts > effectiveTtl) {
    map.delete(key);
    return null;
  }
  map.delete(key);
  map.set(key, entry);
  return entry.val;
}

function setCached(map, key, val, maxEntries = MAX_CACHE_ENTRIES, customTtl = null) {
  if (map.has(key)) map.delete(key);
  if (map.size >= maxEntries) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, { val, ts: Date.now(), ...(customTtl !== null ? { ttl: customTtl } : {}) });
  return val;
}

/**
 * Deduplica promesas en vuelo: si N usuarios piden el mismo recurso a la vez,
 * comparten una única petición HTTP saliente.
 */
function coalesce(key, fn) {
  const existing = inFlightRequests.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => {
      inFlightRequests.delete(key);
    });
  inFlightRequests.set(key, p);
  return p;
}

function clearCache() {
  searchCache.clear();
  detailCache.clear();
  catalogCache.clear();
  torrentCache.clear();
  inFlightRequests.clear();
}

// ---------------------------------------------------------------------------
// 1. DECODIFICADOR BENCODE + CONVERSIÓN .TORRENT → MAGNET / INFOHASH / FILEIDX
// ---------------------------------------------------------------------------

/**
 * Decodifica un valor Bencode desde `buffer` a partir de `start`.
 * @param {Buffer} buffer
 * @param {number} [start=0]
 * @param {number} [end=buffer.length]
 * @param {object} [opts] { skipBinaryStrings: boolean }
 * @returns {[any, number]} [valorDecodificado, siguienteOffset]
 */
function decodeBencode(buffer, start = 0, end = buffer.length, opts = {}) {
  if (!Buffer.isBuffer(buffer) || start >= end) {
    throw new Error('bencode: fin inesperado del buffer');
  }
  const c = buffer[start];

  // Entero: i<digits>e
  if (c === 0x69) {
    const eIndex = buffer.indexOf(0x65, start + 1);
    if (eIndex === -1 || eIndex >= end) throw new Error('bencode: entero sin cerrar');
    const raw = buffer.toString('ascii', start + 1, eIndex);
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error('bencode: entero inválido');
    return [num, eIndex + 1];
  }

  // Lista: l...e
  if (c === 0x6c) {
    const list = [];
    let pos = start + 1;
    while (pos < end && buffer[pos] !== 0x65) {
      const [val, next] = decodeBencode(buffer, pos, end, opts);
      list.push(val);
      pos = next;
    }
    if (pos >= end || buffer[pos] !== 0x65) throw new Error('bencode: lista sin cerrar');
    return [list, pos + 1];
  }

  // Diccionario: d...e
  if (c === 0x64) {
    const dict = {};
    let pos = start + 1;
    while (pos < end && buffer[pos] !== 0x65) {
      const [key, keyEnd] = decodeBencode(buffer, pos, end, opts);
      if (typeof key !== 'string') throw new Error('bencode: clave de diccionario inválida');
      const valStart = keyEnd;
      // Para 'pieces' o 'ed2k' o 'filehash' no necesitamos convertir miles de bytes binarios a UTF-8
      const isBinaryField = key === 'pieces' || key === 'ed2k' || key === 'filehash';
      const [val, valEnd] = decodeBencode(
        buffer,
        valStart,
        end,
        isBinaryField ? { ...opts, binaryValue: true } : opts
      );
      dict[key] = val;
      if (start === 0 && key === 'info' && typeof opts.onInfoSlice === 'function') {
        opts.onInfoSlice(valStart, valEnd);
      }
      pos = valEnd;
    }
    if (pos >= end || buffer[pos] !== 0x65) throw new Error('bencode: diccionario sin cerrar');
    return [dict, pos + 1];
  }

  // Byte string: <digits>:<bytes>
  if (c >= 0x30 && c <= 0x39) {
    const colon = buffer.indexOf(0x3a, start);
    if (colon === -1 || colon >= end) throw new Error('bencode: cadena sin dos puntos');
    const len = Number(buffer.toString('ascii', start, colon));
    if (!Number.isInteger(len) || len < 0) throw new Error('bencode: longitud de cadena inválida');
    const strStart = colon + 1;
    const strEnd = strStart + len;
    if (strEnd > end) throw new Error('bencode: cadena truncada');
    if (opts.binaryValue) {
      return [null, strEnd];
    }
    return [buffer.toString('utf8', strStart, strEnd), strEnd];
  }

  throw new Error(`bencode: byte de tipo desconocido (${c})`);
}

/**
 * Localiza el rango exacto [start, end] del diccionario `info` dentro del .torrent.
 * Necesario para calcular el SHA-1 exacto sin re-serializar.
 */
function locateInfoDict(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) {
    throw new Error('bencode: buffer demasiado corto');
  }
  let slice = null;
  if (buffer[0] === 0x64) {
    try {
      decodeBencode(buffer, 0, buffer.length, {
        onInfoSlice(s, e) {
          slice = [s, e];
        }
      });
      if (slice) return slice;
    } catch {
      // Fallback al escaneo por marcador "4:info"
    }
  }

  const marker = Buffer.from('4:info', 'ascii');
  let idx = buffer.indexOf(marker);
  while (idx !== -1) {
    const dictStart = idx + marker.length;
    if (buffer[dictStart] === 0x64) {
      const [, next] = decodeBencode(buffer, dictStart, buffer.length);
      return [dictStart, next];
    }
    idx = buffer.indexOf(marker, idx + 1);
  }
  throw new Error('bencode: diccionario "info" no encontrado');
}

/**
 * Extrae { infoHash, name, length, trackers, files, magnet } desde los bytes de un .torrent.
 */
function parseTorrentBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer[0] !== 0x64) {
    const preview = Buffer.isBuffer(buffer) ? buffer.toString('utf8', 0, 120).replace(/\s+/g, ' ') : '';
    throw new Error(`Respuesta no es un archivo .torrent válido (${preview.slice(0, 60)})`);
  }

  let infoRange = null;
  const [dict] = decodeBencode(buffer, 0, buffer.length, {
    onInfoSlice(s, e) {
      infoRange = [s, e];
    }
  });

  if (!infoRange) {
    infoRange = locateInfoDict(buffer);
  }

  const [infoStart, infoEnd] = infoRange;
  const infoHash = crypto
    .createHash('sha1')
    .update(buffer.subarray(infoStart, infoEnd))
    .digest('hex')
    .toLowerCase();

  const info = (dict && typeof dict === 'object' && dict.info) ? dict.info : {};
  const name = info['name.utf-8'] || info.name || null;

  let files = [];
  let length = null;
  if (Array.isArray(info.files)) {
    let total = 0;
    files = info.files.map((f, index) => {
      const fLen = Number(f && f.length) || 0;
      total += fLen;
      const rawPath = (f && (f['path.utf-8'] || f.path)) || [];
      const pathStr = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
      return { index, length: fLen, path: pathStr };
    });
    length = total > 0 ? total : null;
  } else if (Number.isFinite(Number(info.length)) && Number(info.length) > 0) {
    length = Number(info.length);
    files = [{ index: 0, length, path: name || '' }];
  }

  const trackers = [];
  if (typeof dict.announce === 'string' && dict.announce.trim()) {
    trackers.push(dict.announce.trim());
  }
  if (Array.isArray(dict['announce-list'])) {
    for (const tier of dict['announce-list']) {
      if (Array.isArray(tier)) {
        for (const tr of tier) {
          if (typeof tr === 'string' && tr.trim()) trackers.push(tr.trim());
        }
      } else if (typeof tier === 'string' && tier.trim()) {
        trackers.push(tier.trim());
      }
    }
  }

  const uniqueTrackers = [...new Set(trackers)];
  const magnet = buildMagnet(infoHash, name, uniqueTrackers);

  return {
    infoHash,
    name,
    length,
    trackers: uniqueTrackers,
    files,
    magnet
  };
}

function buildMagnet(infoHash, name = null, trackers = []) {
  const cleanHash = String(infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(cleanHash)) return null;
  const parts = [`xt=urn:btih:${cleanHash}`];
  if (name) parts.push(`dn=${encodeURIComponent(String(name).trim())}`);
  const allTrackers = [...new Set([...(Array.isArray(trackers) ? trackers : []), ...DEFAULT_TRACKERS])];
  for (const tr of allTrackers) {
    if (tr) parts.push(`tr=${encodeURIComponent(tr)}`);
  }
  return `magnet:?${parts.join('&')}`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2).replace(/\.00$/, '')} GB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

/**
 * En torrents multi-archivo (packs de temporada o capítulos dobles 1x1x2),
 * devuelve el índice `fileIdx` (0-based) del archivo de video que corresponde
 * al episodio solicitado.
 */
function selectFileIdxForEpisode(files, season, episode) {
  if (!Array.isArray(files) || files.length <= 1 || episode === null || episode === undefined) {
    return null;
  }
  const epNum = Number(episode);
  const sNum = season !== null && season !== undefined ? Number(season) : null;
  if (!Number.isFinite(epNum)) return null;

  const videoRe = /\.(mkv|mp4|avi|mov|webm|m4v|ts|mpg|mpeg)$/i;
  const sampleRe = /(?:^|[\s._\-\/\[])(sample|trailer|featurette|promo|extras?|ncop\d*|nced\d*|preview)(?:[\s._\-\/\]]|$)/i;
  const videoFiles = files.filter(f => videoRe.test(f.path));
  const nonSampleVideos = videoFiles.filter(f => !sampleRe.test(f.path));
  const pool = nonSampleVideos.length > 0 ? nonSampleVideos : (videoFiles.length > 0 ? videoFiles : files);

  // 1) Coincidencia exacta de temporada y episodio (1x02, S01E02, etc.)
  for (const f of pool) {
    const basename = f.path.split('/').pop() || f.path;
    const eps = parseSeasonEpisodes(basename, sNum);
    if (eps.episodes.includes(epNum) && (sNum === null || eps.season === null || eps.season === sNum)) {
      return f.index;
    }
  }

  // 2) Patrón Cap. 102 / Capítulo 102 (donde 102 = T1 E02)
  if (sNum !== null) {
    const compositeCode = sNum * 100 + epNum;
    const compRe = new RegExp(`(?:^|[^0-9])0?${compositeCode}(?:[^0-9]|$)`);
    for (const f of pool) {
      const basename = f.path.split('/').pop() || f.path;
      const withoutRes = basename.replace(/\b(1080p?|720p?|2160p?|480p?|264|265)\b/gi, '');
      if (compRe.test(withoutRes)) return f.index;
    }
  }

  // 3) Coincidencia por número de episodio aislado dentro de un pack de la temporada
  const epPadded = String(epNum).padStart(2, '0');
  const epAloneRe = new RegExp(`(?:e|ep|episodio|cap(?:itulo)?[.\\s_-]*|\\b)${epPadded}(?:[^0-9]|$)`, 'i');
  for (const f of pool) {
    const basename = f.path.split('/').pop() || f.path;
    const withoutRes = basename.replace(/\b(1080p?|720p?|2160p?|480p?|264|265)\b/gi, '');
    if (epAloneRe.test(withoutRes)) return f.index;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. DECODIFICACIÓN DE ENLACES SINSITIO (ddlUrl.php → do=download&id=N)
// ---------------------------------------------------------------------------

/**
 * Decodifica un enlace de descarga de SinSitio:
 *   - https://www.sinsitio.site/ddlUrl.php?url=<base64>&name=<nombre>
 *   - /ddlUrl.php?url=<base64>&name=<nombre>
 *   - /index.php?do=download&id=71437
 *   - /engine/download.php?id=71437
 *   - magnet:?xt=urn:btih:...
 *
 * @param {string} href
 * @param {string} [baseUrl=BASE_URL]
 * @returns {{ downloadUrl: string|null, magnet: string|null, releaseName: string|null, ddlUrl: string|null, attachmentId: string|null } | null}
 */
function decodeSinsitioDownload(href, baseUrl = BASE_URL) {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^magnet:\?/i.test(trimmed)) {
    return {
      downloadUrl: null,
      magnet: trimmed,
      releaseName: null,
      ddlUrl: null,
      attachmentId: null
    };
  }

  let resolvedUrl;
  try {
    resolvedUrl = new URL(trimmed, `${baseUrl.replace(/\/+$/, '')}/`);
  } catch {
    return null;
  }

  let releaseName = null;
  let ddlUrl = null;
  let targetUrl = resolvedUrl;

  if (/\/ddlUrl\.php$/i.test(resolvedUrl.pathname)) {
    ddlUrl = resolvedUrl.href;
    const rawName = resolvedUrl.searchParams.get('name');
    if (rawName) {
      releaseName = rawName.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const encoded = resolvedUrl.searchParams.get('url');
    if (!encoded || encoded.length > 8192) return null;

    let decoded = '';
    try {
      const cleanB64 = decodeURIComponent(encoded).replace(/\s+/g, '');
      decoded = Buffer.from(cleanB64, 'base64').toString('utf8').trim();
      if (!/^https?:\/\/|^\//i.test(decoded)) {
        const second = Buffer.from(decoded, 'base64').toString('utf8').trim();
        if (/^https?:\/\/|^\//i.test(second)) decoded = second;
      }
    } catch {
      return null;
    }

    if (/^magnet:\?/i.test(decoded)) {
      return {
        downloadUrl: null,
        magnet: decoded,
        releaseName,
        ddlUrl,
        attachmentId: null
      };
    }

    try {
      targetUrl = new URL(decoded, `${baseUrl.replace(/\/+$/, '')}/`);
    } catch {
      return null;
    }
  }

  const isAttachment =
    (/\/index\.php$/i.test(targetUrl.pathname) && targetUrl.searchParams.get('do') === 'download') ||
    /\/engine\/download\.php$/i.test(targetUrl.pathname);

  if (isAttachment) {
    const id = targetUrl.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) return null;
    // Normalizar siempre al host activo de SinSitio para evitar problemas de certificado/redirect
    const normalizedDownload = `${baseUrl.replace(/\/+$/, '')}/index.php?do=download&id=${id}`;
    return {
      downloadUrl: normalizedDownload,
      magnet: null,
      releaseName,
      ddlUrl,
      attachmentId: id
    };
  }

  if (/\.torrent$/i.test(targetUrl.pathname)) {
    return {
      downloadUrl: targetUrl.href,
      magnet: null,
      releaseName,
      ddlUrl,
      attachmentId: null
    };
  }

  return null;
}

/**
 * Separa el nombre limpio y el tamaño de un enlace de descarga de SinSitio.
 * En SinSitio, el texto del anchor suele pegar el tamaño al final sin espacio:
 *   anchorText = "🎬 From 2022 26 Temporada 1807.24 MB"
 *   releaseName (de ?name=) = "From 2022 26 Temporada 1"
 *   → title = "From 2022 26 Temporada 1", size = "807.24 MB"
 */
function parseAnchorNameAndSize(anchorText, releaseNameFromParam = null) {
  const cleanAnchor = String(anchorText || '')
    .replace(/^[\s🎬📥🔗▶•\-]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanParam = releaseNameFromParam
    ? String(releaseNameFromParam).replace(/\s+/g, ' ').trim()
    : null;

  let size = null;
  let title = cleanParam || cleanAnchor;

  if (cleanParam && cleanAnchor) {
    // Si el anchor comienza con el nombre del parámetro (ignorando mayúsculas/espacios),
    // lo que queda al final del anchor es exactamente el tamaño (p. ej. "807.24 MB" o "8 GB").
    const normAnchor = cleanAnchor.toLowerCase();
    const normParam = cleanParam.toLowerCase();
    if (normAnchor.startsWith(normParam)) {
      const remainder = cleanAnchor.slice(cleanParam.length).trim();
      const remSize = remainder.match(/(\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB|KB))/i);
      if (remSize) {
        size = remSize[1].replace(',', '.').replace(/\s+/g, ' ').toUpperCase();
      }
    }
  }

  if (!size && cleanAnchor) {
    // Caso sin ?name= donde el tamaño viene pegado tras una resolución o palabra:
    // "1080p8 GB", "Castellano699.7 MB", "Mkv4.48 GB", "Temporada 1 807.24 MB"
    const gluedAfterToken = cleanAnchor.match(
      /(?:1080p|720p|2160p|480p|xvid|hdtv|mp4|mkv|avi|castellano|latino|spanish|subt|ac3|h264|hevc|bdrip|dvdrip|web-?dl)\s*(\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB))\s*$/i
    );
    if (gluedAfterToken) {
      size = gluedAfterToken[1].replace(',', '.').replace(/\s+/g, ' ').toUpperCase();
      if (!cleanParam) {
        title = cleanAnchor.slice(0, cleanAnchor.length - gluedAfterToken[1].length).trim();
      }
    } else {
      const trailingSize = cleanAnchor.match(/(\d+(?:[.,]\d+)?\s*(?:GB|MB|GiB|MiB))\s*$/i);
      if (trailingSize) {
        size = trailingSize[1].replace(',', '.').replace(/\s+/g, ' ').toUpperCase();
        if (!cleanParam) {
          title = cleanAnchor.slice(0, cleanAnchor.length - trailingSize[0].length).trim();
        }
      }
    }
  }

  return { title: title || 'SinSitio', size };
}

// ---------------------------------------------------------------------------
// 3. PARSERS DE TEMPORADA/EPISODIOS MÚLTIPLES, CALIDAD, IDIOMA Y TÍTULOS
// ---------------------------------------------------------------------------

/**
 * Extrae temporada y lista de episodios desde un nombre de release de SinSitio.
 * Soporta:
 *   - Multi-episodio SinSitio: "Materia-oscura-1x1x2-hdtv", "1x05x06", "S01E01E02", "1x01-1x02", "1x01-02"
 *   - Episodio simple: "2x1", "1x14", "S02E03"
 *   - Pack de temporada: "Temporada 1", "T1 Completa", "(65cap) del 1 al cap30"
 *
 * @param {string} text
 * @param {number|null} [fallbackSeason=null]
 * @returns {{ season: number|null, episodes: number[], isPack: boolean }}
 */
function parseSeasonEpisodes(text, fallbackSeason = null) {
  if (!text) return { season: fallbackSeason, episodes: [], isPack: false };
  const s = String(text);

  // 1) Formato multi-episodio "1x1x2", "1x05x06", "2x01x02x03"
  const multiX = s.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})((?:x\d{1,3})+)(?=$|[^0-9])/i);
  if (multiX) {
    const season = parseInt(multiX[1], 10);
    const firstEp = parseInt(multiX[2], 10);
    const extraEps = multiX[3]
      .split(/x/i)
      .filter(Boolean)
      .map(n => parseInt(n, 10))
      .filter(Number.isFinite);
    const episodes = [...new Set([firstEp, ...extraEps])];
    return { season, episodes, isPack: false };
  }

  // 2) Formato multi-episodio "S01E01E02" / "S01E01-E02" / "S01E01_E02"
  const multiSE = s.match(/(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._-]*e(\d{1,3}))+(?=$|[^0-9])/i);
  if (multiSE) {
    const season = parseInt(multiSE[1], 10);
    const allMatches = [...s.matchAll(/e(\d{1,3})/gi)].map(m => parseInt(m[1], 10)).filter(Number.isFinite);
    return { season, episodes: [...new Set(allMatches)], isPack: false };
  }

  // 3) Rango "1x01-1x02" o "1x01-02" o "1x01_02"
  const rangeX = s.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})\s*[-_]\s*(?:\1x)?(\d{1,3})(?=$|[^0-9])/i);
  if (rangeX) {
    const season = parseInt(rangeX[1], 10);
    const startEp = parseInt(rangeX[2], 10);
    const endEp = parseInt(rangeX[3], 10);
    if (endEp >= startEp && endEp - startEp <= 12) {
      const episodes = [];
      for (let e = startEp; e <= endEp; e++) episodes.push(e);
      return { season, episodes, isPack: false };
    }
  }

  // 4) Episodio simple estándar (delegado + normalizado)
  const single = parseSeasonEpisode(s);
  if (single.season !== null && single.episode !== null) {
    return { season: single.season, episodes: [single.episode], isPack: false };
  }
  if (single.episode !== null && fallbackSeason !== null) {
    return { season: fallbackSeason, episodes: [single.episode], isPack: false };
  }

  // 5) Pack de temporada ("Temporada 1", "T1 Completa", "(65cap) del 1 al cap30")
  const tempMatch =
    s.match(/\btemporada\s*(\d{1,2})\b/i) ||
    s.match(/(?:^|[^a-z0-9])t(\d{1,2})(?=$|[^a-z0-9])/i) ||
    s.match(/\bseason\s*(\d{1,2})\b/i);
  const season = tempMatch ? parseInt(tempMatch[1], 10) : (single.season ?? fallbackSeason);
  const isPack = Boolean(
    single.isPack ||
    tempMatch ||
    /\b(?:completa|completo|complete|pack|\d+\s*cap(?:[ií]tulos?)?)\b/i.test(s)
  );

  return { season: Number.isFinite(season) ? season : fallbackSeason, episodes: [], isPack };
}

function normalizarCalidad(text) {
  const s = String(text || '').toLowerCase();
  if (/2160p|4k|uhd/.test(s)) return '4K';
  if (/1080p/.test(s)) return '1080p';
  if (/720p/.test(s)) return '720p';
  if (/bdrip|brrip|bluray|blu-ray/.test(s)) return '1080p';
  if (/web-?dl|webrip|wehd/.test(s)) return '1080p';
  if (/hdtv|hdrip|microhd/.test(s)) return '720p';
  if (/dvdrip|xvid|480p/.test(s)) return '720p';
  return '1080p';
}

function normalizarIdioma(text, category = '') {
  const s = String(text || '').toLowerCase();
  const cat = String(category || '').toLowerCase();

  const hasLatino = /\blatino\b|\blat\b|espa[ñn]ol\s*latino|audiolatino/.test(s) || /audiolatino|latino/.test(cat);
  const hasCastellano = /\bcastellano\b|\bcast\b|espa[ñn]ol\s*de\s*espa[ñn]a|\bspanish\b/.test(s);
  const hasEnglish = /\bingl[eé]s\b|\benglish\b|\bing\b|\beng\b/.test(s);
  const hasDual = /\bdual\b/.test(s) || ((hasLatino || hasCastellano) && hasEnglish);
  const hasVose = /\bvose\b|\bsubtitulad[oa]\b|peliculas-con-subtitulos/.test(s) || /subtitulos/.test(cat);

  if (hasDual) return 'Dual';
  if (hasLatino) return 'Latino';
  if (hasCastellano) return 'Castellano';
  if (hasVose) return 'Subtitulado';
  return 'Castellano';
}

/**
 * Limpia el título publicado en el `<h1>` o tarjeta de SinSitio quitando
 * etiquetas de calidad/audio/temporada y extrayendo el año y el título alternativo
 * entre paréntesis cuando existe (p. ej. "Malas manzanas (Bad Apples) BDrip XviD Castellano").
 *
 * @param {string} rawTitle
 * @returns {{ titulo: string, tituloAlternativo: string|null, año: string|null }}
 */
function limpiarTituloPost(rawTitle) {
  let s = String(rawTitle || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { titulo: '', tituloAlternativo: null, año: null };

  // Extraer año (19xx / 20xx), p. ej. "(2026)" o "(2022-26)" o "(1989-2001)"
  let año = null;
  const yearMatch = s.match(/\(?\b((?:19|20)\d{2})(?:\s*[-–]\s*(?:(?:19|20)?\d{2}))?\b\)?/);
  if (yearMatch) {
    año = yearMatch[1];
  }

  // Extraer posibles títulos alternativos entre paréntesis que NO sean años ni tags técnicos
  // Ej: "Malas manzanas (Bad Apples) BDrip", "Aracnofobia (1990).(Arachnophobia) BDrip", "Fringe (Al límite) (2008)"
  let tituloAlternativo = null;
  const parenMatches = [...s.matchAll(/\(([^()]{2,60})\)/g)];
  for (const m of parenMatches) {
    const inner = m[1].trim();
    if (/^(?:19|20)\d{2}(?:\s*[-–]\s*\d{2,4})?$/.test(inner)) continue;
    if (/^(?:spanish|castellano|latino|english|subs?|subt|dual|vose|hevc|x264|x265|hd|hdtv|bdrip|dvdrip|web-?dl|completa|en\s+castellano|\d+\s*cap)/i.test(inner)) {
      continue;
    }
    // Si tiene año + género como "(2004 Drama)" o "(2005 Fantastico Rob Bowman)", ignorar como altTitle
    if (/^(?:19|20)\d{2}\s+/i.test(inner)) continue;
    tituloAlternativo = inner;
    break;
  }

  // Eliminar bloques entre corchetes [HDTV], [CLYON], [HD+MP3 Español Latino], [Vol.01-62]
  s = s.replace(/\[[^\]]*\]/g, ' ');

  // Eliminar paréntesis de años o técnicos
  s = s.replace(/\(\s*(?:19|20)\d{2}[^()]*\)/gi, ' ');
  s = s.replace(/\(\s*(?:spanish|castellano|latino|english|espa[ñn]ol|subs?|subt|dual|vose|completa|en\s+castellano|\d+\s*cap)[^()]*\)/gi, ' ');
  if (tituloAlternativo) {
    s = s.replace(`(${tituloAlternativo})`, ' ');
  }

  // Cortar a partir del primer marcador técnico de release o temporada
  const techCutRe = new RegExp(
    '\\b(?:' +
      'bdrip|brrip|dvdrip|hdrip|web-?dl|webrip|bluray|blu-ray|hdtv|uhd|microhd|' +
      'xvid|divx|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dts|mp4|mkv|avi|vhs|' +
      '1080p|720p|2160p|480p|4k|' +
      'castellano|latino|spanish|subtitulad[oa]|vose|reliberaci[oó]n|' +
      'temporadas?\\s+\\d+|temp\\.?\\s*\\d+|' +
      't\\d{1,2}(?:\\s*[,y\\s.]*t?\\d{1,2})*\\b|' +
      '\\d{1,2}x\\d{1,3}' +
    ')\\b.*$',
    'i'
  );
  s = s.replace(techCutRe, ' ');

  // Limpiar puntos o guiones sueltos al final
  s = s
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–:|/]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Si también hay "Título Español - OriginalTitle" (ej. "Entrega al límite - Runner")
  if (!tituloAlternativo && /\s+-\s+/.test(s)) {
    const parts = s.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 2 && parts[0].length >= 3 && parts[1].length >= 3) {
      tituloAlternativo = parts[1];
    }
  }

  return {
    titulo: s || String(rawTitle || '').trim(),
    tituloAlternativo,
    año
  };
}

// ---------------------------------------------------------------------------
// 4. CODIFICACIÓN / DECODIFICACIÓN DE SLUGS Y URLS DE SINSITIO
// ---------------------------------------------------------------------------

/**
 * Convierte una URL de SinSitio (`https://www.sinsitio.site/dvdrip-bdrip/36720-slug.html`)
 * en un identificador compacto sin barras para usar en IDs de Stremio (`ss:dvdrip-bdrip__36720-slug`).
 */
function urlToSlug(urlOrPath) {
  if (!urlOrPath) return null;
  let pathname = String(urlOrPath).trim();
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch { /* usar pathname directo */ }

  const m = pathname.match(/^\/?([a-z0-9\-_]+)\/(\d+-[^/?#]+?)(?:\.html)?$/i);
  if (!m) return null;
  const category = m[1].toLowerCase();
  const postSlug = m[2].replace(/\.html$/i, '');
  if (EXCLUDED_CATEGORIES.has(category)) return null;
  if (/^19619-haz-tu-pedido/i.test(postSlug)) return null;
  return `${category}__${postSlug}`;
}

/**
 * Reconstruye la URL completa de una ficha de SinSitio desde un slug (`categoria__12345-nombre`),
 * una ruta (`/categoria/12345-nombre.html`) o una URL completa.
 */
function slugToUrl(slugOrUrl, baseUrl = BASE_URL) {
  if (!slugOrUrl) return null;
  const raw = String(slugOrUrl).trim().replace(/^ss:/i, '');
  const base = baseUrl.replace(/\/+$/, '');

  if (/^https?:\/\//i.test(raw)) return raw;

  if (raw.includes('__')) {
    const [cat, post] = raw.split('__');
    if (cat && post) {
      return `${base}/${cat}/${post.replace(/\.html$/i, '')}.html`;
    }
  }

  const slashMatch = raw.match(/^\/?([a-z0-9\-_]+)\/(\d+-[^/?#]+?)(?:\.html)?$/i);
  if (slashMatch) {
    return `${base}/${slashMatch[1]}/${slashMatch[2].replace(/\.html$/i, '')}.html`;
  }

  return null;
}

function inferTypeFromCategoryAndTitle(category, rawTitle = '', fichaText = '') {
  const cat = String(category || '').toLowerCase();
  if (SERIES_CATEGORIES.has(cat)) return 'serie';
  const titleStr = String(rawTitle || '');
  if (/\b(?:t\d{1,2}|temporadas?\s*\d+|\d{1,2}x\d{1,3}|s\d{1,2}e\d{1,3})\b/i.test(titleStr)) {
    return 'serie';
  }
  if (/\bserie\s+de\s+tv\b|\bminiserie\b/i.test(String(fichaText || ''))) {
    return 'serie';
  }
  return 'pelicula';
}

// ---------------------------------------------------------------------------
// 5. CLIENTE HTTP CON KEEP-ALIVE, REFERER Y DESCARGA DE .TORRENT
// ---------------------------------------------------------------------------

function candidateMirrors() {
  return [...new Set([BASE_URL, ...EXTRA_MIRRORS, ...DEFAULT_MIRRORS].filter(Boolean))];
}

function rewriteSinsitioBase(targetUrl, activeBase) {
  if (!activeBase || !targetUrl) return targetUrl;
  try {
    const parsed = new URL(targetUrl);
    if (!parsed.hostname.toLowerCase().endsWith('sinsitio.site') && !targetUrl.startsWith(BASE_URL)) {
      return targetUrl;
    }
    const baseParsed = new URL(activeBase);
    parsed.protocol = baseParsed.protocol;
    parsed.host = baseParsed.host;
    return parsed.href;
  } catch {
    return targetUrl;
  }
}

async function fetchHtml(url, { referer = `${BASE_URL}/`, timeoutMs = 15000 } = {}) {
  const mirrors = candidateMirrors();
  let lastErr;

  for (let mIdx = 0; mIdx < mirrors.length; mIdx++) {
    const activeBase = mirrors[mIdx];
    const targetUrl = mIdx === 0 ? url : rewriteSinsitioBase(url, activeBase);
    const activeReferer = mIdx === 0 ? referer : rewriteSinsitioBase(referer, activeBase);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await axios.get(targetUrl, {
          headers: {
            ...DEFAULT_HEADERS,
            ...(activeReferer ? { Referer: activeReferer } : {})
          },
          httpAgent,
          httpsAgent,
          timeout: timeout(timeoutMs)
        });
        return typeof resp.data === 'string' ? resp.data : String(resp.data || '');
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err)) break;
        if (attempt === 0) await new Promise(r => setTimeout(r, 150));
      }
    }

    if (!isTransientNetworkError(lastErr)) break;
  }

  throw lastErr;
}

async function fetchTorrentBuffer(downloadUrl, { referer = `${BASE_URL}/`, ddlUrl = null, timeoutMs = 15000 } = {}) {
  const tryFetchWithMirrors = async (ref) => {
    const mirrors = candidateMirrors();
    let lastErr;
    for (let mIdx = 0; mIdx < mirrors.length; mIdx++) {
      const activeBase = mirrors[mIdx];
      const targetUrl = mIdx === 0 ? downloadUrl : rewriteSinsitioBase(downloadUrl, activeBase);
      const activeRef = mIdx === 0 ? ref : rewriteSinsitioBase(ref, activeBase);
      try {
        const resp = await axios.get(targetUrl, {
          responseType: 'arraybuffer',
          headers: {
            ...DEFAULT_HEADERS,
            Accept: 'application/x-bittorrent,application/octet-stream,*/*',
            ...(activeRef ? { Referer: activeRef } : {})
          },
          httpAgent,
          httpsAgent,
          timeout: timeout(timeoutMs)
        });
        return Buffer.from(resp.data);
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err)) break;
      }
    }
    throw lastErr;
  };

  // 1er intento: con el Referer de la ficha del post (requisito de DataLife Engine)
  let buf = await tryFetchWithMirrors(referer);
  if (buf && buf.length >= 10 && buf[0] === 0x64) {
    return buf;
  }

  // 2do intento: si DLE rebotó al HTML, probar con ddlUrl.php como Referer
  if (ddlUrl && ddlUrl !== referer) {
    buf = await tryFetchWithMirrors(ddlUrl);
    if (buf && buf.length >= 10 && buf[0] === 0x64) {
      return buf;
    }
  }

  throw new Error(`El adjunto DLE (${downloadUrl}) no devolvió un .torrent válido`);
}

/**
 * Resuelve un enlace de descarga (`index.php?do=download&id=N`) a su metainfo `.torrent`
 * cacheada en memoria y deduplicada en vuelo.
 */
async function resolveTorrentDownload(downloadUrl, { referer = `${BASE_URL}/`, ddlUrl = null } = {}) {
  if (!downloadUrl) return null;
  const cached = getCached(torrentCache, downloadUrl, TORRENT_CACHE_TTL_MS);
  if (cached) return cached;

  return coalesce(`torrent:${downloadUrl}`, async () => {
    const buffer = await fetchTorrentBuffer(downloadUrl, { referer, ddlUrl });
    const parsed = parseTorrentBuffer(buffer);
    return setCached(torrentCache, downloadUrl, parsed, MAX_TORRENT_CACHE_ENTRIES);
  });
}

// ---------------------------------------------------------------------------
// 6. PARSER DE LISTADOS (BÚSQUEDA / PORTADA / CATEGORÍAS) Y DE FICHA DETALLE
// ---------------------------------------------------------------------------

/**
 * Parsea cualquier listado HTML de SinSitio (búsqueda `do=search`, portada `/`,
 * categorías `/dvdrip-bdrip/`, `/series/`, etc.).
 */
function parseListingHtml(html, { baseUrl = BASE_URL, filterType = null } = {}) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);

  // Ignorar bloques de últimos comentarios, actividad o recomendaciones laterales
  $('.comments, #dle-comments-list, .lastcomm, .ultimos-comentarios, footer, nav').remove();

  const itemsBySlug = new Map();
  const base = baseUrl.replace(/\/+$/, '');

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const rawHref = ($a.attr('href') || '').trim();
    if (!rawHref || rawHref.includes('#comment')) return;

    let parsedUrl;
    try {
      parsedUrl = new URL(rawHref, `${base}/`);
    } catch {
      return;
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (!host.endsWith('sinsitio.site')) return;

    const slug = urlToSlug(parsedUrl.pathname);
    if (!slug) return;

    const [category] = slug.split('__');
    if (EXCLUDED_CATEGORIES.has(category)) return;

    // Extraer título desde atributo title, h4/h3 interno o texto del enlace
    const attrTitle = ($a.attr('title') || '').trim();
    const headingText = $a.find('h1, h2, h3, h4, .th-title, .short-title').first().text().trim();
    const imgAlt = ($a.find('img').first().attr('alt') || '').trim();
    let linkText = $a.clone().find('span, i, small').remove().end().text().trim();
    if (/^(?:leer\s*m[aá]s|comentarios|informaci[oó]n|regresar|adelante|atr[aá]s|\d+)$/i.test(linkText)) {
      linkText = '';
    }

    const rawTitle = attrTitle || headingText || imgAlt || linkText;
    // Buscar poster dentro del enlace o en el contenedor padre de la tarjeta
    let poster = null;
    const $imgs = $a.find('img').add($a.closest('article, .th-item, .short-item, .movie-item, div').find('img'));
    $imgs.each((__, imgEl) => {
      if (poster) return;
      const src = ($(imgEl).attr('data-src') || $(imgEl).attr('src') || '').trim();
      if (!src || /\/uploads\/fotos\/|noavatar|plus_fav|spoiler|dleimages/i.test(src)) return;
      if (/\/uploads\/posts\//i.test(src) || /\.(?:jpg|jpeg|png|webp)$/i.test(src)) {
        try {
          poster = new URL(src, `${base}/`).href;
        } catch { /* ignore */ }
      }
    });

    const existing = itemsBySlug.get(slug);
    if (existing) {
      if (!existing.poster && poster) existing.poster = poster;
      if ((!existing.tituloCompleto || existing.tituloCompleto.length < rawTitle.length) && rawTitle) {
        const cleaned = limpiarTituloPost(rawTitle);
        existing.tituloCompleto = rawTitle;
        existing.titulo = cleaned.titulo || existing.titulo;
        existing.tituloOriginal = existing.tituloOriginal || cleaned.tituloAlternativo;
        existing.año = existing.año || cleaned.año;
      }
      return;
    }

    if (!rawTitle || rawTitle.length < 2) return;

    const cleaned = limpiarTituloPost(rawTitle);
    const tipo = inferTypeFromCategoryAndTitle(category, rawTitle);

    if (filterType) {
      const targetNorm = filterType === 'series' || filterType === 'serie' ? 'serie' : 'pelicula';
      if (tipo !== targetNorm) return;
    }

    const detailUrl = `${base}${parsedUrl.pathname}`;
    itemsBySlug.set(slug, {
      titulo: cleaned.titulo,
      tituloCompleto: rawTitle,
      tituloOriginal: cleaned.tituloAlternativo || null,
      slug,
      tipo,
      año: cleaned.año || null,
      calidad: normalizarCalidad(rawTitle),
      idioma: normalizarIdioma(rawTitle, category),
      poster: poster || null,
      categoria: category,
      url: detailUrl
    });
  });

  return [...itemsBySlug.values()];
}

/**
 * Extrae un campo etiquetado de la ficha técnica de SinSitio.
 * Soporta tanto formato en línea ("Título original: Runner") como formato
 * multilínea o de tabla ("Título original \n Runner").
 */
function extractLabeledField(text, labelRegex) {
  if (!text) return null;
  const re = new RegExp(
    `(?:^|[\\n\\r])[\\s\\u00a0]*${labelRegex}[\\s\\u00a0]*(?::[\\s\\u00a0]*([^\\n\\r]+)|[\\n\\r]+[\\s\\u00a0]*([^\\n\\r]+))`,
    'im'
  );
  const m = text.match(re);
  const val = (m && (m[1] || m[2]) || '').trim();
  if (!val) return null;
  // Evitar capturar la siguiente etiqueta si el campo estaba vacío (p. ej. "Reparto \n Música")
  if (/^(?:t[ií]tulo|a[ñn]os?|duraci[oó]n|pa[ií]s|direcci[oó]n|guion|reparto|m[uú]sica|fotograf[ií]a|compa[ñn][ií]as|g[eé]nero|sinopsis|grupos)\b/i.test(val)) {
    return null;
  }
  return val;
}

/**
 * Parsea el HTML de una ficha de detalle de SinSitio (`/{categoria}/{id}-{slug}.html`).
 */
function parseDetailHtml(html, detailUrl = '') {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);

  // Eliminar comentarios, relacionados, reels y navegación para no contaminar los enlaces
  $(
    '.comments, #dle-comments-list, .related, .related-torrents, .recommendations, .recomendados, .sidebar, header, nav, footer'
  ).remove();

  const rawH1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const slug = urlToSlug(detailUrl) || '';
  const [category = ''] = slug.split('__');

  // Insertar saltos de línea virtuales en etiquetas de bloque/tabla en un clon para extraer campos aunque el HTML venga en una sola línea
  const $textClone = cheerio.load($.html());
  $textClone('br, p, div, tr, td, th, li, h1, h2, h3, h4').after('\n');
  const fullBodyText = $textClone.root().text();
  const mainContentText = fullBodyText.split(/Actividad de la Comunidad|Reels de SinSitio|Deja un comentario/i)[0] || fullBodyText;

  const cleanedH1 = limpiarTituloPost(rawH1);
  const rawOriginal = extractLabeledField(mainContentText, '(?:📺\\s*)?T[ií]tulo\\s+original');
  const rawEspana = extractLabeledField(mainContentText, '(?:🇪🇸\\s*)?T[ií]tulo\\s+en\\s+Espa[ñn]a');
  const rawYear = extractLabeledField(mainContentText, '(?:🗓️\\s*)?A[ñn]os?');
  const rawDuracion = extractLabeledField(mainContentText, '(?:⏱️\\s*)?Duraci[oó]n');
  const rawDireccion = extractLabeledField(mainContentText, '(?:🎬\\s*)?(?:Direcci[oó]n|Creada\\s+por)');
  const rawGenero = extractLabeledField(mainContentText, '(?:🎭\\s*)?G[eé]nero');
  const rawSinopsis = extractLabeledField(mainContentText, '(?:🌲\\s*)?Sinopsis');

  const añoMatch = (rawYear || '').match(/((?:19|20)\d{2})/);
  const año = (añoMatch && añoMatch[1]) || cleanedH1.año || null;

  const tituloOriginal = rawOriginal
    ? rawOriginal.replace(/\s+/g, ' ').trim()
    : (cleanedH1.tituloAlternativo || null);

  const altTitles = [];
  if (cleanedH1.tituloAlternativo && cleanedH1.tituloAlternativo !== tituloOriginal) {
    altTitles.push(cleanedH1.tituloAlternativo);
  }
  if (rawEspana) {
    for (const part of rawEspana.split(/\s+(?:u|o|\/)\s+/i)) {
      const p = part.trim();
      if (p) altTitles.push(p);
    }
  }

  // Poster principal del post (/uploads/posts/...)
  let poster = null;
  $('img').each((_, img) => {
    if (poster) return;
    const src = ($(img).attr('data-src') || $(img).attr('src') || '').trim();
    if (!src || /\/uploads\/fotos\/|noavatar|plus_fav|spoiler|dleimages/i.test(src)) return;
    if (/\/uploads\/posts\//i.test(src)) {
      try {
        poster = new URL(src, detailUrl || `${BASE_URL}/`).href;
      } catch { /* ignore */ }
    }
  });

  const tipo = inferTypeFromCategoryAndTitle(category, rawH1, `${rawGenero || ''} ${rawSinopsis || ''}`);
  const defaultIdioma = normalizarIdioma(`${rawH1} ${mainContentText}`, category);
  const defaultCalidad = normalizarCalidad(rawH1);

  // Recorrer el DOM en orden para rastrear encabezados de temporada (T1, T2, Temporada 1...)
  // y enlaces de descarga (ddlUrl.php / do=download / magnet:)
  let currentSeason = null;
  const torrents = [];
  const seenKeys = new Set();

  // Seleccionamos bloques de texto corto (posibles encabezados de temporada) y enlaces
  $('b, strong, em, i, h2, h3, h4, p, div, a[href]').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    const $el = $(el);

    if (tag !== 'a') {
      // Sólo considerar nodos hoja o cortos que declaren temporada: "T1", "T2", "Temporada 1", con cualquier emoji
      if ($el.find('a[href]').length > 0) return;
      const txt = $el.text().replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 60) return;
      const mT = txt.match(/^[^\p{L}\p{N}]*(?:temporada|temp\.?|t)\s*(\d{1,2})(?:\s*\(\d{4}\))?\s*$/iu);
      if (mT) {
        currentSeason = parseInt(mT[1], 10);
      }
      return;
    }

    const href = ($el.attr('href') || '').trim();
    if (!href) return;

    // Ignorar enlaces que estén después de la sección principal (ej. posts relacionados al pie)
    const decoded = decodeSinsitioDownload(href, BASE_URL);
    if (!decoded) return;

    const anchorText = $el.text().replace(/\s+/g, ' ').trim();
    const { title: releaseTitle, size } = parseAnchorNameAndSize(anchorText, decoded.releaseName);
    const calidad = normalizarCalidad(`${releaseTitle} ${rawH1}`) || defaultCalidad;
    const idioma = normalizarIdioma(`${releaseTitle} ${rawH1}`, category) || defaultIdioma;

    const epInfo = parseSeasonEpisodes(releaseTitle, currentSeason);
    const season = epInfo.season ?? currentSeason;

    if (epInfo.episodes.length > 0) {
      // Emitir una entrada por cada episodio cubierto (p. ej. 1x1x2 → episodio 1 y episodio 2)
      for (const ep of epInfo.episodes) {
        const dedupeKey = `${decoded.downloadUrl || decoded.magnet}:${season}:${ep}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        torrents.push({
          calidad,
          tamaño: size || null,
          idioma,
          subtitulos: /subt|subs|vose/i.test(`${releaseTitle} ${rawH1}`) ? 'Español' : 'Integrados',
          magnet: decoded.magnet || null,
          downloadUrl: decoded.downloadUrl || null,
          ddlUrl: decoded.ddlUrl || null,
          referer: detailUrl || `${BASE_URL}/`,
          dn: releaseTitle,
          temporada: season,
          episodio: ep,
          esPack: false
        });
      }
    } else {
      const dedupeKey = `${decoded.downloadUrl || decoded.magnet}:${season ?? 'all'}:${epInfo.isPack ? 'pack' : 'movie'}`;
      if (seenKeys.has(dedupeKey)) return;
      seenKeys.add(dedupeKey);
      torrents.push({
        calidad,
        tamaño: size || null,
        idioma,
        subtitulos: /subt|subs|vose/i.test(`${releaseTitle} ${rawH1}`) ? 'Español' : 'Integrados',
        magnet: decoded.magnet || null,
        downloadUrl: decoded.downloadUrl || null,
        ddlUrl: decoded.ddlUrl || null,
        referer: detailUrl || `${BASE_URL}/`,
        dn: releaseTitle,
        temporada: tipo === 'serie' ? season : null,
        episodio: null,
        esPack: tipo === 'serie' ? Boolean(epInfo.isPack || season !== null) : false
      });
    }
  });

  const generos = rawGenero
    ? rawGenero.split(/[|·,\/]/).map(g => g.replace(/Serie de TV\.?/i, '').trim()).filter(Boolean)
    : [];

  return {
    titulo: cleanedH1.titulo || rawH1,
    tituloCompleto: rawH1,
    tituloOriginal,
    altTitles,
    slug: slug || null,
    tipo,
    año,
    duracion: rawDuracion || null,
    director: rawDireccion || null,
    generos,
    sinopsis: rawSinopsis || '',
    descripcion: rawSinopsis || '',
    poster,
    url: detailUrl || null,
    torrents
  };
}

// ---------------------------------------------------------------------------
// 7. FUNCIONES PÚBLICAS DEL SCRAPER (BÚSQUEDA, DETALLE, CATÁLOGO, STREAMS)
// ---------------------------------------------------------------------------

/**
 * Busca en SinSitio (`GET /index.php?do=search&subaction=search&story={query}`).
 */
async function buscarEnSinSitio(query, tipo = null) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const cacheKey = `${cleanQuery.toLowerCase()}:${tipo || 'all'}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return cached;

  return coalesce(`search:${cacheKey}`, async () => {
    const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(cleanQuery)}`;
    try {
      const html = await fetchHtml(searchUrl, { referer: `${BASE_URL}/`, timeoutMs: 15000 });
      const results = parseListingHtml(html, { baseUrl: BASE_URL, filterType: tipo });
      return setCached(
        searchCache,
        cacheKey,
        results,
        MAX_CACHE_ENTRIES,
        results.length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS
      );
    } catch (err) {
      console.warn(`[SinSitio] Error en búsqueda "${cleanQuery}":`, err.message);
      return [];
    }
  });
}

/**
 * Obtiene y parsea la ficha de detalle de una película o serie en SinSitio.
 *
 * @param {string} slugOrUrl  `dvdrip-bdrip__36720-slug`, `/series/14275-slug.html` o URL completa
 * @param {string} [tipoPreferido='pelicula']
 */
async function extraerDetalleTorrent(slugOrUrl, tipoPreferido = 'pelicula') {
  if (!slugOrUrl) return null;
  const targetUrl = slugToUrl(slugOrUrl, BASE_URL);
  if (!targetUrl) return null;

  const cacheKey = targetUrl.toLowerCase();
  const cached = getCached(detailCache, cacheKey);
  if (cached) return cached;

  return coalesce(`detail:${cacheKey}`, async () => {
    try {
      const html = await fetchHtml(targetUrl, { referer: `${BASE_URL}/`, timeoutMs: 15000 });
      const parsed = parseDetailHtml(html, targetUrl);
      if (!parsed) return null;
      return setCached(detailCache, cacheKey, parsed);
    } catch (err) {
      console.warn(`[SinSitio] Error extrayendo detalle ${targetUrl}:`, err.message);
      return null;
    }
  });
}

/**
 * Resuelve en paralelo los archivos `.torrent` de una lista de entradas de descarga
 * para obtener su `magnet`, `infoHash`, `tamaño` real y `fileIdx` (si aplica).
 */
async function resolverMagnetsEnLote(torrents = [], { season = null, episode = null, concurrency = 4 } = {}) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  const results = new Array(torrents.length);
  let cursor = 0;

  async function worker() {
    while (cursor < torrents.length) {
      const idx = cursor++;
      const t = torrents[idx];
      if (!t) continue;
      if (t.magnet && /^magnet:\?/i.test(t.magnet)) {
        results[idx] = t;
        continue;
      }
      if (!t.downloadUrl) {
        results[idx] = t;
        continue;
      }
      try {
        const meta = await resolveTorrentDownload(t.downloadUrl, {
          referer: t.referer || `${BASE_URL}/`,
          ddlUrl: t.ddlUrl || null
        });
        if (meta && meta.magnet) {
          const epTarget = episode ?? t.episodio ?? null;
          const sTarget = season ?? t.temporada ?? null;
          let fileIdx = selectFileIdxForEpisode(meta.files, sTarget, epTarget);
          if (fileIdx === null && epTarget === null && Array.isArray(meta.files) && meta.files.length > 1 && !t.esPack) {
            const largest = selectLargestVideoFileIdx(meta.files);
            if (largest) fileIdx = largest.fileIdx;
          }
          results[idx] = {
            ...t,
            magnet: meta.magnet,
            infoHash: meta.infoHash,
            dn: meta.name || t.dn,
            tamaño: t.tamaño || formatBytes(meta.length) || null,
            fileIdx: fileIdx !== null ? fileIdx : undefined
          };
        } else {
          results[idx] = t;
        }
      } catch (err) {
        console.warn(`[SinSitio] Falló resolución de .torrent (${t.downloadUrl}):`, err.message);
        results[idx] = t;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, torrents.length) }, () => worker());
  await Promise.all(workers);
  return results.filter(Boolean);
}

const GENERO_SECCION_MAP = {
  estrenos: 'estrenos',
  castellano: 'dvdrip-bdrip',
  latino: 'audiolatino',
  'bluray 1080p': 'bluray',
  bluray: 'bluray',
  clasicos: 'cine-clsico-de-todos-los-tiempos',
  'clásicos': 'cine-clsico-de-todos-los-tiempos',
  subtitulado: 'peliculas-con-subtitulos-srt',
  vose: 'peliculas-con-subtitulos-srt',
  reliberacion: 'reliberacion',
  'reliberación': 'reliberacion',
  documentales: 'documentales',
  'series hd': 'series-mkv',
  'series mkv': 'series-mkv',
  'series clasicas': 'series-que-ya-son-clasicos',
  'series clásicas': 'series-que-ya-son-clasicos'
};

/**
 * Obtiene el catálogo de películas o series de SinSitio.
 *
 * @param {'peliculas'|'series'} [tipo='peliculas']
 * @param {number} [page=1]
 * @param {string|null} [genero=null]
 */
async function obtenerCatalogo(tipo = 'peliculas', page = 1, genero = null) {
  const esSerie = tipo === 'series' || tipo === 'serie';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const genKey = genero ? String(genero).toLowerCase().trim() : '';

  let section = esSerie ? 'series' : 'dvdrip-bdrip';
  if (genKey && GENERO_SECCION_MAP[genKey]) {
    section = GENERO_SECCION_MAP[genKey];
  }

  const cacheKey = `${tipo}:${section}:${pageNum}`;
  const cached = getCached(catalogCache, cacheKey);
  if (cached) return cached;

  return coalesce(`catalog:${cacheKey}`, async () => {
    const urls = [];
    const suffix = pageNum > 1 ? `page/${pageNum}/` : '';
    urls.push(`${BASE_URL}/${section}/${suffix}`);
    // En la página 1 sin filtro de género, combinar estrenos + sección principal para mayor variedad
    if (pageNum === 1 && !genKey) {
      if (esSerie) {
        urls.push(`${BASE_URL}/series-mkv/`);
      } else {
        urls.unshift(`${BASE_URL}/estrenos/`);
      }
    }

    const combined = [];
    const seenSlugs = new Set();
    const responses = await Promise.allSettled(
      urls.map(u => fetchHtml(u, { referer: `${BASE_URL}/`, timeoutMs: 15000 }))
    );

    for (const r of responses) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const items = parseListingHtml(r.value, {
        baseUrl: BASE_URL,
        filterType: esSerie ? 'series' : 'movie'
      });
      for (const item of items) {
        if (!item.slug || seenSlugs.has(item.slug)) continue;
        seenSlugs.add(item.slug);
        combined.push(item);
      }
    }

    return setCached(catalogCache, cacheKey, combined);
  });
}

/**
 * Convierte un torrent resuelto de SinSitio en un objeto `stream` de Stremio.
 */
function torrentToStream(torrent, tituloFallback, extra = {}) {
  if (!torrent) return null;
  const magnet = String(torrent.magnet || '').trim();
  if (!magnet.startsWith('magnet:')) return null;

  const calidad = torrent.calidad || '1080p';
  const idioma = torrent.idioma || 'Castellano';
  const subs = torrent.subtitulos || 'Integrados';
  const tamaño = torrent.tamaño || null;

  const infoHash = R_EXTRA.extraerInfoHash(torrent.infoHash) || R_EXTRA.extraerInfoHash(magnet);
  if (!infoHash) return null;

  let dn = torrent.dn || null;
  if (!dn) {
    const m = magnet.match(/[?&]dn=([^&]+)/);
    if (m) {
      try { dn = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { dn = m[1]; }
    }
  }

  const se = torrentSeasonEpisode(torrent);
  const season = extra.season ?? se.season;
  const episode = extra.episode ?? se.episode;
  const esPack = extra.esPack === true || torrent.esPack === true;

  const lineas = [];
  const baseName = extra.titulo || tituloFallback || 'SinSitio';
  const displayName = (season !== null && season !== undefined && episode !== null && episode !== undefined)
    ? `${baseName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : baseName;

  lineas.push(displayName);
  lineas.push(`🎞️ ${calidad} | 💾 ${tamaño || '?'} | 🗣️ ${idioma} | Subs: ${subs}`);
  if (esPack) lineas.push('📦 Temporada completa (pack)');
  if (dn) lineas.push(`📄 ${dn}`);

  const stream = {
    name: `SinSitio\n${calidad}`,
    title: lineas.join('\n'),
    infoHash,
    sources: R_EXTRA.construirSources(infoHash, magnet),
    behaviorHints: {
      bingeGroup: `sinsitio-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      ...(dn ? { filename: dn } : {})
    },
    _meta: {
      fuente: 'sinsitio',
      idioma,
      calidad,
      seeders: 0,
      pack: esPack === true
    }
  };

  if (Number.isInteger(torrent.fileIdx) && torrent.fileIdx >= 0) {
    stream.fileIdx = torrent.fileIdx;
  }

  return stream;
}

/**
 * Filtra los torrents de una ficha por temporada y episodio (exactos vs packs).
 */
function filtrarPorEpisodio(torrents, season, episode) {
  if (!Array.isArray(torrents) || season === null || episode === null) {
    return { exactos: torrents || [], packs: [] };
  }
  const s = Number(season);
  const e = Number(episode);
  const exactos = [];
  const packs = [];

  for (const t of torrents) {
    const matchKind = torrentMatchesEpisode(t, s, e);
    if (matchKind === 'exact') {
      exactos.push(t);
      continue;
    }
    if (matchKind === 'pack') {
      packs.push(t);
      continue;
    }
    const info = torrentSeasonEpisode(t);
    if (info.isPack && !info.isMultiSeasonPack && info.season === null) {
      packs.push(t);
    }
  }
  return { exactos, packs };
}

/**
 * Busca y resuelve streams en SinSitio para una película o serie.
 * Compatible con la interfaz de fuentes externas de `index.js`:
 *   buscarStreams({ title, originalTitle, altTitles, tmdbId, year, type, season, episode })
 */
async function buscarStreams({ title, originalTitle, altTitles = [], year, type, season = null, episode = null } = {}) {
  const conEpisodio = season !== null && episode !== null;
  const esSerie = type === 'series' || type === 'serie' || (type === 'anime' && conEpisodio);
  const tipoObjetivo = esSerie ? 'series' : 'movie';

  const queries = [];
  const seenQ = new Set();
  const pushQuery = (q) => {
    const clean = String(q || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) return;
    const norm = normalizeTitle(clean);
    if (!norm || seenQ.has(norm)) return;
    seenQ.add(norm);
    queries.push(clean);
    const deaccented = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (deaccented !== clean && !queries.includes(deaccented)) {
      queries.push(deaccented);
    }
  };

  // En SinSitio, el buscador DLE indexa tanto el título en español como "Título original: <English>"
  pushQuery(title);
  pushQuery(originalTitle);
  for (const alt of (Array.isArray(altTitles) ? altTitles : [])) {
    pushQuery(alt);
  }
  // Si el título tiene subtítulo tras ':' o '-', añadir también la raíz principal
  for (const base of [title, originalTitle]) {
    if (base && /[:\-–]/.test(base)) {
      const head = base.split(/[:\-–]/)[0].trim();
      if (head.length >= 4) pushQuery(head);
    }
  }

  if (queries.length === 0) return [];

  const target = {
    title: title || originalTitle,
    originalTitle: originalTitle || title,
    altTitles: Array.isArray(altTitles) ? altTitles : [],
    year,
    type: tipoObjetivo
  };

  const allCandidates = [];
  const seenSlugs = new Set();

  // Ejecutar las consultas principales en paralelo (máx 3 variantes)
  const searchBatch = queries.slice(0, 3);
  const batchResults = await Promise.allSettled(
    searchBatch.map(q => buscarEnSinSitio(q, tipoObjetivo))
  );

  for (const r of batchResults) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const item of r.value) {
      if (!item || !item.slug || seenSlugs.has(item.slug)) continue;
      seenSlugs.add(item.slug);
      allCandidates.push(item);
    }
  }

  if (allCandidates.length === 0) return [];

  const MIN_SCORE = 0.6;
  let ranked = rankCandidates(allCandidates, target);
  const picked = pickBestMatch(allCandidates, target, { minScore: MIN_SCORE });
  let mejores = picked.ranked.filter(r => r.score >= MIN_SCORE);
  if (mejores.length === 0 && picked.best && picked.match) {
    mejores = [picked.match];
  }

  // Si la consulta se hizo con el título original en inglés (p. ej. "Secret Society of Lies"
  // o "Dark Matter"), la tarjeta de búsqueda sólo muestra el título en español ("Sociedad secreta de mentiras"
  // o "Materia Oscura"), pero el motor DLE devolvió ese post porque su cuerpo contiene
  // "Título original: Secret Society of Lies". Inspeccionamos hasta los 3 primeros candidatos
  // para verificar su `tituloOriginal` y `año` reales en la ficha técnica.
  const candidatesToInspect = mejores.length > 0
    ? mejores.slice(0, 3).map(r => r.cand)
    : ranked.slice(0, 3).map(r => r.cand);

  for (const cand of candidatesToInspect) {
    if (!cand || !cand.slug) continue;
    const detalle = await extraerDetalleTorrent(cand.slug, esSerie ? 'serie' : 'pelicula');
    if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) continue;

    // Verificar puntuación combinando datos de la tarjeta + datos reales de la ficha técnica
    const enrichedCand = {
      ...cand,
      titulo: detalle.titulo || cand.titulo,
      tituloOriginal: detalle.tituloOriginal || cand.tituloOriginal,
      año: detalle.año || cand.año,
      tipo: detalle.tipo || cand.tipo
    };
    const allAltTitles = [
      ...(target.altTitles || []),
      ...(detalle.altTitles || [])
    ];
    const verifiedScore = scoreCandidate(enrichedCand, {
      ...target,
      altTitles: allAltTitles
    });

    if (verifiedScore.score < MIN_SCORE) {
      // Permitir también coincidencia exacta de año cuando es el único resultado de la búsqueda
      const isUniqueExactYear =
        allCandidates.length === 1 &&
        verifiedScore.yearDelta === 0 &&
        verifiedScore.titleScore >= 0.4;
      if (!isUniqueExactYear) continue;
    }

    // Pre-filtrar por episodio ANTES de descargar los archivos .torrent
    let elegidos = detalle.torrents;
    let esPack = false;
    if (esSerie && season !== null && episode !== null) {
      const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
      if (exactos.length === 0 && packs.length === 0) continue;
      elegidos = exactos.length > 0 ? exactos : packs;
      esPack = exactos.length === 0 && packs.length > 0;
    } else if (!esSerie) {
      elegidos = detalle.torrents.filter(t => {
        const se = torrentSeasonEpisode(t);
        return se.season === null && se.episode === null;
      });
      if (elegidos.length === 0) elegidos = detalle.torrents;
    }

    // Resolver únicamente los .torrent seleccionados (1–2 peticiones en vez de toda la serie)
    const resueltos = await resolverMagnetsEnLote(elegidos, { season, episode });
    const streams = resueltos
      .map(t => torrentToStream(t, detalle.titulo, {
        titulo: detalle.titulo,
        season: esSerie ? season : null,
        episode: esSerie ? (esPack ? null : episode) : null,
        esPack
      }))
      .filter(Boolean);

    if (streams.length > 0) {
      return streams;
    }
  }

  return [];
}

module.exports = {
  BASE_URL,
  DEFAULT_MIRRORS,
  DEFAULT_TRACKERS,
  decodeBencode,
  locateInfoDict,
  parseTorrentBuffer,
  buildMagnet,
  formatBytes,
  selectFileIdxForEpisode,
  decodeSinsitioDownload,
  parseAnchorNameAndSize,
  parseSeasonEpisodes,
  limpiarTituloPost,
  urlToSlug,
  slugToUrl,
  parseListingHtml,
  parseDetailHtml,
  buscarEnSinSitio,
  extraerDetalleTorrent,
  resolverMagnetsEnLote,
  obtenerCatalogo,
  torrentToStream,
  filtrarPorEpisodio,
  buscarStreams,
  clearCache
};
