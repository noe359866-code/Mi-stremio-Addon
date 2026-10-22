/**
 * lib/server.js
 * ---------------------------------------------------------------------------
 * Servidor HTTP del addon UniverTorrent:
 *   - /                     → redirige a /configure
 *   - /configure            → página web de configuración (Español / Inglés)
 *   - /es/configure         → configuración preseleccionada en Español
 *   - /en/configure         → configuración preseleccionada en Inglés
 *   - /es/manifest.json     → manifest preconfigurado en Español
 *   - /en/manifest.json     → manifest preconfigurado en Inglés
 *   - /health               → estado (para Beamup/Render/UptimeRobot)
 *   - /manifest.json        → manifest universal (con o sin configuración)
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
const {
  PERFILES_IDIOMA,
  BEAMUP_HOST,
  BEAMUP_ORIGIN,
  localizarManifest
} = require('./config');

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

  // Caché extendida + stale-while-revalidate para soportar bastantes usuarios concurrentes
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
      try {
        config = JSON.parse(req.query.config);
      } catch {
        config = req.query;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderConfigPage({ config, manifest: localizarManifest(addonInterface.manifest, config) }));
  });

  app.get('/', (req, res) => res.redirect('/configure'));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      name: addonInterface.manifest.name,
      version: addonInterface.manifest.version,
      subdomain: BEAMUP_HOST,
      beamupUrl: BEAMUP_ORIGIN
    });
  });

  // Middleware para atajos de idioma (/es/... y /en/...) hacia configuración JSON de Stremio
  app.use((req, res, next) => {
    const match = req.url.match(/^\/(es|espanol|spanish|en|ingles|english)(\/.*)$/i);
    if (match) {
      const tag = match[1].toLowerCase();
      const rest = match[2];
      const perfil = (tag === 'en' || tag === 'ingles' || tag === 'english')
        ? { ...PERFILES_IDIOMA.en, ui: 'en' }
        : { ...PERFILES_IDIOMA.es, ui: 'es' };
      req.url = `/${encodeURIComponent(JSON.stringify(perfil))}${rest}`;
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

  // Recursos del addon (manifest.json, catalog/, stream/, meta/)
  app.use(getRouter(addonInterface));

  return app;
}

module.exports = { createApp };
