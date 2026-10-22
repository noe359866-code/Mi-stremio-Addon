/**
 * HackTorrent Stremio Addon - Archivo Principal
 * Recursos: catalog + stream + meta
 * Scraper: lib/scraper.js (Axios + Cheerio)
 * Matching: lib/match.js (título + título original + año + tipo + temporada/episodio)
 */

'use strict';

const axios = require('axios');
const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest.json');

const Scraper = require('./lib/scraper');
const HT = require('./lib/hacktorrent');
const PelisPanda = require('./lib/pelispanda');
const SinSitio = require('./lib/sinsitio');
const Knaben = require('./lib/knaben');
const BlackHoleBay = require('./lib/theblackholebay');
const TorrentsCsv = require('./lib/torrentsCsv');
const { DEFAULTS, BEAMUP_HOST, BEAMUP_ORIGIN, normalizarConfig, aplicarConfig, fuentesActivas } = require('./lib/config');
const { timeout } = require('./lib/timeouts');
const {
  pickBestMatch,
  rankCandidates,
  similarity,
  torrentSeasonEpisode,
  normalizeTitle
} = require('./lib/match');

const builder = new addonBuilder(manifest);

// Caché simple para Cinemeta/Kitsu (evita repetir la misma consulta por episodio)
const META_CACHE = new Map();
function metaCacheGet(key) {
  const hit = META_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { META_CACHE.delete(key); return null; }
  return hit.value;
}
function metaCacheSet(key, value, ttl = 6 * 60 * 60 * 1000) {
  if (META_CACHE.size > 500) META_CACHE.clear();
  META_CACHE.set(key, { value, exp: Date.now() + ttl });
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Convierte un item de HackTorrent o PelisPanda (wpreact) a Stremio Meta Preview
 */
function toMetaPreview(item, stremioType, prefijo) {
  if (!item || !item.slug) return null;

  const idPrefix = prefijo || (item.fuente === 'pelispanda' ? 'pp' : item.fuente === 'sinsitio' ? 'ss' : 'ht');
  const tipoItem = item.tipo || item.type || null;
  let type = stremioType;
  if (!type) {
    type = tipoItem === 'pelicula' ? 'movie' : 'series';
  } else if (stremioType === 'series' && tipoItem === 'pelicula') {
    type = 'movie';
  }

  const slug = item.slug;
  let poster = item.poster || item.featured || item.image || null;
  if (poster && poster.startsWith('/')) poster = `https://image.tmdb.org/t/p/w500${poster}`;
  if (poster && /^https?:\/\/image\.tmdb\.org\/t\/p\/(w\d+|original)\/?$/i.test(poster)) poster = null;
  let background = item.background || item.background_image || item.backdrop || poster;
  if (background && background.startsWith('/')) background = `https://image.tmdb.org/t/p/original${background}`;
  if (background && /^https?:\/\/image\.tmdb\.org\/t\/p\/(w\d+|original)\/?$/i.test(background)) background = poster || null;

  const titulo = item.titulo || item.title || slug.replace(/-/g, ' ');
  const año = item.año || item.year || item.years || null;
  const añoStr = año ? String(año).slice(0, 4) : '';
  const descripcion = item.sinopsis || item.descripcion || item.overview || '';
  const rawGen = item.generos?.length ? item.generos : item.genres;
  const generos = Array.isArray(rawGen)
    ? rawGen.map(g => (typeof g === 'string' ? g.trim() : String(g?.name || '').trim())).filter(Boolean)
    : rawGen
      ? String(rawGen).split(',').map(g => g.trim()).filter(Boolean)
      : [];

  return {
    id: `${idPrefix}:${slug}`,
    type,
    name: titulo,
    poster: poster || undefined,
    posterShape: 'poster',
    background: background || undefined,
    logo: poster || undefined,
    description: descripcion || undefined,
    releaseInfo: añoStr || undefined,
    imdbRating: item.imdbRating || (item.imdb && item.imdb !== '0' ? item.imdb : null),
    genres: generos.length ? generos : undefined
  };
}

/**
 * Mapea un torrent (de extraerDetalleTorrent) a un stream de Stremio.
 * Incluye el nombre real del archivo para que el usuario pueda verificar
 * que el torrent corresponde a lo que pidió.
 */
function torrentToStream(torrent, tituloFallback, extra = {}) {
  const rawMagnet = torrent.magnet || torrent.torrentUrl;
  if (!rawMagnet) return null;
  const magnet = Scraper.normalizarMagnet(rawMagnet) || rawMagnet;

  const calidad = torrent.calidad || torrent.calidadNormalizada || 'Desconocido';
  const tamaño = torrent.tamaño || torrent.size || '';
  const idioma = torrent.idioma || torrent.language || 'Latino';
  const subs = torrent.subtitulos || (torrent.subs ? 'Sí' : 'No');

  let infoHash = torrent.infoHash || null;
  if (!infoHash && magnet.startsWith('magnet:')) {
    const m = magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32}|[a-fA-F0-9]{32})/i);
    if (m) {
      const raw = m[1];
      infoHash = (raw.length === 32 && /^[A-Z2-7]{32}$/i.test(raw) && !/^[0-9a-f]{32}$/i.test(raw))
        ? (Scraper.base32ToHex(raw) || raw.toLowerCase())
        : raw.toLowerCase();
    }
  }

  let dn = torrent.dn || null;
  if (!dn && magnet.startsWith('magnet:')) {
    const m = magnet.match(/[?&]dn=([^&]+)/);
    if (m) { try { dn = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { dn = m[1]; } }
  }

  const se = torrentSeasonEpisode(torrent);
  const season = extra.season ?? se.season;
  const episode = extra.episode ?? se.episode;
  const esPack = extra.esPack === true;

  const lineas = [];
  const displayName = (season !== null && season !== undefined && episode !== null && episode !== undefined)
    ? `${extra.titulo || tituloFallback} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : (extra.titulo || tituloFallback || 'HackTorrent');
  lineas.push(displayName);
  lineas.push(`🎞️ ${calidad} | 💾 ${tamaño || '?'} | 🗣️ ${idioma} | Subs: ${subs}`);
  if (esPack) lineas.push('📦 Temporada completa (pack)');
  if (dn) lineas.push(`📄 ${dn}`);
  if (torrent.fecha) lineas.push(`📅 ${torrent.fecha}`);

  const nombreFuente = `HackTorrent\n${calidad}`;

  const stream = {
    name: nombreFuente,
    title: lineas.join('\n'),
    url: magnet,
    behaviorHints: {
      bingeGroup: `hacktorrent-${String(calidad).replace(/\s+/g, '-').toLowerCase()}`,
      videoHash: infoHash ? `${infoHash}:${calidad}` : undefined,
      filename: dn || undefined
    },
    // Metadatos internos para lib/config.js (se eliminan antes de responder)
    _meta: {
      fuente: 'hacktorrent',
      idioma,
      calidad,
      seeders: 0,
      pack: esPack === true
    }
  };
  if (infoHash) stream.infoHash = infoHash;
  return stream;
}

/**
 * Une streams de varias fuentes sin duplicar el mismo torrent (mismo infoHash).
 * Los de HackTorrent van primero (suelen ser Latino); Knaben añade inglés.
 */
function fusionarStreams(propios = [], externos = []) {
  const vistos = new Set();
  const salida = [];
  for (const stream of [...propios, ...externos]) {
    if (!stream || !stream.url) continue;
    const hash = stream.infoHash || (stream.url.match(/btih:([a-fA-F0-9]{32,40})/i) || [])[1];
    const clave = hash ? hash.toLowerCase() : stream.url;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(stream);
  }
  return salida;
}

/**
 * Consulta todas las fuentes adicionales (PelisPanda en Latino + fuentes en inglés) EN PARALELO.
 * Cualquier fallo individual se ignora: HackTorrent sigue funcionando solo.
 *
 * @returns {Promise<Array>} streams ya fusionados y sin duplicados
 */
async function buscarEnFuentesExternas({ title, originalTitle, altTitles, tmdbId, year, type, season, episode, config }) {
  if (!title) return [];

  const cfg = normalizarConfig(config);
  const activas = fuentesActivas(cfg);
  const permitirHispanasPorDefecto = cfg.fuentes === DEFAULTS.fuentes;

  const fuentes = [
    { clave: 'pp', nombre: 'PelisPanda', fn: PelisPanda.buscarStreams, activa: activas.has('pp') || permitirHispanasPorDefecto },
    { clave: 'ss', nombre: 'SinSitio', fn: SinSitio.buscarStreams, activa: activas.has('ss') || permitirHispanasPorDefecto },
    { clave: 'knaben', nombre: 'Knaben', fn: Knaben.buscarStreams, activa: activas.has('knaben') },
    { clave: 'tbb', nombre: 'BlackHoleBay', fn: BlackHoleBay.buscarStreams, activa: activas.has('tbb') },
    { clave: 'tcsv', nombre: 'Torrents.csv', fn: TorrentsCsv.buscarStreams, activa: activas.has('tcsv') }
  ].filter(f => f.activa);

  if (fuentes.length === 0) return [];

  const resultados = await Promise.allSettled(
    fuentes.map(({ fn }) => fn({ title, originalTitle, altTitles, tmdbId, year, type, season, episode }))
  );

  const streams = [];
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (Array.isArray(r.value)) streams.push(...r.value);
    } else {
      console.warn(`[Stream] ${fuentes[i].nombre} falló:`, r.reason?.message || r.reason);
    }
  });

  return fusionarStreams([], streams);
}

/**
 * Parsea el id de Stremio:
 *   tt0111161 | tt0903747:5:14 | ht:slug | ht:slug:5:14 | pp:slug | pp:slug:5:14 | kitsu:1234:1:5
 */
function parseStremioId(id) {
  const partes = String(id).split(':');

  if (/^ht:/i.test(id)) {
    return {
      fuente: 'ht',
      slug: partes[1] || null,
      season: partes.length >= 4 ? parseInt(partes[2], 10) : null,
      episode: partes.length >= 4 ? parseInt(partes[3], 10) : null
    };
  }

  if (/^pp:/i.test(id)) {
    return {
      fuente: 'pp',
      slug: partes[1] || null,
      season: partes.length >= 4 ? parseInt(partes[2], 10) : null,
      episode: partes.length >= 4 ? parseInt(partes[3], 10) : null
    };
  }

  if (/^ss:/i.test(id)) {
    return {
      fuente: 'ss',
      slug: partes[1] || null,
      season: partes.length >= 4 ? parseInt(partes[2], 10) : null,
      episode: partes.length >= 4 ? parseInt(partes[3], 10) : null
    };
  }

  if (/^kitsu:/i.test(id)) {
    // Formatos habituales: kitsu:ID  |  kitsu:ID:EP  |  kitsu:ID:TEMP:EP
    if (partes.length >= 4) {
      return { fuente: 'kitsu', kitsuId: partes[1] || null, season: parseInt(partes[2], 10) || 1, episode: parseInt(partes[3], 10) || null };
    }
    if (partes.length === 3) {
      return { fuente: 'kitsu', kitsuId: partes[1] || null, season: 1, episode: parseInt(partes[2], 10) || null };
    }
    return { fuente: 'kitsu', kitsuId: partes[1] || null, season: null, episode: null };
  }

  if (/^tt\d+$/i.test(partes[0])) {
    return {
      fuente: 'imdb',
      imdbId: partes[0],
      season: partes.length >= 3 ? parseInt(partes[1], 10) : null,
      episode: partes.length >= 3 ? parseInt(partes[2], 10) : null
    };
  }

  // Id desconocido: intentamos usarlo como slug directo
  return { fuente: 'slug', slug: String(id).replace(/^[a-z]+:/i, ''), season: null, episode: null };
}

/** Resuelve título/año/TMDB ID del contenido desde Cinemeta (tt) o Kitsu (kitsu). */
async function resolverInfo(type, req) {
  if (req.fuente === 'imdb') {
    const key = `cinemeta:${type}:${req.imdbId}`;
    const cached = metaCacheGet(key);
    if (cached) return cached;

    let meta = null;
    try {
      meta = await HT.getCinemeta(type, req.imdbId);
    } catch (e) {
      console.warn(`[Stream] Cinemeta falló para ${req.imdbId}:`, e.message);
    }
    if (meta) {
      const info = {
        title: meta.name || null,
        originalTitle: meta.originalTitle || meta.original_name || null,
        year: meta.releaseInfo || meta.year || null,
        tmdbId: meta.moviedb_id ? String(meta.moviedb_id) : (meta.tmdb_id ? String(meta.tmdb_id) : null),
        altTitles: []
      };
      if (info.title) metaCacheSet(key, info);
      return info;
    }
    // Si Cinemeta falla, NO devolver el literal "tt0848228" como título (evita buscar IDs en texto)
    return { title: null, originalTitle: null, year: null, tmdbId: null, altTitles: [] };
  }

  if (req.fuente === 'kitsu') {
    const key = `kitsu:${req.kitsuId}`;
    const cached = metaCacheGet(key);
    if (cached) return cached;
    try {
      const res = await axios.get(`https://kitsu.io/api/edge/anime/${encodeURIComponent(req.kitsuId)}`, {
        timeout: timeout(10000),
        headers: { Accept: 'application/vnd.api+json' }
      });
      const a = res.data?.data?.attributes || {};
      const altTitles = [a.titles?.en, a.titles?.en_jp, a.titles?.ja_jp, ...(Array.isArray(a.abbreviatedTitles) ? a.abbreviatedTitles : [])].filter(Boolean);
      const info = {
        title: a.canonicalTitle || a.titles?.en || a.titles?.en_jp || null,
        originalTitle: a.titles?.en_jp || a.titles?.ja_jp || null,
        year: a.startDate ? String(a.startDate).slice(0, 4) : null,
        tmdbId: null,
        altTitles,
        tipoForzado: 'anime'
      };
      if (info.title) metaCacheSet(key, info);
      return info;
    } catch (e) {
      console.warn(`[Stream] Kitsu falló para ${req.kitsuId}:`, e.message);
      return { title: null, originalTitle: null, year: null, tmdbId: null, altTitles: [], tipoForzado: 'anime' };
    }
  }

  return { title: null, originalTitle: null, year: null, tmdbId: null, altTitles: [] };
}

