const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const manifest = require('./manifest.json');
const HT = require('./lib/hacktorrent');

const builder = new addonBuilder(manifest);

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
    poster: poster,
    posterShape: 'poster',
    background: background || poster,
    logo: poster,
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
    return { metas: [] };
  }
});

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
    let imdbId = null;
    let slug = null;
    let season = null;
    let episode = null;
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
    return { streams: [] };
  }
});

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

module.exports.builder = builder;
