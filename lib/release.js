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

  const stream = {
    name: `${nombreFuente}\n${calidad}`,
    title: lineas.join('\n'),
    url: magnet,
    behaviorHints: {
      bingeGroup: `${nombreFuente.toLowerCase().replace(/\s+/g, '-')}-${calidad.toLowerCase()}`,
      filename: hit.name
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

  const infoHash = hash || (magnet.match(/btih:([a-fA-F0-9]{32,40})/i) || [])[1];
  if (infoHash) stream.infoHash = String(infoHash).toLowerCase();

  return stream;
}

module.exports = {
  TRACKERS,
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
