/**
 * lib/configPage.js
 * ---------------------------------------------------------------------------
 * Página web /configure del addon.
 *
 * Genera HTML autocontenido (CSS + JS embebidos, sin CDN ni fuentes externas)
 * con el formulario de configuración y construye la URL de instalación en el
 * formato de Stremio:  /<configJSON>/manifest.json
 *
 * Funciona detrás de proxy/preview porque todas las URLs son relativas y el
 * enlace de instalación se calcula con `location.origin` en el navegador.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { normalizarConfig, serializarConfig, DEFAULTS } = require('./config');

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
  const fuentes = new Set(String(cfg.fuentes).split(','));

  const version = escaparHtml(manifest.version || '');
  const nombre = escaparHtml(manifest.name || 'HackTorrent');

  const idiomas = [
    { valor: 'ambos', titulo: 'Ambos', texto: 'Latino primero y también inglés (VO)' },
    { valor: 'latino', titulo: 'Latino / Español', texto: 'Sólo audio latino, castellano o dual' },
    { valor: 'ingles', titulo: 'Inglés (VO)', texto: 'Sólo audio inglés o dual' }
  ];

  const calidades = [
    ['cualquiera', 'Cualquiera'],
    ['720p', '720p o más'],
    ['1080p', '1080p o más'],
    ['4k', 'Sólo 4K']
  ];

  const ordenes = [
    ['latino', 'Latino primero, luego seeders'],
    ['seeders', 'Más seeders primero'],
    ['calidad', 'Mejor calidad primero']
  ];

  const maximos = [10, 20, 25, 40, 60];

  return `<!DOCTYPE html>
<html lang="es">
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
    display:grid;place-items:center;font-size:26px;font-weight:800;color:#fff;
    box-shadow:0 8px 24px rgba(124,92,255,.35);
  }
  h1{font-size:clamp(20px,3.4vw,27px);margin:0;letter-spacing:-.02em}
  .sub{color:var(--tenue);font-size:14px;margin:2px 0 0}
  .badge{
    margin-left:auto;font-size:12px;color:#cbd5e1;background:var(--panel2);
    border:1px solid var(--borde);padding:5px 10px;border-radius:999px;
  }
  .card{
    background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01)),var(--panel);
    border:1px solid var(--borde);border-radius:16px;padding:18px 18px 20px;margin:0 0 16px;
  }
  .card h2{font-size:15px;margin:0 0 4px;letter-spacing:.01em}
  .card .hint{color:var(--tenue);font-size:13px;margin:0 0 14px}
  .opciones{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .opcion{
    display:flex;gap:11px;align-items:flex-start;padding:12px 13px;border-radius:12px;
    background:var(--panel2);border:1px solid var(--borde);cursor:pointer;transition:.15s;
  }
  .opcion:hover{border-color:#3a4560;transform:translateY(-1px)}
  .opcion input{margin:3px 0 0;accent-color:var(--acento);width:16px;height:16px;flex:0 0 auto}
  .opcion .t{font-weight:600;font-size:14px}
  .opcion .d{color:var(--tenue);font-size:12.5px}
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
    .badge{margin-left:0}
    .acciones button{flex:1 1 100%}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">HT</div>
    <div>
      <h1>${nombre}</h1>
      <p class="sub">Elige idioma, fuentes y calidad. Se guarda en la propia URL del addon.</p>
    </div>
    ${version ? `<span class="badge">v${version}</span>` : ''}
  </header>

  <form id="form" autocomplete="off">
    <div class="card">
      <h2>Idioma del audio</h2>
      <p class="hint">HackTorrent suele traer Latino; Knaben y Black Hole Bay son inglés (VO).</p>
      <div class="opciones" id="idioma">
        ${idiomas.map(op => `
        <label class="opcion" data-valor="${op.valor}">
          <input type="radio" name="idioma" value="${op.valor}"${marcar(cfg.idioma === op.valor)}>
          <span><span class="t">${op.titulo}</span><span class="d">${op.texto}</span></span>
        </label>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Fuentes</h2>
      <p class="hint">Desactiva la que no quieras ver en la lista de streams.</p>
      <div class="opciones">
        <label class="opcion">
          <input type="checkbox" name="fuente" value="ht"${marcar(fuentes.has('ht'))}>
          <span><span class="t">HackTorrent</span><span class="d">Latino / Castellano / Dual · catalogue + búsqueda</span></span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="knaben"${marcar(fuentes.has('knaben'))}>
          <span><span class="t">Knaben</span><span class="d">Inglés · ~30 trackers, seeders reales</span></span>
        </label>
        <label class="opcion">
          <input type="checkbox" name="fuente" value="tbb"${marcar(fuentes.has('tbb'))}>
          <span><span class="t">Black Hole Bay <em style="color:var(--aviso);font-style:normal">experimental</em></span><span class="d">DHT · se solapa con Knaben</span></span>
        </label>
      </div>
      <div class="nota">
        <span>⚠️</span>
        <span>Black Hole Bay está desactivada por defecto: repite muchos resultados de Knaben y suele faltar episodios sueltos.</span>
      </div>
    </div>

    <div class="card">
      <h2>Calidad y orden</h2>
      <p class="hint">Se aplica después del filtrado: nunca muestra otro título ni otro episodio.</p>
      <div class="fila">
        <label class="campo">
          <span>Calidad mínima</span>
          <select name="calidad">
            ${calidades.map(([v, t]) => `<option value="${v}"${seleccionar(cfg.calidad === v)}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="campo">
          <span>Orden de los resultados</span>
          <select name="orden">
            ${ordenes.map(([v, t]) => `<option value="${v}"${seleccionar(cfg.orden === v)}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="campo">
          <span>Máximo de resultados</span>
          <select name="max">
            ${maximos.map(v => `<option value="${v}"${seleccionar(cfg.max === v)}>${v} streams</option>`).join('')}
          </select>
        </label>
      </div>
      <div style="margin-top:14px">
        <label class="interruptor">
          <input type="checkbox" name="packs"${marcar(cfg.packs)}>
          <span>Permitir <strong>packs de temporada</strong> cuando no exista el episodio exacto</span>
        </label>
      </div>
    </div>

    <div class="card">
      <h2>Instalar en Stremio</h2>
      <p class="hint">Esta URL ya lleva tu configuración. Pégala en Stremio → Addons → «Add addon».</p>
      <div class="url">
        <input id="url" readonly>
        <button type="button" class="primario" id="copiar">Copiar URL</button>
      </div>
      <div class="acciones">
        <button type="button" class="verde" id="instalar">Instalar en Stremio</button>
        <button type="button" id="manifest">Ver manifest</button>
        <button type="button" id="reset">Valores por defecto</button>
      </div>
      <div class="nota"><span>🔁</span><span>Si ya lo tenías instalado, desinstálalo y vuelve a instalarlo con esta URL para que tome los cambios.</span></div>
    </div>
  </form>

  <p class="pie">
    ${nombre} ${version ? `v${version}` : ''} · Streams vía magnets públicos (HackTorrent, Knaben, The Black Hole Bay).
    No aloja contenido. Los subtítulos se añaden con un addon tipo OpenSubtitles.
  </p>
</div>

<script>
(function () {
  var DEFAULTS = ${JSON.stringify(DEFAULTS)};
  var form = document.getElementById('form');
  var urlInput = document.getElementById('url');
  var subida = false;

  function configActual() {
    var idioma = (form.querySelector('input[name="idioma"]:checked') || {}).value || DEFAULTS.idioma;
    var fuentes = Array.prototype.slice.call(form.querySelectorAll('input[name="fuente"]:checked'))
      .map(function (i) { return i.value; });
    var ordenFuentes = ['ht', 'knaben', 'tbb'].filter(function (f) { return fuentes.indexOf(f) !== -1; });
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
    // Omitir valores por defecto → URL más corta (igual que lib/config.js)
    Object.keys(cfg).forEach(function (k) {
      if (cfg[k] === DEFAULTS[k]) delete cfg[k];
    });
    return cfg;
  }

  function urlConfig(cfg) {
    var base = window.location.origin + '/';
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

  actualizar();
})();
</script>
</body>
</html>`;
}

module.exports = { renderConfigPage, escaparHtml };
