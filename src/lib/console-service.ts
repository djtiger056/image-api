import fs from 'fs-extra';
import path from 'path';

import { getCredit } from '@/api/controllers/core.ts';
import { checkQwenCredit } from '@/lib/browser-credit.ts';
import { splitAuthorizationTokens, resolveServiceAuthorization } from '@/lib/service-authorization.js';
import { resolveKlingWebStorageState } from '@/providers/kling/web-utils.ts';
import { getQwenStatePath } from '@/providers/qwen/session.ts';
import accountManager from '@/lib/account-manager.ts';

const ROOT_DIR = path.resolve();
const KLING_STATE_PATH = path.join(ROOT_DIR, 'kling.json');

function maskSecret(value?: string) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export async function getConsoleStatus({ deep = false }: { deep?: boolean } = {}) {
  const response: Record<string, any> = {
    ok: true,
    now: new Date().toISOString(),
    server_api_key_required: Boolean(String(process.env.SERVER_API_KEYS || process.env.SERVER_API_KEY || '').trim()),
    credentials: {
      jimeng: {
        configured: false,
        source: 'none',
        token_count: 0,
        preview: [] as string[],
      },
      kling: {
        configured: false,
        source: 'none',
        cookies_count: 0,
        origins_count: 0,
        cookie_names: [] as string[],
      },
      doubao: {
        configured: false,
        source: 'none',
        token_count: 0,
        preview: [] as string[],
      },
      xyq: {
        configured: false,
        source: 'none',
        token_count: 0,
        preview: [] as string[],
      },
      qwen: {
        configured: false,
        source: 'none',
        state_path: getQwenStatePath(),
      },
    },
  };

  // 辅助函数: 检查 account-manager 中的账号
  function checkAccountManager(platform: 'jimeng' | 'doubao' | 'xyq' | 'qwen') {
    const accounts = accountManager.getAccounts(platform).filter(a => a.status === 'active');
    if (accounts.length === 0) return null;
    const tokens = accounts
      .map(a => a.authorization || a.sessionid || '')
      .filter(Boolean);
    if (tokens.length === 0) return null;
    return {
      configured: true,
      source: 'account-manager',
      token_count: tokens.length,
      preview: tokens.slice(0, 3).map(maskSecret),
    };
  }

  try {
    // 优先检查 account-manager
    const amJimeng = checkAccountManager('jimeng');
    if (amJimeng) {
      response.credentials.jimeng = amJimeng;
    } else {
      // 回退到环境变量
      const authorization = resolveServiceAuthorization(undefined);
      const tokens = splitAuthorizationTokens(authorization);
      response.credentials.jimeng = {
        configured: tokens.length > 0,
        source: process.env.JIMENG_AUTHORIZATION ? 'authorization' : 'sessionid',
        token_count: tokens.length,
        preview: tokens.slice(0, 3).map(maskSecret),
      };
    }

    // Deep check 使用第一个可用 token
    const jimengToken = response.credentials.jimeng.token_count > 0
      ? (accountManager.getActiveTokens('jimeng').split(',')[0] || resolveServiceAuthorization(undefined).split(',')[0])
      : '';
    if (deep && jimengToken) {
      try {
        const points = await getCredit(jimengToken);
        response.credentials.jimeng.check = {
          ok: true,
          total_credit: points.totalCredit,
          gift_credit: points.giftCredit,
          purchase_credit: points.purchaseCredit,
          vip_credit: points.vipCredit,
        };
      } catch (error) {
        response.credentials.jimeng.check = {
          ok: false,
          error: (error as Error).message,
        };
      }
    }
  } catch (error) {
    response.credentials.jimeng.error = (error as Error).message;
  }

  try {
    const klingState = await resolveKlingWebStorageState();
    response.credentials.kling = {
      configured: true,
      source: process.env.KLING_WEB_STORAGE_STATE_JSON
        ? 'env-json'
        : await fs.pathExists(KLING_STATE_PATH)
          ? 'kling.json'
          : 'other',
      cookies_count: klingState.cookies.length,
      origins_count: klingState.origins.length,
      cookie_names: klingState.cookies.slice(0, 8).map((item) => item.name),
    };
  } catch (error) {
    response.credentials.kling.error = (error as Error).message;
  }

  // Doubao 凭证检查
  try {
    // 优先检查 account-manager
    const amDoubao = checkAccountManager('doubao');
    if (amDoubao) {
      response.credentials.doubao = amDoubao;
    } else {
      // 回退到环境变量
      const doubaoAuth = String(process.env.DOUBAO_AUTHORIZATION || '').trim();
      const doubaoSession = String(process.env.DOUBAO_SESSIONID || '').trim();
      const doubaoRaw = doubaoAuth || doubaoSession;
      if (doubaoRaw) {
        const tokens = doubaoRaw.replace(/^Bearer\s+/i, '').split(',').filter(Boolean);
        response.credentials.doubao = {
          configured: tokens.length > 0,
          source: doubaoAuth ? 'authorization' : 'sessionid',
          token_count: tokens.length,
          preview: tokens.slice(0, 3).map(maskSecret),
        };
      }
    }
  } catch (error) {
    response.credentials.doubao.error = (error as Error).message;
  }

  // XYQ (小云雀) 凭证检查
  try {
    // 优先检查 account-manager
    const amXyq = checkAccountManager('xyq');
    if (amXyq) {
      response.credentials.xyq = amXyq;
    } else {
      // 回退到环境变量
      const xyqAuth = String(process.env.XYQ_AUTHORIZATION || '').trim();
      const xyqSession = String(process.env.XYQ_SESSIONID || '').trim();
      const xyqRaw = xyqAuth || xyqSession;
      if (xyqRaw) {
        const tokens = xyqRaw.replace(/^Bearer\s+/i, '').split(',').filter(Boolean);
        response.credentials.xyq = {
          configured: tokens.length > 0,
          source: xyqAuth ? 'authorization' : 'sessionid',
          token_count: tokens.length,
          preview: tokens.slice(0, 3).map(maskSecret),
        };
      }
    }

    // Deep check（复用 jimeng 的 user_credit API）
    const xyqToken = response.credentials.xyq.token_count > 0
      ? (accountManager.getActiveTokens('xyq').split(',')[0] || String(process.env.XYQ_AUTHORIZATION || process.env.XYQ_SESSIONID || '').replace(/^Bearer\s+/i, '').split(',')[0])
      : '';
    if (deep && xyqToken) {
      try {
        const { getCredit } = await import('@/api/controllers/core.ts');
        const points = await getCredit(xyqToken);
        response.credentials.xyq.check = {
          ok: true,
          total_credit: points.totalCredit,
          gift_credit: points.giftCredit,
          purchase_credit: points.purchaseCredit,
          vip_credit: points.vipCredit,
        };
      } catch (error) {
        response.credentials.xyq.check = {
          ok: false,
          error: (error as Error).message,
        };
      }
    }
  } catch (error) {
    response.credentials.xyq.error = (error as Error).message;
  }

  // Qwen (千问) 凭证检查
  try {
    // 优先检查 account-manager
    const qwenAccounts = accountManager.getAccounts('qwen').filter(a => a.status === 'active');
    if (qwenAccounts.length > 0) {
      const hasCookie = qwenAccounts.some(a => a.cookie);
      response.credentials.qwen = {
        configured: true,
        source: 'account-manager',
        state_path: getQwenStatePath(),
        account_count: qwenAccounts.length,
        ...(hasCookie ? { preview: maskSecret(qwenAccounts[0].cookie?.substring(0, 30)) } : {}),
      };
    } else {
      // 回退到环境变量
      const qwenCookie = String(process.env.QWEN_COOKIE || '').trim();
      const hasQwenState = await fs.pathExists(getQwenStatePath());
      if (qwenCookie || hasQwenState) {
        response.credentials.qwen = {
          configured: true,
          source: hasQwenState ? 'qwen.json' : 'cookie',
          state_path: getQwenStatePath(),
          ...(qwenCookie ? { preview: maskSecret(qwenCookie.substring(0, 30)) } : {}),
        };
      }
    }

    // Deep check（浏览器自动化）
    if (deep) {
      const qwenCookie = qwenAccounts.length > 0
        ? (qwenAccounts[0].cookie || qwenAccounts[0].authorization || qwenAccounts[0].sessionid || '')
        : String(process.env.QWEN_COOKIE || '').trim();
      if (qwenCookie) {
        try {
          const result = await checkQwenCredit(qwenCookie);
          response.credentials.qwen.check = {
            ok: true,
            total_amount: result.totalAmount,
          };
        } catch (error) {
          response.credentials.qwen.check = {
            ok: false,
            error: (error as Error).message,
          };
        }
      }
    }
  } catch (error) {
    response.credentials.qwen.error = (error as Error).message;
  }

  return response;
}
