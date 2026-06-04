import { UnifiedImageGenerateInput } from "@/providers/types.ts";

export const DEFAULT_KLING_MODEL = "3.0";

const KLING_MODEL_MAP: Record<string, string> = {
  "kling-3-0": "3.0",
  "3.0": "3.0",
  "kling-v3-omni": "3.0",
  "kling-image-o1": "3.0",
};

export function isKlingModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.startsWith("kling-") || Object.prototype.hasOwnProperty.call(KLING_MODEL_MAP, lower);
}

export function resolveKlingKolorsVersion(model?: string): string {
  if (!model) return DEFAULT_KLING_MODEL;
  const lower = model.toLowerCase();
  if (KLING_MODEL_MAP[lower]) return KLING_MODEL_MAP[lower];
  if (lower.startsWith("kling-")) return DEFAULT_KLING_MODEL;
  return model;
}

const ASPECT_RATIO_MAP: Record<string, string> = {
  "1:1": "1:1",
  "16:9": "16:9",
  "9:16": "9:16",
  "4:3": "4:3",
  "3:4": "3:4",
  "2:3": "2:3",
  "3:2": "3:2",
  "21:9": "21:9",
  "9:21": "9:21",
};

/**
 * 构建 Kling 真实 API 的 task/submit 请求体
 * 格式: { type, inputs, arguments[], callbackPayloads[] }
 */
export function buildKlingTaskSubmitBody(input: UnifiedImageGenerateInput): Record<string, any> {
  const kolorsVersion = resolveKlingKolorsVersion(input.model);
  const aspectRatio = input.ratio
    ? (ASPECT_RATIO_MAP[input.ratio] || input.ratio)
    : "3:4";
  const imageCount = String(input.n && input.n > 0 ? Math.min(input.n, 4) : 1);
  const resolution = input.resolution === "2k" ? "2k" : "1k";

  const argumentsList: Array<Record<string, any>> = [
    { name: "prompt", value: input.prompt },
    { name: "rich_prompt", value: input.prompt },
    { name: "skill", value: "" },
    { name: "kolors_version", value: kolorsVersion },
    { name: "__isUnLimited", value: false },
    { name: "img_resolution", value: resolution, setByUser: !!input.resolution },
    { name: "aspect_ratio", value: aspectRatio, setByUser: !!input.ratio },
    { name: "imageCount", value: imageCount, setByUser: !!input.n },
    { name: "source", value: "" },
    { name: "paymentMode", value: 1 },
    { name: "showPrice", value: parseInt(imageCount) * 100 },
  ];

  return {
    type: "mmu_img_aiweb",
    inputs: [],
    arguments: argumentsList,
    callbackPayloads: [
      { name: "settingKeys", value: "img_resolution|aspect_ratio|imageCount" },
      { name: "imageMasks", value: "", resources: [] },
      { name: "subjects", value: "[]" },
    ],
  };
}

/**
 * @deprecated 旧的 mapper，仅为向后兼容保留
 */
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
  return buildKlingTaskSubmitBody(input);
}
