/**
 * lib/config.js
 * ---------------------------------------------------------------------------
 * Configuración del addon UniverTorrent (página web /configure).
 *
 * Stremio pasa la configuración como un segmento de la URL:
 *   /<configJSON>/manifest.json
 *   /<configJSON>/stream/movie/tt0848228.json
 *
 * El objeto `config` llega ya parseado al handler. Aquí se NORMALIZA y se
 * aplica a los streams (idioma, fuentes, calidad mínima, orden, packs, máximo).
 *
 * Forma canónica (compacta para que la URL no se dispare):
 *   { idioma: 'ambos'|'latino'|'ingles',
 *     fuentes: 'ht,knaben[,tbb][,tcsv]',
 *     calidad: 'cualquiera'|'720p'|'1080p'|'4k',
 *     orden:   'latino'|'seeders'|'calidad',
 *     max:     25,
 *     packs:   true }
 * ---------------------------------------------------------------------------
 */

'use strict';

const { extraerInfoHash, construirSources } = require('./release');

const DEFAULTS = Object.freeze({
  idioma: 'ambos',
  fuentes: 'ht,knaben,tcsv',
  calidad: 'cualquiera',
  orden: 'latino',
  max: 25,
  packs: true
});

// Perfiles preconfigurados para Español, Inglés y Universal (Ambos)
const PERFILES_IDIOMA = Object.freeze({
  es: Object.freeze({
    idioma: 'latino',
    fuentes: 'ht,pp,ss,dt,mt,wt',
    calidad: 'cualquiera',
    orden: 'latino',
    max: 25,
    packs: true
  }),
  en: Object.freeze({
    idioma: 'ingles',
    fuentes: 'knaben,tcsv',
    calidad: 'cualquiera',
    orden: 'seeders',
    max: 25,
    packs: true
  }),
  ambos: DEFAULTS
});

