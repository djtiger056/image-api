/**
 * 统一 Seedream 生图 Provider
 *
 * 将 jimeng、xyq（小云雀）、doubao 三个提供商的 Seedream 模型合并为统一接口。
 * 对外只暴露 seedream-4.0 / seedream-4.5 / seedream-5.0 三个模型名。
 *
 * 轮询顺序：jimeng → xyq → doubao
 * 当某个提供商积分/额度耗尽时，自动降级到下一个提供商。
 */

import _ from "lodash";

import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import ImageProvider, {
  ImageProviderContext,
  UnifiedImageGenerateInput,
  UnifiedImageGenerateOutput,
} from "@/providers/types.ts";

// jimeng
import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { getCredit as getJimengCredit, tokenSplit as jimengTokenSplit } from "@/api/controllers/core.ts";
import { resolveServiceAuthorization, selectSingleToken } from "@/lib/service-authorization.js";

// xyq
import {
  createImageCompletion as xyqCreateImage,
  tokenSplit as xyqTokenSplit,
  getCredit as getXyqCredit,
} from "@/providers/xyq/api.ts";
import { normalizeRatio as xyqNormalizeRatio, normalizeStyle as xyqNormalizeStyle } from "@/providers/xyq/mapper.ts";

// doubao
import {
  createImageCompletion as doubaoCreateImage,
  tokenSplit as doubaoTokenSplit,
} from "@/providers/doubao/api.ts";
import { resolveDoubaoModel, normalizeRatio as doubaoNormalizeRatio, normalizeStyle as doubaoNormalizeStyle } from "@/providers/doubao/mapper.ts";

// ──────────────────────────────────────────────
// 模型映射
// ──────────────────────────────────────────────

interface SeedreamModelMapping {
  jimeng: string;      // jimeng 内部模型名
  xyq: string;         // xyq 内部模型名（genModel 格式）
  doubao: string;      // doubao 内部 genModel 名
}

const SEEDREAM_MODEL_MAP: Record<string, SeedreamModelMapping> = {
  "seedream-5.0": {
    jimeng: "jimeng-5.0",
    xyq: "xyq-seedream-5.0",
    doubao: "Seedream 4.5",  // doubao 没有 5.0，降级到 4.5
  },
  "seedream-4.5": {
    jimeng: "jimeng-4.5",
    xyq: "xyq-seedream-4.5",
    doubao: "Seedream 4.5",
  },
  "seedream-4.0": {
    jimeng: "jimeng-4.0",
    xyq: "xyq-seedream-4.0",
    doubao: "Seedream 4.0",
  },
};

const SUPPORTED_MODELS = Object.keys(SEEDREAM_MODEL_MAP);

export function isSeedreamModel(model?: string): boolean {
  if (!model) return false;
  return SUPPORTED_MODELS.includes(model.toLowerCase());
}

export function getSeedreamModels() {
  return SUPPORTED_MODELS.map((id) => ({
    id,
    object: "model",
    owned_by: "images-api",
    description: `统一 Seedream ${id.replace("seedream-", "")} 模型（自动轮询 jimeng/xyq/doubao）`,
  }));
}

// ──────────────────────────────────────────────
// Token 解析
// ──────────────────────────────────────────────

function pickJimengToken(authorization?: string): string | null {
  try {
    const incoming = String(authorization || '').trim();
    if (incoming) {
      const tokens = jimengTokenSplit(incoming);
      return tokens[0] || null;
    }
    return selectSingleToken(undefined, 'jimeng');
  } catch {
    return null;
  }
}

function pickXyqToken(): string | null {
  try {
    return selectSingleToken(undefined, 'xyq');
  } catch {
    return null;
  }
}

