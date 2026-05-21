/**
 * 千问 (Qwen) API 底层模块
 *
 * 封装 create.qianwen.com / DashScope API，支持：
 * - HappyHorse 1.0 视频生成
 * - Wan 2.6 / Wan 2.7 视频生成
 * - Qwen-Image 2.0 / 1.0 图片生成（文生图、图生图）
 *
 * API 流程：
 * 1. 从页面 HTML 提取 signKey/nonceId
 * 2. 生成 token = MD5(browserId_nonceId_signKey_timestamp_chid)
 * 3. 提交任务（视频/图片）
 * 4. 轮询结果
 */

import crypto from "crypto";

import _ from "lodash";
import axios from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { uploadImageToQwen } from "@/providers/qwen/upload.ts";

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
const IMAGE_POLL_TIME = 120000; // 图片最长等待2分钟
const VIDEO_POLL_TIME = 420000; // 视频最长等待7分钟

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

export function buildApiUrl(path: string): string {
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

  logger.info("[Qwen] 正在从页面获取 signKey...");

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
      "[Qwen] 无法从页面提取 signKey，可能 cookie 已过期"
    );
  }

  cachedSignKey = {
    nonceId: match[1],
    signKey: match[2],
    ts: Date.now(),
  };

  logger.success(`[Qwen] signKey 获取成功`);
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

function buildSignFields(params: QwenApiParams): Record<string, any> {
  return {
    chid: params.chid,
    product: PRODUCT,
    token: params.token,
    browserId: params.browserId,
    timestamp: params.timestamp,
    nonceId: params.nonceId,
    signKey: params.signKey,
    platform: PLATFORM,
  };
}

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// ─── 额度查询 ──────────────────────────────────────────────────────

/** Cookie 过期/鉴权失败专用错误 */
export class QwenAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenAuthError";
  }
}

export async function getCredit(
  cookie: string
): Promise<{ totalAmount: number }> {
  const params = await buildCommonParams(cookie);
  const url = buildApiUrl("/api/web/credit/total");

  const response = await axios.post(
    url,
    buildSignFields(params),
    {
      headers: { Cookie: cookie, ...DEFAULT_HEADERS },
      timeout: 15000,
    }
  );

  const { code, msg } = response.data;

  // 1013 = 登录校验未通过（cookie 过期）
  if (code === 1013) {
    throw new QwenAuthError("千问 Cookie 已过期，请更新 QWEN_COOKIE");
  }

  if (code !== 0) {
    throw new Error(`查询额度失败: ${msg}`);
  }

  // 二次校验：code=0 但 data 为空或 totalAmount 缺失，也视为鉴权异常
  const data = response.data.data;
  if (!data || typeof data.totalAmount !== "number") {
    throw new QwenAuthError("千问 Cookie 可能已过期（额度接口返回异常）");
  }

  return data;
}

// ─── 通用轮询 ──────────────────────────────────────────────────────

interface PollResult {
  success: boolean;
  resultImages?: Array<{
    url: string;
    preview_url?: string;
    download_url?: string;
  }>;
  resultVideos?: Array<{
    url: string;
    cover?: { cdn_url: string };
  }>;
  error?: string;
}

/**
 * 轮询任务结果（视频和图片通用）
 * @param recordId 提交时的 chid
 * @param scene 场景标识（如 "hh_t2v", "qwen2_t2i" 等）
 * @param cookie cookie 字符串
 * @param maxWaitTime 最长等待时间（毫秒）
 */