// Host / origen externo opcional (sólo si se despliega en un dominio dedicado y se configura por entorno)
const BEAMUP_HOST = String(process.env.BEAMUP_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const BEAMUP_ORIGIN = String(
  process.env.BEAMUP_ORIGIN || process.env.PUBLIC_ADDON_URL || (BEAMUP_HOST ? `https://${BEAMUP_HOST}` : '')
).trim().replace(/\/+$/, '');

// Fuentes marcadas por defecto en la interfaz /configure y cuando no se especifica `fuentes` explícitamente
const FUENTES_UI_POR_DEFECTO = 'ht,pp,ss,dt,mt,wt,knaben,tcsv';

// Claves internas de fuente aceptadas (con alias neutros es1..es6, en1..en3 y de grupo espanol/ingles/todas)
const FUENTES_VALIDAS = ['ht', 'pp', 'ss', 'dt', 'mt', 'wt', 'knaben', 'tbb', 'tcsv'];
const FUENTES_HISPANAS_ADICIONALES = new Set(['pp', 'ss', 'dt', 'mt', 'wt']);
const FUENTES_ALIAS = {
  ht: 'ht', hacktorrent: 'ht', hack: 'ht', es1: 'ht', 'servidor-es-1': 'ht',
  pp: 'pp', pelispanda: 'pp', 'pelis-panda': 'pp', panda: 'pp', es2: 'pp', 'servidor-es-2': 'pp',
  ss: 'ss', sinsitio: 'ss', 'sin-sitio': 'ss', 'sinsitio.site': 'ss', es3: 'ss', 'servidor-es-3': 'ss',
  dt: 'dt', divxtotal: 'dt', 'divx-total': 'dt', 'divxtotal.foo': 'dt', es4: 'dt', 'servidor-es-4': 'dt',
  mt: 'mt', mejortorrent: 'mt', 'mejor-torrent': 'mt', 'mejortorrent.eu': 'mt', es5: 'mt', 'servidor-es-5': 'mt',
  wt: 'wt', wolftorrent: 'wt', 'wolf-torrent': 'wt', wolfmax4k: 'wt', 'wolftorrent.com': 'wt', es6: 'wt', 'servidor-es-6': 'wt',
  knaben: 'knaben', knb: 'knaben', en1: 'knaben', 'servidor-en-1': 'knaben',
  tcsv: 'tcsv', torrentscsv: 'tcsv', 'torrents-csv': 'tcsv', 'torrents.csv': 'tcsv', en2: 'tcsv', 'servidor-en-2': 'tcsv',
  tbb: 'tbb', blackholebay: 'tbb', 'black-hole-bay': 'tbb', theblackholebay: 'tbb', en3: 'tbb', 'servidor-en-3': 'tbb'
};

const FUENTES_GRUPOS = {
  todas: ['ht', 'knaben', 'tcsv'],
  all: ['ht', 'knaben', 'tcsv'],
  ambos: ['ht', 'knaben', 'tcsv'],
  both: ['ht', 'knaben', 'tcsv'],
  espanol: ['ht', 'pp', 'ss', 'dt', 'mt', 'wt'],
  es: ['ht', 'pp', 'ss', 'dt', 'mt', 'wt'],
  latino: ['ht', 'pp', 'ss', 'dt', 'mt', 'wt'],
  spanish: ['ht', 'pp', 'ss', 'dt', 'mt', 'wt'],
  ingles: ['knaben', 'tcsv'],
  en: ['knaben', 'tcsv'],
  english: ['knaben', 'tcsv']
};

const IDIOMAS = ['ambos', 'latino', 'ingles'];
const IDIOMA_ALIAS = {
  ambos: 'ambos',
  both: 'ambos',
  all: 'ambos',
  todos: 'ambos',
  universal: 'ambos',
  bilingue: 'ambos',
  bilingual: 'ambos',
  'es-en': 'ambos',
  'en-es': 'ambos',
  latino: 'latino',
  espanol: 'latino',
  es: 'latino',
  spanish: 'latino',
  castellano: 'latino',
  hispano: 'latino',
  ingles: 'ingles',
  en: 'ingles',
  english: 'ingles',
  vo: 'ingles',
  vose: 'ingles'
};

const CALIDADES = ['cualquiera', '720p', '1080p', '4k'];
const CALIDAD_ALIAS = {
  cualquiera: 'cualquiera',
  any: 'cualquiera',
  all: 'cualquiera',
  todas: 'cualquiera',
  '720': '720p',
  '720p': '720p',
  hd: '720p',
  '1080': '1080p',
  '1080p': '1080p',
  fullhd: '1080p',
  fhd: '1080p',
  '4k': '4k',
  '2160': '4k',
  '2160p': '4k',
  uhd: '4k'
};

const ORDENES = ['latino', 'seeders', 'calidad'];
const ORDEN_ALIAS = {
  latino: 'latino',
  espanol: 'latino',
  es: 'latino',
  spanish: 'latino',
  language: 'latino',
  idioma: 'latino',
  seeders: 'seeders',
  seeds: 'seeders',
  peers: 'seeders',
  calidad: 'calidad',
  quality: 'calidad'
};

const RANGO_CALIDAD = { desconocida: 3, sd: 2, '480p': 2, '720p': 3, '1080p': 4, '4k': 5 };
const RANGO_CALIDAD_MIN = { cualquiera: 0, '720p': 3, '1080p': 4, '4k': 5 };

function sinAcentos(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarBooleano(valor, porDefecto = true) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  const s = String(valor).toLowerCase().trim();
  if (['1', 'true', 'si', 'sí', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
  return porDefecto;
}

/** Normaliza la lista de fuentes (array, csv, alias de grupo o booleans por clave). */
function normalizarFuentes(valor) {
  if (valor === undefined || valor === null || valor === '') return DEFAULTS.fuentes;

  let lista = [];
  if (Array.isArray(valor)) {
    lista = valor;
  } else if (typeof valor === 'object') {
    lista = Object.keys(valor).filter(k => normalizarBooleano(valor[k], false));
  } else {
    lista = String(valor).split(/[,;|+\s]+/);
  }

  const vistas = new Set();
  for (const item of lista) {
    const token = sinAcentos(item).trim();
    if (!token) continue;
    if (FUENTES_GRUPOS[token]) {
      for (const f of FUENTES_GRUPOS[token]) vistas.add(f);
      continue;
    }
    const clave = FUENTES_ALIAS[token];
    if (clave) vistas.add(clave);
  }

  // Si el usuario no deja ninguna, al menos la fuente principal en español (addon siempre útil)
  if (vistas.size === 0) return 'ht';
  return FUENTES_VALIDAS.filter(f => vistas.has(f)).join(',');
}

function normalizarEnum(valor, permitidos, porDefecto, mapaAlias = null) {
  const s = sinAcentos(valor).trim();
  if (!s) return porDefecto;
  if (mapaAlias && mapaAlias[s]) return mapaAlias[s];
  const candidatos = [s, `${s}p`];
  for (const c of candidatos) {
    if (permitidos.includes(c)) return c;
  }
  return porDefecto;
}

/**
 * Convierte una entrada arbitraria (objeto, JSON, JSON URL-encoded, query string o atajo 'es'/'en')
 * en un objeto plano sin normalizar para inspeccionar claves explícitas.
 */
function parsearEntradaConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};

  let texto = raw.trim();
  if (!texto) return {};

  // Decodificar hasta 2 capas de %XX por si llega codificado desde URL o proxy
  for (let i = 0; i < 2 && texto.includes('%'); i++) {
    try {
      const dec = decodeURIComponent(texto);
      if (dec === texto) break;
      texto = dec.trim();
    } catch {
      break;
    }
  }

  const limpio = sinAcentos(texto).trim();
  if (limpio === 'es' || limpio === 'espanol' || limpio === 'spanish') {
    return { ...PERFILES_IDIOMA.es, ui: 'es' };
  }
  if (limpio === 'en' || limpio === 'english' || limpio === 'ingles') {
    return { ...PERFILES_IDIOMA.en, ui: 'en' };
  }

  if (texto.startsWith('{')) {
    try {
      const parsed = JSON.parse(texto);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Continuar con fallback clave=valor
    }
  }

  // Soporte de rutas estilo clave=valor&clave2=valor2 o clave=valor|clave2=valor2
  if (texto.includes('=')) {
    const queryNorm = texto.replace(/\|/g, '&');
    const params = new URLSearchParams(queryNorm);
    const obj = {};
    for (const [k, v] of params.entries()) {
      if (k) obj[k] = v;
    }
    if (Object.keys(obj).length > 0) return obj;
  }

  return {};
}

/** Indica si el usuario/URL especificó explícitamente el campo `fuentes` / `sources`. */
function tieneFuentesExplicitas(raw) {
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, '_fuentesExplicitas')) {
    return Boolean(raw._fuentesExplicitas);
  }
  const entrada = parsearEntradaConfig(raw);
  const valor = entrada.fuentes ?? entrada.sources;
  return valor !== undefined && valor !== null && String(valor).trim() !== '';
}

