/**
 * 千问 (Qianwen) 视频生成 API 底层模块
 *
 * 封装 create.qianwen.com 的 HappyHorse 1.0 视频生成接口，
 * 实现文生视频的提交、轮询与信用查询。
 *
 * 认证方式：Cookie-based auth，通过 QWEN_COOKIE 环境变量传入
 * signKey/nonceId 从 create.qianwen.com 页面 HTML 提取
 */

import crypto from "crypto";
import _ from "lodash";
import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const BASE_URL = "https://zaodian-api.qianwen.com";
const PAGE_URL = "https://create.qianwen.com";
const COMMON_PARAMS = "biz_id=ai_image&pr=kkpcweb&fr=win";
const MAX_POLL_ATTEMPTS = 120; // 最多轮询 120 次
const POLL_INTERVAL_MS = 5000; // 每 5 秒轮询一次
const SIGN_CACHE_TTL_MS = 25 * 60 * 1000; // signKey 缓存 25 分钟

const FAKE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Content-Type": "application/json",
  Origin: "https://create.qianwen.com",
  Referer: "https://create.qianwen.com/",
  "Sec-Ch-Ua":
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// ─── signKey 缓存 ─────────────────────────────────────────────────

interface SignCache {
  signKey: string;
  nonceId: string;
  fetchedAt: number;
}

let signCache: SignCache | null = null;

// ─── 工具函数 ──────────────────────────────────────────────────────

/**
 * 生成随机 hex 字符串 (32 chars)
 */
function randomHex32(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 生成 MD5 token
 * token = MD5(browserId_nonceId_signKey_timestamp_chid)
 */
export function generateToken(
  browserId: string,
  nonceId: string,
  signKey: string,
  timestamp: number,
  chid: string
): string {
  const raw = `${browserId}_${nonceId}_${signKey}_${timestamp}_${chid}`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

/**
 * 从 create.qianwen.com 页面提取 signKey 和 nonceId
 */
export async function getSignKeyAndNonce(): Promise<{
  signKey: string;
  nonceId: string;
}> {
  // 检查缓存
  if (signCache && Date.now() - signCache.fetchedAt < SIGN_CACHE_TTL_MS) {
    return { signKey: signCache.signKey, nonceId: signCache.nonceId };
  }

  logger.info("[Qwen] 正在从 create.qianwen.com 获取 signKey/nonceId...");

  const response = await axios.get(PAGE_URL, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "User-Agent": FAKE_HEADERS["User-Agent"],
    },
    timeout: 15000,
  });

  const html = response.data as string;
  const match = html.match(
    /__sm_req_token__\s*=\s*\{\s*"nonceId"\s*:\s*"([^"]+)"\s*,\s*"signKey"\s*:\s*"([^"]+)"\s*\}/
  );

  if (!match) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      "[Qwen] 无法从 create.qianwen.com 页面提取 signKey/nonceId"
    );
  }

  const nonceId = match[1];
  const signKey = match[2];

  signCache = { signKey, nonceId, fetchedAt: Date.now() };
  logger.info(`[Qwen] 获取 signKey/nonceId 成功`);

  return { signKey, nonceId };
}

/**
 * 强制刷新 signKey 缓存
 */
export function invalidateSignCache(): void {
  signCache = null;
}

/**
 * cookie 分割（支持多 cookie 用 \n 或 , 分隔）
 */
