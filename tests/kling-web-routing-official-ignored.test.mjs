import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const APP_PORT = 18284;
const MOCK_PORT = 19284;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

let mockServer;
let appProcess;
let officialRequests = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

before(async () => {
  mockServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/images/generations' && req.method === 'POST') {
      officialRequests += 1;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        message: 'official should not be used',
        data: {
          task_id: 'official-task-1',
          task_status: 'submitted',
        },
      }));
      return;
    }

    if (req.url === '/mock-kling/image/new') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html>
  <body>
    <div id="editor" contenteditable="true" role="textbox"></div>
    <button id="generate-btn">Generate</button>
    <div id="result"></div>
    <script>
      const editor = document.getElementById('editor');
      const button = document.getElementById('generate-btn');
      const result = document.getElementById('result');
      button.addEventListener('click', async () => {
        setTimeout(() => {
          const img = document.createElement('img');
          img.src = '${MOCK_BASE_URL}/generated/result-1.png';
          result.appendChild(img);
        }, 200);
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (req.url === '/generated/result-1.png') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=', 'base64'));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  mockServer.listen(MOCK_PORT, '127.0.0.1');
  await once(mockServer, 'listening');

  appProcess = spawn('node', ['--enable-source-maps', '--no-node-snapshot', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SERVER_PORT: String(APP_PORT),
      KLING_AUTH_MODE: 'official',
      KLING_API_TOKEN: 'test.jwt.token',
      KLING_BASE_URL: MOCK_BASE_URL,
      KLING_WEB_TARGET_URL: `${MOCK_BASE_URL}/mock-kling/image/new`,
      KLING_WEB_WAIT_TIMEOUT_MS: '8000',
      KLING_WEB_RESULT_POLL_INTERVAL_MS: '200',
      BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
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
    await once(appProcess, 'exit').catch(() => null);
  }
  if (mockServer) {
    await new Promise((resolve, reject) => {
      mockServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('Kling should ignore official routing and always use web transport', async () => {
  const response = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'route always web',
      async: true,
      provider_options: {
        transport: 'official',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        storage_state: { cookies: [], origins: [] },
      },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.provider, 'kling');
  assert.equal(json.transport, 'web');
  assert.match(json.task_id, /^kling-web-/);
  assert.equal(officialRequests, 0, 'official upstream must not be called');
});
