import fs from 'fs-extra';
import path from 'path';

import { getCredit } from '@/api/controllers/core.ts';
import { getCredit as getXyqCredit } from '@/providers/xyq/api.ts';
import { splitAuthorizationTokens, resolveServiceAuthorization } from '@/lib/service-authorization.js';
import {
  PlaywrightStorageState,
  normalizeKlingCookiesExport,
  resolveKlingWebStorageState,
} from '@/providers/kling/web-utils.ts';
import { getQwenStatePath, saveQwenCookieToState } from '@/providers/qwen/session.ts';

const ROOT_DIR = path.resolve();
const LOCAL_ENV_PATH = path.join(ROOT_DIR, 'local.env');
const KLING_STATE_PATH = path.join(ROOT_DIR, 'kling.json');

function maskSecret(value?: string) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function parseBoolean(value: any) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return false;
}

function pickJsonPayload(value: any) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

function normalizeKlingStateFromBody(body: any): PlaywrightStorageState | null {
  const storageState = pickJsonPayload(body.kling_storage_state ?? body.klingStorageState);
  if (Array.isArray(storageState)) {
    return normalizeKlingCookiesExport(storageState);
  }
  if (storageState && typeof storageState === 'object') {
    return {
      cookies: Array.isArray((storageState as any).cookies) ? (storageState as any).cookies : [],
      origins: Array.isArray((storageState as any).origins) ? (storageState as any).origins : [],
    };
  }

  const cookies = pickJsonPayload(body.kling_cookies ?? body.klingCookies);
  if (Array.isArray(cookies)) {
    return normalizeKlingCookiesExport(cookies);
  }
  return null;
}

async function upsertLocalEnvValue(key: string, value?: string) {
  const exists = await fs.pathExists(LOCAL_ENV_PATH);
  const lines = exists ? (await fs.readFile(LOCAL_ENV_PATH, 'utf8')).split(/\r?\n/) : [];
  let found = false;
  const nextLines = lines
    .filter((line) => !(value === undefined && line.startsWith(`${key}=`)))
    .map((line) => {
      if (!line.startsWith(`${key}=`)) return line;
      found = true;
      return `${key}=${value ?? ''}`;
    });

  if (value !== undefined && !found) {
    nextLines.push(`${key}=${value}`);
  }

  const content = nextLines.join('\n').replace(/\n+$/g, '') + '\n';
  await fs.writeFile(LOCAL_ENV_PATH, content, 'utf8');
}

async function removeLocalEnvValue(key: string) {
  await upsertLocalEnvValue(key, undefined);
}

