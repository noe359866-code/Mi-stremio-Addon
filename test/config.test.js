'use strict';

/**
 * Configuración del addon: normalización y efecto real sobre los streams.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULTS,
  normalizarConfig,
  serializarConfig,
  construirUrlManifest,
  fuentesActivas,
  clasificarIdioma,
  aplicarConfig
} = require('../lib/config');

// ------------------------- normalización -------------------------

test('config por defecto: todo lo razonable activado', () => {
  const cfg = normalizarConfig(undefined);
  assert.deepStrictEqual(cfg, DEFAULTS);
  assert.strictEqual(cfg.idioma, 'ambos');
  assert.strictEqual(cfg.fuentes, 'ht,knaben');
  assert.strictEqual(cfg.packs, true);
});

test('acepta JSON en texto y alias de claves', () => {
  const cfg = normalizarConfig('{"language":"latino","sources":["hacktorrent","tbb"],"quality":"1080","order":"seeders","limit":30,"incluirPacks":false}');
  assert.strictEqual(cfg.idioma, 'latino');
  assert.strictEqual(cfg.fuentes, 'ht,tbb');
  assert.strictEqual(cfg.calidad, '1080p');
  assert.strictEqual(cfg.orden, 'seeders');
  assert.strictEqual(cfg.max, 30);
  assert.strictEqual(cfg.packs, false);
});

test('acepta la query string de la página (/configure?idioma=latino&fuentes=ht,knaben)', () => {
  const cfg = normalizarConfig({ idioma: 'latino', fuentes: 'ht,knaben', calidad: '4k', orden: 'calidad', max: '40', packs: 'on' });
  assert.deepStrictEqual(cfg, {
    idioma: 'latino', fuentes: 'ht,knaben', calidad: '4k', orden: 'calidad', max: 40, packs: true
  });
});

test('valores inválidos caen a los por defecto y el máximo se acota', () => {
  const cfg = normalizarConfig({ idioma: 'klingon', fuentes: 'rtmp', calidad: '9000p', orden: 'aleatorio', max: 9999, packs: 'quizá' });
  assert.strictEqual(cfg.idioma, DEFAULTS.idioma);
  assert.strictEqual(cfg.fuentes, 'ht'); // ninguna fuente válida → al menos HackTorrent
  assert.strictEqual(cfg.calidad, DEFAULTS.calidad);
  assert.strictEqual(cfg.orden, DEFAULTS.orden);
  assert.strictEqual(cfg.max, 60);
  assert.strictEqual(cfg.packs, DEFAULTS.packs);
});

test('serializarConfig quita los valores por defecto (URL corta)', () => {
  assert.deepStrictEqual(serializarConfig(DEFAULTS), {});
  assert.deepStrictEqual(
    serializarConfig({ idioma: 'latino', fuentes: 'ht', calidad: '1080p', orden: 'seeders', max: 10, packs: false }),
    { idioma: 'latino', fuentes: 'ht', calidad: '1080p', orden: 'seeders', max: 10, packs: false }
  );
});

test('construirUrlManifest genera la URL del protocolo de configuración', () => {
  // Sin config → manifest pelado
  assert.strictEqual(construirUrlManifest(DEFAULTS, 'https://addon.test/'), 'https://addon.test/manifest.json');

  const url = construirUrlManifest({ idioma: 'latino', fuentes: 'ht,knaben' }, 'https://addon.test');
  assert.ok(url.startsWith('https://addon.test/%7B'), url);
  assert.ok(url.endsWith('/manifest.json'));
  const segmento = decodeURIComponent(url.replace('https://addon.test/', '').replace('/manifest.json', ''));
  assert.deepStrictEqual(JSON.parse(segmento), { idioma: 'latino' });
});

test('fuentesActivas normaliza alias', () => {
  assert.deepStrictEqual([...fuentesActivas({ fuentes: 'ht,tbb' })], ['ht', 'tbb']);
  assert.deepStrictEqual([...fuentesActivas({ fuentes: ['hacktorrent', 'knaben'] })], ['ht', 'knaben']);
  assert.deepStrictEqual([...fuentesActivas({ fuentes: { ht: true, tbb: false } })], ['ht']);
});

test('clasificarIdioma entiende las etiquetas reales', () => {
  assert.strictEqual(clasificarIdioma('Latino'), 'latino');
  assert.strictEqual(clasificarIdioma('Latino/Inglés'), 'dual');
  assert.strictEqual(clasificarIdioma('Castellano'), 'latino');
  assert.strictEqual(clasificarIdioma('Dual'), 'dual');
  assert.strictEqual(clasificarIdioma('Inglés'), 'ingles');
  assert.strictEqual(clasificarIdioma(''), 'desconocido');
});

// ------------------------- efecto sobre los streams -------------------------

function stream({ fuente = 'hacktorrent', idioma = 'Latino', calidad = '1080p', seeders = 0, pack = false, nombre = 'X' }) {
  return {
    name: `${fuente}\n${calidad}`,
    title: `${nombre}`,
    url: `magnet:?xt=urn:btih:${Math.random().toString(16).slice(2).padEnd(40, '0')}`,
    _meta: { fuente, idioma, calidad, seeders, pack }
  };
}

const MUESTRA = [
  stream({ fuente: 'hacktorrent', idioma: 'Latino', calidad: '1080p', nombre: 'HT-Latino-1080' }),
  stream({ fuente: 'hacktorrent', idioma: 'Latino', calidad: '720p', nombre: 'HT-Latino-720' }),
  stream({ fuente: 'knaben', idioma: 'Inglés', calidad: '4K', seeders: 500, nombre: 'KNB-4K' }),
  stream({ fuente: 'knaben', idioma: 'Inglés', calidad: '1080p', seeders: 100, nombre: 'KNB-1080' }),
  stream({ fuente: 'tbb', idioma: 'Inglés', calidad: '1080p', seeders: 50, nombre: 'TBB-1080' })
];

const nombres = (streams) => streams.map(s => s.title);
// The Black Hole Bay está desactivada por defecto: los tests que la incluyen
// la activan explícitamente.
const TODAS = { fuentes: 'ht,knaben,tbb' };

test('idioma latino: fuera los English-only', () => {
  const salida = aplicarConfig(MUESTRA, { idioma: 'latino' });
  assert.deepStrictEqual(nombres(salida).sort(), ['HT-Latino-1080', 'HT-Latino-720']);
});

test('idioma inglés: fuera los Latino-only, se queda con VO y dual', () => {
  const salida = aplicarConfig(MUESTRA, { ...TODAS, idioma: 'ingles' });
  assert.deepStrictEqual(nombres(salida).sort(), ['KNB-1080', 'KNB-4K', 'TBB-1080']);
});

test('idioma ambos: todo, pero Latino primero', () => {
  const salida = aplicarConfig(MUESTRA, { ...TODAS, idioma: 'ambos' });
  assert.strictEqual(salida.length, 5);
  assert.ok(nombres(salida).slice(0, 2).every(n => n.startsWith('HT-Latino')));
});

test('si el idioma elegido no tiene nada se muestran todos (no dejar sin streams)', () => {
  const soloIngles = [stream({ fuente: 'knaben', idioma: 'Inglés', nombre: 'KNB-1080' })];
  const salida = aplicarConfig(soloIngles, { idioma: 'latino' });
  assert.deepStrictEqual(nombres(salida), ['KNB-1080']);
});

test('fuentes: se pueden desactivar Knaben o HackTorrent', () => {
  assert.deepStrictEqual(
    nombres(aplicarConfig(MUESTRA, { fuentes: 'ht' })).sort(),
    ['HT-Latino-1080', 'HT-Latino-720']
  );
  assert.deepStrictEqual(
    nombres(aplicarConfig(MUESTRA, { fuentes: 'knaben' })).sort(),
    ['KNB-1080', 'KNB-4K']
  );
  assert.deepStrictEqual(
    nombres(aplicarConfig(MUESTRA, { fuentes: 'ht,knaben,tbb', idioma: 'ambos' })).length,
    5
  );
});

test('calidad mínima filtra por debajo', () => {
  const salida = aplicarConfig(MUESTRA, { ...TODAS, calidad: '1080p' });
  assert.deepStrictEqual(nombres(salida).sort(), ['HT-Latino-1080', 'KNB-1080', 'KNB-4K', 'TBB-1080']);

  const solo4k = aplicarConfig(MUESTRA, { ...TODAS, calidad: '4k' });
  assert.deepStrictEqual(nombres(solo4k), ['KNB-4K']);
});

test('packs: se pueden ocultar', () => {
  const conPack = [
    ...MUESTRA,
    stream({ fuente: 'knaben', idioma: 'Inglés', calidad: '1080p', pack: true, nombre: 'KNB-PACK' })
  ];
  assert.ok(nombres(aplicarConfig(conPack, { packs: true })).includes('KNB-PACK'));
  assert.ok(!nombres(aplicarConfig(conPack, { packs: false })).includes('KNB-PACK'));
});

test('orden por seeders y por calidad', () => {
  const porSeeders = aplicarConfig(MUESTRA, { ...TODAS, orden: 'seeders', idioma: 'ambos' });
  assert.deepStrictEqual(nombres(porSeeders), ['KNB-4K', 'KNB-1080', 'TBB-1080', 'HT-Latino-1080', 'HT-Latino-720']);

  const porCalidad = aplicarConfig(MUESTRA, { ...TODAS, orden: 'calidad', idioma: 'ambos' });
  assert.strictEqual(nombres(porCalidad)[0], 'KNB-4K');
  assert.ok(nombres(porCalidad).slice(-2).every(n => n.endsWith('-720') || n.endsWith('-1080')));
});

test('máximo de resultados (con mínimo de seguridad 5 y tope 60)', () => {
  const muchos = Array.from({ length: 12 }, (_, i) =>
    stream({ fuente: 'knaben', idioma: 'Inglés', seeders: i, nombre: 'S' + i })
  );
  assert.strictEqual(aplicarConfig(muchos, { ...TODAS, max: 10 }).length, 10);
  assert.strictEqual(aplicarConfig(muchos, { ...TODAS, max: 60 }).length, 12);
  // Por debajo del mínimo se acota a 5 para no dejar la lista prácticamente vacía
  assert.strictEqual(normalizarConfig({ max: 1 }).max, 5);
  assert.strictEqual(normalizarConfig({ max: 999 }).max, 60);
});

test('los metadatos internos (_meta) no se envían a Stremio', () => {
  const salida = aplicarConfig(MUESTRA, TODAS);
  for (const s of salida) {
    assert.strictEqual(s._meta, undefined);
    assert.ok(s.url.startsWith('magnet:'));
    assert.ok(s.name && s.title);
  }
  // No se mutan los originales
  assert.ok(MUESTRA[0]._meta);
});

test('lista vacía o inválida devuelve []', () => {
  assert.deepStrictEqual(aplicarConfig([], {}), []);
  assert.deepStrictEqual(aplicarConfig(null, {}), []);
  assert.deepStrictEqual(aplicarConfig([{ name: 'sin url' }], {}), []);
});