/** Genera variantes de búsqueda razonables para un título. */
function variantesDeBusqueda(info) {
  const out = [];
  const push = (q) => {
    const v = String(q || '').trim();
    if (v.length < 2) return;
    if (/^(tt\d+|kitsu:\d+)$/i.test(v)) return;
    if (!out.some(x => normalizeTitle(x) === normalizeTitle(v))) out.push(v);
  };

  push(info.title);
  push(info.originalTitle);
  if (Array.isArray(info.altTitles)) {
    for (const alt of info.altTitles) push(alt);
  }
  if (info.title) {
    // "Avengers: Infinity War" -> "Avengers Infinity War"
    push(String(info.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' '));
    // Sin año pegado al título
    push(String(info.title).replace(/\s*\((19|20)\d{2}\)\s*$/, ''));
    // Parte principal antes de ":" (títulos con subtítulo largo)
    const antesDeDosPuntos = String(info.title).split(':')[0].trim();
    if (antesDeDosPuntos.split(' ').length >= 2) push(antesDeDosPuntos);
  }

  return out.slice(0, 4);
}

/**
 * Busca en HackTorrent juntando resultados de varias variantes del título
 * (y resolución por TMDB ID cuando Cinemeta devuelve título en inglés) y los
 * ordena por similitud real (título/título original + TMDB ID + año + tipo).
 */
