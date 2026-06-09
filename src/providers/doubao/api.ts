/**
 * doubao.com API 底层调用模块（双模式）
 *
 * 支持两种请求方式：
 * - http: 直接 HTTP 请求（与 video-api.ts 一致），适合云端服务器
 * - browser: Playwright 浏览器自动化，SDK 真实签名，适合本地 Windows
 *
 * 模式选择（DOUBAO_IMAGE_MODE 环境变量）：
 * - http: 强制直接 HTTP
 * - browser: 强制浏览器
 * - auto（默认）: 先试 HTTP，遇 710022004 自动降级到浏览器
 */

import crypto from "crypto";
import { PassThrough } from "stream";
import { chromium, Browser, BrowserContext, Page } from "playwright-core";

import _ from "lodash";
import axios, { AxiosRequestConfig } from "axios";
import { createParser } from "eventsource-parser";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { uploadImageToDoubao } from "@/providers/doubao/upload.ts";
import { markTokenResult } from "@/lib/service-authorization.js";

// ─── 常量 ────────────────────────────────────────────────────────────

const MODEL_NAME = "doubao";
const DEFAULT_ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "3.22.0";
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;
const DOUBAO_CHAT_URL = "https://www.doubao.com/chat/";
const IDLE_TIMEOUT = 5 * 60_000;
const PAGE_LOAD_TIMEOUT = 30_000;
const GENERATION_TIMEOUT = 300_000;

const DEVICE_ID = `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;
const WEB_ID = `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;

const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-control": "no-cache",
  "Last-event-id": "undefined",
  Origin: "https://www.doubao.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://www.doubao.com/chat/",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// ─── 模式管理 ─────────────────────────────────────────────────────

type ImageMode = "http" | "browser" | "auto";

function getImageMode(): ImageMode {
  const raw = (process.env.DOUBAO_IMAGE_MODE || "auto").toLowerCase().trim();
  if (raw === "http" || raw === "browser" || raw === "auto") return raw;
  return "auto";
}

function isCloudEnvironment(): boolean {
  // 检测常见云环境标识
  return !!(
    process.env.CLOUD_ENV ||
    process.env.TENCENTCLOUD ||
    process.env.ALIBABA_CLOUD ||
    process.env.AWS_REGION ||
    process.env.GOOGLE_CLOUD ||
    process.env.AZURE_REGION ||
    // 无 DISPLAY 且非 Windows → 大概率是 headless 云服务器
    (!process.env.DISPLAY && process.platform !== "win32")
  );
}

// ─── 工具函数 ──────────────────────────────────────────────────────

