/**
 * lib/release.js
 * ---------------------------------------------------------------------------
 * Reglas COMPARTIDAS para las fuentes externas (Knaben, Torrents.csv, Black Hole Bay…).
 *
 * Todas las fuentes entregan sus resultados como "hits normalizados":
 *   {
 *     name:      nombre del release          ("Breaking.Bad.S02E05.1080p...")
 *     hash:      infoHash (hex, opcional)
 *     magnet:    magnet completo (opcional)
 *     seeders, peers,
 *     sizeLabel: "1.02 GiB"
 *     tracker:   "The Pirate Bay"
 *     fuente:    "Knaben" | "Torrents.csv" | "Black Hole Bay"
 *   }
 *
 * Aquí se aplican las mismas reglas que en HackTorrent para no volver a
 * entregar el torrent equivocado:
 *   - el título (o título original / alternativo) debe aparecer como FRASE
 *     en el nombre del release (soportando equivalencias `&`/`and`/`y`,
 *     guiones compuestos "Spider-Man" ↔ "Spiderman" y secuelas "II" ↔ "2")
 *   - películas: año del release ±1 y descartar nombres con SxxExx o packs de temporada
 *   - series: SxxExx exacto (incluidos capítulos dobles S01E01E02); si no hay,
 *     sólo packs de ESA temporada (nunca packs multitemporada S01-S05)
 *   - sin magnet/hash → descartado
 *   - deduplicado por infoHash
 * ---------------------------------------------------------------------------
 */

'use strict';

const { normalizeTitle, parseSeasonEpisode, parseYear } = require('./match');

// Trackers de respaldo cuando la fuente sólo entrega el infoHash
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.io:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'wss://tracker.openwebtorrent.com'
];

// Patrones de archivos que NO son vídeo (separados por cualquier carácter no alfanumérico, incluido `_`)
const NON_VIDEO_TOKEN_RE = /(?:^|[^a-z0-9])(soundtrack|ost|discography|album|mp3|flac|wav|aac\s*ost|audiobook|m4b|ebook|e-book|epub|mobi|cbr|cbz|comic|comics|software|windows|linux|macos|android|apk|exe|msi|dmg| crack|keygen|repack\s+by\s+fitgirl|fitgirl|dodi|codex|rune|skidrow|nsp|xci|xxx|porn|adult)(?=$|[^a-z0-9])/i;
const NON_VIDEO_EXT_RE = /\.(mp3|flac|wav|ogg|m4b|epub|mobi|pdf|cbz|cbr|exe|msi|apk|dmg|deb|rpm|nsp|xci|pkg)$/i;

function esReleaseVideo(nombre) {
  const s = String(nombre || '').trim();
  if (!s) return false;
  if (NON_VIDEO_EXT_RE.test(s)) return false;
  return !NON_VIDEO_TOKEN_RE.test(s);
}

// ------------------- FORMATO -------------------