async function pollForResult(
  recordId: string,
  scene: string,
  cookie: string,
  maxWaitTime: number = MAX_POLL_TIME
): Promise<PollResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    try {
      const params = await buildCommonParams(cookie);
      const pollUrl = buildApiUrl("/api/web/assets/v1/batch/get");

      const pollResponse = await axios.post(
        pollUrl,
        {
          items: [{ recordId, scene }],
          req_id: util.uuid(),
          ...buildSignFields(params),
        },
        {
          headers: { Cookie: cookie, ...DEFAULT_HEADERS },
          timeout: 15000,
        }
      );

      if (pollResponse.data.code !== 0) {
        logger.warn(`[Qwen] 轮询返回错误: ${pollResponse.data.msg}`);
        continue;
      }

      const list = pollResponse.data.data?.list;
      if (!list || list.length === 0) continue;

      const content = list[0]?.content;
      if (!content) continue;

      const extra = content.extra || {};

      // 检查图片结果
      const resultImages = extra.result_images;
      if (resultImages && resultImages.length > 0 && resultImages[0].url) {
        logger.success(`[Qwen] 检测到图片结果: ${resultImages.length} 张`);
        return { success: true, resultImages };
      }

      // 检查视频结果
      const resultVideos = extra.result_videos;
      if (resultVideos && resultVideos.length > 0 && resultVideos[0].url) {
        logger.success(`[Qwen] 检测到视频结果: ${resultVideos.length} 个`);
        return { success: true, resultVideos };
      }

      // 也检查 content 顶层是否有视频 URL（不同 API 版本可能结构不同）
      const contentVideoUrl = content.video_url || content.videoUrl || content.url;
      if (contentVideoUrl && typeof contentVideoUrl === 'string') {
        logger.success(`[Qwen] 从 content 顶层获取到视频 URL`);
        return { success: true, resultVideos: [{ url: contentVideoUrl }] };
      }

      // 检查是否失败
      const status = extra.status || content.status;
      if (status === "failed" || status === "error") {
        return {
          success: false,
          error: extra.error_msg || content.error_msg || "生成失败",
        };
      }

      // 还在处理中
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`[Qwen] 仍在生成中... (${elapsed}s)`);
    } catch (pollErr) {
      logger.warn(`[Qwen] 轮询请求异常: ${(pollErr as Error).message}`);
    }
  }

  return { success: false, error: "生成超时" };
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
  resolution?: string;
  model?: string;
  attachments?: Array<{ type: string; url?: string; materialId?: string; material_id?: string; objOrBg?: string }>;
}

const DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com/api/v1";

function resolveDashScopeApiKey(apiKey?: string): string {
  const incoming = String(apiKey || process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_TOKEN || "").trim();
  if (!incoming) {
    throw new Error("Wan 视频服务未配置可用凭证。请设置 DASHSCOPE_API_KEY 或 DASHSCOPE_API_TOKEN。");
  }
  return incoming.replace(/^Bearer\s+/i, "");
}

function buildDashScopeHeaders(apiKey: string): Record<string, string> {
  return {
    ...DEFAULT_HEADERS,
    Authorization: `Bearer ${apiKey}`,
  };
}

async function prepareQwenVideoAttachments(
  attachments: Array<{ type: string; url?: string; materialId?: string; material_id?: string; objOrBg?: string }>,
  cookie: string
): Promise<Array<{ type: string; materialId: string; objOrBg?: string }>> {
  const normalized: Array<{ type: string; materialId: string; objOrBg?: string }> = [];

  for (const attachment of attachments.slice(0, 2)) {
    const existingMaterialId = attachment.materialId || attachment.material_id;
    if (existingMaterialId) {
      normalized.push({
        type: attachment.type || "image",
        materialId: existingMaterialId,
        ...(attachment.objOrBg ? { objOrBg: attachment.objOrBg } : {}),
      });
      continue;
    }

    if (!attachment.url) continue;

    try {
      const materialId = await uploadImageToQwen(attachment.url, cookie, "QwenVideo");
      normalized.push({
        type: attachment.type || "image",
        materialId,
        ...(attachment.objOrBg ? { objOrBg: attachment.objOrBg } : {}),
      });
    } catch (err) {
      logger.warn(
        `[QwenVideo] 参考图上传失败: ${(err as Error).message}`
      );
    }
  }

  return normalized;
}

async function submitDashScopeVideo(
  model: string,
  prompt: string,
  ratio: string,
  duration: number,
  resolution: string,
  apiKey: string
): Promise<{ taskId?: string; error?: string }> {
  const submitUrl = `${DASHSCOPE_API_BASE}/services/aigc/video-generation/video-synthesis`;
  const body: Record<string, any> = {
    model,
    input: { prompt },
    parameters: {
      ratio,
      duration,
      size: resolution,
    },
  };

  const response = await axios.post(submitUrl, body, {
    headers: buildDashScopeHeaders(apiKey),
    timeout: 30000,
  });

  const taskId = response.data?.output?.task_id || response.data?.output?.taskId || response.data?.request_id;
  if (response.data?.code && response.data.code !== 200) {
    return { error: response.data.message || response.data.msg || "提交失败" };
  }
  if (!taskId) {
    return { error: "DashScope 未返回 task_id" };
  }
  return { taskId };
}

