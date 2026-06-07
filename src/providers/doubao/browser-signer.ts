/**
 * DoubaoBrowserAutomation - 豆包全浏览器自动化
 *
 * 模拟真实用户操作：输入 prompt、上传参考图、点击发送
 * 页面自身代码处理 anti-bot 签名，与官网行为完全一致
 * 通过 page.on('response') 拦截 SSE 响应解析图片 URL
 */

import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import logger from "@/lib/logger.ts";

// ─── 类型 ────────────────────────────────────────────────────────────

export interface GenerateResult {
  imageUrls: string[];
  textContent: string;
  convId: string;
}

interface PendingGeneration {
  resolve: (result: GenerateResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ─── 常量 ────────────────────────────────────────────────────────────

const GENERATION_TIMEOUT = 300_000;  // 生图超时 5 分钟
const IDLE_TIMEOUT = 5 * 60_000;     // 空闲自动关闭
const PAGE_LOAD_TIMEOUT = 30_000;
const DOUBAO_CHAT_URL = "https://www.doubao.com/chat/";

// ─── 实现 ────────────────────────────────────────────────────────────

export class DoubaoBrowserAutomation {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ready = false;
  private starting = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSessionId: string | null = null;
  private pendingGeneration: PendingGeneration | null = null;

  // ── 公开方法 ──────────────────────────────────────────────────────

  /**
   * 通过浏览器 UI 生成图片
   *
   * 流程：输入 prompt → 上传参考图 → 点击发送 → DOM 轮询等待结果 → 提取图片 URL
   */
  async generateImage(
    params: {
      prompt: string;
      ratio?: string;
      style?: string;
      genModel?: string;
      referenceImage?: Buffer;
    },
    sessionId: string
  ): Promise<GenerateResult> {
    await this.ensureReady(sessionId);
    this.resetIdleTimer();

    try {
      // 1. 上传参考图（如果有）
      if (params.referenceImage) {
        await this.uploadReferenceImage(params.referenceImage);
      }

      // 2. 构造完整 prompt
      const style = params.style || "智能";
      const ratio = params.ratio || "1:1";
      const fullPrompt = `帮我生成图片：${params.prompt}\n风格：${style}\n比例：${ratio}`;

      // 3. 输入 prompt
      await this.typePrompt(fullPrompt);

      // 4. 点击发送
      await this.clickSend();

      logger.info("[DoubaoBrowserAutomation] 已发送，等待响应...");

      // 5. DOM 轮询等待结果
      const result = await this.pollDOMForResult();

      this.resetIdleTimer();
      return result;
    } catch (err: any) {
      this.resetIdleTimer();
      throw new Error(`[DoubaoBrowserAutomation] 操作失败: ${err.message}`);
    }
  }

  isReady(): boolean { return this.ready; }

  async stop(): Promise<void> {
    logger.info("[DoubaoBrowserAutomation] 停止...");
    await this.cleanup();
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  private async ensureReady(sessionId: string): Promise<void> {
    if (this.ready && this.page && !this.page.isClosed()) {
      if (sessionId !== this.currentSessionId) {
        await this.injectCookies(sessionId);
        // session 变化需要重新加载页面
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
        await this.page.waitForTimeout(3000);
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
      logger.info("[DoubaoBrowserAutomation] 启动浏览器...");

      const chromePath =
        process.env.BROWSER_EXECUTABLE_PATH ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

      this.browser = await chromium.launch({
        headless: true,
        executablePath: chromePath,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });

      this.context = await this.browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "zh-CN",
      });

      this.page = await this.context.newPage();

      // 注入 cookies
      await this.injectCookies(sessionId);

      // 监听 SSE 响应
      this.setupResponseListener();

      // 导航到 doubao.com/chat
      logger.info("[DoubaoBrowserAutomation] 导航到 doubao.com/chat...");
      await this.page.goto(DOUBAO_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT,
      });
      await this.page.waitForTimeout(5000);

      // 验证登录状态
      const isLoggedIn = await this.checkLoginStatus();
      if (!isLoggedIn) {
        throw new Error("登录状态无效，请检查 sessionid");
      }

      this.ready = true;
      this.resetIdleTimer();
      logger.success("[DoubaoBrowserAutomation] 就绪，已登录");
    } catch (err: any) {
      logger.error(`[DoubaoBrowserAutomation] 启动失败: ${err.message}`);
      await this.cleanup();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /**
   * 注入 session cookies
   */
  private async injectCookies(sessionId: string): Promise<void> {
    if (!this.context) return;
    await this.context.addCookies([
      { name: "sessionid", value: sessionId, domain: ".doubao.com", path: "/" },
      { name: "sessionid_ss", value: sessionId, domain: ".doubao.com", path: "/" },
    ]);
    this.currentSessionId = sessionId;
    logger.info("[DoubaoBrowserAutomation] 已注入 cookies");
  }

  /**
   * 验证登录状态
   */
  private async checkLoginStatus(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const result = await this.page.evaluate(async () => {
        const resp = await fetch("/passport/account/info/v2/?aid=497858", { credentials: "include" });
        const data = await resp.json();
        return !!data?.data?.user_id;
      });
      return result;
    } catch {
      return false;
    }
  }

  /**
   * 设置 SSE 响应监听器
   *
   * 通过 DOM 监控等待生成结果，同时用 fetch 拦截器捕获响应
   */
  private setupResponseListener(): void {
    // 不需要额外设置，结果通过 pollDOMForResult 获取
  }

  /**
   * 标记开始等待 SSE 响应
   */
  private markSSEPending(): void {
    // DOM 监控模式不需要标记
  }

  /**
   * 轮询 DOM 等待生成结果
   *
   * 监控页面上的新消息元素，提取图片 URL 或文本
   */
  private async pollDOMForResult(): Promise<GenerateResult> {
    if (!this.page) throw new Error("浏览器未就绪");

    const startTime = Date.now();
    const timeout = GENERATION_TIMEOUT;

    // 记录当前消息数量
    const initialMsgCount = await this.page.evaluate(() => {
      return document.querySelectorAll('[class*="message-content"]').length;
    });

    while (Date.now() - startTime < timeout) {
      await this.page.waitForTimeout(2000);

      const result = await this.page.evaluate((prevCount: number) => {
        // 查找所有图片元素（在新消息中）
        const imgs = Array.from(document.querySelectorAll('img'));
        const newImgs = imgs.filter(img => {
          const src = img.src || '';
          // 豆包生成的图片 URL 包含特定域名
          return src.includes('byteimg.com') && src.includes('rc_gen_image');
        }).map(img => img.src);

        // 查找新消息中的文本
        const msgElements = Array.from(document.querySelectorAll('[class*="message-content"]'));
        const newMsgs = msgElements.slice(prevCount);
        let textContent = '';
        for (const msg of newMsgs) {
          textContent += msg.textContent || '';
        }

        // 查找错误消息
        const errorElements = Array.from(document.querySelectorAll('[class*="error"], [class*="fail"], [class*="retry"]'));
        const hasError = errorElements.some(el => {
          const text = el.textContent || '';
          return text.includes('失败') || text.includes('错误') || text.includes('重试');
        });

        return { imageUrls: newImgs, textContent, hasError, msgCount: msgElements.length };
      }, initialMsgCount);

      if (result.imageUrls.length > 0) {
        logger.info(`[DoubaoBrowserAutomation] DOM 检测到 ${result.imageUrls.length} 张图片`);
        return { imageUrls: result.imageUrls, textContent: result.textContent, convId: "" };
      }

      if (result.hasError) {
        throw new Error("[DoubaoBrowserAutomation] 页面显示生成失败");
      }

      // 检查是否还在生成中（可以通过 loading 指示器判断）
      const isGenerating = await this.page.evaluate(() => {
        const el = document.querySelector('[class*="loading"], [class*="generating"], [class*="typing"]');
        return !!el;
      });

      if (!isGenerating && result.msgCount > initialMsgCount && Date.now() - startTime > 15000) {
        // 有新消息但没有图片，且不在生成中
        if (result.textContent) {
          return { imageUrls: [], textContent: result.textContent, convId: "" };
        }
      }
    }

    throw new Error("[DoubaoBrowserAutomation] 生图超时");
  }

  /**
   * 解析 SSE 事件流，提取图片 URL 和文本
   */
  private parseSSE(body: string): GenerateResult {
    const imageUrls: string[] = [];
    const emittedKeys = new Set<string>();
    let textContent = "";
    let convId = "";

    const lines = body.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === "[DONE]") continue;

      try {
        const event = JSON.parse(dataStr);

        // 处理 event_data
        if (event.event_type === 2001 && event.event_data) {
          const result = JSON.parse(event.event_data);

          if (!convId && result.conversation_id) {
            convId = result.conversation_id;
          }

          const message = result.message;
          if (!message || !message.content) continue;

          // 解析文本
          try {
            const content = JSON.parse(message.content);
            if (typeof content === "string") textContent += content;
            else if (typeof content.text === "string") textContent += content.text;
            else if (typeof content.content === "string") textContent += content.content;
          } catch {
            if (typeof message.content === "string") textContent += message.content;
          }

          // 解析图片 (content_type = 2074)
          if (message.content_type === 2074) {
            try {
              const payload = JSON.parse(message.content);
              if (Array.isArray(payload.creations)) {
                for (const c of payload.creations) {
                  const img = c?.image || {};
                  const key = img?.key;
                  const url = img?.image_ori_raw?.url || img?.image_ori?.url;
                  if (key && url && !emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    imageUrls.push(url);
                  }
                }
              }
            } catch {}
          }
        }

        // 处理错误事件
        if (event.event_type === 2005 && event.event_data) {
          try {
            const errData = JSON.parse(event.event_data);
            const errMsg = errData?.error_detail?.message || errData?.message || "未知错误";
            logger.warn(`[DoubaoBrowserAutomation] SSE 错误: ${errMsg}`);
          } catch {}
        }
      } catch {}
    }

    return { imageUrls, textContent, convId };
  }