export async function saveConsoleCredentials(body: any) {
  const persist = !body || body.persist === undefined ? true : parseBoolean(body.persist);
  const clearJimeng = parseBoolean(body?.clear_jimeng ?? body?.clearJimeng);
  const clearKling = parseBoolean(body?.clear_kling ?? body?.clearKling);
  const clearDoubao = parseBoolean(body?.clear_doubao ?? body?.clearDoubao);
  const clearXyq = parseBoolean(body?.clear_xyq ?? body?.clearXyq);
  const clearQwen = parseBoolean(body?.clear_qwen ?? body?.clearQwen);

  const jimengSessionId = String(body?.jimeng_sessionid ?? body?.jimengSessionId ?? '').trim();
  const jimengAuthorization = String(body?.jimeng_authorization ?? body?.jimengAuthorization ?? '').trim();
  const klingState = normalizeKlingStateFromBody(body || {});
  const doubaoSessionId = String(body?.doubao_sessionid ?? body?.doubaoSessionId ?? '').trim();
  const xyqSessionId = String(body?.xyq_sessionid ?? body?.xyqSessionId ?? '').trim();
  const qwenCookie = String(body?.qwen_cookie ?? body?.qwenCookie ?? '').trim();

  if (clearJimeng) {
    delete process.env.JIMENG_SESSIONID;
    delete process.env.JIMENG_AUTHORIZATION;
    if (persist) {
      await removeLocalEnvValue('JIMENG_SESSIONID');
      await removeLocalEnvValue('JIMENG_AUTHORIZATION');
    }
  }

  if (jimengSessionId) {
    process.env.JIMENG_SESSIONID = jimengSessionId;
    delete process.env.JIMENG_AUTHORIZATION;
    if (persist) {
      await upsertLocalEnvValue('JIMENG_SESSIONID', jimengSessionId);
      await removeLocalEnvValue('JIMENG_AUTHORIZATION');
    }
  }

  if (jimengAuthorization) {
    process.env.JIMENG_AUTHORIZATION = jimengAuthorization;
    if (persist) {
      await upsertLocalEnvValue('JIMENG_AUTHORIZATION', jimengAuthorization);
    }
  }

  if (clearKling) {
    delete process.env.KLING_WEB_STORAGE_STATE_JSON;
    if (persist) {
      await fs.remove(KLING_STATE_PATH);
    }
  }

  if (klingState) {
    const serialized = JSON.stringify(klingState, null, 2);
    process.env.KLING_WEB_STORAGE_STATE_JSON = serialized;
    if (persist) {
      await fs.writeFile(KLING_STATE_PATH, serialized, 'utf8');
    }
  }

  if (clearDoubao) {
    delete process.env.DOUBAO_SESSIONID;
    delete process.env.DOUBAO_AUTHORIZATION;
    if (persist) {
      await removeLocalEnvValue('DOUBAO_SESSIONID');
      await removeLocalEnvValue('DOUBAO_AUTHORIZATION');
    }
  }

  if (doubaoSessionId) {
    process.env.DOUBAO_SESSIONID = doubaoSessionId;
    if (persist) {
      await upsertLocalEnvValue('DOUBAO_SESSIONID', doubaoSessionId);
    }
  }

  if (clearXyq) {
    delete process.env.XYQ_SESSIONID;
    delete process.env.XYQ_AUTHORIZATION;
    if (persist) {
      await removeLocalEnvValue('XYQ_SESSIONID');
      await removeLocalEnvValue('XYQ_AUTHORIZATION');
    }
  }

  if (xyqSessionId) {
    process.env.XYQ_SESSIONID = xyqSessionId;
    if (persist) {
      await upsertLocalEnvValue('XYQ_SESSIONID', xyqSessionId);
    }
  }

  if (clearQwen) {
    delete process.env.QWEN_COOKIE;
    if (persist) {
      await removeLocalEnvValue('QWEN_COOKIE');
      await fs.remove(getQwenStatePath());
    }
  }

  if (qwenCookie) {
    process.env.QWEN_COOKIE = qwenCookie;
    if (persist) {
      await upsertLocalEnvValue('QWEN_COOKIE', qwenCookie);
      await saveQwenCookieToState(qwenCookie);
    }
  }

  return getConsoleStatus({ deep: false });
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

  try {
    const authorization = resolveServiceAuthorization(undefined);
    const tokens = splitAuthorizationTokens(authorization);
    response.credentials.jimeng = {
      configured: tokens.length > 0,
      source: process.env.JIMENG_AUTHORIZATION ? 'authorization' : 'sessionid',
      token_count: tokens.length,
      preview: tokens.slice(0, 3).map(maskSecret),
    };

    if (deep && tokens.length > 0) {
      try {
        const points = await getCredit(tokens[0]);
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
  } catch (error) {
    response.credentials.doubao.error = (error as Error).message;
  }

  // XYQ (小云雀) 凭证检查
  try {
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

      if (deep && tokens.length > 0) {
        try {
          const quota = await getXyqCredit(tokens[0]);
          response.credentials.xyq.check = {
            ok: true,
            quota: quota.map((item: any) => ({
              scene: item.scene,
              used: item.used,
              total: item.total,
              remaining: item.remaining,
            })),
          };
        } catch (error) {
          response.credentials.xyq.check = {
            ok: false,
            error: (error as Error).message,
          };
        }
      }
    }
  } catch (error) {
    response.credentials.xyq.error = (error as Error).message;
  }

  // Qwen (千问) 凭证检查
  try {
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
  } catch (error) {
    response.credentials.qwen.error = (error as Error).message;
  }

  return response;
}
