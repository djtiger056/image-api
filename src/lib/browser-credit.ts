/**
 * BrowserCreditChecker - 通过浏览器自动化查询平台积分/额度
 *
 * 对于需要 anti-bot 签名的平台（xyq、qwen），直接 HTTP 请求积分 API
 * 会被反爬拦截。此模块用 Playwright 浏览器注入 cookie 后在页面内
 * 发起 fetch 调用，浏览器环境自带所有 anti-bot 保护。
 *
 * 模式参考 kling/api-automation.ts
 */

import { randomBytes, createHash } from "crypto";
import { chromium, Browser, BrowserContext, Page } from "playwright-core";

import logger from "@/lib/logger.ts";

// ─── 浏览器实例管理 ──────────────────────────────────────────────

let browserInstance: Browser | null = null;

async function ensureBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;

  const chromePath =
    process.env.BROWSER_EXECUTABLE_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  browserInstance = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  browserInstance.on("disconnected", () => {
    browserInstance = null;
  });

  return browserInstance;
}

async function createPageWithCookies(
  cookies: Array<{ name: string; value: string; domain: string; path?: string }>,
  url: string,
  waitMs: number = 3000
): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await ensureBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
  });

  await context.addCookies(cookies);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(waitMs);

  return { context, page };
}

// ─── 工具函数 ──────────────────────────────────────────────────

function extractSessionId(sessionId: string): string {
  const raw = String(sessionId || "").trim();
  if (!raw) return "";
  const match = raw.match(/(?:^|;\s*)sessionid=([^;,\s]+)/i);
  if (match?.[1]) return match[1];
  return raw.replace(/^Bearer\s+/i, "");
}

function normalizeQwenCookie(cookie: string): string {
  return String(cookie || "")
    .replace(/^Bearer\s+/i, "")
    .split("|||")
    .map((s) => s.trim())
    .filter(Boolean)[0] || "";
}

/**
 * 将 Chrome 的 sameSite 值规范化为 Playwright 要求的格式 (Strict|Lax|None)
 */
function normalizeSameSite(value: string): string | undefined {
  const lower = value.toLowerCase().trim();
  if (lower === "no_restriction" || lower === "none") return "None";
  if (lower === "lax") return "Lax";
  if (lower === "strict") return "Strict";
  return undefined; // 未知值不设置，让浏览器用默认
}

/**
 * 检测是否为 Chrome/Playwright 导出的 JSON cookie 数组
 */
function isJsonCookieArray(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("[") && trimmed.includes('"name"');
}

/**
 * 将 Chrome 导出格式的 cookie 转为 Playwright addCookies 兼容格式
 * Chrome 格式: { name, value, domain, path, expirationDate, hostOnly, httpOnly, secure, sameSite, storeId, session }
 * Playwright 格式: { name, value, domain, path, expires?, httpOnly?, secure?, sameSite? }
 */
function parseChromeCookies(jsonStr: string, targetDomain: string): Array<{
  name: string; value: string; domain: string; path: string;
  expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string;
}> {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c: any) => c && c.name && c.value !== undefined)
      .map((c: any) => ({
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain || targetDomain),
        path: String(c.path || "/"),
        ...(typeof c.expirationDate === "number" && c.expirationDate > 0
          ? { expires: c.expirationDate }
          : {}),
        ...(typeof c.httpOnly === "boolean" ? { httpOnly: c.httpOnly } : {}),
        ...(typeof c.secure === "boolean" ? { secure: c.secure } : {}),
        ...(c.sameSite && c.sameSite !== "null"
          ? { sameSite: normalizeSameSite(String(c.sameSite)) }
          : {}),
      }));
  } catch {
    return [];
  }
}

function parseCookieToRecords(
  cookieHeader: string,
  domain: string
): Array<{ name: string; value: string; domain: string; path: string }> {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      return {
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        domain,
        path: "/",
      };
    })
    .filter((item): item is { name: string; value: string; domain: string; path: string } =>
      Boolean(item)
    );
}

// xyq 积分查询已移除 — API 返回数据不准确，容易误导用户

// ─── 千问 (qwen) 积分查询 ──────────────────────────────────────

