/**
 * 千问视频模型映射
 *
 * qwen-happyhorse-1.0 → model: "happyhorse", scene: "hh_t2v"
 */

// ─── 模型映射接口 ─────────────────────────────────────────────────

export interface QwenVideoModelMapping {
  /** 内部模型名 */
  model: string;
  /** 轮询场景 */
  scene: string;
  /** 模型描述 */
  description: string;
}

export const QWEN_VIDEO_MODEL_MAP: Record<string, QwenVideoModelMapping> = {
  "qwen-happyhorse-1.0": {
    model: "happyhorse",
    scene: "hh_t2v",
    description: "千问 HappyHorse 1.0 视频生成模型（通过 create.qianwen.com）",
  },
  "qwen-happyhorse": {
    model: "happyhorse",
    scene: "hh_t2v",
    description: "千问 HappyHorse 视频生成模型（别名）",
  },
};

export const DEFAULT_QWEN_VIDEO_MODEL = "qwen-happyhorse-1.0";

export const QWEN_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

// ─── 模型判断 ─────────────────────────────────────────────────────

export function isQwenModelName(model?: string): boolean {
  if (!model) return false;
  return model.toLowerCase().startsWith("qwen-");
}

export function resolveQwenVideoModel(model?: string): QwenVideoModelMapping {
  if (!model) return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
  const lower = model.toLowerCase();
  if (QWEN_VIDEO_MODEL_MAP[lower]) return QWEN_VIDEO_MODEL_MAP[lower];
  // 兼容不带 qwen- 前缀
  const withPrefix = lower.startsWith("qwen-") ? lower : `qwen-${lower}`;
  if (QWEN_VIDEO_MODEL_MAP[withPrefix]) return QWEN_VIDEO_MODEL_MAP[withPrefix];
  return QWEN_VIDEO_MODEL_MAP[DEFAULT_QWEN_VIDEO_MODEL];
}

export function getQwenVideoModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  // 去重（别名模型只返回一个）
  const seen = new Set<string>();
  return Object.entries(QWEN_VIDEO_MODEL_MAP)
    .filter(([_, m]) => {
      if (seen.has(m.model)) return false;
      seen.add(m.model);
      return true;
    })
    .map(([id, mapping]) => ({
      id,
      object: "model",
      owned_by: "images-api",
      description: mapping.description,
    }));
}
