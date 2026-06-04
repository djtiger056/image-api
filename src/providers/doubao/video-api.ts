/**
 * 豆包视频生成 API 底层模块
 *
 * 封装豆包 Web 端的 /samantha/chat/completion SSE 流式接口，
 * 实现文生视频的提交、流式解析与会话清理。
 *
 * 关键差异（对比图片生成）：
 *   - content_type: 2020（视频） vs 2009（图片）
 *   - action_bar_skill_id: 17（视频） vs 3（图片）
 *   - 响应中视频 content_type: 2076（视频结果） vs 2074（图片结果）
 *   - 每日额度: 10次（每次5秒视频消耗1额度）
 */

import crypto from "crypto";
import { PassThrough } from "stream";

import _ from "lodash";
import axios, { AxiosRequestConfig } from "axios";
import { createParser } from "eventsource-parser";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { removeConversation, tokenSplit } from "@/providers/doubao/api.ts";
import { uploadImageToDoubao } from "@/providers/doubao/upload.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const MODEL_NAME = "doubao-video";
const DEFAULT_ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "3.20.0";
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;
export const DOUBAO_VIDEO_FIXED_DURATION = 10;
const VIDEO_RESULT_POLL_INTERVAL = 10000;
const VIDEO_RESULT_POLL_TIMEOUT = 600000; // 10分钟，高峰期视频生成较慢
const VIDEO_PROBE_BYTES = 8191;

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
  Referer: "https://www.doubao.com/chat/create-video",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// ─── 视频模型映射 ──────────────────────────────────────────────────

export interface DoubaoVideoModelMapping {
  /** 内部模型名（豆包视频不需要传 model 参数，但用于标识） */
  model: string;
  /** 模型描述 */
  description: string;
  /** action_bar_skill_id */
  skillId: number;
}

export const DOUBAO_VIDEO_MODEL_MAP: Record<string, DoubaoVideoModelMapping> = {
  "doubao-seedance-2.0-fast": {
    model: "seed2fast",
    description: "豆包 Seedance 2.0 Fast 视频生成模型（每日10次免费额度）",
    skillId: 17,
  },
  "doubao-seed2fast": {
    model: "seed2fast",
    description: "豆包 Seedance 2.0 Fast 视频生成模型（别名）",
    skillId: 17,
  },
};

export const DEFAULT_DOUBAO_VIDEO_MODEL = "doubao-seedance-2.0-fast";

export const DOUBAO_VIDEO_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
];

export function isDoubaoVideoModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return (
    lower.startsWith("doubao-seedance-") ||
    lower.startsWith("doubao-seed2fast") ||
    lower.startsWith("doubao-video-")
  );
}

export function resolveDoubaoVideoModel(model?: string): DoubaoVideoModelMapping {
  if (!model) return DOUBAO_VIDEO_MODEL_MAP[DEFAULT_DOUBAO_VIDEO_MODEL];
  const lower = model.toLowerCase();
  if (DOUBAO_VIDEO_MODEL_MAP[lower]) return DOUBAO_VIDEO_MODEL_MAP[lower];
  // 兼容不带 doubao- 前缀
  const withPrefix = lower.startsWith("doubao-") ? lower : `doubao-${lower}`;
  if (DOUBAO_VIDEO_MODEL_MAP[withPrefix]) return DOUBAO_VIDEO_MODEL_MAP[withPrefix];
  return DOUBAO_VIDEO_MODEL_MAP[DEFAULT_DOUBAO_VIDEO_MODEL];
}