async function buscarCandidatos(info, tipoObjetivo) {
  const variantes = variantesDeBusqueda(info);
  const todos = new Map();
  const altTitles = Array.isArray(info.altTitles) ? [...info.altTitles] : [];

  for (const q of variantes) {
    try {
      const resultados = await Scraper.buscarEnHackTorrent(q, null);
      for (const r of resultados || []) {
        if (!r || !r.slug) continue;
        if (!todos.has(r.slug)) todos.set(r.slug, r);
      }
    } catch (e) {
      console.warn(`[Stream] Búsqueda "${q}" falló:`, e.message);
    }
    if (todos.size >= 8) break;
  }

  let lista = Array.from(todos.values());
  let ranked = lista.length > 0
    ? rankCandidates(lista, {
      title: info.title,
      originalTitle: info.originalTitle,
      altTitles,
      tmdbId: info.tmdbId,
      year: info.year,
      type: tipoObjetivo
    })
    : [];

  // Si tenemos tmdbId (de Cinemeta) y la búsqueda por título en inglés no dio
  // coincidencia fuerte (p.ej. "The Wolf of Wall Street" -> "El lobo de Wall Street"),
  // resolvemos el título exacto en español en HackTorrent usando /?tmdb={id}.
  const mejorScoreInicial = ranked[0]?.score || 0;
  if (info.tmdbId && mejorScoreInicial < 0.78 && typeof Scraper.buscarPorTmdb === 'function') {
    try {
      const porTmdb = await Scraper.buscarPorTmdb(info.tmdbId);
      for (const r of porTmdb || []) {
        if (!r || !r.slug) continue;
        const t = r.titulo || r.title;
        if (t && !altTitles.includes(t)) altTitles.push(t);
        if (!todos.has(r.slug)) todos.set(r.slug, r);
      }
      if (porTmdb && porTmdb.length > 0) {
        info.altTitles = altTitles;
        lista = Array.from(todos.values());
        ranked = rankCandidates(lista, {
          title: info.title,
          originalTitle: info.originalTitle,
          altTitles,
          tmdbId: info.tmdbId,
          year: info.year,
          type: tipoObjetivo
        });
      }
    } catch (e) {
      console.warn(`[Stream] Búsqueda TMDB ${info.tmdbId} falló:`, e.message);
    }
  }

  if (lista.length === 0) return { ranked: [], variantes, lista: [] };

  return { ranked, variantes, lista };
}

