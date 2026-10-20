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
const HT = require('./lib/hacktorrent');

const builder = new addonBuilder(manifest);

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
    poster: poster,
    posterShape: 'poster',
    background: background || poster,
    logo: poster,
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
    return { metas: [] };
  }
});

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
    let imdbId = null;
    let slug = null;
    let season = null;
    let episode = null;
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
    return { streams: [] };
  }
});

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
module.exports.builder = builder;
