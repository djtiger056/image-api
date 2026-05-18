import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const APP_PORT = 18186;
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

test('Console page should include log panel and Kling polling hints', async () => {
  const response = await fetch(`${BASE_URL}/console`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /前端执行日志/);
  assert.match(text, /自动轮询结果并记录日志/);
  assert.match(text, /Kling 任务成功/);
});
