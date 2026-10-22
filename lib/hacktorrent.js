const axios = require('axios');
const cheerio = require('cheerio');
const { pickBestMatch } = require('./match');
const { timeout } = require('./timeouts');

// Los datos MOCK sólo se usan con HACKTORRENT_MOCK=1 (tests/sandbox offline).
// En producción NUNCA devolvemos contenido de ejemplo: es peor entregar una
// película equivocada que no devolver streams.
const MOCK_ENABLED = /^(1|true|yes|si|sí)$/i.test(String(process.env.HACKTORRENT_MOCK || ''));

const BASE_URL = 'https://hacktorrent.cc';
const WPREACT_API = `${BASE_URL}/wp-json/wpreact/v1`;
const REACT_API = `${BASE_URL}/wp-json/react/v1`;

const AXIOS_CONFIG = {
  timeout: timeout(10000),
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Referer': BASE_URL + '/',
  },
  maxRedirects: 5,
  validateStatus: s => s >= 200 && s < 400
};

const HTML_AXIOS_CONFIG = {
  timeout: timeout(10000),
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9',
  },
  maxRedirects: 5
};

// Simple in-memory cache 5 min
const cache = new Map();
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(key); return null; }
  return v.data;
}
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

// ------------------ MOCK FALLBACK (for sandbox / offline testing) ------------------
// When HackTorrent is unreachable (Cloudflare / firewall en sandbox), devolvemos datos de ejemplo
// Estos datos permiten probar el addon localmente sin depender de la red externa.
const MOCK_MOVIES = [
  {
    id: 10658, slug: "el-proyecto-colibri", title: "El Proyecto Colibrí",
    overview: "Un hombre y su primo intentan hacerse millonarios mediante la construcción de un cable de fibra óptica entre Kansas y Nueva Jersey.",
    original_title: "The Hummingbird Project", duracion: "111m",
    background_image: "https://image.tmdb.org/t/p/original//4N6eXAhEm2rdwyMUrY2c4c7lTfO.jpg",
    featured: "https://image.tmdb.org/t/p/w300//uRRuhlqmzGnxugvA257Rt3dzvaz.jpg",
    years: "2019-03-15", year: "2019", tmdb_id: "489243", imdb: "6.2", type: "pelicula", language: "Latino", genres: "Suspense,Drama"
  },
  {
    id: 15051, slug: "la-noche-del-demonio-estan-entre-nosotros", title: "La noche del demonio: Están entre nosotros",
    overview: "Un trío de acosadores se infiltra en un tranquilo suburbio y obliga a una nueva familia a entrar en el plano astral.",
    original_title: "Insidious: Out of the Further", duracion: "106m",
    background_image: "https://image.tmdb.org/t/p/original//hD8y787ciNWQ2bn396YrSsOIzdN.jpg",
    featured: "https://image.tmdb.org/t/p/w300//icc5Tjg14CZH94b0CDBQ2PP8YjH.jpg",
    years: "2026-08-19", year: "2026", tmdb_id: "1291595", imdb: "6.6", type: "pelicula", language: "Latino", genres: "Terror,Suspense"
  },
  {
    id: 4203, slug: "avengers-los-vengadores", title: "Avengers: Los Vengadores",
    overview: "Cuando un enemigo inesperado surge como una gran amenaza para la seguridad mundial, Nick Fury decide reclutar a un equipo.",
    original_title: "The Avengers", duracion: "143m",
    background_image: "https://image.tmdb.org/t/p/original//9BBTo63ANSmhC4e6r62OJFuK2GL.jpg",
    featured: "https://image.tmdb.org/t/p/w500//ugX4WZJO3jEvTOerctAWJLinujo.jpg",
    years: "2012-04-25", year: "2012", tmdb_id: "24428", imdb: "7.7", type: "pelicula", language: "Castellano", genres: "Ciencia ficción,Acción,Aventura"
  },
  {
    id: 6723, slug: "avengers-infinity-war", title: "Avengers: Infinity War",
    overview: "Los Vengadores y sus aliados deben estar dispuestos a sacrificarlo todo para intentar derrotar al poderoso Thanos.",
    original_title: "Avengers: Infinity War", duracion: "149m",
    background_image: "https://image.tmdb.org/t/p/original//mDfJG3LC3Dqb67AZ52x3Z0jU0uB.jpg",
    featured: "https://image.tmdb.org/t/p/w300//ksBQ4oHQDdJwND8H90ay8CbMihU.jpg",
    years: "2018-04-25", year: "2018", tmdb_id: "299536", imdb: "8.2", type: "pelicula", language: "Castellano", genres: "Aventura,Acción,Ciencia ficción"
  },
  {
    id: 15177, slug: "el-telefono", title: "El teléfono",
    overview: "Una asesina en serie que vive en el pasado intercambia llamadas con una mujer que vive 20 años en el futuro.",
    original_title: "The Call", duracion: "112m",
    background_image: "https://image.tmdb.org/t/p/original//iDw6J49rf7Xlu9QZBWpvmrMqSzI.jpg",
    featured: "https://image.tmdb.org/t/p/w300//iqqWhCEPzHn1EX04BKFRuRy6cJr.jpg",
    years: "2020-11-23", year: "2020", tmdb_id: "575604", imdb: "7.4", type: "pelicula", language: "Latino", genres: "Suspense,Misterio,Ciencia ficción"
  }
];

