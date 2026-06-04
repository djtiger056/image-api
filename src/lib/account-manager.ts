/**
 * 账号管理器 - 多平台多账号统一管理
 *
 * 功能:
 * - 多平台多账号配置读写
 * - 账号健康检查 (token 有效性 + 积分查询)
 * - 智能轮询策略 (random / round-robin / weighted-random / least-used / priority)
 * - 失败自动切换
 * - API Key 管理
 * - 使用统计
 */

import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';

import logger from '@/lib/logger.ts';

// ─── 类型定义 ──────────────────────────────────────────────────────

export type Platform = 'jimeng' | 'doubao' | 'kling' | 'xyq' | 'qwen';
export type RotationStrategy = 'random' | 'round-robin' | 'weighted-random' | 'least-used' | 'priority';
export type AccountStatus = 'active' | 'inactive' | 'error' | 'expired' | 'cooldown';
export type FailoverStrategy = 'priority' | 'round-robin' | 'random';

export interface Account {
  id: string;
  name: string;
  platform: Platform;
  // 凭证 (按平台选用不同字段)
  sessionid?: string;
  authorization?: string;
  access_key?: string;
  secret_key?: string;
  cookie?: string;
  // 状态
  status: AccountStatus;
  priority: number;
  // 统计
  daily_usage: number;
  max_daily_usage: number;
  total_usage: number;
  last_used_at: string | null;
  last_check_at: string | null;
  last_error: string | null;
  // 积分
  points: {
    total: number;
    gift: number;
    purchase: number;
    vip: boolean;
  };
  // 标签 & 备注
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  rate_limit: string;
  allowed_platforms: string[];
  total_calls: number;
  last_used_at: string | null;
  created_at: string;
  enabled: boolean;
}

export interface AccountsConfig {
  accounts: Record<Platform, Account[]>;
  api_keys: ApiKey[];
  settings: {
    health_check_interval_ms: number;
    auto_receive_daily_credits: boolean;
    failover_strategy: FailoverStrategy;
    rotation_strategy: RotationStrategy;
    max_retry_count: number;
  };
}

// ─── 工具函数 ──────────────────────────────────────────────────────

