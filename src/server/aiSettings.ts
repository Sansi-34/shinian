import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { APICallError } from 'ai';
import { eq } from 'drizzle-orm';
import { db } from '../db/db';
import { aiSettings, type AiSettings } from '../db/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AI_SETTINGS_ID = 'default';
export const MAX_CAPTURE_CHARS = 4000;
export const MAX_CONSTRAINT_CHARS = 200;
export const MASTER_KEY_AAD = 'shinian:ai-settings:v1';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 20_000;

export type AiErrorCode =
  | 'unreachable'
  | 'auth'
  | 'model_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'rate_limited'
  | 'redirect_blocked'
  | 'invalid_url'
  | 'local_not_allowed'
  | 'cancelled'
  | 'interrupted'
  | 'incomplete_stream'
  | 'ai_not_configured'
  | 'ai_disabled'
  | 'generation_in_progress'
  | 'too_many_generations'
  | 'suggestion_expired'
  | 'not_adoptable';

const ERROR_MESSAGES: Record<AiErrorCode, string> = {
  unreachable: '地址不可达',
  auth: '认证失败',
  model_unavailable: '模型不可用',
  timeout: '请求超时',
  invalid_response: '响应格式不支持',
  rate_limited: '请求过于频繁',
  redirect_blocked: '地址重定向被拒绝',
  invalid_url: '地址格式不支持',
  local_not_allowed: '本机地址未获允许',
  cancelled: '已取消',
  interrupted: '服务重启中断',
  incomplete_stream: '流式回复中断',
  ai_not_configured: '未配置',
  ai_disabled: '已停用',
  generation_in_progress: '正在生成',
  too_many_generations: '生成任务过多',
  suggestion_expired: '建议已过期',
  not_adoptable: '该建议不能直接采用',
};

export function errorMessageForCode(code: AiErrorCode): string {
  return ERROR_MESSAGES[code] ?? '请求失败';
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly detail: string;

  constructor(code: AiErrorCode, message?: string, detail?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'AiError';
    this.code = code;
    this.detail = detail ?? message ?? ERROR_MESSAGES[code];
  }
}

// ---------- 主密钥 ----------

export function resolveMasterKeyPath(): string {
  const override = process.env.SHINIAN_MASTER_KEY_FILE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.resolve(__dirname, '../../db/master.key');
}

export function getMasterKeyStatus(): { path: string; exists: boolean } {
  const keyPath = resolveMasterKeyPath();
  return { path: keyPath, exists: fs.existsSync(keyPath) };
}

/** 首次需要加密时自动生成 32 字节主密钥（64 位小写 hex）。 */
export function ensureMasterKey(): Buffer {
  const keyPath = resolveMasterKeyPath();
  if (fs.existsSync(keyPath)) {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // 忽略：部分文件系统不支持 chmod
      }
    }
    return readMasterKey(keyPath);
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const hex = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, hex, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // 忽略：部分文件系统不支持 chmod
      }
    }
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
  return readMasterKey(keyPath);
}

function readMasterKey(keyPath: string): Buffer {
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`主密钥文件格式无效（需要 64 位 hex）：${keyPath}`);
  }
  return Buffer.from(raw, 'hex');
}

// ---------- 加解密 ----------

export function encryptSecret(plaintext: string, aad: string): string {
  const key = ensureMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext: string, aad: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new AiError('ai_not_configured', '无法解密已保存的凭据，请重新填写。');
  }
  const key = ensureMasterKey();
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const data = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new AiError('ai_not_configured', '无法解密已保存的凭据，请重新填写。');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptApiKey(plaintext: string): string {
  return encryptSecret(plaintext, MASTER_KEY_AAD);
}

export function decryptApiKey(ciphertext: string): string {
  try {
    return decryptSecret(ciphertext, MASTER_KEY_AAD);
  } catch {
    throw new AiError(
      'ai_not_configured',
      '无法解密已保存的 API Key，请重新填写。',
      '主密钥不匹配或密钥数据损坏，请重新填写 API Key。'
    );
  }
}

