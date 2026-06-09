import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import {
  klingImageProvider,
  resolveImageProvider,
} from "@/providers/provider-registry.ts";
import {
  UnifiedImageGenerateInput,
  ImageProviderContext,
} from "@/providers/types.ts";
import { resolveServiceAuthorization } from "@/lib/service-authorization.js";
import {
  isKlingNativeGenerationBody,
  isKlingNativeMultiImageBody,
} from "@/providers/kling/mapper.ts";
import historyManager from "@/lib/history-manager.ts";
import taskManager from "@/lib/task-manager.ts";
import logger from "@/lib/logger.ts";

function getProviderContext(
  request: Request,
  authorizationOverride?: string
): ImageProviderContext {
  return {
    authorization: (authorizationOverride || request.headers.authorization) as string | undefined,
  };
}

function validateUnsupportedSizeParams(body: any) {
  const unsupportedParams = ["size", "width", "height"];
  const bodyKeys = Object.keys(body || {});
  const foundUnsupported = unsupportedParams.filter((param) => bodyKeys.includes(param));
  if (foundUnsupported.length > 0) {
    throw new Error(
      `不支持的参数: ${foundUnsupported.join(", ")}。请使用 ratio 和 resolution 参数控制图像尺寸。`
    );
  }
}

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

function extractImages(request: Request, requireImages = false): Array<string | Buffer> | undefined {
  const contentType = request.headers["content-type"] || "";
  const isMultiPart = contentType.startsWith("multipart/form-data");

  if (isMultiPart) {
    const files =
      (request.rawFiles as any)?.images ||
      (request.filesMap as any)?.images ||
      (request.rawFiles as any)?.files ||
      (request.filesMap as any)?.files ||
      request.files;
    const imageFiles = files ? (Array.isArray(files) ? files : [files]) : [];
    if (imageFiles.length > 10) {
      throw new Error("最多支持10张输入图片");
    }
    if (requireImages && imageFiles.length === 0) {
      throw new Error("至少需要提供1张输入图片");
    }
    return imageFiles.length > 0
      ? imageFiles.map((file: any) => fs.readFileSync(file.filepath))
      : undefined;
  }

  const bodyImages = request.body.images;
  if (_.isUndefined(bodyImages) || bodyImages === null) {
    if (requireImages) throw new Error("至少需要提供1张输入图片");
    return undefined;
  }
  if (!Array.isArray(bodyImages)) {
    throw new Error("images 参数必须是数组");
  }
  if (bodyImages.length > 10) {
    throw new Error("最多支持10张输入图片");
  }
  if (requireImages && bodyImages.length === 0) {
    throw new Error("至少需要提供1张输入图片");
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

function buildUnifiedInput(
  request: Request,
  images?: Array<string | Buffer>
): UnifiedImageGenerateInput {
  const body = request.body || {};
  if (!_.isString(body.prompt) || !body.prompt.trim()) {
    throw new Error("prompt 不能为空");
  }

  return {
    model: body.model,
    prompt: body.prompt,
    images,
    negativePrompt: body.negative_prompt,
    ratio: body.ratio,
    resolution: body.resolution,
    duration: coerceNumber(body.duration),
    responseFormat: body.response_format,
    sampleStrength: coerceNumber(body.sample_strength),
    intelligentRatio: coerceBoolean(body.intelligent_ratio),
    async: coerceBoolean(body.async),
    n: coerceNumber(body.n),
    providerOptions: _.isObject(body.provider_options) ? body.provider_options : undefined,
  };
}

// ─── 异步生成核心逻辑 ─────────────────────────────────

/**
 * 在后台执行图片生成任务
 * 完成后自动记录到 history
 */
function runImageGenerationBackground(params: {
  taskId: string;
  provider: any;
  input: UnifiedImageGenerateInput;
  context: ImageProviderContext;
  requestMeta: { model: string; prompt: string; ratio?: string; n?: number };
}): void {
  const { taskId, provider, input, context, requestMeta } = params;

  taskManager.updateTaskStatus(taskId, 'running');

  provider.generateUnified(input, context)
    .then((result: any) => {
      // 按 n 参数截取
      const n = requestMeta.n;
      if (n && n > 0 && Array.isArray(result.data) && result.data.length > n) {
        result.data = result.data.slice(0, n);
      }

      taskManager.updateTaskStatus(taskId, 'completed', result);

      // 记录历史
      const imageUrls = (result.data || [])
        .map((d: any) => d.url)
        .filter((u: any): u is string => typeof u === 'string' && u.startsWith('http'));
      if (imageUrls.length > 0) {
        historyManager.recordImageGeneration({
          provider: provider.name,
          model: requestMeta.model,
          prompt: requestMeta.prompt,
          imageUrls,
          extra: { ratio: requestMeta.ratio, n, task_id: taskId },
        }).catch((err: any) => logger.warn(`[History] 图片记录失败: ${err.message}`));
      }
    })
    .catch((err: any) => {
      taskManager.updateTaskStatus(taskId, 'failed', err.message || '生成失败');
    });
}

export default {
  prefix: "/v1/images",

  get: {
    "/generations": async (request: Request) => {
      return klingImageProvider.listNativeGenerations(request.query || {}, getProviderContext(request));
    },
    "/generations/:id": async (request: Request) => {
      return klingImageProvider.getNativeGeneration(request.params.id, getProviderContext(request));
    },
    "/multi-image2image/:id": async (request: Request) => {
      return klingImageProvider.getNativeMultiImageToImage(request.params.id, getProviderContext(request));
    },

    // ─── 新增：查询异步任务状态 ──────────────────────
    "/tasks/:id": async (request: Request) => {
      const task = taskManager.getTask(request.params.id);
      if (!task) {
        return { error: "任务不存在", code: "TASK_NOT_FOUND" };
      }
      // 返回任务状态（pending/running 时不返回 result）
      const response: any = {
        task_id: task.id,
        status: task.status,
        provider: task.provider,
        model: task.model,
        prompt: task.prompt,
        created_at: task.createdAt,
      };
      if (task.status === 'completed') {
        response.result = task.result;
        response.completed_at = task.completedAt;
        response.duration_ms = task.completedAt! - task.createdAt;
      } else if (task.status === 'failed') {
        response.error = task.error;
        response.completed_at = task.completedAt;
        response.duration_ms = task.completedAt! - task.createdAt;
      } else if (task.status === 'running') {
        response.elapsed_ms = Date.now() - task.createdAt;
      }
      return response;
    },
  },

  post: {
    "/generations": async (request: Request) => {
      validateUnsupportedSizeParams(request.body);

      if (isKlingNativeGenerationBody(request.body)) {
        return klingImageProvider.createNativeGeneration(request.body, getProviderContext(request));
      }

      const images = extractImages(request);
      const provider = resolveImageProvider(request.body);
      const authorization = provider.name === "jimeng"
        ? resolveServiceAuthorization(request.headers.authorization as string | undefined)
        : undefined;
      const context = getProviderContext(request, authorization);
      const input = buildUnifiedInput(request, images);
      const isAsync = input.async === true;

      // ── 异步模式：创建任务，立即返回 task_id ──
      if (isAsync) {
        const task = taskManager.createTask({
          type: 'image',
          provider: provider.name,
          model: request.body?.model || 'default',
          prompt: request.body?.prompt || '',
        });

        // 后台执行生成
        runImageGenerationBackground({
          taskId: task.id,
          provider,
          input,
          context,
          requestMeta: {
            model: request.body?.model || 'default',
            prompt: request.body?.prompt || '',
            ratio: request.body?.ratio,
            n: coerceNumber(request.body?.n),
          },
        });

        return {
          task_id: task.id,
          status: 'pending',
          message: '任务已提交，使用 task_id 查询进度',
        };
      }

      // ── 同步模式：等待生成完成 ──
      const result = await provider.generateUnified(input, context);

      // 按 n 参数截取返回图片数量
      const n = Number(request.body?.n);
      if (n > 0 && Array.isArray(result.data) && result.data.length > n) {
        result.data = result.data.slice(0, n);
      }

      // 异步记录生成历史并下载到本地（不阻塞响应）
      const imageUrls = (result.data || [])
        .map((d: any) => d.url)
        .filter((u: any): u is string => typeof u === 'string' && u.startsWith('http'));
      if (imageUrls.length > 0) {
        historyManager.recordImageGeneration({
          provider: provider.name,
          model: request.body?.model || 'default',
          prompt: request.body?.prompt || '',
          imageUrls,
          extra: { ratio: request.body?.ratio, n },
        }).catch((err: any) => logger.warn(`[History] 图片记录失败: ${err.message}`));
      }

      return result;
    },

    "/compositions": async (request: Request) => {
      validateUnsupportedSizeParams(request.body);
      const images = extractImages(request, true);
      const provider = resolveImageProvider(request.body);
      const authorization = provider.name === "jimeng"
        ? resolveServiceAuthorization(request.headers.authorization as string | undefined)
        : undefined;
      const context = getProviderContext(request, authorization);
      const input = buildUnifiedInput(request, images);
      const isAsync = input.async === true;

      // ── 异步模式 ──
      if (isAsync) {
        const task = taskManager.createTask({
          type: 'composition',
          provider: provider.name,
          model: request.body?.model || 'default',
          prompt: request.body?.prompt || '',
        });

        runImageGenerationBackground({
          taskId: task.id,
          provider,
          input,
          context,
          requestMeta: {
            model: request.body?.model || 'default',
            prompt: request.body?.prompt || '',
            ratio: request.body?.ratio,
            n: coerceNumber(request.body?.n),
          },
        });

        return {
          task_id: task.id,
          status: 'pending',
          message: '合成任务已提交，使用 task_id 查询进度',
        };
      }

      // ── 同步模式 ──
      const result = await provider.generateUnified(input, context);

      const n = Number(request.body?.n);
      if (n > 0 && Array.isArray(result.data) && result.data.length > n) {
        result.data = result.data.slice(0, n);
      }

      const compImageUrls = (result.data || [])
        .map((d: any) => d.url)
        .filter((u: any): u is string => typeof u === 'string' && u.startsWith('http'));
      if (compImageUrls.length > 0) {
        historyManager.recordImageGeneration({
          provider: provider.name,
          model: request.body?.model || 'default',
          prompt: request.body?.prompt || '',
          imageUrls: compImageUrls,
          extra: { ratio: request.body?.ratio, n, type: 'composition' },
        }).catch((err: any) => logger.warn(`[History] 图片合成记录失败: ${err.message}`));
      }

      return result;
    },

    "/multi-image2image": async (request: Request) => {
      if (!isKlingNativeMultiImageBody(request.body)) {
        throw new Error(
          "Kling 多图转图请传 subject_image_list / scene_image / style_image 中的至少一个字段。"
        );
      }
      return klingImageProvider.createNativeMultiImageToImage(request.body, getProviderContext(request));
    },
  },
};
