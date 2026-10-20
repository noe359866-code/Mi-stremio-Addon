/**
 * lib/knaben.js
 * ---------------------------------------------------------------------------
 * Fuente secundaria en INGLÉS usando la API pública de Knaben (meta-indexer).
 *
 *   GET https://api.knaben.org/v2/search?q=...&sf=title&o=seeders&d=desc&s=60
 *
 * API v2 (la recomienda Knaben; v1 está limitada por ancho de banda):
 *   https://knaben.org/api/v2/
 *
 * Reglas para no repetir el problema del torrent equivocado:
 *   - Sólo se aceptan categorías de vídeo (Movies / TV / Anime).
 *   - El título pedido debe aparecer como FRASE dentro del nombre del torrent
 *     (los releases empiezan por el título; evita "The Bad Guys Breaking In"
 *     cuando se busca "Breaking Bad").
 *   - Películas: año del release dentro de ±1 del año real.
 *   - Series: SxxExx exacto; si no hay, sólo packs de ESA temporada.
 *   - Sin magnet ni hash → el resultado se descarta.
 *
 * Todo es tolerante a fallos: si Knaben no responde, el addon sigue funcionando
 * con HackTorrent (se devuelve []).
 * ---------------------------------------------------------------------------
 */

'use strict';

const axios = require('axios');
const {
  normalizeTitle,
  parseSeasonEpisode,
  parseYear
} = require('./match');

const KNABEN_API = String(process.env.KNABEN_API || 'https://api.knaben.org/v2').replace(/\/+$/, '');
const KNABEN_TIMEOUT = parseInt(process.env.KNABEN_TIMEOUT || '9000', 10);
const KNABEN_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.KNABEN_ENABLED ?? '1'));
const KNABEN_LIMIT = Math.max(1, Math.min(50, parseInt(process.env.KNABEN_LIMIT || '15', 10) || 15));
const PAGE_SIZE = Math.max(10, Math.min(150, parseInt(process.env.KNABEN_PAGE_SIZE || '60', 10) || 60));

// Caché: evita repetir la misma búsqueda por cada episodio que pide Stremio
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_TTL_EMPTY = 3 * 60 * 1000;
const CACHE_MAX = 300;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttl = CACHE_TTL) {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next();
    if (!oldest.done) CACHE.delete(oldest.value);
  }
  CACHE.set(key, { value, exp: Date.now() + ttl });
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

// ------------------- UTILIDADES -------------------