export function apiKeyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
}

export function computeTestFingerprint(input: {
  baseUrl: string;
  modelId: string;
  apiKeyFingerprint: string;
  allowLocal: boolean;
}): string {
  const payload = `${input.baseUrl}\n${input.modelId}\n${input.apiKeyFingerprint}\n${
    input.allowLocal ? '1' : '0'
  }`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------- URL 策略 ----------

export type UrlValidationResult =
  | { ok: true; baseUrl: string; hostname: string }
  | { ok: false; code: 'invalid_url' | 'local_not_allowed'; message: string };

function invalidUrl(message: string): UrlValidationResult {
  return { ok: false, code: 'invalid_url', message };
}

/** 判断 IP 字面量是否属于本机/内网/链路本地地址。 */
export function isPrivateAddress(address: string): boolean {
  let value = address.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return isPrivateAddress(mapped);
  }
  if (value === '::1' || value === '::' || value === '0:0:0:0:0:0:0:1') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    const octets = value.split('.').map((n) => Number(n));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 唯一本地地址 fc00::/7、链路本地 fe80::/10
  const firstHextet = Number.parseInt(value.split(':')[0] ?? '', 16);
  if (Number.isFinite(firstHextet)) {
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

/** localhost / *.localhost / *.local 以及私网 IP 字面量。 */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  return isPrivateAddress(host);
}

/**
 * 保存、测试、真实请求共用的 URL 规范化策略。
 * 返回 origin + pathname（不含末尾斜杠、查询串、fragment、账号密码）。
 */
export function validateAndNormalizeBaseUrl(
  raw: unknown,
  allowLocal: boolean
): UrlValidationResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return invalidUrl('请填写 Base URL。');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return invalidUrl('地址格式不正确，请填写完整的 http(s) 地址。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalidUrl('只支持 http:// 或 https:// 地址。');
  }
  if (url.username || url.password) {
    return invalidUrl('地址不能包含用户名或密码。');
  }
  if (url.search) return invalidUrl('地址不能包含查询参数。');
  if (url.hash) return invalidUrl('地址不能包含 fragment（# 片段）。');

  let pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const completionsSuffix = '/chat/completions';
  if (pathname.endsWith(completionsSuffix)) {
    pathname = pathname.slice(0, -completionsSuffix.length).replace(/\/+$/, '');
  }
  if (!pathname.endsWith('/v1')) pathname += '/v1';
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const hostname = url.hostname;
  if (isPrivateHost(hostname) && !allowLocal) {
    return {
      ok: false,
      code: 'local_not_allowed',
      message: '该地址属于本机/内网，请先勾选「允许本机/内网地址」。',
    };
  }
  return { ok: true, baseUrl: `${url.origin}${pathname}`, hostname };
}

/** 请求前校验完整 URL（由 provider 拼接后的地址）。 */
async function assertRequestUrlAllowed(rawUrl: string, allowLocal: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AiError('invalid_url', '地址格式不支持。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiError('invalid_url', '只支持 http:// 或 https:// 地址。');
  }
  if (url.username || url.password) {
    throw new AiError('invalid_url', '地址不能包含用户名或密码。');
  }
  if (isPrivateHost(url.hostname)) {
    if (!allowLocal) {
      throw new AiError('local_not_allowed', '该地址属于本机/内网，请先允许本机/内网地址。');
    }
    return;
  }
  if (allowLocal) return;

  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const isIpLiteral =
    /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host.includes('%');
  if (isIpLiteral) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new AiError('unreachable', '地址不可达。', `DNS 解析失败：${host}`);
  }
  if (addresses.length === 0) {
    throw new AiError('unreachable', '地址不可达。', `DNS 未返回可用地址：${host}`);
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new AiError(
        'local_not_allowed',
        '该地址解析到本机/内网，请先允许本机/内网地址。',
        `DNS 解析到内网地址：${host}`
      );
    }
  }
}