/**
 * Detecta el idioma de interfaz ('es' o 'en') a partir de la configuración.
 */
function resolverIdiomaUI(raw) {
  if (typeof raw === 'string') {
    const limpio = sinAcentos(raw).trim();
    if (limpio === 'en' || limpio === 'english' || limpio === 'ingles') return 'en';
    if (limpio === 'es' || limpio === 'espanol' || limpio === 'spanish' || limpio === 'latino') return 'es';
  }
  const entrada = parsearEntradaConfig(raw);
  const uiRaw = sinAcentos(entrada.ui ?? entrada.uiLang ?? entrada.interfaz ?? entrada.locale ?? '').trim();
  if (uiRaw === 'en' || uiRaw === 'english' || uiRaw === 'ingles') return 'en';
  if (uiRaw === 'es' || uiRaw === 'espanol' || uiRaw === 'spanish') return 'es';
  return 'es';
}

/**
 * Convierte cualquier entrada (objeto, JSON, JSON codificado, query string o código 'es'/'en')
 * en una configuración válida y completa.
 *
 * @param {object|string|undefined} raw
 * @returns {{idioma:string, fuentes:string, calidad:string, orden:string, max:number, packs:boolean}}
 */
function normalizarConfig(raw) {
  const explicita = tieneFuentesExplicitas(raw);
  const entrada = parsearEntradaConfig(raw);
  const max = Number.parseInt(entrada.max ?? entrada.maxResultados ?? entrada.limit, 10);

  const resultado = {
    idioma: normalizarEnum(entrada.idioma ?? entrada.language ?? entrada.lang, IDIOMAS, DEFAULTS.idioma, IDIOMA_ALIAS),
    fuentes: normalizarFuentes(entrada.fuentes ?? entrada.sources),
    calidad: normalizarEnum(entrada.calidad ?? entrada.quality, CALIDADES, DEFAULTS.calidad, CALIDAD_ALIAS),
    orden: normalizarEnum(entrada.orden ?? entrada.order, ORDENES, DEFAULTS.orden, ORDEN_ALIAS),
    max: Number.isFinite(max) ? Math.max(5, Math.min(60, max)) : DEFAULTS.max,
    packs: normalizarBooleano(entrada.packs ?? entrada.incluirPacks ?? entrada.allowPacks, DEFAULTS.packs)
  };
  Object.defineProperty(resultado, '_fuentesExplicitas', {
    value: explicita,
    enumerable: false
  });
  return resultado;
}

