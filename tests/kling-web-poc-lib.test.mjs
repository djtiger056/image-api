import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCookiesExport,
  redactHeaders,
  shouldCaptureRequest,
} from '../scripts/lib/kling-web-poc-lib.mjs';

test('normalizeCookiesExport should convert extension-style cookie array into Playwright storage state', () => {
  const storageState = normalizeCookiesExport([
    {
      name: 'sessionid',
      value: 'abc123',
      domain: '.kling.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: 1893456000,
    },
  ]);

  assert.equal(storageState.cookies.length, 1);
  assert.deepEqual(storageState.origins, []);
  assert.equal(storageState.cookies[0].name, 'sessionid');
  assert.equal(storageState.cookies[0].sameSite, 'None');
  assert.equal(storageState.cookies[0].expires, 1893456000);
});

test('redactHeaders should hide sensitive cookie and authorization values', () => {
  const redacted = redactHeaders({
    cookie: 'sessionid=abc123; other=value',
    authorization: 'Bearer super-secret',
    'x-custom': 'ok',
  });

  assert.equal(redacted.cookie, '[REDACTED]');
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted['x-custom'], 'ok');
});

test('shouldCaptureRequest should keep likely generation traffic and ignore analytics noise', () => {
  assert.equal(
    shouldCaptureRequest({
      url: 'https://app.klingai.com/api/image/generate',
      method: 'POST',
      resourceType: 'fetch',
    }),
    true
  );

  assert.equal(
    shouldCaptureRequest({
      url: 'https://analytics.google.com/g/collect?v=2',
      method: 'POST',
      resourceType: 'fetch',
    }),
    false
  );

  assert.equal(
    shouldCaptureRequest({
      url: 'https://static.klingai.com/assets/app.js',
      method: 'GET',
      resourceType: 'script',
    }),
    false
  );
});
