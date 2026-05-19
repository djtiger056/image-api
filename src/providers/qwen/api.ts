/**
 * 千问 (Qwen) 视频生成 API 底层模块
 *
 * 封装 create.qianwen.com 的 web API，实现 HappyHorse 1.0 视频生成。
 *
 * API 流程：
 * 1. 从页面 HTML 提取 signKey/nonceId
 * 2. 生成 token = MD5(browserId_nonceId_signKey_timestamp_chid)
 * 3. POST /api/web/ai/video/function 提交任务
 * 4. POST /api/web/assets/v1/batch/get 轮询结果
 */

import crypto from "crypto";

import _ from "lodash";
import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const API_BASE = "https://zaodian-api.qianwen.com";
const PAGE_URL = "https://create.qianwen.com/";
const BIZ_ID = "ai_image";
const PR = "kkpcweb";
const FR = "win";
const PRODUCT = "ai_studio";
const PLATFORM = "pc";
const POLL_INTERVAL = 5000; // 5秒轮询一次
const MAX_POLL_TIME = 300000; // 最长等待5分钟
const MAX_RETRY_COUNT = 3;

// signKey 缓存（每次页面加载会变化，缓存30分钟）
let cachedSignKey: { nonceId: string; signKey: string; ts: number } | null = null;
const SIGNKEY_TTL = 30 * 60 * 1000; // 30分钟

// ─── 工具函数 ──────────────────────────────────────────────────────

function md5(str: string): string {
  return crypto.createHash("md5").update(str, "utf8").digest("hex");
}

function generateHexId(len: number = 32): string {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").substring(0, len);
}

export function tokenSplit(cookie: string): string[] {
  return cookie
    .replace(/^Bearer\s+/i, "")
    .split("|||")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildApiUrl(path: string): string {
  const ts = Date.now();
  const reqId = util.uuid();
  return `${API_BASE}${path}?biz_id=${BIZ_ID}&pr=${PR}&fr=${FR}&ai_ts=${ts}&req_id=${reqId}`;
}

// ─── signKey 获取 ──────────────────────────────────────────────────

/**
 * 从 create.qianwen.com 页面提取 signKey 和 nonceId
 * 结果会缓存30分钟
 */
export async function getSignKeyAndNonce(cookie: string): Promise<{
  nonceId: string;
  signKey: string;
}> {
  if (cachedSignKey && Date.now() - cachedSignKey.ts < SIGNKEY_TTL) {
    return { nonceId: cachedSignKey.nonceId, signKey: cachedSignKey.signKey };
  }

  logger.info("[QwenVideo] 正在从页面获取 signKey...");

  const response = await axios.get(PAGE_URL, {
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    timeout: 15000,
  });

  const html = response.data as string;
  const match = html.match(
    /__sm_req_token__\s*=\s*\{"nonceId":"([^"]+)","signKey":"([^"]+)"\}/
  );

  if (!match) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      "[QwenVideo] 无法从页面提取 signKey，可能 cookie 已过期"
    );
  }

  cachedSignKey = {
    nonceId: match[1],
    signKey: match[2],
    ts: Date.now(),
  };

  logger.success(`[QwenVideo] signKey 获取成功`);
  return { nonceId: match[1], signKey: match[2] };
}

// ─── Token 生成 ────────────────────────────────────────────────────

/**
 * 生成 API token
 * token = MD5(browserId_nonceId_signKey_timestamp_chid)
 */
function generateToken(
  browserId: string,
  nonceId: string,
  signKey: string,
  timestamp: number,
  chid: string
): string {
  return md5(`${browserId}_${nonceId}_${signKey}_${timestamp}_${chid}`);
}

// ─── 通用请求 ──────────────────────────────────────────────────────

interface QwenApiParams {
  chid: string;
  token: string;
  browserId: string;
  timestamp: number;
  nonceId: string;
  signKey: string;
}

async function buildCommonParams(cookie: string): Promise<QwenApiParams> {
  const { nonceId, signKey } = await getSignKeyAndNonce(cookie);
  const browserId = generateHexId(32);
  const chid = generateHexId(32);
  const timestamp = Date.now();
  const token = generateToken(browserId, nonceId, signKey, timestamp, chid);

  return { chid, token, browserId, timestamp, nonceId, signKey };
}

// ─── 额度查询 ──────────────────────────────────────────────────────

export async function getCredit(
  cookie: string
): Promise<{ totalAmount: number }> {
  const params = await buildCommonParams(cookie);
  const url = buildApiUrl("/api/web/credit/total");

  const response = await axios.post(
    url,
    {
      chid: params.chid,
      product: PRODUCT,
      token: params.token,
      browserId: params.browserId,
      timestamp: params.timestamp,
      nonceId: params.nonceId,
      signKey: params.signKey,
      platform: PLATFORM,
    },
    {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 15000,
    }
  );

  if (response.data.code !== 0) {
    throw new Error(`查询额度失败: ${response.data.msg}`);
  }

  return response.data.data;
}

