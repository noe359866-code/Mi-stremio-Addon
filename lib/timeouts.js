/**
 * lib/timeouts.js
 * ---------------------------------------------------------------------------
 * Un único punto para los timeouts HTTP del addon.
 *
 * En un servidor propio (Render, VPS, Docker) no hace falta tocar nada: cada
 * petición usa su timeout "natural" (8–15 s).
 *
 * En plataformas serverless (Netlify Functions, Vercel…) el presupuesto de una
 * petición es mucho menor, así que se puede fijar un tope global con:
 *
 *   ADDON_HTTP_TIMEOUT_MS=8000      # tope para TODAS las peticiones salientes
 *
 * Si estás en AWS Lambda (Netlify corre allí) y no defines la variable, se
 * aplica un tope conservador de 8000 ms para responder antes del corte de la
 * función. Nunca se sube el timeout de una petición: sólo se recorta.
 * ---------------------------------------------------------------------------
 */

'use strict';

function entero(valor) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Tope global. Prioridad: env explícita > valor por defecto serverless > sin tope.
const TOPE_GLOBAL = (() => {
  const explicito = entero(process.env.ADDON_HTTP_TIMEOUT_MS);
  if (explicito) return explicito;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT) return 8000;
  return 0;
})();

/**
 * Devuelve el timeout efectivo de una petición.
 * @param {number} valor timeout propio de la llamada (ms)
 * @param {number} [porDefecto] valor si `valor` no es válido
 * @returns {number} ms
 */
function timeout(valor, porDefecto = 10000) {
  const propio = entero(valor) || porDefecto;
  return TOPE_GLOBAL > 0 ? Math.min(propio, TOPE_GLOBAL) : propio;
}

module.exports = { timeout, TOPE_GLOBAL };
