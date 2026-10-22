'use strict';

/**
 * lib/timeouts.js: en serverless hay que responder antes del corte de la
 * función, así que el tope global debe recortar (nunca ampliar) los timeouts.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { timeout, TOPE_GLOBAL } = require('../lib/timeouts');

function timeoutConEnv(valor, extraEnv = '') {
  const codigo = `
    ${extraEnv}
    const { timeout } = require('./lib/timeouts');
    process.stdout.write(String(timeout(${valor})));
  `;
  return execFileSync(process.execPath, ['-e', codigo], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, AWS_LAMBDA_FUNCTION_NAME: '', LAMBDA_TASK_ROOT: '', ADDON_HTTP_TIMEOUT_MS: '' }
  }).trim();
}

test('timeout: sin tope global devuelve el valor propio', () => {
  assert.strictEqual(TOPE_GLOBAL, 0);
  assert.strictEqual(timeout(15000), 15000);
  assert.strictEqual(timeout(8000), 8000);
});

test('timeout: valores inválidos caen al valor por defecto', () => {
  assert.strictEqual(timeout(undefined, 9000), 9000);
  assert.strictEqual(timeout('abc', 9000), 9000);
  assert.strictEqual(timeout(0, 9000), 9000);
});

test('timeout: ADDON_HTTP_TIMEOUT_MS recorta los timeouts largos', () => {
  assert.strictEqual(timeoutConEnv(15000, "process.env.ADDON_HTTP_TIMEOUT_MS = '4000';"), '4000');
  // Nunca amplía: un timeout menor se respeta
  assert.strictEqual(timeoutConEnv(2000, "process.env.ADDON_HTTP_TIMEOUT_MS = '4000';"), '2000');
});

test('timeout: en AWS Lambda (Netlify) hay tope de 8000 ms por defecto', () => {
  assert.strictEqual(timeoutConEnv(15000, "process.env.AWS_LAMBDA_FUNCTION_NAME = 'addon';"), '8000');
  assert.strictEqual(
    timeoutConEnv(15000, "process.env.AWS_LAMBDA_FUNCTION_NAME = 'addon'; process.env.ADDON_HTTP_TIMEOUT_MS = '5000';"),
    '5000'
  );
});
