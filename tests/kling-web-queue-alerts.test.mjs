import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const APP_PORT = 18185;
const MOCK_PORT = 19194;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const ALERTS_PATH = './tmp/test-kling-web-queue-alerts/alerts.jsonl';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=';
const RESULT_IMAGE = Buffer.from(PNG_BASE64, 'base64');

let mockServer;
let appProcess;
const createdTasks = new Map();
const receivedAlerts = [];

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

async function waitForTask(taskId, expectedStatus = 'succeed', timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${BASE_URL}/v1/images/generations/${taskId}`);
    const json = await response.json();
    const status = json?.data?.task_status;
    if (status === expectedStatus) return json;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for task ${taskId} -> ${expectedStatus}`);
}

before(async () => {
  await fs.rm('./tmp/test-kling-web-queue-alerts', { recursive: true, force: true });

  mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const jsonBody = rawBody ? JSON.parse(rawBody) : {};

    if (req.url?.startsWith('/generated/')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.end(RESULT_IMAGE);
      return;
    }

    if (req.url === '/api/task/create' && req.method === 'POST') {
      const taskId = `mock-task-${createdTasks.size + 1}`;
      createdTasks.set(taskId, { prompt: jsonBody.prompt || '' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { task_id: taskId } }));
      return;
    }

    if (req.url?.startsWith('/api/task/result') && req.method === 'GET') {
      const url = new URL(`${MOCK_BASE_URL}${req.url}`);
      const taskId = url.searchParams.get('taskId');
      const task = createdTasks.get(taskId);
      const prompt = task?.prompt || '';
      const delay = prompt.includes('slow-first') ? 1800 : 200;
      await sleep(delay);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        data: {
          task_id: taskId,
          task_status: 'succeed',
          images: [
            { url: `${MOCK_BASE_URL}/generated/${taskId}-1.png` },
          ],
        },
      }));
      return;
    }

    if (req.url === '/alerts' && req.method === 'POST') {
      receivedAlerts.push(jsonBody);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
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
        const createResp = await fetch('/api/task/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: editor.innerText })
        });
        const created = await createResp.json();
        const taskId = created.data.task_id;
        const response = await fetch('/api/task/result?taskId=' + encodeURIComponent(taskId));
        const json = await response.json();
        const img = document.createElement('img');
        img.src = json.data.images[0].url;
        img.width = 512;
        img.height = 512;
        result.appendChild(img);
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (req.url === '/mock-kling/image/fail') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><body><div>broken page without prompt editor</div></body></html>');
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
      KLING_AUTH_MODE: 'web',
      KLING_WEB_TARGET_URL: `${MOCK_BASE_URL}/mock-kling/image/new`,
      KLING_WEB_WAIT_TIMEOUT_MS: '8000',
      KLING_WEB_RESULT_POLL_INTERVAL_MS: '100',
      KLING_WEB_ARTIFACTS_DIR: './tmp/test-kling-web-queue-alerts/artifacts',
      KLING_WEB_TASKS_STATE_PATH: './tmp/test-kling-web-queue-alerts/tasks.json',
      KLING_WEB_MAX_CONCURRENT_TASKS: '1',
      KLING_WEB_FAILURE_ALERT_WEBHOOK_URL: `${MOCK_BASE_URL}/alerts`,
      KLING_WEB_FAILURE_ALERTS_PATH: ALERTS_PATH,
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

test('Kling async web tasks should queue when concurrency limit is reached', async () => {
  const create1 = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'slow-first task',
      async: true,
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        cookies: [],
      },
    }),
  }).then((r) => r.json());

  const create2 = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'queued-second task',
      async: true,
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/new`,
        cookies: [],
      },
    }),
  }).then((r) => r.json());

  const queuedState = await fetch(`${BASE_URL}/v1/images/generations/${create2.task_id}`).then((r) => r.json());
  assert.equal(queuedState.data.task_status, 'queued');

  await waitForTask(create1.task_id, 'succeed');
  const completedSecond = await waitForTask(create2.task_id, 'succeed');
  assert.equal(completedSecond.data.task_status, 'succeed');
});

test('Kling web failures should emit persistent alert and webhook notification', async () => {
  receivedAlerts.length = 0;

  const created = await fetch(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kling-v2-1',
      prompt: 'this should fail',
      async: true,
      provider_options: {
        transport: 'web',
        target_url: `${MOCK_BASE_URL}/mock-kling/image/fail`,
        cookies: [],
      },
    }),
  }).then((r) => r.json());

  const failed = await waitForTask(created.task_id, 'failed');
  assert.equal(failed.data.task_status, 'failed');
  assert.equal(receivedAlerts.length, 1);
  assert.equal(receivedAlerts[0].taskId, created.task_id);
  assert.match(receivedAlerts[0].error || '', /editor|textbox|visible|prompt/i);

  const alertsText = await fs.readFile(ALERTS_PATH, 'utf8');
  assert.match(alertsText, new RegExp(created.task_id));
});