async function pollDashScopeVideoTask(
  taskId: string,
  apiKey: string,
  maxWaitTime: number = MAX_POLL_TIME
): Promise<{ success: boolean; videoUrl?: string; coverUrl?: string; error?: string }> {
  const start = Date.now();
  const statusUrl = `${DASHSCOPE_API_BASE}/tasks/${taskId}`;

  while (Date.now() - start < maxWaitTime) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    const response = await axios.get(statusUrl, {
      headers: buildDashScopeHeaders(apiKey),
      timeout: 15000,
    });

    const status = String(response.data?.output?.task_status || response.data?.status || "").toLowerCase();
    const output = response.data?.output || {};
    const videoUrl = output?.video_url || output?.videoUrl || output?.result_url;
    const coverUrl = output?.cover_url || output?.coverUrl;

    if (videoUrl && (status === "succeeded" || status === "succeed" || status === "completed" || !status)) {
      return { success: true, videoUrl, coverUrl };
    }
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      return { success: false, error: output?.message || response.data?.message || "生成失败" };
    }
    logger.info(`[Qwen] DashScope 视频仍在生成中... taskId=${taskId}, status=${status || "unknown"}`);
  }

  return { success: false, error: "生成超时" };
}

/**
 * 同步视频生成 —— 提交任务、轮询结果、返回视频 URL
 */
export async function createVideoCompletion(
  params: QwenVideoParams,
  credential: string,
  options?: { apiKey?: string; maxWaitTimeMs?: number }
): Promise<QwenVideoResult> {
  const { prompt, ratio = "16:9", duration = 10, resolution = "720P", attachments = [], model } = params;
  const maxWaitTimeMs = Number(options?.maxWaitTimeMs) > 0 ? Number(options?.maxWaitTimeMs) : VIDEO_POLL_TIME;
  const lowerModel = String(model || "").toLowerCase();
  const isDashScopeModel =
    lowerModel.startsWith("wan2.6") ||
    lowerModel.startsWith("wanx2.") ||
    lowerModel.startsWith("wanx");

  if (!isDashScopeModel) {
    // 检查额度
    let isCookieExpired = false;
    try {
      const credit = await getCredit(credential);
      if (credit.totalAmount <= 0) {
        // 真正额度为0，直接返回
        return {
          success: false,
          error: "千问视频额度已用完",
          creditRemaining: 0,
        };
      }
      logger.info(`[Qwen] 当前额度: ${credit.totalAmount}`);
    } catch (e) {
      if (e instanceof QwenAuthError) {
        // Cookie 过期，标记后继续尝试提交（API 可能仍然可用）
        isCookieExpired = true;
        logger.warn(`[Qwen] Cookie 鉴权异常: ${(e as Error).message}`);
      } else {
        logger.warn(`[Qwen] 查询额度失败，继续尝试: ${(e as Error).message}`);
      }
    }

    // 构建请求参数
    const common = await buildCommonParams(credential);
    const submitUrl = buildApiUrl("/api/web/ai/video/function");
    const normalizedAttachments = await prepareQwenVideoAttachments(attachments, credential);
    const hasImageAttachment = normalizedAttachments.some((item) => item?.type === "image" && item?.materialId);
    const scene = lowerModel.startsWith("wan2.7")
      ? (hasImageAttachment ? "wan27_first_frame_i2v" : "wan27_t2v")
      : "hh_t2v";
    const modelKey = lowerModel.startsWith("wan2.7") ? "wan27" : "happyhorse";

    const submitBody = {
      model: modelKey,
      rootModel: modelKey,
      prompt,
      originPrompt: prompt,
      scene,
      params: {
        size: ratio,
        resolution,
        duration,
        attachmentType: normalizedAttachments.length > 0 ? 1 : 0,
        attachments: normalizedAttachments,
      },
      genMode: "vid_gen",
      ...buildSignFields(common),
    };

    logger.info(
      `[Qwen] 提交视频任务: prompt="${prompt.substring(0, 30)}...", ratio=${ratio}, resolution=${resolution}, duration=${duration}s`
    );

    // 提交任务
    const submitResponse = await axios.post(submitUrl, submitBody, {
      headers: { Cookie: credential, ...DEFAULT_HEADERS },
      timeout: 30000,
    });

    if (submitResponse.data.code !== 0) {
      const submitMsg = submitResponse.data.msg || "提交失败";
      // 如果之前额度检查就发现 cookie 过期，明确提示
      if (isCookieExpired || submitResponse.data.code === 1013) {
        return {
          success: false,
          error: `千问 Cookie 已过期，请更新 QWEN_COOKIE。原始错误: ${submitMsg}`,
        };
      }
      return {
        success: false,
        error: `提交失败: ${submitMsg}`,
      };
    }

    logger.success(`[Qwen] 视频任务已提交，开始轮询结果...`);

    // 轮询结果 - 优先使用 API 返回的 recordId
    const recordId = submitResponse.data.data?.recordId || common.chid;
    const pollResult = await pollForResult(recordId, scene, credential, maxWaitTimeMs);

    if (!pollResult.success) {
      return { success: false, error: pollResult.error };
    }

    const video = pollResult.resultVideos?.[0];
    if (!video) {
      return { success: false, error: "未获取到视频结果" };
    }

    return {
      success: true,
      videoUrl: video.url,
      coverUrl: video.cover?.cdn_url,
    };
  }

  const apiKey = resolveDashScopeApiKey(options?.apiKey || credential);
  const dashModel = lowerModel || "wan2.6-t2v";

  logger.info(
    `[Qwen] 提交 DashScope 视频任务: model=${dashModel}, prompt="${prompt.substring(0, 30)}...", ratio=${ratio}, resolution=${resolution}, duration=${duration}s`
  );

  const submit = await submitDashScopeVideo(dashModel, prompt, ratio, duration, resolution, apiKey);
  if (!submit.taskId) {
    return { success: false, error: submit.error || "提交失败" };
  }

  const result = await pollDashScopeVideoTask(submit.taskId, apiKey, maxWaitTimeMs);
  if (!result.success || !result.videoUrl) {
    return { success: false, error: result.error || "未获取到视频结果" };
  }

  return {
    success: true,
    videoUrl: result.videoUrl,
    coverUrl: result.coverUrl,
  };
}

