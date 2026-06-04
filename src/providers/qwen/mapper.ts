/**
 * 千问 (Qwen) 模型映射
 *
 * 覆盖视频模型（HappyHorse / Wan 2.6 / Wan 2.7）和图片模型（Qwen-Image 2.0 / 1.0 专业版）。
 */

// ─── 视频模型 ──────────────────────────────────────────────────────

export interface QwenVideoModelMapping {
  model: string;
  description: string;
  backend: "qianwen-web" | "dashscope";
  scene?: string;
  sceneWithImage?: string;
  dashscopeModel?: string;
  resolutions?: string[];
  durations?: number[];
  defaultDuration?: number;
  defaultResolution?: string;
  supportsImageInput?: boolean;
}

const QWEN_VIDEO_MODEL_MAP: Record<string, QwenVideoModelMapping> = {
  "qwen-happyhorse-1.0": {
    model: "happyhorse",
    description: "千问 HappyHorse 1.0 视频生成模型（每日有限免费额度）",
    backend: "qianwen-web",
    scene: "hh_t2v",
    resolutions: ["720P"],
    durations: [5, 10],
    defaultDuration: 10,
    defaultResolution: "720P",
    supportsImageInput: false,
  },
  "wan2.6-t2v": {
    model: "wan2.6-t2v",
    description: "通义万相 Wan 2.6 文生视频模型（DashScope）",
    backend: "dashscope",
    dashscopeModel: "wan2.6-t2v",
    resolutions: ["720P", "1080P"],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    defaultResolution: "1080P",
    supportsImageInput: false,
  },
  "wan2.7-t2v": {
    model: "wan27",
    description: "通义万相 Wan 2.7 视频模型（千问创作网页端）",
    backend: "qianwen-web",
    scene: "wan27_t2v",
    sceneWithImage: "wan27_first_frame_i2v",
    resolutions: ["720P", "1080P"],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    defaultResolution: "1080P",
    supportsImageInput: true,
  },
};

export const DEFAULT_QWEN_VIDEO_MODEL = "qwen-happyhorse-1.0";

export const QWEN_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

// ─── 图片模型 ──────────────────────────────────────────────────────

export interface QwenImageModelMapping {
  modelKey: string;
  rootModel: string;
  sceneT2I: string;
  sceneI2I: string;
  description: string;
}

const QWEN_IMAGE_MODEL_MAP: Record<string, QwenImageModelMapping> = {
  "wan2.7-image": {
    modelKey: "wan27_image",
    rootModel: "wan27_image",
    sceneT2I: "wan27_image_txt_to_image",
    sceneI2I: "wan27_image_txt_to_image",
    description: "通义万相 Wan 2.7-Image 生图模型（最新，支持多图参考）",
  },
  "qwen-image-2.0": {
    modelKey: "qwen_image",
    rootModel: "qwen2",
    sceneT2I: "qwen2_t2i",
    sceneI2I: "qwen2_i2i",
    description: "千问 Qwen-Image 2.0 高质感生图模型（免费）",
  },
  "qwen-image-1.0-pro": {
    modelKey: "qwen_full",
    rootModel: "qwen_full",
    sceneT2I: "qwen_full_txt_to_image",
    sceneI2I: "qwen_full_image_to_image",
    description: "千问 Qwen-Image 1.0 专业版生图模型（免费）",
  },
  "qwen-image-1.0": {
    modelKey: "qwen",
    rootModel: "qwen",
    sceneT2I: "qwen_txt_to_image",
    sceneI2I: "qwen_image_to_image",
    description: "千问 Qwen-Image 1.0 生图模型（免费）",
  },
};

export const DEFAULT_QWEN_IMAGE_MODEL = "wan2.7-image";

export const QWEN_IMAGE_RATIOS = [
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "auto",
];

// ─── 模型名判断 ────────────────────────────────────────────────────

/**
 * 判断模型名是否为千问视频模型（HappyHorse / Wan 2.x）
 */
export function isQwenVideoModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  // wan2.7-image 是图片模型，排除
  if (lower.startsWith("wan2.") && lower.includes("image")) return false;
  return (
    lower.startsWith("qwen-happyhorse") ||
    lower.startsWith("wan2.") ||
    lower.startsWith("wanx2.")
  );
}

/**
 * 判断模型名是否为千问图片模型（qwen-image-*）
 */