/** Serializa la config a JSON compacto (lo que va en la URL). */
function serializarConfig(cfg) {
  const c = normalizarConfig(cfg);
  const salida = {
    idioma: c.idioma,
    fuentes: c.fuentes,
    calidad: c.calidad,
    orden: c.orden,
    max: c.max,
    packs: c.packs
  };
  // Quitar lo que coincide con el valor por defecto → URL más corta
  for (const clave of Object.keys(salida)) {
    if (salida[clave] === DEFAULTS[clave]) delete salida[clave];
  }
  if (resolverIdiomaUI(cfg) === 'en') {
    salida.ui = 'en';
  }
  return salida;
}

/**
 * Localiza el manifest (Español o Inglés) sin mostrar nunca el nombre de los proveedores.
 */
function localizarManifest(baseManifest, rawConfig) {
  const clone = JSON.parse(JSON.stringify(baseManifest || {}));
  clone.resources = ['stream'];
  clone.catalogs = [];
  const ui = resolverIdiomaUI(rawConfig);
  const cfg = normalizarConfig(rawConfig);
  const usarIngles = ui === 'en' || (cfg.idioma === 'ingles' && ui !== 'es');

  if (usarIngles) {
    clone.description = 'Torrent streams for movies, series and anime in English (VO) and Spanish (Latino, Castellano & Dual) in HD, 1080p and 4K. Streams only (no catalogs).';
  }
  return clone;
}

function fuentesActivas(cfg) {
  return new Set(String(normalizarConfig(cfg).fuentes).split(',').filter(Boolean));
}

/**
 * Clasifica el idioma de un stream a partir de su `_meta.idioma`
 * "Latino/Inglés" o "Dual" → dual (se ofrece en ambos modos).
 */
function clasificarIdioma(texto) {
  const s = sinAcentos(texto);
  if (!s) return 'desconocido';
  const latino = /latino|castellano|espanol|spanish/.test(s);
  const ingles = /ingl|english|\bvo\b|original/.test(s);
  const japones = /japon|\bjap\b/.test(s);
  const dual = /dual/.test(s);
  if (dual || (latino && (ingles || japones))) return 'dual';
  if (latino) return 'latino';
  if (ingles) return 'ingles';
  return 'desconocido';
}

function rangoCalidad(texto) {
  const s = sinAcentos(texto);
  if (/2160|4k|uhd/.test(s)) return '4k';
  if (/1080/.test(s)) return '1080p';
  if (/720/.test(s)) return '720p';
  if (/480|dvdrip|\bsd\b|\bts\b|\bcam\b/.test(s)) return 'sd';
  return 'desconocida';
}

function coincideIdioma(idiomaStream, preferencia) {
  if (preferencia === 'ambos') return true;
  if (preferencia === 'latino') return idiomaStream !== 'ingles';
  if (preferencia === 'ingles') return idiomaStream !== 'latino';
  return true;
}

/**
 * Aplica la configuración a la lista final de streams:
 * fuentes → idioma → calidad mínima → packs → orden → máximo → limpieza.
 *
 * Si el filtro de idioma deja la lista vacía se devuelve la lista original
 * (mejor mostrar algo en VO que nada), dejando aviso en el log.
 *
 * @param {Array} streams streams de Stremio (con `_meta` interno opcional)
 * @param {object|string} config
 * @returns {Array} streams listos para enviar (sin `_meta`)
 */