/** Devuelve true si el detalle corresponde al candidato (evita redirects raros). */
function detalleCoherente(detalle, candidato, info) {
  if (detalle?.tmdbId && info?.tmdbId && String(detalle.tmdbId) === String(info.tmdbId)) {
    return true;
  }
  const tituloDetalle = detalle?.titulo || '';
  const origDetalle = detalle?.tituloOriginal || '';
  if (!tituloDetalle && !origDetalle) return true;

  const refs = [
    candidato?.titulo || candidato?.title || '',
    candidato?.tituloOriginal || candidato?.originalTitle || '',
    info?.title || '',
    info?.originalTitle || '',
    ...(Array.isArray(info?.altTitles) ? info.altTitles : [])
  ].filter(Boolean);

  let mejor = 0;
  for (const ref of refs) {
    if (tituloDetalle) mejor = Math.max(mejor, similarity(tituloDetalle, ref));
    if (origDetalle) mejor = Math.max(mejor, similarity(origDetalle, ref));
  }

  // Coincidencia muy baja y el título del detalle tampoco se parece al slug
  if (mejor < 0.35 && similarity(tituloDetalle, String(candidato.slug || '').replace(/-/g, ' ')) < 0.5) {
    console.warn(`[Stream] ⚠️ Detalle incoherente: "${tituloDetalle}" vs "${candidato.titulo}" (score ${mejor.toFixed(2)})`);
    return false;
  }
  return true;
}

/**
 * Filtra torrents por temporada/episodio.
 * - Si hay coincidencias exactas → SOLO esas (nunca otro episodio).
 * - Si no hay exactas pero sí packs de la temporada pedida → packs (marcados).
 * - Si no hay nada → arrays vacíos (el llamador probará otro candidato).
 */
function filtrarPorEpisodio(torrents, season, episode) {
  const exactos = [];
  const packs = [];

  for (const t of torrents) {
    const se = torrentSeasonEpisode(t);
    if (se.season === season && se.episode === episode) {
      exactos.push(t);
    } else if (se.season === season && (se.episode === null || se.episode === undefined) && se.isPack) {
      packs.push(t);
    }
  }

  return { exactos, packs };
}

