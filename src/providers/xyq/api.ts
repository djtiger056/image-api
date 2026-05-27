/**
 * 小云雀 (xyq.jianying.com) API 底层调用模块
 *
 * 走网页端真实链路：
 * - /api/biz/v1/common/get_odin_user_info
 * - /api/web/v1/common/upload_file
 * - /api/biz/v1/agent/submit_run
 * - /api/biz/v1/agent/get_thread
 */

import _ from "lodash";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { uploadImageToXyq, XyqUploadResult } from "@/providers/xyq/upload.ts";

const MODEL_NAME = "xyq";
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;
const POLL_INTERVAL = 8000;
const POLL_TIMEOUT = 300000;
const VIDEO_POLL_TIMEOUT = 75 * 60 * 1000;
const XYQ_BASE = "https://xyq.jianying.com";

const FAKE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-control": "no-cache",
  Origin: XYQ_BASE,
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: `${XYQ_BASE}/home?tab_name=home`,
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  appvr: "5.8.0",
  "entrance-from": "web",
  appid: "795647",
};

function extractSessionId(sessionId: string): string {
  const raw = String(sessionId || "").trim();
  if (!raw) return "";
  const match = raw.match(/(?:^|;\s*)sessionid=([^;,\s]+)/i);
  if (match?.[1]) return match[1];
  return raw.replace(/^Bearer\s+/i, "");
}

function buildCookie(sessionId: string): string {
  const value = extractSessionId(sessionId);
  return value ? `sessionid=${value}; sessionid_ss=${value}; sessionid_ss_pippitcn_web=${value}` : "";
}

function buildAuthHeaders(sessionId: string): Record<string, string> {
  const cookie = buildCookie(sessionId);
  return {
    ...FAKE_HEADERS,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export interface XyqUserInfo {
  consumer_uid: string | number;
  workspace_id: string | number;
  app_id: string | number;
  space_id?: string | number;
}

async function xyqRequest(
  method: string,
  uri: string,
  sessionId: string,
  options: AxiosRequestConfig = {}
): Promise<any> {
  const response = await axios.request({
    method,
    url: `${XYQ_BASE}${uri}`,
    headers: {
      ...buildAuthHeaders(sessionId),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    timeout: 30000,
    validateStatus: () => true,
    ..._.omit(options, "headers"),
  });

  return checkResult(response);
}

function checkResult(result: AxiosResponse): any {
  if (!result.data) return null;
  const { ret, errmsg, data } = result.data;
  if (ret === "0" || ret === 0) return data;
  if (result.data.data && !result.data.ret) return result.data.data;
  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[云雀请求失败]: ret=${ret}, errmsg=${errmsg}`
  );
}

async function getOdinUserInfo(sessionId: string): Promise<XyqUserInfo> {
  const data = await xyqRequest("POST", "/api/biz/v1/common/get_odin_user_info", sessionId);
  const userInfo = data?.user_info || data || {};
  const consumerUid = userInfo.consumer_uid ?? userInfo.uid ?? userInfo.user_id;
  // workspace_id 必须从 get_user_workspace 接口获取，不能用 consumer_uid 代替
  let workspaceId: string | number | undefined = userInfo.workspace_id ?? userInfo.workspaceId ?? userInfo.workspace?.id;
  if (!workspaceId) {
    try {
      const wsData = await xyqRequest("POST", "/api/web/v1/workspace/get_user_workspace", sessionId, { data: {} });
      workspaceId = wsData?.workspace_id ?? wsData?.id;
    } catch (e: any) {
      logger.warn(`[XYQ] 获取workspace_id失败: ${e.message}`);
    }
  }
  if (!workspaceId) workspaceId = consumerUid;
  const appId = userInfo.app_id ?? userInfo.appId ?? "795647";
  const spaceId = userInfo.space_id ?? userInfo.spaceId;

  if (_.isNil(consumerUid)) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[云雀] 获取用户信息失败: ${JSON.stringify(data)}`
    );
  }

  return {
    consumer_uid: consumerUid,
    workspace_id: workspaceId,
    app_id: appId,
    ...(spaceId ? { space_id: spaceId } : {}),
  };
}

export async function getTokenLiveStatus(sessionId: string): Promise<boolean> {
  try {
    await getOdinUserInfo(sessionId);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("未登录") || msg.includes("unauthorized") || msg.includes("401") || msg.includes("check login error") || msg.includes("1015")) {
      return false;
    }
    return true;
  }
}

