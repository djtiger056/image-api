/**
 * 小云雀图片生成 Provider
 *
 * 实现 ImageProvider 接口，将 xyq.jianying.com 的免费生图能力
 * 接入统一的 /v1/images/generations 路由。
 *
 * 认证方式：使用 xyq.jianying.com 的 sessionid Cookie，
 * 支持多账号逗号分隔轮询（与即梦/豆包 Token 机制一致）。
 *
 * 环境变量：
 *   XYQ_AUTHORIZATION — 云雀 sessionid（逗号分隔多个）
 *   XYQ_SESSIONID — 云雀 sessionid（备用）
 */

import _ from "lodash";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import ImageProvider, {
  ImageProviderContext,
  UnifiedImageGenerateInput,
  UnifiedImageGenerateOutput,
} from "@/providers/types.ts";
import {
  isXyqModelName,
  resolveXyqModel,
  normalizeRatio,
  normalizeStyle,
} from "@/providers/xyq/mapper.ts";
import {
  createImageCompletion,
  createImageCompletionStream,
  tokenSplit,
  } from "@/providers/xyq/api.ts";
  import { selectSingleToken } from "@/lib/service-authorization.js";

  /**
 * 解析云雀 Authorization
 *
 * 优先级：
 * 1. 请求头 Authorization（由调用方传入）
 * 2. 环境变量 XYQ_AUTHORIZATION
 * 3. 环境变量 XYQ_SESSIONID
 */
function resolveXyqAuthorization(authorization?: string): string {
  const incoming = String(authorization || "").trim();
  if (incoming) return incoming;

  const envAuth = String(process.env.XYQ_AUTHORIZATION || "").trim();
  if (envAuth) return /^Bearer\s+/i.test(envAuth) ? envAuth : `Bearer ${envAuth}`;

  const envSession = String(process.env.XYQ_SESSIONID || "").trim();
  if (envSession) return /^Bearer\s+/i.test(envSession) ? envSession : `Bearer ${envSession}`;

  throw new Error(
    "云雀服务未配置可用凭证。请设置 XYQ_AUTHORIZATION 或 XYQ_SESSIONID，或在请求里提供 Authorization。"
  );
}

/**
 * 从 Authorization 中选取一个云雀 sessionid
 */
function pickXyqToken(authorization?: string): string {
  const incoming = String(authorization || '').trim();
  if (incoming) {
    const tokens = tokenSplit(incoming);
    if (tokens.length > 0) return tokens[0];
  }
  return selectSingleToken(undefined, 'xyq');
}

export default class XyqImageProvider implements ImageProvider {
  name = "xyq";

  supportsModel(model?: string): boolean {
    if (!model) return false;
    return isXyqModelName(model);
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    const token = pickXyqToken(context.authorization);
    const responseFormat = _.defaultTo(input.responseFormat, "url");

    // 解析模型参数
    const modelMapping = resolveXyqModel(input.model);
    const ratio = normalizeRatio(input.ratio);
    const style = normalizeStyle(
      input.providerOptions?.style || input.providerOptions?.xyq_style
    );

    logger.info(
      `[XYQ] 开始生图: model=${modelMapping.modelName}, ratio=${ratio}, style=${style}`
    );

    // 调用云雀同步生图接口
    const result = await createImageCompletion(
      {
        prompt: input.prompt,
        ratio,
        style,
        genModel: modelMapping.modelName,
        referenceImages:
          input.images && input.images.length > 0
            ? input.images
            : undefined,
      },
      token
    );

    // 提取图片 URL
    const imageUrls = result.imageUrls;

    if (imageUrls.length === 0) {
      throw new Error(`云雀生图未返回任何图片。${result.textContent || ""}`);
    }

    // 按 responseFormat 转换
    const data =
      responseFormat === "b64_json"
        ? (
            await Promise.all(
              imageUrls.map((url) => util.fetchFileBASE64(url))
            )
          ).map((b64) => ({ b64_json: b64 }))
        : imageUrls.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
      provider: this.name,
    };
  }
}