/**
 * 带策略的 fetch：redirect manual（任何 3xx 直接失败）、DNS 私网检查。
 * 所有模型请求都必须走这里。
 */
export function createGuardedFetch(options: { allowLocal: boolean }): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    await assertRequestUrlAllowed(rawUrl, options.allowLocal);
    const response = await fetch(rawUrl, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new AiError(
        'redirect_blocked',
        '地址重定向被拒绝。',
        `上游返回 HTTP ${response.status} 重定向，已拒绝跟随。`
      );
    }
    return response;
  };
}

// ---------- 错误归类与脱敏 ----------

export function redactSecrets(value: unknown, secrets: readonly string[] = []): string {
  let text =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.message
        : String(value ?? '');
  for (const secret of secrets) {
    if (secret && secret.length > 0) text = text.split(secret).join('[REDACTED]');
  }
  text = text.replace(
    /authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
    'Authorization: [REDACTED]'
  );
  text = text.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(
    /(api[_-]?key|apikey)\s*["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi,
    'apiKey: [REDACTED]'
  );
  text = text.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]');
  return text.slice(0, 500);
}

function rootCauseCode(error: unknown): string | undefined {
  let current: any = error;
  for (let i = 0; i < 5 && current; i += 1) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}

function isAbortLike(error: unknown): boolean {
  const err: any = error;
  return (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    err?.code === 'ABORT_ERR' ||
    /aborted|abort error/i.test(String(err?.message ?? ''))
  );
}

function upstreamMessage(error: APICallError): string {
  let message = error.message || '上游请求失败';
  if (error.responseBody) {
    try {
      const parsed = JSON.parse(error.responseBody) as any;
      const nested = parsed?.error?.message ?? parsed?.message;
      if (typeof nested === 'string' && nested.trim()) message = nested.trim();
    } catch {
      // 非 JSON 响应不把全文放进 detail
    }
  }
  return message.slice(0, 300);
}

export function classifyError(
  error: unknown,
  secrets: readonly string[] = []
): { code: AiErrorCode; detail: string } {
  if (error instanceof AiError) {
    return { code: error.code, detail: redactSecrets(error.detail, secrets) };
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const message = upstreamMessage(error);
    let code: AiErrorCode;
    if (status !== undefined && status >= 300 && status < 400) code = 'redirect_blocked';
    else if (status === 401 || status === 403) code = 'auth';
    else if (status === 404) code = 'model_unavailable';
    else if (status === 429) code = 'rate_limited';
    else if (status !== undefined && status >= 500) code = 'unreachable';
    else if (status !== undefined && status >= 200 && status < 300) code = 'invalid_response';
    else if (status === 400 && /model/i.test(message)) code = 'model_unavailable';
    else if (status !== undefined && status >= 400) code = 'invalid_response';
    else code = 'unreachable';
    const prefix = status !== undefined ? `HTTP ${status}：` : '';
    return { code, detail: redactSecrets(`${prefix}${message}`, secrets) };
  }
  const errorName = (error as any)?.name;
  if (
    typeof errorName === 'string' &&
    [
      'AI_InvalidResponseDataError',
      'AI_TypeValidationError',
      'AI_JSONParseError',
      'AI_EmptyResponseBodyError',
      'AI_NoContentGeneratedError',
      'InvalidResponseDataError',
      'TypeValidationError',
      'JSONParseError',
      'EmptyResponseBodyError',
      'NoContentGeneratedError',
    ].includes(errorName)
  ) {
    return { code: 'invalid_response', detail: redactSecrets(error, secrets) };
  }
  if (errorName === 'AI_NoSuchModelError' || errorName === 'NoSuchModelError') {
    return { code: 'model_unavailable', detail: redactSecrets(error, secrets) };
  }
  if (isAbortLike(error)) {
    return { code: 'timeout', detail: '请求超时，已停止等待。' };
  }
  const cause = rootCauseCode(error);
  if (cause && ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(cause)) {
    return { code: 'unreachable', detail: redactSecrets(`连接失败：${cause}`, secrets) };
  }
  return {
    code: 'unreachable',
    detail: redactSecrets(error instanceof Error ? error.message : String(error ?? '未知错误'), secrets),
  };
}

