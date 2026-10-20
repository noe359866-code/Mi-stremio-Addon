<<<<<<< HEAD
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const manifest = require('./manifest.json');
=======
/**
 * HackTorrent Stremio Addon - Archivo Principal
 * Recursos: catalog + stream (manifest.json)
 * Scraper: lib/scraper.js (Axios + Cheerio)
 * SDK: stremio-addon-sdk
 * Puerto dinámico: process.env.PORT || 7000 (compatible Render)
 */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const manifest = require('./manifest.json');

// Usamos el nuevo scraper dedicado que cumple exactamente los requisitos del encargo
// (funciones con User-Agent + try/catch + calidad/tamaño/magnet)
const Scraper = require('./lib/scraper');
// Mantenemos lib/hacktorrent.js para funciones de catálogo/cinemeta/cache si hace falta
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
const HT = require('./lib/hacktorrent');

const builder = new addonBuilder(manifest);

<<<<<<< HEAD
// Helper to build Stremio metaPreview from wpreact item
function toMetaPreview(item, type) {
  // item from wpreact movies/series or search results
  const idPrefix = 'ht:'; // custom prefix for hacktorrent items
  const slug = item.slug;
  if (!slug) return null;

  // Determine type: item.type === 'pelicula' => movie, serie => series, anime => series
  let stremioType = type;
  if (!stremioType) {
    if (item.type === 'pelicula') stremioType = 'movie';
    else if (item.type === 'serie' || item.type === 'anime') stremioType = 'series';
    else stremioType = 'movie';
  }

  // poster: item.featured may be w300 path or full url
  let poster = item.featured || item.image || null;
  if (poster && poster.startsWith('/')) {
    poster = `https://image.tmdb.org/t/p/w500${poster}`;
  }
  // background
  let background = item.background_image || item.backdrop || null;
  if (background && background.startsWith('/')) {
    background = `https://image.tmdb.org/t/p/original${background}`;
  }
  // fallback to poster
  if (!poster && background) poster = background;

  const releaseInfo = item.year ? String(item.year) : (item.years ? String(item.years).slice(0,4) : '');
  const imdbRating = item.imdb ? String(item.imdb) : null;

  return {
    id: `${idPrefix}${slug}`,
    type: stremioType,
    name: item.title,
=======
// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Convierte un item de HackTorrent (wpreact) a Stremio Meta Preview
 */
function toMetaPreview(item, stremioType) {
  if (!item || !item.slug) return null;

  // Determinar tipo Stremio si no viene impuesto
  let type = stremioType;
  if (!type) {
    if (item.tipo === 'pelicula' || item.type === 'pelicula') type = 'movie';
    else if (item.tipo === 'serie' || item.type === 'serie' || item.tipo === 'anime' || item.type === 'anime') type = 'series';
    else type = 'movie';
  } else if (stremioType === 'series' && (item.tipo === 'pelicula' || item.type === 'pelicula')) {
    // Caso borde: catálogo series pero item es peli -> mapear a movie
    type = 'movie';
  }

  const slug = item.slug;
  // Resolver poster: wpreact da "/ugXW...jpg" (path tmdb) o url completa
  let poster = item.poster || item.featured || item.image || null;
  if (poster && poster.startsWith('/')) poster = `https://image.tmdb.org/t/p/w500${poster}`;
  let background = item.background || item.background_image || item.backdrop || poster;
  if (background && background.startsWith('/')) background = `https://image.tmdb.org/t/p/original${background}`;

  const titulo = item.titulo || item.title || slug.replace(/-/g, ' ');
  const año = item.año || item.year || item.years || null;
  const añoStr = año ? String(año).slice(0, 4) : '';
  const descripcion = item.descripcion || item.overview || '';
  const generos = item.generos || item.genres
    ? String(item.generos || item.genres).split(',').map(g => g.trim()).filter(Boolean)
    : [];

  return {
    id: `ht:${slug}`, // prefijo ht: para items propios de HackTorrent (también soportamos tt: de Cinemeta)
    type: type,
    name: titulo,
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
    poster: poster,
    posterShape: 'poster',
    background: background || poster,
    logo: poster,
<<<<<<< HEAD
    description: item.overview || '',
    releaseInfo: releaseInfo,
    imdbRating: imdbRating,
    genres: item.genres ? item.genres.split(',').map(g=>g.trim()) : [],
    // Stremio requires at least id, type, name
  };
}

// CATALOG HANDLER
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[Catalog] type=${type} id=${id} extra=${JSON.stringify(extra)}`);
  const search = extra?.search ? String(extra.search).trim() : null;
  const skip = extra?.skip ? parseInt(extra.skip, 10) : 0;
  const page = Math.floor(skip / 20) + 1;

  try {
    if (search) {
      // Search mode: use hacktorrent search API
      const results = await HT.searchHackTorrent(search);
      // Filter by type if catalog type specified
      let filtered = results;
      if (type === 'movie') {
        filtered = results.filter(r => r.type === 'pelicula');
      } else if (type === 'series') {
        filtered = results.filter(r => r.type === 'serie' || r.type === 'anime');
      }
      const metas = filtered.slice(0, 50).map(item => toMetaPreview(item, type)).filter(Boolean);
      return { metas };
    }

    // No search -> return latest novedades
    if (type === 'movie' && id === 'hacktorrent-peliculas') {
      const movies = await HT.getCatalogMovies(page);
      const metas = movies.map(m => toMetaPreview(m, 'movie')).filter(Boolean);
      // ensure we respect skip: slice
      const start = skip % 20;
      return { metas: metas.slice(start) };
    }

    if (type === 'series' && id === 'hacktorrent-series') {
      const series = await HT.getCatalogSeries(page);
      const metas = series.map(s => toMetaPreview(s, 'series')).filter(Boolean);
      const start = skip % 20;
      return { metas: metas.slice(start) };
    }

    return { metas: [] };
  } catch (err) {
    console.error('[Catalog] error:', err.message);
=======
    description: descripcion,
    releaseInfo: añoStr,
    imdbRating: item.imdbRating || item.imdb || null,
    genres: generos
  };
}

/**
 * Mapea un torrent (de extraerDetalleTorrent) a un stream de Stremio
 */
function torrentToStream(torrent, tituloFallback) {
  // torrent = {calidad, calidadNormalizada, tamaño, idioma, subtitulos, fecha, magnet, torrentUrl, infoHash, temporada, episodio}
  const magnet = torrent.magnet || torrent.torrentUrl;
  if (!magnet) return null;

  const calidad = torrent.calidad || torrent.calidadNormalizada || 'Desconocido';
  const tamaño = torrent.tamaño || torrent.size || '';
  const idioma = torrent.idioma || torrent.language || 'Latino';
  const subs = torrent.subtitulos || (torrent.subs ? 'Sí' : 'No');

  // Extraer infoHash si es magnet (para compatibilidad con clientes que prefieren infoHash)
  let infoHash = torrent.infoHash || null;
  if (!infoHash && magnet.startsWith('magnet:')) {
    const m = magnet.match(/btih:([a-fA-F0-9]{32,40})/i);
    if (m) infoHash = m[1].toLowerCase();
  }

  // Título del stream: 3 líneas visibles en Stremio
  // Línea 1: nombre archivo o título
  // Línea 2: calidad | tamaño | idioma | subs
  // Línea 3: fecha / temporada-episodio
  const lineas = [];
  const displayName = torrent.temporada && torrent.episodio
    ? `${tituloFallback} S${String(torrent.temporada).padStart(2, '0')}E${String(torrent.episodio).padStart(2, '0')}`
    : (tituloFallback || 'HackTorrent');
  lineas.push(displayName);
  lineas.push(`${calidad} | ${tamaño} | ${idioma} | Subs: ${subs}`);
  if (torrent.fecha) lineas.push(`📅 ${torrent.fecha}`);
  if (torrent.temporada && torrent.episodio) lineas.push(`S${torrent.temporada}E${torrent.episodio}`);

  const nombreFuente = `HackTorrent\n${calidad}`; // primera línea en UI de Stremio (izquierda)

  const stream = {
    name: nombreFuente,
    title: lineas.join('\n'),
    url: magnet, // Stremio acepta magnet directo en url
    behaviorHints: {
      bingeGroup: `hacktorrent-${calidad.replace(/\s+/g, '-').toLowerCase()}`,
      // videoHash permite agrupar por calidad en binge
      videoHash: infoHash ? `${infoHash}:${calidad}` : undefined
    }
  };
  // Algunos reproductores usan infoHash + trackers separados; también lo proveemos
  if (infoHash) stream.infoHash = infoHash;

  return stream;
}

// ---------------------------------------------------------------------------
// 1) MANEJADOR DE CATÁLOGOS - defineCatalogHandler
//    Muestra últimos estrenos o resultados de búsqueda desde HackTorrent
// ---------------------------------------------------------------------------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  // Manejo de errores sólido: cualquier excepción devuelve {metas: []} y no cuelga el servidor
  try {
    console.log(`[Catalog] type=${type} id=${id} extra=${JSON.stringify(extra)}`);

    const busqueda = extra?.search ? String(extra.search).trim() : null;
    const skip = extra?.skip ? parseInt(extra.skip, 10) : 0;
    const page = Math.floor(skip / 20) + 1;

    // --- A) BÚSQUEDA: el usuario escribió en la barra de búsqueda de Stremio ---
    if (busqueda) {
      try {
        // Usamos la función de scraping que soporta título o IMDb ID
        const resultados = await Scraper.buscarEnHackTorrent(busqueda, null);
        if (!resultados || resultados.length === 0) {
          console.log(`[Catalog] Búsqueda "${busqueda}" sin resultados`);
          return { metas: [] };
        }
        // Filtrar por tipo de catálogo solicitado (movie vs series)
        let filtrados = resultados;
        if (type === 'movie') filtrados = resultados.filter(r => r.tipo === 'pelicula');
        if (type === 'series') filtrados = resultados.filter(r => r.tipo === 'serie' || r.tipo === 'anime');

        const metas = filtrados.slice(0, 50).map(item => toMetaPreview(item, type)).filter(Boolean);
        console.log(`[Catalog] Búsqueda "${busqueda}" -> ${metas.length} metas`);
        return { metas };
      } catch (err) {
        console.error(`[Catalog] Error en búsqueda "${busqueda}":`, err.message);
        return { metas: [] }; // vacío en vez de colgarse
      }
    }

    // --- B) CATÁLOGO SIN BÚSQUEDA: últimos estrenos ---
    try {
      if (type === 'movie' && id === 'hacktorrent-peliculas') {
        const peliculas = await HT.getCatalogMovies(page);
        if (!peliculas || peliculas.length === 0) return { metas: [] };
        const metas = peliculas.map(p => toMetaPreview(p, 'movie')).filter(Boolean);
        // Respetar paginación skip (Stremio pide de 20 en 20)
        const start = skip % 20;
        return { metas: metas.slice(start) };
      }

      if (type === 'series' && id === 'hacktorrent-series') {
        const series = await HT.getCatalogSeries(page);
        if (!series || series.length === 0) return { metas: [] };
        const metas = series.map(s => toMetaPreview(s, 'series')).filter(Boolean);
        const start = skip % 20;
        return { metas: metas.slice(start) };
      }
    } catch (err) {
      console.error(`[Catalog] Error cargando novedades type=${type} id=${id}:`, err.message);
      return { metas: [] };
    }

    // Catálogo desconocido
    return { metas: [] };

  } catch (err) {
    // Catch global para que el servidor nunca se caiga por un error de scraping
    console.error('[Catalog] Error global:', err.message);
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
    return { metas: [] };
  }
});

<<<<<<< HEAD
// META HANDLER (to show details when user clicks catalog item)
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[Meta] type=${type} id=${id}`);
  try {
    if (id.startsWith('ht:')) {
      const slug = id.replace('ht:', '');
      let detail = null;
      if (type === 'movie') {
        detail = await HT.getMovieDetail(slug);
      } else if (type === 'series') {
        detail = await HT.getSerieDetail(slug);
        if (!detail || !detail.title) {
          // try anime as fallback
          detail = await HT.getAnimeDetail(slug);
        }
      }
      if (!detail) return { meta: null };

      // Build full meta object
      let poster = detail.featured;
      if (poster && poster.startsWith('/')) poster = `https://image.tmdb.org/t/p/w500${poster}`;
      else if (poster && !poster.startsWith('http')) poster = `https://image.tmdb.org/t/p/w500/${poster}`;
      let background = detail.background_image;
      if (background && background.startsWith('/')) background = `https://image.tmdb.org/t/p/original${background}`;
      else if (background && !background.startsWith('http')) background = `https://image.tmdb.org/t/p/original/${background}`;

      const genres = detail.genres ? detail.genres.split(',').map(g=>g.trim()) : [];

      // For series, we need to provide videos list if downloads exist per episode
      let videos = [];
      if (type === 'series' && detail.downloads && detail.downloads.length > 0) {
        // group by season/episode
        const seen = new Map();
        for (const dl of detail.downloads) {
          if (dl.season && dl.episode) {
            const key = `${dl.season}:${dl.episode}`;
            if (!seen.has(key)) {
              seen.set(key, {
                id: `${id}:${dl.season}:${dl.episode}`,
                title: `Episodio ${dl.episode} - ${dl.quality}`,
                season: dl.season,
                episode: [dl.episode],
                released: detail.years || detail.year || '',
                overview: detail.overview || ''
              });
            }
          }
        }
        videos = Array.from(seen.values());
      } else if (type === 'series') {
        // Try scraping to build videos list
        try {
          const scraped = await HT.scrapeSeriesPage(slug);
          const torrents = scraped.torrents || [];
          const seen = new Map();
          for (const t of torrents) {
            const key = `${t.season}:${t.episode}`;
            if (!seen.has(key)) {
              seen.set(key, {
                id: `${id}:${t.season}:${t.episode}`,
                title: `Episodio ${t.episode} - ${t.quality}`,
                season: t.season,
                episode: [t.episode],
                released: detail.years || detail.year || '',
                overview: detail.overview || ''
              });
            }
          }
          videos = Array.from(seen.values());
        } catch {}
      }

      const meta = {
        id: id,
        type: type,
        name: detail.title,
        poster: poster,
        background: background || poster,
        logo: poster,
        description: detail.overview || '',
        releaseInfo: detail.year || detail.years || '',
        imdbRating: detail.imdb ? String(detail.imdb) : null,
        genres: genres,
        runtime: detail.duracion || '',
        country: detail.country || '',
        director: detail.director ? [detail.director] : [],
        cast: detail.actors ? detail.actors.split(',').slice(0,5) : [],
        language: detail.language || 'Latino',
        videos: videos.length > 0 ? videos : undefined
      };
      return { meta };
    }
    // For IMDb IDs, we don't handle meta - let Cinemeta handle it
    return { meta: null };
  } catch (err) {
    console.error('[Meta] error:', err.message);
    return { meta: null };
  }
});