function bytesAHumano(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Último año del nombre del release ("1917.2019" o "The_Avengers_2012_1080p" → 2012). */
function ultimoAnio(texto) {
  if (!texto) return null;
  const matches = [...String(texto).matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=$|[^0-9])/g)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

function calidadDeNombre(nombre) {
  const s = String(nombre || '');
  if (/(?:^|[^a-z0-9])(2160p|4k|uhd)(?=$|[^a-z0-9])/i.test(s)) return '4K';
  if (/(?:^|[^a-z0-9])(1080p|1080i|fhd|fullhd)(?=$|[^a-z0-9])/i.test(s)) return '1080p';
  if (/(?:^|[^a-z0-9])720p(?=$|[^a-z0-9])/i.test(s)) return '720p';
  if (/(?:^|[^a-z0-9])(480p|576p|dvdrip|dvd)(?=$|[^a-z0-9])/i.test(s)) return '480p';
  if (/(?:^|[^a-z0-9])(hdtv|webrip|web-dl|web|brrip|bdrip|bluray|cam|camrip|hdcam|ts|telesync)(?=$|[^a-z0-9])/i.test(s)) return 'SD';
  return 'Desconocida';
}

function fuenteDeNombre(nombre) {
  const s = String(nombre || '');
  if (/(?:^|[^a-z0-9])remux(?=$|[^a-z0-9])/i.test(s)) return 'REMUX';
  if (/web[\s._-]*dl/i.test(s)) return 'WEB-DL';
  if (/web[\s._-]*rip/i.test(s)) return 'WEBRip';
  if (/blu[\s._-]*ray|bdrip|brrip/i.test(s)) return 'BluRay';
  if (/(?:^|[^a-z0-9])hdtv(?=$|[^a-z0-9])/i.test(s)) return 'HDTV';
  if (/(?:^|[^a-z0-9])dvdrip(?=$|[^a-z0-9])/i.test(s)) return 'DVDRip';
  if (/(?:^|[^a-z0-9])(hdcam|camrip|cam|telesync|hdts)(?=$|[^a-z0-9])/i.test(s)) return 'CAM';
  return null;
}

function idiomaDeNombre(nombre) {
  const s = String(nombre || '');
  const hasLatino = /(?:^|[^a-z0-9])(latino|lat)(?=$|[^a-z0-9])/i.test(s);
  const hasCastellano = /(?:^|[^a-z0-9])(castellano|espa[nñ]ol|spanish|spa|esp)(?=$|[^a-z0-9])/i.test(s);
  const hasIngles = /(?:^|[^a-z0-9])(english|ingles|eng)(?=$|[^a-z0-9])/i.test(s);
  const hasDual = /(?:^|[^a-z0-9])(dual|multi)(?=$|[^a-z0-9])/i.test(s);

  if (hasLatino && (hasIngles || hasDual)) return 'Latino/Inglés';
  if (hasCastellano && (hasIngles || hasDual)) return 'Dual';
  if (hasLatino) return 'Latino';
  if (hasCastellano) return 'Castellano';
  if (hasDual) return 'Dual';
  return 'Inglés';
}

/** Convierte un hash Base32 RFC 4648 (32 caracteres) a hex SHA-1 de 40 caracteres. */
function base32ToHex(b32) {
  const clean = String(b32 || '').trim().toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]{32}$/.test(clean)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of clean) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.length === 40 ? hex.toLowerCase() : null;
}

/**
 * Extrae y normaliza un infoHash SHA-1 (40 hex en minúsculas) desde un hash
 * directo (hex o Base32) o desde un enlace magnet (incluidos híbridos v2/v1).
 */
function extraerInfoHash(magnetOrHash) {
  if (!magnetOrHash) return null;
  const raw = String(magnetOrHash).trim();
  if (/^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(raw) && !/^[0-9a-f]{32}$/i.test(raw)) {
    return base32ToHex(raw);
  }
  const m = raw.match(/btih:([0-9a-f]{40}|[A-Z2-7]{32})/i);
  if (!m) return null;
  const candidate = m[1];
  if (candidate.length === 40) return candidate.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(candidate) && !/^[0-9a-f]{32}$/i.test(candidate)) {
    return base32ToHex(candidate);
  }
  return null;
}

/** Extrae todos los trackers (`tr=`) válidos embebidos en un enlace magnet. */
function extraerTrackersDeMagnet(magnet) {
  if (!magnet || typeof magnet !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = re.exec(magnet)) !== null) {
    let decoded = match[1];
    try { decoded = decodeURIComponent(decoded.replace(/\+/g, ' ')); } catch { /* usar crudo */ }
    decoded = decoded.trim().replace(/^tracker:/i, '');
    if (!/^(udp|https?|wss?):\/\//i.test(decoded)) continue;
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push(decoded);
  }
  return out;
}

/**
 * Construye la lista `sources` oficial del protocolo de Torrents de Stremio:
 * `["tracker:<url>", ..., "dht:<infoHash>"]`.
 */
