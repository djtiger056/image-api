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
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { createParser } from "eventsource-parser";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { removeConversation, tokenSplit } from "@/providers/doubao/api.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const MODEL_NAME = "doubao-video";
const DEFAULT_ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "3.19.2";
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;

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
  /** 会话 ID（用于清理） */
  conversationId: string;
  /** 文本描述（机器人回复） */
  textContent: string;
  /** 是否达到每日限额 */
  quotaExhausted: boolean;
}

// ─── SSE 流解析（同步模式） ────────────────────────────────────────

/**
 * 接收完整 SSE 流，返回同步结果（含视频 URL）
 */
export function receiveVideoStream(stream: any): Promise<DoubaoVideoResult> {
  let temp = Buffer.from("");
  let videoUrl = "";
  let textContent = "";
  let conversationId = "";
  let quotaExhausted = false;
  const emittedVideoKeys = new Set<string>();

  return new Promise((resolve, reject) => {
    let isEnd = false;

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

        // event_type 2003 = 流结束
        if (rawResult.event_type === 2003) {
          isEnd = true;
          resolve({
            videoUrl,
            conversationId,
            textContent: textContent.trim(),
            quotaExhausted,
          });
          return;
        }

        // event_type 2002 = 会话创建
        if (rawResult.event_type === 2002) {
          const ed = _.attempt(() => JSON.parse(rawResult.event_data));
          if (!_.isError(ed) && ed.conversation_id) {
            conversationId = ed.conversation_id;
          }
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
        if (rawResult.event_type !== 2001) return;

        const result = _.attempt(() => JSON.parse(rawResult.event_data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${rawResult.event_data}`);

        if (!conversationId && result.conversation_id) {
          conversationId = result.conversation_id;
        }

        const message = result.message;
        if (!message || !message.content) return;

        const ctype = message.content_type;

        // 检查额度用尽
        const parsedContent = _.attempt(() => JSON.parse(message.content));
        if (!_.isError(parsedContent) && typeof parsedContent === "object") {
          // 检查 text 字段是否包含限额提示
          const text = parsedContent.text || "";
          if (text.includes("生成次数已经达到上限") || text.includes("额度")) {
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
          if (text) textContent += text;
        }

        // content_type 2076 = 视频结果（类似图片的 2074）
        // 也可能使用其他 content_type，需要灵活处理
        if (ctype === 2076 || ctype === 2075 || ctype === 2077) {
          const payload = _.isError(parsedContent)
            ? _.attempt(() => JSON.parse(message.content))
            : parsedContent;

          if (!_.isError(payload) && payload) {
            // 尝试多种视频 URL 提取方式
            const urls: string[] = [];

            // 格式1: creations[].video.url
            if (Array.isArray(payload.creations)) {
              for (const c of payload.creations) {
                const v = c?.video || {};
                const key = v?.key as string | undefined;
                const url = v?.url || v?.video_ori?.url || v?.video_preview?.url;
                if (key && url && !emittedVideoKeys.has(key)) {
                  emittedVideoKeys.add(key);
                  urls.push(url);
                }
              }
            }

            // 格式2: 直接的 url 字段
            if (payload.url) urls.push(payload.url);
            if (payload.video_url) urls.push(payload.video_url);

            // 格式3: data.uri 或 data.url
            if (payload.data?.uri) urls.push(payload.data.uri);
            if (payload.data?.url) urls.push(payload.data.url);

            if (urls.length > 0 && !videoUrl) {
              videoUrl = urls[0];
              logger.info(`[DoubaoVideo] 视频 URL 获取到: ${videoUrl}`);
            }
          }
        }

        // is_finish = true 时结束
        if (result.is_finish) {
          isEnd = true;

          // 如果完成但还没找到视频URL，检查tts_content中是否有有用信息
          if (!videoUrl && message.tts_content) {
            textContent = message.tts_content;
          }

          // 检查最终的 content 中是否有视频 URL
          if (!videoUrl && !_.isError(parsedContent)) {
            const urls: string[] = [];
            if (Array.isArray(parsedContent.creations)) {
              for (const c of parsedContent.creations) {
                const v = c?.video || {};
                const url = v?.url || v?.video_ori?.url;
                if (url) urls.push(url);
              }
            }
            if (parsedContent.url) urls.push(parsedContent.url);
            if (parsedContent.video_url) urls.push(parsedContent.video_url);
            if (urls.length > 0) videoUrl = urls[0];
          }

          resolve({
            videoUrl,
            conversationId,
            textContent: textContent.trim(),
            quotaExhausted,
          });
          return;
        }
      } catch (err) {
        logger.error(err);
        if (!isEnd) {
          isEnd = true;
          reject(err);
        }
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

    stream.once("error", (err: Error) => {
      if (!isEnd) {
        isEnd = true;
        reject(err);
      }
    });
    stream.once("close", () => {
      if (!isEnd) {
        isEnd = true;
        resolve({
          videoUrl,
          conversationId,
          textContent: textContent.trim(),
          quotaExhausted,
        });
      }
    });
  });
}

// ─── 视频生成（同步） ─────────────────────────────────────────────

export interface DoubaoVideoParams {
  prompt: string;
  ratio?: string;
  duration?: number;
  skillId?: number;
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
      duration = 5,
      skillId = 17,
    } = params;

    logger.info(
      `[DoubaoVideo] 视频生成请求: prompt=${prompt}, ratio=${ratio}, duration=${duration}s`
    );

    const contentJson = JSON.stringify({
      text: prompt,
    });

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
              attachments: [],
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
        },
        headers: {
          Referer: "https://www.doubao.com/chat/create-video",
          "Agw-Js-Conv": "str",
        },
        timeout: 300000,
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
    const result = await receiveVideoStream(response.data);
    logger.success(
      `[DoubaoVideo] 视频生成流传输完成 ${util.timestamp() - streamStartTime}ms`
    );

    // 异步清理会话
    if (result.conversationId) {
      removeConversation(result.conversationId, sessionId).catch((err) =>
        console.error("[DoubaoVideo] 移除视频生成会话失败：", err)
      );
    }

    return result;
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT) {
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
      duration = 5,
      skillId = 17,
    } = params;

    logger.info(
      `[DoubaoVideo] 流式视频生成请求: prompt=${prompt}, ratio=${ratio}, duration=${duration}s`
    );

    const contentJson = JSON.stringify({
      text: prompt,
    });

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
              attachments: [],
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
        },
        headers: {
          Referer: "https://www.doubao.com/chat/create-video",
          "Agw-Js-Conv": "str",
        },
        timeout: 300000,
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
    if (retryCount < MAX_RETRY_COUNT) {
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
  const emittedVideoKeys = new Set<string>();

  const transStream = new PassThrough();

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

      // 流结束
      if (rawResult.event_type === 2003) {
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
        return;
      }

      // 会话创建
      if (rawResult.event_type === 2002) {
        const ed = _.attempt(() => JSON.parse(rawResult.event_data));
        if (!_.isError(ed) && ed.conversation_id) convId = ed.conversation_id;
        return;
      }

      if (rawResult.event_type !== 2001) return;

      const result = _.attempt(() => JSON.parse(rawResult.event_data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${rawResult.event_data}`);

      if (!convId && result.conversation_id) convId = result.conversation_id;

      if (result.is_finish) {
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
        return;
      }

      const message = result.message;
      if (!message || !message.content) return;

      const content = _.attempt(() => JSON.parse(message.content));
      const ctype = message.content_type;

      // 视频结果事件 (content_type = 2076/2075/2077)
      if ((ctype === 2076 || ctype === 2075 || ctype === 2077) && !_.isError(content)) {
        const payload = content as any;
        const urls: string[] = [];

        if (Array.isArray(payload.creations)) {
          for (const c of payload.creations) {
            const v = c?.video || {};
            const key = v?.key as string | undefined;
            const url = v?.url || v?.video_ori?.url || v?.video_preview?.url;
            if (key && url && !emittedVideoKeys.has(key)) {
              emittedVideoKeys.add(key);
              urls.push(url);
            }
          }
        }
        if (payload.url) urls.push(payload.url);
        if (payload.video_url) urls.push(payload.video_url);

        if (urls.length > 0) {
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
          for (const url of urls) {
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
    if (!transStream.closed) transStream.end("data: [DONE]\n\n");
  });
  stream.once("close", () => {
    if (!transStream.closed) transStream.end("data: [DONE]\n\n");
  });

  return transStream;
}