export function isQwenImageModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return (
    lower.startsWith("qwen-image") ||
    lower.startsWith("wan2.7-image") ||
    lower === "qwen" ||
    lower === "qwen-full"
  );
}

/**
 * 判断模型名是否为任意千问模型（视频或图片）
 */
export function isQwenModelName(model?: string): boolean {
  if (!model) return false;
  return (
    isQwenVideoModelName(model) || isQwenImageModelName(model)
  );
}

// ─── 模型解析 ──────────────────────────────────────────────────────

export function resolveQwenVideoModel(model?: string): QwenVideoModelMapping {
  if (!model) return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
  const lower = model.toLowerCase();
  if (QWEN_VIDEO_MODEL_MAP[lower]) return QWEN_VIDEO_MODEL_MAP[lower];
  if (lower.startsWith("wan2.7")) {
    return (
      QWEN_VIDEO_MODEL_MAP[lower] ||
      QWEN_VIDEO_MODEL_MAP["wan2.7-t2v"] ||
      QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL]
    );
  }
  if (lower.startsWith("wan2.6")) {
    return (
      QWEN_VIDEO_MODEL_MAP[lower] ||
      QWEN_VIDEO_MODEL_MAP["wan2.6-t2v"] ||
      QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL]
    );
  }
  const withPrefix = lower.startsWith("qwen-") ? lower : `qwen-${lower}`;
  if (QWEN_VIDEO_MODEL_MAP[withPrefix]) return QWEN_VIDEO_MODEL_MAP[withPrefix];
  return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
}

export function resolveQwenImageModel(model?: string): QwenImageModelMapping {
  if (!model) return QWEN_IMAGE_MODEL_MAP[DEFAULT_QWEN_IMAGE_MODEL];
  const lower = model.toLowerCase();
  if (QWEN_IMAGE_MODEL_MAP[lower]) return QWEN_IMAGE_MODEL_MAP[lower];
  const withPrefix = lower.startsWith("qwen-") ? lower : `qwen-${lower}`;
  if (QWEN_IMAGE_MODEL_MAP[withPrefix])
    return QWEN_IMAGE_MODEL_MAP[withPrefix];
  return QWEN_IMAGE_MODEL_MAP[DEFAULT_QWEN_IMAGE_MODEL];
}

// ─── 比例标准化 ────────────────────────────────────────────────────

export function normalizeQwenRatio(ratio?: string): string {
  if (!ratio) return "1:1";
  const normalized = ratio.replace(/\s/g, "");
  if (QWEN_IMAGE_RATIOS.includes(normalized)) return normalized;
  if (QWEN_VIDEO_RATIOS.includes(normalized)) return normalized;
  const aliasMap: Record<string, string> = {
    "16x9": "16:9", "9x16": "9:16", "1x1": "1:1",
    "4x3": "4:3", "3x4": "3:4",
    landscape: "16:9", portrait: "9:16", square: "1:1",
  };
  return aliasMap[normalized.toLowerCase()] || "1:1";
}

export function normalizeQwenVideoResolution(
  model?: string,
  resolution?: string
): string {
  const mapping = resolveQwenVideoModel(model);
  const allowed = (mapping.resolutions || ["720P"]).map((item) =>
    String(item).toUpperCase()
  );
  const normalized = String(resolution || "")
    .trim()
    .toUpperCase();
  if (normalized && allowed.includes(normalized)) return normalized;
  return String(mapping.defaultResolution || allowed[0] || "720P").toUpperCase();
}

export function normalizeQwenVideoDuration(
  model?: string,
  duration?: number
): number {
  const mapping = resolveQwenVideoModel(model);
  const allowed = mapping.durations || [];
  const numeric = Number(duration);
  if (Number.isFinite(numeric) && allowed.includes(numeric)) return numeric;
  return Number(mapping.defaultDuration || allowed[0] || 5);
}

// ─── 模型列表 ──────────────────────────────────────────────────────

export function getQwenVideoModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  return Object.entries(QWEN_VIDEO_MODEL_MAP).map(([id, mapping]) => ({
    id,
    object: "model",
    owned_by: "images-api",
    description: mapping.description,
  }));
}

export function getQwenImageModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  return Object.entries(QWEN_IMAGE_MODEL_MAP).map(([id, mapping]) => ({
    id,
    object: "model",
    owned_by: "images-api",
    description: mapping.description,
  }));
}
