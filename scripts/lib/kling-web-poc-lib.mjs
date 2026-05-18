import path from 'node:path';

const DEFAULT_ORIGIN = 'https://kling.ai';
const ANALYTICS_HOST_PATTERNS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'sentry.io',
  'datadoghq.',
  'bytetnsdoc.com',
  'ksurl.cn',
];
const CAPTURE_PATH_KEYWORDS = [
  '/api/',
  '/image/',
  '/images/',
  '/generate',
  '/creation',
  '/task',
  '/asset',
  '/works',
];

function normalizeSameSite(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'lax') return 'Lax';
  if (['none', 'no_restriction', 'unspecified'].includes(normalized)) return 'None';
  return 'None';
}

function normalizeCookie(cookie, originUrl = DEFAULT_ORIGIN) {
  const origin = new URL(originUrl);
  const domain = cookie.domain || origin.hostname;
  const secure = cookie.secure ?? origin.protocol === 'https:';
  const expires = Number.isFinite(cookie.expires)
    ? cookie.expires
    : Number.isFinite(cookie.expirationDate)
      ? cookie.expirationDate
      : -1;

  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain,
    path: cookie.path || '/',
    expires,
    httpOnly: Boolean(cookie.httpOnly),
    secure,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

export function normalizeCookiesExport(payload, originUrl = DEFAULT_ORIGIN) {
  if (!Array.isArray(payload)) {
    throw new Error('cookies payload must be an array');
  }

  return {
    cookies: payload.map((cookie) => normalizeCookie(cookie, originUrl)),
    origins: [],
  };
}

export function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (['cookie', 'authorization', 'x-api-key', 'proxy-authorization'].includes(lowerKey)) {
        return [key, '[REDACTED]'];
      }
      return [key, value];
    })
  );
}

export function shouldCaptureRequest({ url, method = 'GET', resourceType = 'other' }) {
  if (!url) return false;
  if (!['fetch', 'xhr'].includes(resourceType)) return false;

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const upperMethod = String(method).toUpperCase();

  if (ANALYTICS_HOST_PATTERNS.some((pattern) => hostname.includes(pattern))) {
    return false;
  }

  const hostLooksRelevant = ['kling.ai', 'klingai.com', 'kuaishou.com', 'yximgs.com'].some((pattern) =>
    hostname.includes(pattern)
  );
  if (!hostLooksRelevant) return false;

  if (upperMethod !== 'GET') return true;
  return CAPTURE_PATH_KEYWORDS.some((pattern) => pathname.includes(pattern));
}

export function getDefaultArtifactsDir(rootDir = process.cwd()) {
  return path.join(rootDir, 'tmp', 'kling-web-poc');
}

export function getDefaultStorageStatePath(rootDir = process.cwd()) {
  return path.join(getDefaultArtifactsDir(rootDir), 'storage-state.json');
}
