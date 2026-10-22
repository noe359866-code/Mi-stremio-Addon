/**
 * lib/configPage.js
 * ---------------------------------------------------------------------------
 * Página web /configure del addon UniverTorrent.
 *
 * Genera HTML autocontenido (CSS + JS embebidos, sin CDN ni fuentes externas)
 * con soporte bilingüe (Español / Inglés), perfiles rápidos para Español e
 * Inglés, sin exponer nombres de proveedores externos, y construye la URL de
 * instalación en el formato de Stremio:  /<configJSON>/manifest.json
 * ---------------------------------------------------------------------------
 */

'use strict';

const {
  normalizarConfig,
  resolverIdiomaUI,
  DEFAULTS,
  PERFILES_IDIOMA,
  BEAMUP_HOST,
  BEAMUP_ORIGIN
} = require('./config');

function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function marcar(condicion) {
  return condicion ? ' checked' : '';
}

function seleccionar(condicion) {
  return condicion ? ' selected' : '';
}

/**
 * @param {object} opciones { config (raw de la query), manifest, baseUrl }
 * @returns {string} HTML
 */
function renderConfigPage({ config, manifest = {}, baseUrl = '' } = {}) {
  const cfg = normalizarConfig(config);
  const ui = resolverIdiomaUI(config);
  const fuentes = new Set(String(cfg.fuentes).split(','));

  const version = escaparHtml(manifest.version || '');
  const nombre = escaparHtml(manifest.name || 'UniverTorrent');

  const idiomas = [
    {
      valor: 'ambos',
      titulo: 'Ambos (Español + Inglés)',
      tituloEn: 'Both (Spanish + English)',
      texto: 'Español (Latino / Castellano / Dual) primero y también Inglés (VO)',
      textoEn: 'Spanish (Latino / Castellano / Dual) first plus English (VO)'
    },
    {
      valor: 'latino',
      titulo: 'Español (Latino / Castellano)',
      tituloEn: 'Spanish (Latino / Castellano)',
      texto: 'Sólo audio en español latino, castellano o dual',
      textoEn: 'Only Spanish (Latin American, Castilian or Dual audio)'
    },
    {
      valor: 'ingles',
      titulo: 'Inglés (English VO)',
      tituloEn: 'English (Original Audio)',
      texto: 'Sólo audio en inglés (VO) o dual',
      textoEn: 'Only English (Original Version) or Dual audio'
    }
  ];

  const calidades = [
    ['cualquiera', 'Cualquiera / Any'],
    ['720p', '720p HD o más / 720p+'],
    ['1080p', '1080p Full HD o más / 1080p+'],
    ['4k', 'Sólo 4K UHD / 4K Only']
  ];

  const ordenes = [
    ['latino', 'Español primero, luego seeders / Spanish first'],
    ['seeders', 'Más seeders primero / Most seeders first'],
    ['calidad', 'Mejor calidad primero / Best quality first']
  ];

  const maximos = [10, 20, 25, 40, 60];

  return `<!DOCTYPE html>
<html lang="${ui === 'en' ? 'en' : 'es'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configurar ${nombre}</title>
<style>
  :root{
    --fondo:#0b0d12; --panel:#141821; --panel2:#1b2130; --borde:#252c3b;
    --texto:#e8ecf4; --tenue:#9aa5b8; --acento:#7c5cff; --acento2:#22c55e; --aviso:#f59e0b;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:radial-gradient(1200px 600px at 50% -10%, #1a2033 0%, var(--fondo) 60%);
    color:var(--texto); font-family:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,Cantarell,sans-serif;
    line-height:1.5; padding:24px 16px 64px;
  }
  .wrap{max-width:860px;margin:0 auto}
  header{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
  .logo{
    width:52px;height:52px;border-radius:14px;flex:0 0 auto;
    background:linear-gradient(135deg,var(--acento),#20c997);
    display:grid;place-items:center;font-size:24px;font-weight:800;color:#fff;
    box-shadow:0 8px 24px rgba(124,92,255,.35);
  }
  h1{font-size:clamp(20px,3.4vw,27px);margin:0;letter-spacing:-.02em}
  .sub{color:var(--tenue);font-size:14px;margin:2px 0 0}
  .header-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .badge{
    font-size:12px;color:#cbd5e1;background:var(--panel2);
    border:1px solid var(--borde);padding:5px 10px;border-radius:999px;
  }
  .lang-switch{display:inline-flex;background:var(--panel2);border:1px solid var(--borde);border-radius:999px;padding:2px}
  .lang-btn{
    border:0;background:transparent;color:var(--tenue);padding:4px 10px;border-radius:999px;
    font-size:12px;font-weight:600;cursor:pointer;
  }
  .lang-btn.activo{background:var(--acento);color:#fff}
  .card{
    background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01)),var(--panel);
    border:1px solid var(--borde);border-radius:16px;padding:18px 18px 20px;margin:0 0 16px;
  }
  .card h2{font-size:15px;margin:0 0 4px;letter-spacing:.01em}
  .card .hint{color:var(--tenue);font-size:13px;margin:0 0 14px}
  .perfiles{display:flex;gap:10px;flex-wrap:wrap}
  .perfil-btn{
    flex:1 1 200px;text-align:left;padding:11px 14px;border-radius:12px;
    background:var(--panel2);border:1px solid var(--borde);color:var(--texto);cursor:pointer;
  }
  .perfil-btn:hover{border-color:var(--acento)}
  .perfil-btn strong{display:block;font-size:13.5px}
  .perfil-btn span{display:block;font-size:12px;color:var(--tenue);font-weight:400;margin-top:2px}
  .opciones{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .opcion{
    display:flex;gap:11px;align-items:flex-start;padding:12px 13px;border-radius:12px;
    background:var(--panel2);border:1px solid var(--borde);cursor:pointer;transition:.15s;
  }
  .opcion:hover{border-color:#3a4560;transform:translateY(-1px)}
  .opcion input{margin:3px 0 0;accent-color:var(--acento);width:16px;height:16px;flex:0 0 auto}
  .opcion .t{font-weight:600;font-size:14px;display:block}
  .opcion .d{color:var(--tenue);font-size:12.5px;display:block}
  .opcion.activa{border-color:var(--acento);box-shadow:0 0 0 1px var(--acento) inset}
  .fila{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  label.campo{display:block}
  label.campo span{display:block;font-size:12.5px;color:var(--tenue);margin-bottom:6px}
  select{
    width:100%;padding:10px 12px;border-radius:10px;background:var(--panel2);
    color:var(--texto);border:1px solid var(--borde);font-size:14px;outline:none;
  }
  select:focus{border-color:var(--acento)}
  .interruptor{display:flex;align-items:center;gap:11px;padding:12px 13px;border-radius:12px;background:var(--panel2);border:1px solid var(--borde)}
  .interruptor input{width:18px;height:18px;accent-color:var(--acento2)}
  .nota{
    display:flex;gap:10px;font-size:12.5px;color:#fde68a;background:rgba(245,158,11,.08);
    border:1px solid rgba(245,158,11,.35);border-radius:10px;padding:10px 12px;margin-top:12px;
  }
  .url{
    display:flex;gap:8px;flex-wrap:wrap;align-items:stretch;margin-top:4px;
  }
  .url input{
    flex:1 1 320px;min-width:0;padding:11px 12px;border-radius:10px;background:#0d1117;
    color:#c7d2fe;border:1px solid var(--borde);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
  }
  button{
    border:0;border-radius:10px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;
    background:var(--panel2);color:var(--texto);border:1px solid var(--borde);transition:.15s;
  }
  button:hover{border-color:#3a4560}
  button.primario{background:linear-gradient(135deg,var(--acento),#5b8cff);border:0;color:#fff;box-shadow:0 6px 18px rgba(124,92,255,.35)}
  button.verde{background:linear-gradient(135deg,#16a34a,#22c55e);border:0;color:#06210f}
  .acciones{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .pie{color:var(--tenue);font-size:12.5px;margin-top:22px}
  .pie a{color:#a5b4fc}
  code{background:var(--panel2);padding:2px 6px;border-radius:6px;font-size:12.5px}
  @media (max-width:520px){
    .header-right{margin-left:0}
    .acciones button{flex:1 1 100%}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">UT</div>
    <div>
      <h1>${nombre}</h1>
      <p class="sub" data-es="Configura idioma (Español / Inglés), servidores y calidad. Todo se guarda en la URL del addon." data-en="Configure language (Spanish / English), servers and quality. Everything is saved in the addon URL.">Configura idioma (Español / Inglés), servidores y calidad. Todo se guarda en la URL del addon.</p>
    </div>
    <div class="header-right">
      <div class="lang-switch" role="group" aria-label="Idioma / Language">
        <button type="button" class="lang-btn${ui === 'es' ? ' activo' : ''}" data-ui="es">🇪🇸 Español</button>
        <button type="button" class="lang-btn${ui === 'en' ? ' activo' : ''}" data-ui="en">🇬🇧 English</button>
      </div>
      ${version ? `<span class="badge">v${version}</span>` : ''}
    </div>
  </header>

  <form id="form" autocomplete="off">
    <input type="hidden" name="ui" id="ui-input" value="${escaparHtml(ui)}">

    <div class="card">
      <h2 data-es="Configuración Rápida (Español / Inglés)" data-en="Quick Setup (Spanish / English)">Configuración Rápida (Español / Inglés)</h2>
      <p class="hint" data-es="Elige un perfil preconfigurado para Español, Inglés o Universal con un solo clic." data-en="Choose a preconfigured profile for Spanish, English or Universal with a single click.">Elige un perfil preconfigurado para Español, Inglés o Universal con un solo clic.</p>
      <div class="perfiles">
        <button type="button" class="perfil-btn" id="preset-ambos">
          <strong data-es="🌐 Universal (Español + Inglés)" data-en="🌐 Universal (Spanish + English)">🌐 Universal (Español + Inglés)</strong>
          <span data-es="Todos los servidores en Español e Inglés activos" data-en="All Spanish and English servers enabled">Todos los servidores en Español e Inglés activos</span>
        </button>
        <button type="button" class="perfil-btn" id="preset-es">
          <strong data-es="🇪🇸 Configuración Español" data-en="🇪🇸 Spanish Configuration">🇪🇸 Configuración Español</strong>
          <span data-es="Audio Latino, Castellano y Dual · Servidores hispanos" data-en="Latino, Castilian & Dual audio · Spanish servers">Audio Latino, Castellano y Dual · Servidores hispanos</span>
        </button>
        <button type="button" class="perfil-btn" id="preset-en">
          <strong data-es="🇬🇧 Configuración Inglés (English)" data-en="🇬🇧 English Configuration">🇬🇧 Configuración Inglés (English)</strong>
          <span data-es="Audio Inglés (VO) y Dual · Ordenado por seeders" data-en="English (VO) & Dual audio · Sorted by seeders">Audio Inglés (VO) y Dual · Ordenado por seeders</span>
        </button>
      </div>
    </div>

    <div class="card">
      <h2 data-es="Idioma del audio / Audio Language" data-en="Audio Language / Idioma del audio">Idioma del audio / Audio Language</h2>
      <p class="hint" data-es="Selecciona si prefieres streams en Español (Latino/Castellano/Dual), en Inglés (VO) o ambos." data-en="Select whether you prefer streams in Spanish (Latino/Castilian/Dual), English (VO), or both.">Selecciona si prefieres streams en Español (Latino/Castellano/Dual), en Inglés (VO) o ambos.</p>
      <div class="opciones" id="idioma">
        ${idiomas.map(op => `
        <label class="opcion" data-valor="${op.valor}">
          <input type="radio" name="idioma" value="${op.valor}"${marcar(cfg.idioma === op.valor)}>
          <span>
            <span class="t" data-es="${escaparHtml(op.titulo)}" data-en="${escaparHtml(op.tituloEn)}">${op.titulo}</span>
            <span class="d" data-es="${escaparHtml(op.texto)}" data-en="${escaparHtml(op.textoEn)}">${op.texto}</span>
          </span>
        </label>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2 data-es="Servidores de Streams" data-en="Stream Servers">Servidores de Streams</h2>
      <p class="hint" data-es="Activa o desactiva los nodos de búsqueda en Español e Inglés." data-en="Enable or disable Spanish and English search nodes.">Activa o desactiva los nodos de búsqueda en Español e Inglés.</p>
      <div class="opciones">
        <label class="opcion">
          <input type="checkbox" name="fuente" value="ht"${marcar(fuentes.has('ht'))}>
          <span>
            <span class="t" data-es="Servidor Español 1" data-en="Spanish Server 1">Servidor Español 1</span>
            <span class="d" data-es="Latino / Castellano / Dual · Catálogo + Búsqueda" data-en="Latino / Castilian / Dual · Catalog + Search">Latino / Castellano / Dual · Catálogo + Búsqueda</span>
          </span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="pp"${marcar(fuentes.has('pp') || cfg.fuentes === DEFAULTS.fuentes)}>
          <span>
            <span class="t" data-es="Servidor Español 2" data-en="Spanish Server 2">Servidor Español 2</span>
            <span class="d" data-es="Latino / Dual · Películas, Series y Anime HD" data-en="Latino / Dual · Movies, Series & Anime HD">Latino / Dual · Películas, Series y Anime HD</span>
          </span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="ss"${marcar(fuentes.has('ss') || cfg.fuentes === DEFAULTS.fuentes)}>
          <span>
            <span class="t" data-es="Servidor Español 3" data-en="Spanish Server 3">Servidor Español 3</span>
            <span class="d" data-es="Castellano / Latino / Dual · Cine y Series" data-en="Castilian / Latino / Dual · Movies & Series">Castellano / Latino / Dual · Cine y Series</span>
          </span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="knaben"${marcar(fuentes.has('knaben'))}>
          <span>
            <span class="t" data-es="Servidor Inglés 1" data-en="English Server 1">Servidor Inglés 1</span>
            <span class="d" data-es="Inglés (VO) · Alta disponibilidad y seeders reales" data-en="English (VO) · High availability & live seeders">Inglés (VO) · Alta disponibilidad y seeders reales</span>
          </span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="tcsv"${marcar(fuentes.has('tcsv'))}>
          <span>
            <span class="t" data-es="Servidor Inglés 2" data-en="English Server 2">Servidor Inglés 2</span>
            <span class="d" data-es="Índice verificado · Título, año y episodio exacto" data-en="Verified index · Exact title, year & episode">Índice verificado · Título, año y episodio exacto</span>
          </span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="tbb"${marcar(fuentes.has('tbb'))}>
          <span>
            <span class="t" data-es="Servidor Inglés 3 (DHT)" data-en="English Server 3 (DHT)">Servidor Inglés 3 (DHT)</span>
            <span class="d" data-es="Experimental · Red DHT adicional" data-en="Experimental · Additional DHT network">Experimental · Red DHT adicional</span>
          </span>
        </label>
      </div>
      <div class="nota">
        <span>⚠️</span>
        <span data-es="El Servidor Inglés 3 (DHT) está desactivado por defecto porque duplica resultados de otros servidores y prioriza packs." data-en="English Server 3 (DHT) is disabled by default because it duplicates results from other servers and prioritizes packs.">El Servidor Inglés 3 (DHT) está desactivado por defecto porque duplica resultados de otros servidores y prioriza packs.</span>
      </div>
    </div>

    <div class="card">
      <h2 data-es="Calidad y orden" data-en="Quality and Sort Order">Calidad y orden</h2>
      <p class="hint" data-es="Se aplica después del filtrado: nunca muestra otro título ni otro episodio." data-en="Applied after filtering: never shows a different title or episode.">Se aplica después del filtrado: nunca muestra otro título ni otro episodio.</p>
      <div class="fila">
        <label class="campo">
          <span data-es="Calidad mínima" data-en="Minimum Quality">Calidad mínima</span>
          <select name="calidad">
            ${calidades.map(([v, t]) => `<option value="${v}"${seleccionar(cfg.calidad === v)}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="campo">
          <span data-es="Orden de los resultados" data-en="Result Sort Order">Orden de los resultados</span>
          <select name="orden">
            ${ordenes.map(([v, t]) => `<option value="${v}"${seleccionar(cfg.orden === v)}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="campo">
          <span data-es="Máximo de resultados" data-en="Maximum Results">Máximo de resultados</span>
          <select name="max">
            ${maximos.map(v => `<option value="${v}"${seleccionar(cfg.max === v)}>${v} streams</option>`).join('')}
          </select>
        </label>
      </div>
      <div style="margin-top:14px">
        <label class="interruptor">
          <input type="checkbox" name="packs"${marcar(cfg.packs)}>
          <span data-es="Permitir packs de temporada cuando no exista el episodio exacto" data-en="Allow full season packs when the exact episode is unavailable">Permitir <strong>packs de temporada</strong> cuando no exista el episodio exacto</span>
        </label>
      </div>
    </div>

    <div class="card">
      <h2 data-es="Servidor y Subdominio Beamup (Alta Capacidad)" data-en="Server & Beamup Subdomain (High Capacity)">Servidor y Subdominio Beamup (Alta Capacidad)</h2>
      <p class="hint" data-es="Para bastantes usuarios concurrentes y mayor tiempo de respuesta, puedes usar el subdominio dedicado en baby-beamup.club." data-en="For many concurrent users and extended response time, you can use the dedicated baby-beamup.club subdomain.">Para bastantes usuarios concurrentes y mayor tiempo de respuesta, puedes usar el subdominio dedicado en <code>baby-beamup.club</code>.</p>
      <div class="fila">
        <label class="campo">
          <span data-es="Host de instalación" data-en="Installation Host">Host de instalación</span>
          <select name="servidor" id="servidor">
            <option value="actual">Servidor actual (automático) / Current Server</option>
            <option value="beamup">Beamup: ${escaparHtml(BEAMUP_HOST)} (alta capacidad / más tiempo)</option>
          </select>
        </label>
      </div>
    </div>

    <div class="card">
      <h2 data-es="Instalar en Stremio" data-en="Install in Stremio">Instalar en Stremio</h2>
      <p class="hint" data-es="Esta URL ya lleva tu configuración. Pégala en Stremio → Addons → «Add addon»." data-en="This URL already contains your configuration. Paste it into Stremio → Addons → 'Add addon'.">Esta URL ya lleva tu configuración. Pégala en Stremio → Addons → «Add addon».</p>
      <div class="url">
        <input id="url" readonly>
        <button type="button" class="primario" id="copiar">Copiar URL</button>
      </div>
      <div class="acciones">
        <button type="button" class="verde" id="instalar">Instalar en Stremio</button>
        <button type="button" id="manifest">Ver manifest</button>
        <button type="button" id="reset">Valores por defecto</button>
      </div>
      <div class="nota"><span>🔁</span><span data-es="Enlaces rápidos preconfigurados: /manifest.json (Universal), /es/manifest.json (Español) y /en/manifest.json (Inglés). Subdominio: ${escaparHtml(BEAMUP_ORIGIN)}/manifest.json" data-en="Quick preconfigured links: /manifest.json (Universal), /es/manifest.json (Spanish) and /en/manifest.json (English). Subdomain: ${escaparHtml(BEAMUP_ORIGIN)}/manifest.json">Enlaces rápidos preconfigurados: <code>/manifest.json</code> (Universal), <code>/es/manifest.json</code> (Español) y <code>/en/manifest.json</code> (Inglés). Subdominio: <code>${escaparHtml(BEAMUP_ORIGIN)}/manifest.json</code></span></div>
    </div>
  </form>

  <p class="pie" data-es="${nombre} ${version ? `v${version}` : ''} · Catálogos y streams universales en Español (Latino, Castellano y Dual) e Inglés (VO). No aloja contenido." data-en="${nombre} ${version ? `v${version}` : ''} · Universal catalogs and streams in Spanish (Latino, Castilian & Dual) and English (VO). Does not host content.">
    ${nombre} ${version ? `v${version}` : ''} · Catálogos y streams universales en Español (Latino, Castellano y Dual) e Inglés (VO).
    No aloja contenido. Los subtítulos se añaden con un addon tipo OpenSubtitles.
  </p>
</div>

<script>
(function () {
  var DEFAULTS = ${JSON.stringify(DEFAULTS)};
  var PERFILES = ${JSON.stringify(PERFILES_IDIOMA)};
  var BEAMUP_ORIGIN = ${JSON.stringify(BEAMUP_ORIGIN)};
  var form = document.getElementById('form');
  var urlInput = document.getElementById('url');
  var servidorSelect = document.getElementById('servidor');
  var uiInput = document.getElementById('ui-input');

  function aplicarIdiomaUI(lang) {
    var esEn = lang === 'en';
    uiInput.value = esEn ? 'en' : 'es';
    document.documentElement.lang = esEn ? 'en' : 'es';
    Array.prototype.forEach.call(document.querySelectorAll('.lang-btn'), function (b) {
      b.classList.toggle('activo', b.getAttribute('data-ui') === (esEn ? 'en' : 'es'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-es][data-en]'), function (el) {
      el.textContent = el.getAttribute(esEn ? 'data-en' : 'data-es');
    });
  }

  function aplicarPerfil(perfil) {
    if (!perfil) return;
    var radio = form.querySelector('input[name="idioma"][value="' + perfil.idioma + '"]');
    if (radio) radio.checked = true;
    var activas = String(perfil.fuentes || '').split(',');
    Array.prototype.forEach.call(form.querySelectorAll('input[name="fuente"]'), function (i) {
      i.checked = activas.indexOf(i.value) !== -1;
    });
    if (perfil.calidad) form.querySelector('select[name="calidad"]').value = perfil.calidad;
    if (perfil.orden) form.querySelector('select[name="orden"]').value = perfil.orden;
    if (perfil.max) form.querySelector('select[name="max"]').value = String(perfil.max);
    if (typeof perfil.packs === 'boolean') form.querySelector('input[name="packs"]').checked = perfil.packs;
    actualizar();
  }

  function configActual() {
    var idioma = (form.querySelector('input[name="idioma"]:checked') || {}).value || DEFAULTS.idioma;
    var fuentes = Array.prototype.slice.call(form.querySelectorAll('input[name="fuente"]:checked'))
      .map(function (i) { return i.value; });
    var ordenFuentes = ['ht', 'pp', 'ss', 'knaben', 'tbb', 'tcsv'].filter(function (f) { return fuentes.indexOf(f) !== -1; });
    var calidad = form.querySelector('select[name="calidad"]').value;
    var orden = form.querySelector('select[name="orden"]').value;
    var max = parseInt(form.querySelector('select[name="max"]').value, 10) || DEFAULTS.max;
    var packs = form.querySelector('input[name="packs"]').checked;

    var cfg = {
      idioma: idioma,
      fuentes: ordenFuentes.length ? ordenFuentes.join(',') : 'ht',
      calidad: calidad,
      orden: orden,
      max: max,
      packs: packs
    };
    Object.keys(cfg).forEach(function (k) {
      if (cfg[k] === DEFAULTS[k]) delete cfg[k];
    });
    return cfg;
  }

  function urlConfig(cfg) {
    var origin = (servidorSelect && servidorSelect.value === 'beamup') ? BEAMUP_ORIGIN : window.location.origin;
    var base = origin + '/';
    var json = JSON.stringify(cfg);
    if (Object.keys(cfg).length === 0) return base + 'manifest.json';
    return base + encodeURIComponent(json) + '/manifest.json';
  }

  function pintarSeleccion() {
    Array.prototype.forEach.call(document.querySelectorAll('#idioma .opcion'), function (el) {
      var input = el.querySelector('input');
      el.classList.toggle('activa', input.checked);
    });
  }

  function actualizar() {
    pintarSeleccion();
    var cfg = configActual();
    var url = urlConfig(cfg);
    urlInput.value = url;
    try { history.replaceState(null, '', '/configure?' + new URLSearchParams(cfg).toString()); } catch (e) {}
    return { cfg: cfg, url: url };
  }

  Array.prototype.forEach.call(document.querySelectorAll('.lang-btn'), function (btn) {
    btn.addEventListener('click', function () {
      aplicarIdiomaUI(this.getAttribute('data-ui'));
    });
  });

  document.getElementById('preset-ambos').addEventListener('click', function () {
    aplicarPerfil({ idioma: 'ambos', fuentes: 'ht,pp,ss,knaben,tcsv', calidad: 'cualquiera', orden: 'latino', max: 25, packs: true });
  });
  document.getElementById('preset-es').addEventListener('click', function () {
    aplicarIdiomaUI('es');
    aplicarPerfil(PERFILES.es);
  });
  document.getElementById('preset-en').addEventListener('click', function () {
    aplicarIdiomaUI('en');
    aplicarPerfil(PERFILES.en);
  });

  form.addEventListener('input', actualizar);
  form.addEventListener('change', actualizar);

  document.getElementById('copiar').addEventListener('click', function () {
    var boton = this;
    var texto = urlInput.value;
    var listo = function () {
      boton.textContent = '¡Copiado!';
      setTimeout(function () { boton.textContent = 'Copiar URL'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(listo, function () { urlInput.select(); });
    } else {
      urlInput.select();
      try { document.execCommand('copy'); listo(); } catch (e) {}
    }
  });

  document.getElementById('instalar').addEventListener('click', function () {
    var url = urlInput.value.replace(/^https?:\\/\\//, 'stremio://');
    window.location.href = url;
  });

  document.getElementById('manifest').addEventListener('click', function () {
    window.open(urlInput.value, '_blank', 'noopener');
  });

  document.getElementById('reset').addEventListener('click', function () {
    form.querySelector('input[name="idioma"][value="' + DEFAULTS.idioma + '"]').checked = true;
    Array.prototype.forEach.call(form.querySelectorAll('input[name="fuente"]'), function (i) {
      i.checked = DEFAULTS.fuentes.split(',').indexOf(i.value) !== -1;
    });
    form.querySelector('select[name="calidad"]').value = DEFAULTS.calidad;
    form.querySelector('select[name="orden"]').value = DEFAULTS.orden;
    form.querySelector('select[name="max"]').value = String(DEFAULTS.max);
    form.querySelector('input[name="packs"]').checked = DEFAULTS.packs;
    actualizar();
  });

  if (uiInput.value === 'en') {
    aplicarIdiomaUI('en');
  }
  actualizar();
})();
</script>
</body>
</html>`;
}

module.exports = { renderConfigPage, escaparHtml };
