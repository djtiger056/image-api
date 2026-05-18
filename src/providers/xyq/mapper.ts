/**
 * 小云雀模型名映射
 *
 * 将用户友好的模型名映射到云雀平台的实际模型。
 * 云雀平台底层使用 Seedream 模型，通过前缀 "xyq-" 区分来源。
 */

export interface XyqModelMapping {
  /** 用户模型名 */
  modelName: string;
  /** 模型描述 */
  description: string;
  /** 是否为视频模型 */
  isVideo: boolean;
}

// 用户模型名 → 云雀模型映射
const XYQ_MODEL_MAP: Record<string, XyqModelMapping> = {
  "xyq-seedream-5.0": {
    modelName: "xyq-seedream-5.0",
    description: "小云雀 Seedream 5.0 生图模型（最新）",
    isVideo: false,
  },
  "xyq-seedream-4.5": {
    modelName: "xyq-seedream-4.5",
    description: "小云雀 Seedream 4.5 生图模型",
    isVideo: false,
  },
  "xyq-seedream-4.0": {
    modelName: "xyq-seedream-4.0",
    description: "小云雀 Seedream 4.0 生图模型",
    isVideo: false,
  },
  "xyq-seedance-2.0": {
    modelName: "xyq-seedance-2.0",
    description: "小云雀 Seedance 2.0 视频生成模型",
    isVideo: true,
  },
  "xyq-seedance-2.0-fast": {
    modelName: "xyq-seedance-2.0-fast",
    description: "小云雀 Seedance 2.0 Fast 快速视频生成模型",
    isVideo: true,
  },
};

export const DEFAULT_XYQ_MODEL = "xyq-seedream-5.0";
export const DEFAULT_GEN_MODEL = "Seedream 5.0";

// 支持的宽高比
export const XYQ_RATIOS = [
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
export const XYQ_STYLES = [
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
 * 判断模型名是否为云雀模型
 */
export function isXyqModelName(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.startsWith("xyq-");
}

/**
 * 判断是否为云雀视频模型
 */
export function isXyqVideoModel(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.startsWith("xyq-") && (lower.includes("video") || lower.includes("seedance"));
}

/**
 * 将用户模型名映射到云雀内部参数
 */
export function resolveXyqModel(model?: string): XyqModelMapping {
  if (!model) return XYQ_MODEL_MAP[DEFAULT_XYQ_MODEL];

  const lower = model.toLowerCase();

  // 直接匹配
  if (XYQ_MODEL_MAP[lower]) return XYQ_MODEL_MAP[lower];

  // 默认回退到生图模型
  return XYQ_MODEL_MAP[DEFAULT_XYQ_MODEL];
}

/**
 * 标准化比例参数
 */
export function normalizeRatio(ratio?: string): string {
  if (!ratio) return "1:1";
  const normalized = ratio.replace(/\s/g, "");
  if (XYQ_RATIOS.includes(normalized)) return normalized;
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
 */
export function normalizeStyle(style?: string): string {
  if (!style) return "智能";
  if (XYQ_STYLES.includes(style)) return style;
  // 尝试模糊匹配
  const lower = style.toLowerCase();
  const found = XYQ_STYLES.find(
    (s) => s.toLowerCase() === lower || s.includes(style)
  );
  return found || "智能";
}

/**
 * 获取所有云雀模型列表（用于 /v1/models）
 */
export function getXyqModels(): Array<{
  id: string;
  object: string;
  owned_by: string;
  description: string;
}> {
  return Object.entries(XYQ_MODEL_MAP).map(([id, mapping]) => ({
    id,
    object: "model",
    owned_by: "images-api",
    description: mapping.description,
  }));
}
