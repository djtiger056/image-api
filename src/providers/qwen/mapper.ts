/**
 * 千问 (Qwen) 视频模型映射
 */

export interface QwenVideoModelMapping {
  model: string;
  scene: string;
  description: string;
}

const QWEN_VIDEO_MODEL_MAP: Record<string, QwenVideoModelMapping> = {
  "qwen-happyhorse-1.0": {
    model: "happyhorse",
    scene: "hh_t2v",
    description: "千问 HappyHorse 1.0 视频生成模型（每日有限免费额度）",
  },
};

export const DEFAULT_QWEN_VIDEO_MODEL = "qwen-happyhorse-1.0";

export const QWEN_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

export function isQwenModelName(model?: string): boolean {
  if (!model) return false;
  return model.toLowerCase().startsWith("qwen-");
}

export function resolveQwenVideoModel(model?: string): QwenVideoModelMapping {
  if (!model) return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
  const lower = model.toLowerCase();
  if (QWEN_VIDEO_MODEL_MAP[lower]) return QWEN_VIDEO_MODEL_MAP[lower];
  const withPrefix = lower.startsWith("qwen-") ? lower : `qwen-${lower}`;
  if (QWEN_VIDEO_MODEL_MAP[withPrefix]) return QWEN_VIDEO_MODEL_MAP[withPrefix];
  return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
}

export function normalizeQwenRatio(ratio?: string): string {
  if (!ratio) return "16:9";
  const normalized = ratio.replace(/\s/g, "");
  if (QWEN_VIDEO_RATIOS.includes(normalized)) return normalized;
  const aliasMap: Record<string, string> = {
    "16x9": "16:9", "9x16": "9:16", "1x1": "1:1",
    "4x3": "4:3", "3x4": "3:4",
    landscape: "16:9", portrait: "9:16", square: "1:1",
  };
  return aliasMap[normalized.toLowerCase()] || "16:9";
}

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
