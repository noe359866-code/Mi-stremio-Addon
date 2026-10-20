# HackTorrent - Stremio Addon

Addon de Stremio que provee **catálogos** y **streams** desde [https://hacktorrent.cc/](https://hacktorrent.cc/) utilizando Web Scraping con **Axios** y **Cheerio**.

Soporta:
- 🎬 **Películas** (movie) - catálogo de novedades + búsqueda
- 📺 **Series** (series) - catálogo de series + episodios individuales
- Streams vía **magnet links** con calidad `4K HDR`, `1080p`, `720p`, `DVDRip` y audio `Latino / Castellano / Inglés`

---

## 📦 1. Estructura Inicial

```
hacktorrent-stremio-addon/
├── package.json         # Dependencias (stremio-addon-sdk, axios, cheerio)
├── manifest.json        # Configuración Stremio (catalogs + streams)
├── index.js             # Servidor principal con defineCatalogHandler / defineStreamHandler
├── lib/
│   └── hacktorrent.js   # Lógica de scraping (Axios + Cheerio) + API wpreact
└── README.md
```

### `package.json`
```json
{
  "name": "hacktorrent-stremio-addon",
  "version": "1.0.0",
  "dependencies": {
    "axios": "^1.7.2",
    "cheerio": "^1.0.0-rc.12",
    "stremio-addon-sdk": "^1.8.6"
  }
}
```

### `manifest.json`
- `resources`: `["catalog", "stream", "meta"]`
- `types`: `["movie", "series"]`
- `idPrefixes`: `["tt", "ht"]` (IMDb ID + hacktorrent slug)
- 2 catálogos:
  - `hacktorrent-peliculas` (type: movie)
  - `hacktorrent-series` (type: series)
  - Ambos soportan `extra: search` y `skip` (paginación)

---

## 🔍 2. Código de Web Scraping (Axios + Cheerio)

**Archivo:** `lib/hacktorrent.js`

### Fuente principal: API JSON `wpreact`
HackTorrent expone una API JSON no documentada:

- `https://hacktorrent.cc/wp-json/wpreact/v1/search?query=Avengers` → búsqueda
- `https://hacktorrent.cc/wp-json/wpreact/v1/movies?page=1` → catálogo películas
- `https://hacktorrent.cc/wp-json/wpreact/v1/series?page=1` → catálogo series
- `https://hacktorrent.cc/wp-json/wpreact/v1/movie/{slug}` → detalle película con `downloads: [{quality, size, language, download_link: magnet}]`
- `https://hacktorrent.cc/wp-json/wpreact/v1/anime/{slug}` → anime con `season/episode` + magnet

**Extracción directa (sin acortalink):**
```javascript
const res = await axios.get(`${WPREACT_API}/movie/${slug}`, AXIOS_CONFIG);
const magnet = res.data.downloads[0].download_link;
// magnet:?xt=urn:btih:...&dn=...&tr=...
```

### Fallback Scraping HTML (series antiguas)
Para series como `breaking-bad` o `from` la API no devuelve `downloads`, se hace scraping de `https://hacktorrent.cc/serie/{slug}/`:

```javascript
const res = await axios.get(`${BASE_URL}/serie/${slug}/`, HTML_AXIOS_CONFIG);
const $ = cheerio.load(res.data);

$('table').each((i, table) => {
  // | # | Formato | Tamaño | Subtítulos | Idioma | Fecha | Acciones |
  $(table).find('tbody tr').each((j, row) => {
    const cells = $(row).find('td');
    const calidad = $(cells[1]).text().trim(); // WEB-DL 1080p
    const acortarUrl = $(cells[6]).find('a[href*="acortalink"]').attr('href');
    // https://acortalink.net/s.php?i=VTJGc2RHVmtY...
  });
});
```

### Resolución de `acortalink.net` → magnet
```javascript
async function resolveAcortalink(url) {
  const res = await axios.get(url, { maxRedirects: 5 });
  // Buscar magnet en body o en Location header
  const magnet = res.data.match(/magnet:\?xt=urn:btih:[^"'\s]+/);
  return magnet[0].replace(/&amp;/g, '&');
}
```

---

## 🚀 3. Archivo Principal `index.js`

### Manejador de Catálogos
Muestra últimas novedades o resultados de búsqueda:

```javascript
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra?.search;
  if (search) {
    const results = await HT.searchHackTorrent(search);
    const metas = results.map(r => toMetaPreview(r, type));
    return { metas };
  }
  if (type === 'movie' && id === 'hacktorrent-peliculas') {
    const movies = await HT.getCatalogMovies(page);
    return { metas: movies.map(m => toMetaPreview(m, 'movie')) };
  }
  // similar para series
});
```

### Manejador de Streams (`defineStreamHandler`)
Dado un **IMDb ID** (`tt1234567` o `tt1234567:1:2` para series):

1. Resuelve título vía **Cinemeta**: `https://v3-cinemeta.strem.io/meta/movie/tt1234567.json`
2. Busca en HackTorrent: `searchHackTorrent(título)` → encuentra mejor `slug` por similitud + año
3. Obtiene `downloads` del slug:
   - Películas: `getMovieDetail(slug)` → magnets directos
   - Series: `getSerieDetail(slug)` + fallback `scrapeSeriesPage(slug)` → resuelve acortalinks
4. Devuelve streams con calidad:

```javascript
builder.defineStreamHandler(async ({ type, id }) => {
  // id = tt0111161 o tt0944947:1:2
  const [imdb, season, episode] = id.split(':');
  const meta = await HT.getCinemeta(type, imdb);
  const results = await HT.searchHackTorrent(meta.name);
  const best = HT.findBestMatch(results, meta.name, meta.releaseInfo);
  const streams = await getStreamsForSlug(best.slug, type, season, episode);
  return { streams };
});
```

**Formato de streams:**
```javascript
{
  name: "HackTorrent\nWEB-DL 1080p",
  title: "El Proyecto Colibrí\nWEB-DL 1080p | 3.70 GB | Latino | Subs ✅",
  url: "magnet:?xt=urn:btih:...",
  behaviorHints: { bingeGroup: "hacktorrent-web-dl-1080p" }
}
```

---

## 🧪 4. Instrucciones para Probar (con subtítulos)

### Instalación local
```bash
git clone https://github.com/noe359866-code/Mi-stremio-Addon.git
cd Mi-stremio-Addon
npm install
npm start
# Addon disponible en http://localhost:7000/manifest.json
```

### Instalar en Stremio (Desktop / Android / Web)
1. Abre **Stremio** → Addons (puzzle icon) → **Addon URL** (arriba).
2. Pega: `http://127.0.0.1:7000/manifest.json` (si local) o la URL desplegada (ej. `https://tu-dominio.vercel.app/manifest.json`).
3. Click **Install**.

### Probar catálogos
- Ve a **Discover** → verás **HackTorrent - Películas** y **HackTorrent - Series** en la lista de catálogos.
- Prueba búsqueda: en Discover escribe `Avengers` → debe devolver `Avengers: Los Vengadores`, `Avengers: Infinity War`, etc.

### Probar streams
1. Abre cualquier película/serie (ej. **Avengers: Los Vengadores** `tt0848228` o **Breaking Bad** `tt0903747`).
2. Click **Play** → Stremio mostrará los streams de HackTorrent con etiquetas:
   ```
   HackTorrent
   WEB-DL 4K HDR | 18.2 GB | Latino
   ```
3. Elige la calidad deseada (1080p, 720p, etc.). Stremio abrirá el torrent vía WebTorrent o reproductor externo.

### Probar junto a addon de subtítulos
1. Instala **OpenSubtitles Official** desde la lista comunitaria de addons:
   - Addons → Community → busca `OpenSubtitles` → Install.
2. Abre la misma película/serie con streams de HackTorrent.
3. Durante reproducción, activa subtítulos: `CC` → elige idioma (Español, English).
4. Stremio combinará automáticamente el stream de HackTorrent + subtítulos de OpenSubtitles.

> **Nota:** HackTorrent ya provee contenido en Latino con subs disponibles (`Subs ✅`), pero el addon de subtítulos te permite descargar subtítulos externos adicionales.

### Despliegue opcional
- **Vercel / Netlify**: haz `vercel --prod` o conecta repo a Netlify. Usa `index.js` como serverless function si lo prefieres.
- **PORT**: Configura `PORT=7000` como variable de entorno si despliegas en contenedor.

---

## ⚠️ Notas Legales
Solo para fines educativos. Verifica derechos de distribución en tu jurisdicción. Este addon no aloja contenido, solo enlaza magnets públicos indexados por HackTorrent.cc.

