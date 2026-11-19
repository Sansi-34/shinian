// 拾念 SHINIAN · 检索词扩展（不是语义搜索）
// 模型只接收问题与当前检索词，只返回可编辑的替代表达；不读取记录正文。
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  AiError,
  classifyError,
  decryptApiKey,
  getAiTimeoutMs,
  getSettingsRow,
} from './aiSettings';
import { callModel, extractJsonText, type ModelUsage, type ProviderConfig } from './aiProvider';
import {
  ASK_MAX_KEYWORDS_CHARS,
  ASK_MAX_QUESTION_CHARS,
  ASK_MAX_SUGGESTION_TERM_CHARS,
  ASK_MAX_SUGGESTION_TERMS,
  ASK_MAX_SUGGESTION_TOTAL_CHARS,
  type AskAiConfig,
  type AskKeywordSuggestionsResponse,
} from './askTypes';

export const KEYWORD_SUGGESTION_SYSTEM_PROMPT = [
  '你是「拾念」的检索词改写助手：只根据用户本次给出的问题和当前检索词，提出可能帮助找回旧记录的替代表达。',
  '你不回答原问题，不猜测用户以前做过什么，不编造记录、来源 ID、引用或链接，不生成事实结论。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏。JSON 字段：',
  '{"terms":["简短检索词"]}',
  '规则：',
  `- terms 最多 ${ASK_MAX_SUGGESTION_TERMS} 项；每项 1–${ASK_MAX_SUGGESTION_TERM_CHARS} 个字符；合计不超过 ${ASK_MAX_SUGGESTION_TOTAL_CHARS} 个字符。`,
  '- 每项是一个可直接用于本地子串检索的短词或短语，可包含中文、英文技术词或常见缩写。',
  '- 不要重复当前检索词；不要写句子、问题、解释、来源 ID、链接或记录正文。',
  '- 没有合适建议时返回 {"terms":[]}；不要为了凑数返回最近记录、宽泛词或无关词。',
  '- 专业词或缩写只是可选检索建议，不代表已经确定原因。',
  '- 不调用任何工具。',
].join('\n');

const keywordSuggestionSchema = z
  .object({
    terms: z
      .array(z.string().trim().min(1).max(ASK_MAX_SUGGESTION_TERM_CHARS))
      .max(ASK_MAX_SUGGESTION_TERMS),
  })
  .strict();

export type KeywordSuggestionParse =
  | { ok: true; terms: string[] }
  | { ok: false; detail: string };

function invalidSuggestion(detail: string): AiError {
  return new AiError('invalid_response', '检索词建议格式不支持。', detail);
}

function normalizeTermKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/**
 * 校验模型输出。允许空数组；最多 5 项、单项 40 字、合计 120 字；
 * 去重并过滤与当前检索词相同的项；不做任何 SQL/指令执行。
 */
export function parseKeywordSuggestions(
  raw: string,
  currentKeywords: string[] = []
): KeywordSuggestionParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (error) {
    if (error instanceof AiError) return { ok: false, detail: error.detail };
    return { ok: false, detail: '模型返回内容不是合法 JSON。' };
  }
  const result = keywordSuggestionSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      detail: `检索词建议字段校验失败：${issue ? `${issue.path.join('.') || 'root'}：${issue.message}` : '未知字段错误'}`,
    };
  }
  const current = new Set(currentKeywords.map(normalizeTermKey));
  const seen = new Set<string>();
  const terms: string[] = [];
  let total = 0;
  for (const item of result.data.terms) {
    const term = item.trim();
    if (!term || /[\u0000-\u001f\u007f]/u.test(term)) {
      return { ok: false, detail: '检索词建议包含空词或控制字符。' };
    }
    const key = normalizeTermKey(term);
    // 当前词已经由原检索覆盖，不把同一表达重复当成“扩展词”。
    if (current.has(key) || seen.has(key)) continue;
    total += Array.from(term).length;
    if (total > ASK_MAX_SUGGESTION_TOTAL_CHARS) {
      return { ok: false, detail: `检索词建议合计不能超过 ${ASK_MAX_SUGGESTION_TOTAL_CHARS} 个字符。` };
    }
    seen.add(key);
    terms.push(term);
    if (terms.length > ASK_MAX_SUGGESTION_TERMS) {
      return { ok: false, detail: `检索词建议最多 ${ASK_MAX_SUGGESTION_TERMS} 项。` };
    }
  }
  return { ok: true, terms };
}