function bytesAHumano(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Último año que aparece en el nombre del release ("1917.2019" → 2019). */
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
  if (/blu-?ray|bdrip|brrip/i.test(s)) return 'BluRay';
  if (/hdtv/i.test(s)) return 'HDTV';
  if (/remux/i.test(s)) return 'REMUX';
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

/** Categorías de vídeo permitidas según el tipo pedido. */
function categoriaCompatible(categoria, tipo) {
  const c = String(categoria || '');
  if (!c) return false;
  // Nunca audio, libros, juegos, software ni adultos
  if (/xxx|adult|porn|audio|music|books?|comics?|games?|software|android|other/i.test(c)) return false;
  if (tipo === 'movie') return /^movies?\b/i.test(c);
  return /^(tv|anime)\b/i.test(c);
}

/**
 * ¿El título buscado aparece como frase dentro del nombre del torrent?
 * - Títulos de 2+ palabras: la frase completa debe aparecer (evita
 *   "The Bad Guys Breaking In" al buscar "Breaking Bad").
 * - Títulos de una palabra ("From", "Dune", "Akira"): debe ser la PRIMERA
 *   palabra del release (los releases empiezan por el título).
 *
 * Limitación conocida: con una sola palabra no se puede distinguir
 * "From S01E02" de "From Dusk Till Dawn S01E02" sin metadatos externos.
 * Para películas el filtro de año lo resuelve; en series es un caso raro.
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

function construirMagnet(hash, dn) {
  if (!hash) return null;
  if (!/^[a-fA-F0-9]{32,40}$/.test(String(hash))) return null;
  const params = [`xt=urn:btih:${hash}`];
  if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
  for (const tr of TRACKERS) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join('&')}`;
}

function formatearTituloStream(hit) {
  const calidad = calidadDeNombre(hit.title);
  const fuente = fuenteDeNombre(hit.title);
  const size = bytesAHumano(hit.bytes);
  const seeders = hit.liveSeeders ?? hit.seeders ?? 0;
  const peers = hit.livePeers ?? hit.peers ?? 0;
  const idioma = idiomaDeNombre(hit.title);
  const se = parseSeasonEpisode(hit.title);

  const lineas = [];
  if (se.season && se.episode) {
    lineas.push(`S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')}`);
  } else {
    const anio = ultimoAnio(hit.title);
    if (anio) lineas.push(String(anio));
  }
  lineas.push(`🎞️ ${calidad}${fuente ? ` · ${fuente}` : ''} | 💾 ${size || '?'}`);
  lineas.push(`🌐 ${idioma} (VO) | 🌱 ${seeders} seeders${peers ? ` | 👥 ${peers}` : ''}`);
  lineas.push(`📄 ${hit.title}`);
  if (hit.tracker) lineas.push(`🔗 ${hit.tracker}`);

  return {
    name: `Knaben\n${calidad}`,
    title: lineas.join('\n'),
    calidad
  };
}

// Knaben pide moderación (hay límite de peticiones): espaciado global + cooldown
const MIN_INTERVALO_MS = Math.max(0, parseInt(process.env.KNABEN_MIN_INTERVAL_MS || '400', 10) || 0);
let ultimaConsulta = 0;
let bloqueadoHasta = 0;

const dormir = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Consulta la API de Knaben (v2) con espaciado entre peticiones.
 * @returns {Promise<Array>} hits crudos
 */
async function consultarKnaben(query, size = PAGE_SIZE) {
  if (Date.now() < bloqueadoHasta) {
    throw Object.assign(new Error('Knaben en cooldown por rate limit'), { knabenCooldown: true });
  }

  const espera = MIN_INTERVALO_MS - (Date.now() - ultimaConsulta);
  if (espera > 0) await dormir(espera);
  ultimaConsulta = Date.now();

  const parametros = new URLSearchParams({
    q: query,
    sf: 'title',
    o: 'seeders',
    d: 'desc',
    s: String(size)
  });

  const url = `${KNABEN_API}/search?${parametros.toString()}`;
  let res;
  try {
    res = await axios.get(url, {
      timeout: KNABEN_TIMEOUT,
      headers: {
        'User-Agent': 'HackTorrent-Stremio-Addon/1.2 (+https://github.com/noe359866-code/Mi-stremio-Addon)',
        'Accept': 'application/json'
      },
      validateStatus: s => s >= 200 && s < 300
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || status === 503) {
      bloqueadoHasta = Date.now() + 60 * 1000;
      console.warn('[Knaben] ⚠️ Rate limit alcanzado, pausando 60s');
      err.knabenCooldown = true;
    }
    throw err;
  }

  const hits = res.data?.hits;
  return Array.isArray(hits) ? hits : [];
}

/**
 * Busca en Knaben y devuelve streams de Stremio (inglés).
 *
 * @param {object} opciones
 * @param {string} opciones.title       Título (preferiblemente original/inglés)
 * @param {string} [opciones.originalTitle]
 * @param {string|number} [opciones.year]
 * @param {'movie'|'series'} opciones.type
 * @param {number|null} [opciones.season]
 * @param {number|null} [opciones.episode]
 * @param {number} [opciones.limit]
 * @returns {Promise<Array>} streams
 */
async function buscarStreams(opciones = {}) {
  if (!KNABEN_ENABLED) return [];

  const {
    title,
    originalTitle = null,
    year = null,
    type = 'movie',
    season = null,
    episode = null,
    limit = KNABEN_LIMIT
  } = opciones;

  if (!title) return [];

  const esSerie = type === 'series';
  const anioObjetivo = parseYear(year);

  const cacheKey = [
    'knaben', normalizeTitle(title), normalizeTitle(originalTitle || ''),
    anioObjetivo || '', esSerie ? 'serie' : 'movie',
    season ?? '', episode ?? '', limit
  ].join('|');

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const conEpisodio = esSerie && Number.isFinite(season) && Number.isFinite(episode);
  const sufijoEp = conEpisodio
    ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : '';

  const hits = new Map();

  const agregarHits = (lista) => {
    for (const hit of lista) {
      if (!hit || !hit.title) continue;
      const clave = hit.hash || hit.magnetUrl || hit.id;
      if (!clave || hits.has(clave)) continue;
      hits.set(clave, hit);
    }
  };

  /**
   * Consulta Knaben para un título. Con episodio se consultan dos variantes:
   *   "Serie S02E05"  (episodio concreto)
   *   "Serie"         (packs de temporada)
   * Se corta en cuanto hay suficientes episodios exactos o si hay rate limit.
   */
  const recolectar = async (titulo) => {
    const consultas = [`${titulo}${sufijoEp}`];
    if (sufijoEp) consultas.push(titulo);

    for (const q of consultas) {
      try {
        agregarHits(await consultarKnaben(q));
      } catch (err) {
        console.error(`[Knaben] ❌ Error buscando "${q}":`, err.message);
        if (err.knabenCooldown) return; // no insistir
      }
      if (conEpisodio) {
        let exactos = 0;
        for (const hit of hits.values()) {
          const se = parseSeasonEpisode(hit.title);
          if (se.season === season && se.episode === episode) exactos++;
        }
        if (exactos >= Math.min(limit, 8)) return;
      }
    }
  };

  /** Aplica el filtrado estricto sobre lo recolectado. */
  const filtrar = () => {
    const aceptados = [];
    for (const hit of hits.values()) {
      if (!categoriaCompatible(hit.category, esSerie ? 'series' : 'movie')) continue;

      const magnet = hit.magnetUrl && /^magnet:/i.test(hit.magnetUrl)
        ? hit.magnetUrl
        : construirMagnet(hit.hash, hit.title);
      if (!magnet) continue;

      if (!contieneTitulo(title, hit.title) && !(originalTitle && contieneTitulo(originalTitle, hit.title))) {
        continue;
      }

      const se = parseSeasonEpisode(hit.title);

      if (esSerie) {
        if (conEpisodio) {
          const exacto = se.season === season && se.episode === episode;
          const packDeTemporada = se.season === season && se.episode === null && se.isPack;
          if (!exacto && !packDeTemporada) continue;
        }
      } else {
        // Películas: año del release (si se conoce) dentro de ±1
        const anioHit = ultimoAnio(hit.title);
        if (anioObjetivo && anioHit && Math.abs(anioHit - anioObjetivo) > 1) continue;
        // Un nombre con SxxExx no es una película
        if (se.season !== null && se.episode !== null) continue;
      }

      aceptados.push({ hit, se, magnet });
    }
    return aceptados;
  };

  // Ronda 1: título principal. Ronda 2 (sólo si no hubo nada válido): título original.
  await recolectar(title);
  let aceptados = filtrar();

  const tituloOriginalDistinto = originalTitle &&
    normalizeTitle(originalTitle) !== normalizeTitle(title);

  if (aceptados.length === 0 && tituloOriginalDistinto) {
    await recolectar(originalTitle);
    aceptados = filtrar();
  }

  // 3) Ordenar: episodio exacto > pack; luego seeders
  const seedersDe = (hit) => Number(hit.liveSeeders ?? hit.seeders ?? 0);
  aceptados.sort((a, b) => {
    const aExacto = conEpisodio && a.se.season === season && a.se.episode === episode ? 1 : 0;
    const bExacto = conEpisodio && b.se.season === season && b.se.episode === episode ? 1 : 0;
    if (aExacto !== bExacto) return bExacto - aExacto;
    return seedersDe(b.hit) - seedersDe(a.hit);
  });

  const seleccionados = aceptados.slice(0, limit);

  const streams = seleccionados.map(({ hit, se, magnet }) => {
    const { name, title: tituloStream } = formatearTituloStream(hit);
    const esPack = !se.episode && se.isPack;
    const lineas = tituloStream.split('\n');
    if (esPack) lineas.splice(1, 0, '📦 Temporada completa (pack)');

    const stream = {
      name,
      title: lineas.join('\n'),
      url: magnet,
      behaviorHints: {
        bingeGroup: `knaben-${calidadDeNombre(hit.title).toLowerCase()}`,
        filename: hit.title
      }
    };

    const infoHash = String(hit.hash || '').toLowerCase() || (magnet.match(/btih:([a-fA-F0-9]{32,40})/i) || [])[1];
    if (infoHash) stream.infoHash = infoHash.toLowerCase();
    return stream;
  });

  console.log(`[Knaben] ✅ ${streams.length}/${hits.size} resultados válidos para "${title}${sufijoEp}"`);
  cacheSet(cacheKey, streams, streams.length > 0 ? CACHE_TTL : CACHE_TTL_EMPTY);
  return streams;
}

module.exports = {
  KNABEN_ENABLED,
  KNABEN_API,
  buscarStreams,
  // helpers expuestos para tests
  _contieneTitulo: contieneTitulo,
  _categoriaCompatible: categoriaCompatible,
  _calidadDeNombre: calidadDeNombre,
  _ultimoAnio: ultimoAnio,
  _construirMagnet: construirMagnet,
  _bytesAHumano: bytesAHumano,
  _limpiarCache: () => CACHE.clear()
};
