# HackTorrent - Stremio Addon

Addon de Stremio que provee **catálogos** y **streams** desde [https://hacktorrent.cc/](https://hacktorrent.cc/) utilizando Web Scraping con **Axios** y **Cheerio**.

Soporta:
- 🎬 **Películas** (movie) - catálogo de novedades + búsqueda
- 📺 **Series** (series) - catálogo de series + episodios individuales
- 🍥 **Anime** (series) - catálogo de anime + ids `kitsu:`
- Streams vía **magnet links** con calidad `4K HDR`, `1080p`, `720p`, `DVDRip` y audio `Latino / Castellano / Inglés`

> **v1.5.0** — Despliegue en **Netlify Functions** (serverless, sin el "sleep" de Render):
> `netlify.toml` + `netlify/functions/addon.js`. Ver [Despliegue en Netlify](#-despliegue-en-netlify-v150).
> **v1.4.0** — Página web de **configuración** (`/configure`): idioma, fuentes, calidad,
> orden, packs y máximo de resultados. Ver [Configuración web](#-configuración-web-configure-v140).
> Fuentes: **HackTorrent** (Latino), **Knaben**, **Torrents.csv** y **The Black Hole Bay** (opcional).

---

## 📦 1. Estructura Inicial

```
hacktorrent-stremio-addon/
├── package.json         # Dependencias (stremio-addon-sdk, axios, cheerio)
├── manifest.json        # Configuración Stremio (catalogs + streams)
├── index.js             # Servidor principal con defineCatalogHandler / defineStreamHandler
├── lib/
│   ├── hacktorrent.js   # Catálogos (wpreact), Cinemeta, caché
│   ├── scraper.js       # Búsqueda + detalle (magnet/calidad/temporada/episodio)
│   ├── knaben.js        # Fuente en inglés: API pública v2 de Knaben
│   ├── torrentsCsv.js   # Torrents.csv: índice comunitario con API JSON
│   ├── theblackholebay.js # Fuente opcional: API REST de The Black Hole Bay
│   ├── release.js       # Reglas compartidas de filtrado de releases externos
│   ├── config.js        # Configuración válida + filtros/orden de los streams
│   ├── configPage.js    # Página HTML de /configure (sin dependencias)
│   ├── server.js        # Express: /configure, /health y el router del SDK
│   ├── timeouts.js      # Tope de timeouts HTTP (serverless)
│   └── match.js         # Emparejamiento por título/título original/año/tipo
├── netlify/
│   └── functions/
│       └── addon.js     # Función serverless (Express + serverless-http)
├── netlify.toml         # Build, función y rewrite /* → /configure, /manifest.json…
├── public/              # Placeholder de publish (el rewrite manda todo a la función)
├── test/                # Tests con node:test (sin red)
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
2. Pega: `http://127.0.0.1:7000/manifest.json` (si local) o la URL desplegada (ej. `https://tu-sitio.netlify.app/manifest.json`).
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

### Despliegue
- **Netlify (recomendado)**: ver [Despliegue en Netlify](#-despliegue-en-netlify-v150). No se duerme.
- **Render / VPS / Docker**: `npm start` con `PORT=7000`. En el plan gratuito de Render el
  servicio se suspende tras ~15 min sin tráfico: la primera petición de Stremio tarda
  decenas de segundos (o falla). Netlify no tiene ese problema.
- **Vercel**: funciona igual, pero usa [`api/index.js`](api/index.js) si lo añades; el
  adaptador de `netlify/functions/addon.js` sirve de referencia (es un evento distinto).

---

## ☁️ Despliegue en Netlify (v1.5.0)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/noe359866-code/Mi-stremio-Addon)

El addon corre como **una sola Netlify Function** (`netlify/functions/addon.js`) que envuelve
el mismo Express de `lib/server.js` con [`serverless-http`](https://github.com/dougmoscrop/serverless-http).
No hay proceso que se apague: Netlify sólo ejecuta la función cuando Stremio hace una petición.

```
https://TU-SITIO.netlify.app/configure            ← página de configuración
https://TU-SITIO.netlify.app/manifest.json        ← instalar en Stremio
https://TU-SITIO.netlify.app/health               ← estado
https://TU-SITIO.netlify.app/{config}/stream/...  ← recursos del addon
```

Las URLs son **idénticas** a las de Render: el rewrite de `netlify.toml` manda todo
(`/*`) a la función sin cambiar la ruta del navegador, así que las URLs ya instaladas
en Stremio se pueden reutilizar cambiando sólo el dominio.

### Pasos (desde GitHub, sin CLI)

1. Sube este repo a GitHub (o haz fork).
2. En Netlify: **Add new site → Import an existing project → GitHub** y elige el repo.
3. Netlify lee `netlify.toml`: build `npm ci --omit=dev || npm install --omit=dev`,
   publish `public`, functions `netlify/functions`. No cambies nada, sólo **Deploy**.
4. Cuando termine, abre `https://TU-SITIO.netlify.app/configure`, elige idioma/fuentes y
   pulsa **Instalar en Stremio** (o copia `https://TU-SITIO.netlify.app/manifest.json`).
5. Comprueba que responde: `https://TU-SITIO.netlify.app/health` → `{ "ok": true, ... }`.

> El nombre del sitio (`TU-SITIO`) se puede cambiar en **Site configuration → Change site name**;
> también puedes usar un dominio propio. La página de configuración usa `location.origin`,
> así que el enlace de instalación siempre apunta al dominio real.

### Probar en local con Netlify

```bash
npm install
npx netlify-cli dev        # equivale a: npm run dev:netlify
# http://localhost:8888/configure  (usa el rewrite real de netlify.toml)
```

El `npm start` de siempre (puerto 7000) sigue funcionando para desarrollo sin Netlify;
ambos caminos comparten `lib/server.js` y el mismo manifest.

### Qué cambia respecto a Render

| | Render (plan gratuito) | Netlify Functions |
| --- | --- | --- |
| Servicio dormido | Sí, ~15 min sin tráfico → arranque lento | No existe el "sleep" |
| Primera petición | 30–60 s (o timeout de Stremio) | Arranque en frío de ~0.3–1 s |
| Límite por petición | Sin límite práctico | 60 s (10 s en cuentas antiguas) |
| Caché en memoria | Persistente entre peticiones | Por instancia (se pierde al reciclarse) |
| Coste | Instancia siempre "reservada" | Cuota mensual de invocaciones |

### Timeouts: cómo se respeta el límite de Netlify

Una función serverless no puede quedarse colgada esperando a un scraper. Por eso:

- `lib/timeouts.js` recorta **todas** las peticiones salientes con `ADDON_HTTP_TIMEOUT_MS`
  (8 s en `netlify.toml`; en AWS Lambda el tope por defecto es 8000 ms).
- `netlify/functions/addon.js` tiene un presupuesto total (`NETLIFY_ADDON_DEADLINE_MS`, 9 s).
  Si se agota, responde **200 con la lista vacía** (`{ "streams": [] }`, `{ "metas": [] }`…)
  en lugar de un 504: Stremio muestra "sin resultados" y el resto de addons sigue funcionando.
- Las respuestas `.json` se cachean en el CDN de Netlify (`ADDON_CACHE_MAX_AGE`, 1 h).

### Variables de entorno (Netlify → Site configuration → Environment variables)

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `ADDON_HTTP_TIMEOUT_MS` | `8000` (Lambda) | tope de cada petición saliente (ms) |
| `NETLIFY_ADDON_DEADLINE_MS` | `9000` | presupuesto total por invocación (ms) |
| `ADDON_CACHE_MAX_AGE` | `3600` | segundos de caché CDN para catalog/stream/meta |
| `KNABEN_TIMEOUT` | `9000` | timeout propio de Knaben (se recorta con el tope) |
| `BLACKHOLEBAY_TIMEOUT` | `9000` | timeout propio de The Black Hole Bay |
| `BLACKHOLEBAY_ENABLED` | `0` | activa la tercera fuente por defecto |
| `HACKTORRENT_MOCK` | — | `1` para tests offline (nunca en producción) |

Cambiar una variable requiere **redeploy** (Deploys → Trigger deploy → Clear cache and deploy site).

### Problemas típicos en Netlify

- **`/.netlify/functions/addon` en la URL**: el rewrite no se aplicó. Revisa que
  `netlify.toml` esté en la raíz del repo y que el sitio se haya construido desde ese commit
  (el addon funciona igual, pero las URLs de Stremio serán las largas).
- **504 / timeout**: sube `ADDON_HTTP_TIMEOUT_MS` sólo si tu cuenta permite más de 10 s;
  si no, mantén 8000 y desactiva fuentes lentas (Knaben/TBB) en `/configure`.
- **"Page not found"**: publish está en `public/` y ese directorio debe existir (ya viene en
  el repo). Si lo borras, Netlify falla el deploy con `Deploy directory 'public' does not exist`.
- **Catálogo con datos viejos**: es el CDN. Baja `ADDON_CACHE_MAX_AGE` o haz
  "Clear cache and deploy" después de cambiar el código.

---

## ⚙️ Configuración web (/configure) (v1.4.0)

La configuración vive **en la propia URL** del addon (protocolo de configuración de Stremio),
así que no hace falta base de datos ni cuenta: cada URL = una configuración.

```
https://tu-addon.com/configure        ← página con el formulario
https://tu-addon.com/{configJSON}/manifest.json   ← addon ya configurado
```

La página (`/`) redirige a `/configure` y muestra:

| Opción | Valores | Efecto |
| --- | --- | --- |
| **Idioma del audio** | `ambos` · `latino` · `ingles` | filtra los streams por idioma (`Latino/Inglés` o `Dual` cuentan para ambos) |
| **Fuentes** | `ht` · `knaben` · `tcsv` (Torrents.csv) · `tbb` (Black Hole Bay) | activa sólo las que quieras; se consultan únicamente las seleccionadas |
| **Calidad mínima** | `cualquiera` · `720p` · `1080p` · `4k` | descarta calidad inferior |
| **Orden** | `latino` · `seeders` · `calidad` | orden de la lista de streams |
| **Máximo de resultados** | 10 / 20 / 25 / 40 / 60 | evita listas eternas |
| **Packs de temporada** | sí / no | si se desactivan, nunca se ofrece un pack en lugar del episodio |

Detalles de implementación:

- `lib/config.js` normaliza cualquier entrada (JSON, query string, alias como `language`/`sources`)
  y valida rangos: `max` se acota a 5–60 y las fuentes desconocidas se ignoran.
- Cada stream viaja internamente con un `_meta` (fuente, idioma, calidad, seeders, pack) que se
  usa para filtrar/ordenar y **se elimina antes de responder** a Stremio.
- Si el filtro de idioma o de calidad deja la lista vacía, se muestran todos los resultados
  (mejor VO que nada). Con los **packs** no hay excepción: si los desactivas, no aparecen.
- `/health` devuelve `{ ok, name, version }` para Render/UptimeRobot (en Netlify no hace
  falta un ping para mantenerlo despierto: no se duerme).
- Ejemplos de URL:

```text
/configure?idioma=latino&fuentes=ht
/configure?idioma=ingles&fuentes=knaben,tbb&calidad=1080p&orden=seeders&max=40
```

> El manifest declara `config` + `behaviorHints.configurable: true`, así que Stremio muestra el
> botón **Configure**. Al cambiar opciones hay que **reinstalar** con la nueva URL (Stremio
> guarda la URL completa, configuración incluida).

---

## 🌐 Fuentes de streams: HackTorrent, Knaben, Torrents.csv y Black Hole Bay

Además de HackTorrent (Latino/Dual), se pueden activar indexadores públicos adicionales.
Todos pasan por las reglas compartidas de `lib/release.js` (título como frase, año y SxxExx),
para evitar torrents de otra película o episodio.

| Fuente | Estado | API | Aporta |
| --- | --- | --- | --- |
| **HackTorrent** | activa | wpreact + HTML | Latino / Castellano / Dual |
| **Knaben** | activa (`KNABEN_ENABLED=1`) | `GET api.knaben.org/v2/search` | ~30 trackers y seeders reportados |
| **Torrents.csv** | activa por defecto (se puede desactivar en `/configure`) | `GET torrents-csv.com/service/search` | Índice comunitario, resultados por nombre/infohash |
| **The Black Hole Bay** | **desactivada** (`BLACKHOLEBAY_ENABLED=0`) | `GET theblackholebay.lol/api/search` | TPB + 1337x + YTS, crawler DHT y subidas de usuarios |

Torrents.csv está activada por defecto; se puede desactivar desde `/configure` o quitando `tcsv` de `fuentes`. Cada resultado
se filtra por título, año y episodio antes de crear un magnet con trackers de respaldo. Las
fuentes activas aparecen etiquetadas y se deduplican por `infoHash`.

### The Black Hole Bay (opcional)

```bash
BLACKHOLEBAY_ENABLED=1   # activarla
```

Detalles verificados de su API ([docs](https://theblackholebay.lol/api)):

- `GET /api/search?q=...&category=200` — sin autenticación; 120 peticiones/minuto/IP.
  `category` es numérica: **200 = vídeo** (por eso siempre se pide 200 y se acepta 200-299;
  los resultados vienen con subcódigo 207/208).
- Devuelve `name`, `info_hash`, `magnet`, `seeders`, `leechers`, `size`, `sizeLabel`,
  `source` (TPB, 1337x, YTS, DHT, User_Upload). No hay `year` ni temporada: el filtrado
  se hace sobre el nombre del release.
- **Por qué está desactivada por defecto:**
  1. **Se solapa mucho con Knaben**: los mismos torrents de TPB con el mismo `infoHash`
     (YIFY/GalaxyRG, etc.). Añadiría poco y multiplicaría las peticiones.
  2. Su portada muestra *“LIVE API UNAVAILABLE – SERVING FROM LOCAL INDEX”* cuando el índice
     remoto falla; en ese modo responde desde un índice local pequeño y más antiguo.
  3. En series devuelve sobre todo **packs de temporada**; los episodios sueltos escasean
     (con el filtro estricto eso significa “sin resultados” más a menudo).
  4. La respuesta es **muy pesada** (magnets con decenas de trackers): se limita a
     `BLACKHOLEBAY_MAX_BYTES` (8 MB) para no consumir memoria.
- Lo que sí aporta: magnets descubiertos por **DHT** y subidas de usuarios que no aparecen
  en Knaben, y una alternativa si Knaben te limita por IP.

### Variables de entorno de las fuentes externas

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `KNABEN_ENABLED` | `1` | `0` desactiva Knaben |
| `KNABEN_API` | `https://api.knaben.org/v2` | base de la API |
| `KNABEN_LIMIT` | `15` | máximo de streams de Knaben por consulta |
| `KNABEN_PAGE_SIZE` | `60` | resultados pedidos a la API (máx. 150) |
| `KNABEN_TIMEOUT` | `9000` | timeout en ms |
| `KNABEN_MIN_INTERVAL_MS` | `400` | espaciado mínimo entre peticiones |
| `TORRENTS_CSV_ENABLED` | `1` | `0` desactiva Torrents.csv a nivel de servidor |
| `TORRENTS_CSV_API` | `https://torrents-csv.com` | URL base de la API |
| `TORRENTS_CSV_LIMIT` | `15` | máximo de streams de esta fuente |
| `TORRENTS_CSV_PAGE_SIZE` | `80` | resultados pedidos a la API (máx. 100) |
| `TORRENTS_CSV_TIMEOUT` | `9000` | timeout en ms |
| `BLACKHOLEBAY_ENABLED` | `0` | `1` activa The Black Hole Bay |
| `BLACKHOLEBAY_API` | `https://theblackholebay.lol/api` | base de la API |
| `BLACKHOLEBAY_LIMIT` | `10` | máximo de streams de esta fuente |
| `BLACKHOLEBAY_TIMEOUT` | `9000` | timeout en ms |
| `BLACKHOLEBAY_MAX_BYTES` | `8388608` | tamaño máximo de respuesta |
| `BLACKHOLEBAY_MIN_INTERVAL_MS` | `300` | espaciado mínimo entre peticiones |

> Knaben y The Black Hole Bay aportan sobre todo contenido **en inglés (VO)**; Torrents.csv
> puede incluir varios idiomas, inferidos del nombre del release. Se pueden añadir subtítulos con
> un addon tipo OpenSubtitles. HackTorrent aparece primero cuando hay resultados Latino.

---

## 🎯 Corrección de torrents equivocados (v1.1.0)

**Síntoma:** en series, anime y algunas películas el addon abría otro título u otro episodio.

**Causas encontradas y corregidas:**

1. **Fallback `resultados[0]`** — si el emparejamiento no encontraba nada, el handler tomaba el
   primer resultado de la búsqueda sin importar el título. Ahora, si no hay coincidencia segura,
   se devuelven `streams: []` (mejor sin streams que con contenido ajeno).
2. **Datos MOCK siempre activos** — cuando hacktorrent.cc fallaba o daba timeout, el scraper
   devolvía "El Proyecto Colibrí"/"Avengers" inventados con un filtro por palabras sueltas
   (`query.includes(titulo.split(' ')[0])`). Esa era la vía típica del "torrent de otra peli".
   Los mocks ahora sólo se activan con `HACKTORRENT_MOCK=1` (tests/sandbox).
3. **Scraping HTML devolvía la home** — si `?s=` no filtraba, se devolvían los 5 primeros
   títulos de la portada. Ahora se exige coincidencia real de tokens con la búsqueda.
4. **El tipo no se respetaba** — `findBestMatch()` tenía el filtro de tipo vacío, así que una
   película podía resolverse contra una serie del mismo nombre (y al revés). Ahora el tipo es
   un filtro estricto: `movie → pelicula`, `series → serie | anime`.
5. **Año ignorado** — "The Avengers" (2012) podía caer en "Infinity War" (2018). Ahora se puntúa
   título + título original + año (el sitio guarda títulos en español, por eso también se compara
   `original_title`) y se descarta contenido con más de 1 año de diferencia.
6. **Episodios de series** — si no había coincidencia de SxxExx, se devolvían **todos** los
   episodios. Ahora se devuelve sólo el episodio pedido; si no existe, se intenta un pack de esa
   temporada y, si tampoco hay, se prueba el siguiente candidato y finalmente se devuelve vacío.
7. **Temporada/episodio mal leídos** — se detecta la temporada por encabezado/contenedor de la
   tabla y el episodio por la columna `#`, la fila o el nombre del magnet (`...S02E05...`).
   La API se recorre de forma recursiva, así que también funciona con respuestas anidadas
   (`seasons → episodes → downloads`) o con mapas de calidad (`{"1080p": "magnet:..."}`).
8. **Anime** — se prueban los endpoints `serie` y `anime` para el mismo slug, hay catálogo
   "HackTorrent - Anime" y, si llega un id `kitsu:`, el título se resuelve vía API de Kitsu.
9. **Meta handler** — usaba `id.split(':')[0]` (devolvía "ht" en lugar del slug) y los episodios
   se generaban con `episode: [n]`; corregido para que la ficha y los episodios sean navegables.

**Cómo verificarlo (sin red, con la API simulada):**

```bash
npm test
```

Cubre: elección por año entre secuelas, rechazo de tipo incorrecto, episodio exacto en series,
temporada/episodio leídos del magnet, detección de temporadas en HTML, formas anidadas de la API
y que un título parecido de otro año devuelva vacío en vez de contenido ajeno.

> Tras actualizar el addon, **desinstálalo y vuelve a instalarlo** en Stremio (o reinicia el
> servidor) para que el nuevo `manifest.json` (v1.1.0) y el catálogo de Anime se registren.

---

### Solución de problemas

| Síntoma | Qué revisar |
| --- | --- |
| No aparecen streams nuevos de `Knaben` | el hosting debe permitir salir a `api.knaben.org`; prueba `curl "https://api.knaben.org/v2/search?q=test&s=1"` |
| Sólo veo resultados en inglés | HackTorrent no tiene ese título en Latino; prueba `KNABEN_LIMIT=25` para ver más opciones |
| Quiero desactivar Knaben | `KNABEN_ENABLED=0` |
| Quiero activar The Black Hole Bay | `BLACKHOLEBAY_ENABLED=1` |
| Cambié opciones y no se aplican | reinstala el addon con la nueva URL de `/configure` (la config va en la URL) |
| La página `/configure` no carga | el servidor debe escuchar en `0.0.0.0` (ya es el comportamiento por defecto) y permitir el dominio del proxy |
| TBB no devuelve episodios sueltos | normal: su índice tiene sobre todo packs; usa Knaben para episodios |
| Muchos `429` en logs | sube `KNABEN_MIN_INTERVAL_MS` (p. ej. `1000`) |
| Sigo viendo un título equivocado | revisa el **nombre del release** en el stream: si no coincide, manda el `id` (tt…/kitsu…) y temporada/episodio |

---

## ⚠️ Notas Legales
Solo para fines educativos. Verifica derechos de distribución en tu jurisdicción. Este addon no aloja contenido:
solo enlaza magnets públicos indexados por HackTorrent.cc y por Knaben (meta-indexer de trackers públicos).