// STREAM HANDLER
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stream] type=${type} id=${id}`);
  try {
    // id can be:
    // - "tt1234567" (movie)
    // - "tt1234567:1:2" (series episode)
    // - "ht:slug" or "ht:slug:1:2"
    const parts = id.split(':');
=======
// ---------------------------------------------------------------------------
// 2) MANEJADOR DE STREAMS - defineStreamHandler
//    Recibe IMDb ID (tt...) o id propio ht:slug, consulta scraping y devuelve magnets
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id }) => {
  // Manejo de errores sólido: siempre devolver {streams: []} en caso de fallo
  try {
    console.log(`[Stream] Solicitado type=${type} id=${id}`);

    // Stremio envía id como:
    //  - "tt0111161" (película)
    //  - "tt0903747:1:1" (serie S01E01)
    //  - "ht:el-proyecto-colibri" (item propio de nuestro catálogo)
    //  - "ht:breaking-bad:1:1" (serie propia)
    if (!id) return { streams: [] };

    const partes = id.split(':');
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
    let imdbId = null;
    let slug = null;
    let season = null;
    let episode = null;
<<<<<<< HEAD
    let isCustomId = false;

    if (id.startsWith('ht:')) {
      isCustomId = true;
      // ht:slug or ht:slug:season:episode
      // slug may contain hyphens, but not colon, so parts[1] is slug
      slug = parts[1];
      if (parts.length >= 4) {
        season = parseInt(parts[2], 10);
        episode = parseInt(parts[3], 10);
      } else if (parts.length === 3) {
        // maybe ht:slug:episode? treat as season 1
        season = 1;
        episode = parseInt(parts[2], 10);
      }
    } else {
      // IMDb style
      imdbId = parts[0];
      if (parts.length >= 3) {
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
        if (isNaN(season) || isNaN(episode)) { season = null; episode = null; }
      }
    }

    let streams = [];

    // If we already have a slug from custom id, fetch directly
    if (isCustomId && slug) {
      streams = await getStreamsForSlug(slug, type, season, episode);
      return { streams };
    }

    // Else we have IMDb id - need to resolve title via Cinemeta, then search hacktorrent
    if (imdbId) {
      const cinemeta = await HT.getCinemeta(type, imdbId);
      if (!cinemeta) {
        console.log(`[Stream] Cinemeta not found for ${imdbId}`);
        // fallback: try using imdbId as search? Not ideal.
        // We could attempt to search with imdbId but hacktorrent doesn't index by imdb
        // Return empty
        return { streams: [] };
      }
      const title = cinemeta.name;
      const year = cinemeta.releaseInfo ? cinemeta.releaseInfo.substring(0,4) : null;
      // Try to get Spanish title? cinemeta may have alternative titles in translations?
      // We'll search with primary name
      console.log(`[Stream] Resolved IMDb ${imdbId} -> "${title}" (${year})`);

      // Strategy: search hacktorrent with title
      let searchResults = await HT.searchHackTorrent(title);
      // If no results, try original title or alternative: clean title without special chars
      if (!searchResults || searchResults.length === 0) {
        const cleanTitle = title.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
        searchResults = await HT.searchHackTorrent(cleanTitle);
      }
      // If still empty, try with first 2 words to broaden
      if (!searchResults || searchResults.length === 0) {
        const short = title.split(' ').slice(0,2).join(' ');
        searchResults = await HT.searchHackTorrent(short);
      }

      if (!searchResults || searchResults.length === 0) {
        console.log(`[Stream] No search results for "${title}"`);
        return { streams: [] };
      }

      // Find best match considering type
      const best = HT.findBestMatch(searchResults, title, year, cinemeta.originalTitle || null, type);
      if (!best) {
        console.log(`[Stream] No best match found among ${searchResults.length} results`);
        // fallback: take first result of correct type
        const typeFiltered = searchResults.filter(r => {
          if (type === 'movie') return r.type === 'pelicula';
          if (type === 'series') return r.type === 'serie' || r.type === 'anime';
          return true;
        });
        if (typeFiltered.length === 0) return { streams: [] };
        slug = typeFiltered[0].slug;
        console.log(`[Stream] Fallback to first result slug=${slug}`);
      } else {
        slug = best.slug;
        console.log(`[Stream] Best match title="${best.title}" slug=${slug} type=${best.type} year=${best.year} score`);
      }

      if (!slug) return { streams: [] };

      streams = await getStreamsForSlug(slug, type, season, episode);
      return { streams };
    }

    return { streams: [] };
  } catch (err) {
    console.error('[Stream] error:', err);
=======
    let esIdPropio = false;

    if (id.startsWith('ht:')) {
      esIdPropio = true;
      slug = partes[1];
      if (partes.length >= 4) {
        season = parseInt(partes[2], 10);
        episode = parseInt(partes[3], 10);
      } else if (partes.length === 3) {
        season = 1;
        episode = parseInt(partes[2], 10);
      }
      // Validar NaN
      if (season && isNaN(season)) season = null;
      if (episode && isNaN(episode)) episode = null;
    } else {
      imdbId = partes[0];
      if (partes.length >= 3) {
        season = parseInt(partes[1], 10);
        episode = parseInt(partes[2], 10);
        if (isNaN(season) || isNaN(episode)) { season = null; episode = null; }
      }
      // Validar que parece IMDb ID
      if (!/^tt\d+$/.test(imdbId)) {
        console.warn(`[Stream] id no es IMDb ni ht: "${id}"`);
        // Intentar tratarlo como slug directo
        slug = imdbId;
        imdbId = null;
        esIdPropio = true;
      }
    }

    // --- CASO A: ID PROPIO ht:... -> directo a detalle ---
    if (esIdPropio && slug) {
      try {
        const detalle = await Scraper.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie');
        if (!detalle || !detalle.torrents || detalle.torrents.length === 0) {
          console.log(`[Stream] Sin torrents para ht:${slug}`);
          return { streams: [] };
        }
        // Para series, filtrar por temporada/episodio si vienen
        let torrents = detalle.torrents;
        if (type === 'series' && season !== null && episode !== null) {
          const filtrados = torrents.filter(t =>
            (t.temporada === season && t.episodio === episode) ||
            (t.season === season && t.episode === episode)
          );
          // Si filtrado deja vacío pero hay torrents, puede ser que el sitio no separe por temporada
          // En ese caso devolvemos todos (la temporada es referencia visual)
          if (filtrados.length > 0) torrents = filtrados;
        }
        const streams = torrents.map(t => torrentToStream(t, detalle.titulo)).filter(Boolean);
        console.log(`[Stream] ht:${slug} -> ${streams.length} streams`);
        return { streams };
      } catch (err) {
        console.error(`[Stream] Error detalle ht:${slug}:`, err.message);
        return { streams: [] };
      }
    }

    // --- CASO B: IMDb ID -> resolver título vía Cinemeta -> buscar en HackTorrent ---
    if (imdbId) {
      try {
        // 1) Resolver título y año desde Cinemeta (v3-cinemeta.strem.io) - no requiere API key
        let titulo = null;
        let año = null;
        try {
          const cinemeta = await HT.getCinemeta(type, imdbId);
          if (cinemeta) {
            titulo = cinemeta.name;
            año = cinemeta.releaseInfo ? String(cinemeta.releaseInfo).slice(0, 4) : null;
            console.log(`[Stream] Cinemeta ${imdbId} -> "${titulo}" (${año})`);
          }
        } catch (e) {
          console.warn(`[Stream] Cinemeta falló para ${imdbId}:`, e.message);
        }

        // Fallback si Cinemeta no responde: usar el propio imdbId como query (no ideal, pero evita vacío)
        if (!titulo) {
          console.log(`[Stream] Sin Cinemeta para ${imdbId}, usando búsqueda directa por ID`);
          titulo = imdbId;
        }

        // 2) Buscar en HackTorrent con el título
        let resultados = await Scraper.buscarEnHackTorrent(titulo, imdbId);
        // Si no hay resultados, probar con título limpio (sin caracteres especiales)
        if ((!resultados || resultados.length === 0) && titulo !== imdbId) {
          const limpio = titulo.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
          if (limpio && limpio !== titulo) {
            console.log(`[Stream] Reintentando búsqueda con título limpio: "${limpio}"`);
            resultados = await Scraper.buscarEnHackTorrent(limpio, imdbId);
          }
        }
        // Último intento: 2 primeras palabras (títulos largos)
        if ((!resultados || resultados.length === 0) && titulo.split(' ').length > 2) {
          const corto = titulo.split(' ').slice(0, 2).join(' ');
          console.log(`[Stream] Reintentando búsqueda corta: "${corto}"`);
          resultados = await Scraper.buscarEnHackTorrent(corto, imdbId);
        }

        if (!resultados || resultados.length === 0) {
          console.log(`[Stream] HackTorrent no devolvió resultados para "${titulo}" (${imdbId})`);
          return { streams: [] };
        }

        // 3) Encontrar el mejor match (por similitud de título + año + tipo)
        let mejor = null;
        try {
          mejor = HT.findBestMatch(resultados, titulo, año, null, type);
        } catch {}
        // Si no hay mejor por scoring, tomar el primero del tipo correcto
        if (!mejor) {
          const filtradosTipo = resultados.filter(r => {
            if (type === 'movie') return r.tipo === 'pelicula';
            if (type === 'series') return r.tipo === 'serie' || r.tipo === 'anime';
            return true;
          });
          mejor = filtradosTipo[0] || resultados[0];
          console.log(`[Stream] Sin bestMatch, usando fallback: ${mejor?.titulo} (${mejor?.slug})`);
        } else {
          console.log(`[Stream] Mejor match: "${mejor.titulo}" slug=${mejor.slug} tipo=${mejor.tipo} año=${mejor.año || mejor.tiempo || '?'} `);
        }

        if (!mejor || !mejor.slug) return { streams: [] };
        slug = mejor.slug;

        // 4) Extraer detalle del mejor match
        const detalle = await Scraper.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie');
        if (!detalle || !detalle.torrents || detalle.torrents.length === 0) {
          console.log(`[Stream] Detalle de ${slug} sin torrents`);
          return { streams: [] };
        }

        // 5) Para series, filtrar por episodio si aplica
        let torrents = detalle.torrents;
        if (type === 'series' && season !== null && episode !== null) {
          const filtrados = torrents.filter(t =>
            (t.temporada === season && t.episodio === episode) ||
            (t.season === season && t.episode === episode) ||
            (t.temporada == season && t.episodio == episode) // loose equality
          );
          if (filtrados.length > 0) {
            console.log(`[Stream] Filtrado S${season}E${episode}: ${filtrados.length}/${torrents.length}`);
            torrents = filtrados;
          } else {
            console.log(`[Stream] Sin torrents exactos para S${season}E${episode}, devolviendo todos (${torrents.length})`);
          }
        }

        // 6) Mapear a streams de Stremio
        const streams = torrents.map(t => torrentToStream(t, detalle.titulo)).filter(Boolean);
        console.log(`[Stream] ${imdbId} (${titulo}) -> ${streams.length} streams vía ${slug}`);
        return { streams };

      } catch (err) {
        console.error(`[Stream] Error procesando IMDb ${imdbId}:`, err.message);
        return { streams: [] }; // nunca colgar
      }
    }

    // Si no es ni ht: ni tt, devolver vacío
    return { streams: [] };

  } catch (err) {
    // Catch global para que el servidor nunca se cuelgue
    console.error('[Stream] Error global:', err.message, err.stack?.split('\n')[1] || '');
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
    return { streams: [] };
  }
});

<<<<<<< HEAD
async function getStreamsForSlug(slug, type, season, episode) {
  const streams = [];

  // Try to get detail via wpreact first (movies and anime)
  if (type === 'movie') {
    let detail = await HT.getMovieDetail(slug);
    if (detail && detail.downloads && detail.downloads.length > 0) {
      for (const dl of detail.downloads) {
        const s = HT.mapDownloadToStream(dl, detail.title);
        if (s) streams.push(s);
      }
      console.log(`[Stream] Movie ${slug} -> ${streams.length} streams via wpreact`);
      return streams;
    } else {
      // fallback to scrape movie page
      console.log(`[Stream] Movie ${slug} no wpreact downloads, trying scrape`);
      const scraped = await HT.scrapeMoviePage(slug);
      for (const t of scraped.torrents) {
        // t contains quality, size, language, subs, acortarUrl
        if (!t.acortarUrl) continue;
        const magnet = await HT.resolveAcortalink(t.acortarUrl);
        if (!magnet) continue;
        const dl = {
          quality: t.quality,
          size: t.size,
          language: t.language,
          subs: t.subs,
          download_link: magnet,
          date: t.date
        };
        const s = HT.mapDownloadToStream(dl, scraped.title || slug);
        if (s) streams.push(s);
      }
      console.log(`[Stream] Movie scrape fallback -> ${streams.length} streams`);
      return streams;
    }
  }

  if (type === 'series') {
    // First try wpreact serie detail - it may contain downloads per episode (especially anime)
    let detail = await HT.getSerieDetail(slug);
    if (!detail) {
      detail = await HT.getAnimeDetail(slug);
    }
    if (detail && detail.downloads && detail.downloads.length > 0) {
      // Filter by season/episode if provided
      let downloads = detail.downloads;
      if (season && episode) {
        downloads = downloads.filter(d => {
          // wpreact downloads for anime have season/episode numeric
          if (d.season && d.episode) return parseInt(d.season,10) === season && parseInt(d.episode,10) === episode;
          return true; // if no season/episode info, keep all
        });
        // If filtered empty, fallback to keep all
        if (downloads.length === 0) downloads = detail.downloads;
      }
      for (const dl of downloads) {
        const s = HT.mapDownloadToStream(dl, detail.title, { season, episode });
        if (s) streams.push(s);
      }
      console.log(`[Stream] Serie ${slug} S${season}E${episode} -> ${streams.length} via wpreact`);
      if (streams.length > 0) return streams;
    }

    // Fallback to HTML scraping for series (classic hacktorrent series like breaking-bad, from)
    console.log(`[Stream] Serie ${slug} fallback to HTML scrape`);
    const scraped = await HT.scrapeSeriesPage(slug);
    let torrents = scraped.torrents || [];

    if (season && episode) {
      torrents = torrents.filter(t => t.season === season && t.episode === episode);
      // If no exact season match (maybe site lumps all seasons as 1), try only episode match
      if (torrents.length === 0) {
        const scrapedAll = await HT.scrapeSeriesPage(slug);
        torrents = (scrapedAll.torrents || []).filter(t => t.episode === episode);
      }
    }

    console.log(`[Stream] Scraped torrents after filter: ${torrents.length} (season ${season} episode ${episode})`);

    // Resolve each acortalink concurrently with limit
    const concurrency = 3;
    const queue = [...torrents];
    const resolved = [];

    async function worker() {
      while (queue.length > 0) {
        const t = queue.shift();
        if (!t.acortarUrl) continue;
        const magnet = await HT.resolveAcortalink(t.acortarUrl);
        if (!magnet) continue;
        const dl = {
          quality: t.quality,
          size: t.size,
          language: t.language,
          subs: t.subs,
          download_link: magnet,
          date: t.date,
          season: t.season,
          episode: t.episode
        };
        const s = HT.mapDownloadToStream(dl, scraped.title || slug, { season, episode });
        if (s) resolved.push(s);
      }
    }
    const workers = Array(Math.min(concurrency, torrents.length)).fill(null).map(() => worker());
    await Promise.all(workers);

    console.log(`[Stream] Serie scrape resolved ${resolved.length} streams`);
    return resolved;
  }

  return [];
}

const interface = builder.getInterface();

// Start HTTP server if run directly
if (require.main === module) {
  const port = process.env.PORT || 7000;
  serveHTTP(interface, { port, cacheMaxAge: 3600 * 6 });
  console.log(`🚀 HackTorrent Addon iniciado en http://localhost:${port}/manifest.json`);
  console.log(`   Catálogos: ${manifest.catalogs.map(c=>c.name).join(', ')}`);
} else {
  module.exports = interface;
}

