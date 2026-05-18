import { test } from 'node:test';
import assert from 'node:assert/strict';

const helperModulePath = '../src/lib/service-authorization.js';

function clearEnv() {
  delete process.env.JIMENG_SESSIONID;
  delete process.env.JIMENG_AUTHORIZATION;
}

test('resolveServiceAuthorization should prefer incoming authorization header', async () => {
  clearEnv();
  process.env.JIMENG_SESSIONID = 'env-token';
  const { resolveServiceAuthorization } = await import(helperModulePath);

  assert.equal(resolveServiceAuthorization('Bearer incoming-token'), 'Bearer incoming-token');
});

test('resolveServiceAuthorization should fall back to JIMENG_SESSIONID and add Bearer prefix', async () => {
  clearEnv();
  process.env.JIMENG_SESSIONID = 'session-a,session-b';
  const { resolveServiceAuthorization } = await import(helperModulePath);

  assert.equal(resolveServiceAuthorization(undefined), 'Bearer session-a,session-b');
});

test('resolveServiceAuthorization should fall back to JIMENG_AUTHORIZATION as-is', async () => {
  clearEnv();
  process.env.JIMENG_AUTHORIZATION = 'Bearer auth-a,auth-b';
  const { resolveServiceAuthorization } = await import(helperModulePath);

  assert.equal(resolveServiceAuthorization(undefined), 'Bearer auth-a,auth-b');
});

test('resolveServiceAuthorization should throw when neither request nor env credentials exist', async () => {
  clearEnv();
  const { resolveServiceAuthorization } = await import(helperModulePath);

  assert.throws(() => resolveServiceAuthorization(undefined), /Jimeng 服务端未配置可用凭证/);
});

test('splitAuthorizationTokens should normalize Bearer prefix and commas', async () => {
  clearEnv();
  const { splitAuthorizationTokens } = await import(helperModulePath);

  assert.deepEqual(
    splitAuthorizationTokens('Bearer token-1, token-2 ,,token-3 '),
    ['token-1', 'token-2', 'token-3']
  );
});
