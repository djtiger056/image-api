/**
 * BrowserSigner - 浏览器端 anti-bot 签名服务
 *
 * 用 Playwright 浏览器生成字节跳动系平台的 anti-bot 签名参数(fp/msToken/a_bogus)。
 * 浏览器只负责签名，实际 API 请求由 axios 发送，支持高并发。
 *
 * 架构: 单浏览器实例 + route 拦截器捕获签名 URL
 */

import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import logger from "@/lib/logger.ts";

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

interface PendingSign {
  resolve: (value: SignedRequest) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class BrowserSigner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ready = false;
  private starting = false;
  private pendingSigns = new Map<string, PendingSign>();
  private signedResults = new Map<string, SignedRequest>();

  // 签名请求超时时间
  private static SIGN_TIMEOUT = 15000;

  /**
   * 启动浏览器并初始化签名服务
   */
  async start(): Promise<void> {
    if (this.ready || this.starting) return;
    this.starting = true;

    try {
      logger.info("[BrowserSigner] 启动浏览器...");

      // 使用系统 Chrome（项目已配置的浏览器路径）
      const chromePath =
        process.env.BROWSER_EXECUTABLE_PATH ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

      this.browser = await chromium.launch({
        headless: true,
        executablePath: chromePath,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });

      this.context = await this.browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "zh-CN",
      });

      this.page = await this.context.newPage();

      // 设置 route 拦截器 — 捕获签名后的 URL
      await this.page.route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();

        // 只拦截 API 请求（包含 anti-bot 参数）
        if (this.isApiRequest(url)) {
          const signedReq: SignedRequest = {
            url,
            headers: request.headers(),
          };

          // 检查是否有等待这个签名的请求
          const key = this.findPendingKey(url);
          if (key) {
            const pending = this.pendingSigns.get(key);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingSigns.delete(key);
              pending.resolve(signedReq);
            }
          }

          // 存储结果（用于非精确匹配）
          this.signedResults.set(url, signedReq);

          // 取消浏览器请求（不需要真正发出去）
          await route.abort();
          return;
        }

        // 非 API 请求放行（页面加载、静态资源等）
        await route.continue();
      });

      // 导航到 xyq 加载 sdk-glue.js
      await this.page.goto("https://xyq.jianying.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // 等待页面稳定
      await this.page.waitForTimeout(3000);

      this.ready = true;
      logger.success("[BrowserSigner] 浏览器签名服务就绪");
    } catch (err: any) {
      logger.error(`[BrowserSigner] 启动失败: ${err.message}`);
      await this.cleanup();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /**
   * 确保签名服务就绪
   */
  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      await this.start();
    }
  }

  /**
   * 判断 URL 是否为 API 请求（包含 anti-bot 参数或目标 API 路径）
   */
  private isApiRequest(url: string): boolean {
    // xyq API 路径
    if (url.includes("xyq.jianying.com/api/")) return true;
    // doubao API 路径
    if (url.includes("www.doubao.com/samantha/")) return true;
    if (url.includes("www.doubao.com/chat/completion")) return true;
    // 包含 a_bogus 参数的请求
    if (url.includes("a_bogus=")) return true;
    return false;
  }

  /**
   * 从 pending 队列中查找匹配的请求
   */
  private findPendingKey(url: string): string | null {
    for (const key of Array.from(this.pendingSigns.keys())) {
      // URL 路径匹配（忽略查询参数的微小差异）
      const keyPath = key.split("?")[0];
      const urlPath = url.split("?")[0];
      if (keyPath === urlPath || url.startsWith(keyPath)) {
        return key;
      }
    }
    return null;
  }

  /**
   * 获取 anti-bot 签名参数
   *
   * @param targetUrl 目标 API URL（不含 anti-bot 参数）
   * @param method HTTP 方法
   * @param body 请求体（可选）
   * @returns 签名后的 URL 和 headers
   */
  async sign(
    targetUrl: string,
    method: string = "POST",
    body?: string
  ): Promise<SignedRequest> {
    await this.ensureReady();

    return new Promise<SignedRequest>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSigns.delete(targetUrl);
        reject(
          new Error(
            `[BrowserSigner] 签名超时 (${BrowserSigner.SIGN_TIMEOUT}ms): ${targetUrl}`
          )
        );
      }, BrowserSigner.SIGN_TIMEOUT);

      this.pendingSigns.set(targetUrl, { resolve, reject, timeout });

      // 从浏览器端触发 fetch，让 route 拦截器捕获签名后的 URL
      this.page!
        .evaluate(
          ({ url, method, body }) => {
            fetch(url, {
              method,
              headers: { "Content-Type": "application/json" },
              ...(body ? { body } : {}),
              credentials: "include",
            }).catch(() => {
              // 请求会被 route 拦截并 abort，所以一定会报错，这是正常的
            });
          },
          { url: targetUrl, method, body }
        )
        .catch((err) => {
          // page.evaluate 本身的错误（如页面崩溃）
          clearTimeout(timeout);
          this.pendingSigns.delete(targetUrl);
          reject(
            new Error(`[BrowserSigner] evaluate 失败: ${err.message}`)
          );
        });
    });
  }

  /**
   * 获取 anti-bot URL 参数字符串
   *
   * @param targetUrl 目标 API URL
   * @returns 签名后的 URL（包含 fp/msToken/a_bogus 等参数）
   */
  async getSignedUrl(targetUrl: string, body?: string): Promise<string> {
    const signed = await this.sign(targetUrl, "POST", body);
    return signed.url;
  }

  /**
   * 提取 URL 中的 anti-bot 参数
   */
  extractAntiBotParams(url: string): Record<string, string> {
    const params: Record<string, string> = {};
    const urlObj = new URL(url);
    const antiBotKeys = [
      "verifyFp",
      "fp",
      "msToken",
      "a_bogus",
      "X-Bogus",
    ];
    for (const key of antiBotKeys) {
      const value = urlObj.searchParams.get(key);
      if (value) params[key] = value;
    }
    return params;
  }

  /**
   * 检查签名服务是否就绪
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    this.ready = false;
    // 拒绝所有等待中的签名请求
    for (const [key, pending] of Array.from(this.pendingSigns.entries())) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("[BrowserSigner] 服务已关闭"));
    }
    this.pendingSigns.clear();
    this.signedResults.clear();

    try {
      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
      await this.browser?.close().catch(() => {});
    } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /**
   * 停止签名服务
   */
  async stop(): Promise<void> {
    logger.info("[BrowserSigner] 停止签名服务...");
    await this.cleanup();
    logger.info("[BrowserSigner] 签名服务已停止");
  }

  /**
   * 重启签名服务
   */
  async restart(): Promise<void> {
    await this.cleanup();
    await this.start();
  }
}

// 全局单例
export const browserSigner = new BrowserSigner();
