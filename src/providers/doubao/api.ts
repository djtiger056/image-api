/**
 * doubao.com API 底层调用模块
 *
 * 封装豆包 Web 端的 /samantha/chat/completion SSE 流式接口，
 * 实现文生图 / 图生图的提交、流式解析与会话清理。
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
import { uploadImageToDoubao } from "@/providers/doubao/upload.ts";

// ─── 常量 ────────────────────────────────────────────────────────────

const MODEL_NAME = "doubao";
const DEFAULT_ASSISTANT_ID = "497858";
const VERSION_CODE = "20800";
const PC_VERSION = "2.44.0";
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
  Referer: "https://www.doubao.com",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

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

async function doubaoRequest(
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
      "X-Flow-Trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
      ...(options.headers || {}),
    },
    timeout: 15000,
    validateStatus: () => true,
    ..._.omit(options, "params", "headers"),
  });

  if (options.responseType === "stream") return response;
  return checkResult(response);
}

function checkResult(result: AxiosResponse): any {
  if (!result.data) return null;
  const { code, msg, data } = result.data;
  if (!_.isFinite(code)) return result.data;
  if (code === 0) return data;
  throw new APIException(EX.API_REQUEST_FAILED, `[豆包请求失败]: ${msg}`);
}

// ─── 会话管理 ──────────────────────────────────────────────────────

export async function removeConversation(
  convId: string,
  sessionId: string
): Promise<void> {
  try {
    const params = {
      msToken: generateFakeMsToken(),
      a_bogus: generateFakeABogus(),
    };
    const headers = {
      Referer: `https://www.doubao.com/chat/${convId}`,
      "Agw-js-conv": "str",
    };
    await doubaoRequest("POST", "/samantha/thread/delete", sessionId, {
      data: { conversation_id: convId },
      params,
      headers,
    });
    logger.success(`[Doubao] 会话 ${convId} 删除成功`);
  } catch (err) {
    logger.error(`[Doubao] 删除会话 ${convId} 失败:`, err);
  }
}

// ─── Token 校验 ────────────────────────────────────────────────────

export async function getTokenLiveStatus(sessionId: string): Promise<boolean> {
  try {
    const data = await doubaoRequest(
      "GET",
      "/passport/account/info/v2",
      sessionId
    );
    return !!(data && data.user_id);
  } catch {
    return false;
  }
}

export function tokenSplit(authorization: string): string[] {
  return authorization.replace("Bearer ", "").split(",");
}

// ─── SSE 流解析 ────────────────────────────────────────────────────

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
 * 接收完整 SSE 流，返回同步结果（含图片 URL 列表）
 */