export function normalizeVideoRatio(ratio?: string): string {
  if (!ratio) return "16:9";
  const normalized = ratio.replace(/\s/g, "");
  if (DOUBAO_VIDEO_RATIOS.includes(normalized)) return normalized;
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

export function getDoubaoVideoModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  // 去重（doubao-seed2fast 是别名）
  const seen = new Set<string>();
  return Object.entries(DOUBAO_VIDEO_MODEL_MAP)
    .filter(([_, m]) => {
      if (seen.has(m.model)) return false;
      seen.add(m.model);
      return true;
    })
    .map(([id, mapping]) => ({
      id,
      object: "model",
      owned_by: "images-api",
      description: mapping.description,
    }));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaExhaustedMessage(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;

  return [
    "生成次数已经达到上限",
    "今日免费额度已用完",
    "今天免费额度已用完",
    "今日额度已用完",
    "今日次数已用完",
    "今日次数用完",
    "免费额度已用完",
    "额度已用完",
    "已无剩余额度",
    "没有剩余额度",
    "剩余额度为0",
    "剩余额度为0",
    "已达到上限",
  ].some((phrase) => normalized.includes(phrase));
}

function isVideoPendingMessage(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;

  return [
    "开始生成",
    "正在生成",
    "生成中",
    "请稍候",
    "请耐心等待",
    "稍后为你呈现",
    "视频生成完成后",
    "视频生成好后",
    "生成好后",
    "已为你开始生成",
    "已开始生成视频",
    "预计等待",
    "我会及时通知你",
    "及时通知你",
    "视频生成额度",
    "消耗",
  ].some((phrase) => normalized.includes(phrase));
}

/** 判断是否为豆包的拒绝/错误消息（非额度类） */
function isVideoRejectionMessage(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;

  return [
    "暂不支持",
    "不支持上传",
    "不支持该",
    "无法生成",
    "无法完成",
    "请换张",
    "请更换",
    "试试换",
    "换张参考图",
    "文生视频",
    "肖像保护",
    "内容安全",
    "审核不通过",
    "违规",
    "敏感",
  ].some((phrase) => normalized.includes(phrase));
}

function isNonRetryableVideoError(err: any): boolean {
  const responseData = err?.response?.data;
  const responseDataText =
    typeof responseData === "string"
      ? responseData
      : responseData && typeof responseData === "object"
        ? JSON.stringify(responseData)
        : "";
  const text = [
    err?.message,
    err?.errmsg,
    err?.code,
    err?.errcode,
    responseDataText,
  ]
    .filter((item) => item !== undefined && item !== null)
    .join(" ");

  return (
    text.includes("710022004") ||
    /rate\s*limited/i.test(text) ||
    isQuotaExhaustedMessage(text)
  );
}

function hasImageUrlExtension(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)(?:[?#].*)?$/i.test(String(value || ""));
}

function looksLikeVideoUrl(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!/^https?:\/\//i.test(normalized)) return false;
  if (hasImageUrlExtension(normalized)) return false;

  if (/\.(mp4|mov|webm|m4v|m3u8)(?:[?#].*)?$/i.test(normalized)) return true;

  return /(?:video|videos|capcut|vlabvod|seedance|bytevid|byteimg|douyin|vod|snssdk|bytedance|bdurl|toutiao|bytecdn|ibytedtos|imagex|tos-hl-x|tos-.*\.volces|byte-video|v\d+-[a-z]+)\b/i.test(normalized);
}

function collectVideoUrls(
  node: any,
  urls: string[],
  seenUrls: Set<string>,
  visited: WeakSet<object>,
  depth = 0,
  videoContext = false
) {
  if (node == null || depth > 8) return;

  if (typeof node === "string") {
    const matches = node.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const match of matches) {
      const candidate = match.trim();
      if (!candidate) continue;
      // 在任何上下文中都提取 URL，不仅仅在 videoContext 中
      // 图片 URL 除外（它们不是视频）
      if (hasImageUrlExtension(candidate)) continue;
      if (seenUrls.has(candidate)) continue;
      seenUrls.add(candidate);
      urls.push(candidate);
    }
    return;
  }

  if (typeof node !== "object") return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      collectVideoUrls(item, urls, seenUrls, visited, depth + 1, videoContext);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const lowerKey = String(key || "").toLowerCase();
    const nextVideoContext =
      videoContext ||
      lowerKey.includes("video") ||
      lowerKey.includes("download") ||
      lowerKey.includes("play") ||
      lowerKey.includes("origin") ||
      lowerKey.includes("media") ||
      lowerKey.includes("creation") ||
      lowerKey.includes("result");

    collectVideoUrls(value, urls, seenUrls, visited, depth + 1, nextVideoContext);
  }
}

// ─── 底层请求 ──────────────────────────────────────────────────────

async function doubaoVideoRequest(
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
      real_aid: DEFAULT_ASSISTANT_ID,
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

// ─── 视频结果接口 ─────────────────────────────────────────────────

export interface DoubaoVideoResult {
  /** 视频 URL */
  videoUrl: string;
  /** 所有解析到的视频 URL */
  videoUrls?: string[];
  /** 已解析但服务端探测不可播放的候选 URL */
  candidateVideoUrls?: string[];
  /** 会话 ID（用于清理） */
  conversationId: string;
  /** 文本描述（机器人回复） */
  textContent: string;
  /** 是否达到每日限额 */
  quotaExhausted: boolean;
  /** 是否命中过“已开始生成/请稍候”这类中间态提示 */
  generationPending?: boolean;
  /** SSE 已结束，但仍停留在“后台生成中”中间态 */
  streamClosedWhilePending?: boolean;
}

export interface DoubaoVideoPollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

function normalizePollOptions(options: DoubaoVideoPollOptions = {}): Required<DoubaoVideoPollOptions> {
  const timeoutMs = Number(options.timeoutMs);
  const intervalMs = Number(options.intervalMs);

  return {
    timeoutMs: Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.round(timeoutMs), 30000), 900000)
      : VIDEO_RESULT_POLL_TIMEOUT,
    intervalMs: Number.isFinite(intervalMs)
      ? Math.min(Math.max(Math.round(intervalMs), 3000), 60000)
      : VIDEO_RESULT_POLL_INTERVAL,
  };
}

function extractVideoUrlsFromPayload(
  payload: any,
  emittedVideoKeys?: Set<string>
): string[] {
  if (!payload) return [];

  const urls: string[] = [];
  const seenUrls = new Set<string>();

  const pushUrl = (candidate: any, requireVideoLike = false) => {
    if (typeof candidate !== "string") return false;
    const normalized = candidate.trim();
    if (!normalized || !/^https?:\/\//i.test(normalized)) return false;
    if (hasImageUrlExtension(normalized)) return false;
    if (requireVideoLike && !looksLikeVideoUrl(normalized)) return false;
    if (seenUrls.has(normalized)) return false;
    seenUrls.add(normalized);
    urls.push(normalized);
    return true;
  };

  const pushCreationVideos = (creations: any[]) => {
    for (const creation of creations) {
      const video = creation?.video || {};
      const key = video?.key as string | undefined;
      const candidates = [
        video?.download_url,
        video?.play_url,
        video?.url,
        video?.video_ori?.url,
        video?.video_preview?.url,
      ].filter((item): item is string => typeof item === "string" && !!item.trim());
      if (candidates.length === 0) continue;
      if (key && emittedVideoKeys && emittedVideoKeys.has(key)) continue;

      let emittedForCreation = false;
      for (const candidate of candidates) {
        emittedForCreation = pushUrl(candidate) || emittedForCreation;
      }
      if (key && emittedVideoKeys && emittedForCreation) {
        emittedVideoKeys.add(key);
      }
    }
  };

  const visitCreationBlocks = (node: any, visited: WeakSet<object>, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visitCreationBlocks(item, visited, depth + 1);
      return;
    }

    if (Array.isArray(node.creations)) {
      pushCreationVideos(node.creations);
    }
    if (node.video && typeof node.video === "object") {
      pushCreationVideos([node]);
    }

    for (const [key, value] of Object.entries(node)) {
      const lowerKey = String(key || "").toLowerCase();
      if (
        lowerKey.includes("creation") ||
        lowerKey === "content" ||
        lowerKey === "data" ||
        lowerKey === "result" ||
        lowerKey === "message" ||
        lowerKey === "video"
      ) {
        visitCreationBlocks(value, visited, depth + 1);
      }
    }
  };

  visitCreationBlocks(payload, new WeakSet<object>());

  const directCandidates = [
    payload.video_url,
    payload.videoUrl,
    payload.result_url,
    payload.play_url,
    payload.download_url,
    payload.data?.video_url,
    payload.data?.videoUrl,
    payload.data?.result_url,
    payload.data?.play_url,
    payload.data?.download_url,
    payload.result?.video_url,
    payload.result?.videoUrl,
    payload.result?.result_url,
    payload.result?.play_url,
    payload.result?.download_url,
  ];

  for (const candidate of directCandidates) {
    pushUrl(candidate, true);
  }

  if (urls.length === 0) {
    collectVideoUrls(payload, urls, seenUrls, new WeakSet<object>());
  }

  return urls.filter(Boolean);
}

function extractVideoUrlsFromMessageList(messages: any[]): string[] {
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  const emittedVideoKeys = new Set<string>();

  const pushUrls = (payload: any) => {
    for (const url of extractVideoUrlsFromPayload(payload, emittedVideoKeys)) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      urls.push(url);
    }
  };

  const pushVideoResultUrls = (payload: any) => {
    for (const url of extractVideoUrlsFromVideoResult(payload, seenUrls)) {
      urls.push(url);
    }
  };

  for (const message of messages || []) {
    const content = message?.content;
    if (typeof content !== "string" || !content.trim()) continue;

    const parsed = _.attempt(() => JSON.parse(content));
    if (_.isError(parsed)) {
      // 非 JSON 内容，尝试直接从文本中提取 URL
      const textUrls = content.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const url of textUrls) {
        const trimmed = url.trim();
        if (trimmed && !hasImageUrlExtension(trimmed) && !seenUrls.has(trimmed)) {
          seenUrls.add(trimmed);
          urls.push(trimmed);
        }
      }
      continue;
    }

    pushUrls(parsed);
    // 增强：也用视频结果专用提取器
    pushVideoResultUrls(parsed);

    if (Array.isArray(parsed)) {
      for (const block of parsed) {
        pushUrls(block?.content?.creation_block);
        pushUrls(block?.creation_block);
        pushVideoResultUrls(block?.content?.creation_block);
        pushVideoResultUrls(block?.creation_block);
      }
    }
  }

  if (urls.length === 0) {
    // 没有提取到 URL，dump 所有消息的原始内容供调试
    for (let i = 0; i < (messages || []).length; i++) {
      const msg = messages[i];
      const rawContent = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content);
      logger.warn(
        `[DoubaoVideo DEBUG] 未提取到URL，消息[${i}] content_type=${msg?.content_type}, raw=${(rawContent || "").substring(0, 500)}`
      );
    }
  } else {
    logger.info(
      `[DoubaoVideo] 从消息列表提取到 ${urls.length} 个视频 URL: ${urls.map(u => u.substring(0, 120)).join(", ")}`
    );
  }

  return urls;
}

