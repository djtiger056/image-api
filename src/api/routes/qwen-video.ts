import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import { inferClosestRatioFromImageSource } from "@/lib/image-ratio.ts";
import {
  createVideoCompletion,
  getCredit,
  tokenSplit,
} from "@/providers/qwen/api.ts";
import { normalizeCookieString } from "@/providers/qwen/upload.ts";
import { resolveQwenSession } from "@/providers/qwen/session.ts";
import {
  resolveQwenVideoModel,
  normalizeQwenRatio,
  normalizeQwenVideoResolution,
  normalizeQwenVideoDuration,
  DEFAULT_QWEN_VIDEO_MODEL,
  getQwenVideoModels,
} from "@/providers/qwen/mapper.ts";
import historyManager from "@/lib/history-manager.ts";

/**
 * 解析千问 Cookie
 */
function resolveQwenCookie(authorization?: string): string {
  const incoming = String(authorization || "").trim();
  if (incoming) {
    // 支持 "Bearer cookie" 或直接 cookie
    return normalizeCookieString(incoming.replace(/^Bearer\s+/i, ""));
  }

  const envCookie = String(process.env.QWEN_COOKIE || "").trim();
  if (envCookie) return normalizeCookieString(envCookie);

  throw new Error(
    "千问视频服务未配置可用凭证。请设置 QWEN_COOKIE 环境变量。"
  );
}

function pickQwenCookie(authorization?: string): string {
  const raw = resolveQwenCookie(authorization);
  const cookies = tokenSplit(raw);
  const cookie = _.sample(cookies);
  if (!cookie) throw new Error("QWEN_COOKIE 中没有可用 cookie");
  return cookie;
}

const QWEN_VIDEO_REFERENCE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

async function resolveQwenVideoRatio(ratio: string, images: any[]): Promise<string> {
  const fallback = normalizeQwenRatio(ratio);
  const firstImage = Array.isArray(images)
    ? images.find((item) => _.isString(item) && item.trim())
    : undefined;

  if (!firstImage) return fallback;

  try {
    return await inferClosestRatioFromImageSource(
      String(firstImage).trim(),
      QWEN_VIDEO_REFERENCE_RATIOS,
      fallback
    );
  } catch (error: any) {
    logger.warn(`[QwenVideo Route] 无法解析参考图比例，使用默认比例 ${fallback}: ${error.message}`);
    return fallback;
  }
}

export default {
  prefix: "/v1/qwen/videos",

  post: {
    /**
     * POST /v1/qwen/videos/generations
     * 千问视频生成（同步模式，等待完成后返回视频 URL）
     */
    "/generations": async (request: Request) => {
      request
        .validate(
          "body.model",
          (v) => _.isUndefined(v) || _.isString(v)
        )
        .validate(
          "body.prompt",
          (v) => _.isString(v) && v.length > 0
        )
        .validate(
          "body.ratio",
          (v) => _.isUndefined(v) || _.isString(v)
        )
        .validate(
          "body.duration",
          (v) => _.isUndefined(v) || _.isFinite(v)
        )
        .validate(
          "body.resolution",
          (v) => _.isUndefined(v) || _.isString(v)
        )
        .validate(
          "body.response_format",
          (v) => _.isUndefined(v) || _.isString(v)
        )
        .validate(
          "body.images",
          (v) => _.isUndefined(v) || Array.isArray(v)
        )
        .validate(
          "body.timeout_ms",
          (v) => _.isUndefined(v) || _.isFinite(v)
        );

      const authorization = request.headers.authorization as string | undefined;
      const qwenSession = authorization
        ? await resolveQwenSession(pickQwenCookie(authorization))
        : await resolveQwenSession();

      const {
        model = DEFAULT_QWEN_VIDEO_MODEL,
        prompt,
        ratio = "16:9",
        duration = 10,
        resolution,
        images = [],
        timeout_ms,
        response_format = "url",
      } = request.body;

      const modelMapping = resolveQwenVideoModel(model);
      const normalizedDuration = normalizeQwenVideoDuration(model, duration);
      const normalizedResolution = normalizeQwenVideoResolution(
        model,
        resolution
      );
      const supportsImageInput = Boolean(modelMapping.supportsImageInput);
      const normalizedImages = supportsImageInput
        ? (Array.isArray(images)
            ? images
                .filter((item) => _.isString(item) && item.trim())
                .map((item) => ({ type: "image", url: String(item).trim() }))
            : [])
        : [];
      const normalizedRatio = await resolveQwenVideoRatio(
        ratio,
        normalizedImages.map((item) => item.url)
      );

      logger.info(
        `[QwenVideo Route] 同步视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}, resolution=${normalizedResolution}, duration=${normalizedDuration}s, images=${normalizedImages.length}`
      );

      const result = await createVideoCompletion(
        {
          prompt,
          ratio: normalizedRatio,
          duration: normalizedDuration,
          resolution: normalizedResolution,
          model,
          attachments: normalizedImages,
        },
        qwenSession,
        {
          maxWaitTimeMs: _.isFinite(timeout_ms) ? Number(timeout_ms) : undefined,
        }
      );

      if (!result.success || !result.videoUrl) {
        return {
          created: util.unixTimestamp(),
          error: {
            message: result.error || "千问视频生成未返回视频URL",
            type: "generation_failed",
          },
        };
      }

      if (response_format === "b64_json") {
        const videoBase64 = await util.fetchFileBASE64(result.videoUrl);
        if (result.videoUrl && result.videoUrl.startsWith('http')) {
          historyManager.recordVideoGeneration({
            provider: 'qwen',
            model: model || 'qwen-video',
            prompt: prompt || '',
            videoUrls: [result.videoUrl],
          }).catch(() => {});
        }
        return {
          created: util.unixTimestamp(),
          data: [{ b64_json: videoBase64 }],
          model,
          provider: "qwen",
        };
      }

      if (result.videoUrl && result.videoUrl.startsWith('http')) {
        historyManager.recordVideoGeneration({
          provider: 'qwen',
          model: model || 'qwen-video',
          prompt: prompt || '',
          videoUrls: [result.videoUrl],
        }).catch(() => {});
      }
      return {
        created: util.unixTimestamp(),
        data: [{ url: result.videoUrl }],
        model,
        provider: "qwen",
      };
    },
  },

  get: {
    /**
     * GET /v1/qwen/videos/models
     * 返回可用的千问视频模型列表
     */
    "/models": async () => {
      return {
        data: getQwenVideoModels(),
      };
    },

    /**
     * GET /v1/qwen/videos/credit
     * 查询剩余信用额度
     */
    "/credit": async (request: Request) => {
      const authorization = request.headers.authorization as string | undefined;
      const qwenSession = authorization
        ? await resolveQwenSession(pickQwenCookie(authorization))
        : await resolveQwenSession();
      const credit = await getCredit(qwenSession);
      return {
        ok: true,
        total_amount: credit.totalAmount,
        provider: "qwen",
      };
    },
  },
};
