/**
 * 生成历史管理器
 *
 * 负责：
 * 1. 生成完成后自动下载图片/视频到本地 output/ 目录
 * 2. 用 JSON 文件记录每次生成的元数据（prompt、模型、时间、本地路径等）
 * 3. 提供查询/删除接口供管理面板使用
 */

import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import logger from './logger.ts';

// ─── 路径常量 ──────────────────────────────────────────
const ROOT_DIR = path.resolve();
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const CONFIG_PATH = path.join(ROOT_DIR, 'configs', 'history.json');

// ─── 类型定义 ──────────────────────────────────────────
export interface HistoryRecord {
  id: string;
  type: 'image' | 'video';
  provider: string;
  model: string;
  prompt: string;
  created_at: string;        // ISO 时间戳
  media_files: MediaFile[];
  status: 'success' | 'failed';
  error?: string;
  extra?: Record<string, any>;  // 附加信息（ratio, duration 等）
}

export interface MediaFile {
  filename: string;          // 本地文件名
  local_path: string;        // 相对路径 (output/YYYY-MM-DD/xxx.png)
  original_url: string;      // 原始平台 URL
  content_type: string;      // MIME type
  file_size: number;         // 字节数
}

// ─── 内部状态 ──────────────────────────────────────────
let historyCache: HistoryRecord[] = [];
let initialized = false;

// ─── 初始化 ──────────────────────────────────────────
function ensureInitialized() {
  if (initialized) return;
  fs.ensureDirSync(OUTPUT_DIR);
  fs.ensureDirSync(path.dirname(CONFIG_PATH));
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      historyCache = fs.readJsonSync(CONFIG_PATH);
    } catch {
      historyCache = [];
    }
  }
  initialized = true;
}

function saveHistory() {
  ensureInitialized();
  try {
    fs.writeJsonSync(CONFIG_PATH, historyCache, { spaces: 2 });
  } catch (err) {
    logger.error(`[HistoryManager] 保存历史记录失败: ${(err as Error).message}`);
  }
}

// ─── 文件下载 ──────────────────────────────────────────

/**
 * 从 URL 下载文件到本地
 * @returns 本地文件的相对路径 (output/YYYY-MM-DD/filename.ext)
 */
async function downloadFile(url: string, type: 'image' | 'video'): Promise<{
  local_path: string;
  filename: string;
  content_type: string;
  file_size: number;
}> {
  ensureInitialized();

  // 日期子目录
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dateDir = path.join(OUTPUT_DIR, dateStr);
  fs.ensureDirSync(dateDir);

  // 生成文件名: uuid + 推断的扩展名
  const ext = inferExtension(url, type);
  const filename = `${uuidv4().slice(0, 8)}${ext}`;
  const filePath = path.join(dateDir, filename);
  const relativePath = `output/${dateStr}/${filename}`;

  // 下载
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120_000,  // 2分钟超时（视频可能较大）
    maxContentLength: 500 * 1024 * 1024, // 500MB
  });

  const buffer = Buffer.from(response.data);
  fs.writeFileSync(filePath, buffer);

  const contentType = response.headers['content-type'] || guessContentType(type, ext);

  logger.info(`[HistoryManager] 文件已下载: ${relativePath} (${formatSize(buffer.length)})`);

  return {
    local_path: relativePath,
    filename,
    content_type: contentType,
    file_size: buffer.length,
  };
}

/**
 * 批量下载多个 URL
 */
async function downloadFiles(urls: string[], type: 'image' | 'video'): Promise<MediaFile[]> {
  const results: MediaFile[] = [];

  // 并发下载（最多 4 个并发）
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 4) {
    chunks.push(urls.slice(i, i + 4));
  }

  for (const chunk of chunks) {
    const downloaded = await Promise.all(
      chunk.map(async (url) => {
        try {
          const file = await downloadFile(url, type);
          return {
            ...file,
            original_url: url,
          };
        } catch (err) {
          logger.error(`[HistoryManager] 下载失败: ${url} - ${(err as Error).message}`);
          return null;
        }
      })
    );

    for (const file of downloaded) {
      if (file) results.push(file);
    }
  }

  return results;
}

// ─── 记录生成历史 ──────────────────────────────────────

/**
 * 记录一次图片生成
 */
export async function recordImageGeneration(params: {
  provider: string;
  model: string;
  prompt: string;
  imageUrls: string[];
  extra?: Record<string, any>;
}): Promise<HistoryRecord> {
  const { provider, model, prompt, imageUrls, extra } = params;

  const record: HistoryRecord = {
    id: uuidv4().slice(0, 12),
    type: 'image',
    provider,
    model: model || 'default',
    prompt,
    created_at: new Date().toISOString(),
    media_files: [],
    status: 'success',
    extra,
  };

  try {
    record.media_files = await downloadFiles(imageUrls, 'image');
    if (record.media_files.length === 0) {
      record.status = 'failed';
      record.error = '所有文件下载失败';
    }
  } catch (err) {
    record.status = 'failed';
    record.error = (err as Error).message;
  }

  // 存入历史（最新的在前面）
  ensureInitialized();
  historyCache.unshift(record);
  saveHistory();

  logger.info(`[HistoryManager] 图片生成已记录: ${record.id} (${record.media_files.length} 个文件)`);
  return record;
}

