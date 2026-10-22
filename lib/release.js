/**
 * lib/release.js
 * ---------------------------------------------------------------------------
 * Reglas COMPARTIDAS para las fuentes externas (Knaben, The Black Hole Bay…).
 *
 * Todas las fuentes entregan sus resultados como "hits normalizados":
 *   {
 *     name:      nombre del release          ("Breaking.Bad.S02E05.1080p...")
 *     hash:      infoHash (hex, opcional)
 *     magnet:    magnet completo (opcional)
 *     seeders, peers,
 *     sizeLabel: "1.02 GiB"
 *     tracker:   "The Pirate Bay"
 *     fuente:    "Knaben" | "Black Hole Bay"
 *   }
 *
 * Aquí se aplican las mismas reglas que en HackTorrent para no volver a
 * entregar el torrent equivocado:
 *   - el título debe aparecer como FRASE en el nombre del release
 *   - películas: año del release ±1 y descartar nombres con SxxExx
 *   - series: SxxExx exacto; si no hay, sólo packs de ESA temporada
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
  'udp://tracker.openbittorrent.com:6969/announce'
];

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

/** Último año del nombre del release ("1917.2019" → 2019). */
function ultimoAnio(texto) {
  if (!texto) return null;
  const matches = String(texto).match(/\b(19|20)\d{2}\b/g);
  if (!matches || matches.length === 0) return null;
  return parseInt(matches[matches.length - 1], 10);
}

function calidadDeNombre(nombre) {
  const s = String(nombre || '');
  if (/\b(2160p|4k|uhd)\b/i.test(s)) return '4K';
  if (/\b1080p\b/i.test(s)) return '1080p';
  if (/\b720p\b/i.test(s)) return '720p';
  if (/\b(480p|576p|dvdrip|dvd)\b/i.test(s)) return '480p';
  if (/\b(hdtv|webrip|web|brrip|bluray|cam|ts)\b/i.test(s)) return 'SD';
  return 'Desconocida';
}

function fuenteDeNombre(nombre) {
  const s = String(nombre || '');
  if (/web-?dl/i.test(s)) return 'WEB-DL';
  if (/web-?rip/i.test(s)) return 'WEBRip';
  if (/remux/i.test(s)) return 'REMUX';
  if (/blu-?ray|bdrip|brrip/i.test(s)) return 'BluRay';
  if (/hdtv/i.test(s)) return 'HDTV';
  if (/dvdrip/i.test(s)) return 'DVDRip';
  return null;
}

function idiomaDeNombre(nombre) {
  const s = String(nombre || '');
  if (/latino/i.test(s)) return 'Latino';
  if (/castellano|espa[nñ]ol|spanish/i.test(s)) return 'Castellano';
  if (/dual/i.test(s)) return 'Dual';
  return 'Inglés';
}

/** Convierte un hash Base32 RFC 4648 (32 caracteres) a hex SHA-1 de 40 caracteres. */
function base32ToHex(b32) {
  const clean = String(b32 || '').trim().toUpperCase();
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

/**
 * ¿El título buscado aparece como frase dentro del nombre del torrent?
 * - 2+ palabras: la frase completa debe aparecer (evita que "Breaking Bad"
 *   empareje con "The Bad Guys Breaking In").
 * - 1 palabra: debe ser la primera palabra del release.
 */
function contieneTitulo(tituloBuscado, nombreTorrent) {
  if (!tituloBuscado || !nombreTorrent) return false;

  const objetivo = normalizeTitle(tituloBuscado);
  const nombre = normalizeTitle(nombreTorrent);
  if (!objetivo || !nombre) return false;

  if (objetivo.split(' ').length === 1) {
    return nombre === objetivo || nombre.startsWith(objetivo + ' ');
  }

  return (' ' + nombre + ' ').includes(' ' + objetivo + ' ');
}

/** Magnet a partir del infoHash (con trackers de respaldo). */
function construirMagnet(hash, dn, trackers = TRACKERS) {
  if (!hash) return null;
  if (!/^[a-fA-F0-9]{32,40}$/.test(String(hash))) return null;
  const params = [`xt=urn:btih:${hash}`];
  if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join('&')}`;
}

// ------------------- FILTRADO -------------------

/**
 * Filtra, ordena y limita hits normalizados.
 *
 * @param {Array} hits
 * @param {object} opciones
 * @param {string} opciones.title
 * @param {string} [opciones.originalTitle]
 * @param {string|number} [opciones.year]
 * @param {'movie'|'series'} [opciones.type]
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
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = 15,
    aceptarCategoria = () => true
  } = opciones;

  const esSerie = type === 'series';
  const anioObjetivo = parseYear(year);
  const conEpisodio = esSerie && Number.isFinite(season) && Number.isFinite(episode);

  const aceptados = [];
  const vistos = new Set();

  for (const hit of hits || []) {
    if (!hit || !hit.name) continue;

    const hash = String(hit.hash || '').toLowerCase();
    const clave = hash || hit.magnet;
    if (!clave || vistos.has(clave)) continue;

    if (!aceptarCategoria(hit)) continue;

    const magnet = hit.magnet && /^magnet:/i.test(hit.magnet)
      ? hit.magnet
      : construirMagnet(hit.hash, hit.name);
    if (!magnet) continue;

    if (!contieneTitulo(title, hit.name) &&
        !(originalTitle && contieneTitulo(originalTitle, hit.name))) {
      continue;
    }

    const se = parseSeasonEpisode(hit.name);

    if (esSerie) {
      if (conEpisodio) {
        const exacto = se.season === season && se.episode === episode;
        const packDeTemporada = se.season === season && se.episode === null && se.isPack;
        if (!exacto && !packDeTemporada) continue;
      }
    } else {
      const anioHit = ultimoAnio(hit.name);
      if (anioObjetivo && anioHit && Math.abs(anioHit - anioObjetivo) > 1) continue;
      if (se.season !== null && se.episode !== null) continue;
    }

    vistos.add(clave);
    aceptados.push({ hit, se, magnet, hash });
  }

  const seedersDe = (hit) => Number(hit.seeders ?? 0);
  aceptados.sort((a, b) => {
    const aExacto = conEpisodio && a.se.season === season && a.se.episode === episode ? 1 : 0;
    const bExacto = conEpisodio && b.se.season === season && b.se.episode === episode ? 1 : 0;
    if (aExacto !== bExacto) return bExacto - aExacto;
    return seedersDe(b.hit) - seedersDe(a.hit);
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
    lineas.push(`S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')}`);
  } else if (esPack) {
    lineas.push(`T${String(se.season).padStart(2, '0')} · Temporada completa (pack)`);
  } else {
    const anio = ultimoAnio(hit.name);
    if (anio) lineas.push(String(anio));
  }

  lineas.push(`🎞️ ${calidad}${fuente ? ` · ${fuente}` : ''} | 💾 ${size || '?'}`);
  lineas.push(`🌐 ${idioma} (VO) | 🌱 ${seeders} seeders${peers ? ` | 👥 ${peers}` : ''}`);
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
