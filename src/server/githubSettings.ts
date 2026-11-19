import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/db';
import { githubSettings } from '../db/schema';
import { decryptSecret, encryptSecret } from './aiSettings';

export const GITHUB_SETTINGS_ID = 'default';
export const GITHUB_SETTINGS_AAD = 'shinian:github-token:v1';

export const GITHUB_API_BASE = (() => {
  const raw = process.env.SHINIAN_GITHUB_API_BASE?.trim();
  // 只允许测试用的固定本机地址通过环境变量覆盖；普通部署固定使用官方 API。
  return raw && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(raw) ? raw : 'https://api.github.com';
})();

export function githubApiBase(): string {
  return GITHUB_API_BASE;
}

export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

async function getGithubRow() {
  const rows = await db
    .select()
    .from(githubSettings)
    .where(eq(githubSettings.id, GITHUB_SETTINGS_ID))
    .limit(1);
  return rows[0];
}

export async function getPublicGithubSettings() {
  const row = await getGithubRow();
  return {
    configured: Boolean(row?.tokenCiphertext),
    hasToken: Boolean(row?.tokenCiphertext),
    tokenFingerprint: row ? row.tokenFingerprint : null,
    updatedAt: row?.updatedAt ?? null,
    apiBase: GITHUB_API_BASE,
    note: '不填写 Token 时使用 GitHub 公开读取额度；填写后只发送给 GitHub API，不发送给模型。',
  };
}

export async function saveGithubToken(rawToken: unknown): Promise<
  { ok: true; changed: boolean } | { ok: false; message: string }
> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return { ok: false, message: '请填写 GitHub Token。' };
  if (token.length < 10 || token.length > 300) {
    return { ok: false, message: 'GitHub Token 长度不正确。' };
  }
  if (/\s/.test(token)) return { ok: false, message: 'GitHub Token 不能包含空格。' };
  const existing = await getGithubRow();
  const fingerprint = tokenFingerprint(token);
  const now = Date.now();
  if (existing && existing.tokenFingerprint === fingerprint) {
    return { ok: true, changed: false };
  }
  if (existing) {
    await db
      .update(githubSettings)
      .set({
        tokenCiphertext: encryptSecret(token, GITHUB_SETTINGS_AAD),
        tokenFingerprint: fingerprint,
        updatedAt: now,
      })
      .where(eq(githubSettings.id, GITHUB_SETTINGS_ID));
  } else {
    await db.insert(githubSettings).values({
      id: GITHUB_SETTINGS_ID,
      tokenCiphertext: encryptSecret(token, GITHUB_SETTINGS_AAD),
      tokenFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { ok: true, changed: true };
}

export async function deleteGithubToken(): Promise<void> {
  await db.delete(githubSettings).where(eq(githubSettings.id, GITHUB_SETTINGS_ID));
}

/** 读取并解密 Token；未配置时返回空字符串。 */
export async function readGithubToken(): Promise<string> {
  const row = await getGithubRow();
  if (!row) return '';
  return decryptSecret(row.tokenCiphertext, GITHUB_SETTINGS_AAD).trim();
}