// ─── 图片结果接口 ─────────────────────────────────────────────────

export interface QwenImageResult {
  success: boolean;
  imageUrls?: string[];
  downloadUrls?: string[];
  error?: string;
}

// ─── 提交图片任务 ─────────────────────────────────────────────────

export interface QwenImageParams {
  prompt: string;
  modelKey: string;
  rootModel: string;
  scene: string;
  ratio?: string;
  num?: number;
  attachments?: Array<{ type: string; materialId: string; objOrBg?: string }>;
}

/**
 * 同步图片生成 —— 提交任务、轮询结果、返回图片 URL
 */
export async function createImageCompletion(
  params: QwenImageParams,
  cookie: string
): Promise<QwenImageResult> {
  const {
    prompt,
    modelKey,
    rootModel,
    scene,
    ratio = "1:1",
    num = 1,
    attachments = [],
  } = params;

  const normalizedAttachments = attachments
    .map((attachment) => ({
      type: attachment.type,
      materialId: attachment.materialId || (attachment as any).material_id,
      ...(attachment.objOrBg ? { objOrBg: attachment.objOrBg } : {}),
    }))
    .filter((attachment) => Boolean(attachment.materialId));

  const common = await buildCommonParams(cookie);
  const submitUrl = buildApiUrl("/api/web/ai/image/function");

  const submitBody: Record<string, any> = {
    model: modelKey,
    rootModel,
    prompt,
    originPrompt: prompt,
    scene,
    params: {
      size: ratio,
      num,
    },
    ...buildSignFields(common),
  };

  // 图生图：附加参考图
  if (normalizedAttachments.length > 0) {
    submitBody.params.attachments = normalizedAttachments;
  }

  logger.info(
    `[Qwen] 提交图片任务: model=${modelKey}, scene=${scene}, ratio=${ratio}, num=${num}, attachments=${JSON.stringify(normalizedAttachments)}`
  );
  logger.info(
    `[Qwen] 请求体: ${JSON.stringify(submitBody).substring(0, 1000)}`
  );

  const submitResponse = await axios.post(submitUrl, submitBody, {
    headers: { Cookie: cookie, ...DEFAULT_HEADERS },
    timeout: 30000,
  });

  logger.info(
    `[Qwen] 图片任务响应: code=${submitResponse.data.code}, msg=${submitResponse.data.msg}, cookie前50=${cookie.substring(0, 50)}`
  );

  if (submitResponse.data.code !== 0) {
    return {
      success: false,
      error: `提交失败: ${submitResponse.data.msg}`,
    };
  }

  const recordId = submitResponse.data.data?.recordId || common.chid;
  logger.success(`[Qwen] 图片任务已提交 (recordId=${recordId})，开始轮询...`);

  // 轮询结果
  const pollResult = await pollForResult(recordId, scene, cookie, IMAGE_POLL_TIME);

  if (!pollResult.success) {
    return { success: false, error: pollResult.error };
  }

  const images = pollResult.resultImages || [];
  if (images.length === 0) {
    return { success: false, error: "未获取到图片结果" };
  }

  return {
    success: true,
    imageUrls: images.map((img) => img.url),
    downloadUrls: images.map((img) => img.download_url || img.url),
  };
}
