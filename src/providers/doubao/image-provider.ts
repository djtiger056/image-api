/**
 * 豆包图片生成 Provider
 *
 * 实现 ImageProvider 接口，将 doubao.com 的免费生图能力
 * 接入统一的 /v1/images/generations 路由。
 *
 * 认证方式：使用 doubao.com 的 sessionid Cookie 作为 Bearer Token，
 * 支持多账号逗号分隔轮询（与即梦 Token 机制一致）。
 *
 * 环境变量：
 *   DOUBAO_AUTHORIZATION — 豆包 sessionid（逗号分隔多个）
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
  isDoubaoModelName,
  resolveDoubaoModel,
  normalizeRatio,
  normalizeStyle,
} from "@/providers/doubao/mapper.ts";
import {
  createImageCompletion,
  createImageCompletionStream,
  tokenSplit,
} from "@/providers/doubao/api.ts";
import { resolveServiceAuthorization, selectSingleToken } from "@/lib/service-authorization.js";

/**
 * 解析豆包 Authorization
 *
 * 优先级：
 * 1. 请求头 Authorization（由调用方传入）
 * 2. 环境变量 DOUBAO_AUTHORIZATION
 * 3. 环境变量 DOUBAO_SESSIONID
 */
function resolveDoubaoAuthorization(authorization?: string): string {
  return resolveServiceAuthorization(authorization, 'doubao');
}

/**
 * 从 Authorization 中选取一个豆包 sessionid
 */
function pickDoubaoToken(authorization?: string): string {
  const incoming = String(authorization || '').trim();
  if (incoming) {
    const tokens = tokenSplit(incoming);
    if (tokens.length > 0) return tokens[0];
  }
  return selectSingleToken(undefined, 'doubao');
}

export default class DoubaoImageProvider implements ImageProvider {
  name = "doubao";

  supportsModel(model?: string): boolean {
    if (!model) return false;
    return isDoubaoModelName(model);
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    const token = pickDoubaoToken(context.authorization);
    const responseFormat = _.defaultTo(input.responseFormat, "url");

    // 解析模型参数
    const modelMapping = resolveDoubaoModel(input.model);
    const ratio = normalizeRatio(input.ratio);
    const style = normalizeStyle(
      input.providerOptions?.style || input.providerOptions?.doubao_style
    );

    logger.info(
      `[Doubao] 开始生图: genModel=${modelMapping.genModel}, ratio=${ratio}, style=${style}`
    );

    // 调用豆包同步生图接口
    const result = await createImageCompletion(
      {
        prompt: input.prompt,
        ratio,
        style,
        genModel: modelMapping.genModel,
        referenceImage:
          input.images && input.images.length > 0
            ? input.images[0]
            : undefined,
      },
      token
    );

    // 提取图片 URL
    const imageUrls = result.choices[0]?.message?.images || [];

    if (imageUrls.length === 0) {
      throw new Error("豆包生图未返回任何图片");
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