const MOCK_SERIES = [
  {
    id: 499, slug: "from", title: "From",
    overview: "Desvela el misterio de un pueblo de pesadilla en el centro de América que atrapa a todos los que entran.",
    original_title: "FROM", background_image: "https://image.tmdb.org/t/p/original//6gN8DYnIEln8v7OhRy61c57w0Xy.jpg",
    featured: "https://image.tmdb.org/t/p/original//cjXLrg4R7FRPFafvuQ3SSznQOd9.jpg",
    years: "2022-02-20", year: "2022", tmdb_id: "124364", imdb: "8.2", type: "serie", language: "Latino", genres: "Misterio,Drama,Sci-Fi & Fantasy"
  },
  {
    id: 917, slug: "breaking-bad", title: "Breaking Bad",
    overview: "Tras cumplir 50 años, Walter White, un profesor de química, se entera de que tiene cáncer y decide fabricar metanfetamina.",
    original_title: "Breaking Bad", background_image: "https://image.tmdb.org/t/p/original//gc8PfyTqzqltKPW3X0cIVUGmagz.jpg",
    featured: "https://image.tmdb.org/t/p/original//ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg",
    years: "2008-01-20", year: "2008", tmdb_id: "1396", imdb: "8.9", type: "serie", language: "Latino", genres: "Drama,Crimen"
  }
];

const MOCK_DETAILS = {
  "el-proyecto-colibri": {
    id: 10658, slug: "el-proyecto-colibri", title: "El Proyecto Colibrí",
    original_title: "The Hummingbird Project", duracion: "111m",
    background_image: "https://image.tmdb.org/t/p/original//4N6eXAhEm2rdwyMUrY2c4c7lTfO.jpg",
    featured: "https://image.tmdb.org/t/p/w300//uRRuhlqmzGnxugvA257Rt3dzvaz.jpg",
    overview: "Un hombre y su primo intentan hacerse millonarios mediante la construcción de un cable de fibra óptica.",
    years: "2019-03-15", year: "2019", tmdb_id: "489243", imdb: "6.2", type: "pelicula", language: "Latino",
    downloads: [
      { quality: "WEB-DL 1080p", date: "20240105", size: "3.70 GB", subs: 1, download_link: "magnet:?xt=urn:btih:a7a4b188eb86e5ae3023d64aa75c573dded4a015&dn=El.Proyecto.Colibri.2019.WEB-DL.1080p-Lat&xl=3981293107&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce", language: "Latino" },
      { quality: "720p", date: "20240105", size: "1.01 GB", subs: 1, download_link: "magnet:?xt=urn:btih:889dfd64f9722a2067f4dc9f22cde7df33d78d2f&dn=El.Proyecto.Colibri.2019.720p-Lat&xl=1085059055&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce", language: "Latino" },
      { quality: "DVDRip", date: "20240105", size: "651 MB", subs: 0, download_link: "magnet:?xt=urn:btih:bf04a027f112fc139682da6dfd60453c354d9d7e&dn=El.Proyecto.Colibri.2019.DVDRip-Lat&xl=683553841&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce", language: "Latino" }
    ]
  },
  "la-noche-del-demonio-estan-entre-nosotros": {
    id: 15051, slug: "la-noche-del-demonio-estan-entre-nosotros", title: "La noche del demonio: Están entre nosotros",
    original_title: "Insidious: Out of the Further", duracion: "106m",
    background_image: "https://image.tmdb.org/t/p/original//hD8y787ciNWQ2bn396YrSsOIzdN.jpg",
    featured: "https://image.tmdb.org/t/p/w300//icc5Tjg14CZH94b0CDBQ2PP8YjH.jpg",
    overview: "Un trío de acosadores se infiltra en un tranquilo suburbio.", years: "2026-08-19", year: "2026", tmdb_id: "1291595", imdb: "6.6", type: "pelicula", language: "Latino",
    downloads: [
      { quality: "WEB-DL 4k HDR", size: "18.2 GB", subs: 1, language: "Latino - Inglés", date: "20260901", download_link: "magnet:?xt=urn:btih:429ed335cf8a8c13fa95bda05beb9cedaca52cbb&dn=La.noche.del.demonio.Estan.entre.nosotros.2026.WEB-DL.4k.HDR-Dual-Lat&xl=19555437918&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce" },
      { quality: "WEB-DL 1080p", size: "5.66 GB", subs: 1, language: "Latino - Inglés", date: "20260901", download_link: "magnet:?xt=urn:btih:33c328b31bc6b6ab37af2c46ae2c59282ca803ba&dn=La.noche.del.demonio.Estan.entre.nosotros.2026.WEB-DL.1080p-Dual-Lat&xl=6079353863&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce" },
      { quality: "720p", size: "1.23 GB", subs: 1, language: "Latino - Inglés", date: "20260901", download_link: "magnet:?xt=urn:btih:a78e8831e034292bdcc19e73479742b4fe91bd40&dn=La.noche.del.demonio.Estan.entre.nosotros.2026.720p-Dual-Lat&xl=1328976709&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce" }
    ]
  },
  "avengers-los-vengadores": {
    id: 4203, slug: "avengers-los-vengadores", title: "Avengers: Los Vengadores",
    original_title: "The Avengers", duracion: "143m",
    background_image: "https://image.tmdb.org/t/p/original//9BBTo63ANSmhC4e6r62OJFuK2GL.jpg",
    featured: "https://image.tmdb.org/t/p/w500//ugX4WZJO3jEvTOerctAWJLinujo.jpg",
    overview: "Cuando un enemigo inesperado surge como una gran amenaza para la seguridad mundial, Nick Fury decide reclutar a un equipo.", years: "2012-04-25", year: "2012", tmdb_id: "24428", imdb: "7.7", type: "pelicula", language: "Castellano",
    downloads: [
      { quality: "4K Ultra HD", size: "56.5 GB", subs: 0, language: "Castellano", date: "20240105", download_link: "magnet:?xt=urn:btih:EE3F83277C291246EB3B43FAB71E356B6FEA8E49&dn=Los%20Vengadores%20%5bFullUHD%202160p%5d%5bCastellano%20DTS%205.1-Ingles%20DolbyTrueHD%2batmos%207.1%2bSubs%5d&tr=http%3a%2f%2fshare.camoe.cn%3a8080%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce" },
      { quality: "WEB-DL 1080p", size: "8.2 GB", subs: 1, language: "Latino", date: "20240105", download_link: "magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=Avengers.Los.Vengadores.2012.1080p-Latino&xl=8800000000&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce" }
    ]
  },
  "avengers-infinity-war": {
    id: 6723, slug: "avengers-infinity-war", title: "Avengers: Infinity War",
    original_title: "Avengers: Infinity War", duracion: "149m",
    background_image: "https://image.tmdb.org/t/p/original//mDfJG3LC3Dqb67AZ52x3Z0jU0uB.jpg",
    featured: "https://image.tmdb.org/t/p/w300//ksBQ4oHQDdJwND8H90ay8CbMihU.jpg",
    overview: "Los Vengadores y sus aliados deben estar dispuestos a sacrificarlo todo para intentar derrotar al poderoso Thanos.", years: "2018-04-25", year: "2018", tmdb_id: "299536", imdb: "8.2", type: "pelicula", language: "Castellano",
    downloads: [
      { quality: "WEB-DL 1080p", size: "4.5 GB", subs: 1, language: "Castellano", date: "20240105", download_link: "magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12&dn=Avengers.Infinity.War.2018.1080p-Latino&xl=4800000000&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce" }
    ]
  }
};