function generateFakeMsToken(): string {
  const bytes = crypto.randomBytes(96);
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateFakeABogus(): string {
  return `mf-${util.generateRandomString({ length: 34 })}-${util.generateRandomString({ length: 6 })}`;
}

function generateCookie(sessionId: string): string {
  return [`sessionid=${sessionId}`, `sessionid_ss=${sessionId}`].join("; ");
}

const DOUBAO_RATE_LIMIT_PATTERNS = [
  /rate\s*limit/i, /too\s*many\s*requests/i, /quota/i, /limited/i,
  /频繁/, /频率/, /限流/, /请求过多/, /稍后再试/, /稍后重试/,
  /额度/, /次数/, /已用完/, /不足/, /高峰/, /排队/, /风控/,
];

export function isDoubaoRateLimitedError(error: unknown): boolean {
  const parts = [
    (error as any)?.message, (error as any)?.errmsg,
    (error as any)?.code, (error as any)?.errcode,
  ].filter((v) => v != null).map(String);
  return DOUBAO_RATE_LIMIT_PATTERNS.some((p) => p.test(parts.join(" ")));
}

/** 判断是否为 shark_admin 反爬拦截（710022002 block / 710022004 rate limited） */
function isSharkAdminBlock(error: unknown): boolean {
  const msg = String((error as any)?.message || "");
  return (
    (msg.includes("710022002") || msg.includes("710022004")) &&
    (/rate\s*limit/i.test(msg) || /block/i.test(msg))
  );
}

function createDoubaoRequestError(errMsg: string, errCode?: string | number): APIException {
  const detail = errCode ? `${errCode} - ${errMsg}` : errMsg;
  const error = new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${detail}`);
  if (isDoubaoRateLimitedError(error)) error.setHTTPStatusCode(429);
  return error;
}

function markDoubaoFailure(sessionId: string, error: any): void {
  markTokenResult(sessionId, false, error?.message || String(error || "未知错误"));
}

// ─── Token 校验 ────────────────────────────────────────────────────

export async function getTokenLiveStatus(sessionId: string): Promise<boolean> {
  try {
    const response = await axios.get("https://www.doubao.com/passport/account/info/v2/", {
      params: { aid: DEFAULT_ASSISTANT_ID },
      headers: { ...FAKE_HEADERS, Cookie: generateCookie(sessionId) },
      timeout: 10000,
      validateStatus: () => true,
    });
    return !!response.data?.data?.user_id;
  } catch {
    return false;
  }
}

export function tokenSplit(authorization: string): string[] {
  return authorization.replace("Bearer ", "").split(",");
}

// ─── 会话管理 ──────────────────────────────────────────────────────

export async function removeConversation(
  convId: string,
  sessionId: string
): Promise<void> {
  if (!convId) return;
  try {
    await axios.post(
      `https://www.doubao.com/samantha/thread/delete?aid=${DEFAULT_ASSISTANT_ID}`,
      { conversation_id: convId },
      {
        headers: {
          ...FAKE_HEADERS,
          Cookie: generateCookie(sessionId),
          "Content-Type": "application/json",
          Referer: `https://www.doubao.com/chat/${convId}`,
          "Agw-js-conv": "str",
        },
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    logger.success(`[Doubao] 会话 ${convId} 删除成功`);
  } catch (err: any) {
    logger.warn(`[Doubao] 删除会话 ${convId} 失败 (可忽略): ${err?.message}`);
  }
}

// ─── 图片结果提取 ─────────────────────────────────────────────────

function extractImageUrlsFromPayload(payload: any, emittedKeys?: Set<string>): string[] {
  if (!payload) return [];

  const urls: string[] = [];
  const seen = emittedKeys || new Set<string>();

  const pushUrl = (url: string, key?: string) => {
    if (!url) return;
    const k = key || url;
    if (seen.has(k)) return;
    seen.add(k);
    urls.push(url);
  };

  if (Array.isArray(payload.creations)) {
    for (const c of payload.creations) {
      const img = c?.image || {};
      const key = img?.key;
      const url = img?.image_ori_raw?.url || img?.image_ori?.url;
      if (url) pushUrl(url, key);
    }
  }

  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (Array.isArray(node.creations)) {
      for (const c of node.creations) {
        const img = c?.image || {};
        const key = img?.key;
        const url = img?.image_ori_raw?.url || img?.image_ori?.url;
        if (url) pushUrl(url, key);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "creation_block" || k === "content" || k === "data") {
        visit(v, depth + 1);
      }
    }
  };

  if (urls.length === 0) visit(payload);
  return urls;
}

// ═══════════════════════════════════════════════════════════════════
// 模式 A: 直接 HTTP（适合云端服务器）
// ═══════════════════════════════════════════════════════════════════

async function doubaoImageRequest(
  method: string,
  uri: string,
  sessionId: string,
  options: AxiosRequestConfig = {}
): Promise<any> {
  const response = await axios.request({
    method,
    url: `https://www.doubao.com${uri}`,
    params: {
      aid: DEFAULT_ASSISTANT_ID,
      device_id: DEVICE_ID,
      device_platform: "web",
      language: "zh",
      pc_version: PC_VERSION,
      pkg_type: "release_version",
      region: "CN",
      samantha_web: 1,
      sys_region: "CN",
      tea_uuid: WEB_ID,
      "use-olympus-account": 1,
      version_code: VERSION_CODE,
      web_id: WEB_ID,
      web_tab_id: util.uuid(),
      ...(options.params || {}),
    },
    headers: {
      ...FAKE_HEADERS,
      Cookie: generateCookie(sessionId),
      "x-flow-trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
      ...(options.headers || {}),
    },
    timeout: 15000,
    validateStatus: () => true,
    ..._.omit(options, "params", "headers"),
  });

  if (options.responseType === "stream") return response;
  return response.data;
}

