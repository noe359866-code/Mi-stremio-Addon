const axios = require('axios');
const cheerio = require('cheerio');


const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MY_VIEW_KEY = "r-eXUxP-hmdv-5_TnUkTRmDqFoyNVBhtazfpzqh53rA";

const AXIOS_CONFIG = {
    timeout: 6000,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
    }
};


exports.handler = async (event) => {
    try {
        const path = event.path;

        // Servir Manifiesto
        if (path.endsWith('manifest.json')) {
            return response(200, require('./manifest.json'));
        }

        // Manejo de Streams
        if (path.includes('/stream/movie/')) {
            const imdbId = path.match(/tt\d+/)?.[0];
            if (!imdbId) return response(400, { error: "ID no válido" });

            // 1. Obtener info de TMDB (Necesitamos el ID numérico para tu View Key)
            const movie = await getMovieInfo(imdbId);
            if (!movie) return response(404, { streams: [] });

            const streams = [];

          
            const vimeusUrl = `https://vimeus.com/e/movie?tmdb=${movie.id}&view_key=${MY_VIEW_KEY}&theme=minimal&loader=v3`;
            streams.push({
                name: "REBZYYX\nDIRECTO",
                title: `${movie.title}\n[Vimeos] Latino HD`,
                externalUrl: vimeusUrl
            });

         
            try {
                const searchTitle = encodeURIComponent(movie.title.replace(/[^\w\s]/gi, ''));
                const scraped = await fetchScrapedStreams(searchTitle);
                streams.push(...scraped);
            } catch (err) {
                console.error("Scraping fallback failed");
            }

            return response(200, { streams });
        }

        return response(404, { error: "Not Found" });
    } catch (err) {
        return response(500, { error: "Internal Server Error" });
    }
};



async function fetchScrapedStreams(title) {
    const sources = [
        { name: "Cuevana", url: `https://cuevana.gs/wp-json/wp/v2/posts?search=${title}` },
        { name: "La Movie", url: `https://la.movie/wp-json/wp/v2/posts?search=${title}` }
    ];

    const streams = [];
    const results = await Promise.allSettled(sources.map(s => axios.get(s.url, AXIOS_CONFIG)));

    for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'fulfilled' && res.value.data?.[0]) {
            const pageUrl = res.value.data[0].link;
            const videoLink = await extractVideoLink(pageUrl);
            if (videoLink) {
                streams.push({
                    name: `REBZYYX\n${sources[i].name}`,
                    title: `${res.value.data[0].title.rendered}\nLatino HD (Scraped)`,
                    externalUrl: videoLink
                });
            }
        }
    }
    return streams;
}

async function extractVideoLink(url, depth = 0) {
    if (depth > 1 || !url) return null; // Depth 1 para no agotar el tiempo de Netlify
    try {
        const res = await axios.get(url, AXIOS_CONFIG);
        const html = res.data;
        const $ = cheerio.load(html);

        
        const iframes = $("iframe").map((_, el) => $(el).attr("src")).get();
        for (let src of iframes) {
            if (src.includes('vimeus') || src.includes('vimeos') || src.includes('voe')) return src;
        }

     
        const patterns = [/https?:\/\/(vimeos\.net|vimeus\.com|voe\.sx|streamwish\.to)\/[^"' ]+/i];
        for (let reg of patterns) {
            const match = html.match(reg);
            if (match) return match[0];
        }
    } catch { return null; }
}



async function getMovieInfo(imdbId) {
    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await axios.get(url, AXIOS_CONFIG);
        return res.data?.movie_results?.[0] || null;
    } catch { return null; }
}

function response(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(body)
    };
}