/**
 * 记录一次视频生成
 */
export async function recordVideoGeneration(params: {
  provider: string;
  model: string;
  prompt: string;
  videoUrls: string[];
  extra?: Record<string, any>;
}): Promise<HistoryRecord> {
  const { provider, model, prompt, videoUrls, extra } = params;

  const record: HistoryRecord = {
    id: uuidv4().slice(0, 12),
    type: 'video',
    provider,
    model: model || 'default',
    prompt,
    created_at: new Date().toISOString(),
    media_files: [],
    status: 'success',
    extra,
  };

  try {
    record.media_files = await downloadFiles(videoUrls, 'video');
    if (record.media_files.length === 0) {
      record.status = 'failed';
      record.error = '所有文件下载失败';
    }
  } catch (err) {
    record.status = 'failed';
    record.error = (err as Error).message;
  }

  ensureInitialized();
  historyCache.unshift(record);
  saveHistory();

  logger.info(`[HistoryManager] 视频生成已记录: ${record.id} (${record.media_files.length} 个文件)`);
  return record;
}

// ─── 查询接口 ──────────────────────────────────────────

/**
 * 获取历史记录列表（分页）
 */
export function getHistoryList(options: {
  page?: number;
  pageSize?: number;
  type?: 'image' | 'video';
  provider?: string;
} = {}): {
  records: HistoryRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} {
  ensureInitialized();

  const { page = 1, pageSize = 20, type, provider } = options;
  let filtered = [...historyCache];

  if (type) filtered = filtered.filter(r => r.type === type);
  if (provider) filtered = filtered.filter(r => r.provider === provider);

  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const records = filtered.slice(start, start + pageSize);

  return { records, total, page, pageSize, totalPages };
}

/**
 * 获取单条历史记录
 */
export function getHistoryById(id: string): HistoryRecord | undefined {
  ensureInitialized();
  return historyCache.find(r => r.id === id);
}

/**
 * 删除历史记录（同时删除本地文件）
 */
export function deleteHistory(id: string): boolean {
  ensureInitialized();
  const index = historyCache.findIndex(r => r.id === id);
  if (index === -1) return false;

  const record = historyCache[index];

  // 删除本地文件
  for (const file of record.media_files) {
    const fullPath = path.join(ROOT_DIR, file.local_path);
    try {
      if (fs.existsSync(fullPath)) {
        fs.removeSync(fullPath);
        logger.info(`[HistoryManager] 已删除文件: ${file.local_path}`);
      }
    } catch (err) {
      logger.warn(`[HistoryManager] 删除文件失败: ${file.local_path} - ${(err as Error).message}`);
    }
  }

  historyCache.splice(index, 1);
  saveHistory();
  return true;
}

/**
 * 清空所有历史记录
 */
export function clearHistory(): number {
  ensureInitialized();
  const count = historyCache.length;

  // 删除所有本地文件
  for (const record of historyCache) {
    for (const file of record.media_files) {
      const fullPath = path.join(ROOT_DIR, file.local_path);
      try {
        if (fs.existsSync(fullPath)) fs.removeSync(fullPath);
      } catch { /* 忽略 */ }
    }
  }

  historyCache = [];
  saveHistory();
  return count;
}

/**
 * 获取统计信息
 */
export function getHistoryStats(): {
  total_records: number;
  total_images: number;
  total_videos: number;
  total_files: number;
  total_size: number;
  providers: Record<string, number>;
} {
  ensureInitialized();

  const stats = {
    total_records: historyCache.length,
    total_images: historyCache.filter(r => r.type === 'image').length,
    total_videos: historyCache.filter(r => r.type === 'video').length,
    total_files: 0,
    total_size: 0,
    providers: {} as Record<string, number>,
  };

  for (const record of historyCache) {
    stats.total_files += record.media_files.length;
    stats.total_size += record.media_files.reduce((sum, f) => sum + f.file_size, 0);
    stats.providers[record.provider] = (stats.providers[record.provider] || 0) + 1;
  }

  return stats;
}

// ─── 工具函数 ──────────────────────────────────────────

function inferExtension(url: string, type: 'image' | 'video'): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase().split('?')[0];
    if (ext && ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm'].includes(ext)) {
      return ext;
    }
  } catch { /* URL 解析失败 */ }
  return type === 'video' ? '.mp4' : '.png';
}

function guessContentType(type: 'image' | 'video', ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  return map[ext] || (type === 'video' ? 'video/mp4' : 'image/png');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default {
  recordImageGeneration,
  recordVideoGeneration,
  getHistoryList,
  getHistoryById,
  deleteHistory,
  clearHistory,
  getHistoryStats,
};
