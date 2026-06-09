/**
 * 生成历史 API 路由
 *
 * 提供历史记录的查询、删除、统计接口
 * 以及 output/ 目录的本地文件服务
 */

import fs from 'fs-extra';
import path from 'path';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import historyManager from '@/lib/history-manager.ts';
import logger from '@/lib/logger.ts';

const ROOT_DIR = path.resolve();

// MIME 类型映射
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
};

export default {
  prefix: '/admin/history',

  get: {
    /**
     * GET /admin/history
     * 获取历史记录列表（分页）
     * Query: page, pageSize, type (image|video), provider
     */
    '': async (request: Request) => {
      const page = Math.max(1, parseInt(String(request.query.page || '1')) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(String(request.query.pageSize || '20')) || 20));
      const type = request.query.type as 'image' | 'video' | undefined;
      const provider = request.query.provider as string | undefined;

      return historyManager.getHistoryList({ page, pageSize, type, provider });
    },

    /**
     * GET /admin/history/stats
     * 获取统计信息
     */
    '/stats': async () => {
      return historyManager.getHistoryStats();
    },

    /**
     * GET /admin/history/:id
     * 获取单条历史记录
     */
    '/:id': async (request: Request) => {
      const record = historyManager.getHistoryById(request.params.id);
      if (!record) {
        throw new Error(`记录 ${request.params.id} 不存在`);
      }
      return record;
    },

    /**
     * GET /admin/history/file/:path*
     * 服务本地文件（图片/视频）
     * 路径: /admin/history/file/output/2026-06-08/xxx.png
     */
    '/file/:path+': async (request: Request) => {
      // 从 params 中提取文件路径
      let filePath = request.params.path || '';
      // 去掉查询参数
      filePath = filePath.split('?')[0];

      // 安全检查：防止路径遍历
      if (filePath.includes('..') || filePath.includes('\\')) {
        throw new Error('非法路径');
      }

      // 确保路径以 output/ 开头
      if (!filePath.startsWith('output/')) {
        filePath = 'output/' + filePath;
      }

      const fullPath = path.join(ROOT_DIR, filePath);

      // 确保文件在 output 目录内
      const resolvedPath = path.resolve(fullPath);
      const resolvedOutput = path.resolve(path.join(ROOT_DIR, 'output'));
      if (!resolvedPath.startsWith(resolvedOutput)) {
        throw new Error('非法路径');
      }

      if (!fs.existsSync(fullPath)) {
        throw new Error('文件不存在');
      }

      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullPath);

      const content = fs.readFileSync(fullPath);
      return new Response(content, {
        type: 'raw',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
          'Cache-Control': 'public, max-age=86400',
          'Accept-Ranges': 'bytes',
        },
      });
    },
  },

  delete: {
    /**
     * DELETE /admin/history/:id
     * 删除单条历史记录
     */
    '/:id': async (request: Request) => {
      const success = historyManager.deleteHistory(request.params.id);
      if (!success) {
        throw new Error(`记录 ${request.params.id} 不存在`);
      }
      return { success: true, message: '已删除' };
    },

    /**
     * DELETE /admin/history
     * 清空所有历史记录
     */
    '': async () => {
      const count = historyManager.clearHistory();
      return { success: true, message: `已清空 ${count} 条记录` };
    },
  },
};
