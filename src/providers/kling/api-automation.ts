import path from "path";

import fs from "fs-extra";
import { Browser, Page, chromium } from "playwright-core";

import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { UnifiedImageGenerateInput } from "@/providers/types.ts";
import { buildKlingTaskSubmitBody } from "@/providers/kling/mapper.ts";
import {
  DEFAULT_KLING_WEB_ARTIFACTS_DIR,
  resolveKlingWebStorageState,
} from "@/providers/kling/web-utils.ts";

let browserInstance: Browser | null = null;
let sharedPage: Page | null = null;
let sharedContext: any = null;

function getTargetUrl(): string {
  return process.env.KLING_WEB_TARGET_URL || "https://klingai.com/app/image/new";
}

function getWaitTimeoutMs(): number {
  const value = Number(process.env.KLING_API_WAIT_TIMEOUT_MS || 120000);
  return Number.isFinite(value) && value > 0 ? value : 120000;
}

function getPollIntervalMs(): number {
  const value = Number(process.env.KLING_API_POLL_INTERVAL_MS || 2000);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

function getHeadless(): boolean {
  return String(process.env.KLING_WEB_HEADLESS || "true").toLowerCase() !== "false";
}

async function ensureBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  const exePath =
    process.env.BROWSER_EXECUTABLE_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    "/usr/bin/google-chrome-stable";
  browserInstance = await chromium.launch({
    executablePath: exePath,
    headless: getHeadless(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  browserInstance.on("disconnected", () => {
    browserInstance = null;
    sharedPage = null;
    sharedContext = null;
  });
  return browserInstance;
}

/**
 * 确保有一个加载好的共享页面，用于 API 调用。
 * 页面需要完全加载以便 XHR 拦截器（__NS_hxfalcon token 生成器）就绪。
 */
async function ensureReadyPage(input: UnifiedImageGenerateInput): Promise<Page> {
  const browser = await ensureBrowser();
  const targetUrl = getTargetUrl();

  // 如果已有共享页面且还活着，直接复用
  if (sharedPage && !sharedPage.isClosed()) {
    try {
      await sharedPage.evaluate(() => document.readyState);
      return sharedPage;
    } catch {
      sharedPage = null;
    }
  }

  // 创建新 context + page
  const storageState = await resolveKlingWebStorageState(input.providerOptions);
  sharedContext = await browser.newContext({
    storageState,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await sharedContext.newPage();

  logger.info(`Kling API: 正在加载页面 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

  // 等待 XHR 拦截器就绪 —— 通过检测页面是否已有 API 请求
  await page.waitForTimeout(2000);

  sharedPage = page;
  return page;
}

export interface KlingApiGenerateResult {
  taskId: string;
  imageUrls: string[];
  observedTaskIds: string[];
  pageUrl: string;
}

class KlingApiAutomation {
  async generate(input: UnifiedImageGenerateInput): Promise<KlingApiGenerateResult> {
    const page = await ensureReadyPage(input);
    const body = buildKlingTaskSubmitBody(input);
    const timeoutMs = getWaitTimeoutMs();
    const pollMs = getPollIntervalMs();
    const artifactsDir = path.join(
      DEFAULT_KLING_WEB_ARTIFACTS_DIR,
      `api-${util.uuid(false)}`
    );

    logger.info(
      `Kling API: 提交任务 prompt="${input.prompt.substring(0, 60)}" model=${body.arguments.find((a: any) => a.name === "kolors_version")?.value} ratio=${body.arguments.find((a: any) => a.name === "aspect_ratio")?.value} n=${body.arguments.find((a: any) => a.name === "imageCount")?.value}`
    );

    // 在页面 JS 上下文中执行 API 调用（自动带 __NS_hxfalcon token）
    const result = await page.evaluate(
      async ({ body, timeoutMs, pollMs }: { body: any; timeoutMs: number; pollMs: number }) => {
        // 辅助: 异步 XHR
        function xhrRequest(method: string, url: string, data?: string): Promise<any> {
          return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = () => {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch {
                resolve(xhr.responseText);
              }
            };
            xhr.onerror = () => reject(new Error(`XHR ${method} ${url} failed`));
            xhr.send(data || null);
          });
        }

        // 1. 提交任务
        let submitResult: any;
        try {
          submitResult = await xhrRequest("POST", "/api/task/submit", JSON.stringify(body));
        } catch (err: any) {
          return { error: `提交任务失败: ${err.message}` };
        }

        if (submitResult.result !== 1 && submitResult.status !== 200) {
          return {
            error: `提交任务失败: ${JSON.stringify(submitResult.error || submitResult.message || submitResult).substring(0, 500)}`,
            raw: submitResult,
          };
        }

        const taskId =
          submitResult.data?.task_id ||
          submitResult.data?.taskId ||
          submitResult.data?.id ||
          submitResult.data;

        if (!taskId) {
          return { error: "提交成功但未返回 taskId", raw: submitResult };
        }

        // 2. 轮询任务状态
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const statusResult = await xhrRequest(
              "GET",
              `/api/task/status?taskId=${taskId}`
            );

            const status = statusResult.data?.status || statusResult.data?.task_status;
            if (status === "succeed" || status === "done" || status === "finished") {
              // 3. 获取结果图片
              const feedsResult = await xhrRequest(
                "GET",
                `/api/user/works/personal/feeds?taskId=${taskId}&pageSize=1&contentType=`
              );

              const imageUrls: string[] = [];
              const works = feedsResult.data?.works || feedsResult.data || [];
              const workList = Array.isArray(works) ? works : [works];

              for (const work of workList) {
                const resource = work?.resource?.resource || work?.cover?.resource;
                if (resource) imageUrls.push(resource);
                if (work?.coverList) {
                  for (const item of work.coverList) {
                    const url = typeof item === "string" ? item : item?.resource;
                    if (url) imageUrls.push(url);
                  }
                }
              }

              return { taskId, imageUrls, raw: statusResult };
            }

            if (status === "failed" || status === "error") {
              return {
                error: `任务失败: ${statusResult.data?.message || JSON.stringify(statusResult.data)}`,
                taskId,
              };
            }
          } catch {
            // 轮询出错，继续重试
          }

          await new Promise((r) => setTimeout(r, pollMs));
        }

        return { error: `任务超时 (${Math.floor(timeoutMs / 1000)}s)`, taskId };
      },
      { body, timeoutMs, pollMs }
    );

    // 保存调试 artifacts
    await fs.ensureDir(artifactsDir);
    await fs.writeJson(path.join(artifactsDir, "result.json"), result, { spaces: 2 });
    await fs.writeJson(path.join(artifactsDir, "request-body.json"), body, { spaces: 2 });

    if (result.error) {
      logger.error(`Kling API 失败: ${result.error}`);
      throw new Error(result.error);
    }

    const imageUrls = result.imageUrls || [];
    logger.info(`Kling API: 任务 ${result.taskId} 完成，${imageUrls.length} 张图片`);

    return {
      taskId: String(result.taskId),
      imageUrls,
      observedTaskIds: [String(result.taskId)],
      pageUrl: page.url(),
    };
  }

  /**
   * 获取 Kling 账户信息（余额、用户名等）
   * 优先从 DOM 读取（最可靠），同时尝试 profile API 获取详细信息。
   */
  async getAccountInfo(input: UnifiedImageGenerateInput): Promise<{
    points: number | null;
    userName: string | null;
    userId: string | null;
    vipStatus: number | null;
    taskSuccessCount: number | null;
  }> {
    const page = await ensureReadyPage(input);

    const result = await page.evaluate(async () => {
      const info: any = { points: null, userName: null, userId: null, vipStatus: null, taskSuccessCount: null };

      // 1. 从 DOM 读余额（最可靠）
      const pointEl = document.querySelector('.point-box .value');
      if (pointEl) {
        const val = parseInt(pointEl.textContent || '', 10);
        if (!isNaN(val)) info.points = val;
      }

      // 2. 通过 profile API 获取用户信息
      try {
        const resp = await new Promise<any>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/api/user/profile_and_features');
          xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); } };
          xhr.onerror = () => resolve(null);
          xhr.send();
        });

        if (resp?.status === 200 && resp.data?.userProfile) {
          const profile = resp.data.userProfile;
          info.userName = profile.userName || null;
          info.userId = String(profile.userId || '');
          info.vipStatus = profile.userVipStatus ?? null;
          info.taskSuccessCount = profile.count?.taskSuccessCount ?? null;
        }
      } catch {}

      return info;
    });

    logger.info(`Kling 账户: points=${result.points} user=${result.userName} tasks=${result.taskSuccessCount}`);
    return result;
  }

  async close() {
    if (sharedContext) {
      await sharedContext.close().catch(() => null);
      sharedContext = null;
      sharedPage = null;
    }
    if (browserInstance) {
      await browserInstance.close().catch(() => null);
      browserInstance = null;
    }
  }
}

export default new KlingApiAutomation();
