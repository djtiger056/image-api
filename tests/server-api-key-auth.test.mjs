import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const APP_PORT = 18184;
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
      SERVER_API_KEYS: 'test-key-1,test-key-2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', () => {});

  await waitForServer(`${BASE_URL}/v1/models`);
});

after(async () => {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
  }
});

test('Protected API route should reject requests without x-api-key', async () => {
  const response = await fetch(`${BASE_URL}/v1/models`);
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.match(json.message, /API Key/i);
});

test('Protected API route should reject requests with wrong x-api-key', async () => {
  const response = await fetch(`${BASE_URL}/v1/models`, {
    headers: {
      'x-api-key': 'wrong-key',
    },
  });
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.match(json.message, /API Key/i);
});

test('Protected API route should allow requests with configured x-api-key', async () => {
  const response = await fetch(`${BASE_URL}/v1/models`, {
    headers: {
      'x-api-key': 'test-key-2',
    },
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(json.data));
});

test('/ping should remain publicly accessible', async () => {
  const response = await fetch(`${BASE_URL}/ping`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(text, 'pong');
});