function getMessageListFromChainResponse(response: any): any[] {
  const body = response?.downlink_body?.pull_singe_chain_downlink_body;
  return Array.isArray(body?.messages) ? body.messages : [];
}

function isMp4LikeBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

function isWebmLikeBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function isVideoContentType(contentType: string): boolean {
  return /^video\//i.test(contentType) || /application\/(?:octet-stream|mp4|x-mpegurl|vnd\.apple\.mpegurl)/i.test(contentType);
}

export function isValidVideoBuffer(buffer: Buffer, contentType = ""): boolean {
  const ct = contentType.toLowerCase();
  // 明确的图片类型不是视频
  if (/^image\//i.test(ct)) return false;
  return isVideoContentType(ct) || isMp4LikeBuffer(buffer) || isWebmLikeBuffer(buffer);
}

function buildDoubaoVideoFetchHeaders(sessionId?: string, url?: string): Record<string, string> {
  // 根据目标域名动态设置 Referer：抖音 CDN 需要 douyin.com Referer
  let referer = "https://www.doubao.com/";
  if (url) {
    try {
      const host = new URL(url).hostname;
      if (/\bdouyin(com)?\.com$/.test(host) || /\bdouyinvod\.com$/.test(host)) {
        referer = "https://www.douyin.com/";
      }
    } catch { /* ignore parse errors */ }
  }
  return {
    Referer: referer,
    "User-Agent": FAKE_HEADERS["User-Agent"],
    Accept: "video/*,*/*;q=0.8",
    ...(sessionId ? { Cookie: generateCookie(sessionId) } : {}),
  };
}

// ─── 增强视频 URL 提取 ────────────────────────────────────────────

/**
 * 从 content_type=2076 的视频结果 payload 中提取 URL
 * 豆包视频结果格式与图片(2074)不同，可能不使用 creations 结构
 */
function extractVideoUrlsFromVideoResult(payload: any, seenUrls: Set<string>): string[] {
  if (!payload || typeof payload !== "object") return [];

  const urls: string[] = [];

  // 直接字段
  const directFields = [
    "video_url", "videoUrl", "download_url", "play_url", "result_url",
    "url", "src", "video_src",
  ];
  for (const field of directFields) {
    const val = payload[field];
    if (typeof val === "string" && val.trim() && /^https?:\/\//i.test(val) && !seenUrls.has(val)) {
      seenUrls.add(val);
      urls.push(val);
    }
  }

  // 嵌套在 data/result/video 中
  for (const wrapper of ["data", "result", "video", "video_info", "video_info_list"]) {
    const nested = payload[wrapper];
    if (!nested) continue;

    if (typeof nested === "string" && /^https?:\/\//i.test(nested) && !seenUrls.has(nested)) {
      seenUrls.add(nested);
      urls.push(nested);
      continue;
    }

    if (typeof nested === "object") {
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string" && /^https?:\/\//i.test(item) && !seenUrls.has(item)) {
            seenUrls.add(item);
            urls.push(item);
          } else if (item && typeof item === "object") {
            for (const field of directFields) {
              const val = item[field];
              if (typeof val === "string" && val.trim() && /^https?:\/\//i.test(val) && !seenUrls.has(val)) {
                seenUrls.add(val);
                urls.push(val);
              }
            }
          }
        }
      } else {
        for (const field of directFields) {
          const val = nested[field];
          if (typeof val === "string" && val.trim() && /^https?:\/\//i.test(val) && !seenUrls.has(val)) {
            seenUrls.add(val);
            urls.push(val);
          }
        }
      }
    }
  }

  return urls;
}

export async function fetchDoubaoVideoBuffer(url: string, sessionId?: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxRedirects: 5,
    headers: buildDoubaoVideoFetchHeaders(sessionId, url),
    validateStatus: () => true,
  });
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  const buffer = Buffer.from(response.data || []);

  if (response.status < 200 || response.status >= 400 || !isValidVideoBuffer(buffer, contentType)) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[豆包视频下载失败]: status=${response.status}, contentType=${contentType || "unknown"}, bytes=${buffer.length}`
    );
  }

  return { buffer, contentType };
}

export async function fetchDoubaoVideoStream(
  url: string,
  sessionId?: string,
  range?: string
): Promise<{ stream: any; status: number; headers: Record<string, any>; contentType: string }> {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5,
    headers: {
      ...buildDoubaoVideoFetchHeaders(sessionId, url),
      ...(range ? { Range: range } : {}),
    },
    validateStatus: () => true,
  });

  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  if (response.status < 200 || response.status >= 400) {
    if (typeof response.data?.destroy === "function") response.data.destroy();
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[豆包视频代理失败]: status=${response.status}, contentType=${contentType || "unknown"}`
    );
  }

  return {
    stream: response.data,
    status: response.status,
    headers: response.headers || {},
    contentType: contentType || "video/mp4",
  };
}

