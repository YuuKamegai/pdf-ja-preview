import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  TOKEN_HEADER,
  allowedHostsFor,
  checkApiRequest,
  checkPageRequest,
  createToken,
  redactToken,
} from '../../web/server/security';

const TOKEN = 'a'.repeat(64);
const config = { token: TOKEN, allowedHosts: allowedHostsFor(7391) };

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test('token は毎回違い、十分長い', () => {
  const first = createToken();
  assert.notEqual(first, createToken());
  assert.ok(first.length >= 32);
});

test('許可された Host と token なら通す', () => {
  const decision = checkApiRequest(
    request({ host: '127.0.0.1:7391', [TOKEN_HEADER]: TOKEN }),
    config,
  );
  assert.equal(decision.ok, true);
});

test('localhost も同じポートなら通す', () => {
  assert.equal(
    checkApiRequest(request({ host: 'localhost:7391', [TOKEN_HEADER]: TOKEN }), config).ok,
    true,
  );
});

test('別のポートの Host は弾く', () => {
  const decision = checkApiRequest(
    request({ host: '127.0.0.1:7392', [TOKEN_HEADER]: TOKEN }),
    config,
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, 'bad-host');
});

test('外部の名前を名乗る Host は弾く', () => {
  assert.equal(
    checkApiRequest(request({ host: 'evil.example:7391', [TOKEN_HEADER]: TOKEN }), config).ok,
    false,
  );
});

test('Host が無ければ弾く', () => {
  assert.equal(checkApiRequest(request({ [TOKEN_HEADER]: TOKEN }), config).ok, false);
});

test('別 origin からの要求は弾く', () => {
  const decision = checkApiRequest(
    request({ host: '127.0.0.1:7391', origin: 'https://example.com', [TOKEN_HEADER]: TOKEN }),
    config,
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, 'bad-origin');
  assert.equal(decision.ok === false && decision.status, 403);
});

test('同一 origin の要求は通す', () => {
  assert.equal(
    checkApiRequest(
      request({ host: '127.0.0.1:7391', origin: 'http://127.0.0.1:7391', [TOKEN_HEADER]: TOKEN }),
      config,
    ).ok,
    true,
  );
});

test('token が無い・違うと弾く', () => {
  assert.equal(checkApiRequest(request({ host: '127.0.0.1:7391' }), config).ok, false);
  const wrong = checkApiRequest(
    request({ host: '127.0.0.1:7391', [TOKEN_HEADER]: 'b'.repeat(64) }),
    config,
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.code, 'bad-token');
});

test('長さの違う token も弾く', () => {
  assert.equal(
    checkApiRequest(request({ host: '127.0.0.1:7391', [TOKEN_HEADER]: 'short' }), config).ok,
    false,
  );
});

test('起動 HTML は token を求めないが Sec-Fetch-Site は見る', () => {
  assert.equal(checkPageRequest(request({ host: '127.0.0.1:7391' }), config).ok, true);
  assert.equal(
    checkPageRequest(request({ host: '127.0.0.1:7391', 'sec-fetch-site': 'none' }), config).ok,
    true,
  );
  const cross = checkPageRequest(
    request({ host: '127.0.0.1:7391', 'sec-fetch-site': 'cross-site' }),
    config,
  );
  assert.equal(cross.ok, false);
  assert.equal(cross.ok === false && cross.code, 'bad-fetch-site');
});

test('iframe への埋め込みは断る', () => {
  const decision = checkPageRequest(
    request({ host: '127.0.0.1:7391', 'sec-fetch-dest': 'iframe' }),
    config,
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.code, 'bad-fetch-dest');
});

test('CSP は frame-ancestors none で外部取得も禁じる', () => {
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'/);
  assert.equal(/https?:\/\//.test(CONTENT_SECURITY_POLICY), false, '外部の出どころを許さない');
});

test('共通ヘッダーに CSP と nosniff が入る', () => {
  assert.equal(SECURITY_HEADERS['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['cache-control'], 'no-store');
});

test('ログ向けに token を伏せる', () => {
  assert.equal(redactToken(`GET /?t=${TOKEN}`, TOKEN), 'GET /?t=***');
  assert.equal(redactToken('nothing', TOKEN), 'nothing');
});