function aplicarConfig(streams, config) {
  const cfg = normalizarConfig(config);
  if (!Array.isArray(streams) || streams.length === 0) return [];

  const activas = fuentesActivas(cfg);

  // 1) Metadatos normalizados por stream (acepta tanto `infoHash` nativo de torrent como `magnet:`)
  let lista = streams.map((stream, indice) => {
    if (!stream || (!stream.infoHash && !stream.url)) return null;
    const hashResuelto = extraerInfoHash(stream.infoHash) || extraerInfoHash(stream.url);
    if (!hashResuelto && /^magnet:/i.test(String(stream.url || ''))) return null;
    const meta = stream._meta || {};
    const idioma = clasificarIdioma(meta.idioma || stream.title || '');
    const calidad = rangoCalidad(meta.calidad || stream.name || stream.title || '');
    const fuenteCanon = FUENTES_ALIAS[String(meta.fuente || '').toLowerCase()] || 'desconocida';
    return {
      stream,
      hashResuelto,
      indice,
      fuente: fuenteCanon,
      idioma,
      calidad,
      seeders: Number(meta.seeders) || 0,
      pack: meta.pack === true,
      esLatino: fuenteCanon === 'ht' || FUENTES_HISPANAS_ADICIONALES.has(fuenteCanon)
    };
  }).filter(Boolean);

  // 2) Fuentes habilitadas:
  //    - Si el usuario NO especificó `fuentes`, se permiten los servidores hispanos e ingleses por defecto.
  //    - Si el usuario SÍ especificó `fuentes` (p. ej. desmarcó pp/ss/dt/mt/wt en /configure), se respeta estrictamente su selección.
  const permitirHispanasPorDefecto = !tieneFuentesExplicitas(config);
  const porFuente = lista.filter(x => activas.has(x.fuente) || (permitirHispanasPorDefecto && FUENTES_HISPANAS_ADICIONALES.has(x.fuente)));
  if (porFuente.length > 0) lista = porFuente;
  else console.warn('[Config] Ninguna fuente habilitada dejó streams; usando todos');

  // 3) Idioma
  const porIdioma = lista.filter(x => coincideIdioma(x.idioma, cfg.idioma));
  if (porIdioma.length > 0) {
    lista = porIdioma;
  } else if (cfg.idioma !== 'ambos') {
    console.log(`[Config] Sin streams en "${cfg.idioma}"; se muestran todos los idiomas`);
  }

  // 4) Calidad mínima
  const minRango = RANGO_CALIDAD_MIN[cfg.calidad] ?? 0;
  if (minRango > 0) {
    const porCalidad = lista.filter(x => (RANGO_CALIDAD[x.calidad] ?? 0) >= minRango);
    if (porCalidad.length > 0) lista = porCalidad;
    else console.log(`[Config] Nada llega a "${cfg.calidad}"; se muestran todas las calidades`);
  }

  // 5) Packs de temporada: si el usuario los desactiva, NUNCA se muestran
  if (!cfg.packs) {
    lista = lista.filter(x => !x.pack);
  }

  // 6) Orden
  const rangoIdioma = { latino: 0, dual: 1, desconocido: 2, ingles: 3 };
  lista.sort((a, b) => {
    if (cfg.orden === 'seeders') {
      if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    } else if (cfg.orden === 'calidad') {
      const ra = RANGO_CALIDAD[a.calidad] ?? 0;
      const rb = RANGO_CALIDAD[b.calidad] ?? 0;
      if (rb !== ra) return rb - ra;
      if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    } else {
      // 'latino' (por defecto): español/dual primero, luego seeders, luego orden original
      const ra = rangoIdioma[a.idioma] ?? 3;
      const rb = rangoIdioma[b.idioma] ?? 3;
      if (ra !== rb) return ra - rb;
      if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    }
    return a.indice - b.indice;
  });

  // 7) Máximo y normalización a objeto Torrent nativo de Stremio (`infoHash` + `sources`, sin `url` magnet)
  const finales = lista.slice(0, cfg.max).map(x => {
    const stream = { ...x.stream };
    delete stream._meta;
    if (x.hashResuelto) {
      const magnetOriginal = typeof stream.url === 'string' && stream.url.startsWith('magnet:')
        ? stream.url
        : null;
      stream.infoHash = x.hashResuelto;
      if (!Array.isArray(stream.sources) || stream.sources.length === 0) {
        stream.sources = construirSources(x.hashResuelto, magnetOriginal);
      }
      delete stream.url;
    }
    return stream;
  });

  console.log(`[Config] ${cfg.idioma}/${cfg.fuentes}/${cfg.calidad}/orden:${cfg.orden}/packs:${cfg.packs ? 'sí' : 'no'} → ${finales.length}/${streams.length} streams`);
  return finales;
}

/**
 * Construye la URL de instalación/manifest con la configuración embebida.
 * Usa la misma lógica que el JS de la página: omite los valores por defecto.
 *
 * @param {object|string} config
 * @param {string} [origen] p. ej. "https://mi-addon.com" (sin barra final)
 * @returns {string} "{origen}/{configJSON}/manifest.json"
 */
function construirUrlManifest(config, origen = '') {
  const compacta = serializarConfig(config);
  const base = String(origen).replace(/\/+$/, '');
  if (Object.keys(compacta).length === 0) return `${base}/manifest.json`;
  return `${base}/${encodeURIComponent(JSON.stringify(compacta))}/manifest.json`;
}

module.exports = {
  DEFAULTS,
  PERFILES_IDIOMA,
  BEAMUP_HOST,
  BEAMUP_ORIGIN,
  FUENTES_UI_POR_DEFECTO,
  FUENTES_VALIDAS,
  IDIOMAS,
  CALIDADES,
  ORDENES,
  parsearEntradaConfig,
  tieneFuentesExplicitas,
  normalizarConfig,
  serializarConfig,
  resolverIdiomaUI,
  localizarManifest,
  construirUrlManifest,
  fuentesActivas,
  clasificarIdioma,
  rangoCalidad,
  aplicarConfig
};
