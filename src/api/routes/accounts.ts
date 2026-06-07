/**
 * 账号管理 API 路由
 *
 * 提供完整的账号 CRUD、健康检查、统计、API Key 管理等接口
 * 所有接口需要 SERVER_API_KEYS 鉴权
 */

import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import accountManager from '@/lib/account-manager.ts';
import type { Platform } from '@/lib/account-manager.ts';

export default {
  prefix: '/admin',

  get: {
    // ── 统计概览 ──
    '/stats': async (_request: Request) => {
      return accountManager.getStats();
    },

    // ── 账号列表（可选 refresh_credits=true 触发积分刷新）──
    '/accounts': async (request: Request) => {
      const platform = request.query.platform as Platform | undefined;
      const refreshCredits = ['1', 'true', 'yes'].includes(String(request.query.refresh_credits || '').toLowerCase());
      let creditRefresh = accountManager.getCreditRefreshStatus();
      if (refreshCredits) {
        creditRefresh = accountManager.startCreditRefresh();
      }
      return {
        accounts: accountManager.getAccountsView(platform),
        total: accountManager.getAccounts(platform).length,
        credit_refresh: creditRefresh,
      };
    },

    // ── 单个账号详情 ──
    '/accounts/:id': async (request: Request) => {
      const id = request.params.id;
      const view = accountManager.getAccountsView().find((a: any) => a.id === id);
      if (!view) throw new Error(`账号 ${id} 不存在`);
      return view;
    },

    // ── API Key 列表 ──
    '/api-keys': async (_request: Request) => {
      return {
        keys: accountManager.getApiKeys().map(k => ({
          id: k.id,
          key: k.key.slice(0, 10) + '...' + k.key.slice(-4),
          name: k.name,
          rate_limit: k.rate_limit,
          allowed_platforms: k.allowed_platforms,
          total_calls: k.total_calls,
          last_used_at: k.last_used_at,
          created_at: k.created_at,
          enabled: k.enabled,
        })),
      };
    },

    // ── 系统设置 ──
    '/settings': async (_request: Request) => {
      return accountManager.getSettings();
    },
  },

  post: {
    // ── 添加账号 ──
    '/accounts': async (request: Request) => {
      const { platform, ...data } = request.body || {};
      if (!platform || !['jimeng', 'doubao', 'kling', 'xyq', 'qwen'].includes(platform)) {
        throw new Error('请指定有效的 platform (jimeng/doubao/kling/xyq/qwen)');
      }
      const account = accountManager.addAccount(platform as Platform, data);
      return account;
    },

    // ── 批量导入账号 ──
    '/accounts/import': async (request: Request) => {
      const { platform, accounts } = request.body || {};
      if (!platform || !Array.isArray(accounts)) {
        throw new Error('请提供 platform 和 accounts 数组');
      }
      const imported = accountManager.importAccounts(platform as Platform, accounts);
      return { imported: imported.length, accounts: imported };
    },

    // ── 账号健康检查 ──
    '/accounts/check': async (request: Request) => {
      const { id } = request.body || {};
      if (id) {
        // 检查单个账号
        await accountManager.runHealthCheck();
        const view = accountManager.getAccountsView().find((a: any) => a.id === id);
        return view || { error: '账号不存在' };
      }
      // 检查所有
      await accountManager.runHealthCheck();
      return { ok: true, message: '健康检查完成', stats: accountManager.getStats() };
    },

    // ── 每日重置 ──
    '/accounts/reset-daily': async (_request: Request) => {
      accountManager.resetDaily();
      return { ok: true, message: '每日计数已重置' };
    },

    // ── 添加 API Key ──
    '/api-keys': async (request: Request) => {
      const key = accountManager.addApiKey(request.body || {});
      return { id: key.id, key: key.key, name: key.name };
    },

    // ── 更新设置 ──
    '/settings': async (request: Request) => {
      return accountManager.updateSettings(request.body || {});
    },
  },

  put: {
    // ── 更新账号 ──
    '/accounts/:id': async (request: Request) => {
      const id = request.params.id;
      const updated = accountManager.updateAccount(id, request.body || {});
      if (!updated) throw new Error(`账号 ${id} 不存在`);
      return updated;
    },

    // ── 切换 API Key 状态 ──
    '/api-keys/:id/toggle': async (request: Request) => {
      const id = request.params.id;
      const { enabled } = request.body || {};
      const ok = accountManager.toggleApiKey(id, enabled !== false);
      if (!ok) throw new Error(`API Key ${id} 不存在`);
      return { ok: true };
    },
  },

  delete: {
    // ── 删除账号 ──
    '/accounts/:id': async (request: Request) => {
      const id = request.params.id;
      const ok = accountManager.deleteAccount(id);
      if (!ok) throw new Error(`账号 ${id} 不存在`);
      return { ok: true, message: `账号 ${id} 已删除` };
    },

    // ── 删除 API Key ──
    '/api-keys/:id': async (request: Request) => {
      const id = request.params.id;
      const ok = accountManager.deleteApiKey(id);
      if (!ok) throw new Error(`API Key ${id} 不存在`);
      return { ok: true, message: `API Key ${id} 已删除` };
    },
  },
};