const MOCK_SERIE_DETAILS = {
  "from": {
    id: 499, slug: "from", title: "From",
    overview: "Desvela el misterio de un pueblo de pesadilla en el centro de América.",
    original_title: "FROM", background_image: "https://image.tmdb.org/t/p/original//6gN8DYnIEln8v7OhRy61c57w0Xy.jpg",
    featured: "https://image.tmdb.org/t/p/original//cjXLrg4R7FRPFafvuQ3SSznQOd9.jpg",
    years: "2022-02-20", year: "2022", tmdb_id: "124364", imdb: "8.2", type: "serie", language: "Latino",
    downloads: []
  },
  "breaking-bad": {
    id: 917, slug: "breaking-bad", title: "Breaking Bad",
    overview: "Walter White, profesor de química, se entera de cáncer y decide fabricar metanfetamina.",
    original_title: "Breaking Bad", background_image: "https://image.tmdb.org/t/p/original//gc8PfyTqzqltKPW3X0cIVUGmagz.jpg",
    featured: "https://image.tmdb.org/t/p/original//ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg",
    years: "2008-01-20", year: "2008", tmdb_id: "1396", imdb: "8.9", type: "serie", language: "Latino",
    downloads: []
  }
};

// ------------------ Catalog / Search API ------------------

async function fetchWpreactSearch(query) {
  const cacheKey = `search:wpreact:${query}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/search?query=${encodeURIComponent(query)}`;
    const res = await axios.get(url, AXIOS_CONFIG);
    const results = res.data?.results || res.data?.data || [];
    const arr = Array.isArray(results) ? results : (Array.isArray(res.data) ? res.data : []);
    if (arr.length === 0) throw new Error('empty');
    setCache(cacheKey, arr);
    return arr;
  } catch (e) {
    // fallback to react search
    const fallback = await fetchReactSearch(query);
    if (fallback && fallback.length > 0) return fallback;
    // mock fallback (sólo tests/sandbox offline)
    if (MOCK_ENABLED) {
      const qNorm = normalizeTitle(query);
      const allMocks = [...MOCK_MOVIES, ...MOCK_SERIES];
      const filtered = allMocks.filter(m => {
        const t = normalizeTitle(m.title);
        const o = normalizeTitle(m.original_title || '');
        return t === qNorm || o === qNorm || t.includes(qNorm) || o.includes(qNorm) || qNorm.includes(t);
      });
      if (filtered.length > 0) {
        setCache(cacheKey, filtered);
        return filtered;
      }
    }
    return fallback;
  }
}