function construirSources(infoHash, magnetOrTrackers = null, incluirRespaldo = true) {
  const hash = extraerInfoHash(infoHash);
  const crudos = [];
  if (typeof magnetOrTrackers === 'string') {
    crudos.push(...extraerTrackersDeMagnet(magnetOrTrackers));
  } else if (Array.isArray(magnetOrTrackers)) {
    for (const item of magnetOrTrackers) {
      const limpio = String(item || '').trim().replace(/^tracker:/i, '');
      if (/^(udp|https?|wss?):\/\//i.test(limpio)) crudos.push(limpio);
    }
  }
  if (incluirRespaldo) {
    crudos.push(...TRACKERS);
  }

  const seen = new Set();
  const sources = [];
  for (const tr of crudos) {
    if (seen.has(tr)) continue;
    seen.add(tr);
    sources.push(`tracker:${tr}`);
  }
  if (hash) sources.push(`dht:${hash}`);
  return sources;
}

const ROMAN_SEQUEL_MAP = {
  ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9',
  two: '2', dos: '2', three: '3', tres: '3', four: '4', cuatro: '4'
};

function normalizarSecuelaEnFrase(normPhrase) {
  const words = normPhrase.split(' ');
  if (words.length < 2) return normPhrase;
  return words.map((w, i) => {
    if (i === 0) return w;
    if (ROMAN_SEQUEL_MAP[w]) {
      if (/^(two|dos|three|tres|four|cuatro)$/.test(w)) {
        return /^(part|parte|chapter|capitulo|vol|volume|volumen)$/.test(words[i - 1])
          ? ROMAN_SEQUEL_MAP[w]
          : w;
      }
      return ROMAN_SEQUEL_MAP[w];
    }
    return w;
  }).join(' ');
}

function fraseCoincide(objetivo, nombre) {
  if (!objetivo || !nombre) return false;
  if (objetivo.split(' ').length === 1) {
    return nombre === objetivo || nombre.startsWith(objetivo + ' ');
  }
  return (' ' + nombre + ' ').includes(' ' + objetivo + ' ');
}

/**
 * ¿El título buscado aparece como frase dentro del nombre del torrent?
 * - 2+ palabras: la frase completa debe aparecer (evita que "Breaking Bad"
 *   empareje con "The Bad Guys Breaking In").
 * - 1 palabra: debe ser la primera palabra del release.
 * - Soporta equivalencia de conectores (`&` ↔ `and` ↔ `y`), palabras con guión
 *   (`Spider-Man` ↔ `Spiderman`) y numerales de secuela (`Gladiator II` ↔ `Gladiator 2`).
 */
function contieneTitulo(tituloBuscado, nombreTorrent) {
  if (!tituloBuscado || !nombreTorrent) return false;

  const objetivo = normalizeTitle(tituloBuscado);
  const nombre = normalizeTitle(nombreTorrent);
  if (!objetivo || !nombre) return false;

  if (fraseCoincide(objetivo, nombre)) return true;

  // Equivalencia de conectores (& / and / y): ej. "Deadpool & Wolverine" ↔ "Deadpool and Wolverine"
  if (/[&]|\b(and|y)\b/i.test(String(tituloBuscado))) {
    const stripConn = s => s.replace(/\b(and|y)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const objSinConn = stripConn(objetivo);
    const nomSinConn = stripConn(nombre);
    if (objSinConn.split(' ').length >= 2 && fraseCoincide(objSinConn, nomSinConn)) {
      return true;
    }
  }

  // Equivalencia de palabras compuestas con guión: ej. "Spider-Man" ↔ "Spiderman", "X-Men" ↔ "Xmen"
  if (String(tituloBuscado).includes('-')) {
    const collapsedTitle = normalizeTitle(String(tituloBuscado).replace(/([a-zA-Z0-9])-([a-zA-Z0-9])/g, '$1$2'));
    if (collapsedTitle && collapsedTitle !== objetivo && fraseCoincide(collapsedTitle, nombre)) {
      return true;
    }
  }

  // Equivalencia de secuelas en números romanos / Part Two ↔ Part 2
  const objSec = normalizarSecuelaEnFrase(objetivo);
  const nomSec = normalizarSecuelaEnFrase(nombre);
  if ((objSec !== objetivo || nomSec !== nombre) && fraseCoincide(objSec, nomSec)) {
    return true;
  }

  return false;
}

/** Magnet a partir del infoHash (con trackers de respaldo). */
function construirMagnet(hash, dn, trackers = TRACKERS) {
  const cleanHash = extraerInfoHash(hash);
  if (!cleanHash) return null;
  const params = [`xt=urn:btih:${cleanHash}`];
  if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join('&')}`;
}

const CALIDAD_ORDEN = { '4K': 5, '1080p': 4, '720p': 3, '480p': 2, SD: 1, Desconocida: 2 };

// ------------------- FILTRADO -------------------

/**
 * Filtra, ordena y limita hits normalizados.
 *
 * @param {Array} hits
 * @param {object} opciones
 * @param {string} opciones.title
 * @param {string} [opciones.originalTitle]
 * @param {string[]} [opciones.altTitles]
 * @param {string|number} [opciones.year]
 * @param {'movie'|'series'|'anime'} [opciones.type]
 * @param {number|null} [opciones.season]
 * @param {number|null} [opciones.episode]
 * @param {number} [opciones.limit]
 * @param {(hit:object)=>boolean} [opciones.aceptarCategoria] filtro propio de la fuente
 * @returns {{aceptados: Array<{hit:object, se:object, magnet:string}>, total: number}}
 */
function filtrarYOrdenar(hits, opciones = {}) {
  const {
    title,
    originalTitle = null,
    altTitles = [],
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = 15,
    aceptarCategoria = () => true
  } = opciones;

  const conEpisodio = Number.isFinite(season) && Number.isFinite(episode);
  const esSerie = type === 'series' || type === 'serie' || (type === 'anime' && conEpisodio);
  const anioObjetivo = parseYear(year);

  const titulosValidos = [
    title,
    originalTitle,
    ...(Array.isArray(altTitles) ? altTitles : [])
  ].filter(Boolean);

  const aceptados = [];
  const vistos = new Set();

  for (const hit of hits || []) {
    if (!hit || !hit.name) continue;

    const hash = extraerInfoHash(hit.hash) || extraerInfoHash(hit.magnet) || '';
    const clave = hash || hit.magnet;
    if (!clave || vistos.has(clave)) continue;

    if (!aceptarCategoria(hit)) continue;

    const magnet = hit.magnet && /^magnet:/i.test(hit.magnet)
      ? hit.magnet
      : construirMagnet(hash || hit.hash, hit.name);
    if (!magnet) continue;

    if (!titulosValidos.some(t => contieneTitulo(t, hit.name))) {
      continue;
    }

    const se = parseSeasonEpisode(hit.name);

    if (esSerie) {
      if (conEpisodio) {
        const exacto = se.season === season && (
          se.episode === episode ||
          (Array.isArray(se.episodes) && se.episodes.includes(episode))
        );
        const packDeTemporada = se.season === season && se.episode === null && se.isPack && !se.isMultiSeasonPack;
        if (!exacto && !packDeTemporada) continue;
      }
    } else {
      const anioHit = ultimoAnio(hit.name);
      if (anioObjetivo && anioHit && Math.abs(anioHit - anioObjetivo) > 1) continue;
      // En películas descartamos tanto episodios sueltos como packs de temporada
      if (se.season !== null || se.episode !== null || se.isPack) continue;
    }

    vistos.add(clave);
    aceptados.push({ hit, se, magnet, hash });
  }

  const seedersDe = (hit) => Number(hit.seeders ?? 0);
  const esExacto = (entry) => conEpisodio && entry.se.season === season && (
    entry.se.episode === episode ||
    (Array.isArray(entry.se.episodes) && entry.se.episodes.includes(episode))
  ) ? 1 : 0;

  aceptados.sort((a, b) => {
    const aExacto = esExacto(a);
    const bExacto = esExacto(b);
    if (aExacto !== bExacto) return bExacto - aExacto;
    const diffSeeders = seedersDe(b.hit) - seedersDe(a.hit);
    if (diffSeeders !== 0) return diffSeeders;
    const calA = CALIDAD_ORDEN[calidadDeNombre(a.hit.name)] || 0;
    const calB = CALIDAD_ORDEN[calidadDeNombre(b.hit.name)] || 0;
    if (calA !== calB) return calB - calA;
    return (Number(b.hit.size) || 0) - (Number(a.hit.size) || 0);
  });

  return { aceptados: aceptados.slice(0, limit), total: aceptados.length };
}

/** Formatea un hit aceptado como stream de Stremio. */
function formatearStream({ hit, se, magnet, hash }, fuentes = {}) {
  const {
    nombreFuente = 'Indexer',
    claveFuente = 'externa'
  } = fuentes;

  const calidad = calidadDeNombre(hit.name);
  const fuente = fuenteDeNombre(hit.name);
  const idioma = idiomaDeNombre(hit.name);
  const seeders = Number(hit.seeders ?? 0);
  const peers = Number(hit.peers ?? 0);
  const size = hit.sizeLabel || bytesAHumano(hit.size);

  const esEpisodio = se && se.season !== null && se.episode !== null;
  const esPack = se && !esEpisodio && se.isPack;

  const lineas = [];
  if (esEpisodio) {
    if (Array.isArray(se.episodes) && se.episodes.length > 1) {
      const first = String(se.episodes[0]).padStart(2, '0');
      const last = String(se.episodes[se.episodes.length - 1]).padStart(2, '0');
      lineas.push(`S${String(se.season).padStart(2, '0')}E${first}-E${last}`);
    } else {
      lineas.push(`S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')}`);
    }
  } else if (esPack) {
    lineas.push(`T${String(se.season).padStart(2, '0')} · Temporada completa (pack)`);
  } else {
    const anio = ultimoAnio(hit.name);
    if (anio) lineas.push(String(anio));
  }

  const etiquetaIdioma = idioma === 'Inglés' ? 'Inglés (VO)' : idioma;
  lineas.push(`🎞️ ${calidad}${fuente ? ` · ${fuente}` : ''} | 💾 ${size || '?'}`);
  lineas.push(`🌐 ${etiquetaIdioma} | 🌱 ${seeders} seeders${peers ? ` | 👥 ${peers}` : ''}`);
  lineas.push(`📄 ${hit.name}`);
  if (hit.tracker) lineas.push(`🔗 ${hit.tracker}`);

  const infoHash = extraerInfoHash(hash) || extraerInfoHash(magnet);
  if (!infoHash) return null;

  const stream = {
    name: `${nombreFuente}\n${calidad}`,
    title: lineas.join('\n'),
    infoHash,
    sources: construirSources(infoHash, magnet),
    behaviorHints: {
      bingeGroup: `${nombreFuente.toLowerCase().replace(/\s+/g, '-')}-${calidad.toLowerCase()}`,
      ...(hit.name ? { filename: hit.name } : {})
    },
    // Metadatos internos: lib/config.js los usa para filtrar/ordenar y los
    // elimina antes de enviar la respuesta a Stremio.
    _meta: {
      fuente: claveFuente,
      idioma,
      calidad,
      seeders,
      pack: esPack === true
    }
  };

  return stream;
}

module.exports = {
  TRACKERS,
  esReleaseVideo,
  base32ToHex,
  extraerInfoHash,
  extraerTrackersDeMagnet,
  construirSources,
  bytesAHumano,
  ultimoAnio,
  calidadDeNombre,
  fuenteDeNombre,
  idiomaDeNombre,
  contieneTitulo,
  construirMagnet,
  filtrarYOrdenar,
  formatearStream
};
