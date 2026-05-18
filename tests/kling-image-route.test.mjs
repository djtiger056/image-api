import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const APP_PORT = 18180;
const MOCK_PORT = 19191;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

let mockServer;
let appProcess;

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
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : {};

    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/api/task/create') {
      res.end(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'req-create',
        data: {
          task_id: 'mock-web-task-1',
          task_status: 'submitted',
          created_at: 1,
          updated_at: 1,
        },
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/task/result') {
      res.end(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'req-result',
        data: {
          task_id: 'mock-web-task-1',
          task_status: 'succeed',
          task_result: {
            images: [
              { index: 0, url: `${MOCK_BASE_URL}/generated/result-1.png` },
            ],
          },
          created_at: 1,
          updated_at: 2,
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
        await fetch('/api/task/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: editor.innerText })
        });
        setTimeout(async () => {
          const response = await fetch('/api/task/result');
          const json = await response.json();
          const img = document.createElement('img');
          img.src = json.data.task_result.images[0].url;
          img.width = 512;
          img.height = 512;
          result.appendChild(img);
        }, 300);
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
    res.end(JSON.stringify({ code: 404, message: `not found: ${req.method} ${req.url}`, body }));
  });

  mockServer.listen(MOCK_PORT, '127.0.0.1');
  await once(mockServer, 'listening');

  appProcess = spawn('node', ['--enable-source-maps', '--no-node-snapshot', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SERVER_PORT: String(APP_PORT),
      KLING_AUTH_MODE: 'web',
      KLING_WEB_TARGET_URL: `${MOCK_BASE_URL}/mock-kling/image/new`,
      KLING_WEB_WAIT_TIMEOUT_MS: '8000',
      KLING_WEB_RESULT_POLL_INTERVAL_MS: '200',
      KLING_WEB_ARTIFACTS_DIR: './tmp/test-kling-web-provider',
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
  }
  if (mockServer) {
    await new Promise((resolve, reject) => {
      mockServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('Kling unified async request should return wrapped web task response', async () => {
  const response = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'web sync robot',
      async: true,
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        storage_state: { cookies: [], origins: [] },
      },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.provider, 'kling');
  assert.equal(json.transport, 'web');
  assert.equal(json.status, 'processing');
  assert.match(json.task_id, /^kling-web-/);
});

test('Kling unified sync request should return image urls from web mode', async () => {
  const response = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'web sync robot',
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        storage_state: { cookies: [], origins: [] },
      },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.provider, 'kling');
  assert.equal(json.transport, 'web');
  assert.equal(json.status, 'succeed');
  assert.deepEqual(json.data, [{ url: `${MOCK_BASE_URL}/generated/result-1.png` }]);
});

test('Kling native request should accept model_name and still use web mode', async () => {
  const response = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_name: 'kling-v2-1',
      prompt: 'native web robot',
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        cookies: [],
      },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.provider, 'kling');
  assert.equal(json.transport, 'web');
  assert.equal(json.status, 'succeed');
  assert.deepEqual(json.data, [{ url: `${MOCK_BASE_URL}/generated/result-1.png` }]);
});