export function tokenSplit(cookie: string): string[] {
  return cookie
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── 底层请求 ──────────────────────────────────────────────────────

function buildApiUrl(path: string): string {
  const ts = Date.now();
  const reqId = util.uuid();
  return `${BASE_URL}${path}?${COMMON_PARAMS}&ai_ts=${ts}&req_id=${reqId}`;
}

async function qwenRequest(
  path: string,
  data: any,
  cookie: string,
  timeout = 15000
): Promise<any> {
  const url = buildApiUrl(path);
  const response = await axios.post(url, data, {
    headers: {
      ...FAKE_HEADERS,
      Cookie: cookie,
    },
    timeout,
    validateStatus: () => true,
  });

  return response.data;
}

// ─── 视频参数接口 ─────────────────────────────────────────────────

export interface QwenVideoParams {
  prompt: string;
  ratio?: string;
  duration?: number;
}

// ─── 视频结果接口 ─────────────────────────────────────────────────

export interface QwenVideoResult {
  videoUrl: string;
  success: boolean;
  error?: string;
}

// ─── 视频比例映射 ─────────────────────────────────────────────────

const VALID_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

export function normalizeQwenRatio(ratio?: string): string {
  if (!ratio) return "16:9";
  const normalized = ratio.replace(/\s/g, "");
  if (VALID_RATIOS.includes(normalized)) return normalized;
  const aliasMap: Record<string, string> = {
    "1x1": "1:1",
    "4x3": "4:3",
    "3x4": "3:4",
    "16x9": "16:9",
    "9x16": "9:16",
    landscape: "16:9",
    portrait: "9:16",
    square: "1:1",
  };
  return aliasMap[normalized.toLowerCase()] || "16:9";
}

// ─── 视频生成（同步） ─────────────────────────────────────────────

/**
 * 同步视频生成 —— 提交任务、轮询直到完成、返回视频 URL
 */
export async function createVideoCompletion(
  params: QwenVideoParams,
  cookie: string
): Promise<QwenVideoResult> {
  const { prompt, ratio = "16:9", duration = 10 } = params;
  const normalizedRatio = normalizeQwenRatio(ratio);
  const normalizedDuration = duration === 5 ? 5 : 10;

  logger.info(
    `[Qwen] 视频生成请求: prompt=${prompt.substring(0, 50)}..., ratio=${normalizedRatio}, duration=${normalizedDuration}s`
  );

  // 获取签名信息
  const { signKey, nonceId } = await getSignKeyAndNonce();

  // 准备通用参数
  const browserId = randomHex32();
  const chid = randomHex32();
  const timestamp = Date.now();
  const token = generateToken(browserId, nonceId, signKey, timestamp, chid);

  // ── 提交视频任务 ──
  const submitBody = {
    model: "happyhorse",
    rootModel: "happyhorse",
    prompt,
    originPrompt: prompt,
    params: {
      size: normalizedRatio,
      resolution: "720P",
      duration: normalizedDuration,
      attachmentType: 0,
      attachments: [],
    },
    genMode: "vid_gen",
    chid,
    product: "ai_studio",
    token,
    browserId,
    timestamp,
    nonceId,
    signKey,
    platform: "pc",
  };

  logger.info("[Qwen] 提交视频生成任务...");
  const submitResult = await qwenRequest(
    "/api/web/ai/video/function",
    submitBody,
    cookie,
    30000
  );

  if (submitResult.code !== 0) {
    const errMsg = submitResult.message || submitResult.msg || "提交任务失败";
    logger.error(`[Qwen] 提交任务失败: ${JSON.stringify(submitResult)}`);
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[Qwen] 提交视频任务失败: ${errMsg}`
    );
  }

  logger.info("[Qwen] 视频任务提交成功，开始轮询结果...");

  // ── 轮询结果 ──
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollTs = Date.now();
    const pollChid = randomHex32();
    const pollToken = generateToken(
      browserId,
      nonceId,
      signKey,
      pollTs,
      pollChid
    );

    const pollBody = {
      items: [{ recordId: chid, scene: "hh_t2v" }],
      req_id: util.uuid(),
      chid: pollChid,
      product: "ai_studio",
      token: pollToken,
      browserId,
      timestamp: pollTs,
      nonceId,
      signKey,
      platform: "pc",
    };

    const pollResult = await qwenRequest(
      "/api/web/assets/v1/batch/get",
      pollBody,
      cookie,
      15000
    );

    if (pollResult.code !== 0) {
      logger.warn(
        `[Qwen] 轮询第 ${attempt} 次返回错误: ${JSON.stringify(pollResult)}`
      );
      continue;
    }

    // 检查视频是否完成
    const list = pollResult.data?.list;
    if (Array.isArray(list) && list.length > 0) {
      const item = list[0];
      // 检查内容中的视频 URL
      if (item.content?.result_videos?.length > 0) {
        const videoUrl = item.content.result_videos[0].url;
        if (videoUrl) {
          logger.info(`[Qwen] 视频生成完成 (第 ${attempt} 次轮询): ${videoUrl}`);
          return { videoUrl, success: true };
        }
      }
      // 检查 status 字段判断任务失败
      if (item.status === "failed" || item.status === "error") {
        const errMsg = item.error_msg || item.message || "视频生成失败";
        logger.error(`[Qwen] 视频生成失败: ${errMsg}`);
        return { videoUrl: "", success: false, error: errMsg };
      }
    }

    if (attempt % 10 === 0) {
      logger.info(`[Qwen] 已轮询 ${attempt} 次，继续等待...`);
    }
  }

  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[Qwen] 视频生成轮询超时 (${MAX_POLL_ATTEMPTS} 次，${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}秒)`
  );
}

// ─── 信用查询 ─────────────────────────────────────────────────────

/**
 * 查询剩余信用额度
 */
export async function getCredit(
  cookie: string
): Promise<{ totalAmount: number }> {
  const signKeyNonce = await getSignKeyAndNonce();
  const { signKey, nonceId } = signKeyNonce;

  const browserId = randomHex32();
  const chid = randomHex32();
  const timestamp = Date.now();
  const token = generateToken(browserId, nonceId, signKey, timestamp, chid);

  const body = {
    chid,
    product: "ai_studio",
    token,
    browserId,
    timestamp,
    nonceId,
    signKey,
    platform: "pc",
  };

  const result = await qwenRequest(
    "/api/web/credit/total",
    body,
    cookie,
    15000
  );

  if (result.code !== 0) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[Qwen] 查询信用失败: ${result.message || JSON.stringify(result)}`
    );
  }

  return { totalAmount: result.data?.totalAmount ?? 0 };
}
