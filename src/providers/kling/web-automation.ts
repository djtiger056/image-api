import path from "path";

import _ from "lodash";
import axios from "axios";
import fs from "fs-extra";
import mime from "mime";
import { Browser, FilePayload, Page, chromium } from "playwright-core";

import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { UnifiedImageGenerateInput } from "@/providers/types.ts";
import {
  DEFAULT_KLING_WEB_ARTIFACTS_DIR,
  DEFAULT_KLING_WEB_TARGET_URL,
  extractLikelyImageUrlsFromJson,
  extractLikelyImageUrlsFromText,
  extractLikelyTaskIds,
  isLikelyResultImageUrl,
  normalizeKlingResultImageUrl,
  resolveKlingWebStorageState,
  shouldCaptureKlingWebRequest,
} from "@/providers/kling/web-utils.ts";

let browserInstance: Browser | null = null;
let browserLaunching: Promise<Browser> | null = null;

function getHeadless(): boolean {
  return String(process.env.KLING_WEB_HEADLESS || "true").toLowerCase() !== "false";
}

function getWaitTimeoutMs(): number {
  const value = Number(process.env.KLING_WEB_WAIT_TIMEOUT_MS || 180000);
  return Number.isFinite(value) && value > 0 ? value : 180000;
}

function getPollIntervalMs(): number {
  const value = Number(process.env.KLING_WEB_RESULT_POLL_INTERVAL_MS || 2000);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

function getArtifactsRoot(): string {
  return process.env.KLING_WEB_ARTIFACTS_DIR || DEFAULT_KLING_WEB_ARTIFACTS_DIR;
}

async function ensureTempDirs() {
  const tmpRoot = process.env.TMPDIR || "/tmp";
  const tmpDownloads = process.env.KLING_WEB_TMP_DOWNLOADS_DIR || "/lf/tmp-downloads";
  await Promise.all([
    fs.ensureDir(tmpRoot),
    fs.ensureDir(tmpDownloads),
    fs.ensureDir(getArtifactsRoot()),
  ]);
  if (!process.env.TMPDIR) {
    process.env.TMPDIR = tmpRoot;
  }
  if (!process.env.KLING_WEB_TMP_DOWNLOADS_DIR) {
    process.env.KLING_WEB_TMP_DOWNLOADS_DIR = tmpDownloads;
  }
}

async function closeBlockingPopups(page: Page) {
  const closeSelectors = [
    ".close.all-center",
    ".el-dialog .close",
    ".dialog-close",
    ".modal-close",
    "[aria-label='Close']",
    "[aria-label='关闭']",
  ];
  for (const selector of closeSelectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {}
  }
}

function promptEditorLocator(page: Page) {
  return page.locator("div[contenteditable='true'][role='textbox'], textarea").first();
}

function generateButtonLocator(page: Page) {
  return page.locator("button:has-text('生成'), button:has-text('Generate'), .generic-button.critical.big.button-pay").first();
}

async function isLoginRequired(page: Page) {
  const markers = [
    /welcome to kling ai/i,
    /sign in with email/i,
    /sign in with google/i,
    /欢迎登录/,
    /手机登录/,
    /扫码登录/,
    /一键登录/,
  ];
  for (const marker of markers) {
    try {
      if (await page.getByText(marker).count()) {
        return true;
      }
    } catch {}
  }
  return false;
}

async function ensureBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }
  if (browserLaunching) {
    return browserLaunching;
  }

  browserLaunching = (async () => {
    await ensureTempDirs();
    const browserExecutablePath = process.env.BROWSER_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable";
    browserInstance = await chromium.launch({
      executablePath: browserExecutablePath,
      headless: getHeadless(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    browserInstance.on("disconnected", () => {
      browserInstance = null;
    });
    return browserInstance;
  })();

  try {
    return await browserLaunching;
  } finally {
    browserLaunching = null;
  }
}

function getImageExtension(imageUrl: string, contentType?: string): string {
  const contentExt = contentType ? mime.getExtension(contentType) : "";
  if (contentExt) return contentExt === "jpeg" ? "jpg" : contentExt;
  try {
    const pathname = new URL(imageUrl).pathname;
    const ext = path.extname(pathname).replace(/^\./, "");
    if (ext) return ext;
  } catch {}
  return "png";
}

async function toFilePayload(image: string | Buffer, index: number): Promise<FilePayload> {
  if (Buffer.isBuffer(image)) {
    return {
      name: `reference-${index + 1}.png`,
      mimeType: "image/png",
      buffer: image,
    };
  }

  if (util.isURL(image)) {
    const response = await axios.get<ArrayBuffer>(image, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    const ext = getImageExtension(image, response.headers["content-type"] as string | undefined);
    return {
      name: `reference-${index + 1}.${ext}`,
      mimeType: response.headers["content-type"] || mime.getType(ext) || "image/png",
      buffer: Buffer.from(response.data),
    };
  }

  if (util.isBASE64Data(image)) {
    const format = util.extractBASE64DataFormat(image) || "image/png";
    return {
      name: `reference-${index + 1}.${mime.getExtension(format) || "png"}`,
      mimeType: format,
      buffer: Buffer.from(util.removeBASE64DataHeader(image), "base64"),
    };
  }

  if (util.isBASE64(image)) {
    return {
      name: `reference-${index + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(image, "base64"),
    };
  }

  if (await fs.pathExists(image)) {
    const buffer = await fs.readFile(image);
    const ext = path.extname(image).replace(/^\./, "") || "png";
    return {
      name: path.basename(image),
      mimeType: mime.getType(ext) || "image/png",
      buffer,
    };
  }

  throw new Error(`不支持的网页参考图格式: ${String(image).slice(0, 120)}`);
}

async function collectDomImageUrls(page: Page): Promise<string[]> {
  const urls = await page.evaluate(() => {
    const result = new Set<string>();
    const pushUrl = (value?: string | null) => {
      if (!value) return;
      try {
        result.add(new URL(value, window.location.href).toString());
      } catch {}
    };

    document.querySelectorAll("img[src]").forEach((node) => {
      const img = node as HTMLImageElement;
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (width >= 128 || height >= 128) {
        pushUrl(img.currentSrc || img.src);
      }
    });

    document.querySelectorAll<HTMLElement>("[style*='background-image']").forEach((node) => {
      const style = getComputedStyle(node).backgroundImage;
      const match = style.match(/url\(["']?(.*?)["']?\)/);
      if (match?.[1]) {
        pushUrl(match[1]);
      }
    });

    return Array.from(result);
  });

  return [...new Set(
    urls
      .filter((url) => isLikelyResultImageUrl(url))
      .map((url) => normalizeKlingResultImageUrl(url))
      .filter(Boolean)
  )];
}

async function persistArtifacts(runDir: string, payload: Record<string, any>) {
  await fs.mkdir(runDir, { recursive: true });
  await Promise.all(
    Object.entries(payload).map(([name, value]) =>
      fs.writeFile(path.join(runDir, name), _.isString(value) ? value : JSON.stringify(value, null, 2))
    )
  );
}

export interface KlingWebGenerateResult {
  taskId: string;
  imageUrls: string[];
  traffic: any[];
  observedTaskIds: string[];
  pageUrl: string;
}

class KlingWebAutomation {
  async generate(input: UnifiedImageGenerateInput): Promise<KlingWebGenerateResult> {
    const taskId = `kling-web-${util.uuid(false)}`;
    const runDir = path.join(getArtifactsRoot(), taskId);
    const browser = await ensureBrowser();
    const storageState = await resolveKlingWebStorageState(input.providerOptions);
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    const traffic: any[] = [];
    const baselineImageUrls = new Set<string>();
    const observedImageUrls = new Set<string>();
    const observedTaskIds = new Set<string>();
    const requestStartedAfterSubmit = new WeakMap<object, boolean>();
    let hasSubmittedGeneration = false;
    const targetUrl = input.providerOptions?.target_url || input.providerOptions?.targetUrl || process.env.KLING_WEB_TARGET_URL || DEFAULT_KLING_WEB_TARGET_URL;

    page.on("request", (request) => {
      requestStartedAfterSubmit.set(request, hasSubmittedGeneration);
    });

    page.on("response", async (response) => {
      const request = response.request();
      const isPostSubmitRequest = requestStartedAfterSubmit.get(request) === true;
      if (!shouldCaptureKlingWebRequest({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      })) {
        return;
      }

      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        bodyText = "";
      }
      const parsed = util.ignoreJSONParse(bodyText);
      const capturedImageUrls = new Set<string>();
      if (parsed) {
        extractLikelyTaskIds(parsed).forEach((value) => observedTaskIds.add(value));
        const jsonImageUrls = extractLikelyImageUrlsFromJson(parsed);
        jsonImageUrls.forEach((url) => capturedImageUrls.add(url));
        if (jsonImageUrls.length === 0) {
          extractLikelyImageUrlsFromText(bodyText).forEach((url) => capturedImageUrls.add(url));
        }
      } else {
        extractLikelyImageUrlsFromText(bodyText).forEach((url) => capturedImageUrls.add(url));
      }

      for (const url of capturedImageUrls) {
        if (isPostSubmitRequest) {
          if (!baselineImageUrls.has(url)) {
            observedImageUrls.add(url);
          }
        } else {
          baselineImageUrls.add(url);
        }
      }

      traffic.push({
        ts: new Date().toISOString(),
        method: request.method(),
        resourceType: request.resourceType(),
        url: response.url(),
        status: response.status(),
        phase: isPostSubmitRequest ? "post-submit" : "pre-submit",
        bodyText: bodyText.length > 8000 ? `${bodyText.slice(0, 8000)}\n...[truncated]` : bodyText,
      });
    });

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      await closeBlockingPopups(page);
      (await collectDomImageUrls(page)).forEach((url) => baselineImageUrls.add(url));
      await page.screenshot({ path: path.join(runDir, "01-loaded.png"), fullPage: true }).catch(() => null);

      const stepTimeoutMs = Math.min(getWaitTimeoutMs(), 30000);
      const editor = promptEditorLocator(page);
      await editor.waitFor({ state: "visible", timeout: stepTimeoutMs });
      await editor.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
      await page.keyboard.type(input.prompt, { delay: 5 });

      if (input.images?.length) {
        const fileInput = page.locator("input[type='file']").first();
        await fileInput.waitFor({ state: "attached", timeout: Math.min(getWaitTimeoutMs(), 15000) });
        const payloads = await Promise.all(input.images.map((image, index) => toFilePayload(image, index)));
        await fileInput.setInputFiles(payloads);
      }

      const generateButton = generateButtonLocator(page);
      await generateButton.waitFor({ state: "visible", timeout: Math.min(getWaitTimeoutMs(), 15000) });
      hasSubmittedGeneration = true;
      await generateButton.click();

      await page.waitForTimeout(1500);
      await closeBlockingPopups(page);
      const loginRequired = await isLoginRequired(page);
      if (loginRequired) {
        throw new Error("Kling 网页登录态已失效或未登录。请重新导出 storageState/cookies。");
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < getWaitTimeoutMs()) {
        const domUrls = await collectDomImageUrls(page);
        domUrls.forEach((url) => {
          if (!baselineImageUrls.has(url)) {
            observedImageUrls.add(url);
          }
        });
        if (observedImageUrls.size > 0) {
          await page.screenshot({ path: path.join(runDir, "02-result.png"), fullPage: true }).catch(() => null);
          break;
        }
        await page.waitForTimeout(getPollIntervalMs());
      }

      const imageUrls = [...observedImageUrls];
      await persistArtifacts(runDir, {
        "summary.json": {
          taskId,
          targetUrl,
          prompt: input.prompt,
          baselineImageCount: baselineImageUrls.size,
          imageCount: imageUrls.length,
          observedTaskIds: [...observedTaskIds],
          pageUrl: page.url(),
        },
        "traffic.json": traffic,
      });

      if (imageUrls.length === 0) {
        throw new Error(
          `Kling 网页任务在 ${Math.floor(getWaitTimeoutMs() / 1000)} 秒内未观察到结果图，详情见 ${runDir}`
        );
      }

      logger.info(`Kling 网页模式获取到 ${imageUrls.length} 张结果图`);
      return {
        taskId,
        imageUrls,
        traffic,
        observedTaskIds: [...observedTaskIds],
        pageUrl: page.url(),
      };
    } catch (err) {
      await page.screenshot({ path: path.join(runDir, "error.png"), fullPage: true }).catch(() => null);
      await persistArtifacts(runDir, {
        "error.json": {
          taskId,
          targetUrl,
          message: (err as Error).message,
          pageUrl: page.url(),
          observedTaskIds: [...observedTaskIds],
        },
        "traffic.json": traffic,
      }).catch(() => null);
      throw err;
    } finally {
      await context.close().catch(() => null);
    }
  }
}

export default new KlingWebAutomation();