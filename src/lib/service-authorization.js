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

export function resolveServiceAuthorization(authorization) {
  const incoming = String(authorization || '').trim();
  if (incoming) return incoming;

  const configuredAuthorization = String(process.env.JIMENG_AUTHORIZATION || '').trim();
  if (configuredAuthorization) {
    return normalizeBearer(configuredAuthorization);
  }

  const configuredSessionId = String(process.env.JIMENG_SESSIONID || '').trim();
  if (configuredSessionId) {
    return normalizeBearer(configuredSessionId);
  }

  throw new Error('Jimeng 服务端未配置可用凭证。请设置 JIMENG_AUTHORIZATION 或 JIMENG_SESSIONID，或在请求里提供 Authorization。');
}
