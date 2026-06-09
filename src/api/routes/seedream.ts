/**
 * 统一 Seedream 生图路由
 *
 * POST /v1/seedream/generations
 *
 * 对外暴露 seedream-4.0 / seedream-4.5 / seedream-5.0 三个模型，
 * 底层自动轮询 jimeng → xyq → doubao。
 *
 * 支持文生图和图生图（images 参数，URL 数组或 multipart 文件上传）。
 * 支持异步模式（async=true 返回 task_id，前端轮询 /v1/images/tasks/:id）。
 */

import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import {
  UnifiedImageGenerateInput,
  ImageProviderContext,
} from "@/providers/types.ts";
import SeedreamUnifiedProvider, {
  isSeedreamModel,
} from "@/providers/seedream/unified-provider.ts";
import taskManager from "@/lib/task-manager.ts";
import historyManager from "@/lib/history-manager.ts";
import logger from "@/lib/logger.ts";

const provider = new SeedreamUnifiedProvider();

function coerceNumber(value: any): number | undefined {
  if (_.isUndefined(value) || value === "") return undefined;
  if (_.isFinite(value)) return Number(value);
  if (typeof value === "string" && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

function coerceBoolean(value: any): boolean | undefined {
  if (_.isUndefined(value) || value === "") return undefined;
  if (_.isBoolean(value)) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * 从请求中提取图片（支持 multipart 文件上传和 body URL 数组）
 */
function extractImages(request: Request): Array<string | Buffer> | undefined {
  const contentType = request.headers["content-type"] || "";
  const isMultiPart = contentType.startsWith("multipart/form-data");

  if (isMultiPart) {
    const files = (request.files as any)?.images;
    const imageFiles = files ? (Array.isArray(files) ? files : [files]) : [];
    if (imageFiles.length > 10) {
      throw new Error("最多支持10张输入图片");
    }
    return imageFiles.length > 0
      ? imageFiles.map((file: any) => fs.readFileSync(file.filepath))
      : undefined;
  }

  const bodyImages = request.body.images;
  if (_.isUndefined(bodyImages) || bodyImages === null) {
    return undefined;
  }
  if (!Array.isArray(bodyImages)) {
    throw new Error("images 参数必须是数组");
  }
  if (bodyImages.length > 10) {
    throw new Error("最多支持10张输入图片");
  }
  bodyImages.forEach((image: any, index: number) => {
    if (!_.isString(image) && !_.isObject(image)) {
      throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
    }
    if (_.isObject(image) && !(image as any).url) {
      throw new Error(`图片 ${index + 1} 缺少url字段`);
    }
  });
  return bodyImages.map((image: any) => (_.isString(image) ? image : (image as any).url));
}

function buildInput(
  request: Request,
  images?: Array<string | Buffer>
): UnifiedImageGenerateInput {
  const body = request.body || {};
  if (!_.isString(body.prompt) || !body.prompt.trim()) {
    throw new Error("prompt 不能为空");
  }

  const model = (body.model || "seedream-4.5").toLowerCase();
  if (!isSeedreamModel(model)) {
    throw new Error(`不支持的模型: ${model}。支持: seedream-4.0, seedream-4.5, seedream-5.0`);
  }

  // seedream 支持 style 参数，传入 providerOptions
  const providerOptions = _.isObject(body.provider_options) ? { ...body.provider_options } : {};
  if (body.style && !providerOptions.style) {
    providerOptions.style = body.style;
  }

  return {
    model,
    prompt: body.prompt,
    images,
    negativePrompt: body.negative_prompt,
    ratio: body.ratio,
    resolution: body.resolution,
    responseFormat: body.response_format,
    sampleStrength: coerceNumber(body.sample_strength),
    intelligentRatio: coerceBoolean(body.intelligent_ratio),
    async: coerceBoolean(body.async),
    n: coerceNumber(body.n),
    providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
  };
}

function recordHistory(providerName: string, model: string, prompt: string, result: any, extra: any) {
  const imageUrls = (result.data || [])
    .map((d: any) => d.url)
    .filter((u: any): u is string => typeof u === 'string' && u.startsWith('http'));
  if (imageUrls.length > 0) {
    historyManager.recordImageGeneration({
      provider: providerName,
      model,
      prompt,
      imageUrls,
      extra,
    }).catch((err: any) => logger.warn(`[History] Seedream 记录失败: ${err.message}`));
  }
}

export default {
  prefix: "/v1/seedream",

  post: {
    "/generations": async (request: Request) => {
      const images = extractImages(request);
      const input = buildInput(request, images);
      const context: ImageProviderContext = {
        authorization: request.headers.authorization as string | undefined,
      };
      const n = Number(request.body?.n);
      const model = request.body?.model || 'seedream-4.5';
      const prompt = request.body?.prompt || '';
      const isAsync = input.async === true;

      // ── 异步模式 ──
      if (isAsync) {
        const task = taskManager.createTask({
          type: 'image',
          provider: 'seedream',
          model,
          prompt,
        });

        taskManager.updateTaskStatus(task.id, 'running');

        provider.generateUnified(input, context)
          .then((result: any) => {
            if (n > 0 && Array.isArray(result.data) && result.data.length > n) {
              result.data = result.data.slice(0, n);
            }
            taskManager.updateTaskStatus(task.id, 'completed', result);
            recordHistory('seedream', model, prompt, result, { ratio: request.body?.ratio, n, task_id: task.id });
          })
          .catch((err: any) => {
            taskManager.updateTaskStatus(task.id, 'failed', err.message || '生成失败');
          });

        return {
          task_id: task.id,
          status: 'pending',
          message: 'Seedream 任务已提交，使用 task_id 查询进度',
        };
      }

      // ── 同步模式 ──
      const result = await provider.generateUnified(input, context);

      if (n > 0 && Array.isArray(result.data) && result.data.length > n) {
        result.data = result.data.slice(0, n);
      }

      recordHistory('seedream', model, prompt, result, { ratio: request.body?.ratio, n });

      return result;
    },
  },
};
