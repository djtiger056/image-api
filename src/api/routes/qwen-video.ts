import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import {
  createVideoCompletion,
  getCredit,
  tokenSplit,
  normalizeQwenRatio,
} from "@/providers/qwen/api.ts";
import {
  isQwenModelName,
  resolveQwenVideoModel,
  DEFAULT_QWEN_VIDEO_MODEL,
  getQwenVideoModels,
} from "@/providers/qwen/mapper.ts";

/**
 * 解析千问 Cookie
 */
function resolveQwenCookie(authorization?: string): string {
  const incoming = String(authorization || "").trim();
  if (incoming) {
    // 支持 "Bearer cookie" 或直接 cookie
    return incoming.replace(/^Bearer\s+/i, "");
  }

  const envCookie = String(process.env.QWEN_COOKIE || "").trim();
  if (envCookie) return envCookie;

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
          "body.response_format",
          (v) => _.isUndefined(v) || _.isString(v)
        );

      const cookie = pickQwenCookie(
        request.headers.authorization as string | undefined
      );

      const {
        model = DEFAULT_QWEN_VIDEO_MODEL,
        prompt,
        ratio = "16:9",
        duration = 10,
        response_format = "url",
      } = request.body;

      const modelMapping = resolveQwenVideoModel(model);
      const normalizedRatio = normalizeQwenRatio(ratio);
      const normalizedDuration = duration === 5 ? 5 : 10;

      logger.info(
        `[QwenVideo Route] 同步视频生成: model=${modelMapping.model}, ratio=${normalizedRatio}, duration=${normalizedDuration}s`
      );

      const result = await createVideoCompletion(
        {
          prompt,
          ratio: normalizedRatio,
          duration: normalizedDuration,
        },
        cookie
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
        return {
          created: util.unixTimestamp(),
          data: [{ b64_json: videoBase64 }],
          model,
          provider: "qwen",
        };
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
      const cookie = pickQwenCookie(
        request.headers.authorization as string | undefined
      );
      const credit = await getCredit(cookie);
      return {
        ok: true,
        total_amount: credit.totalAmount,
        provider: "qwen",
      };
    },
  },
};