// ─── SSE 流接收（HTTP 模式） ──────────────────────────────────────

interface ImageStreamResult {
  conversationId: string;
  imageUrls: string[];
  textContent: string;
}

function receiveImageStream(stream: any): Promise<ImageStreamResult> {
  let temp = Buffer.from("");
  const imageUrls: string[] = [];
  const emittedKeys = new Set<string>();
  let textContent = "";
  let conversationId = "";
  let errorCode: number | undefined;
  let errorMsg: string | undefined;

  return new Promise((resolve, reject) => {
    let isEnd = false;
    let dataHandler: ((buffer: Buffer) => void) | null = null;

    const cleanup = () => {
      if (dataHandler) stream.off("data", dataHandler);
      stream.removeAllListeners("error");
      stream.removeAllListeners("close");
    };

    const finalize = () => {
      if (isEnd) return;
      isEnd = true;
      cleanup();
      if (typeof stream.destroy === "function" && !stream.destroyed) {
        stream.destroy();
      }
      if (errorCode) {
        reject(createDoubaoRequestError(errorMsg || "未知错误", errorCode));
        return;
      }
      resolve({ conversationId, imageUrls, textContent });
    };

    const fail = (err: any) => {
      if (isEnd) return;
      isEnd = true;
      cleanup();
      if (typeof stream.destroy === "function" && !stream.destroyed) {
        stream.destroy(err);
      }
      reject(err);
    };

    const parser = createParser((event) => {
      try {
        if (event.type !== "event" || isEnd) return;

        const rawResult = _.attempt(() => JSON.parse(event.data));
        if (_.isError(rawResult)) return;

        const eventPayload = rawResult.event_data
          ? _.attempt(() => JSON.parse(rawResult.event_data))
          : null;
        const isValidPayload = !_.isError(eventPayload) && eventPayload;

        if (isValidPayload) {
          const cid =
            eventPayload.conversation_id ||
            eventPayload.conversationId ||
            eventPayload.data?.conversation_id ||
            eventPayload.message?.conversation_id ||
            "";
          if (!conversationId && cid) conversationId = cid;
        }

        if (rawResult.event_type === 2001 && isValidPayload) {
          const message = eventPayload.message;
          if (!message) return;
          const ctype = message.content_type;

          if (ctype === 2074) {
            const parsed = _.attempt(() => JSON.parse(message.content));
            if (!_.isError(parsed)) {
              const urls = extractImageUrlsFromPayload(parsed, emittedKeys);
              for (const url of urls) {
                if (!imageUrls.includes(url)) imageUrls.push(url);
              }
              if (imageUrls.length > 0) {
                logger.info(`[Doubao] 图片 URL 获取到: ${imageUrls.length} 张`);
                finalize();
                return;
              }
            }
          }

          if (ctype === 2001 || ctype === 1) {
            const parsed = _.attempt(() => JSON.parse(message.content));
            let text = "";
            if (!_.isError(parsed)) {
              if (typeof parsed === "string") text = parsed;
              else if (typeof parsed.text === "string") text = parsed.text;
              else if (typeof parsed.content === "string") text = parsed.content;
            } else if (typeof message.content === "string") {
              text = message.content;
            }
            if (text) textContent += text;
          }

          if (ctype === 9999) {
            const parsed = _.attempt(() => JSON.parse(message.content));
            if (!_.isError(parsed) && Array.isArray(parsed)) {
              for (const block of parsed) {
                if (block.block_type === 2074) {
                  const urls = extractImageUrlsFromPayload(block.content, emittedKeys);
                  for (const url of urls) {
                    if (!imageUrls.includes(url)) imageUrls.push(url);
                  }
                }
                if (block.block_type === 10000 && block.content?.text_block?.text) {
                  textContent += block.content.text_block.text;
                }
              }
              if (imageUrls.length > 0) {
                logger.info(`[Doubao] 图片 URL 从全量消息获取到: ${imageUrls.length} 张`);
                finalize();
                return;
              }
            }
          }

          if (eventPayload.is_finish && imageUrls.length > 0) {
            finalize();
            return;
          }
        }

        if (rawResult.event_type === 2003) {
          finalize();
          return;
        }

        if (rawResult.event_type === 2005 && isValidPayload) {
          errorCode = eventPayload.error_code || eventPayload.code;
          errorMsg = eventPayload.error_msg || eventPayload.message || "未知错误";
          logger.warn(`[Doubao] STREAM_ERROR: code=${errorCode}, msg=${errorMsg}`);
          return;
        }
      } catch (err) {
        logger.error(`[Doubao] SSE 解析错误: ${(err as Error).message}`);
      }
    });

    dataHandler = (buffer: Buffer) => {
      if (isEnd) return;
      if (buffer.toString().indexOf("�") !== -1) {
        temp = Buffer.concat([temp, buffer]);
        return;
      }
      if (temp.length > 0) {
        buffer = Buffer.concat([temp, buffer]);
        temp = Buffer.from("");
      }
      parser.feed(buffer.toString());
    };

    stream.on("data", dataHandler);
    stream.once("error", (err: Error) => fail(err));
    stream.once("close", () => finalize());
  });
}