/** 探测视频 URL: 'playable'=确认可播放, 'not-video'=确认非视频, 'unknown'=探测失败 */
async function probeVideoUrl(url: string, sessionId?: string): Promise<'playable' | 'not-video' | 'unknown'> {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        ...buildDoubaoVideoFetchHeaders(sessionId, url),
        Range: `bytes=0-${VIDEO_PROBE_BYTES}`,
      },
      validateStatus: () => true,
    });

    const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
    const buffer = Buffer.from(response.data || []);
    const ok =
      response.status >= 200 &&
      response.status < 400 &&
      isValidVideoBuffer(buffer, contentType);

    if (!ok) {
      logger.warn(
        `[DoubaoVideo] 候选 URL 不是有效视频: status=${response.status}, contentType=${contentType || "unknown"}, bytes=${buffer.length}, url=${url.substring(0, 180)}`
      );
      // 如果服务器正常响应但内容不是视频，说明该 URL 明确不是视频（如图片）
      if (response.status >= 200 && response.status < 400) return 'not-video';
      return 'unknown';
    }
    return 'playable';
  } catch (err: any) {
    logger.warn(
      `[DoubaoVideo] 候选 URL 视频探测失败: ${err?.message || err}, url=${url.substring(0, 180)}`
    );
    return 'unknown';
  }
}

async function filterPlayableVideoUrls(urls: string[], sessionId?: string): Promise<string[]> {
  const playable: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const probeResult = await probeVideoUrl(url, sessionId);
    if (probeResult === 'playable') {
      playable.push(url);
    } else if (probeResult === 'unknown') {
      unknown.push(url);
    }
    // 'not-video' URLs are silently discarded
  }

  // 探测只用于排序，不用于否定结果。豆包/字节系视频 URL 常见
  // Range/Referer/Cookie 差异导致服务端探测 403，但浏览器或本地代理仍可播放。
  return playable.length > 0 ? [...playable, ...unknown] : unknown;
}

function parseEventData(rawResult: any): any {
  if (!rawResult || typeof rawResult.event_data !== "string") return null;
  const parsed = _.attempt(() => JSON.parse(rawResult.event_data));
  return _.isError(parsed) ? null : parsed;
}

function getConversationIdFromPayload(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  return (
    payload.conversation_id ||
    payload.conversationId ||
    payload.data?.conversation_id ||
    payload.data?.conversationId ||
    payload.message?.conversation_id ||
    payload.message?.conversationId ||
    ""
  );
}