function pickDoubaoToken(): string | null {
  try {
    return selectSingleToken(undefined, 'doubao');
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// 积分/额度检查
// ──────────────────────────────────────────────

async function checkJimengAvailable(token: string): Promise<boolean> {
  try {
    const credit = await getJimengCredit(token);
    const available = credit.totalCredit > 0;
    logger.info(`[Seedream] jimeng 积分: ${credit.totalCredit} (可用: ${available})`);
    return available;
  } catch (err: any) {
    logger.warn(`[Seedream] jimeng 积分查询失败: ${err.message}`);
    // 查询失败时仍然尝试（可能是临时错误）
    return true;
  }
}

async function checkXyqAvailable(token: string): Promise<boolean> {
  try {
    const quota = await getXyqCredit(token);
    // 检查是否有任一场景还有剩余配额
    const hasRemaining = quota.some((item: any) => item.remaining > 0);
    logger.info(`[Seedream] xyq 配额: ${quota.map((i: any) => `${i.scene}:${i.remaining}/${i.total}`).join(", ")} (可用: ${hasRemaining})`);
    return hasRemaining;
  } catch (err: any) {
    logger.warn(`[Seedream] xyq 配额查询失败: ${err.message}`);
    return true;
  }
}

// ──────────────────────────────────────────────
// 各提供商生图实现
// ──────────────────────────────────────────────

async function generateWithJimeng(
  input: UnifiedImageGenerateInput,
  mapping: SeedreamModelMapping,
  token: string
): Promise<UnifiedImageGenerateOutput> {
  const jimengInput = { ...input, model: mapping.jimeng };
  const imageUrls = input.images && input.images.length > 0
    ? await generateImageComposition(
        jimengInput.model,
        jimengInput.prompt,
        jimengInput.images,
        {
          ratio: jimengInput.ratio,
          resolution: jimengInput.resolution,
          sampleStrength: jimengInput.sampleStrength,
          negativePrompt: jimengInput.negativePrompt,
          intelligentRatio: jimengInput.intelligentRatio,
        },
        token
      )
    : await generateImages(
        jimengInput.model,
        jimengInput.prompt,
        {
          ratio: jimengInput.ratio,
          resolution: jimengInput.resolution,
          sampleStrength: jimengInput.sampleStrength,
          negativePrompt: jimengInput.negativePrompt,
          intelligentRatio: jimengInput.intelligentRatio,
        },
        token
      );

  const responseFormat = _.defaultTo(input.responseFormat, "url");
  const data = responseFormat === "b64_json"
    ? (await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
    : imageUrls.map((url) => ({ url }));

  return { created: util.unixTimestamp(), data, provider: "jimeng" };
}

async function generateWithXyq(
  input: UnifiedImageGenerateInput,
  mapping: SeedreamModelMapping,
  token: string
): Promise<UnifiedImageGenerateOutput> {
  const ratio = xyqNormalizeRatio(input.ratio);
  const style = xyqNormalizeStyle(input.providerOptions?.style);

  const result = await xyqCreateImage(
    {
      prompt: input.prompt,
      ratio,
      style,
      genModel: mapping.xyq,
      referenceImages: input.images && input.images.length > 0 ? input.images : undefined,
    },
    token
  );

  if (result.imageUrls.length === 0) {
    throw new Error(`xyq 生图未返回图片: ${result.textContent || ""}`);
  }

  const responseFormat = _.defaultTo(input.responseFormat, "url");
  const data = responseFormat === "b64_json"
    ? (await Promise.all(result.imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
    : result.imageUrls.map((url) => ({ url }));

  return { created: util.unixTimestamp(), data, provider: "xyq" };
}

async function generateWithDoubao(
  input: UnifiedImageGenerateInput,
  mapping: SeedreamModelMapping,
  token: string
): Promise<UnifiedImageGenerateOutput> {
  const ratio = doubaoNormalizeRatio(input.ratio);
  const style = doubaoNormalizeStyle(input.providerOptions?.style);

  const result = await doubaoCreateImage(
    {
      prompt: input.prompt,
      ratio,
      style,
      genModel: mapping.doubao,
      referenceImage: input.images && input.images.length > 0 ? input.images[0] : undefined,
    },
    token
  );

  const imageUrls = result.choices[0]?.message?.images || [];
  if (imageUrls.length === 0) {
    throw new Error("doubao 生图未返回图片");
  }

  const responseFormat = _.defaultTo(input.responseFormat, "url");
  const data = responseFormat === "b64_json"
    ? (await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
    : imageUrls.map((url) => ({ url }));

  return { created: util.unixTimestamp(), data, provider: "doubao" };
}

// ──────────────────────────────────────────────
// 统一 Provider
// ──────────────────────────────────────────────

export default class SeedreamUnifiedProvider implements ImageProvider {
  name = "seedream";

  supportsModel(model?: string): boolean {
    return isSeedreamModel(model);
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    const model = (input.model || "seedream-4.5").toLowerCase();
    const mapping = SEEDREAM_MODEL_MAP[model];
    if (!mapping) {
      throw new Error(`不支持的 seedream 模型: ${model}。支持: ${SUPPORTED_MODELS.join(", ")}`);
    }

    // 收集可用的提供商链
    type ProviderCandidate = {
      name: string;
      token: string;
      generate: () => Promise<UnifiedImageGenerateOutput>;
    };

    const candidates: ProviderCandidate[] = [];

    // 1. jimeng
    const jimengToken = pickJimengToken(context.authorization);
    if (jimengToken) {
      candidates.push({
        name: "jimeng",
        token: jimengToken,
        generate: () => generateWithJimeng(input, mapping, jimengToken),
      });
    }

    // 2. xyq
    const xyqToken = pickXyqToken();
    if (xyqToken) {
      candidates.push({
        name: "xyq",
        token: xyqToken,
        generate: () => generateWithXyq(input, mapping, xyqToken),
      });
    }

    // 3. doubao
    const doubaoToken = pickDoubaoToken();
    if (doubaoToken) {
      candidates.push({
        name: "doubao",
        token: doubaoToken,
        generate: () => generateWithDoubao(input, mapping, doubaoToken),
      });
    }

    if (candidates.length === 0) {
      throw new Error("没有可用的提供商凭证。请配置 JIMENG_AUTHORIZATION / XYQ_SESSIONID / DOUBAO_SESSIONID 中的至少一个。");
    }

    // 依次尝试
    const errors: Array<{ provider: string; error: string }> = [];

    for (const candidate of candidates) {
      try {
        logger.info(`[Seedream] 尝试 ${candidate.name} (${model})...`);
        const result = await candidate.generate();
        logger.info(`[Seedream] ${candidate.name} 生图成功`);
        return result;
      } catch (err: any) {
        const msg = err.message || String(err);
        logger.warn(`[Seedream] ${candidate.name} 失败: ${msg}`);
        errors.push({ provider: candidate.name, error: msg });
      }
    }

    // 所有提供商都失败
    const summary = errors.map((e) => `${e.provider}: ${e.error}`).join("; ");
    throw new Error(`所有提供商均失败: ${summary}`);
  }
}