// ---------------------------------------------------------------------------
// 1) CATÁLOGOS
// ---------------------------------------------------------------------------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    console.log(`[Catalog] type=${type} id=${id} extra=${JSON.stringify(extra)}`);

    const busqueda = extra?.search ? String(extra.search).trim() : null;
    const genero = extra?.genre && extra.genre !== 'Todos' ? String(extra.genre).trim() : null;
    const skip = extra?.skip ? parseInt(extra.skip, 10) : 0;
    const PAGE_SIZE = 12;
    const page = Math.floor(skip / PAGE_SIZE) + 1;

    const esCatalogoPelisPanda = /^pelispanda/i.test(id || '') || /-hd$/i.test(id || '');
    const esCatalogoSinSitio = /^sinsitio/i.test(id || '') || /-esp$/i.test(id || '');
    const prefijoCatalogo = esCatalogoPelisPanda ? 'pp' : esCatalogoSinSitio ? 'ss' : 'ht';

    // --- A) BÚSQUEDA ---
    if (busqueda) {
      try {
        const resultados = esCatalogoPelisPanda
          ? await PelisPanda.buscarEnPelisPanda(busqueda, null)
          : esCatalogoSinSitio
            ? await SinSitio.buscarEnSinSitio(busqueda, type === 'movie' ? 'pelicula' : 'serie')
            : await Scraper.buscarEnHackTorrent(busqueda, null);
        if (!resultados || resultados.length === 0) {
          console.log(`[Catalog] Búsqueda "${busqueda}" (${prefijoCatalogo}) sin resultados`);
          return { metas: [] };
        }

        let filtrados = resultados;
        if (type === 'movie') filtrados = resultados.filter(r => r.tipo === 'pelicula');
        if (type === 'series') filtrados = resultados.filter(r => r.tipo === 'serie' || r.tipo === 'anime');

        // Ordenar por relevancia de la búsqueda (los mejores primero)
        const ranked = rankCandidates(filtrados, { title: busqueda, type });
        const ordenados = ranked.length > 0 ? ranked.map(r => r.cand) : filtrados;

        const metas = ordenados.slice(0, 50).map(item => toMetaPreview(item, type, prefijoCatalogo)).filter(Boolean);
        console.log(`[Catalog] Búsqueda "${busqueda}" (${prefijoCatalogo}) -> ${metas.length} metas`);
        return { metas };
      } catch (err) {
        console.error(`[Catalog] Error en búsqueda "${busqueda}":`, err.message);
        return { metas: [] };
      }
    }

    // --- B) CATÁLOGO SIN BÚSQUEDA ---
    try {
      if (esCatalogoSinSitio) {
        const tipoCat = (type === 'series' || id === 'sinsitio-series' || id === 'univertorrent-series-esp') ? 'series' : 'peliculas';
        const items = await SinSitio.obtenerCatalogo(tipoCat, page, genero);
        if (!items || items.length === 0) return { metas: [] };
        const stremioType = type === 'movie' ? 'movie' : 'series';
        const metas = items
          .map(item => toMetaPreview(item, stremioType, 'ss'))
          .filter(Boolean);
        const start = metas.length > 0 ? (skip % PAGE_SIZE) : 0;
        return { metas: start < metas.length ? metas.slice(start) : metas };
      }

      if (esCatalogoPelisPanda) {
        let tipoCat = 'peliculas';
        if (id === 'pelispanda-estrenos' || id === 'univertorrent-estrenos-hd') tipoCat = 'estrenos';
        else if (id === 'pelispanda-series' || id === 'univertorrent-series-hd') tipoCat = 'series';
        else if (id === 'pelispanda-anime' || id === 'pelispanda-animes' || id === 'univertorrent-anime-hd' || id === 'univertorrent-animes-hd') tipoCat = 'animes';

        const items = await PelisPanda.obtenerCatalogo(tipoCat, page, genero);
        if (!items || items.length === 0) return { metas: [] };
        const stremioType = type === 'movie' ? 'movie' : 'series';
        const metas = items
          .map(item => toMetaPreview(tipoCat === 'animes' ? { ...item, tipo: 'anime' } : item, stremioType, 'pp'))
          .filter(Boolean);
        const start = metas.length > 0 ? (skip % PAGE_SIZE) : 0;
        return { metas: start < metas.length ? metas.slice(start) : metas };
      }

      const esEstrenosPrincipal = id === 'hacktorrent-estrenos' || id === 'univertorrent-estrenos';
      const esPeliculasPrincipal = id === 'hacktorrent-peliculas' || id === 'univertorrent-peliculas' || esEstrenosPrincipal;

      if (type === 'movie' && esPeliculasPrincipal) {
        let peliculas = [];
        if (esEstrenosPrincipal || genero) {
          const tipoCat = esEstrenosPrincipal ? 'estrenos' : 'peliculas';
          peliculas = await Scraper.obtenerCatalogo(tipoCat, page, genero);
        } else {
          peliculas = await HT.getCatalogMovies(page);
          if (!peliculas || peliculas.length === 0) {
            peliculas = await Scraper.obtenerCatalogo('peliculas', page, null);
          }
        }
        if (!peliculas || peliculas.length === 0) return { metas: [] };
        const metas = peliculas.map(p => toMetaPreview(p, 'movie')).filter(Boolean);
        const start = metas.length > 0 ? (skip % PAGE_SIZE) : 0;
        return { metas: start < metas.length ? metas.slice(start) : metas };
      }

      if (type === 'series' && (id === 'hacktorrent-series' || id === 'univertorrent-series')) {
        let series = [];
        if (genero) {
          series = await Scraper.obtenerCatalogo('series', page, genero);
        } else {
          series = await HT.getCatalogSeries(page);
          if (!series || series.length === 0) {
            series = await Scraper.obtenerCatalogo('series', page, null);
          }
        }
        if (!series || series.length === 0) return { metas: [] };
        const metas = series.map(s => toMetaPreview(s, 'series')).filter(Boolean);
        const start = metas.length > 0 ? (skip % PAGE_SIZE) : 0;
        return { metas: start < metas.length ? metas.slice(start) : metas };
      }

      if (type === 'series' && (id === 'hacktorrent-anime' || id === 'hacktorrent-animes' || id === 'univertorrent-anime' || id === 'univertorrent-animes')) {
        let anime = [];
        if (genero) {
          anime = await Scraper.obtenerCatalogo('animes', page, genero);
        } else {
          anime = await HT.getCatalogAnime(page);
          if (!anime || anime.length === 0) {
            anime = await Scraper.obtenerCatalogo('animes', page, null);
          }
        }
        if (!anime || anime.length === 0) return { metas: [] };
        const metas = anime.map(a => toMetaPreview({ ...a, tipo: 'anime' }, 'series')).filter(Boolean);
        const start = metas.length > 0 ? (skip % PAGE_SIZE) : 0;
        return { metas: start < metas.length ? metas.slice(start) : metas };
      }
    } catch (err) {
      console.error(`[Catalog] Error cargando novedades type=${type} id=${id}:`, err.message);
      return { metas: [] };
    }

    return { metas: [] };
  } catch (err) {
    console.error('[Catalog] Error global:', err.message);
    return { metas: [] };
  }
});

/** Asegura que los torrents seleccionados tengan magnet resuelto si traían acortalink. */
async function asegurarMagnets(torrents) {
  if (!Array.isArray(torrents) || torrents.length === 0) return [];
  const necesitaResolucion = torrents.some(t => !t.magnet && !t.torrentUrl && (t.acortalink || t.acortarUrl));
  if (!necesitaResolucion || typeof Scraper.resolverMagnetsEnLote !== 'function') {
    return torrents;
  }
  const normalizados = torrents.map(t => (t.acortalink ? t : { ...t, acortalink: t.acortarUrl }));
  return Scraper.resolverMagnetsEnLote(normalizados);
}