export async function receiveStream(stream: any): Promise<StreamResult> {
  let temp = Buffer.from("");
  const imageUrls: string[] = [];
  const emittedImageKeys = new Set<string>();

  return new Promise((resolve, reject) => {
    const data: StreamResult = {
      id: "",
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", images: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };

    let isEnd = false;

    const finalize = () => {
      data.choices[0].message.content =
        data.choices[0].message.content.replace(/\n$/, "");
      data.choices[0].message.images = imageUrls;
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
            `[豆包请求失败]: ${rawResult.code}-${rawResult.message}`
          );

        // event_type 2003 = 流结束
        if (rawResult.event_type === 2003) {
          isEnd = true;
          finalize();
          return resolve(data);
        }

        // event_type 2001 = 数据事件
        if (rawResult.event_type !== 2001) return;

        const result = _.attempt(() => JSON.parse(rawResult.event_data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${rawResult.event_data}`);

        logger.info(`[Doubao SSE] event_type=${rawResult.event_type}, is_finish=${result.is_finish}, content_type=${result.message?.content_type}, conv_id=${result.conversation_id}`);

        if (result.is_finish) {
          isEnd = true;
          finalize();
          return resolve(data);
        }

        if (!data.id && result.conversation_id) {
          data.id = result.conversation_id;
        }

        const message = result.message;
        if (!message || !message.content) return;

        // 解析文本内容
        let text = "";
        const parsed = _.attempt(() => JSON.parse(message.content));
        if (!_.isError(parsed)) {
          if (typeof parsed === "string") text = parsed;
          else if (typeof parsed.text === "string") text = parsed.text;
          else if (parsed.delta && typeof parsed.delta.text === "string")
            text = parsed.delta.text;
          else if (typeof parsed.content === "string") text = parsed.content;
        } else if (typeof message.content === "string") {
          text = message.content;
        }
        if (text) data.choices[0].message.content += text;

        // 解析图片内容 (content_type = 2074)
        const ctype = message.content_type;
        if (ctype === 2074) {
          const payload = _.isError(parsed)
            ? _.attempt(() => JSON.parse(message.content))
            : parsed;
          if (
            !_.isError(payload) &&
            payload &&
            Array.isArray(payload.creations)
          ) {
            payload.creations.forEach((c: any) => {
              const img = c?.image || {};
              const key = img?.key as string | undefined;
              const ori = img?.image_ori?.url;
              if (key && ori && !emittedImageKeys.has(key)) {
                emittedImageKeys.add(key);
                imageUrls.push(ori);
              }
            });
          }
        }
      } catch (err) {
        logger.error(err);
        reject(err);
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

    stream.once("error", (err: Error) => reject(err));
    stream.once("close", () => {
      finalize();
      if (imageUrls.length === 0) {
        logger.warn(`[Doubao SSE] 流关闭但无图片, conv_id=${data.id}, content长度=${data.choices[0].message.content.length}, content=${data.choices[0].message.content.substring(0, 200)}`);
      }
      resolve(data);
    });
  });
}

/**
 * 创建转换流 —— 将豆包 SSE 流转换为 OpenAI 兼容格式
 */
export function createTransStream(
  stream: any,
  endCallback?: (convId: string) => void
): PassThrough {
  let convId = "";
  let temp = Buffer.from("");
  const created = util.unixTimestamp();
  let imageNoticeSent = false;
  const emittedImageKeys = new Set<string>();

  const transStream = new PassThrough();

  // 写入初始 chunk
  if (!transStream.closed) {
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model: MODEL_NAME,
        object: "chat.completion.chunk",
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
          `[豆包请求失败]: ${rawResult.code}-${rawResult.message}`
        );

      // 流结束
      if (rawResult.event_type === 2003) {
        transStream.write(
          `data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
            created,
          })}\n\n`
        );
        if (!transStream.closed) transStream.end("data: [DONE]\n\n");
        endCallback?.(convId);
        return;
      }

      if (rawResult.event_type !== 2001) return;

      const result = _.attempt(() => JSON.parse(rawResult.event_data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${rawResult.event_data}`);

      if (!convId) convId = result.conversation_id;

      if (result.is_finish) {
        transStream.write(
          `data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
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

      // 图片生成事件 (content_type = 2074)
      const ctype = message.content_type;
      if (ctype === 2074 && !_.isError(content)) {
        const creations = Array.isArray((content as any).creations)
          ? (content as any).creations
          : [];
        if (!imageNoticeSent && creations.length) {
          const notice = `\n[图片生成中（共${creations.length}张）...]\n`;
          transStream.write(
            `data: ${JSON.stringify({
              id: convId,
              model: MODEL_NAME,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: notice }, finish_reason: null }],
              created,
            })}\n\n`
          );
          imageNoticeSent = true;
        }
        for (const c of creations) {
          const img = c?.image || {};
          const key = img?.key as string | undefined;
          const url =
            img?.image_preview?.url || img?.image_thumb?.url || img?.image_ori?.url;
          const ori = img?.image_ori?.url || url;
          if (key && url && !emittedImageKeys.has(key)) {
            emittedImageKeys.add(key);
            transStream.write(
              `data: ${JSON.stringify({
                id: convId,
                model: MODEL_NAME,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: `${ori}\n` }, finish_reason: null }],
                created,
              })}\n\n`
            );
          }
        }
      }

      // 文本内容
      let text = "";
      if (!_.isError(content)) {
        if (typeof content === "string") text = content;
        else if (typeof (content as any).text === "string") text = (content as any).text;
        else if ((content as any).delta && typeof (content as any).delta.text === "string")
          text = (content as any).delta.text;
        else if (typeof (content as any).content === "string") text = (content as any).content;
      } else if (typeof message.content === "string") {
        text = message.content;
      }

      if (text) {
        transStream.write(
          `data: ${JSON.stringify({
            id: convId,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
            created,
          })}\n\n`
        );
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

// ─── 图片生成（同步） ─────────────────────────────────────────────

export interface DoubaoImageParams {
  prompt: string;
  ratio?: string;
  style?: string;
  genModel?: string;
  referenceImage?: Buffer | string;
}

/**
 * 同步图片生成 —— 提交请求、等待完成、返回结果
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
      `[Doubao] 图片生成请求: prompt=${prompt}, ratio=${ratio}, style=${style}, model=${genModel}, refImage=${!!referenceImage}`
    );

    // 构造附件（参考图）—— 上传图片到豆包 ImageX/TOS
    const attachments: any[] = [];
    if (referenceImage) {
      try {
        const storeUri = await uploadImageToDoubao(referenceImage, sessionId);
        attachments.push({
          type: "image",
          key: storeUri,
          extra: { refer_types: "overall" },
          identifier: util.uuid(),
        });
        logger.info(`[Doubao] 参考图上传成功: ${storeUri}`);
      } catch (uploadErr) {
        logger.error(`[Doubao] 参考图上传失败: ${(uploadErr as Error).message}`);
        throw uploadErr;
      }
    }

    const contentJson = JSON.stringify({
      text: `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`,
      model: genModel,
      template_type: "placeholder",
      use_creation: false,
    });

    const imageMessage = [
      {
        content: contentJson,
        content_type: 2009,
        attachments,
      },
    ];

    const response = await doubaoRequest(
      "post",
      "/samantha/chat/completion",
      sessionId,
      {
        data: {
          messages: imageMessage,
          completion_option: {
            is_regen: false,
            with_suggest: false,
            need_create_conversation: true,
            launch_stage: 1,
            is_replace: false,
            is_delete: false,
            message_from: 0,
            action_bar_skill_id: 3,
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
          Referer: "https://www.doubao.com/chat/",
          "agw-js-conv": "str, str",
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
    const answer = await receiveStream(response.data);
    logger.success(
      `[Doubao] 图片生成流传输完成 ${util.timestamp() - streamStartTime}ms`
    );

    // 异步清理会话
    removeConversation(answer.id, sessionId).catch((err) =>
      console.error("[Doubao] 移除图片生成会话失败：", err)
    );

    // 如果没有返回图片且还有重试次数，重试
    const imageUrls = answer.choices[0]?.message?.images || [];
    if (imageUrls.length === 0 && retryCount < MAX_RETRY_COUNT) {
      logger.warn(`[Doubao] 未返回图片，${RETRY_DELAY / 1000}秒后重试 (${retryCount + 1}/${MAX_RETRY_COUNT})...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createImageCompletion(params, sessionId, retryCount + 1);
    }

    return answer;
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`[Doubao] 图片生成流响应错误: ${err.stack}`);
      logger.warn(`[Doubao] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createImageCompletion(params, sessionId, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 流式图片生成 —— 返回 OpenAI 兼容的 SSE 流
 */
export async function createImageCompletionStream(
  params: DoubaoImageParams,
  sessionId: string,
  retryCount = 0
): Promise<PassThrough> {
  try {
    const {
      prompt,
      ratio = "1:1",
      style = "智能",
      genModel = "Seedream 4.5",
      referenceImage,
    } = params;

    logger.info(
      `[Doubao] 流式图片生成请求: prompt=${prompt}, ratio=${ratio}, style=${style}, model=${genModel}, refImage=${!!referenceImage}`
    );

    const attachments: any[] = [];
    if (referenceImage) {
      try {
        const storeUri = await uploadImageToDoubao(referenceImage, sessionId);
        attachments.push({
          type: "vlm_image",
          identifier: util.uuid(),
          name: "reference-image.png",
          key: storeUri,
          file_review_state: 3,
          file_parse_state: 3,
          option: { width: 1, height: 1 },
        });
        logger.info(`[Doubao] 流式参考图上传成功: ${storeUri}`);
      } catch (uploadErr) {
        logger.error(`[Doubao] 流式参考图上传失败: ${(uploadErr as Error).message}`);
        throw uploadErr;
      }
    }

    const contentJson = JSON.stringify({
      text: `帮我生成图片：${prompt}\n风格：${style}\n比例：${ratio}`,
      model: genModel,
      template_type: "placeholder",
      use_creation: false,
    });

    const imageMessage = [
      {
        content: contentJson,
        content_type: 2009,
        attachments,
        references: [],
      },
    ];

    const response = await doubaoRequest(
      "post",
      "/samantha/chat/completion",
      sessionId,
      {
        data: {
          messages: imageMessage,
          completion_option: {
            is_regen: false,
            with_suggest: false,
            need_create_conversation: true,
            launch_stage: 1,
            is_replace: false,
            is_delete: false,
            message_from: 0,
            action_bar_skill_id: 0,
            use_deep_think: false,
            use_auto_cot: false,
            resend_for_regen: false,
            enable_commerce_credit: false,
            event_id: "0",
          },
          evaluate_option: { web_ab_params: "" },
          section_id: `26${util.generateRandomString({ length: 16, charset: "numeric" })}`,
          conversation_id: "0",
          local_conversation_id: `local_16${util.generateRandomString({ length: 14, charset: "numeric" })}`,
          local_message_id: util.uuid(),
        },
        headers: {
          Referer: "https://www.doubao.com/chat/",
          "agw-js-conv": "str, str",
        },
        timeout: 300000,
        responseType: "stream",
      }
    );

    if (
      response.headers["content-type"]?.indexOf("text/event-stream") === -1
    ) {
      logger.error(
        `[Doubao] 无效的响应Content-Type: ${response.headers["content-type"]}`
      );
      response.data.on("data", (buffer: Buffer) =>
        logger.error(buffer.toString())
      );
      const transStream = new PassThrough();
      transStream.end(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "image.completion.chunk",
          choices: [
            { index: 0, delta: { content: "服务暂时不可用，第三方响应错误" }, finish_reason: "stop" },
          ],
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return transStream;
    }

    const streamStartTime = util.timestamp();
    return createTransStream(response.data, (convId: string) => {
      logger.success(
        `[Doubao] 流式图片生成传输完成 ${util.timestamp() - streamStartTime}ms`
      );
      removeConversation(convId, sessionId).catch((err) =>
        console.error(err)
      );
    });
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`[Doubao] 流式图片生成响应错误: ${err.stack}`);
      logger.warn(`[Doubao] ${RETRY_DELAY / 1000}秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return createImageCompletionStream(params, sessionId, retryCount + 1);
    }
    throw err;
  }
}
