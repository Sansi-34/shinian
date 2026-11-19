import { randomBytes } from 'node:crypto';
import { sqlite } from '../db/db';

export const SESSION_COOKIE = 'shinian_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function localHostname(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1';
}

function hostnameOf(raw: string): string | null {
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function configuredHosts(): string[] {
  return (process.env.SHINIAN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (localHostname(hostname)) return true;

  const bindHost = process.env.HOST;
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    const bindName = hostnameOf(bindHost);
    if (bindName && bindName === hostname) return true;
  }
  return configuredHosts().some((entry) => {
    const name = hostnameOf(entry);
    return name !== null && name === hostname;
  });
}

/**
 * 写请求只允许同源或本机开发端口（如 Vite 5173 → 3000）。
 * 非本机来源必须与请求 Host 完全一致。
 */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // curl/测试客户端没有 Origin，仍受 Host 校验约束
  const originName = hostnameOf(origin);
  const requestName = hostHeader ? hostnameOf(hostHeader) : null;
  if (!originName || !requestName) return false;
  if (originName === requestName) return true;
  return localHostname(originName) && localHostname(requestName);
}

export function createSession(accountId: string): { token: string; expiresAt: number } {
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const token = randomBytes(32).toString('base64url');
  sqlite
    .prepare(
      `INSERT INTO sessions (id, account_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(token, accountId, now, expiresAt);
  // 顺带清理过期或一周前已撤销的会话，避免无限增长。
  sqlite
    .prepare(
      `DELETE FROM sessions
        WHERE expires_at < ?
           OR (revoked_at IS NOT NULL AND revoked_at < ?)`
    )
    .run(now, now - 7 * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

export function resolveSession(token: string | undefined): string | null {
  if (!token) return null;
  const row = sqlite
    .prepare(
      `SELECT account_id AS accountId, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM sessions WHERE id = ?`
    )
    .get(token) as { accountId: string; expiresAt: number; revokedAt: number | null } | undefined;
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Date.now()) return null;
  const account = sqlite.prepare('SELECT id FROM accounts WHERE id = ?').get(row.accountId) as
    | { id: string }
    | undefined;
  return account?.id ?? null;
}

export function revokeSession(token: string | undefined): boolean {
  if (!token) return false;
  const result = sqlite
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), token);
  return result.changes > 0;
}
