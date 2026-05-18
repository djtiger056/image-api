#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import minimist from 'minimist';
import { chromium } from 'playwright-core';

import {
  getDefaultArtifactsDir,
  getDefaultStorageStatePath,
  normalizeCookiesExport,
  redactHeaders,
  shouldCaptureRequest,
} from './lib/kling-web-poc-lib.mjs';

const argv = minimist(process.argv.slice(2), {
  string: ['artifacts-dir', 'cookies-json', 'prompt', 'storage-state', 'target-url'],
  boolean: ['headless', 'help'],
  alias: {
    h: 'help',
  },
  default: {
    headless: true,
    'target-url': 'https://kling.ai/app/image/new',
  },
});

if (argv.help) {
  console.log(`Kling website free-tier PoC

Usage:
  node scripts/kling-web-poc.mjs --storage-state tmp/kling-web-poc/storage-state.json --prompt "a cute fox"
  node scripts/kling-web-poc.mjs --cookies-json ./kling-cookies.json --prompt "a cute fox"

Options:
  --storage-state   Playwright storageState JSON path
  --cookies-json    Browser extension exported cookies JSON array path
  --prompt          Prompt text to place into the Kling image page
  --artifacts-dir   Output directory for screenshots / logs / summary
  --target-url      Kling page to open (default: https://kling.ai/app/image/new)
  --headless        Launch chromium headless (default: true)
  --help            Show this message
`);
  process.exit(0);
}

const rootDir = process.cwd();
const artifactsDir = path.resolve(argv['artifacts-dir'] || getDefaultArtifactsDir(rootDir));
const storageStatePath = path.resolve(argv['storage-state'] || getDefaultStorageStatePath(rootDir));
const targetUrl = argv['target-url'];
const prompt = argv.prompt || 'A cinematic fox walking through neon rain, ultra-detailed';

async function ensureStorageState() {
  if (argv['storage-state']) {
    await fs.access(storageStatePath);
    return storageStatePath;
  }

  if (!argv['cookies-json']) {
    throw new Error(
      '缺少登录态。请提供 --storage-state <playwright-json> 或 --cookies-json <浏览器导出的 cookies json>。'
    );
  }

  const cookiesPath = path.resolve(argv['cookies-json']);
  const raw = await fs.readFile(cookiesPath, 'utf8');
  const parsed = JSON.parse(raw);
  const storageState = Array.isArray(parsed) ? normalizeCookiesExport(parsed, targetUrl) : parsed;
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
  await fs.writeFile(storageStatePath, JSON.stringify(storageState, null, 2));
  return storageStatePath;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function closeBlockingPopups(page) {
  const selectors = ['.close.all-center', '.el-dialog .close', '.dialog-close', '.modal-close'];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {}
  }
}

function promptLocator(page) {
  return page.locator("div[contenteditable='true'][role='textbox'], textarea").first();
}

function generateButtonLocator(page) {
  return page.locator("button:has-text('生成'), button:has-text('Generate'), .generic-button.critical.big.button-pay").first();
}

async function detectLoginRequired(page) {
  const markers = [
    /Welcome to Kling AI/i,
    /Sign in with email/i,
    /欢迎登录/,
    /手机登录/,
    /扫码登录/,
    /一键登录/,
  ];
  for (const marker of markers) {
    try {
      if (await page.getByText(marker).count().then((count) => count > 0)) {
        return true;
      }
    } catch {}
  }
  return false;
}

async function main() {
  const resolvedStorageStatePath = await ensureStorageState();
  await fs.mkdir(artifactsDir, { recursive: true });

  const browserExecutablePath = process.env.BROWSER_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
    headless: argv.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    storageState: resolvedStorageStatePath,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();

  const requests = [];
  const responsesByUrl = new Map();

  page.on('request', (request) => {
    if (!shouldCaptureRequest({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    })) {
      return;
    }

    requests.push({
      ts: new Date().toISOString(),
      phase: 'request',
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      headers: redactHeaders(request.headers()),
      postData: request.postData() || null,
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    if (!shouldCaptureRequest({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    })) {
      return;
    }

    let bodyText = null;
    try {
      bodyText = await response.text();
      if (bodyText && bodyText.length > 5000) {
        bodyText = `${bodyText.slice(0, 5000)}\n...[truncated]`;
      }
    } catch {
      bodyText = '[unavailable]';
    }

    const payload = {
      ts: new Date().toISOString(),
      phase: 'response',
      method: request.method(),
      resourceType: request.resourceType(),
      url: response.url(),
      status: response.status(),
      headers: redactHeaders(response.headers()),
      bodyText,
    };
    requests.push(payload);
    responsesByUrl.set(response.url(), payload);
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
  await closeBlockingPopups(page);
  await page.screenshot({ path: path.join(artifactsDir, '01-page-loaded.png'), fullPage: true });

  const promptBox = promptLocator(page);
  if (await promptBox.count()) {
    await promptBox.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
    await page.keyboard.type(prompt, { delay: 5 });
  }

  const generateButton = generateButtonLocator(page);
  await generateButton.click({ timeout: 15000 });
  await closeBlockingPopups(page);

  await Promise.race([
    page.waitForTimeout(12000),
    page.getByText(/Welcome to Kling AI|欢迎登录|手机登录|扫码登录/i).waitFor({ timeout: 12000 }).catch(() => null),
  ]);

  const loginRequired = await detectLoginRequired(page);
  const signInVisible = loginRequired;

  await page.screenshot({ path: path.join(artifactsDir, '02-after-generate.png'), fullPage: true });

  const summary = {
    targetUrl,
    prompt,
    storageStatePath: resolvedStorageStatePath,
    capturedEventCount: requests.length,
    loginRequired,
    signInVisible,
    candidateResponseUrls: Array.from(responsesByUrl.keys()),
    outcome: loginRequired || signInVisible
      ? 'login_required_or_session_expired'
      : requests.length > 0
        ? 'captured_candidate_requests'
        : 'no_candidate_requests_observed',
  };

  await writeJson(path.join(artifactsDir, 'summary.json'), summary);
  await writeJson(path.join(artifactsDir, 'captured-traffic.json'), requests);
  await fs.writeFile(
    path.join(artifactsDir, 'page-url.txt'),
    `${page.url()}\n`,
    'utf8'
  );

  console.log(JSON.stringify(summary, null, 2));

  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(`[kling-web-poc] ${error.message}`);
  process.exit(1);
});