// ---------------------------------------------------------------------------
// 2) STREAMS
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id, config }) => {
  try {
    const cfg = normalizarConfig(config);
    const activas = fuentesActivas(cfg);
    const usarHackTorrent = activas.has('ht');

    console.log(`[Stream] Solicitado type=${type} id=${id} cfg=${JSON.stringify(cfg)}`);
    if (!id) return { streams: [] };

    // Envuelve cualquier respuesta aplicando la configuración del usuario
    const responder = (streams) => ({ streams: aplicarConfig(streams || [], cfg) });

    const req = parseStremioId(id);
    const esSerie = type === 'series';

    // Año, título y episodio objetivo
    let info = { title: null, originalTitle: null, year: null, tmdbId: null, altTitles: [] };
    let season = Number.isFinite(req.season) ? req.season : null;
    let episode = Number.isFinite(req.episode) ? req.episode : null;

    // --- CASO A: id propio ht:slug → el slug ya identifica el contenido ---
    if (req.fuente === 'ht' && req.slug) {
      const tipoPreferido = esSerie ? 'serie' : 'pelicula';
      const detalle = usarHackTorrent
        ? await Scraper.extraerDetalleTorrent(req.slug, tipoPreferido)
        : null;

      const externasHt = buscarEnFuentesExternas({
        title: detalle?.titulo || req.slug.replace(/-/g, ' '),
        originalTitle: detalle?.tituloOriginal || null,
        year: detalle?.año || null,
        type: esSerie ? 'series' : 'movie',
        season,
        episode,
        config: cfg
      });

      if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) {
        console.log(`[Stream] Sin torrents para ht:${req.slug} (se usan las fuentes externas)`);
        return responder(await externasHt);
      }

      detalle.torrents = await asegurarMagnets(detalle.torrents);
      const propios = streamsDeDetalle(detalle, { titulo: detalle.titulo, season, episode, esSerie }).streams || [];
      return responder(fusionarStreams(propios, await externasHt));
    }

    // --- CASO A.2: id propio pp:slug (PelisPanda) ---
    if (req.fuente === 'pp' && req.slug) {
      const usarPelisPanda = activas.has('pp') || cfg.fuentes === DEFAULTS.fuentes;
      const tipoPreferido = esSerie ? 'serie' : 'pelicula';
      const detalle = usarPelisPanda
        ? await PelisPanda.extraerDetalleTorrent(req.slug, tipoPreferido)
        : null;

      if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) {
        console.log(`[Stream] Sin torrents para pp:${req.slug}`);
        return responder([]);
      }

      if (esSerie && season !== null && episode !== null) {
        const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
        const elegidos = exactos.length > 0 ? exactos : packs;
        const esPack = exactos.length === 0 && packs.length > 0;
        const resueltos = await PelisPanda.resolverMagnetsEnLote(elegidos);
        const propios = resueltos
          .map(t => PelisPanda.torrentToStream(t, detalle.titulo, {
            titulo: detalle.titulo,
            season,
            episode: esPack ? null : episode,
            esPack
          }))
          .filter(Boolean);
        return responder(propios);
      }

      const filtrados = !esSerie
        ? detalle.torrents.filter(t => {
          const se = torrentSeasonEpisode(t);
          return se.season === null && se.episode === null;
        })
        : detalle.torrents;
      const resueltos = await PelisPanda.resolverMagnetsEnLote(filtrados);
      const propios = resueltos
        .map(t => PelisPanda.torrentToStream(t, detalle.titulo, {
          titulo: detalle.titulo,
          season: null,
          episode: null
        }))
        .filter(Boolean);
      return responder(propios);
    }

    // --- CASO A.3: id propio ss:slug (SinSitio) ---
    if (req.fuente === 'ss' && req.slug) {
      const usarSinSitio = activas.has('ss') || cfg.fuentes === DEFAULTS.fuentes;
      const tipoPreferido = esSerie ? 'serie' : 'pelicula';
      const detalle = usarSinSitio
        ? await SinSitio.extraerDetalleTorrent(req.slug, tipoPreferido)
        : null;

      if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) {
        console.log(`[Stream] Sin torrents para ss:${req.slug}`);
        return responder([]);
      }

      if (esSerie && season !== null && episode !== null) {
        const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
        const elegidos = exactos.length > 0 ? exactos : packs;
        const esPack = exactos.length === 0 && packs.length > 0;
        const resueltos = await SinSitio.resolverMagnetsEnLote(elegidos, { season, episode });
        const propios = resueltos
          .map(t => SinSitio.torrentToStream(t, detalle.titulo, {
            titulo: detalle.titulo,
            season,
            episode: esPack ? null : episode,
            esPack
          }))
          .filter(Boolean);
        return responder(propios);
      }

      const filtrados = !esSerie
        ? detalle.torrents.filter(t => {
          const se = torrentSeasonEpisode(t);
          return se.season === null && se.episode === null;
        })
        : detalle.torrents;
      const resueltos = await SinSitio.resolverMagnetsEnLote(filtrados.length > 0 ? filtrados : detalle.torrents);
      const propios = resueltos
        .map(t => SinSitio.torrentToStream(t, detalle.titulo, {
          titulo: detalle.titulo,
          season: null,
          episode: null
        }))
        .filter(Boolean);
      return responder(propios);
    }

    // --- CASO B: tt (Cinemeta) / kitsu / slug suelto ---
    if (req.fuente !== 'slug') {
      info = await resolverInfo(type, req);
    } else {
      info = { title: decodeURIComponent(req.slug || '').replace(/-/g, ' '), originalTitle: null, year: null, tmdbId: null, altTitles: [] };
    }

    if (!info || !info.title) {
      console.log(`[Stream] No se pudo resolver el título de ${id}`);
      return { streams: [] };
    }

    const tipoObjetivo = esSerie ? 'series' : 'movie';
    console.log(`[Stream] Objetivo: "${info.title}"${info.originalTitle ? ` / "${info.originalTitle}"` : ''} (${info.year || '?'}) → ${tipoObjetivo}`);

    // Fuentes adicionales (PelisPanda en Latino + fuentes en inglés) en paralelo
    const externasPromise = buscarEnFuentesExternas({
      title: info.title,
      originalTitle: info.originalTitle,
      altTitles: info.altTitles,
      tmdbId: info.tmdbId,
      year: info.year,
      type: tipoObjetivo,
      season,
      episode,
      config: cfg
    });
    const responderConExternas = async (streams) => responder(fusionarStreams(streams, await externasPromise));

    // Buscar candidatos y ordenarlos por relevancia (si HackTorrent está activo)
    let ranked = [];
    let lista = [];
    if (usarHackTorrent) {
      ({ ranked, lista } = await buscarCandidatos(info, tipoObjetivo));
    } else {
      console.log('[Stream] HackTorrent desactivado en la configuración; sólo fuentes externas');
    }
    let soloPeliculaAnime = false;

    if (ranked.length === 0 && info.title) {
      // Segundo intento con título limpio y sin subtítulo
      const limpio = String(info.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (normalizeTitle(limpio) !== normalizeTitle(info.title)) {
        console.log(`[Stream] Reintentando búsqueda limpia: "${limpio}"`);
        const segundo = await buscarCandidatos({ ...info, title: limpio }, tipoObjetivo);
        ranked = segundo.ranked;
        if (segundo.lista.length > 0) lista = segundo.lista;
      }
    }

    // Anime: muchas películas de anime están catalogadas como "anime" en el sitio.
    // Se permiten SÓLO si el detalle resulta ser una película (sin episodios).
    if (ranked.length === 0 && !esSerie && lista.length > 0) {
      const animeRanked = rankCandidates(lista, {
        title: info.title,
        originalTitle: info.originalTitle,
        altTitles: info.altTitles,
        tmdbId: info.tmdbId,
        year: info.year,
        type: 'series'
      }).filter(r => String(r.cand.tipo || '').toLowerCase() === 'anime');

      if (animeRanked.length > 0) {
        console.log('[Stream] Sin película directa: probando anime como película');
        ranked = animeRanked;
        soloPeliculaAnime = true;
      }
    }

    if (ranked.length === 0) {
      console.log(`[Stream] Sin candidatos en HackTorrent para "${info.title}" (${id}); se usan las fuentes externas`);
      return responderConExternas([]);
    }

    // Sólo candidatos con puntuación suficiente (arriba del umbral del matcher)
    const MIN_SCORE = 0.6;
    let mejores;

    if (soloPeliculaAnime) {
      // Ya vienen filtrados como anime; el matcher estricto los descartaría por tipo
      mejores = ranked.filter(r => r.score >= MIN_SCORE);
      if (mejores.length === 0) mejores = ranked.slice(0, 1);
    } else {
      const elegidos = pickBestMatch(ranked.map(r => r.cand), {
        title: info.title,
        originalTitle: info.originalTitle,
        altTitles: info.altTitles,
        tmdbId: info.tmdbId,
        year: info.year,
        type: tipoObjetivo
      });
      mejores = elegidos.ranked.filter(r => r.score >= MIN_SCORE);
      if (mejores.length === 0 && elegidos.best && elegidos.match) mejores = [elegidos.match];
    }
    console.log(`[Stream] Candidatos: ${mejores.slice(0, 5).map(r =>
      `${r.cand.titulo || r.cand.title} [${r.cand.tipo || r.cand.type}] ${r.score.toFixed(2)}`
    ).join(' | ')}`);

    // Probar los mejores candidatos en orden; si uno no tiene el episodio
    // pedido o su detalle es incoherente, pasamos al siguiente. NUNCA se
    // devuelve contenido de otro título/episodio.
    const maxCandidatos = Math.min(mejores.length, 5);
    for (let i = 0; i < maxCandidatos; i++) {
      const { cand, score } = mejores[i];
      if (!cand.slug) continue;
      if (score < 0.4) continue;

      const tipoContenido = cand.tipo === 'pelicula' ? 'pelicula'
        : cand.tipo === 'anime' ? 'anime'
        : cand.tipo === 'serie' ? 'serie'
        : (esSerie ? 'serie' : 'pelicula');

      let detalle;
      try {
        detalle = await Scraper.extraerDetalleTorrent(cand.slug, tipoContenido);
      } catch (e) {
        console.error(`[Stream] Error detalle ${cand.slug}:`, e.message);
        continue;
      }

      if (!detalle || !Array.isArray(detalle.torrents) || detalle.torrents.length === 0) {
        console.log(`[Stream] ${cand.slug} sin torrents, siguiente candidato`);
        continue;
      }
      if (!detalleCoherente(detalle, cand, info)) continue;

      // Fichero de anime catalogado como película: si tiene episodios es una
      // serie y no debe entregarse para una película.
      if (soloPeliculaAnime && detalle.torrents.some(t => torrentSeasonEpisode(t).episode !== null)) {
        console.log(`[Stream] ${cand.slug} es una serie de anime, no una película → descartado`);
        continue;
      }

      if (esSerie && season !== null && episode !== null) {
        const { exactos, packs } = filtrarPorEpisodio(detalle.torrents, season, episode);
        if (exactos.length === 0 && packs.length === 0) {
          console.log(`[Stream] ${cand.slug} no tiene S${season}E${episode}, siguiente candidato`);
          continue;
        }
        if (exactos.length === 0) {
          console.log(`[Stream] ${cand.slug}: sin episodio exacto, usando ${packs.length} pack(s) de T${season}`);
          const resueltosPacks = await asegurarMagnets(packs);
          return responderConExternas(
            resueltosPacks
              .map(t => torrentToStream(t, detalle.titulo, { titulo: detalle.titulo, season, episode: null, esPack: true }))
              .filter(Boolean)
          );
        }
        console.log(`[Stream] ${cand.slug} → ${exactos.length} torrent(s) para S${season}E${episode}`);
        const resueltosExactos = await asegurarMagnets(exactos);
        return responderConExternas(
          resueltosExactos
            .map(t => torrentToStream(t, detalle.titulo, { titulo: detalle.titulo, season, episode }))
            .filter(Boolean)
        );
      }

      console.log(`[Stream] ${cand.slug} → ${detalle.torrents.length} torrent(s)`);
      detalle.torrents = await asegurarMagnets(detalle.torrents);
      return responderConExternas(streamsDeDetalle(detalle, { titulo: detalle.titulo, season, episode, esSerie }).streams || []);
    }

    console.log(`[Stream] Ningún candidato válido para "${info.title}" (${id}); se usan las fuentes externas`);
    return responderConExternas([]);
  } catch (err) {
    console.error('[Stream] Error global:', err.message, err.stack?.split('\n')[1] || '');
    return { streams: [] };
  }
});

