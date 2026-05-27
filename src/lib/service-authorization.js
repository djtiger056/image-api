/**
 * 服务认证模块 (增强版)
 *
 * 认证优先级链:
 * 1. 请求头 Authorization (调用方显式传入)
 * 2. 账号管理器 (AccountManager) 中的活跃账号
 * 3. 环境变量 JIMENG_AUTHORIZATION
 * 4. 环境变量 JIMENG_SESSIONID
 */

let _accountManager = null;

function getAccountManager() {
  if (_accountManager === null) {
    try {
      // 延迟加载，避免循环依赖
      _accountManager = require('@/lib/account-manager.ts').default;
    } catch (e) {
      _accountManager = false; // 标记不可用
    }
  }
  return _accountManager || null;
}

function normalizeBearer(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return /^Bearer\s+/i.test(normalized) ? normalized : `Bearer ${normalized}`;
}

export function splitAuthorizationTokens(authorization) {
  return String(authorization || '')
    .replace(/^Bearer\s+/i, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 获取平台的认证 Token (增强版)
 *
 * 优先级: 请求头 > 账号管理器 > 环境变量
 *
 * @param {string|undefined} authorization - 请求头 Authorization
 * @param {string} platform - 平台名称 (jimeng/doubao/xyq)
 * @returns {string} Bearer 格式的认证字符串
 */
export function resolveServiceAuthorization(authorization, platform = 'jimeng') {
  // 1. 请求头优先
  const incoming = String(authorization || '').trim();
  if (incoming) return incoming;

  // 2. 账号管理器
  const am = getAccountManager();
  if (am) {
    try {
      const poolTokens = am.getActiveTokens(platform);
      if (poolTokens) {
        return normalizeBearer(poolTokens);
      }
    } catch (e) {
      // 账号管理器异常，继续降级
    }
  }

  // 3. 环境变量 (兼容旧模式)
  const envMap = {
    jimeng: { auth: 'JIMENG_AUTHORIZATION', session: 'JIMENG_SESSIONID' },
    doubao: { auth: 'DOUBAO_AUTHORIZATION', session: 'DOUBAO_SESSIONID' },
    xyq: { auth: 'XYQ_AUTHORIZATION', session: 'XYQ_SESSIONID' },
  };

  const env = envMap[platform] || envMap.jimeng;
  const configuredAuthorization = String(process.env[env.auth] || '').trim();
  if (configuredAuthorization) {
    return normalizeBearer(configuredAuthorization);
  }

  const configuredSessionId = String(process.env[env.session] || '').trim();
  if (configuredSessionId) {
    return normalizeBearer(configuredSessionId);
  }

  throw new Error(`${platform} 服务端未配置可用凭证。请通过管理面板添加账号，或设置环境变量 ${env.auth} / ${env.session}。`);
}

/**
 * 选择单个 Token (用于需要随机选择的场景)
 */
export function selectSingleToken(authorization, platform = 'jimeng') {
  const am = getAccountManager();
  if (am) {
    try {
      const account = am.selectAccount(platform);
      if (account) {
        const token = account.authorization || account.sessionid;
        if (token) return token;
      }
    } catch (e) {
      // 降级
    }
  }

  // 降级: 从完整 token 列表中随机选
  const fullAuth = resolveServiceAuthorization(authorization, platform);
  const tokens = splitAuthorizationTokens(fullAuth);
  if (tokens.length === 0) throw new Error(`${platform} 无可用 Token`);
  return tokens[Math.floor(Math.random() * tokens.length)];
}

/**
 * 标记 Token 使用结果 (供控制器调用)
 */
export function markTokenResult(token, success, error = null) {
  const am = getAccountManager();
  if (!am) return;

  // 通过 token 值反查账号
  const accounts = am.getAccounts();
  const account = accounts.find(a =>
    (a.sessionid && a.sessionid === token) ||
    (a.authorization && a.authorization === token)
  );

  if (!account) return;

  if (success) {
    am.markUsed(account.id);
  } else if (error) {
    am.markError(account.id, error);
  }
}