// ─── 视频结果接口 ─────────────────────────────────────────────────

export interface QwenVideoResult {
  success: boolean;
  videoUrl?: string;
  coverUrl?: string;
  error?: string;
  creditRemaining?: number;
}

// ─── 提交视频任务 ─────────────────────────────────────────────────

export interface QwenVideoParams {
  prompt: string;
  ratio?: string;
  duration?: number;
  attachments?: Array<{ type: string; url: string }>;
}

/**
 * 同步视频生成 —— 提交任务、轮询结果、返回视频 URL
 */
export async function createVideoCompletion(
  params: QwenVideoParams,
  cookie: string
): Promise<QwenVideoResult> {
  const { prompt, ratio = "16:9", duration = 10, attachments = [] } = params;

  // 检查额度
  try {
    const credit = await getCredit(cookie);
    if (credit.totalAmount <= 0) {
      return {
        success: false,
        error: "千问视频额度已用完",
        creditRemaining: 0,
      };
    }
    logger.info(`[QwenVideo] 当前额度: ${credit.totalAmount}`);
  } catch (e) {
    logger.warn(`[QwenVideo] 查询额度失败，继续尝试: ${(e as Error).message}`);
  }

  // 构建请求参数
  const common = await buildCommonParams(cookie);
  const submitUrl = buildApiUrl("/api/web/ai/video/function");

  const submitBody = {
    model: "happyhorse",
    rootModel: "happyhorse",
    prompt,
    originPrompt: prompt,
    params: {
      size: ratio,
      resolution: "720P",
      duration: duration === 5 ? 5 : 10,
      attachmentType: 0,
      attachments,
    },
    genMode: "vid_gen",
    chid: common.chid,
    product: PRODUCT,
    token: common.token,
    browserId: common.browserId,
    timestamp: common.timestamp,
    nonceId: common.nonceId,
    signKey: common.signKey,
    platform: PLATFORM,
  };

  logger.info(
    `[QwenVideo] 提交视频任务: prompt="${prompt.substring(0, 30)}...", ratio=${ratio}, duration=${duration}s`
  );

  // 提交任务
  const submitResponse = await axios.post(submitUrl, submitBody, {
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 30000,
  });

  if (submitResponse.data.code !== 0) {
    return {
      success: false,
      error: `提交失败: ${submitResponse.data.msg}`,
    };
  }

  logger.success(`[QwenVideo] 任务已提交，开始轮询结果...`);

  // 轮询结果
  const recordId = common.chid; // 提交时的 chid 就是 recordId
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    try {
      const pollParams = await buildCommonParams(cookie);
      const pollUrl = buildApiUrl("/api/web/assets/v1/batch/get");

      const pollResponse = await axios.post(
        pollUrl,
        {
          items: [{ recordId, scene: "hh_t2v" }],
          req_id: util.uuid(),
          chid: pollParams.chid,
          product: PRODUCT,
          token: pollParams.token,
          browserId: pollParams.browserId,
          timestamp: pollParams.timestamp,
          nonceId: pollParams.nonceId,
          signKey: pollParams.signKey,
          platform: PLATFORM,
        },
        {
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 15000,
        }
      );

      if (pollResponse.data.code !== 0) {
        logger.warn(
          `[QwenVideo] 轮询返回错误: ${pollResponse.data.msg}`
        );
        continue;
      }

      const list = pollResponse.data.data?.list;
      if (!list || list.length === 0) continue;

      const content = list[0]?.content;
      if (!content) continue;

      // 检查是否有结果视频
      const resultVideos = content.extra?.result_videos;
      if (resultVideos && resultVideos.length > 0) {
        const videoUrl = resultVideos[0].url;
        const coverUrl = resultVideos[0].cover?.cdn_url;

        logger.success(
          `[QwenVideo] 视频生成完成! URL: ${videoUrl.substring(0, 80)}...`
        );

        return {
          success: true,
          videoUrl,
          coverUrl,
        };
      }

      // 检查是否失败
      const status = content.extra?.status;
      if (status === "failed" || status === "error") {
        return {
          success: false,
          error: content.extra?.error_msg || "视频生成失败",
        };
      }

      // 还在处理中，继续轮询
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`[QwenVideo] 仍在生成中... (${elapsed}s)`);
    } catch (pollErr) {
      logger.warn(
        `[QwenVideo] 轮询请求异常: ${(pollErr as Error).message}`
      );
    }
  }

  return {
    success: false,
    error: "视频生成超时（超过5分钟）",
  };
}
