/**
 * lib/server.js
 * ---------------------------------------------------------------------------
 * Servidor HTTP del addon UniverTorrent:
 *   - /                     → redirige a /configure
 *   - /configure            → página web de configuración (Español / Inglés)
 *   - /es/configure         → configuración preseleccionada en Español
 *   - /en/configure         → configuración preseleccionada en Inglés
 *   - /:config/configure    → reconfiguración de un addon ya instalado en Stremio
 *   - /es/manifest.json     → manifest preconfigurado en Español
 *   - /en/manifest.json     → manifest preconfigurado en Inglés
 *   - /health               → estado (para Render/Netlify/Koyeb/UptimeRobot)
 *   - /manifest.json        → manifest universal (con o sin configuración)
 *   - /:config/...json      → recursos del addon (Stremio)
 *
 * Incluye CORS universal (`Access-Control-Allow-Origin: *`) en TODAS las rutas
 * y normaliza cualquier formato de configuración en la URL (`%7B...%7D`, `{...}`,
 * `es`, `en`, `idioma=latino&...`, `idioma=latino|...`) antes del router del SDK.
 * ---------------------------------------------------------------------------
 */

'use strict';

const cors = require('cors');
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { renderConfigPage } = require('./configPage');
const {
  PERFILES_IDIOMA,
  BEAMUP_HOST,
  BEAMUP_ORIGIN,
  parsearEntradaConfig,
  normalizarConfig,
  tieneFuentesExplicitas,
  resolverIdiomaUI,
  localizarManifest
} = require('./config');

/**
 * Convierte cualquier segmento `:config` (`es`, `en`, `%7B...%7D`, `{...}`, `k=v&...`)
 * en un objeto JSON limpio apto para `JSON.parse()` dentro de `stremio-addon-sdk`.
 */
function normalizarSegmentoConfig(rawSegmento) {
  const entrada = parsearEntradaConfig(rawSegmento);
  const cfg = normalizarConfig(rawSegmento);
  const jsonObj = {
    idioma: cfg.idioma,
    calidad: cfg.calidad,
    orden: cfg.orden,
    max: cfg.max,
    packs: cfg.packs
  };
  if (tieneFuentesExplicitas(rawSegmento) || Object.keys(entrada).length > 0) {
    if (tieneFuentesExplicitas(rawSegmento)) {
      jsonObj.fuentes = cfg.fuentes;
    }
  }
  const ui = resolverIdiomaUI(rawSegmento);
  if (ui === 'en') jsonObj.ui = 'en';
  return jsonObj;
}

/**
 * @param {object} addonInterface interface del SDK ({ manifest, get })
 * @param {object} [opciones]
 * @param {number} [opciones.cacheMaxAge] segundos de caché para las respuestas .json
 * @returns {import('express').Express}
 */
function createApp(addonInterface, opciones = {}) {
  const cacheMaxAge = opciones.cacheMaxAge || Number(process.env.ADDON_CACHE_MAX_AGE) || 3600 * 6;
  const app = express();

  app.disable('x-powered-by');

  // CORS habilitado en TODAS las rutas (manifest con/sin config, stream, health y preflight OPTIONS)
  app.use(cors());

  // Caché extendida + stale-while-revalidate para respuestas .json
  app.use((req, res, next) => {
    if (/\.json$/i.test(req.path.split('?')[0]) && !res.getHeader('Cache-Control')) {
      res.setHeader(
        'Cache-Control',
        `max-age=${cacheMaxAge}, stale-while-revalidate=86400, stale-if-error=86400, public`
      );
    }
    next();
  });

  // Página de configuración en Español o Inglés (/es/configure, /en/configure)
  app.get(['/es/configure', '/en/configure'], (req, res) => {
    const esEn = req.path.startsWith('/en/');
    const baseCfg = esEn
      ? { ...PERFILES_IDIOMA.en, ui: 'en' }
      : { ...PERFILES_IDIOMA.es, ui: 'es' };
    const config = { ...baseCfg, ...req.query };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderConfigPage({ config, manifest: localizarManifest(addonInterface.manifest, config) }));
  });

  // Página de configuración estándar (/configure?idioma=latino... o ?config={json})
  app.get('/configure', (req, res) => {
    let config = req.query;
    if (typeof req.query.config === 'string') {
      config = { ...parsearEntradaConfig(req.query.config), ...req.query };
      delete config.config;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderConfigPage({ config, manifest: localizarManifest(addonInterface.manifest, config) }));
  });

  // Reconfiguración desde Stremio cuando el addon ya está instalado con config en la ruta (`/:config/configure`)
  app.get('/:config/configure', (req, res) => {
    const desdeRuta = parsearEntradaConfig(req.params.config);
    const config = { ...desdeRuta, ...req.query };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderConfigPage({ config, manifest: localizarManifest(addonInterface.manifest, config) }));
  });

  app.get('/', (req, res) => res.redirect('/configure'));

  app.get('/health', (req, res) => {
    const payload = {
      ok: true,
      name: addonInterface.manifest.name,
      version: addonInterface.manifest.version,
      resources: addonInterface.manifest.resources
    };
    if (BEAMUP_HOST) payload.subdomain = BEAMUP_HOST;
    if (BEAMUP_ORIGIN) payload.beamupUrl = BEAMUP_ORIGIN;
    res.json(payload);
  });

  // Normaliza atajos de idioma (/es/..., /en/...) y configuraciones en cualquier formato
  // (`{json}` sin codificar, `%7Bjson%7D`, `idioma=latino&...`) a JSON codificado para el SDK
  app.use((req, res, next) => {
    const match = req.url.match(/^\/([^/?#]+)(\/(?:manifest\.json|stream\/[^?#]+))(\?.*)?$/i);
    if (match) {
      const seg = match[1];
      const rest = match[2];
      const search = match[3] || '';
      const reservadas = new Set(['stream', 'catalog', 'meta', 'subtitles', 'addon_catalog', '.netlify']);
      if (!reservadas.has(seg.toLowerCase())) {
        // Si ya es JSON válido tras decodificar, conservarlo; si es alias/query (`es`, `en`, `idioma=latino`), convertir a JSON
        let jsonValido = null;
        try {
          const dec = decodeURIComponent(seg);
          const parsed = JSON.parse(dec);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            jsonValido = parsed;
          }
        } catch {
          jsonValido = null;
        }
        const normalizado = jsonValido || normalizarSegmentoConfig(seg);
        req.url = `/${encodeURIComponent(JSON.stringify(normalizado))}${rest}${search}`;
      }
    }
    next();
  });

  // Manifest con localización Español / Inglés según configuración (sin nombres de proveedores)
  app.get('/:config/manifest.json', (req, res) => {
    const rawConfig = req.params.config;
    const manifestLocalizado = localizarManifest(addonInterface.manifest, rawConfig);
    if (manifestLocalizado.behaviorHints) {
      delete manifestLocalizado.behaviorHints.configurationRequired;
      delete manifestLocalizado.behaviorHints.configurable;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(manifestLocalizado));
  });

  // Recursos del addon (manifest.json y stream/)
  app.use(getRouter(addonInterface));

  return app;
}

module.exports = { createApp, normalizarSegmentoConfig };
