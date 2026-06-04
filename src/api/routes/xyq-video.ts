import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import {
  createVideoCompletion,
  tokenSplit,
} from "@/providers/xyq/api.ts";
import {
  isXyqVideoModel,
  resolveXyqModel,
  normalizeRatio,
} from "@/providers/xyq/mapper.ts";

import { selectSingleToken } from '@/lib/service-authorization.js';

const DEFAULT_XYQ_VIDEO_MODEL = "xyq-seedance-2.0-fast";
const DEFAULT_XYQ_VIDEO_TIMEOUT_MS = 75 * 60 * 1000;
const XYQ_VIDEO_DURATIONS = [5, 10];

function resolveXyqAuthorization(authorization?: string): string {
  const incoming = String(authorization || "").trim();
  if (incoming) return incoming;

  const envAuth = String(process.env.XYQ_AUTHORIZATION || "").trim();
  if (envAuth) return /^Bearer\s+/i.test(envAuth) ? envAuth : `Bearer ${envAuth}`;

  const envSession = String(process.env.XYQ_SESSIONID || "").trim();
  if (envSession) return /^Bearer\s+/i.test(envSession) ? envSession : `Bearer ${envSession}`;

  throw new Error(
    "云雀视频服务未配置可用凭证。请设置 XYQ_AUTHORIZATION 或 XYQ_SESSIONID，或在请求里提供 Authorization。"
  );
}

function pickXyqToken(authorization?: string): string {
  // 请求头有显式 token 时直接使用
  const incoming = String(authorization || '').trim();
  if (incoming) {
    const tokens = tokenSplit(incoming);
    if (tokens.length > 0) return tokens[0];
  }
  // 使用账号管理器按优先级选择
  return selectSingleToken(undefined, 'xyq');
}

function normalizeDuration(value: any): number {
  const duration = Number(value || 5);
  if (XYQ_VIDEO_DURATIONS.includes(duration)) return duration;
  return 5;
}

function normalizeTimeoutMs(value: any): number {
  const timeoutMs = Number(value);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  return DEFAULT_XYQ_VIDEO_TIMEOUT_MS;
}

function extractReferenceImages(request: Request): Array<string | Buffer> {
  const contentType = request.headers["content-type"] || "";
  const isMultiPart = contentType.startsWith("multipart/form-data");

  if (isMultiPart) {
    const files = (request.rawFiles as any)?.images || (request.rawFiles as any)?.files;
    const imageFiles = files ? (Array.isArray(files) ? files : [files]) : [];
    return imageFiles.slice(0, 2).map((file: any) => fs.readFileSync(file.filepath));
  }

  const images = request.body?.images;
  if (!Array.isArray(images)) return [];
  return images
    .filter((item: any) => _.isString(item) && item.trim())
    .slice(0, 2)
    .map((item: string) => item.trim());
}

export default {
  prefix: "/v1/xyq/videos",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", (v) => _.isString(v) && v.length > 0)
        .validate("body.ratio", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.duration", (v) => _.isUndefined(v) || _.isFinite(Number(v)))
        .validate("body.images", (v) => _.isUndefined(v) || Array.isArray(v))
        .validate("body.timeout_ms", (v) => _.isUndefined(v) || _.isFinite(Number(v)))
        .validate("body.response_format", (v) => _.isUndefined(v) || _.isString(v));

      const token = pickXyqToken(request.headers.authorization as string | undefined);
      const {
        model = DEFAULT_XYQ_VIDEO_MODEL,
        prompt,
        ratio = "16:9",
        duration = 5,
        timeout_ms,
        response_format = "url",
      } = request.body;

      if (!isXyqVideoModel(model)) {
        throw new Error(`模型 ${model} 不是小云雀视频模型`);
      }

      const modelMapping = resolveXyqModel(model);
      const normalizedRatio = normalizeRatio(ratio);
      const normalizedDuration = normalizeDuration(duration);
      const referenceImages = extractReferenceImages(request);
      const timeoutMs = normalizeTimeoutMs(timeout_ms);

      logger.info(
        `[XYQVideo Route] 同步视频生成: model=${modelMapping.modelName}, ratio=${normalizedRatio}, duration=${normalizedDuration}s, images=${referenceImages.length}, timeout=${Math.round(timeoutMs / 1000)}s`
      );

      const result = await createVideoCompletion(
        {
          prompt,
          ratio: normalizedRatio,
          duration: normalizedDuration,
          genModel: modelMapping.modelName,
          referenceImages,
        },
        token,
        { maxWaitTimeMs: timeoutMs }
      );

      const videoUrl = result.videoUrls[0];
      if (response_format === "b64_json") {
        const videoBase64 = await util.fetchFileBASE64(videoUrl);
        return {
          created: util.unixTimestamp(),
          data: [{ b64_json: videoBase64 }],
          model,
          provider: "xyq",
          videoUrl,
          videoUrls: result.videoUrls,
          text: result.textContent || undefined,
        };
      }

      return {
        created: util.unixTimestamp(),
        data: [{ url: videoUrl }],
        model,
        provider: "xyq",
        videoUrl,
        videoUrls: result.videoUrls,
        result_url: videoUrl,
        text: result.textContent || undefined,
      };
    },
  },

  get: {
    "/models": async () => {
      return {
        data: [
          {
            id: "xyq-seedance-2.0",
            object: "model",
            owned_by: "images-api",
            description: "小云雀 Seedance 2.0 视频生成模型（生成较慢，建议使用长等待时间）",
          },
          {
            id: "xyq-seedance-2.0-fast",
            object: "model",
            owned_by: "images-api",
            description: "小云雀 Seedance 2.0 Fast 视频生成模型（生成较慢，建议使用长等待时间）",
          },
        ],
      };
    },
  },
};
