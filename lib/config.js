/**
 * lib/config.js
 * ---------------------------------------------------------------------------
 * Configuración del addon (página web /configure).
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
 *     fuentes: 'ht,knaben[,tbb]',
 *     calidad: 'cualquiera'|'720p'|'1080p'|'4k',
 *     orden:   'latino'|'seeders'|'calidad',
 *     max:     25,
 *     packs:   true }
 * ---------------------------------------------------------------------------
 */

'use strict';

const DEFAULTS = Object.freeze({
  idioma: 'ambos',
  fuentes: 'ht,knaben',
  calidad: 'cualquiera',
  orden: 'latino',
  max: 25,
  packs: true
});

// Claves de fuente aceptadas (ht = HackTorrent, knaben, tbb = The Black Hole Bay)
const FUENTES_VALIDAS = ['ht', 'knaben', 'tbb'];
const FUENTES_ALIAS = {
  ht: 'ht', hacktorrent: 'ht', hack: 'ht',
  knaben: 'knaben', knb: 'knaben',
  tbb: 'tbb', blackholebay: 'tbb', 'black-hole-bay': 'tbb', theblackholebay: 'tbb'
};

const IDIOMAS = ['ambos', 'latino', 'ingles'];
const CALIDADES = ['cualquiera', '720p', '1080p', '4k'];
const ORDENES = ['latino', 'seeders', 'calidad'];

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

/** Normaliza la lista de fuentes (array, csv o booleans por clave). */
function normalizarFuentes(valor) {
  if (valor === undefined || valor === null || valor === '') return DEFAULTS.fuentes;

  let lista = [];
  if (Array.isArray(valor)) {
    lista = valor;
  } else if (typeof valor === 'object') {
    // { ht: true, knaben: false, tbb: true }
    lista = Object.keys(valor).filter(k => normalizarBooleano(valor[k], false));
  } else {
    lista = String(valor).split(/[,;|+\s]+/);
  }

  const vistas = new Set();
  for (const item of lista) {
    const clave = FUENTES_ALIAS[String(item).toLowerCase().trim()];
    if (clave) vistas.add(clave);
  }

  // Si el usuario no deja ninguna, al menos HackTorrent (addon siempre útil)
  if (vistas.size === 0) return 'ht';
  return FUENTES_VALIDAS.filter(f => vistas.has(f)).join(',');
}

function normalizarEnum(valor, permitidos, porDefecto) {
  const s = sinAcentos(valor).trim();
  if (!s) return porDefecto;
  // "inglés" → "ingles", "1080" → "1080p", "4K" → "4k"
  const candidatos = [s, `${s}p`];
  for (const c of candidatos) {
    if (permitidos.includes(c)) return c;
  }
  return porDefecto;
}

/**
 * Convierte cualquier entrada (objeto, JSON, valores sueltos de la query)
 * en una configuración válida y completa.
 *
 * @param {object|string|undefined} raw
 * @returns {{idioma:string, fuentes:string, calidad:string, orden:string, max:number, packs:boolean}}
 */
function normalizarConfig(raw) {
  let entrada = raw;

  if (typeof entrada === 'string') {
    try {
      entrada = JSON.parse(entrada);
    } catch {
      entrada = {};
    }
  }
  if (!entrada || typeof entrada !== 'object') entrada = {};

  const max = Number.parseInt(entrada.max ?? entrada.maxResultados ?? entrada.limit, 10);

  return {
    idioma: normalizarEnum(entrada.idioma ?? entrada.language ?? entrada.lang, IDIOMAS, DEFAULTS.idioma),
    fuentes: normalizarFuentes(entrada.fuentes ?? entrada.sources),
    calidad: normalizarEnum(entrada.calidad ?? entrada.quality, CALIDADES, DEFAULTS.calidad),
    orden: normalizarEnum(entrada.orden ?? entrada.order, ORDENES, DEFAULTS.orden),
    max: Number.isFinite(max) ? Math.max(5, Math.min(60, max)) : DEFAULTS.max,
    packs: normalizarBooleano(entrada.packs ?? entrada.incluirPacks, DEFAULTS.packs)
  };
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
  return salida;
}

function fuentesActivas(cfg) {
  return new Set(String(normalizarConfig(cfg).fuentes).split(',').filter(Boolean));
}

/**
 * Clasifica el idioma de un stream a partir de su `_meta.idioma`
 * (lo rellenan HackTorrent / Knaben / TBB al construir el stream).
 * "Latino/Inglés" o "Dual" → dual (se ofrece en ambos modos).
 */
function clasificarIdioma(texto) {
  const s = sinAcentos(texto);
  if (!s) return 'desconocido';
  const latino = /latino|castellano|espanol|spanish/.test(s);
  const ingles = /ingl|english|\bvo\b|original/.test(s);
  const dual = /dual/.test(s);
  if (dual || (latino && ingles)) return 'dual';
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

  // 1) Metadatos normalizados por stream
  let lista = streams.map((stream, indice) => {
    if (!stream || !stream.url) return null;
    const meta = stream._meta || {};
    const idioma = clasificarIdioma(meta.idioma || stream.title || '');
    const calidad = rangoCalidad(meta.calidad || stream.name || stream.title || '');
    return {
      stream,
      indice,
      // "hacktorrent" → "ht", "blackholebay" → "tbb"…
      fuente: FUENTES_ALIAS[String(meta.fuente || '').toLowerCase()] || 'desconocida',
      idioma,
      calidad,
      seeders: Number(meta.seeders) || 0,
      pack: meta.pack === true,
      esLatino: meta.fuente === 'hacktorrent'
    };
  }).filter(Boolean);

  // 2) Fuentes habilitadas
  const porFuente = lista.filter(x => activas.has(x.fuente));
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
  //    (a diferencia del idioma/calidad, aquí no hay "mejor algo que nada":
  //    un pack es un archivo distinto al episodio que se está pidiendo).
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
      // 'latino' (por defecto): latino/dual primero, luego seeders, luego
      // el orden original (HackTorrent antes que las fuentes externas)
      const ra = rangoIdioma[a.idioma] ?? 3;
      const rb = rangoIdioma[b.idioma] ?? 3;
      if (ra !== rb) return ra - rb;
      if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    }
    return a.indice - b.indice;
  });

  // 7) Máximo
  const finales = lista.slice(0, cfg.max).map(x => {
    const stream = { ...x.stream };
    delete stream._meta;
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
  FUENTES_VALIDAS,
  IDIOMAS,
  CALIDADES,
  ORDENES,
  normalizarConfig,
  serializarConfig,
  construirUrlManifest,
  fuentesActivas,
  clasificarIdioma,
  rangoCalidad,
  aplicarConfig
};
