/**
 * lib/bencode.js
 * ---------------------------------------------------------------------------
 * Parser Bencode ligero (100 % Node nativo, cero dependencias externas) para:
 *   - Calcular el `infoHash` SHA-1 exacto de cualquier archivo `.torrent`
 *     hasheando los bytes crudos del diccionario `info` (BEP-3).
 *   - Extraer `announce` / `announce-list` (trackers) y `files` (multifile).
 *   - Seleccionar automáticamente el `fileIdx` correcto en packs de serie/anime
 *     (descartando clips `sample`/`trailer` y soportando capítulos dobles)
 *     o el archivo de vídeo principal en torrents multifile de películas.
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
const { parseSeasonEpisode } = require('./match');

const VIDEO_FILE_RE = /\.(mkv|mp4|avi|mov|webm|m4v|ts|m2ts|ogm|mpg|mpeg)$/i;
const SAMPLE_FILE_RE = /(?:^|[\\/.\s_-])(sample|trailer|teaser|featurette|ncop|nced|creditless)(?=$|[\\/.\s_-])/i;

function parseBencodeBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('Buffer .torrent vacío o inválido');
  }
  let pos = 0;

  function parseValue() {
    if (pos >= buf.length) throw new Error('Bencode truncado');
    const ch = buf[pos];

    // Entero: i<num>e
    if (ch === 0x69) {
      pos++;
      const end = buf.indexOf(0x65, pos);
      if (end === -1) throw new Error('Entero bencode sin cierre');
      const num = parseInt(buf.slice(pos, end).toString('ascii'), 10);
      pos = end + 1;
      return num;
    }

    // Lista: l...e
    if (ch === 0x6c) {
      pos++;
      const arr = [];
      while (pos < buf.length && buf[pos] !== 0x65) {
        arr.push(parseValue());
      }
      if (pos >= buf.length) throw new Error('Lista bencode sin cierre');
      pos++;
      return arr;
    }

    // Diccionario: d...e
    if (ch === 0x64) {
      const start = pos;
      pos++;
      const obj = {};
      while (pos < buf.length && buf[pos] !== 0x65) {
        const keyBuf = parseBytes();
        const key = keyBuf.toString('utf8');
        const valStart = pos;
        const val = parseValue();
        const valEnd = pos;
        obj[key] = val;
        if (key === 'info') {
          Object.defineProperty(obj, '__rawInfo', {
            value: buf.slice(valStart, valEnd),
            enumerable: false
          });
        }
      }
      if (pos >= buf.length) throw new Error('Diccionario bencode sin cierre');
      pos++;
      Object.defineProperty(obj, '__rawSlice', {
        value: buf.slice(start, pos),
        enumerable: false
      });
      return obj;
    }

    // Cadena de bytes: <len>:<bytes>
    if (ch >= 0x30 && ch <= 0x39) {
      return parseBytes();
    }

    throw new Error(`Byte bencode inesperado 0x${ch.toString(16)} en offset ${pos}`);
  }

  function parseBytes() {
    const colon = buf.indexOf(0x3a, pos);
    if (colon === -1) throw new Error('Cadena bencode sin ":"');
    const len = parseInt(buf.slice(pos, colon).toString('ascii'), 10);
    if (!Number.isFinite(len) || len < 0) throw new Error('Longitud bencode inválida');
    const start = colon + 1;
    const end = start + len;
    if (end > buf.length) throw new Error('Cadena bencode truncada');
    pos = end;
    return buf.slice(start, end);
  }

  return parseValue();
}

/** Detecta heurísticamente si un Buffer parece ser un archivo `.torrent` Bencode. */
function isTorrentBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return false;
  if (buf[0] !== 0x64) return false; // 'd'
  // Evitar confundir HTML o JSON que nunca empieza con 'd<digito>:'
  if (buf[1] < 0x30 || buf[1] > 0x39) return false;
  return buf.includes(Buffer.from('4:info', 'ascii'));
}

function bufToUtf8(val) {
  if (Buffer.isBuffer(val)) return val.toString('utf8');
  return val !== undefined && val !== null ? String(val) : '';
}