async function fetchVideoConversationMessages(
  conversationId: string,
  sessionId: string
): Promise<any[]> {
  const response = await doubaoVideoRequest(
    "POST",
    "/im/chain/single",
    sessionId,
    {
      data: {
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: conversationId,
            anchor_index: 9007199254740991,
            conversation_type: 3,
            direction: 1,
            limit: 20,
            ext: {},
            filter: { index_list: [] },
            evaluate_ab_params: "",
            evaluate_common_params: "",
          },
        },
        sequence_id: util.uuid(),
        channel: 2,
        version: "1",
      },
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json; encoding=utf-8",
        Referer: `https://www.doubao.com/chat/${conversationId}`,
        "Agw-Js-Conv": "str",
        "agw-js-conv": "str",
      },
      timeout: 30000,
    }
  );

  if (response?.status_code && response.status_code !== 0) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[豆包视频会话查询失败]: ${response.status_code}-${response.status_desc || "unknown"}`
    );
  }

  const messages = getMessageListFromChainResponse(response);
  logger.info(
    `[DoubaoVideo] 会话消息查询: conversation=${conversationId}, messages=${messages.length}`
  );
  // 调试：dump 每条消息的 content_type 和 content 前 200 字符
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const contentPreview = typeof msg.content === "string" ? msg.content.substring(0, 200) : JSON.stringify(msg.content || "").substring(0, 200);
    logger.info(
      `[DoubaoVideo DEBUG] 消息[${i}]: content_type=${msg.content_type}, content=${contentPreview}`
    );
  }
  return messages;
}

export async function getVideoConversationResult(
  conversationId: string,
  sessionId: string
): Promise<DoubaoVideoResult> {
  const messages = await fetchVideoConversationMessages(conversationId, sessionId);
  const candidateUrls = extractVideoUrlsFromMessageList(messages);
  const urls = await filterPlayableVideoUrls(candidateUrls, sessionId);

  return {
    videoUrl: urls[0] || "",
    videoUrls: urls,
    candidateVideoUrls: candidateUrls,
    conversationId,
    textContent: "",
    quotaExhausted: false,
    generationPending: urls.length === 0,
    streamClosedWhilePending: urls.length === 0,
  };
}

async function pollVideoConversationResult(
  sessionId: string,
  pendingResult: DoubaoVideoResult,
  options: DoubaoVideoPollOptions = {}
): Promise<DoubaoVideoResult> {
  const conversationId = pendingResult.conversationId;
  if (!conversationId) return pendingResult;

  const pollOptions = normalizePollOptions(options);
  const startedAt = util.timestamp();
  let attempt = 0;
  const allCandidateUrls: string[] = [];

  logger.info(
    `[DoubaoVideo] 开始会话只读轮询: conversation=${conversationId}, timeout=${pollOptions.timeoutMs}ms, interval=${pollOptions.intervalMs}ms`
  );

  while (util.timestamp() - startedAt < pollOptions.timeoutMs) {
    attempt += 1;

    try {
      const messages = await fetchVideoConversationMessages(conversationId, sessionId);
      const candidateUrls = extractVideoUrlsFromMessageList(messages);
      // 累积所有候选 URL
      for (const u of candidateUrls) {
        if (!allCandidateUrls.includes(u)) allCandidateUrls.push(u);
      }
      const urls = await filterPlayableVideoUrls(candidateUrls, sessionId);

      if (urls.length > 0) {
        logger.success(
          `[DoubaoVideo] 会话只读查询获取到视频结果: conversation=${conversationId}, urls=${urls.length}, attempts=${attempt}`
        );
        return {
          ...pendingResult,
          videoUrl: urls[0],
          videoUrls: urls,
          candidateVideoUrls: candidateUrls,
          generationPending: false,
          streamClosedWhilePending: false,
        };
      }

      logger.info(
        `[DoubaoVideo] 会话只读查询暂未返回有效视频 URL: conversation=${conversationId}, attempt=${attempt}, messages=${messages.length}, candidates=${candidateUrls.length}`
      );
    } catch (err: any) {
      if (isNonRetryableVideoError(err)) throw err;
      logger.warn(
        `[DoubaoVideo] 会话只读查询失败: conversation=${conversationId}, attempt=${attempt}, error=${err?.message || err}`
      );
    }

    await sleep(pollOptions.intervalMs);
  }

  logger.warn(
    `[DoubaoVideo] 会话只读查询超时，conversation=${conversationId}, 累积候选URL=${allCandidateUrls.length}`
  );
  // 超时回退：如果累积了候选 URL，尝试返回它们（即使 probe 失败）
  if (allCandidateUrls.length > 0) {
    logger.warn(
      `[DoubaoVideo] 超时回退：返回 ${allCandidateUrls.length} 个未验证的候选 URL`
    );
    return {
      ...pendingResult,
      videoUrl: allCandidateUrls[0],
      videoUrls: allCandidateUrls,
      candidateVideoUrls: allCandidateUrls,
      generationPending: false,
      streamClosedWhilePending: false,
    };
  }
  return pendingResult;
}

// ─── SSE 流解析（同步模式） ────────────────────────────────────────

/**
 * 接收完整 SSE 流，返回同步结果（含视频 URL）
 */
export function receiveVideoStream(stream: any): Promise<DoubaoVideoResult> {
  let temp = Buffer.from("");
  let videoUrl = "";
  const collectedVideoUrls: string[] = [];
  const seenVideoUrls = new Set<string>();
  let textContent = "";
  let conversationId = "";
  let quotaExhausted = false;
  let generationPending = false;
  let streamClosedWhilePending = false;
  const emittedVideoKeys = new Set<string>();

  return new Promise((resolve, reject) => {
    let isEnd = false;
    let dataHandler: ((buffer: Buffer) => void) | null = null;

    const cleanup = () => {
      if (dataHandler) stream.off("data", dataHandler);
      stream.removeAllListeners("error");
      stream.removeAllListeners("close");
    };

    const finalize = (result?: Partial<DoubaoVideoResult>) => {
      if (isEnd) return;
      isEnd = true;
      cleanup();
      if (typeof stream.destroy === "function" && !stream.destroyed) {
        stream.destroy();
      }
      const finalUrls = Array.from(
        new Set<string>([
          ...collectedVideoUrls,
          ...(Array.isArray(result?.videoUrls) ? result!.videoUrls! : []),
          result?.videoUrl || "",
          videoUrl,
        ].filter((item): item is string => typeof item === "string" && !!item))
      );
      resolve({
        videoUrl: result?.videoUrl ?? videoUrl ?? finalUrls[0] ?? "",
        videoUrls: finalUrls,
        candidateVideoUrls: Array.from(
          new Set<string>([
            ...collectedVideoUrls,
            ...(Array.isArray(result?.candidateVideoUrls) ? result!.candidateVideoUrls! : []),
          ].filter((item): item is string => typeof item === "string" && !!item))
        ),
        conversationId: result?.conversationId ?? conversationId,
        textContent: (result?.textContent ?? textContent).trim(),
        quotaExhausted: result?.quotaExhausted ?? quotaExhausted,
        generationPending: result?.generationPending ?? generationPending,
        streamClosedWhilePending:
          result?.streamClosedWhilePending ?? streamClosedWhilePending,
      });
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
        if (_.isError(rawResult))
          throw new Error(`Stream response invalid: ${event.data}`);

        if (rawResult.code)
          throw new APIException(
            EX.API_REQUEST_FAILED,
            `[豆包视频请求失败]: ${rawResult.code}-${rawResult.message}`
          );

        const eventPayload = parseEventData(rawResult);
        const eventConversationId = getConversationIdFromPayload(eventPayload);
        if (!conversationId && eventConversationId) {
          conversationId = eventConversationId;
        }

        if (eventPayload && typeof eventPayload === "object") {
          const eventUrls = extractVideoUrlsFromPayload(eventPayload, emittedVideoKeys);
          if (eventUrls.length > 0) {
            for (const url of eventUrls) {
              if (!seenVideoUrls.has(url)) {
                seenVideoUrls.add(url);
                collectedVideoUrls.push(url);
              }
            }
            if (!videoUrl) {
              videoUrl = eventUrls[0];
              logger.info(
                `[DoubaoVideo] 从 event_type=${rawResult.event_type} 提取到视频 URL: ${videoUrl}`
              );
              finalize({ videoUrl, videoUrls: eventUrls });
              return;
            }
          } else if (rawResult.event_type !== 2001 && rawResult.event_type !== 2002 && rawResult.event_type !== 2003) {
            logger.info(
              `[DoubaoVideo DEBUG] event_type=${rawResult.event_type} 未提取到视频 URL, payload=${JSON.stringify(eventPayload).substring(0, 800)}`
            );
          }
        }

        // event_type 2003 = 当前 SSE 消息流结束。豆包视频常先返回“已提交，
        // 预计等待”的文字，此时视频仍在后台生成；不要继续发追问消息。
        if (rawResult.event_type === 2003) {
          if (videoUrl || quotaExhausted || !generationPending) {
            finalize();
          } else {
            streamClosedWhilePending = true;
            logger.info("[DoubaoVideo DEBUG] 收到 event_type=2003，视频仍处于后台生成中，本次 SSE 未返回视频 URL");
            finalize({
              generationPending: true,
              streamClosedWhilePending: true,
            });
          }
          return;
        }

        // event_type 2002 = 会话创建
        if (rawResult.event_type === 2002) {
          return;
        }

        // event_type 2005 = 错误
        if (rawResult.event_type === 2005) {
          const ed = _.attempt(() => JSON.parse(rawResult.event_data));
          if (!_.isError(ed) && ed.code) {
            throw new APIException(
              EX.API_REQUEST_FAILED,
              `[豆包视频请求失败]: ${ed.code}-${ed.message}`
            );
          }
          return;
        }

        // event_type 2001 = 数据事件
        if (rawResult.event_type !== 2001) {
          return;
        }

        const result = eventPayload;
        if (!result || typeof result !== "object")
          throw new Error(`Stream response invalid: ${rawResult.event_data}`);

        if (!conversationId && result.conversation_id) {
          conversationId = result.conversation_id;
        }

        const message = result.message;
        if (!message || !message.content) {
          logger.info(`[DoubaoVideo DEBUG] 消息为空或无 content, is_finish=${result.is_finish}`);
          // 豆包视频常见中间态：先返回“已开始生成”的回复，随后才继续产出视频事件。
          // 这里不能因为 is_finish 就提前结束，除非已经拿到了终态结果。
          if (result.is_finish && (videoUrl || quotaExhausted)) {
            finalize();
          }
          return;
        }

        const ctype = message.content_type;
        logger.info(`[DoubaoVideo DEBUG] 收到消息: content_type=${ctype}, is_finish=${result.is_finish}, content长度=${String(message.content).length}`);

        // 只识别明确的“额度已用完”语义，避免把“剩余 2 额度”等正常回复误判掉
        const parsedContent = _.attempt(() => JSON.parse(message.content));
        if (!_.isError(parsedContent) && typeof parsedContent === "object") {
          const text =
            typeof parsedContent.text === "string"
              ? parsedContent.text
              : typeof parsedContent.message === "string"
                ? parsedContent.message
                : typeof parsedContent.content === "string"
                  ? parsedContent.content
                  : "";
          if (isQuotaExhaustedMessage(text)) {
            quotaExhausted = true;
          }
        }

        // content_type 2001 = 文本流
        if (ctype === 2001) {
          let text = "";
          if (!_.isError(parsedContent)) {
            if (typeof parsedContent === "string") text = parsedContent;
            else if (typeof parsedContent.text === "string") text = parsedContent.text;
          } else if (typeof message.content === "string") {
            text = message.content;
          }
          if (text) {
            textContent += text;

            if (isVideoPendingMessage(text) || isVideoPendingMessage(textContent)) {
              generationPending = true;
            }
            // 检测豆包拒绝消息（肖像保护、内容安全等）
            if (isVideoRejectionMessage(text) || isVideoRejectionMessage(textContent)) {
              logger.warn(`[DoubaoVideo] 检测到豆包拒绝消息: ${textContent.substring(0, 200)}`);
              finalize({
                videoUrl: "",
                videoUrls: [],
                textContent: textContent.trim(),
                quotaExhausted: false,
                generationPending: false,
                streamClosedWhilePending: false,
              });
              return;
            }
          }
        }

        const payload = _.isError(parsedContent) ? null : parsedContent;
        if (payload && typeof payload === "object") {
          logger.info(`[DoubaoVideo DEBUG] 视频候选 payload: ${JSON.stringify(payload).substring(0, 500)}`);
          // 通用提取（覆盖 creations 结构）
          const urls = extractVideoUrlsFromPayload(payload, emittedVideoKeys);
          // 针对 content_type=2076 的增强提取（非 creations 结构的视频结果）
          const videoResultUrls = (ctype === 2076 || ctype === 2075 || ctype === 2077)
            ? extractVideoUrlsFromVideoResult(payload, seenVideoUrls)
            : [];
          const allUrls = [...urls, ...videoResultUrls.filter(u => !urls.includes(u))];
          logger.info(`[DoubaoVideo DEBUG] 提取到 ${allUrls.length} 个视频 URL (通用:${urls.length}, 视频结果:${videoResultUrls.length})`);
          for (const url of allUrls) {
            if (!seenVideoUrls.has(url)) {
              seenVideoUrls.add(url);
              collectedVideoUrls.push(url);
            }
          }

          if (allUrls.length > 0 && !videoUrl) {
            videoUrl = allUrls[0];
            logger.info(`[DoubaoVideo] 视频 URL 获取到: ${videoUrl}`);
            logger.info(`[DoubaoVideo] 已获取视频结果，提前结束等待`);
            finalize({ videoUrl, videoUrls: allUrls });
            return;
          }
        } else if (ctype === 2076 || ctype === 2075 || ctype === 2077) {
          logger.warn(`[DoubaoVideo DEBUG] 视频结果 content 无法解析为 JSON: ${String(message.content).substring(0, 300)}`);
        }

        // 豆包视频的文本回复可能先结束，但视频结果事件还会继续推送。
        // 只有拿到视频 URL、额度耗尽等终态，才允许在 is_finish 时结束。
        if (result.is_finish) {
          // 如果完成但还没找到视频URL，检查tts_content中是否有有用信息
          if (!videoUrl && message.tts_content) {
            textContent = message.tts_content;
            if (isQuotaExhaustedMessage(message.tts_content)) {
              quotaExhausted = true;
            }
          }

          // 检查最终的 content 中是否有视频 URL
          if (!videoUrl && !_.isError(parsedContent)) {
            const urls = extractVideoUrlsFromPayload(parsedContent, emittedVideoKeys);
            // 增强：针对视频结果 content_type 的额外提取
            const videoResultUrls = (ctype === 2076 || ctype === 2075 || ctype === 2077)
              ? extractVideoUrlsFromVideoResult(parsedContent, seenVideoUrls)
              : [];
            const allFinishUrls = [...urls, ...videoResultUrls.filter(u => !urls.includes(u))];
            for (const url of allFinishUrls) {
              if (!seenVideoUrls.has(url)) {
                seenVideoUrls.add(url);
                collectedVideoUrls.push(url);
              }
            }
            if (allFinishUrls.length > 0) videoUrl = allFinishUrls[0];
          }

          if (videoUrl || quotaExhausted) {
            finalize();
            return;
          }

          logger.info("[DoubaoVideo DEBUG] 收到 is_finish 但尚无视频结果，继续等待后续事件");
        }
      } catch (err) {
        logger.error(err);
        fail(err);
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

    stream.once("error", (err: Error) => {
      fail(err);
    });
    stream.once("close", () => {
      if (
        !isEnd &&
        (generationPending || isVideoPendingMessage(textContent)) &&
        !videoUrl &&
        !quotaExhausted
      ) {
        streamClosedWhilePending = true;
        logger.warn(
          "[DoubaoVideo] SSE 连接已关闭，但视频仍处于后台生成中，未在本次连接中拿到结果"
        );
      }
      finalize();
    });
  });
}

// ─── 视频生成（同步） ─────────────────────────────────────────────

export interface DoubaoVideoParams {
  prompt: string;
  ratio?: string;
  duration?: number;
  skillId?: number;
  referenceImages?: Array<Buffer | string>;
  pollOptions?: DoubaoVideoPollOptions;
}

async function buildVideoAttachments(
  referenceImages: Array<Buffer | string>,
  sessionId: string
): Promise<any[]> {
  const attachments: any[] = [];

  for (const image of referenceImages.slice(0, 2)) {
    try {
      const storeUri = await uploadImageToDoubao(image, sessionId);
      attachments.push({
        type: "image",
        key: storeUri,
        extra: { refer_types: "overall" },
        identifier: util.uuid(),
      });
      logger.info(`[DoubaoVideo] 参考图上传成功: ${storeUri}`);
    } catch (err) {
      logger.error(`[DoubaoVideo] 参考图上传失败: ${(err as Error).message}`);
      throw err;
    }
  }

  return attachments;
}

function buildVideoContent({
  prompt,
  ratio,
  duration,
}: {
  prompt: string;
  ratio: string;
  duration: number;
}): string {
  return JSON.stringify({
    text: prompt,
    ratio,
    duration,
    template_type: "placeholder",
    use_creation: false,
  });
}

/**
 * 同步视频生成 —— 提交请求、等待完成、返回结果
 */
export async function createVideoCompletion(
  params: DoubaoVideoParams,
  sessionId: string,
  retryCount = 0
): Promise<DoubaoVideoResult> {
  try {
    const {
      prompt,
      ratio = "16:9",
      duration = DOUBAO_VIDEO_FIXED_DURATION,
      skillId = 17,
      referenceImages = [],
      pollOptions,
    } = params;

    const attachments = await buildVideoAttachments(referenceImages, sessionId);

    logger.info(
      `[DoubaoVideo] 视频生成请求: prompt=${prompt}, ratio=${ratio}, duration=${duration}s, refImages=${attachments.length}`
    );

    const contentJson = buildVideoContent({ prompt, ratio, duration });

    const response = await doubaoVideoRequest(
      "post",
      "/samantha/chat/completion",
      sessionId,
      {
        data: {
          messages: [
            {
              content: contentJson,
              content_type: 2020,
              attachments,
            },
          ],
          completion_option: {
            is_regen: false,
            with_suggest: false,
            need_create_conversation: true,
            launch_stage: 1,
            is_replace: false,
            is_delete: false,
            is_ai_playground: false,
            message_from: 0,
            action_bar_skill_id: skillId,
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
          Referer: "https://www.doubao.com/chat/create-video",
          "Agw-Js-Conv": "str, str",
        },
        timeout: 660000, // 11分钟，略大于轮询超时
        responseType: "stream",
      }
    );

    if (
      response.headers["content-type"]?.indexOf("text/event-stream") === -1
    ) {
      response.data.on("data", (buffer: Buffer) =>
        logger.error(buffer.toString())
      );
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `Stream response Content-Type invalid: ${response.headers["content-type"]}`
      );
    }

    const streamStartTime = util.timestamp();
    const streamResult = await receiveVideoStream(response.data);
    logger.success(
      `[DoubaoVideo] 视频生成流传输完成 ${util.timestamp() - streamStartTime}ms`
    );

    const result =
      streamResult.streamClosedWhilePending && streamResult.conversationId && !streamResult.videoUrl
        ? await pollVideoConversationResult(sessionId, streamResult, pollOptions)
        : streamResult;

    if (result.videoUrl) {
      const candidateVideoUrls = result.videoUrls?.length ? result.videoUrls : [result.videoUrl];
      const videoUrls = await filterPlayableVideoUrls(candidateVideoUrls, sessionId);
      result.videoUrl = videoUrls[0] || "";
      result.videoUrls = videoUrls;
      result.candidateVideoUrls = Array.from(
        new Set([...(result.candidateVideoUrls || []), ...candidateVideoUrls])
      );
      if (!result.videoUrl && result.conversationId) {
        result.generationPending = true;
        result.streamClosedWhilePending = true;
      }
    } else if (result.videoUrls?.length) {
      result.candidateVideoUrls = Array.from(
        new Set([...(result.candidateVideoUrls || []), ...result.videoUrls])
      );
      result.videoUrls = [];
    }

    // 异步清理会话
    if (result.conversationId && (result.videoUrl || result.quotaExhausted || !result.generationPending)) {
      removeConversation(result.conversationId, sessionId).catch((err) =>
        console.error("[DoubaoVideo] 移除视频生成会话失败：", err)
      );
    } else if (result.conversationId) {
      logger.warn(
        `[DoubaoVideo] 会话 ${result.conversationId} 返回中间态提示且尚无视频结果，暂不主动删除会话`
      );
    }

    return result;
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT && !isNonRetryableVideoError(err)) {
      logger.error(`[DoubaoVideo] 视频生成流响应错误: ${err.stack}`);
      logger.warn(`[DoubaoVideo] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createVideoCompletion(params, sessionId, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 流式视频生成 —— 返回 OpenAI 兼容的 SSE 流
 */
export async function createVideoCompletionStream(
  params: DoubaoVideoParams,
  sessionId: string,
  retryCount = 0
): Promise<PassThrough> {
  try {
    const {
      prompt,
      ratio = "16:9",
      duration = DOUBAO_VIDEO_FIXED_DURATION,
      skillId = 17,
      referenceImages = [],
    } = params;

    const attachments = await buildVideoAttachments(referenceImages, sessionId);

    logger.info(
      `[DoubaoVideo] 流式视频生成请求: prompt=${prompt}, ratio=${ratio}, duration=${duration}s, refImages=${attachments.length}`
    );

    const contentJson = buildVideoContent({ prompt, ratio, duration });

    const response = await doubaoVideoRequest(
      "post",
      "/samantha/chat/completion",
      sessionId,
      {
        data: {
          messages: [
            {
              content: contentJson,
              content_type: 2020,
              attachments,
            },
          ],
          completion_option: {
            is_regen: false,
            with_suggest: false,
            need_create_conversation: true,
            launch_stage: 1,
            is_replace: false,
            is_delete: false,
            is_ai_playground: false,
            message_from: 0,
            action_bar_skill_id: skillId,
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
          Referer: "https://www.doubao.com/chat/create-video",
          "Agw-Js-Conv": "str, str",
        },
        timeout: 660000, // 11分钟，略大于轮询超时
        responseType: "stream",
      }
    );

    if (
      response.headers["content-type"]?.indexOf("text/event-stream") === -1
    ) {
      logger.error(
        `[DoubaoVideo] 无效的响应Content-Type: ${response.headers["content-type"]}`
      );
      const transStream = new PassThrough();
      transStream.end(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "video.completion.chunk",
          choices: [
            { index: 0, delta: { content: "服务暂时不可用" }, finish_reason: "stop" },
          ],
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return transStream;
    }

    const streamStartTime = util.timestamp();
    return createVideoTransStream(response.data, (convId: string) => {
      logger.success(
        `[DoubaoVideo] 流式视频生成传输完成 ${util.timestamp() - streamStartTime}ms`
      );
      removeConversation(convId, sessionId).catch((err) =>
        console.error(err)
      );
    });
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT && !isNonRetryableVideoError(err)) {
      logger.error(`[DoubaoVideo] 流式视频生成响应错误: ${err.stack}`);
      logger.warn(`[DoubaoVideo] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createVideoCompletionStream(params, sessionId, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 创建转换流 —— 将豆包 SSE 流转换为 OpenAI 兼容格式
 */
function createVideoTransStream(
  stream: any,
  endCallback?: (convId: string) => void
): PassThrough {
  let convId = "";
  let temp = Buffer.from("");
  const created = util.unixTimestamp();
  let videoNoticeSent = false;
  let generationPending = false;
  let finished = false;
  const emittedVideoKeys = new Set<string>();

  const transStream = new PassThrough();

  const finishStream = () => {
    if (finished || transStream.closed) return;
    finished = true;
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model: MODEL_NAME,
        object: "video.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
        created,
      })}\n\n`
    );
    if (!transStream.closed) transStream.end("data: [DONE]\n\n");
    endCallback?.(convId);
  };

  // 写入初始 chunk
  if (!transStream.closed) {
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model: MODEL_NAME,
        object: "video.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        ],
        created,
      })}\n\n`
    );
  }

  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;

      const rawResult = _.attempt(() => JSON.parse(event.data));
      if (_.isError(rawResult))
        throw new Error(`Stream response invalid: ${event.data}`);

      if (rawResult.code)
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `[豆包视频请求失败]: ${rawResult.code}-${rawResult.message}`
        );

      const eventPayload = parseEventData(rawResult);
      const eventConversationId = getConversationIdFromPayload(eventPayload);
      if (!convId && eventConversationId) convId = eventConversationId;

      if (eventPayload && typeof eventPayload === "object") {
        const eventUrls = extractVideoUrlsFromPayload(eventPayload, emittedVideoKeys);
        if (eventUrls.length > 0) {
          if (!videoNoticeSent) {
            transStream.write(
              `data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "video.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: `\n[视频生成完成]\n` }, finish_reason: null }],
                created,
              })}\n\n`
            );
            videoNoticeSent = true;
          }
          for (const url of eventUrls) {
            transStream.write(
              `data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "video.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: `${url}\n` }, finish_reason: null }],
                created,
              })}\n\n`
            );
          }
          finishStream();
          return;
        }
      }

      // 当前消息流结束。若只是视频后台生成提示，结束本次连接并返回 pending 提示。
      if (rawResult.event_type === 2003) {
        if (generationPending && !videoNoticeSent && !transStream.closed) {
          transStream.write(
            `data: ${JSON.stringify({
              id: convId,
              model: MODEL_NAME,
              object: "video.completion.chunk",
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  content: "\n[豆包已接受视频生成任务，但本次 SSE 未返回视频 URL]\n",
                },
                finish_reason: null,
              }],
              created,
            })}\n\n`
          );
        }
        finishStream();
        return;
      }

      // 会话创建
      if (rawResult.event_type === 2002) {
        return;
      }

      if (rawResult.event_type !== 2001) return;

      const result = eventPayload;
      if (!result || typeof result !== "object")
        throw new Error(`Stream response invalid: ${rawResult.event_data}`);

      if (!convId && result.conversation_id) convId = result.conversation_id;

      const message = result.message;
      if (!message || !message.content) {
        if (result.is_finish && (!generationPending || videoNoticeSent)) {
          finishStream();
        }
        return;
      }

      const content = _.attempt(() => JSON.parse(message.content));
      const ctype = message.content_type;

      // 视频结果事件：优先从对象里提取任何可播放 URL，不再只依赖固定 content_type
      if (!_.isError(content) && content && typeof content === "object") {
        const payload = content as any;
        const urls = extractVideoUrlsFromPayload(payload, emittedVideoKeys);
        // 增强：针对视频结果 content_type 的额外提取
        const videoResultUrls = (ctype === 2076 || ctype === 2075 || ctype === 2077)
          ? extractVideoUrlsFromVideoResult(payload, new Set(urls))
          : [];
        const allStreamUrls = [...urls, ...videoResultUrls.filter(u => !urls.includes(u))];

        if (allStreamUrls.length > 0) {
          if (!videoNoticeSent) {
            transStream.write(
              `data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "video.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: `\n[视频生成完成]\n` }, finish_reason: null }],
                created,
              })}\n\n`
            );
            videoNoticeSent = true;
          }
          for (const url of allStreamUrls) {
            transStream.write(
              `data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "video.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: `${url}\n` }, finish_reason: null }],
                created,
            })}\n\n`
            );
          }
        }
      }

      // 文本内容 (content_type = 2001)
      let text = "";
      if (!_.isError(content)) {
        if (typeof content === "string") text = content;
        else if (typeof (content as any).text === "string") text = (content as any).text;
      } else if (typeof message.content === "string") {
        text = message.content;
      }

      if (text && ctype === 2001) {
        const normalizedText = String(text).replace(/\s+/g, "");
        if (isVideoPendingMessage(normalizedText)) {
          generationPending = true;
        }

        // 过滤掉空文本
        const cleanText = text.replace(/\n{3,}/g, "\n\n");
        if (cleanText) {
          transStream.write(
            `data: ${JSON.stringify({
              id: convId,
              model: MODEL_NAME,
              object: "video.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: cleanText }, finish_reason: null }],
              created,
            })}\n\n`
          );
        }
      }

      if (result.is_finish && (!generationPending || videoNoticeSent)) {
        finishStream();
      }
    } catch (err) {
      logger.error(err);
      if (!transStream.closed) transStream.end("\n\n");
    }
  });

  stream.on("data", (buffer: Buffer) => {
    if (buffer.toString().indexOf("�") !== -1) {
      temp = Buffer.concat([temp, buffer]);
      return;
    }
    if (temp.length > 0) {
      buffer = Buffer.concat([temp, buffer]);
      temp = Buffer.from("");
    }
    parser.feed(buffer.toString());
  });

  stream.once("error", () => {
    if (finished || transStream.closed) return;
    finished = true;
    if (!transStream.closed) transStream.end("data: [DONE]\n\n");
  });
  stream.once("close", () => {
    if (finished || transStream.closed) return;
    if (generationPending && !videoNoticeSent) {
      transStream.write(
        `data: ${JSON.stringify({
          id: convId,
          model: MODEL_NAME,
          object: "video.completion.chunk",
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: "\n[豆包已接受任务，但当前 SSE 连接已结束，未在本次连接中返回视频结果]\n",
            },
            finish_reason: null,
          }],
          created,
        })}\n\n`
      );
    }
    finished = true;
    if (!transStream.closed) transStream.end("data: [DONE]\n\n");
  });

  return transStream;
}
