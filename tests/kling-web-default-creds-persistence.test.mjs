import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const MOCK_PORT = 19193;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const APP_PORT_FALLBACK = 18182;
const APP_PORT_PERSISTENCE = 18183;
const BASE_URL_FALLBACK = `http://127.0.0.1:${APP_PORT_FALLBACK}`;
const BASE_URL_PERSISTENCE = `http://127.0.0.1:${APP_PORT_PERSISTENCE}`;

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=';
const RESULT_IMAGE = Buffer.from(PNG_BASE64, 'base64');
const HISTORY_IMAGE_URL = `${MOCK_BASE_URL}/generated/history-1.png`;
const RESULT_IMAGE_URL = `${MOCK_BASE_URL}/generated/result-1.png`;
const SECOND_RESULT_IMAGE_URL = `${MOCK_BASE_URL}/generated/result-2.png`;

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

async function stopApp() {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
    await once(appProcess, 'exit').catch(() => null);
  }
  appProcess = null;
}

async function startApp({ port, artifactsDir, tasksStatePath }) {
  await stopApp();
  appProcess = spawn('node', ['--enable-source-maps', '--no-node-snapshot', 'dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SERVER_PORT: String(port),
      KLING_AUTH_MODE: 'web',
      KLING_WEB_TARGET_URL: `${MOCK_BASE_URL}/mock-kling/image/new`,
      KLING_WEB_WAIT_TIMEOUT_MS: '8000',
      KLING_WEB_RESULT_POLL_INTERVAL_MS: '200',
      KLING_WEB_ARTIFACTS_DIR: artifactsDir,
      KLING_WEB_TASKS_STATE_PATH: tasksStatePath,
      BROWSER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', () => {});

  await waitForServer(`http://127.0.0.1:${port}/v1/models`);
}

async function waitForTask(baseUrl, taskId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/v1/images/generations/${taskId}`);
    const json = await response.json();
    if (json?.data?.task_status === 'succeed') {
      return json;
    }
    if (json?.data?.task_status === 'failed') {
      throw new Error(json?.data?.task_status_msg || 'task failed');
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for web task ${taskId}`);
}

before(async () => {
  mockServer = http.createServer(async (req, res) => {
    if (req.url === '/generated/history-1.png') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(RESULT_IMAGE);
      return;
    }

    if (req.url === '/generated/result-1.png') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(RESULT_IMAGE);
      return;
    }

    if (req.url === '/generated/result-2.png') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(RESULT_IMAGE);
      return;
    }

    if (req.url === '/api/task/create' && req.method === 'POST') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { task_id: 'mock-web-task-1' } }));
      return;
    }

    if (req.url === '/api/task/result' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        data: {
          task_id: 'mock-web-task-1',
          task_status: 'succeed',
          images: [
            { url: RESULT_IMAGE_URL },
            { url: SECOND_RESULT_IMAGE_URL },
          ],
        },
      }));
      return;
    }

    if (req.url === '/api/history' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        data: {
          history: [
            {
              works: [
                {
                  resource: { resource: HISTORY_IMAGE_URL },
                },
              ],
            },
          ],
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
    <div id="history">
      <img id="history-preview" src="${HISTORY_IMAGE_URL}" width="512" height="512" />
    </div>
    <div id="result"></div>
    <script>
      const editor = document.getElementById('editor');
      const button = document.getElementById('generate-btn');
      const result = document.getElementById('result');
      fetch('/api/history').catch(() => null);
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
          img.src = json.data.images[0].url;
          img.width = 512;
          img.height = 512;
          result.appendChild(img);
        }, 600);
      });
    </script>
  </body>
</html>`);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  mockServer.listen(MOCK_PORT, '127.0.0.1');
  await once(mockServer, 'listening');
});

after(async () => {
  await stopApp();
  if (mockServer) {
    await new Promise((resolve, reject) => {
      mockServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('Kling web request should fall back to local kling.json when request omits inline credentials', async () => {
  const artifactsDir = './tmp/test-kling-web-provider-default-creds';
  const tasksStatePath = './tmp/test-kling-web-provider-default-creds/tasks.json';
  await fs.rm(artifactsDir, { recursive: true, force: true });

  await startApp({
    port: APP_PORT_FALLBACK,
    artifactsDir,
    tasksStatePath,
  });

  const response = await fetch(`${BASE_URL_FALLBACK}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'use default local kling json',
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
      },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.provider, 'kling');
  assert.equal(json.transport, 'web');
  assert.equal(json.status, 'succeed');
  assert.deepEqual(json.data, [
    { url: RESULT_IMAGE_URL },
    { url: SECOND_RESULT_IMAGE_URL },
  ]);
});

test('Kling async web task should still be queryable after service restart when persistence is enabled', async () => {
  const artifactsDir = './tmp/test-kling-web-provider-persistence';
  const tasksStatePath = './tmp/test-kling-web-provider-persistence/tasks.json';
  await fs.rm(artifactsDir, { recursive: true, force: true });

  await startApp({
    port: APP_PORT_PERSISTENCE,
    artifactsDir,
    tasksStatePath,
  });

  const createResponse = await fetch(`${BASE_URL_PERSISTENCE}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'persist web task across restart',
      async: true,
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        cookies: [],
      },
    }),
  });
  const created = await createResponse.json();

  assert.equal(createResponse.status, 200);
  assert.match(created.task_id, /^kling-web-/);

  const finished = await waitForTask(BASE_URL_PERSISTENCE, created.task_id);
  assert.equal(finished.data.task_status, 'succeed');

  await stopApp();
  await startApp({
    port: APP_PORT_PERSISTENCE,
    artifactsDir,
    tasksStatePath,
  });

  const afterRestartResponse = await fetch(`${BASE_URL_PERSISTENCE}/v1/images/generations/${created.task_id}`);
  const afterRestart = await afterRestartResponse.json();

  assert.equal(afterRestartResponse.status, 200);
  assert.equal(afterRestart.data.task_status, 'succeed');
  assert.deepEqual(afterRestart.data.task_result.images, [
    { index: 0, url: RESULT_IMAGE_URL },
    { index: 1, url: SECOND_RESULT_IMAGE_URL },
  ]);
});