async function fetchReactSearch(query) {
  const cacheKey = `search:react:${query}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    let url = `${REACT_API}/search?q=${encodeURIComponent(query)}`;
    let res = await axios.get(url, AXIOS_CONFIG);
    let data = res.data?.data || res.data;
    if (!Array.isArray(data) || data.length === 0) {
      url = `${REACT_API}/search?s=${encodeURIComponent(query)}`;
      res = await axios.get(url, AXIOS_CONFIG);
      data = res.data?.data || res.data;
    }
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('empty react search');
    }
    // react returns array of objects with _id, title, link, imdb, type, etc.
    // normalize to wpreact shape
    const normalized = (Array.isArray(data) ? data : []).map(item => {
      const slug = (item.link || '').replace(/^\/(pelicula|serie|anime)\//, '').replace(/\//g, '');
      const typeMap = { 'peliculas': 'pelicula', 'series': 'serie', 'animes': 'anime' };
      const rawType = item.type || '';
      const type = typeMap[rawType] || rawType || (item.link?.includes('/pelicula/') ? 'pelicula' : item.link?.includes('/serie/') ? 'serie' : 'anime');
      return {
        id: item._id || item.id,
        slug: slug,
        title: item.title,
        original_title: item.title, // react doesn't give original_title separately
        year: item.years ? String(item.years[0]) : null, // years is array of term ids? not reliable
        tmdb_id: null,
        imdb: item.imdb,
        type: type,
        language: '',
        featured: item.image ? `https://image.tmdb.org/t/p/w300${item.image}` : null,
        background_image: item.backdrop ? `https://image.tmdb.org/t/p/original${item.backdrop}` : null,
        overview: item.overview,
        genres: '',
        _raw: item
      };
    });
    setCache(cacheKey, normalized);
    return normalized;
  } catch (err) {
    return [];
  }
}

async function searchHackTorrent(query) {
  if (!query) return [];
  const results = await fetchWpreactSearch(query);
  return results;
}

// Catalog: movies / series listing via wpreact
async function getCatalogMovies(page = 1) {
  const cacheKey = `catalog:movies:${page}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/movies?page=${page}&per_page=20`;
    const res = await axios.get(url, AXIOS_CONFIG);
    const movies = res.data?.movies || res.data?.results || res.data?.data || [];
    const arr = Array.isArray(movies) ? movies : (Array.isArray(res.data) ? res.data : []);
    if (arr.length === 0) throw new Error('empty');
    setCache(cacheKey, arr);
    return arr;
  } catch (e) {
    try {
      const url = `${REACT_API}/archive?type=movies&page=${page}`;
      const res = await axios.get(url, AXIOS_CONFIG);
      const data = res.data?.data || res.data;
      if (Array.isArray(data) && data.length > 0) return data;
      throw new Error('empty2');
    } catch {
      if (!MOCK_ENABLED) return [];
      const perPage = 20;
      const start = (page - 1) * perPage;
      const slice = MOCK_MOVIES.slice(start, start + perPage);
      setCache(cacheKey, slice);
      return slice;
    }
  }
}

async function getCatalogSeries(page = 1) {
  const cacheKey = `catalog:series:${page}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/series?page=${page}&per_page=20`;
    const res = await axios.get(url, AXIOS_CONFIG);
    const series = res.data?.series || res.data?.movies || res.data?.results || [];
    const arr = Array.isArray(series) ? series : (Array.isArray(res.data) ? res.data : []);
    if (arr.length === 0) throw new Error('empty');
    setCache(cacheKey, arr);
    return arr;
  } catch (e) {
    try {
      const url = `${REACT_API}/archive?type=series&page=${page}`;
      const res = await axios.get(url, AXIOS_CONFIG);
      const data = res.data?.data || res.data;
      if (Array.isArray(data) && data.length > 0) return data;
      throw new Error('empty2');
    } catch {
      if (!MOCK_ENABLED) return [];
      const perPage = 20;
      const start = (page - 1) * perPage;
      const slice = MOCK_SERIES.slice(start, start + perPage);
      setCache(cacheKey, slice);
      return slice;
    }
  }
}

