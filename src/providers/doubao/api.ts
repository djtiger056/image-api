/**
 * doubao.com API 底层调用模块
 *
 * 混合方案（对标 xyq 轻量化）：
 * - 浏览器负责：页面加载、SDK 初始化、anti-bot 签名
 * - 模拟输入触发签名：textarea 输入 → Enter → SDK 自动签名
 * - 路由拦截：捕获签名后的请求 URL 和 SSE 响应
 * - 直接解析 HTTP 响应，不轮询 DOM
 */

import crypto from "crypto";
import { PassThrough } from "stream";
import { chromium, Browser, BrowserContext, Page, Route } from "playwright-core";

import _ from "lodash";
import axios from "axios";

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
const IMAGE_GEN_BOT_ID = "7338286299411103781";
const DOUBAO_CHAT_URL = "https://www.doubao.com/chat/";
const IDLE_TIMEOUT = 5 * 60_000;
const PAGE_LOAD_TIMEOUT = 30_000;
const GENERATION_TIMEOUT = 300_000;

const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://www.doubao.com",
  Referer: "https://www.doubao.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// ─── 工具函数 ──────────────────────────────────────────────────────

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

function createDoubaoRequestError(errMsg: string, errCode?: string | number): APIException {
  const detail = errCode ? `${errCode} - ${errMsg}` : errMsg;
  const error = new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${detail}`);
  if (isDoubaoRateLimitedError(error)) error.setHTTPStatusCode(429);
  return error;
}

function markDoubaoFailure(sessionId: string, error: any): void {
  markTokenResult(sessionId, false, error?.message || String(error || "未知错误"));
}

// ─── Doubao 浏览器会话 ─────────────────────────────────────────────
//
//  轻量混合方案：
//  1. 浏览器导航到 doubao.com/chat，SDK 自动加载
//  2. 模拟用户输入（textarea + Enter）触发 SDK 签名
//  3. 路由拦截捕获签名后的 HTTP 请求和响应
//  4. 直接解析 SSE 响应文本，不轮询 DOM
//

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
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

      this.browser = await chromium.launch({
        headless: true,
        executablePath: chromePath,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });

      this.context = await this.browser.newContext({
        userAgent: FAKE_HEADERS["User-Agent"],
        viewport: { width: 1920, height: 1080 },
        locale: "zh-CN",
      });

      this.page = await this.context.newPage();
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

  /**
   * 通过模拟用户输入 + 路由拦截调用 /chat/completion
   *
   * 流程：
   * 1. 设置路由拦截器捕获 /chat/completion 请求和响应
   * 2. 在 textarea 中输入 prompt
   * 3. 按 Enter 发送
   * 4. SDK 自动签名，路由拦截器捕获完整请求和响应
   * 5. 解析 SSE 响应
   */
  async chatCompletion(prompt: string): Promise<ChatCompletionResponse> {
    if (!this.page) throw new Error("浏览器未就绪");
    this.resetIdleTimer();

    return new Promise<ChatCompletionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("[DoubaoSession] 请求超时"));
      }, GENERATION_TIMEOUT);

      // 设置路由拦截器
      this.page!.route("**/chat/completion*", async (route) => {
        const request = route.request();
        const url = request.url();

        // 只处理 chat/completion 请求
        if (!url.includes("chat/completion")) {
          await route.continue();
          return;
        }

        logger.info(`[DoubaoSession] 捕获签名请求: a_bogus=${url.includes("a_bogus")}, fp=${url.includes("fp")}`);

        try {
          // 继续请求并获取响应
          const response = await route.fetch();
          const body = await response.text();

          clearTimeout(timeout);

          // 解析 SSE 响应
          const result = this.parseSSEResponse(body);

          // 清理路由拦截器
          await this.page!.unroute("**/chat/completion*");

          resolve(result);
        } catch (err: any) {
          clearTimeout(timeout);
          await this.page!.unroute("**/chat/completion*").catch(() => {});
          reject(err);
        }
      });

      // 模拟用户输入
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

  /**
   * 解析 /chat/completion 的 SSE 响应
   *
   * 格式：
   *   event: SSE_ACK           → conversation_id
   *   event: STREAM_ERROR      → error_code, error_msg
   *   event: STREAM_CHUNK      → patch_op[].patch_value.content_block[] (文本/图片增量)
   *   event: SSE_REPLY_END     → end_type
   *
   * 图片数据在 STREAM_CHUNK 中 block_type=2074 的 content_block 里：
   *   content.creation_block.creations[].image.{key, image_ori_raw.url, image_ori.url}
   */
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

        // SSE_ACK — 包含 conversation_id
        if (currentEvent === "SSE_ACK") {
          conversationId = data?.ack_client_meta?.conversation_id || "";
          continue;
        }

        // STREAM_ERROR
        if (currentEvent === "STREAM_ERROR") {
          errorCode = data.error_code;
          errorMsg = data.error_msg || "未知错误";
          logger.warn(`[DoubaoSession] STREAM_ERROR: code=${errorCode}, msg=${errorMsg}`);
          continue;
        }

        // SSE_REPLY_END — 忽略
        if (currentEvent === "SSE_REPLY_END") continue;

        // STREAM_CHUNK — 增量内容（文本 + 图片）
        if (currentEvent === "STREAM_CHUNK" && Array.isArray(data.patch_op)) {
          for (const op of data.patch_op) {
            const contentBlocks = op?.patch_value?.content_block;
            if (!Array.isArray(contentBlocks)) continue;

            for (const block of contentBlocks) {
              // 图片内容 (block_type = 2074)
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

              // 文本内容 (block_type = 10000)
              if (block.block_type === 10000 && block.content?.text_block?.text) {
                textContent += block.content.text_block.text;
              }
            }
          }
          continue;
        }

        // STREAM_MSG_NOTIFY / FULL_MSG_NOTIFY — 全量消息
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

// 全局单例
const doubaoSession = new DoubaoBrowserSession();

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

// ─── 图片生成 ──────────────────────────────────────────────────────

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
 * 同步图片生成
 *
 * 流程：
 * 1. 上传参考图（如有）
 * 2. 构造 prompt（含风格/比例）
 * 3. 浏览器会话模拟输入 + 路由拦截
 * 4. SDK 签名 → 捕获请求/响应 → 解析 SSE
 */
export async function createImageCompletion(
  params: DoubaoImageParams,
  sessionId: string,
  retryCount = 0
): Promise<StreamResult> {
  try {
    const {
      prompt,
      ratio = "1:1",
      style = "智能",
      genModel = "Seedream 4.5",
      referenceImage,
    } = params;

    logger.info(
      `[Doubao] 图片生成请求: prompt=${prompt.substring(0, 50)}..., ratio=${ratio}, style=${style}, model=${genModel}, refImage=${!!referenceImage}`
    );

    // 1. 上传参考图（如果有）
    if (referenceImage) {
      const storeUri = await uploadImageToDoubao(referenceImage, sessionId);
      logger.info(`[Doubao] 参考图上传完成: ${storeUri}`);
    }

    // 2. 构造完整 prompt
    const fullPrompt = `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`;

    // 3. 确保浏览器会话就绪
    await doubaoSession.ensureReady(sessionId);

    // 4. 模拟输入 + 路由拦截 → SDK 签名 → 捕获响应
    logger.info(`[Doubao] 模拟输入触发签名请求...`);
    const result = await doubaoSession.chatCompletion(fullPrompt);

    markTokenResult(sessionId, true);

    // 5. 构造 StreamResult
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

    // 6. 异步清理会话
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
  const { PassThrough } = await import("stream");
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
