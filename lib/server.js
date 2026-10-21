/**
 * lib/server.js
 * ---------------------------------------------------------------------------
 * Servidor HTTP del addon:
 *   - /                     → redirige a /configure
 *   - /configure            → página web de configuración (idioma, fuentes…)
 *   - /health               → estado (para Render/UptimeRobot)
 *   - /manifest.json        → manifest (con o sin configuración)
 *   - /<config>/...json     → recursos del addon (Stremio)
 *
 * Usa el router oficial del SDK para los recursos, de modo que el protocolo
 * de Stremio sigue siendo 100% compatible.
 * ---------------------------------------------------------------------------
 */

'use strict';

const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { renderConfigPage } = require('./configPage');

/**
 * @param {object} addonInterface interface del SDK ({ manifest, get })
 * @param {object} [opciones]
 * @param {number} [opciones.cacheMaxAge] segundos de caché para las respuestas .json
 * @returns {import('express').Express}
 */
function createApp(addonInterface, opciones = {}) {
  const cacheMaxAge = opciones.cacheMaxAge || 3600 * 6;
  const app = express();

  app.disable('x-powered-by');

  // Caché sólo para las respuestas JSON del addon
  app.use((req, res, next) => {
    if (/\.json$/i.test(req.path.split('?')[0]) && !res.getHeader('Cache-Control')) {
      res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, public`);
    }
    next();
  });

  // Página de configuración. Acepta la config por query
  // (?idioma=latino&fuentes=ht,knaben&calidad=1080p...) o por ?config={json}
  app.get('/configure', (req, res) => {
    let config = req.query;
    if (typeof req.query.config === 'string') {
      try {
        config = JSON.parse(req.query.config);
      } catch {
        config = req.query;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderConfigPage({ config, manifest: addonInterface.manifest }));
  });

  app.get('/', (req, res) => res.redirect('/configure'));

  app.get('/health', (req, res) => {
    res.json({ ok: true, name: addonInterface.manifest.name, version: addonInterface.manifest.version });
  });

  // Recursos del addon (manifest.json, catalog/, stream/, meta/)
  app.use(getRouter(addonInterface));

  return app;
}

module.exports = { createApp };