/** Construye streams desde un detalle, respetando temporada/episodio si es serie. */
function streamsDeDetalle(detalle, { titulo, season, episode, esSerie }) {
  const torrents = Array.isArray(detalle.torrents) ? detalle.torrents : [];

  if (esSerie && season !== null && episode !== null) {
    const { exactos, packs } = filtrarPorEpisodio(torrents, season, episode);
    if (exactos.length > 0) {
      return {
        streams: exactos
          .map(t => torrentToStream(t, titulo, { titulo, season, episode }))
          .filter(Boolean)
      };
    }
    if (packs.length > 0) {
      console.log(`[Stream] Sin S${season}E${episode} exacto: ${packs.length} pack(s) de T${season}`);
      return {
        streams: packs
          .map(t => torrentToStream(t, titulo, { titulo, season, episode: null, esPack: true }))
          .filter(Boolean)
      };
    }
    console.log(`[Stream] ${titulo}: no hay torrents para S${season}E${episode} (no se devuelve otro episodio)`);
    return { streams: [] };
  }

  const filtrados = !esSerie
    ? torrents.filter(t => {
      const se = torrentSeasonEpisode(t);
      return se.season === null && se.episode === null;
    })
    : torrents;

  return {
    streams: filtrados
      .map(t => torrentToStream(t, titulo, { titulo, season: null, episode: null }))
      .filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// 3) META
// ---------------------------------------------------------------------------
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const esHt = id.startsWith('ht:');
    const esPp = id.startsWith('pp:');
    const esSs = id.startsWith('ss:');
    if (!esHt && !esPp && !esSs) return { meta: null };
    const prefijo = esPp ? 'pp' : esSs ? 'ss' : 'ht';
    const partes = id.split(':');
    const slug = partes[1];
    if (!slug) return { meta: null };

    let detalle = null;
    try {
      detalle = esPp
        ? await PelisPanda.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie')
        : esSs
          ? await SinSitio.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie')
          : await Scraper.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie');
    } catch { /* seguimos con el fallback */ }

    if (esHt && (!detalle || !detalle.titulo || (detalle.torrents || []).length === 0)) {
      const htDetalle = type === 'movie' ? await HT.getMovieDetail(slug) : await HT.getSerieDetail(slug);
      if (htDetalle) {
        detalle = {
          titulo: htDetalle.title,
          tituloOriginal: htDetalle.original_title,
          slug: htDetalle.slug || slug,
          año: htDetalle.year || htDetalle.years || null,
          sinopsis: htDetalle.overview || '',
          descripcion: htDetalle.overview || '',
          poster: htDetalle.featured
            ? (String(htDetalle.featured).startsWith('/') ? `https://image.tmdb.org/t/p/w300${htDetalle.featured}` : htDetalle.featured)
            : null,
          background: htDetalle.background_image || null,
          generos: htDetalle.genres ? String(htDetalle.genres).split(',').map(g => g.trim()).filter(Boolean) : [],
          imdbRating: htDetalle.imdb || null,
          torrents: (htDetalle.downloads || []).map(d => ({
            calidad: d.quality,
            tamaño: d.size,
            idioma: d.language,
            magnet: d.download_link,
            temporada: d.season,
            episodio: d.episode
          }))
        };
      }
    }
    if (!detalle || !detalle.titulo) return { meta: null };

    const sinopsis = detalle.sinopsis || detalle.descripcion || detalle.overview || '';

    // Videos (episodios) para series
    let videos;
    if (type === 'series' && Array.isArray(detalle.torrents) && detalle.torrents.length > 0) {
      const seen = new Map();
      for (const t of detalle.torrents) {
        const se = torrentSeasonEpisode(t);
        if (se.season === null || se.episode === null) continue;
        const key = `${se.season}:${se.episode}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          id: `${prefijo}:${slug}:${se.season}:${se.episode}`,
          title: `T${se.season} E${se.episode} - ${t.calidad || 'WEB-DL'}`,
          season: se.season,
          episode: se.episode,
          released: detalle.año ? `${String(detalle.año).slice(0, 4)}-01-01T00:00:00.000Z` : undefined,
          overview: sinopsis
        });
      }
      if (seen.size > 0) {
        videos = Array.from(seen.values()).sort((a, b) => a.season - b.season || a.episode - b.episode);
      }
    }

    const rawGen = Array.isArray(detalle.generos) && detalle.generos.length > 0
      ? detalle.generos
      : detalle.genres
        ? String(detalle.genres).split(',').map(g => g.trim()).filter(Boolean)
        : [];

    return {
      meta: {
        id: `${prefijo}:${slug}`,
        type,
        name: detalle.titulo,
        poster: detalle.poster || undefined,
        background: detalle.background || detalle.poster || undefined,
        description: sinopsis,
        releaseInfo: detalle.año ? String(detalle.año).slice(0, 4) : '',
        imdbRating: detalle.imdbRating || undefined,
        genres: rawGen.length > 0 ? rawGen : undefined,
        cast: Array.isArray(detalle.actores) && detalle.actores.length > 0 ? detalle.actores : undefined,
        director: detalle.director ? [detalle.director] : undefined,
        runtime: detalle.duracion || undefined,
        videos
      }
    };
  } catch (err) {
    console.error('[Meta] Error:', err.message);
    return { meta: null };
  }
});

// ---------------------------------------------------------------------------
// 4) SERVIDOR (con página de configuración web en /configure)
// ---------------------------------------------------------------------------
const addonInterface = builder.getInterface();

if (require.main === module) {
  const { createApp } = require('./lib/server');
  const port = process.env.PORT || 7000;
  const app = createApp(addonInterface);

  // 0.0.0.0 para funcionar detrás de proxies (Beamup / baby-beamup.club, Render, Docker, previews)
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 UniverTorrent Addon corriendo en el puerto ${port}`);
    console.log(`   Subdominio Beamup: ${BEAMUP_ORIGIN}`);
    console.log(`   Manifest Beamup:   ${BEAMUP_ORIGIN}/manifest.json`);
    console.log(`   Configuración:     /configure (Español: /es/configure | Inglés: /en/configure)`);
    console.log(`   Manifest:          /manifest.json (Español: /es/manifest.json | Inglés: /en/manifest.json)`);
    console.log(`   Catálogos:         ${manifest.catalogs.map(c => c.name).join(', ')}`);
  });

  // Timeouts extendidos para muchos usuarios concurrentes y respuestas largas (Beamup / servidor persistente)
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 60000;

  const apagar = () => server.close(() => process.exit(0));
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

module.exports = addonInterface;
module.exports.builder = builder;
module.exports._internals = {
  fusionarStreams,
  normalizarConfig,
  aplicarConfig,
  buscarEnFuentesExternas,
  parseStremioId,
  variantesDeBusqueda,
  filtrarPorEpisodio,
  torrentToStream,
  detalleCoherente,
  streamsDeDetalle
};
