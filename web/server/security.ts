/**
 * ローカル専用サーバーの入口を守る。
 *
 * 127.0.0.1 に bind していても、ブラウザで開いた別サイトのページからは
 * 取得を仕掛けられる。Host を許可した名前に限り、Origin があれば同一 origin だけ
 * 通し、API には起動時に作った token を要求する。CORS は開けない。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** API に付ける専用ヘッダー。単純要求では付けられないので、これ自体が防壁になる。 */
export const TOKEN_HEADER = 'x-pdf-ja-token';

export interface SecurityConfig {
  token: string;
  /** `127.0.0.1:7391` のような `host:port`。 */
  allowedHosts: ReadonlySet<string>;
}

export interface Allowed {
  ok: true;
}

export interface Denied {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type Decision = Allowed | Denied;

const ALLOW: Allowed = { ok: true };

export function createToken(): string {
  return randomBytes(32).toString('hex');
}

export function allowedHostsFor(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function deny(status: number, code: string, message: string): Denied {
  return { ok: false, status, code, message };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function checkHostAndOrigin(request: IncomingMessage, config: SecurityConfig): Decision {
  const host = header(request, 'host');
  if (host === undefined || !config.allowedHosts.has(host.toLowerCase())) {
    return deny(403, 'bad-host', `Host が許可されていません: ${host ?? '(なし)'}`);
  }

  const origin = header(request, 'origin');
  if (origin !== undefined && origin !== 'null') {
    // 同一 origin だけ。CORS ヘッダーは返さない。
    const expected = `http://${host.toLowerCase()}`;
    if (origin.toLowerCase() !== expected) {
      return deny(403, 'bad-origin', `Origin が許可されていません: ${origin}`);
    }
  }
  return ALLOW;
}

/** API 要求。Host・Origin に加えて token を必須にする。 */
export function checkApiRequest(request: IncomingMessage, config: SecurityConfig): Decision {
  const base = checkHostAndOrigin(request, config);
  if (!base.ok) return base;

  if (!tokenMatches(config.token, header(request, TOKEN_HEADER))) {
    return deny(403, 'bad-token', 'token が一致しません');
  }
  return ALLOW;
}

/**
 * 起動 HTML と静的ファイル。token はまだ持っていないので要求しない。
 * 代わりに Sec-Fetch-Site を見て、他サイトからの読み込みを断る。
 */
export function checkPageRequest(request: IncomingMessage, config: SecurityConfig): Decision {
  const base = checkHostAndOrigin(request, config);
  if (!base.ok) return base;

  const site = header(request, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return deny(403, 'bad-fetch-site', `Sec-Fetch-Site が許可されていません: ${site}`);
  }

  const dest = header(request, 'sec-fetch-dest');
  if (dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object') {
    return deny(403, 'bad-fetch-dest', '別の文書へ埋め込むことはできません');
  }
  return ALLOW;
}

/** 外部を一切見ない。原文を扱うので CDN も使わない。 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
});

/** token をログへ出さないための伏せ字。 */
export function redactToken(text: string, token: string): string {
  if (token === '') return text;
  return text.split(token).join('***');
}