// Catalog: anime listing via wpreact (fallback react)
async function getCatalogAnime(page = 1) {
  const cacheKey = `catalog:anime:${page}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/animes?page=${page}&per_page=20`;
    const res = await axios.get(url, AXIOS_CONFIG);
    const raw = res.data?.animes || res.data?.anime || res.data?.movies || res.data?.results || res.data?.data;
    const arr = Array.isArray(raw) ? raw : (Array.isArray(res.data) ? res.data : []);
    if (arr.length === 0) throw new Error('empty');
    setCache(cacheKey, arr);
    return arr;
  } catch (e) {
    try {
      const url = `${REACT_API}/archive?type=animes&page=${page}`;
      const res = await axios.get(url, AXIOS_CONFIG);
      const data = res.data?.data || res.data;
      if (Array.isArray(data) && data.length > 0) {
        setCache(cacheKey, data);
        return data;
      }
      throw new Error('empty2');
    } catch {
      return [];
    }
  }
}

// Detail fetch via wpreact
async function getMovieDetail(slug) {
  const cacheKey = `movie:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/movie/${slug}`;
    const res = await axios.get(url, AXIOS_CONFIG);
    if (res.data && res.data.slug) {
      setCache(cacheKey, res.data);
      return res.data;
    }
    throw new Error('not found');
  } catch (e) {
    if (MOCK_ENABLED && MOCK_DETAILS[slug]) {
      setCache(cacheKey, MOCK_DETAILS[slug]);
      return MOCK_DETAILS[slug];
    }
    return null;
  }
}

async function getSerieDetail(slug) {
  const cacheKey = `serie:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/serie/${slug}`;
    const res = await axios.get(url, AXIOS_CONFIG);
    if (res.data && res.data.slug) {
      setCache(cacheKey, res.data);
      return res.data;
    }
    throw new Error('not found');
  } catch (e) {
    if (MOCK_ENABLED && MOCK_SERIE_DETAILS[slug]) {
      setCache(cacheKey, MOCK_SERIE_DETAILS[slug]);
      return MOCK_SERIE_DETAILS[slug];
    }
    return null;
  }
}

async function getAnimeDetail(slug) {
  const cacheKey = `anime:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${WPREACT_API}/anime/${slug}`;
    const res = await axios.get(url, AXIOS_CONFIG);
    if (res.data && res.data.slug) {
      setCache(cacheKey, res.data);
      return res.data;
    }
    throw new Error('not found');
  } catch (e) {
    return null;
  }
}

// Cinemeta helper to resolve IMDb -> title
// Se prueban varios hosts porque el principal a veces no responde.
const CINEMETA_HOSTS = [
  'https://v3-cinemeta.strem.io',
  'https://cinemeta-live.strem.io',
  'https://cinemeta.strem.io'
];

// Mock de Cinemeta: SÓLO con HACKTORRENT_MOCK=1
const MOCK_CINEMETA = {
  "tt0848228": { name: "The Avengers", releaseInfo: "2012", type: "movie" },
  "tt4154756": { name: "Avengers: Infinity War", releaseInfo: "2018", type: "movie" },
  "tt0417299": { name: "The Hummingbird Project", releaseInfo: "2019", type: "movie", originalTitle: "The Hummingbird Project" },
  "tt0111161": { name: "The Shawshank Redemption", releaseInfo: "1994", type: "movie" },
  "tt0903747": { name: "Breaking Bad", releaseInfo: "2008", type: "series" },
  "tt28088034": { name: "La noche del demonio: Están entre nosotros", releaseInfo: "2026", type: "movie" },
};