/** 直接 HTTP 方式的图片生成 */
async function createImageCompletionViaHttp(
  params: DoubaoImageParams,
  sessionId: string
): Promise<ChatCompletionResponse> {
  const {
    prompt,
    ratio = "1:1",
    style = "智能",
    genModel = "Seedream 4.5",
    referenceImage,
  } = params;

  const attachments: any[] = [];
  if (referenceImage) {
    const storeUri = await uploadImageToDoubao(referenceImage, sessionId);
    attachments.push({
      type: "image",
      key: storeUri,
      extra: { refer_types: "overall" },
      identifier: util.uuid(),
    });
    logger.info(`[Doubao] 参考图上传完成: ${storeUri}`);
  }

  const contentJson = JSON.stringify({
    text: `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`,
    model: genModel,
    template_type: "placeholder",
    use_creation: false,
  });

  const response = await doubaoImageRequest(
    "post",
    "/samantha/chat/completion",
    sessionId,
    {
      data: {
        messages: [{ content: contentJson, content_type: 2009, attachments }],
        completion_option: {
          is_regen: false,
          with_suggest: false,
          need_create_conversation: true,
          launch_stage: 1,
          is_replace: false,
          is_delete: false,
          is_ai_playground: false,
          message_from: 0,
          action_bar_skill_id: 3,
          use_auto_cot: false,
          resend_for_regen: false,
          enable_commerce_credit: false,
          event_id: "0",
        },
        evaluate_option: { web_ab_params: "" },
        conversation_id: "0",
        local_conversation_id: `local_${util.generateRandomString({ length: 16, charset: "numeric" })}`,
        local_message_id: util.uuid(),
        section_id: `26${util.generateRandomString({ length: 16, charset: "numeric" })}`,
      },
      headers: {
        "Content-Type": "application/json; encoding=utf-8",
        "Agw-Js-Conv": "str, str",
      },
      timeout: 300000,
      responseType: "stream",
    }
  );

  if (response.headers["content-type"]?.indexOf("text/event-stream") === -1) {
    const errBody = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      response.data.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.data.on("end", () => resolve(Buffer.concat(chunks).toString()));
      setTimeout(() => resolve("[timeout]"), 5000);
    });
    throw createDoubaoRequestError(`无效的响应 Content-Type: ${response.headers["content-type"]}`);
  }

  const streamResult = await receiveImageStream(response.data);
  return {
    conversationId: streamResult.conversationId,
    imageUrls: streamResult.imageUrls,
    textContent: streamResult.textContent,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 模式 B: 浏览器自动化（适合本地 Windows，SDK 真实签名）
// ═══════════════════════════════════════════════════════════════════

interface ChatCompletionResponse {
  conversationId: string;
  imageUrls: string[];
  textContent: string;
}

class DoubaoBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ready = false;
  private starting = false;
  private currentSessionId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async ensureReady(sessionId: string): Promise<void> {
    if (this.ready && this.page && !this.page.isClosed()) {
      if (sessionId !== this.currentSessionId) {
        await this.injectCookies(sessionId);
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
        await this.page.waitForTimeout(3000);
        const ok = await this.checkLogin();
        if (!ok) throw new Error("登录状态无效，请检查 sessionid");
      }
      return;
    }
    if (this.starting) {
      await new Promise<void>((resolve) => {
        const check = () => { if (!this.starting) resolve(); else setTimeout(check, 100); };
        check();
      });
      return;
    }
    await this.start(sessionId);
  }

  private async start(sessionId: string): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      this.currentSessionId = sessionId;
      logger.info("[DoubaoSession] 启动浏览器...");

      const chromePath = process.env.BROWSER_EXECUTABLE_PATH ||
        (process.platform === "win32"
          ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
          : "/usr/bin/google-chrome-stable");

      const hasXvfb = !!process.env.DISPLAY;
      const headlessMode = hasXvfb ? false : true;
      const proxyUrl = process.env.DOUBAO_PROXY || "";
      logger.info(`[DoubaoSession] 浏览器模式: ${headlessMode ? 'headless' : 'headed (Xvfb)'}, proxy: ${proxyUrl || 'none'}`);

      const launchOptions: any = {
        headless: headlessMode,
        executablePath: chromePath,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      };

      this.browser = await chromium.launch(launchOptions);

      const contextOptions: any = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "zh-CN",
      };
      if (proxyUrl) {
        contextOptions.proxy = { server: proxyUrl };
      }

      this.context = await this.browser.newContext(contextOptions);
      this.page = await this.context.newPage();

      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        (window as any).chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters);
      });

      await this.injectCookies(sessionId);

      logger.info("[DoubaoSession] 导航到 doubao.com/chat...");
      await this.page.goto(DOUBAO_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT,
      });
      await this.page.waitForTimeout(3000);

      const ok = await this.checkLogin();
      if (!ok) throw new Error("登录状态无效，请检查 sessionid");

      this.ready = true;
      this.resetIdleTimer();
      logger.success("[DoubaoSession] 就绪");
    } catch (err: any) {
      logger.error(`[DoubaoSession] 启动失败: ${err.message}`);
      await this.cleanup();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  private async injectCookies(sessionId: string): Promise<void> {
    if (!this.context) return;
    await this.context.addCookies([
      { name: "sessionid", value: sessionId, domain: ".doubao.com", path: "/" },
      { name: "sessionid_ss", value: sessionId, domain: ".doubao.com", path: "/" },
    ]);
    this.currentSessionId = sessionId;
  }

  private async checkLogin(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(async () => {
        const r = await fetch("/passport/account/info/v2/?aid=497858", { credentials: "include" });
        const d = await r.json();
        return !!d?.data?.user_id;
      });
    } catch { return false; }
  }

  async chatCompletion(prompt: string): Promise<ChatCompletionResponse> {
    if (!this.page) throw new Error("浏览器未就绪");
    this.resetIdleTimer();

    return new Promise<ChatCompletionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("[DoubaoSession] 请求超时"));
      }, GENERATION_TIMEOUT);

      this.page!.route("**/chat/completion*", async (route) => {
        const request = route.request();
        const url = request.url();

        if (!url.includes("chat/completion")) {
          await route.continue();
          return;
        }

        logger.info(`[DoubaoSession] 捕获签名请求: a_bogus=${url.includes("a_bogus")}, fp=${url.includes("fp")}, url_len=${url.length}`);

        try {
          const response = await route.fetch();
          const status = response.status();
          const body = await response.text();

          clearTimeout(timeout);

          logger.info(`[DoubaoSession] 响应: status=${status}, body_len=${body.length}, preview=${body.substring(0, 200)}`);

          const result = this.parseSSEResponse(body);

          await this.page!.unroute("**/chat/completion*");

          resolve(result);
        } catch (err: any) {
          clearTimeout(timeout);
          await this.page!.unroute("**/chat/completion*").catch(() => {});
          reject(err);
        }
      });

      (async () => {
        try {
          const textarea = this.page!.locator("textarea.semi-input-textarea").first();
          await textarea.fill(prompt);
          await this.page!.waitForTimeout(300);
          await this.page!.keyboard.press("Enter");
          logger.info("[DoubaoSession] 已发送，等待响应...");
        } catch (err: any) {
          clearTimeout(timeout);
          reject(new Error(`[DoubaoSession] 输入失败: ${err.message}`));
        }
      })();
    });
  }

  private parseSSEResponse(body: string): ChatCompletionResponse {
    const imageUrls: string[] = [];
    const emittedKeys = new Set<string>();
    let textContent = "";
    let conversationId = "";
    let errorCode: number | undefined;
    let errorMsg: string | undefined;

    const lines = body.split("\n");
    let currentEvent = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.substring(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.substring(6).trim();
      if (!dataStr || dataStr === "{}") continue;

      try {
        const data = JSON.parse(dataStr);

        if (currentEvent === "SSE_ACK") {
          conversationId = data?.ack_client_meta?.conversation_id || "";
          continue;
        }

        if (currentEvent === "STREAM_ERROR") {
          errorCode = data.error_code;
          errorMsg = data.error_msg || "未知错误";
          logger.warn(`[DoubaoSession] STREAM_ERROR: code=${errorCode}, msg=${errorMsg}`);
          continue;
        }

        if (currentEvent === "SSE_REPLY_END") continue;

        if (currentEvent === "STREAM_CHUNK" && Array.isArray(data.patch_op)) {
          for (const op of data.patch_op) {
            const contentBlocks = op?.patch_value?.content_block;
            if (!Array.isArray(contentBlocks)) continue;

            for (const block of contentBlocks) {
              if (block.block_type === 2074 && block.content?.creation_block?.creations) {
                for (const c of block.content.creation_block.creations) {
                  const img = c?.image || {};
                  const key = img?.key;
                  const url = img?.image_ori_raw?.url || img?.image_ori?.url;
                  if (key && url && !emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    imageUrls.push(url);
                  }
                }
              }

              if (block.block_type === 10000 && block.content?.text_block?.text) {
                textContent += block.content.text_block.text;
              }
            }
          }
          continue;
        }

        if ((currentEvent === "STREAM_MSG_NOTIFY" || currentEvent === "FULL_MSG_NOTIFY")) {
          const message = data.message || data;
          const contentBlocks = message?.content_block || data?.content?.content_block;
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              if (block.block_type === 2074 && block.content?.creation_block?.creations) {
                for (const c of block.content.creation_block.creations) {
                  const img = c?.image || {};
                  const key = img?.key;
                  const url = img?.image_ori_raw?.url || img?.image_ori?.url;
                  if (key && url && !emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    imageUrls.push(url);
                  }
                }
              }
              if (block.block_type === 10000 && block.content?.text_block?.text) {
                textContent += block.content.text_block.text;
              }
            }
          }
          continue;
        }
      } catch {}
    }

    if (errorCode) {
      throw createDoubaoRequestError(errorMsg || "未知错误", errorCode);
    }

    return { conversationId, imageUrls, textContent };
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.info("[DoubaoSession] 空闲超时，关闭浏览器");
      this.cleanup();
    }, IDLE_TIMEOUT);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async cleanup(): Promise<void> {
    this.ready = false;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
      await this.browser?.close().catch(() => {});
    } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async stop(): Promise<void> {
    logger.info("[DoubaoSession] 停止...");
    await this.cleanup();
  }
}

