import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import klingApiAutomation from "@/providers/kling/api-automation.ts";
import ImageProvider, {
  ImageProviderContext,
  UnifiedImageGenerateInput,
  UnifiedImageGenerateOutput,
} from "@/providers/types.ts";
import {
  DEFAULT_KLING_MODEL,
  isKlingModelName,
  buildKlingTaskSubmitBody,
  mapUnifiedToKlingGenerationBody,
} from "@/providers/kling/mapper.ts";

export default class KlingImageProvider implements ImageProvider {
  name = "kling";

  supportsModel(model?: string): boolean {
    return isKlingModelName(model || DEFAULT_KLING_MODEL);
  }

  private async generateViaApi(
    input: UnifiedImageGenerateInput
  ): Promise<UnifiedImageGenerateOutput> {
    const result = await klingApiAutomation.generate(input);
    const responseFormat = input.responseFormat || "url";
    const imageUrls = result.imageUrls || [];

    if (responseFormat === "b64_json") {
      const data = await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)));
      return {
        created: util.unixTimestamp(),
        provider: this.name,
        transport: "api",
        task_id: result.taskId,
        status: "succeed",
        page_url: result.pageUrl,
        observed_task_ids: result.observedTaskIds,
        data: data.map((b64) => ({ b64_json: b64 })),
      };
    }

    return {
      created: util.unixTimestamp(),
      provider: this.name,
      transport: "api",
      task_id: result.taskId,
      status: "succeed",
      page_url: result.pageUrl,
      observed_task_ids: result.observedTaskIds,
      data: imageUrls.map((url) => ({ url })),
    };
  }

  async generateUnified(
    input: UnifiedImageGenerateInput,
    context: ImageProviderContext
  ): Promise<UnifiedImageGenerateOutput> {
    void context;
    return this.generateViaApi(input);
  }

  // ---- Kling 原生 API 兼容方法 (供 images.ts 路由调用) ----

  async createNativeGeneration(body: any, context: ImageProviderContext): Promise<any> {
    void context;
    // 将原生 body 转为统一格式再调用
    const input: UnifiedImageGenerateInput = {
      model: body.model_name || body.kolors_version || DEFAULT_KLING_MODEL,
      prompt: body.prompt,
      ratio: body.aspect_ratio,
      n: body.imageCount ? Number(body.imageCount) : undefined,
      responseFormat: body.response_format,
    };
    return this.generateViaApi(input);
  }

  async getNativeGeneration(id: string, context: ImageProviderContext): Promise<any> {
    void context;
    throw new Error(
      `Kling 网页模式不支持按 ID 查询 (${id})。请使用 POST /v1/images/generations 同步生成。`
    );
  }

  async listNativeGenerations(query: Record<string, any>, context: ImageProviderContext): Promise<any> {
    void query;
    void context;
    return { code: 0, message: "ok", data: [] };
  }

  async createNativeMultiImageToImage(body: any, context: ImageProviderContext): Promise<any> {
    void body;
    void context;
    throw new Error("Kling 多图转图暂不支持 API 模式，请使用网页模式。");
  }

  async getNativeMultiImageToImage(id: string, context: ImageProviderContext): Promise<any> {
    void id;
    void context;
    throw new Error("Kling 多图转图暂不支持 API 模式。");
  }
}