  /**
   * 上传参考图
   */
  private async uploadReferenceImage(imageBuffer: Buffer): Promise<void> {
    if (!this.page) throw new Error("浏览器未就绪");

    logger.info(`[DoubaoBrowserAutomation] 上传参考图: ${imageBuffer.length} bytes`);

    // 找附件按钮：textarea 左下方的 36x36 小按钮
    // 使用坐标点击（基于 DOM 探索：textarea 在 y=980, 附件按钮在 x=712, y=1018）
    const textarea = this.page.locator("textarea.semi-input-textarea").first();
    const taBox = await textarea.boundingBox();
    if (!taBox) throw new Error("找不到输入框");

    // 附件按钮在 textarea 左下方
    const attachX = taBox.x - 8;
    const attachY = taBox.y + taBox.height + 18;

    // 等待 file input 出现
    const fileChooserPromise = this.page.waitForEvent("filechooser", { timeout: 5000 });
    await this.page.mouse.click(attachX, attachY);
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "reference.png",
      mimeType: "image/png",
      buffer: imageBuffer,
    });

    // 等待上传完成
    await this.page.waitForTimeout(3000);
    logger.info("[DoubaoBrowserAutomation] 参考图上传完成");
  }

  /**
   * 在输入框中输入 prompt
   */
  private async typePrompt(prompt: string): Promise<void> {
    if (!this.page) throw new Error("浏览器未就绪");

    // 用 keyboard.type() 逐字输入，确保 React 状态正确更新
    const textarea = this.page.locator("textarea.semi-input-textarea").first();
    await textarea.focus({ force: true });
    await this.page.keyboard.type(prompt, { delay: 10 });

    await this.page.waitForTimeout(500);
    logger.info(`[DoubaoBrowserAutomation] 已输入 prompt (${prompt.length} 字)`);
  }

  /**
   * 点击发送按钮
   */
  private async clickSend(): Promise<void> {
    if (!this.page) throw new Error("浏览器未就绪");

    // 先尝试用 Enter 键发送
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(1000);

    // 检查是否有新消息出现（输入框是否被清空）
    const textarea = this.page.locator("textarea.semi-input-textarea").first();
    const value = await textarea.inputValue();

    if (value.length > 0) {
      // Enter 没有触发发送，尝试找发送按钮并点击
      logger.info("[DoubaoBrowserAutomation] Enter 未触发发送，尝试点击发送按钮...");

      // 找输入区域右侧的按钮（发送按钮通常是最后一个图标按钮）
      const sendBtn = this.page.locator("textarea.semi-input-textarea")
        .locator("..").locator("..").locator("..").locator("..").locator("..")
        .locator("button").last();

      try {
        await sendBtn.click({ timeout: 5000 });
      } catch {
        // 备选：按 Ctrl+Enter
        await this.page.keyboard.press("Control+Enter");
      }
    }

    logger.info("[DoubaoBrowserAutomation] 已发送");
  }

  /**
   * 重置空闲定时器
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.info("[DoubaoBrowserAutomation] 空闲超时，关闭浏览器");
      this.cleanup();
    }, IDLE_TIMEOUT);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    this.ready = false;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.pendingGeneration) {
      clearTimeout(this.pendingGeneration.timeout);
      this.pendingGeneration.reject(new Error("[DoubaoBrowserAutomation] 服务已关闭"));
      this.pendingGeneration = null;
    }
    try {
      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
      await this.browser?.close().catch(() => {});
    } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

// 全局单例
export const doubaoBrowserAutomation = new DoubaoBrowserAutomation();