const doubaoSession = new DoubaoBrowserSession();

/** 浏览器方式的图片生成 */
async function createImageCompletionViaBrowser(
  params: DoubaoImageParams,
  sessionId: string
): Promise<ChatCompletionResponse> {
  const {
    prompt,
    ratio = "1:1",
    style = "智能",
    genModel = "Seedream 4.5",
    referenceImage,
  } = params;

  if (referenceImage) {
    const storeUri = await uploadImageToDoubao(referenceImage, sessionId);
    logger.info(`[Doubao] 参考图上传完成: ${storeUri}`);
  }

  const fullPrompt = `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`;

  await doubaoSession.ensureReady(sessionId);

  logger.info(`[Doubao] 浏览器模式：模拟输入触发签名请求...`);
  const result = await doubaoSession.chatCompletion(fullPrompt);

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 统一入口（模式选择 + 自动降级）
// ═══════════════════════════════════════════════════════════════════

export interface DoubaoImageParams {
  prompt: string;
  ratio?: string;
  style?: string;
  genModel?: string;
  referenceImage?: Buffer | string;
}

interface StreamResult {
  id: string;
  model: string;
  object: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; images: string[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  created: number;
}

/**
 * 同步图片生成（统一入口）
 *
 * 模式选择逻辑：
 * - DOUBAO_IMAGE_MODE=http → 直接 HTTP
 * - DOUBAO_IMAGE_MODE=browser → 浏览器
 * - DOUBAO_IMAGE_MODE=auto（默认）→ 先 HTTP，遇 710022004 自动降级浏览器
 */
export async function createImageCompletion(
  params: DoubaoImageParams,
  sessionId: string,
  retryCount = 0
): Promise<StreamResult> {
  try {
    const mode = getImageMode();

    logger.info(
      `[Doubao] 图片生成请求: prompt=${params.prompt.substring(0, 50)}..., ratio=${params.ratio || "1:1"}, style=${params.style || "智能"}, model=${params.genModel || "Seedream 4.5"}, mode=${mode}`
    );

    let result: ChatCompletionResponse;

    if (mode === "browser") {
      // 强制浏览器模式
      result = await createImageCompletionViaBrowser(params, sessionId);
    } else if (mode === "http") {
      // 强制 HTTP 模式
      result = await createImageCompletionViaHttp(params, sessionId);
    } else {
      // auto 模式：先 HTTP，遇 shark_admin 自动降级浏览器
      try {
        result = await createImageCompletionViaHttp(params, sessionId);
        logger.info("[Doubao] HTTP 模式成功");
      } catch (httpErr: any) {
        if (isSharkAdminBlock(httpErr)) {
          logger.warn("[Doubao] HTTP 被 shark_admin 拦截，自动降级到浏览器模式...");
          result = await createImageCompletionViaBrowser(params, sessionId);
          logger.info("[Doubao] 浏览器降级模式成功");
        } else {
          throw httpErr;
        }
      }
    }

    markTokenResult(sessionId, true);

    const streamResult: StreamResult = {
      id: result.conversationId,
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: result.textContent, images: result.imageUrls },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };

    if (result.imageUrls.length === 0) {
      throw createDoubaoRequestError(
        `豆包生图未返回图片${result.textContent ? `: ${result.textContent.substring(0, 200)}` : ""}`
      );
    }

    if (result.conversationId) {
      removeConversation(result.conversationId, sessionId).catch(() => {});
    }

    return streamResult;
  } catch (err: any) {
    if (isDoubaoRateLimitedError(err)) {
      markDoubaoFailure(sessionId, err);
      throw err;
    }

    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`[Doubao] 图片生成失败: ${err.stack || err.message}`);
      logger.warn(`[Doubao] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createImageCompletion(params, sessionId, retryCount + 1);
    }
    markDoubaoFailure(sessionId, err);
    throw err;
  }
}

/**
 * 流式图片生成 —— 返回 OpenAI 兼容 SSE 流
 */
export async function createImageCompletionStream(
  params: DoubaoImageParams,
  sessionId: string,
  retryCount = 0
): Promise<PassThrough> {
  const stream = new PassThrough();
  const created = util.unixTimestamp();

  (async () => {
    try {
      stream.write(
        `data: ${JSON.stringify({
          id: "", model: MODEL_NAME, object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "正在生成图片，请稍候...\n" }, finish_reason: null }],
          created,
        })}\n\n`
      );

      const result = await createImageCompletion(params, sessionId, retryCount);
      const imageUrls = result.choices[0]?.message?.images || [];
      const textContent = result.choices[0]?.message?.content || "";

      stream.write(
        `data: ${JSON.stringify({
          id: result.id, model: MODEL_NAME, object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: imageUrls.join("\n") + (textContent ? `\n${textContent}` : "") },
            finish_reason: "stop",
          }],
          created,
        })}\n\n`
      );
      stream.end("data: [DONE]\n\n");
    } catch (err: any) {
      logger.error(`[Doubao] 流式图片生成失败: ${err.message}`);
      if (!stream.closed) {
        stream.write(
          `data: ${JSON.stringify({
            id: "", model: MODEL_NAME, object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: `\n\n豆包生图失败: ${err.message}` }, finish_reason: "stop" }],
            created,
          })}\n\n`
        );
        stream.end("data: [DONE]\n\n");
      }
    }
  })();

  return stream;
}

export async function stopDoubaoSession(): Promise<void> {
  await doubaoSession.stop();
}