export interface QwenCreditResult {
  totalAmount: number;
}

/**
 * 通过浏览器查询千问积分额度
 *
 * 流程：
 * 1. Playwright 注入 qwen cookie
 * 2. 导航到 create.qianwen.com（加载页面）
 * 3. 从页面 HTML 提取 __sm_req_token__（signKey + nonceId）
 * 4. Node.js 端计算签名 token = MD5(browserId_nonceId_signKey_ts_chid)
 * 5. 在页面内 fetch 带签名的积分 API 请求
 */
export async function checkQwenCredit(cookie: string): Promise<QwenCreditResult> {
  const rawCookie = String(cookie || "").replace(/^Bearer\s+/i, "").split("|||").map(s => s.trim()).filter(Boolean)[0] || "";
  if (!rawCookie) throw new Error("千问 cookie 为空");

  // 自动检测 JSON 格式（Chrome 扩展导出）vs 传统 name=value 格式
  let cookies: Array<{ name: string; value: string; domain: string; path: string;
    expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string; }>;
  if (isJsonCookieArray(rawCookie)) {
    cookies = parseChromeCookies(rawCookie, ".qianwen.com");
    logger.info(`[BrowserCredit] qwen: 从 JSON 格式解析了 ${cookies.length} 个 cookie`);
  } else {
    cookies = parseCookieToRecords(rawCookie, ".qianwen.com");
  }

  let context: BrowserContext | null = null;
  try {
    const { context: ctx, page } = await createPageWithCookies(
      cookies,
      "https://create.qianwen.com/",
      5000
    );
    context = ctx;

    // 从页面 HTML 提取 signKey 和 nonceId
    const pageHtml = await page.content();
    const signMatch = pageHtml.match(
      /__sm_req_token__\s*=\s*\{"nonceId":"([^"]+)","signKey":"([^"]+)"\}/
    );

    if (!signMatch) {
      throw new Error("无法从千问页面提取 signKey，可能 cookie 已过期或页面结构变化");
    }

    const nonceId = signMatch[1];
    const signKey = signMatch[2];
    logger.info(`[BrowserCredit] qwen signKey 获取成功 (nonceId=${nonceId.substring(0, 8)}...)`);

    // Node.js 端生成签名参数
    const browserId = randomBytes(16).toString("hex");
    const chid = randomBytes(16).toString("hex");
    const timestamp = Date.now();
    const token = createHash("md5")
      .update(`${browserId}_${nonceId}_${signKey}_${timestamp}_${chid}`)
      .digest("hex");

    // 在页面内发起带签名的积分 API 请求
    const creditResult = await page.evaluate(
      async (params: {
        chid: string;
        token: string;
        browserId: string;
        timestamp: number;
        nonceId: string;
        signKey: string;
      }) => {
        try {
          const reqId = crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).substring(2);
          const url = `https://zaodian-api.qianwen.com/api/web/credit/total?biz_id=ai_image&pr=kkpcweb&fr=win&ai_ts=${params.timestamp}&req_id=${reqId}`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              chid: params.chid,
              product: "ai_studio",
              token: params.token,
              browserId: params.browserId,
              timestamp: params.timestamp,
              nonceId: params.nonceId,
              signKey: params.signKey,
              platform: "pc",
            }),
          });
          const json = await resp.json();
          if (json.code === 0 && json.data) {
            return { totalAmount: json.data.totalAmount ?? 0 };
          }
          if (json.code === 1013) {
            return { error: "千问 Cookie 已过期" };
          }
          return { error: `code=${json.code}, msg=${json.msg}` };
        } catch (e: any) {
          return { error: e.message };
        }
      },
      { chid, token, browserId, timestamp, nonceId, signKey }
    );

    if (creditResult.error) {
      throw new Error(`查询千问积分失败: ${creditResult.error}`);
    }

    logger.info(`[BrowserCredit] qwen 积分: ${creditResult.totalAmount}`);

    return { totalAmount: creditResult.totalAmount };
  } finally {
    await context?.close().catch(() => {});
  }
}

// ─── 清理 ──────────────────────────────────────────────────────

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
