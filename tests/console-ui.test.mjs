import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const APP_PORT = 18185;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

let appProcess;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

before(async () => {
  appProcess = spawn('node', ['--enable-source-maps', '--no-node-snapshot', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SERVER_PORT: String(APP_PORT),
      JIMENG_SESSIONID: 'session-a,session-b',
      KLING_WEB_STORAGE_STATE_JSON: JSON.stringify({
        cookies: [{ name: 'sessionid', value: 'kling-demo', domain: '.klingai.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }],
        origins: [],
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', () => {});

  await waitForServer(`${BASE_URL}/console`);
});

after(async () => {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
  }
});

test('Console page should be publicly accessible', async () => {
  const response = await fetch(`${BASE_URL}/console`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /控制台/);
  assert.match(text, /外部调用说明/);
});

test('API guide page should be publicly accessible', async () => {
  const response = await fetch(`${BASE_URL}/docs/api-guide`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /外部调用说明/);
  assert.match(text, /\/v1\/images\/generations/);
});

test('Console status should report configured credentials', async () => {
  const response = await fetch(`${BASE_URL}/console/status`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.credentials.jimeng.configured, true);
  assert.equal(json.credentials.jimeng.token_count, 2);
  assert.equal(json.credentials.kling.configured, true);
  assert.equal(json.credentials.kling.cookies_count, 1);
});