export function tokenSplit(authorization: string): string[] {
  return String(authorization || "")
    .replace(/^Bearer\s+/i, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface XyqDailyQuotaItem {
  scene: string;
  agent_name: string;
  tpl_id: string | null;
  used: number;
  total: number;
  remaining: number;
}

/**
 * 查询小云雀每日配额
 * 使用 GET /api/web/v1/usage/get_web_daily_quota 接口
 */
export async function getCredit(sessionId: string): Promise<XyqDailyQuotaItem[]> {
  const userInfo = await getOdinUserInfo(sessionId);
  const consumerUid = String(userInfo.consumer_uid);
  const data = await xyqRequest("GET", `/api/web/v1/usage/get_web_daily_quota?consumer_uid=${consumerUid}`, sessionId);
  const items: XyqDailyQuotaItem[] = data?.items || [];
  logger.info(`[XYQ] 积分信息: ${items.map(i => `${i.scene}: ${i.remaining}/${i.total}`).join(", ")}`);
  return items;
}

export interface XyqSubmitRunResult {
  thread_id: string;
  run_id: string;
  web_thread_link: string;
}

interface XyqImageSettings {
  ratio?: string;
  preferred_generation_strategy?: string;
  resolution?: string;
  image_model?: string;
  video_model?: string;
  duration?: number;
  mode?: "image" | "video";
}

/** 将 xyq-seedream-5.0 格式转为 seedream_5.0 格式 */
function toXyqModelSlug(genModel?: string): string | undefined {
  if (!genModel) return undefined;
  return genModel.replace(/^xyq-/, "").replace(/-/g, "_").toLowerCase();
}

function buildSubmitMessage(
  prompt: string,
  userInfo: XyqUserInfo,
  threadId?: string,
  runId?: string,
  imageItems: XyqUploadResult[] = [],
  settings?: XyqImageSettings
): any {
  const content: Array<any> = [];
  const mode = settings?.mode === "video" ? "video" : "image";

  // 网页端在对应生成模式下会给 prompt 加明确前缀
  const effectivePrompt = prompt.trim();
  if (effectivePrompt) {
    const prefix = mode === "video" ? "生成视频" : "生成图片";
    const prefixed = effectivePrompt.startsWith(prefix) ? effectivePrompt : `${prefix}：${effectivePrompt}`;
    content.push({
      type: "data",
      sub_type: "biz/x_data_prompt_text",
      data: JSON.stringify({ content: prefixed }),
    });
  }

  for (const item of imageItems) {
    content.push({
      type: "data",
      sub_type: "biz/x_data_upload_image",
      data: JSON.stringify({
        image: {
          url: item.download_url,
          assetId: item.asset_id,
          metaData: {
            width: item.width || 0,
            height: item.height || 0,
          },
        },
      }),
    });
  }

  // image_settings/video_settings: ratio, preferred_generation_strategy (模型), resolution/duration
  if (settings && (settings.ratio || settings.preferred_generation_strategy || settings.resolution || settings.image_model || settings.video_model || settings.duration)) {
    const imageSettings: Record<string, string> = {};
    if (settings.ratio) imageSettings.ratio = settings.ratio;
    // 模型放在 preferred_generation_strategy 里（格式：seedream_5.0）
    const modelSlug = mode === "video" ? settings.video_model : settings.image_model;
    if (modelSlug) {
      imageSettings.preferred_generation_strategy = modelSlug;
    } else if (settings.preferred_generation_strategy && settings.preferred_generation_strategy !== "auto") {
      imageSettings.preferred_generation_strategy = settings.preferred_generation_strategy;
    }
    if (settings.resolution) imageSettings.resolution = settings.resolution.toUpperCase();
    if (settings.duration) imageSettings.duration = String(settings.duration);

    content.push({
      type: "data",
      sub_type: mode === "video" ? "biz/video_settings" : "biz/image_settings",
      data: JSON.stringify(imageSettings),
    });
  }

  // general_agent_settings: 指定 image_model/video_model
  if (settings?.image_model || settings?.video_model) {
    content.push({
      type: "data",
      sub_type: "biz/general_agent_settings",
      data: JSON.stringify(mode === "video"
        ? { video_model: settings.video_model }
        : { image_model: settings.image_model }
      ),
    });
  }

  return {
    message: {
      message_id: "",
      role: "user",
      thread_id: threadId || util.uuid(false),
      run_id: runId || util.uuid(false),
      created_at: Date.now(),
      content,
    },
    user_info: {
      consumer_uid: userInfo.consumer_uid,
      workspace_id: userInfo.workspace_id,
      app_id: userInfo.app_id,
      ...(userInfo.space_id ? { space_id: userInfo.space_id } : {}),
    },
    agent_name: "pippit_nest_agent",
    entrance_from: "web",
    run_extra: JSON.stringify({
      client_extra: {
        edit_type: "integrated_agent",
        position: "home",
        entrance_from: "home",
        tab_name: "other",
      },
    }),
  };
}

export async function submitRun(
  message: string,
  sessionId: string,
  threadId?: string,
  imageItems: XyqUploadResult[] = [],
  settings?: XyqImageSettings
): Promise<XyqSubmitRunResult> {
  const userInfo = await getOdinUserInfo(sessionId);
  const body = buildSubmitMessage(message, userInfo, threadId, undefined, imageItems, settings);
  const data = await xyqRequest("POST", "/api/biz/v1/agent/submit_run", sessionId, { data: body });

  return {
    thread_id: body.message.thread_id || "",
    run_id: body.message.run_id || "",
    web_thread_link: data?.web_thread_link || "",
  };
}

function normalizeThreadResponse(data: any): any {
  if (!data) return null;
  return data.thread || data.data?.thread || data;
}

export async function getThread(
  threadId: string,
  sessionId: string,
  runId?: string,
): Promise<any> {
  const body: Record<string, any> = {
    thread_id: threadId,
    scopes: ["run_list.entry_list.limit(100).offset(0)"],
    limit: 100,
    is_need_fail_reason_detail: true,
  };

  const data = await xyqRequest("POST", "/api/biz/v1/agent/get_thread", sessionId, { data: body });
  return normalizeThreadResponse(data);
}

export interface XyqImageResult {
  imageUrls: string[];
  videoUrls: string[];
  textContent: string;
  state: number;
  failReason?: string;
}

function extractResultsFromThread(thread: any): XyqImageResult {
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  let textContent = "";
  let state = 0;
  let failReason: string | undefined;

  const collectMediaUrls = (node: any, depth = 0, visited = new WeakSet<object>()) => {
    if (node == null || depth > 10) return;
    if (typeof node === "string") {
      const matches = node.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
      for (const raw of matches) {
        const url = raw.replace(/[),\]}]+$/g, "");
        if (/\.(png|jpg|jpeg|webp|gif)(?:[?#].*)?$/i.test(url)) imageUrls.push(url);
        if (/\.(mp4|mov|avi|webm|m4v|m3u8)(?:[?#].*)?$/i.test(url) || /(?:video|vod|vlabvod|bytevid|tos-cn|snssdk|pstatp)/i.test(url)) videoUrls.push(url);
      }
      return;
    }
    if (typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) collectMediaUrls(item, depth + 1, visited);
      return;
    }
    for (const value of Object.values(node)) collectMediaUrls(value, depth + 1, visited);
  };

  const run = thread?.run_list?.[0] || thread?.run || thread?.runs?.[0];
  if (run) {
    state = run.state || run.status || 0;
    failReason = run.fail_reason || run.fail_reason_detail || run.error_message;

    const entryList = run.entry_list || run.message_list || [];
    for (const entry of entryList) {
      const message = entry?.message || entry;
      const artifact = entry?.artifact;

      // 只提取文本内容，跳过 message 里的图片（那是用户上传的原图）
      if (message?.content) {
        for (const content of message.content) {
          if (content?.type === "text" && typeof content.data === "string") {
            textContent += content.data;
          }
        }
      }

      // 只从 artifact 中提取生成的图片和视频
      if (artifact?.content) {
        for (const content of artifact.content) {
          if (content?.type === "image_url" && content?.image_url?.url) {
            imageUrls.push(content.image_url.url);
          }
          if (content?.type === "video_url" && content?.video_url?.url) {
            videoUrls.push(content.video_url.url);
          }
          if (content?.type === "data" && (content?.sub_type === "biz/x_data_image" || content?.sub_type === "biz/x_data_upload_image")) {
            const parsed = _.attempt(() => JSON.parse(content.data));
            if (!_.isError(parsed) && parsed?.image?.url) {
              imageUrls.push(parsed.image.url);
            }
          }
          if (content?.type === "data" && typeof content.data === "string") {
            const parsed = _.attempt(() => JSON.parse(content.data));
            if (!_.isError(parsed)) collectMediaUrls(parsed);
          }
          if (content?.url) {
            const url = content.url;
            if (/\.(png|jpg|jpeg|webp|gif)/i.test(url)) imageUrls.push(url);
            if (/\.(mp4|mov|avi|webm)/i.test(url)) videoUrls.push(url);
          }
          collectMediaUrls(content);
        }
      }
    }
  }

  return {
    imageUrls: [...new Set(imageUrls)],
    videoUrls: [...new Set(videoUrls)],
    textContent,
    state,
    ...(failReason ? { failReason } : {}),
  };
}

export interface XyqImageParams {
  prompt: string;
  ratio?: string;
  style?: string;
  genModel?: string;
  referenceImage?: Buffer | string;
  referenceImages?: Array<Buffer | string>;
  duration?: number;
}

async function pollForResult(
  threadId: string,
  sessionId: string,
  runId?: string,
  options: { timeoutMs?: number; mode?: "image" | "video" } = {}
): Promise<XyqImageResult> {
  const startTime = Date.now();
  let emptyRunListCount = 0;
  const mode = options.mode === "video" ? "video" : "image";
  const timeoutMs = _.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : mode === "video" ? VIDEO_POLL_TIMEOUT : POLL_TIMEOUT;
  const label = mode === "video" ? "云雀视频" : "云雀生图";

  while (Date.now() - startTime < timeoutMs) {
    const thread = await getThread(threadId, sessionId, runId);
    const result = extractResultsFromThread(thread);
    const run = thread?.run_list?.[0] || thread?.run || thread?.runs?.[0];
    const state = result.state || run?.state || 0;

    if (!run) {
      emptyRunListCount++;
      logger.warn(`[XYQ] get_thread 返回空 run_list (第${emptyRunListCount}次)，thread_id=${threadId}。原始 thread keys: ${JSON.stringify(Object.keys(thread || {}))}`);
      // 视频任务排队很慢，给平台更长时间把 run 写入线程。
      const maxEmptyRunListCount = mode === "video" ? 30 : 3;
      if (emptyRunListCount >= maxEmptyRunListCount) {
        throw new APIException(
          EX.API_REQUEST_FAILED,
          `[${label}异常] get_thread 连续返回空 run_list (${emptyRunListCount}次)，thread_id=${threadId}。可能原因：submit_run 未真正提交成功，或 sessionid 无效。`
        );
      }
    } else {
      emptyRunListCount = 0;
    }

    if (state === 3 || state === "completed") {
      return result;
    }
    if (state === 4 || state === "failed") {
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `[${label}失败]: ${result.failReason || "未知失败原因"}`
      );
    }
    if (state === 5 || state === "cancelled") {
      throw new APIException(EX.API_REQUEST_FAILED, `[${label}已被取消]`);
    }

    logger.info(`[XYQ] ${mode === "video" ? "视频" : "图片"}任务进行中 (state=${state})，${POLL_INTERVAL / 1000}秒后继续查询...`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[${label}超时] 等待超过 ${Math.round(timeoutMs / 1000)} 秒`
  );
}

export async function createImageCompletion(
  params: XyqImageParams,
  sessionId: string,
  retryCount = 0
): Promise<{ imageUrls: string[]; textContent: string; threadId: string }> {
  try {
    const { prompt, ratio = "1:1", style, genModel, referenceImage } = params;
    const modelSlug = toXyqModelSlug(genModel);
    const settings: XyqImageSettings = {
      ratio,
      preferred_generation_strategy: style && style !== "智能" ? style : undefined,
      resolution: "2k",
      image_model: modelSlug,
    };

    const imageItems: XyqUploadResult[] = [];
    const uploadSources = params.referenceImages && params.referenceImages.length > 0
      ? params.referenceImages
      : referenceImage
        ? [referenceImage]
        : [];

    for (const source of uploadSources) {
      imageItems.push(await uploadImageToXyq(source, sessionId));
    }

    logger.info(
      `[XYQ] 图片生成请求: prompt=${prompt}, ratio=${ratio}, style=${style}, model=${genModel}, refImage=${imageItems.length > 0}`
    );

    const submitResult = await submitRun(prompt, sessionId, undefined, imageItems, settings);
    if (!submitResult.thread_id) {
      throw new APIException(EX.API_REQUEST_FAILED, "[云雀] 未返回 thread_id");
    }

    const result = await pollForResult(submitResult.thread_id, sessionId, submitResult.run_id, { mode: "image" });
    if (result.imageUrls.length === 0) {
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `[云雀] 生图未返回任何图片。${result.textContent || ""}`
      );
    }

    return {
      imageUrls: result.imageUrls,
      textContent: result.textContent,
      threadId: submitResult.thread_id,
    };
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`[XYQ] 图片生成失败: ${err.stack || err.message}`);
      logger.warn(`[XYQ] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createImageCompletion(params, sessionId, retryCount + 1);
    }
    throw err;
  }
}

export async function createVideoCompletion(
  params: XyqImageParams,
  sessionId: string,
  options: { maxWaitTimeMs?: number } = {},
  retryCount = 0
): Promise<{ videoUrls: string[]; textContent: string; threadId: string }> {
  try {
    const { prompt, ratio = "16:9", genModel, duration = 5 } = params;
    const modelSlug = toXyqModelSlug(genModel);
    const settings: XyqImageSettings = {
      ratio,
      duration,
      video_model: modelSlug,
      preferred_generation_strategy: modelSlug,
      mode: "video",
    };

    const imageItems: XyqUploadResult[] = [];
    const uploadSources = params.referenceImages && params.referenceImages.length > 0
      ? params.referenceImages
      : params.referenceImage
        ? [params.referenceImage]
        : [];

    for (const source of uploadSources) {
      imageItems.push(await uploadImageToXyq(source, sessionId));
    }

    logger.info(
      `[XYQ] 视频生成请求: prompt=${prompt}, ratio=${ratio}, duration=${duration}, model=${genModel}, refImage=${imageItems.length}`
    );

    const submitResult = await submitRun(prompt, sessionId, undefined, imageItems, settings);
    if (!submitResult.thread_id) {
      throw new APIException(EX.API_REQUEST_FAILED, "[云雀] 未返回 thread_id");
    }

    const result = await pollForResult(submitResult.thread_id, sessionId, submitResult.run_id, {
      mode: "video",
      timeoutMs: options.maxWaitTimeMs,
    });
    if (result.videoUrls.length === 0) {
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `[云雀] 视频生成未返回任何视频。${result.textContent || ""}`
      );
    }

    return {
      videoUrls: result.videoUrls,
      textContent: result.textContent,
      threadId: submitResult.thread_id,
    };
  } catch (err: any) {
    const isTimeout = String(err?.message || "").includes("云雀视频超时");
    if (!isTimeout && retryCount < MAX_RETRY_COUNT) {
      logger.error(`[XYQ] 视频生成失败: ${err.stack || err.message}`);
      logger.warn(`[XYQ] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createVideoCompletion(params, sessionId, options, retryCount + 1);
    }
    throw err;
  }
}

export async function createImageCompletionStream(
  params: XyqImageParams,
  sessionId: string,
  retryCount = 0
): Promise<any> {
  const { PassThrough } = await import("stream");
  const stream = new PassThrough();
  const created = util.unixTimestamp();

  (async () => {
    try {
      stream.write(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "正在生成图片，请稍候...\n" }, finish_reason: null },
          ],
          created,
        })}\n\n`
      );

      const result = await createImageCompletion(params, sessionId, retryCount);
      stream.write(
        `data: ${JSON.stringify({
          id: result.threadId,
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: result.imageUrls.join("\n") + (result.textContent ? `\n${result.textContent}` : "") },
              finish_reason: "stop",
            },
          ],
          created,
        })}\n\n`
      );
      stream.end("data: [DONE]\n\n");
    } catch (err: any) {
      logger.error(`[XYQ] 流式图片生成失败: ${err.message}`);
      if (!stream.closed) {
        stream.write(
          `data: ${JSON.stringify({
            id: "",
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: `\n\n云雀生图失败: ${err.message}` },
                finish_reason: "stop",
              },
            ],
            created,
          })}\n\n`
        );
        stream.end("data: [DONE]\n\n");
      }
    }
  })();

  return stream;
}