export function getAiTimeoutMs(): number {
  return readPositiveIntEnv('SHINIAN_AI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

export function getAiTestTimeoutMs(): number {
  return readPositiveIntEnv('SHINIAN_AI_TEST_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------- 设置读写 ----------

export type AiSettingsTestPublic = {
  status: string;
  testedAt: number | null;
  modelId: string | null;
  baseUrl: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  stale: boolean;
};

export type AiSettingsPublic = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  allowLocal: boolean;
  hasApiKey: boolean;
  configVersion: number;
  createdAt: number;
  updatedAt: number;
  test: AiSettingsTestPublic | null;
};

export type AiSettingsResponse = {
  configured: boolean;
  config: AiSettingsPublic | null;
  masterKey: { path: string; exists: boolean };
  limits: { maxCaptureChars: number; maxConstraintChars: number; timeoutMs: number };
};

export async function getSettingsRow(): Promise<AiSettings | undefined> {
  const rows = await db
    .select()
    .from(aiSettings)
    .where(eq(aiSettings.id, AI_SETTINGS_ID))
    .limit(1);
  return rows[0];
}

export function publicTestOf(row: AiSettings): AiSettingsTestPublic | null {
  if (!row.testStatus) return null;
  const currentFingerprint = computeTestFingerprint({
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    apiKeyFingerprint: row.apiKeyFingerprint,
    allowLocal: row.allowLocal === 1,
  });
  return {
    status: row.testStatus,
    testedAt: row.testedAt ?? null,
    modelId: row.testModelId ?? null,
    baseUrl: row.testBaseUrl ?? null,
    durationMs: row.testDurationMs ?? null,
    errorCode: row.testErrorCode ?? null,
    errorDetail: row.testErrorDetail ?? null,
    stale: row.testFingerprint !== currentFingerprint,
  };
}

export function publicConfigOf(row: AiSettings): AiSettingsPublic {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    enabled: row.enabled === 1,
    allowLocal: row.allowLocal === 1,
    hasApiKey: Boolean(row.apiKeyCiphertext),
    configVersion: row.configVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    test: publicTestOf(row),
  };
}

export async function getPublicSettings(): Promise<AiSettingsResponse> {
  const row = await getSettingsRow();
  return {
    configured: Boolean(row),
    config: row ? publicConfigOf(row) : null,
    masterKey: getMasterKeyStatus(),
    limits: {
      maxCaptureChars: MAX_CAPTURE_CHARS,
      maxConstraintChars: MAX_CONSTRAINT_CHARS,
      timeoutMs: getAiTimeoutMs(),
    },
  };
}

export type SaveAiSettingsInput = {
  name?: unknown;
  baseUrl?: unknown;
  modelId?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
  allowLocal?: unknown;
};

export type SaveAiSettingsResult =
  | { ok: true; changed: boolean; row: AiSettings }
  | { ok: false; field: string; message: string };

export async function saveAiSettings(input: SaveAiSettingsInput): Promise<SaveAiSettingsResult> {
  const existing = await getSettingsRow();

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 40) {
    return { ok: false, field: 'name', message: '配置名称需为 1–40 个字符。' };
  }
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  if (modelId.length < 1 || modelId.length > 120) {
    return { ok: false, field: 'modelId', message: 'Model ID 需为 1–120 个字符。' };
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { ok: false, field: 'enabled', message: 'enabled 必须是布尔值。' };
  }
  if (input.allowLocal !== undefined && typeof input.allowLocal !== 'boolean') {
    return { ok: false, field: 'allowLocal', message: 'allowLocal 必须是布尔值。' };
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    return { ok: false, field: 'apiKey', message: 'API Key 必须是字符串。' };
  }

  const allowLocal =
    typeof input.allowLocal === 'boolean'
      ? input.allowLocal
      : existing
        ? existing.allowLocal === 1
        : false;
  const enabled =
    typeof input.enabled === 'boolean' ? input.enabled : existing ? existing.enabled === 1 : true;

  const urlResult = validateAndNormalizeBaseUrl(input.baseUrl, allowLocal);
  if (!urlResult.ok) {
    return { ok: false, field: 'baseUrl', message: urlResult.message };
  }

  const rawApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!rawApiKey && !existing) {
    return { ok: false, field: 'apiKey', message: '首次配置必须填写 API Key。' };
  }
  if (!existing && !rawApiKey) {
    return { ok: false, field: 'apiKey', message: '首次配置必须填写 API Key。' };
  }

  const newFingerprint = rawApiKey ? apiKeyFingerprint(rawApiKey) : null;
  const keyChanged = newFingerprint !== null && newFingerprint !== existing?.apiKeyFingerprint;
  const changed =
    !existing ||
    existing.name !== name ||
    existing.baseUrl !== urlResult.baseUrl ||
    existing.modelId !== modelId ||
    (existing.enabled === 1) !== enabled ||
    (existing.allowLocal === 1) !== allowLocal ||
    keyChanged;

  if (existing && !changed) {
    return { ok: true, changed: false, row: existing };
  }

  const now = Date.now();
  if (!existing) {
    const row: typeof aiSettings.$inferInsert = {
      id: AI_SETTINGS_ID,
      name,
      baseUrl: urlResult.baseUrl,
      modelId,
      apiKeyCiphertext: encryptApiKey(rawApiKey),
      apiKeyFingerprint: apiKeyFingerprint(rawApiKey),
      enabled: enabled ? 1 : 0,
      allowLocal: allowLocal ? 1 : 0,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(aiSettings).values(row);
    const created = await getSettingsRow();
    return { ok: true, changed: true, row: created! };
  }

  const nextCiphertext = keyChanged ? encryptApiKey(rawApiKey) : existing.apiKeyCiphertext;
  const nextFingerprint = keyChanged ? newFingerprint! : existing.apiKeyFingerprint;
  await db
    .update(aiSettings)
    .set({
      name,
      baseUrl: urlResult.baseUrl,
      modelId,
      apiKeyCiphertext: nextCiphertext,
      apiKeyFingerprint: nextFingerprint,
      enabled: enabled ? 1 : 0,
      allowLocal: allowLocal ? 1 : 0,
      configVersion: existing.configVersion + 1,
      updatedAt: now,
    })
    .where(eq(aiSettings.id, AI_SETTINGS_ID));
  const updated = await getSettingsRow();
  return { ok: true, changed: true, row: updated! };
}

export async function deleteAiSettings(): Promise<void> {
  await db.delete(aiSettings).where(eq(aiSettings.id, AI_SETTINGS_ID));
}

export async function recordTestResult(
  input:
    | {
        ok: true;
        testedAt: number;
        modelId: string;
        baseUrl: string;
        durationMs: number;
        testFingerprint: string;
      }
    | {
        ok: false;
        testedAt: number;
        modelId: string;
        baseUrl: string;
        durationMs: number;
        testFingerprint: string;
        errorCode: AiErrorCode;
        errorDetail: string;
      }
): Promise<AiSettings | undefined> {
  const row = await getSettingsRow();
  if (!row) return undefined;
  await db
    .update(aiSettings)
    .set({
      testStatus: input.ok ? 'success' : 'failure',
      testedAt: input.testedAt,
      testModelId: input.modelId,
      testBaseUrl: input.baseUrl,
      testDurationMs: input.durationMs,
      testErrorCode: input.ok ? null : input.errorCode,
      testErrorDetail: input.ok ? null : input.errorDetail.slice(0, 500),
      testFingerprint: input.testFingerprint,
      updatedAt: input.testedAt,
    })
    .where(eq(aiSettings.id, AI_SETTINGS_ID));
  return getSettingsRow();
}
