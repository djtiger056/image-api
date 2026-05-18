import { UnifiedImageGenerateInput } from "@/providers/types.ts";

export const DEFAULT_KLING_MODEL = "kling-v2-1";

function encodeBinaryImage(image: Buffer | string): string {
  return Buffer.isBuffer(image) ? image.toString("base64") : image;
}

export function isKlingModelName(model?: string): boolean {
  return !!model && model.toLowerCase().startsWith("kling-");
}

export function isKlingNativeGenerationBody(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  return Boolean(
    body.model_name ||
      body.aspect_ratio ||
      body.external_task_id ||
      body.callback_url ||
      body.watermark_info ||
      body.image_reference ||
      body.element_list
  );
}

export function isKlingNativeMultiImageBody(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  return Boolean(
    Array.isArray(body.subject_image_list) ||
      body.scene_image ||
      body.style_image
  );
}

export function mapUnifiedToKlingGenerationBody(input: UnifiedImageGenerateInput) {
  if (input.images && input.images.length > 1) {
    throw new Error(
      "Kling 统一接口当前只支持单图图生图；多图请改用 POST /v1/images/multi-image2image。"
    );
  }

  return {
    model_name: input.model || DEFAULT_KLING_MODEL,
    prompt: input.prompt,
    negative_prompt: input.negativePrompt || "",
    ...(input.images && input.images[0]
      ? { image: encodeBinaryImage(input.images[0]) }
      : {}),
    ...(input.ratio ? { aspect_ratio: input.ratio } : {}),
    ...(input.n ? { n: input.n } : {}),
    ...(input.providerOptions || {}),
  };
}