=======
// ---------------------------------------------------------------------------
// OPCIONAL: Meta Handler para items propios ht:... (mejora la vista en Stremio)
// ---------------------------------------------------------------------------
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    if (!id.startsWith('ht:')) return { meta: null };
    const slug = id.split(':')[0].replace('ht:', '');
    // Usamos Scraper para obtener detalle y construir meta
    let detalle = null;
    try {
      detalle = await Scraper.extraerDetalleTorrent(slug, type === 'movie' ? 'pelicula' : 'serie');
    } catch {}
    // Fallback a HT cache
    if (!detalle || !detalle.titulo) {
      detalle = type === 'movie' ? await HT.getMovieDetail(slug) : await HT.getSerieDetail(slug);
      if (!detalle) return { meta: null };
      // HT.get*Detail devuelve estructura distinta, normalizar
      detalle = {
        titulo: detalle.title, slug: detalle.slug,
        torrents: (detalle.downloads || []).map(d => ({
          calidad: d.quality, tamaño: d.size, idioma: d.language,
          magnet: d.download_link, temporada: d.season, episodio: d.episode
        }))
      };
    }
    if (!detalle) return { meta: null };

    // Construir videos para series (lista de episodios)
    let videos = undefined;
    if (type === 'series' && detalle.torrents && detalle.torrents.length > 0) {
      const seen = new Map();
      for (const t of detalle.torrents) {
        const temp = t.temporada ?? t.season ?? 1;
        const ep = t.episodio ?? t.episode;
        if (!ep) continue;
        const key = `${temp}:${ep}`;
        if (!seen.has(key)) {
          seen.set(key, {
            id: `ht:${slug}:${temp}:${ep}`,
            title: `Episodio ${ep} - ${t.calidad || 'WEB-DL'}`,
            season: temp,
            episode: [ep],
            released: detalle.año || '',
            overview: detalle.descripcion || ''
          });
        }
      }
      videos = Array.from(seen.values());
      if (videos.length === 0) videos = undefined;
    }

    const meta = {
      id: id.split(':').slice(0, 2).join(':'), // ht:slug
      type: type,
      name: detalle.titulo,
      poster: detalle.poster || null,
      background: detalle.background || detalle.poster || null,
      description: detalle.descripcion || detalle.overview || '',
      releaseInfo: detalle.año || '',
      genres: detalle.generos ? String(detalle.generos).split(',').map(g => g.trim()).filter(Boolean) : [],
      videos: videos
    };
    return { meta };
  } catch (err) {
    console.error('[Meta] Error:', err.message);
    return { meta: null };
  }
});

// ---------------------------------------------------------------------------
// 3) CONFIGURACIÓN DEL SERVIDOR - Puerto dinámico para Render
// ---------------------------------------------------------------------------
const addonInterface = builder.getInterface();

// Solo arrancar servidor HTTP si se ejecuta directamente (no cuando se importa como módulo)
if (require.main === module) {
  const port = process.env.PORT || 7000; // Render inyecta PORT, local usa 7000
  serveHTTP(addonInterface, {
    port: port,
    cacheMaxAge: 3600 * 6, // cache 6 horas para catálogos
    // CORS abierto para Stremio
  });
  console.log(`🚀 HackTorrent Addon corriendo en http://localhost:${port}/manifest.json`);
  console.log(`   Catálogos: ${manifest.catalogs.map(c => c.name).join(', ')}`);
  console.log(`   Puerto: ${port} (env PORT=${process.env.PORT || 'no definido -> 7000'})`);
}

// Exportar interface para tests y para despliegue serverless (Vercel, Netlify)
module.exports = addonInterface;
>>>>>>> 217aea0 (fix: mejor matching Avengers y index unificado)
module.exports.builder = builder;