async function getCinemeta(type, imdbId) {
  const cacheKey = `cinemeta:${type}:${imdbId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const stremioType = type === 'series' ? 'series' : 'movie';

  for (const host of CINEMETA_HOSTS) {
    try {
      const url = `${host}/meta/${stremioType}/${encodeURIComponent(imdbId)}.json`;
      const res = await axios.get(url, { ...AXIOS_CONFIG, timeout: timeout(8000) });
      const meta = res.data?.meta;
      if (meta && meta.name) {
        setCache(cacheKey, meta, 6 * 60 * 60 * 1000);
        return meta;
      }
    } catch (e) {
      // probar el siguiente host
    }
  }

  if (MOCK_ENABLED && MOCK_CINEMETA[imdbId]) {
    setCache(cacheKey, MOCK_CINEMETA[imdbId], 30 * 60 * 1000);
    return MOCK_CINEMETA[imdbId];
  }

  return null;
}

function normalizeTitle(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(result, targetTitle, targetOrigTitle, year) {
  let score = 0;
  const rTitle = normalizeTitle(result.title);
  const rOrig = normalizeTitle(result.original_title);
  const tNorm = normalizeTitle(targetTitle);
  const tOrigNorm = targetOrigTitle ? normalizeTitle(targetOrigTitle) : '';

  if (rTitle === tNorm) score += 100;
  else if (rTitle.includes(tNorm) || tNorm.includes(rTitle)) score += 60;
  else {
    // token overlap
    const rTokens = rTitle.split(' ');
    const tTokens = tNorm.split(' ');
    const common = rTokens.filter(t => tTokens.includes(t)).length;
    score += (common / Math.max(rTokens.length, tTokens.length)) * 50;
  }
  if (rOrig && tNorm && rOrig === tNorm) score += 80;
  if (tOrigNorm && (rTitle === tOrigNorm || rOrig === tOrigNorm)) score += 70;
  // year proximity
  if (year && result.year) {
    const ry = parseInt(String(result.year).substring(0,4));
    const ty = parseInt(year);
    if (ry && ty) {
      if (ry === ty) score += 30;
      else if (Math.abs(ry - ty) <= 1) score += 10;
      else if (Math.abs(ry - ty) > 5) score -= 20;
    }
  }
  // boost if type matches expected (pelicula)
  return score;
}

/**
 * Encuentra el mejor resultado para un título/año/tipo.
 * Delegado en lib/match.js: aplica filtro estricto de tipo (una película nunca
 * se resuelve contra una serie), similitud de título/título original y año.
 * Devuelve null si no hay coincidencia suficientemente segura.
 */
function findBestMatch(results, targetTitle, targetYear, originalTitle = null, preferredType = null) {
  if (!results || results.length === 0) return null;
  const { best } = pickBestMatch(results, {
    title: targetTitle,
    originalTitle,
    year: targetYear,
    type: preferredType
  });
  return best;
}

// HTML scraping for series (fallback) using Axios + Cheerio
async function scrapeSeriesPage(slug) {
  const cacheKey = `scrape:serie:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${BASE_URL}/serie/${slug}/`;
    const res = await axios.get(url, HTML_AXIOS_CONFIG);
    const html = res.data;
    const $ = cheerio.load(html);

    // Extract metadata like title, poster from html if needed
    const title = $('h1').first().text().trim() || $('title').text().trim();
    // Torrents table parsing
    // The page contains multiple tables maybe per season. We need to detect.
    const torrents = [];

    // Approach: iterate over each h2/h3 that contains "Temporada" then next table
    // If no season headers, treat as single season 1
    let currentSeason = 1;
    // Find all tables that contain the header text "Formato"
    $('table').each((ti, table) => {
      const $table = $(table);
      const headerText = $table.find('th').text();
      if (!headerText.includes('Formato') && !headerText.includes('Tamaño')) return;

      // try to find preceding heading for season
      let season = currentSeason;
      // look backwards for heading containing Temporada or Saison
      let prev = $table.prevAll('h2, h3, h4, p, div').first();
      // also check parent prev
      if (prev.length) {
        const txt = prev.text();
        const m = txt.match(/Temporada\s*(\d+)/i) || txt.match(/Season\s*(\d+)/i);
        if (m) season = parseInt(m[1], 10);
      }
      // Alternative: search for text within table caption
      const caption = $table.find('caption').text();
      const capM = caption.match(/Temporada\s*(\d+)/i);
      if (capM) season = parseInt(capM[1], 10);

      $table.find('tbody tr').each((ri, row) => {
        const $row = $(row);
        const cells = $row.find('td');
        if (cells.length < 6) return;
        const numText = $(cells[0]).text().trim(); // # episode number
        const formato = $(cells[1]).text().trim(); // quality
        const tamano = $(cells[2]).text().trim();
        const subtitulos = $(cells[3]).text().trim();
        const idioma = $(cells[4]).text().trim();
        const fecha = $(cells[5]).text().trim();
        const accionesCell = $(cells[6]);
        // There may be 2 links: Descargar and Ver
        const descargarLink = accionesCell.find('a').first().attr('href') || accionesCell.find('a[href*=\"acortalink\"]')?.attr('href');
        // Fallback: get all anchors
        let magnetLink = null;
        let acortarUrl = null;
        accionesCell.find('a').each((ai, a) => {
          const href = $(a).attr('href');
          const txt = $(a).text().toLowerCase();
          if (txt.includes('descargar') || href?.includes('acortalink')) {
            acortarUrl = href;
          }
        });
        // If not found in that cell, look at row html
        if (!acortarUrl) {
          const rowHtml = $row.html();
          const m = rowHtml?.match(/https:\/\/acortalink\.net\/s\.php\?i=[^"'&]+/);
          if (m) acortarUrl = m[0];
        }

        const episode = parseInt(numText, 10);
        if (isNaN(episode)) return;

        torrents.push({
          season,
          episode,
          quality: formato,
          size: tamano,
          subs: subtitulos?.toLowerCase() === 'sí' || subtitulos?.toLowerCase() === 'si',
          language: idioma,
          date: fecha,
          acortarUrl,
          rawRow: $row.html()
        });
      });
      // if we detected season increment, update currentSeason for next table
      if (season >= currentSeason) currentSeason = season + 1;
    });

    // If no torrents found via table parsing, try alternative selector: look for any acortalink on page
    if (torrents.length === 0) {
      // fallback: find all acortalink anchors and try to infer quality from surrounding text
      $('a[href*=\"acortalink\"]').each((i, el) => {
        const href = $(el).attr('href');
        const row = $(el).closest('tr');
        if (row.length) {
          const cells = row.find('td');
          if (cells.length >= 2) {
            const numText = $(cells[0]).text().trim();
            const formato = $(cells[1]).text().trim();
            const tamano = $(cells[2]).text().trim();
            torrents.push({
              season: 1,
              episode: parseInt(numText,10) || 1,
              quality: formato || 'Unknown',
              size: tamano || '',
              subs: false,
              language: '',
              date: '',
              acortarUrl: href
            });
          }
        }
      });
    }

    const result = { title, torrents };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    // Mock fallback (sólo tests/sandbox)
    if (MOCK_ENABLED && (slug === 'breaking-bad' || slug === 'from')) {
      const mockTorrents = [
        { season: 1, episode: 1, quality: 'WEB-DL 1080p', size: '2.68 GB', subs: true, language: 'Latino/Inglés', date: '01/03/2024', acortarUrl: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Breaking.Bad.S01E01.1080p-Latino&xl=2877000000&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce' },
        { season: 1, episode: 2, quality: 'WEB-DL 1080p', size: '1.96 GB', subs: true, language: 'Latino/Inglés', date: '01/03/2024', acortarUrl: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Breaking.Bad.S01E02.1080p-Latino&xl=2100000000&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce' },
        { season: 2, episode: 1, quality: 'WEB-DL 1080p', size: '2.10 GB', subs: true, language: 'Latino/Inglés', date: '01/03/2024', acortarUrl: 'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Breaking.Bad.S02E01.1080p-Latino&xl=2250000000&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce' },
      ];
      // If slug is 'from', adjust dn
      if (slug === 'from') {
        mockTorrents.forEach(t => t.acortarUrl = t.acortarUrl.replace('Breaking.Bad','From'));
      }
      const mockResult = { title: slug === 'breaking-bad' ? 'Breaking Bad' : 'From', torrents: mockTorrents };
      setCache(cacheKey, mockResult);
      return mockResult;
    }
    return { title: null, torrents: [] };
  }
}

// Also scrape movie page for fallback (if wpreact movie missing downloads)
async function scrapeMoviePage(slug) {
  const cacheKey = `scrape:movie:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `${BASE_URL}/pelicula/${slug}/`;
    const res = await axios.get(url, HTML_AXIOS_CONFIG);
    const html = res.data;
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim();
    const torrents = [];
    $('table').each((ti, table) => {
      const $table = $(table);
      const header = $table.find('th').text();
      if (!header.includes('Formato')) return;
      $table.find('tbody tr').each((ri, row) => {
        const cells = $(row).find('td');
        if (cells.length < 6) return;
        const formato = $(cells[0]).text().trim();
        const idioma = $(cells[1]).text().trim();
        const fecha = $(cells[2]).text().trim();
        const tamano = $(cells[3]).text().trim();
        const subs = $(cells[4]).text().trim();
        const acciones = $(cells[5]);
        let acortarUrl = acciones.find('a[href*=\"acortalink\"]').attr('href') || acciones.find('a').attr('href');
        if (!acortarUrl) {
          const rowHtml = $(row).html();
          const m = rowHtml?.match(/https:\/\/acortalink\.net\/s\.php\?i=[^"'&]+/);
          if (m) acortarUrl = m[0];
        }
        torrents.push({
          quality: formato,
          language: idioma,
          date: fecha,
          size: tamano,
          subs: subs?.toLowerCase() === 'si' || subs?.toLowerCase() === 'sí',
          acortarUrl
        });
      });
    });
    const result = { title, torrents };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { title: null, torrents: [] };
  }
}

// Resolve acortalink.net to magnet via redirects and regex
async function resolveAcortalink(url) {
  if (!url) return null;
  // If already magnet, return directly - crucial for mock fallback where acortarUrl is already magnet
  if (url.startsWith('magnet:')) {
    // cache it for future
    const cacheKeyDirect = `resolve:${url}`;
    const cachedDirect = getCache(cacheKeyDirect);
    if (cachedDirect) return cachedDirect;
    setCache(cacheKeyDirect, url, 60 * 60 * 1000);
    return url;
  }

  const cacheKey = `resolve:${url}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    // First, try HEAD/GET following redirects
    const res = await axios.get(url, {
      ...HTML_AXIOS_CONFIG,
      timeout: timeout(8000),
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });
    // Check if final URL is magnet
    const finalUrl = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || url;
    if (finalUrl && finalUrl.startsWith('magnet:')) {
      setCache(cacheKey, finalUrl, 60 * 60 * 1000);
      return finalUrl;
    }
    // Check headers location
    if (res.headers?.location && res.headers.location.startsWith('magnet:')) {
      setCache(cacheKey, res.headers.location, 60 * 60 * 1000);
      return res.headers.location;
    }
    // Check body for magnet
    const body = typeof res.data === 'string' ? res.data : '';
    const magnetMatch = body.match(/magnet:\?xt=urn:btih:[^'"\s<>]+/);
    if (magnetMatch) {
      // need to decode html entities (&amp;)
      let magnet = magnetMatch[0].replace(/&amp;/g, '&');
      // also need to include trailing trackers that may be html encoded beyond match? Try broader
      // Sometimes magnet is inside href attribute
      setCache(cacheKey, magnet, 60 * 60 * 1000);
      return magnet;
    }
    // Also check for torrent file link
    const torrentMatch = body.match(/https?:\/\/[^'"\s]+\.torrent/);
    if (torrentMatch) {
      setCache(cacheKey, torrentMatch[0], 60 * 60 * 1000);
      return torrentMatch[0];
    }
    // Fallback: if response is JSON with download_link ?
    if (typeof res.data === 'object' && res.data?.download_link?.startsWith('magnet:')) {
      setCache(cacheKey, res.data.download_link, 60 * 60 * 1000);
      return res.data.download_link;
    }
    // Try to extract base64 decoded i param - sometimes it's double base64 + AES? But attempt simple base64 decode
    try {
      const u = new URL(url);
      const i = u.searchParams.get('i');
      if (i) {
        // try base64 decode
        const decoded = Buffer.from(i, 'base64').toString('utf-8');
        if (decoded.startsWith('magnet:') || decoded.includes('btih:')) {
          setCache(cacheKey, decoded, 60 * 60 * 1000);
          return decoded;
        }
        // sometimes double encoded
        const second = Buffer.from(decoded, 'base64').toString('utf-8');
        if (second.startsWith('magnet:')) {
          setCache(cacheKey, second, 60 * 60 * 1000);
          return second;
        }
      }
    } catch {}
    return null;
  } catch (e) {
    // console.error('resolveAcortalink fail', e.message)
    return null;
  }
}

// Helper to parse magnet infoHash and trackers
function parseMagnet(magnet) {
  try {
    const url = new URL(magnet);
    const xt = url.searchParams.get('xt'); // urn:btih:HASH
    const hash = xt ? xt.split(':').pop().toLowerCase() : null;
    const dn = url.searchParams.get('dn');
    const trackers = url.searchParams.getAll('tr');
    const xl = url.searchParams.get('xl');
    return { infoHash: hash, dn, trackers, xl };
  } catch {
    const m = magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z0-9]{32})/);
    return { infoHash: m ? m[1].toLowerCase() : null, dn: null, trackers: [], xl: null };
  }
}

// Map wpreact download to stremio stream format
function mapDownloadToStream(dl, titleFallback, opts = {}) {
  // dl: {quality, size, language, subs, download_link, date, season, episode}
  const magnet = dl.download_link;
  if (!magnet) return null;
  const parsed = parseMagnet(magnet);
  const infoHash = parsed.infoHash;
  const dn = parsed.dn || titleFallback;
  const quality = dl.quality || 'Unknown';
  const size = dl.size || '';
  const lang = dl.language || 'Latino';
  const subsStr = dl.subs ? 'Subs ✅' : 'Subs ❌';
  // Title formatting for Stremio (two lines)
  let prefix = `HackTorrent\n${quality}`;
  let titleLines = [];
  titleLines.push(`${dn || titleFallback}`);
  titleLines.push(`${quality} | ${size} | ${lang} | ${subsStr}`);
  if (dl.season && dl.episode) {
    titleLines.push(`S${String(dl.season).padStart(2,'0')}E${String(dl.episode).padStart(2,'0')}`);
  }
  // Add date
  if (dl.date) titleLines.push(`📅 ${dl.date}`);

  const stream = {
    name: prefix,
    title: titleLines.join('\n'),
    url: magnet,
  };
  // Provide infoHash as alternative for Stremio torrent clients
  if (infoHash) {
    stream.infoHash = infoHash;
    // trackers already in magnet, but also provide as array? Stremio uses magnet directly
  }
  // Provide behaviorHints for binge watching
  stream.behaviorHints = {
    bingeGroup: `hacktorrent-${quality.replace(/\s/g,'-').toLowerCase()}`,
    videoHash: infoHash ? `${infoHash}:${quality}` : undefined
  };
  // Add tag for quality detection
  return stream;
}

module.exports = {
  BASE_URL,
  WPREACT_API,
  REACT_API,
  AXIOS_CONFIG,
  HTML_AXIOS_CONFIG,
  searchHackTorrent,
  fetchWpreactSearch,
  fetchReactSearch,
  getCatalogMovies,
  getCatalogSeries,
  getCatalogAnime,
  getMovieDetail,
  getSerieDetail,
  getAnimeDetail,
  getCinemeta,
  findBestMatch,
  scrapeSeriesPage,
  scrapeMoviePage,
  resolveAcortalink,
  parseMagnet,
  mapDownloadToStream,
  normalizeTitle,
};