function parseTorrentBuffer(buf) {
  const decoded = parseBencodeBuffer(buf);
  if (!decoded || typeof decoded !== 'object' || !decoded.__rawInfo || !decoded.info) {
    throw new Error('Archivo .torrent sin sección info válida');
  }

  const infoHash = crypto.createHash('sha1').update(decoded.__rawInfo).digest('hex').toLowerCase();
  const info = decoded.info;
  const name = bufToUtf8(info['name.utf-8'] || info.name);

  const trackers = [];
  const pushTracker = (raw) => {
    const t = bufToUtf8(raw).trim();
    if (/^(udp|https?|wss?):\/\//i.test(t) && !trackers.includes(t)) {
      trackers.push(t);
    }
  };
  if (decoded.announce) pushTracker(decoded.announce);
  if (Array.isArray(decoded['announce-list'])) {
    for (const tier of decoded['announce-list']) {
      if (Array.isArray(tier)) {
        for (const tr of tier) pushTracker(tr);
      } else {
        pushTracker(tier);
      }
    }
  }

  const files = [];
  let totalSize = 0;
  if (Array.isArray(info.files)) {
    info.files.forEach((f, idx) => {
      const rawParts = f['path.utf-8'] || f.path || [];
      const parts = Array.isArray(rawParts) ? rawParts.map(bufToUtf8) : [bufToUtf8(rawParts)];
      const filePath = parts.filter(Boolean).join('/');
      const length = Number(f.length) || 0;
      totalSize += length;
      files.push({ index: idx, path: filePath, name: parts[parts.length - 1] || filePath, length });
    });
  } else {
    const length = Number(info.length) || 0;
    totalSize = length;
    files.push({ index: 0, path: name, name, length });
  }

  return { infoHash, name, trackers, files, totalSize };
}

/**
 * Selecciona el `fileIdx` exacto dentro de un torrent multifile para el episodio
 * solicitado, descartando clips `sample`/`trailer` y priorizando el archivo de mayor tamaño.
 */
function selectFileIdxForEpisode(files, targetSeason, targetEpisode) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!Number.isFinite(targetEpisode)) return null;

  const allVideoFiles = files.filter(f => VIDEO_FILE_RE.test(f.name || f.path || ''));
  if (allVideoFiles.length === 0) return null;

  // Preferir vídeos reales frente a clips sample/trailer
  const nonSampleVideos = allVideoFiles.filter(f => !SAMPLE_FILE_RE.test(f.path || f.name || ''));
  const pool = nonSampleVideos.length > 0 ? nonSampleVideos : allVideoFiles;

  const epMatches = (se, ep) => se.episode === ep || (Array.isArray(se.episodes) && se.episodes.includes(ep));
  const pickLargest = (candidates) => {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.length || 0) - (a.length || 0));
    return candidates[0];
  };

  // 1) Coincidencia explícita SxxExx / 1x02 / Episodio N (incluidos episodios dobles)
  if (Number.isFinite(targetSeason)) {
    const exactBoth = pool.filter(f => {
      const se = parseSeasonEpisode(f.path || f.name);
      return se.season === targetSeason && epMatches(se, targetEpisode);
    });
    const bestExact = pickLargest(exactBoth);
    if (bestExact) return { fileIdx: bestExact.index, file: bestExact };
  }

  // 2) Archivos donde el nombre sólo trae episodio ("Cap 05.mkv", "- 05 [1080p].mkv", "E05.mp4")
  const epCandidates = [];
  for (const f of pool) {
    const base = f.name || f.path || '';
    const se = parseSeasonEpisode(base);
    if (epMatches(se, targetEpisode) && (se.season === null || se.season === targetSeason)) {
      epCandidates.push(f);
      continue;
    }
    const stripped = base
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/\b(2160|1080|720|480)[pi]?\b/gi, ' ')
      .replace(/\b[xh]\.?26[45]\b/gi, ' ')
      .replace(/\b10\s*bit\b/gi, ' ')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
    const bareMatch = stripped.match(/(?:^|[\s._-]+)(?:ep?\.?|cap(?:[ií]tulo)?\.?)?\s*0*(\d{1,3})(?:v\d+)?(?=$|[\s._-]+|\.[a-z0-9]{2,4}$)/i);
    if (bareMatch && parseInt(bareMatch[1], 10) === targetEpisode) {
      epCandidates.push(f);
    }
  }
  const bestEp = pickLargest(epCandidates);
  if (bestEp) return { fileIdx: bestEp.index, file: bestEp };

  // 3) Si el torrent sólo contiene un único archivo de vídeo real y el propio nombre del pack ya se validó
  if (pool.length === 1 && files.length <= 3) {
    return { fileIdx: pool[0].index, file: pool[0] };
  }

  return null;
}

/**
 * Para torrents multifile de películas (vídeo + `.srt` + `.nfo` + `sample.mkv`),
 * selecciona el `fileIdx` del archivo de vídeo principal (el más grande).
 */
function selectLargestVideoFileIdx(files) {
  if (!Array.isArray(files) || files.length <= 1) return null;
  const allVideoFiles = files.filter(f => VIDEO_FILE_RE.test(f.name || f.path || ''));
  if (allVideoFiles.length === 0) return null;
  const nonSample = allVideoFiles.filter(f => !SAMPLE_FILE_RE.test(f.path || f.name || ''));
  const pool = nonSample.length > 0 ? nonSample : allVideoFiles;
  pool.sort((a, b) => (b.length || 0) - (a.length || 0));
  return { fileIdx: pool[0].index, file: pool[0] };
}

module.exports = {
  VIDEO_FILE_RE,
  SAMPLE_FILE_RE,
  isTorrentBuffer,
  parseBencodeBuffer,
  parseTorrentBuffer,
  selectFileIdxForEpisode,
  selectLargestVideoFileIdx
};
