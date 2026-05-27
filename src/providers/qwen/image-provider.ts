/**
 * 千问 (Qwen) 图片生成 Provider
 *
 * 实现 ImageProvider 接口，将 create.qianwen.com 的免费生图能力
 * 接入统一的 /v1/images/generations 路由。
 *
 * 支持模型：
 * - qwen-image-2.0   (Qwen-Image 2.0，免费)
 * - qwen-image-1.0-pro (Qwen-Image 1.0 专业版，免费)
 * - qwen-image-1.0   (Qwen-Image 1.0，免费)
 *
 * 支持文生图和图生图（通过参考图 URL）。
 *
 * 环境变量：QWEN_COOKIE — 千问 cookie 字符串
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
  isQwenImageModelName,
  resolveQwenImageModel,
  normalizeQwenRatio,
} from "@/providers/qwen/mapper.ts";
import {
  createImageCompletion,
  tokenSplit,
} from "@/providers/qwen/api.ts";
import {
  normalizeCookieString,
  uploadImageToQwen,
} from "@/providers/qwen/upload.ts";
import { resolveQwenSession } from "@/providers/qwen/session.ts";

// ─── Cookie 解析 ──────────────────────────────────────────────────

function resolveQwenCookie(authorization?: string): string {
  const incoming = String(authorization || "").trim();
  if (incoming) {
    const cleaned = incoming.replace(/^Bearer\s+/i, "");
    return normalizeCookieString(cleaned);
  }

  const envCookie = String(process.env.QWEN_COOKIE || "").trim();
  if (envCookie) return normalizeCookieString(envCookie);

  throw new Error(
    "千问图片服务未配置可用凭证。请设置 QWEN_COOKIE 环境变量。"
  );
}

function pickQwenCookie(authorization?: string): string {
  const raw = resolveQwenCookie(authorization);
  const cookies = tokenSplit(raw);
  const cookie = _.sample(cookies);
  if (!cookie) throw new Error("QWEN_COOKIE 中没有可用 cookie");
  return cookie;
}

// ─── Provider 实现 ────────────────────────────────────────────────

export default class QwenImageProvider implements ImageProvider {
  name = "qwen";

  supportsModel(model?: string): boolean {
    if (!model) return false;
    return isQwenImageModelName(model);
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    const session = context.authorization
      ? await resolveQwenSession(pickQwenCookie(context.authorization))
      : await resolveQwenSession();
    const responseFormat = _.defaultTo(input.responseFormat, "url");

    // 解析模型参数
    const modelMapping = resolveQwenImageModel(input.model);
    const ratio = normalizeQwenRatio(input.ratio);
    const num = _.clamp(input.n || 1, 1, 4);

    // 判断是文生图还是图生图
    const hasImages = input.images && input.images.length > 0;

    logger.info(
      `[QwenImage] 开始${hasImages ? "图生图" : "文生图"}: model=${modelMapping.modelKey}, ratio=${ratio}, num=${num}`
    );

    // 处理图生图的参考图：先上传到千问 CDN 获取 material_id
    let attachments: Array<{ type: string; materialId: string }> = [];
    if (hasImages && input.images) {
      for (const img of input.images.slice(0, 2)) {
        try {
          let imageSource: string;
          if (typeof img === "string") {
            imageSource = img;
          } else if (Buffer.isBuffer(img)) {
            imageSource = `data:image/png;base64,${img.toString("base64")}`;
          } else {
            logger.warn("[QwenImage] 不支持的图片格式，跳过");
            continue;
          }
          const materialId = await uploadImageToQwen(imageSource, session);
          attachments.push({ type: "image", materialId });
          logger.info(`[QwenImage] 参考图上传成功: materialId=${materialId}`);
        } catch (uploadErr) {
          logger.warn(`[QwenImage] 参考图上传失败: ${uploadErr instanceof Error ? uploadErr.stack || uploadErr.message : JSON.stringify(uploadErr)}，跳过该图`);
        }
      }
    }

    if (hasImages && attachments.length === 0) {
      throw new Error("参考图上传失败，无法执行千问图生图");
    }

    // 根据上传结果确定场景
    const scene = attachments.length > 0
      ? modelMapping.sceneI2I
      : modelMapping.sceneT2I;
    logger.info(`[QwenImage] 最终场景: ${scene}, attachments=${attachments.length}`);

    // 调用千问图片生成接口
    const result = await createImageCompletion(
      {
        prompt: input.prompt,
        modelKey: modelMapping.modelKey,
        rootModel: modelMapping.rootModel,
        scene,
        ratio,
        num,
        attachments,
      },
      session
    );

    if (!result.success || !result.imageUrls || result.imageUrls.length === 0) {
      throw new Error(result.error || "千问图片生成失败");
    }

    // 按 responseFormat 转换
    const urls = result.downloadUrls || result.imageUrls;
    const data =
      responseFormat === "b64_json"
        ? (
            await Promise.all(
              urls.map((url) => util.fetchFileBASE64(url))
            )
          ).map((b64) => ({ b64_json: b64 }))
        : urls.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
      provider: this.name,
    };
  }
}
