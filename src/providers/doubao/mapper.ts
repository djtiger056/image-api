/**
 * 豆包模型名映射
 *
 * 将用户友好的模型名映射到豆包内部的 genModel 参数。
 * 豆包的生图模型统一走 /samantha/chat/completion，
 * 通过消息体中的 model 字段区分不同版本。
 */

export interface DoubaoModelMapping {
  /** 内部 genModel 名称（传给豆包 API 的 model 字段） */
  genModel: string;
  /** 模型描述 */
  description: string;
}

// 用户模型名 → 豆包内部模型映射
const DOUBAO_MODEL_MAP: Record<string, DoubaoModelMapping> = {
  "doubao-seedream-5.0-lite": {
    genModel: "Seedream 5.0 lite",
    description: "豆包 Seedream 5.0 Lite 生图模型（最新，支持联网检索）",
  },
  "doubao-seedream-4.5": {
    genModel: "Seedream 4.5",
    description: "豆包 Seedream 4.5 生图模型",
  },
  "doubao-seedream-4.0": {
    genModel: "Seedream 4.0",
    description: "豆包 Seedream 4.0 生图模型",
  },
};

export const DEFAULT_DOUBAO_MODEL = "doubao-seedream-5.0-lite";
export const DEFAULT_GEN_MODEL = "Seedream 5.0 lite";

// 支持的宽高比
export const DOUBAO_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
];

// 支持的风格
export const DOUBAO_STYLES = [
  "智能",
  "写实",
  "动漫",
  "油画",
  "水彩",
  "素描",
  "赛博朋克",
  "中国风",
  "复古",
  "极简",
];

/**
 * 判断模型名是否为豆包图片模型（排除视频模型）
 */
export function isDoubaoModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  // 视频模型不走图片 provider
  if (lower.startsWith("doubao-seedance-") || lower.startsWith("doubao-seed2fast") || lower.startsWith("doubao-video-")) {
    return false;
  }
  return lower.startsWith("doubao-") || lower.startsWith("seedream-");
}

/**
 * 将用户模型名映射到豆包内部参数
 */
export function resolveDoubaoModel(model?: string): DoubaoModelMapping {
  if (!model) return { genModel: DEFAULT_GEN_MODEL, description: "" };

  const lower = model.toLowerCase();

  // 直接匹配
  if (DOUBAO_MODEL_MAP[lower]) return DOUBAO_MODEL_MAP[lower];

  // 兼容 seedream-4.5 等不带 doubao- 前缀的写法
  const withPrefix = lower.startsWith("doubao-") ? lower : `doubao-${lower}`;
  if (DOUBAO_MODEL_MAP[withPrefix]) return DOUBAO_MODEL_MAP[withPrefix];

  // 如果是纯 Seedream X.X 格式，直接透传
  if (lower.startsWith("seedream ")) {
    return { genModel: model, description: `豆包 ${model} 生图模型` };
  }

  // 默认回退
  return { genModel: DEFAULT_GEN_MODEL, description: "" };
}

/**
 * 标准化比例参数
 */
export function normalizeRatio(ratio?: string): string {
  if (!ratio) return "1:1";
  const normalized = ratio.replace(/\s/g, "");
  if (DOUBAO_RATIOS.includes(normalized)) return normalized;
  // 尝试匹配常见别名
  const aliasMap: Record<string, string> = {
    "1x1": "1:1",
    "4x3": "4:3",
    "3x4": "3:4",
    "16x9": "16:9",
    "9x16": "9:16",
    landscape: "16:9",
    portrait: "9:16",
    square: "1:1",
  };
  return aliasMap[normalized.toLowerCase()] || "1:1";
}

/**
 * 标准化风格参数
 * 返回空字符串表示不指定风格（不传给豆包 API）
 */
export function normalizeStyle(style?: string): string {
  if (!style || style === "不指定" || style === "none" || style === "auto") return "";
  if (DOUBAO_STYLES.includes(style)) return style;
  // 尝试模糊匹配
  const lower = style.toLowerCase();
  const found = DOUBAO_STYLES.find(
    (s) => s.toLowerCase() === lower || s.includes(style)
  );
  return found || "";
}

/**
 * 获取所有豆包模型列表（用于 /v1/models）
 */
export function getDoubaoModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  return Object.entries(DOUBAO_MODEL_MAP).map(([id, mapping]) => ({
    id,
    object: "model",
    owned_by: "images-api",
    description: mapping.description,
  }));
}