function maskSecret(value?: string): string {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function generateApiKey(): string {
  return `sk-${uuidv4().replace(/-/g, '')}`;
}

// ─── 账号管理器 ─────────────────────────────────────────────────────

class AccountManager {
  private configPath: string;
  private config: AccountsConfig;
  private roundRobinIndex: Map<Platform, number> = new Map();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.configPath = path.resolve('configs/accounts.json');
    this.config = this.loadConfig();
  }

  // ── 配置读写 ──

  private loadConfig(): AccountsConfig {
    try {
      if (fs.pathExistsSync(this.configPath)) {
        const raw = fs.readJsonSync(this.configPath);
        // 确保所有平台都有默认值
        const defaults: AccountsConfig = {
          accounts: { jimeng: [], doubao: [], kling: [], xyq: [], qwen: [] },
          api_keys: [],
          settings: {
            health_check_interval_ms: 300000,
            auto_receive_daily_credits: true,
            failover_strategy: 'priority',
            rotation_strategy: 'weighted-random',
            max_retry_count: 2,
          },
        };
        return _.defaultsDeep(raw, defaults);
      }
    } catch (err) {
      logger.error('[AccountManager] 加载配置失败:', err);
    }
    return {
      accounts: { jimeng: [], doubao: [], kling: [], xyq: [], qwen: [] },
      api_keys: [],
      settings: {
        health_check_interval_ms: 300000,
        auto_receive_daily_credits: true,
        failover_strategy: 'priority',
        rotation_strategy: 'weighted-random',
        max_retry_count: 2,
      },
    };
  }

  private saveConfig(): void {
    try {
      fs.ensureDirSync(path.dirname(this.configPath));
      fs.writeJsonSync(this.configPath, this.config, { spaces: 2 });
    } catch (err) {
      logger.error('[AccountManager] 保存配置失败:', err);
    }
  }

  // ── 初始化 (启动时调用) ──

  init(): void {
    // 从 local.env 迁移旧配置到 accounts.json (首次运行)
    this.migrateFromEnv();
    // 启动健康检查定时器
    this.startHealthCheck();
    const stats = this.getStats();
    logger.info(`[AccountManager] 已加载 ${stats.total} 个账号 (${Object.entries(stats.byPlatform).map(([k, v]) => `${k}:${v}`).join(', ')})`);
  }

  /**
   * 首次运行: 将 local.env 中的凭证迁移到 accounts.json
   */
  private migrateFromEnv(): void {
    const platforms: { key: Platform; envSession: string; envAuth: string }[] = [
      { key: 'jimeng', envSession: 'JIMENG_SESSIONID', envAuth: 'JIMENG_AUTHORIZATION' },
      { key: 'doubao', envSession: 'DOUBAO_SESSIONID', envAuth: 'DOUBAO_AUTHORIZATION' },
      { key: 'xyq', envSession: 'XYQ_SESSIONID', envAuth: 'XYQ_AUTHORIZATION' },
    ];

    for (const { key, envSession, envAuth } of platforms) {
      const existing = this.config.accounts[key];
      if (existing.length > 0) continue; // 已有账号，跳过迁移

      const raw = String(process.env[envAuth] || process.env[envSession] || '').trim();
      if (!raw) continue;

      // 逗号分隔的多 token
      const tokens = raw.replace(/^Bearer\s+/i, '').split(',').filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const account: Account = {
          id: `${key}-migrated-${i + 1}`,
          name: `${key} 迁移账号 #${i + 1}`,
          platform: key,
          sessionid: envAuth ? '' : tokens[i],
          authorization: envAuth ? tokens[i] : '',
          status: 'active',
          priority: 10 - i,
          daily_usage: 0,
          max_daily_usage: 100,
          total_usage: 0,
          last_used_at: null,
          last_check_at: null,
          last_error: null,
          points: { total: 0, gift: 0, purchase: 0, vip: false },
          tags: ['migrated'],
          notes: `从环境变量 ${envAuth || envSession} 自动迁移`,
          created_at: nowISO(),
          updated_at: nowISO(),
        };
        existing.push(account);
      }
      logger.info(`[AccountManager] 已迁移 ${tokens.length} 个 ${key} 账号`);
    }

    // Kling API 密钥迁移
    if (this.config.accounts.kling.length === 0) {
      const ak = String(process.env.KLING_ACCESS_KEY || '').trim();
      const sk = String(process.env.KLING_SECRET_KEY || '').trim();
      if (ak && sk) {
        this.config.accounts.kling.push({
          id: 'kling-migrated-1',
          name: 'Kling API 迁移账号',
          platform: 'kling',
          access_key: ak,
          secret_key: sk,
          status: 'active',
          priority: 10,
          daily_usage: 0,
          max_daily_usage: 50,
          total_usage: 0,
          last_used_at: null,
          last_check_at: null,
          last_error: null,
          points: { total: 0, gift: 0, purchase: 0, vip: false },
          tags: ['migrated'],
          notes: '从环境变量自动迁移',
          created_at: nowISO(),
          updated_at: nowISO(),
        });
      }

      // Kling 浏览器 Cookie 迁移
      const klingCookie = String(process.env.KLING_COOKIE || process.env.KLING_WEB_COOKIES || '').trim();
      if (klingCookie && !ak) {
        this.config.accounts.kling.push({
          id: 'kling-cookie-migrated-1',
          name: 'Kling 网页迁移账号',
          platform: 'kling',
          cookie: klingCookie,
          status: 'active',
          priority: 10,
          daily_usage: 0,
          max_daily_usage: 50,
          total_usage: 0,
          last_used_at: null,
          last_check_at: null,
          last_error: null,
          points: { total: 0, gift: 0, purchase: 0, vip: false },
          tags: ['migrated', 'web'],
          notes: '从环境变量 KLING_COOKIE 自动迁移',
          created_at: nowISO(),
          updated_at: nowISO(),
        });
      }
    }

    this.saveConfig();
  }

  // ── 账号 CRUD ──

  getAccounts(platform?: Platform): Account[] {
    if (platform) return this.config.accounts[platform] || [];
    return Object.values(this.config.accounts).flat();
  }

  getAccount(id: string): Account | undefined {
    return this.getAccounts().find(a => a.id === id);
  }

  addAccount(platform: Platform, data: Partial<Account>): Account {
    if (!this.config.accounts[platform]) {
      this.config.accounts[platform] = [];
    }

    const account: Account = {
      id: data.id || `${platform}-${uuidv4().slice(0, 8)}`,
      name: data.name || `${platform} 账号`,
      platform,
      sessionid: data.sessionid || '',
      authorization: data.authorization || '',
      access_key: data.access_key || '',
      secret_key: data.secret_key || '',
      cookie: data.cookie || '',
      status: data.status || 'active',
      priority: data.priority ?? 5,
      daily_usage: 0,
      max_daily_usage: data.max_daily_usage ?? 100,
      total_usage: 0,
      last_used_at: null,
      last_check_at: null,
      last_error: null,
      points: data.points || { total: 0, gift: 0, purchase: 0, vip: false },
      tags: data.tags || [],
      notes: data.notes || '',
      created_at: nowISO(),
      updated_at: nowISO(),
    };

    this.config.accounts[platform].push(account);
    this.saveConfig();
    logger.info(`[AccountManager] 新增账号: ${account.id} (${platform})`);
    return account;
  }

  updateAccount(id: string, updates: Partial<Account>): Account | undefined {
    const account = this.getAccount(id);
    if (!account) return undefined;

    // 禁止修改 id 和 platform
    const { id: _id, platform: _p, ...safeUpdates } = updates;
    Object.assign(account, safeUpdates, { updated_at: nowISO() });

    this.saveConfig();
    logger.info(`[AccountManager] 更新账号: ${id}`);
    return account;
  }

  deleteAccount(id: string): boolean {
    for (const platform of Object.keys(this.config.accounts) as Platform[]) {
      const list = this.config.accounts[platform];
      const idx = list.findIndex(a => a.id === id);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.saveConfig();
        logger.info(`[AccountManager] 删除账号: ${id}`);
        return true;
      }
    }
    return false;
  }

  // ── 智能轮询选号 ──

  /**
   * 根据策略选择一个活跃账号
   * @param platform 平台
   * @param excludeIds 排除的账号ID (已失败的)
   * @returns 选中的账号, 或 undefined (无可用)
   */
  selectAccount(platform: Platform, excludeIds: string[] = []): Account | undefined {
    const candidates = this.config.accounts[platform]
      .filter(a => a.status === 'active' && !excludeIds.includes(a.id));

    if (candidates.length === 0) return undefined;

    const strategy = this.config.settings.rotation_strategy;

    switch (strategy) {
      case 'random':
        return _.sample(candidates);

      case 'round-robin': {
        const idx = (this.roundRobinIndex.get(platform) || 0) % candidates.length;
        this.roundRobinIndex.set(platform, idx + 1);
        // 按 priority 排序后取
        const sorted = _.orderBy(candidates, ['priority'], ['desc']);
        return sorted[idx];
      }

      case 'least-used': {
        return _.minBy(candidates, a => a.daily_usage);
      }

      case 'priority': {
        return _.maxBy(candidates, a => a.priority);
      }

      case 'weighted-random':
      default: {
        // 按 priority 权重随机
        const totalWeight = candidates.reduce((sum, a) => sum + Math.max(a.priority, 1), 0);
        let random = Math.random() * totalWeight;
        for (const account of candidates) {
          random -= Math.max(account.priority, 1);
          if (random <= 0) return account;
        }
        return candidates[candidates.length - 1];
      }
    }
  }

  /**
   * 获取平台的活跃 Token 列表 (兼容旧接口)
   * 返回逗号分隔的 authorization 字符串
   */
  getActiveTokens(platform: Platform): string {
    const active = this.config.accounts[platform]
      .filter(a => a.status === 'active')
      .sort((a, b) => b.priority - a.priority);

    if (active.length === 0) return '';

    // 优先使用 authorization，其次 sessionid
    const tokens = active.map(a => {
      if (a.authorization) return a.authorization;
      if (a.sessionid) return a.sessionid;
      return '';
    }).filter(Boolean);

    return tokens.join(',');
  }

  /**
   * 标记账号使用成功
   */
  markUsed(id: string): void {
    const account = this.getAccount(id);
    if (!account) return;
    account.daily_usage += 1;
    account.total_usage += 1;
    account.last_used_at = nowISO();
    // 不在每次使用时都保存文件，太频繁
  }

  /**
   * 标记账号使用失败
   */
  markError(id: string, error: string): void {
    const account = this.getAccount(id);
    if (!account) return;
    account.last_error = error;
    account.last_check_at = nowISO();

    // 连续失败策略: 如果今日使用量为0但仍失败，可能是过期
    if (error.includes('积分不足') || error.includes('insufficient')) {
      account.status = 'cooldown';
      logger.warn(`[AccountManager] 账号 ${id} 进入冷却: ${error}`);
    } else if (error.includes('token') || error.includes('expired') || error.includes('失效')) {
      account.status = 'expired';
      logger.warn(`[AccountManager] 账号 ${id} 已过期: ${error}`);
    }
    this.saveConfig();
  }

  /**
   * 每日重置 (清零 daily_usage, 恢复 cooldown 账号)
   */
  resetDaily(): void {
    for (const account of this.getAccounts()) {
      account.daily_usage = 0;
      if (account.status === 'cooldown') {
        account.status = 'active';
      }
    }
    this.saveConfig();
    logger.info('[AccountManager] 每日计数已重置');
  }

  // ── 健康检查 ──

  private startHealthCheck(): void {
    const interval = this.config.settings.health_check_interval_ms;
    if (interval <= 0) return;

    // 首次检查延迟 30 秒 (等服务完全启动)
    setTimeout(() => this.runHealthCheck(), 30000);

    this.healthCheckTimer = setInterval(() => this.runHealthCheck(), interval);
    logger.info(`[AccountManager] 健康检查已启动 (间隔 ${interval / 1000}s)`);
  }

  async runHealthCheck(): Promise<void> {
    const accounts = this.getAccounts().filter(a => a.status !== 'inactive');
    if (accounts.length === 0) return;

    logger.debug(`[AccountManager] 开始健康检查 (${accounts.length} 个账号)`);

    for (const account of accounts) {
      try {
        // 检查 token 有效性 (仅 jimeng 有在线检查 API)
        if (account.platform === 'jimeng' && (account.sessionid || account.authorization)) {
          const { getTokenLiveStatus } = await import('@/api/controllers/core.ts');
          const token = account.authorization || account.sessionid;
          const alive = await getTokenLiveStatus(token!);
          account.last_check_at = nowISO();

          if (!alive) {
            account.status = 'expired';
            account.last_error = 'Token 已失效';
            logger.warn(`[AccountManager] 账号 ${account.id} (${account.name}) Token 已失效`);
          } else {
            if (account.status === 'expired') account.status = 'active';
            account.last_error = null;
          }

          // 查询积分
          try {
            const { getCredit } = await import('@/api/controllers/core.ts');
            const points = await getCredit(token!);
            account.points = {
              total: points.totalCredit || 0,
              gift: points.giftCredit || 0,
              purchase: points.purchaseCredit || 0,
              vip: !!points.vipCredit,
            };
          } catch (e) {
            // 积分查询失败不标记错误
          }
        }

        // Kling 积分检查 (通过网页自动化获取账户信息)
        if (account.platform === 'kling' && account.cookie) {
          try {
            const { default: klingApi } = await import('@/providers/kling/api-automation.ts');
            const info = await klingApi.getAccountInfo({ prompt: 'health-check' });
            account.last_check_at = nowISO();
            if (info.points !== null) {
              account.points = { total: info.points, gift: 0, purchase: 0, vip: !!info.vipStatus };
            }
            if (info.userName) account.name = info.userName;
            if (account.status === 'expired') account.status = 'active';
            account.last_error = null;
          } catch (e: any) {
            account.last_error = e.message;
            if (e.message?.includes('登录') || e.message?.includes('cookie') || e.message?.includes('expired')) {
              account.status = 'expired';
            }
          }
        }

        // 小云雀积分检查
        if (account.platform === 'xyq' && (account.sessionid || account.authorization)) {
          try {
            const { getCredit } = await import('@/providers/xyq/api.ts');
            const token = account.authorization || account.sessionid;
            const quota = await getCredit(token!);
            account.last_check_at = nowISO();
            if (Array.isArray(quota) && quota.length > 0) {
              account.points.total = quota.reduce((sum: number, q: any) => sum + (q.remaining || 0), 0);
            }
          } catch (e) {
            // 静默处理
          }
        }
      } catch (err: any) {
        account.last_error = err.message;
        account.last_check_at = nowISO();
      }
    }

    this.saveConfig();
  }

  // ── API Key 管理 ──

  getApiKeys(): ApiKey[] {
    return this.config.api_keys;
  }

  getApiKey(id: string): ApiKey | undefined {
    return this.config.api_keys.find(k => k.id === id);
  }

  getApiKeyByKey(key: string): ApiKey | undefined {
    return this.config.api_keys.find(k => k.key === key && k.enabled);
  }

  addApiKey(data: Partial<ApiKey>): ApiKey {
    const apiKey: ApiKey = {
      id: `key-${uuidv4().slice(0, 8)}`,
      key: data.key || generateApiKey(),
      name: data.name || '未命名 Key',
      rate_limit: data.rate_limit || '100/hour',
      allowed_platforms: data.allowed_platforms || ['*'],
      total_calls: 0,
      last_used_at: null,
      created_at: nowISO(),
      enabled: true,
    };
    this.config.api_keys.push(apiKey);
    this.saveConfig();
    logger.info(`[AccountManager] 新增 API Key: ${apiKey.id} (${apiKey.name})`);
    return apiKey;
  }

  deleteApiKey(id: string): boolean {
    const idx = this.config.api_keys.findIndex(k => k.id === id);
    if (idx === -1) return false;
    this.config.api_keys.splice(idx, 1);
    this.saveConfig();
    return true;
  }

  toggleApiKey(id: string, enabled: boolean): boolean {
    const key = this.getApiKey(id);
    if (!key) return false;
    key.enabled = enabled;
    this.saveConfig();
    return true;
  }

  recordApiKeyUsage(key: string): void {
    const apiKey = this.config.api_keys.find(k => k.key === key);
    if (apiKey) {
      apiKey.total_calls += 1;
      apiKey.last_used_at = nowISO();
    }
  }

  // ── 设置管理 ──

  getSettings(): AccountsConfig['settings'] {
    return this.config.settings;
  }

  updateSettings(updates: Partial<AccountsConfig['settings']>): AccountsConfig['settings'] {
    Object.assign(this.config.settings, updates);
    this.saveConfig();
    return this.config.settings;
  }

  // ── 统计 ──

  getStats(): {
    total: number;
    byPlatform: Record<string, number>;
    byStatus: Record<string, number>;
    totalUsage: number;
    totalPoints: number;
    apiKeys: number;
  } {
    const all = this.getAccounts();
    const byPlatform: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalUsage = 0;
    let totalPoints = 0;

    for (const a of all) {
      byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      totalUsage += a.total_usage;
      totalPoints += a.points.total;
    }

    return {
      total: all.length,
      byPlatform,
      byStatus,
      totalUsage,
      totalPoints,
      apiKeys: this.config.api_keys.length,
    };
  }

  /**
   * 获取所有账号的精简视图 (用于 API 返回，隐藏敏感信息)
   */
  getAccountsView(platform?: Platform): any[] {
    return this.getAccounts(platform).map(a => ({
      id: a.id,
      name: a.name,
      platform: a.platform,
      status: a.status,
      priority: a.priority,
      daily_usage: a.daily_usage,
      max_daily_usage: a.max_daily_usage,
      total_usage: a.total_usage,
      last_used_at: a.last_used_at,
      last_check_at: a.last_check_at,
      last_error: a.last_error,
      points: a.points,
      tags: a.tags,
      notes: a.notes,
      created_at: a.created_at,
      updated_at: a.updated_at,
      // 凭证用掩码显示
      sessionid_preview: maskSecret(a.sessionid),
      authorization_preview: maskSecret(a.authorization),
      has_sessionid: Boolean(a.sessionid),
      has_authorization: Boolean(a.authorization),
      has_access_key: Boolean(a.access_key),
      has_cookie: Boolean(a.cookie),
    }));
  }

  // ── 批量操作 ──

  /**
   * 批量导入账号
   */
  importAccounts(platform: Platform, accounts: Partial<Account>[]): Account[] {
    return accounts.map(data => this.addAccount(platform, data));
  }

  /**
   * 检查平台是否有可用账号 (兼容旧 service-authorization 的兜底逻辑)
   */
  hasActiveAccount(platform: Platform): boolean {
    return this.config.accounts[platform]?.some(a => a.status === 'active') ?? false;
  }

  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    // 保存最终状态
    this.saveConfig();
  }
}

// 单例导出
export default new AccountManager();