export function buildKeywordSuggestionPrompt(question: string, keywords: string[]): string {
  return [
    `用户问题：${question}`,
    `当前检索词：${keywords.length > 0 ? keywords.join(' ') : '（空，浏览全部）'}`,
    '请只提出最多 5 个可能帮助找回旧记录的替代表达；不要回答原问题，不要引用任何记录正文。',
  ].join('\n');
}

export type KeywordSuggestionGeneration = {
  terms: string[];
  usage: ModelUsage | null;
  durationMs: number;
};

export async function generateKeywordSuggestions(
  config: ProviderConfig,
  input: { question: string; keywords: string[]; signal?: AbortSignal }
): Promise<KeywordSuggestionGeneration> {
  const result = await callModel(config, {
    system: KEYWORD_SUGGESTION_SYSTEM_PROMPT,
    prompt: buildKeywordSuggestionPrompt(input.question, input.keywords),
    maxOutputTokens: 220,
    temperature: 0.2,
    timeoutMs: getAiTimeoutMs(),
    signal: input.signal,
  });
  const parsed = parseKeywordSuggestions(result.text, input.keywords);
  if (!parsed.ok) throw invalidSuggestion(parsed.detail);
  return { terms: parsed.terms, usage: result.usage, durationMs: result.durationMs };
}

export function publicKeywordConfig(row: {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
}): AskAiConfig {
  return { id: row.id, name: row.name, modelId: row.modelId, configVersion: row.configVersion };
}

export type KeywordSuggestionRequest = {
  operationId: string;
  question: string;
  keywords: string[];
  topicId: string | null;
  scopeHash: string | null;
  configVersion: number;
};

export function keywordSuggestionFingerprint(input: KeywordSuggestionRequest): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        op: 'ask-keyword-suggestions',
        question: input.question,
        keywords: input.keywords,
        topicId: input.topicId,
        scopeHash: input.scopeHash,
        configVersion: input.configVersion,
      }),
      'utf8'
    )
    .digest('hex');
}

type CacheEntry = {
  fingerprint: string;
  response: AskKeywordSuggestionsResponse;
  expiresAt: number;
};

const resultCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, { fingerprint: string; promise: Promise<AskKeywordSuggestionsResponse> }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function pruneCache(now: number) {
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= now) resultCache.delete(key);
  }
}

/**
 * 同一 operationId 只产生一次模型请求。成功结果短期驻留内存；
 * 这是请求级幂等，不写数据库，也不缓存任何记录正文。
 */
export async function runKeywordSuggestionOnce(
  input: KeywordSuggestionRequest,
  execute: () => Promise<AskKeywordSuggestionsResponse>
): Promise<{ response: AskKeywordSuggestionsResponse; replayed: boolean }> {
  const now = Date.now();
  pruneCache(now);
  const cached = resultCache.get(input.operationId);
  const fingerprint = keywordSuggestionFingerprint(input);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      throw new AiError('generation_in_progress', 'operationId 已被另一个请求使用。');
    }
    return { response: cached.response, replayed: true };
  }
  const pending = inFlight.get(input.operationId);
  if (pending) {
    if (pending.fingerprint !== fingerprint) {
      throw new AiError('generation_in_progress', 'operationId 已被另一个请求使用。');
    }
    return { response: await pending.promise, replayed: true };
  }
  const promise = execute();
  inFlight.set(input.operationId, { fingerprint, promise });
  try {
    const response = await promise;
    resultCache.set(input.operationId, { fingerprint, response, expiresAt: Date.now() + CACHE_TTL_MS });
    return { response, replayed: false };
  } finally {
    inFlight.delete(input.operationId);
  }
}

/** 同步路由使用的配置读取；只返回脱敏字段，不返回密文或密钥。 */
export async function readKeywordSuggestionConfig(): Promise<{
  settings: Awaited<ReturnType<typeof getSettingsRow>>;
  config: AskAiConfig | null;
}> {
  const settings = await getSettingsRow();
  return {
    settings,
    config: settings ? publicKeywordConfig(settings) : null,
  };
}

export function classifyKeywordSuggestionError(
  error: unknown,
  apiKey: string
): { errorCode: string; message: string } {
  const classified = classifyError(error, apiKey ? [apiKey] : []);
  return { errorCode: classified.code, message: classified.detail.slice(0, 300) };
}

export async function decryptKeywordApiKey(ciphertext: string): Promise<string> {
  return decryptApiKey(ciphertext);
}

export function maxKeywordChars(): number {
  return ASK_MAX_KEYWORDS_CHARS;
}

export function maxQuestionChars(): number {
  return ASK_MAX_QUESTION_CHARS;
}
