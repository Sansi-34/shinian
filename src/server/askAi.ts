// 拾念 SHINIAN · 「问我的记录」模型调用与 HTTP 路由
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, sqlite } from '../db/db';
import { recordQueries } from '../db/schema';
import {
  AiError,
  classifyError,
  decryptApiKey,
  getAiTimeoutMs,
  getSettingsRow,
} from './aiSettings';
import { callModel, extractJsonText, type ModelCallResult, type ProviderConfig } from './aiProvider';
import {
  askContextToken,
  askListItemOf,
  markInterruptedAskQueries,
  normalizeExpandedTerms,
  normalizeKeywords,
  normalizeSourceKeys,
  parseAskRange,
  publicAskOf,
  readAskRecords,
  searchAskCandidates,
  sourcesSnapshotOf,
} from './askData';
import {
  ASK_DEFAULT_CANDIDATES,
  ASK_MAX_CANDIDATES,
  ASK_MAX_CHARS,
  ASK_MAX_KEYWORDS_CHARS,
  ASK_MAX_QUESTION_CHARS,
  ASK_MAX_RECORDS,
  type AskAiConfig,
  type AskAnswer,
  type AskPreviewResponse,
  type AskRecord,
  type AskSearchResponse,
} from './askTypes';
import { buildTopicAskScope, topicScopeSummary } from './topicService';
import type { TopicScope } from './topicTypes';
import {
  classifyKeywordSuggestionError,
  decryptKeywordApiKey,
  generateKeywordSuggestions,
  publicKeywordConfig,
  runKeywordSuggestionOnce,
  type KeywordSuggestionRequest,
} from './askKeywordSuggestions';

export { markInterruptedAskQueries };

export const ASK_SYSTEM_PROMPT = [
  '你是「拾念」的「问我的记录」助手：只根据用户本次确认发送的历史记录，回答关于他自己过去经历的问题。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏。JSON 字段：',
  '{"summary":string,"points":[{"text":string,"basis":"observation"|"inference","condition":string|null,"sourceIds":string[]}],"contradictions":[{"text":string,"sides":[{"sourceId":string,"condition":string}]}],"missing":string[],"insufficientEvidence":boolean}',
  '规则：',
  '- sourceIds/sides[].sourceId 只能使用记录列表每条开头方括号中的完整 ID（attempt:… / capture:…），不得编造、改写或使用未列出的 ID；每个 point 至少 1 条来源，每条 contradiction 至少 2 个 sides。',
  '- basis="observation" 只写记录中直接可见的事实；basis="inference" 只能写由记录推出的解释、关联或可能性。推断不得写成事实，不得添加记录中没有的时间、数量、结果或因果。',
  '- 写 observation 时，如果记录里有条件（频率、时长、环境、做法、占空比等），把其中最具体的条件放进 condition；记录没有写条件时 condition 为 null，并在 text 中明确「记录没有写下条件」，不要补造。',
  '- 如果两条记录对同一件事的结论不同，写入 contradictions；sides 分别列出两边，condition 写各自记录中的条件（没有就写「记录未写条件」），不要替用户判定哪条正确。',
  '- 证据不足时 insufficientEvidence=true，points/contradictions 可以为空，missing 必须具体说明缺什么（例如缺少结果、缺少当时条件、缺少后续引用记录）。',
  '- summary 只做 1–3 句简短回答；不要出现来源 ID、方括号或内部标记，来源链接由应用生成。',
  '- 不把模型推断说成用户实际观察；不编造用户经历；不提供心理诊断、鼓励套话或空泛建议。',
  '- 不调用任何工具。',
].join('\n');

const pointSchema = z.object({
  text: z.string().trim().min(1).max(400),
  basis: z.enum(['observation', 'inference']),
  condition: z.string().trim().max(200).nullable(),
  sourceIds: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
});

const contradictionSchema = z.object({
  text: z.string().trim().min(1).max(400),
  sides: z
    .array(
      z.object({
        sourceId: z.string().trim().min(1).max(120),
        condition: z.string().trim().min(1).max(200),
      })
    )
    .min(2)
    .max(4),
});

const askAnswerSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  points: z.array(pointSchema).max(10),
  contradictions: z.array(contradictionSchema).max(5),
  missing: z.array(z.string().trim().min(1).max(200)).max(6),
  insufficientEvidence: z.boolean(),
});

function invalidAnswer(detail: string): AiError {
  return new AiError('invalid_response', '响应格式不支持。', detail);
}

/** 严格解析模型回答：结构 + 来源必须属于本次发送记录。 */
export function parseAskAnswer(raw: string, sentKeys: string[]): AskAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw invalidAnswer('模型返回内容不是合法 JSON。');
  }
  const result = askAnswerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalidAnswer(
      `回答 JSON 字段校验失败：${issue ? `${issue.path.join('.') || 'root'}：${issue.message}` : '未知字段错误'}`
    );
  }
  const answer = result.data;
  const sent = new Set(sentKeys);
  for (const point of answer.points) {
    const seen = new Set<string>();
    for (const sourceId of point.sourceIds) {
      if (!sent.has(sourceId)) throw invalidAnswer(`point 包含未发送的来源：${sourceId}`);
      if (seen.has(sourceId)) throw invalidAnswer(`point 的 sourceIds 重复：${sourceId}`);
      seen.add(sourceId);
    }
  }
  for (const item of answer.contradictions) {
    const seen = new Set<string>();
    for (const side of item.sides) {
      if (!sent.has(side.sourceId)) throw invalidAnswer(`contradiction 包含未发送的来源：${side.sourceId}`);
      if (seen.has(side.sourceId)) throw invalidAnswer(`contradiction 的 sides 重复：${side.sourceId}`);
      seen.add(side.sourceId);
    }
  }
  const empty = answer.points.length === 0 && answer.contradictions.length === 0;
  if (empty && !answer.insufficientEvidence) {
    throw invalidAnswer('points 与 contradictions 均为空且 insufficientEvidence=false。');
  }
  if (answer.insufficientEvidence && answer.missing.length === 0) {
    throw invalidAnswer('insufficientEvidence=true 时 missing 必须说明缺少什么。');
  }
  return answer;
}

const STATE_LABELS: Record<string, string> = {
  todo: '未开始',
  in_progress: '进行中',
  done: '已结束',
  cancelled: '已放弃',
};
const OUTCOME_LABELS: Record<string, string> = {
  success: '成功',
  failure: '失败',
  undetermined: '未确定',
};

function formatLocal(ms: number, timeZone = 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function oneLine(text: string | null | undefined, max = 1800): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatAskRecord(record: AskRecord): string[] {
  const lines: string[] = [];
  if (record.type === 'attempt') {
    const date = record.observedAt ?? record.createdAt;
    const dateLabel = record.observedAt ? '结果时间' : '记录时间';
    const outcome = record.outcome ? `｜评价：${OUTCOME_LABELS[record.outcome] ?? record.outcome}` : '';
    lines.push(
      `[${record.sourceKey}] 尝试｜${dateLabel}：${formatLocal(date)}｜当前状态：${STATE_LABELS[record.state ?? ''] ?? record.state}${outcome}`
    );
    lines.push(`步骤：${oneLine(record.text) || '（空）'}`);
    lines.push(`结果：${record.resultText && record.resultText.trim() ? oneLine(record.resultText) : '（没有记录结果）'}`);
    lines.push(`所属念头：${oneLine(record.captureText, 500) || '（空）'}`);
  } else {
    lines.push(
      `[${record.sourceKey}] 念头｜创建于：${formatLocal(record.createdAt ?? 0)}${record.archived ? '｜已归档' : ''}`
    );
    lines.push(`正文：${oneLine(record.text) || '（空）'}`);
  }
  return lines;
}

function referenceLines(records: AskRecord[]): string[] {
  const attemptIds = new Set(records.filter((record) => record.type === 'attempt').map((record) => record.id));
  if (attemptIds.size === 0) return [];
  const placeholders = [...attemptIds].map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT r.note, r.from_attempt_id AS fromId, r.to_attempt_id AS toId,
              f.step AS fromStep, t.step AS toStep
         FROM attempt_references r
         JOIN attempts f ON f.id = r.from_attempt_id
         JOIN attempts t ON t.id = r.to_attempt_id
        WHERE r.from_attempt_id IN (${placeholders}) AND r.to_attempt_id IN (${placeholders})`
    )
    .all(...[...attemptIds], ...[...attemptIds]) as Array<{
    note: string | null;
    fromId: string;
    toId: string;
    fromStep: string;
    toStep: string;
  }>;
  if (rows.length === 0) return [];
  const lines = ['', '明确引用关系（只列本次已发送记录之间的真实引用）：'];
  for (const row of rows) {
    lines.push(
      `[attempt:${row.fromId}]「${oneLine(row.fromStep, 80)}」引用了 [attempt:${row.toId}]「${oneLine(row.toStep, 80)}」${row.note ? `；说明：${oneLine(row.note, 200)}` : ''}`
    );
  }
  return lines;
}

export type AskPromptInput = {
  question: string;
  keywords: string[];
  range: { from: number | null; to: number | null };
  records: AskRecord[];
};

/** 与实际发送内容完全一致的 user prompt；selectedChars 用它计算。 */
export function buildAskUserPrompt(input: AskPromptInput): string {
  const lines = [
    '请回答用户关于他自己过去经历的问题。',
    '',
    `用户的问题：${input.question}`,
  ];
  if (input.keywords.length > 0) lines.push(`检索关键词：${input.keywords.join(' ')}`);
  if (input.range.from !== null || input.range.to !== null) {
    lines.push(
      `用户限定的记录日期范围：${input.range.from !== null ? formatLocal(input.range.from).slice(0, 10) : '不限'} 至 ${
        input.range.to !== null ? formatLocal(input.range.to).slice(0, 10) : '不限'
      }（结束日期不包含）`
    );
  }
  lines.push('', '记录列表（方括号内是唯一来源 ID；只能引用这些 ID）：');
  for (const record of input.records) lines.push(...formatAskRecord(record));
  lines.push(...referenceLines(input.records));
  lines.push(
    '',
    '请只输出一个 JSON 对象，不要 Markdown 或代码围栏。区分 observation 与 inference；personal facts 必须带 sourceIds；证据不足时明确写 missing。'
  );
  return lines.join('\n');
}

export type GenerateAskResult = {
  answer: AskAnswer;
  usage: ModelCallResult['usage'];
  durationMs: number;
};

export async function generateAskAnswer(
  config: ProviderConfig,
  input: AskPromptInput & { signal?: AbortSignal }
): Promise<GenerateAskResult> {
  const result = await callModel(config, {
    system: ASK_SYSTEM_PROMPT,
    prompt: buildAskUserPrompt(input),
    maxOutputTokens: 1000,
    temperature: 0.2,
    timeoutMs: getAiTimeoutMs(),
    signal: input.signal,
  });
  const answer = parseAskAnswer(
    result.text,
    input.records.map((record) => record.sourceKey)
  );
  return { answer, usage: result.usage, durationMs: result.durationMs };
}

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? 'error'));
    this.status = status;
    this.body = body;
  }
}

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function parseQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const question = value.trim();
  if (!question || question.length > ASK_MAX_QUESTION_CHARS) return null;
  return question;
}

const INVALID_TOPIC_ID = Symbol('invalid-topic-id');

function parseTopicIdValue(value: unknown): string | null | typeof INVALID_TOPIC_ID {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return INVALID_TOPIC_ID;
  const id = value.trim();
  return id || null;
}

function publicConfigOfSettings(row: {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
}): AskAiConfig {
  return { id: row.id, name: row.name, modelId: row.modelId, configVersion: row.configVersion };
}

type BackgroundAskConfig = {
  baseUrl: string;
  modelId: string;
  allowLocal: boolean;
  apiKeyCiphertext: string;
};

const runningQueries = new Map<string, AbortController>();

async function runAsk(
  fastify: FastifyInstance,
  queryId: string,
  input: AskPromptInput,
  config: BackgroundAskConfig
): Promise<void> {
  const initial = sqlite
    .prepare('SELECT status FROM record_queries WHERE id = ?')
    .get(queryId) as { status: string } | undefined;
  if (!initial || initial.status !== 'pending') return;
  const controller = new AbortController();
  runningQueries.set(queryId, controller);
  const startedAt = Date.now();
  let apiKey = '';
  try {
    apiKey = decryptApiKey(config.apiKeyCiphertext);
    const result = await generateAskAnswer(
      { baseUrl: config.baseUrl, modelId: config.modelId, apiKey, allowLocal: config.allowLocal },
      { ...input, signal: controller.signal }
    );
    const finishedAt = Date.now();
    sqlite
      .prepare(
        `UPDATE record_queries
            SET status = 'succeeded', answer_json = ?, error_code = NULL, error_detail = NULL,
                usage_json = ?, duration_ms = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(
        JSON.stringify(result.answer),
        result.usage ? JSON.stringify(result.usage) : null,
        result.durationMs,
        finishedAt,
        finishedAt,
        queryId
      );
  } catch (error) {
    const classified = classifyError(error, apiKey ? [apiKey] : []);
    const durationMs = Date.now() - startedAt;
    const finishedAt = Date.now();
    if (controller.signal.aborted && classified.code !== 'timeout') {
      sqlite
        .prepare(
          `UPDATE record_queries
              SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run('已取消本次提问。', durationMs, finishedAt, finishedAt, queryId);
    } else {
      sqlite
        .prepare(
          `UPDATE record_queries
              SET status = 'failed', error_code = ?, error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run(classified.code, classified.detail.slice(0, 500), durationMs, finishedAt, finishedAt, queryId);
    }
    fastify.log.info({ queryId, errorCode: classified.code }, 'AI 问答未成功');
  } finally {
    runningQueries.delete(queryId);
  }
}

function queryFingerprint(input: {
  question: string;
  keywords: string[];
  range: { from: number | null; to: number | null };
  sourceKeys: string[];
  contextToken: string;
  topicId?: string | null;
}): string {
  const payload: Record<string, unknown> = {
    op: 'ask-query',
    question: input.question,
    keywords: input.keywords,
    from: input.range.from,
    to: input.range.to,
    sourceKeys: [...input.sourceKeys].sort(),
    contextToken: input.contextToken,
  };
  if (input.topicId) payload.topicId = input.topicId;
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

// 原生 SQL 必须显式别名，publicAskOf 只接受 camelCase 字段。
const ASK_QUERY_COLUMNS = `id, question, keywords,
  range_from AS rangeFrom, range_to AS rangeTo, status,
  answer_json AS answerJson, sources_json AS sourcesJson,
  config_id AS configId, config_version AS configVersion,
  config_name AS configName, model_id AS modelId,
  usage_json AS usageJson, duration_ms AS durationMs,
  error_code AS errorCode, error_detail AS errorDetail,
  created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt`;

type AskQueryRow = Parameters<typeof publicAskOf>[0] & {
  operationFingerprint?: string | null;
};

function queryRowById(id: string): AskQueryRow | undefined {
  return sqlite
    .prepare(`SELECT ${ASK_QUERY_COLUMNS} FROM record_queries WHERE id = ?`)
    .get(id) as AskQueryRow | undefined;
}

export function registerAskRoutes(fastify: FastifyInstance): void {
  // 只把问题与当前检索词发给模型，生成最多 5 个可编辑的替代检索词。
  fastify.post('/api/ask/keyword-suggestions', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = parseQuestion(body.question);
    if (!question) {
      return reply.code(400).send({
        error: 'invalid_question',
        field: 'question',
        message: `问题不能为空且不能超过 ${ASK_MAX_QUESTION_CHARS} 个字符。`,
      });
    }
    const keywordResult = normalizeKeywords(body.keywords, question);
    if (!keywordResult.ok) {
      return reply.code(400).send({
        error: 'invalid_keywords',
        field: 'keywords',
        message: `关键词不能超过 ${ASK_MAX_KEYWORDS_CHARS} 个字符。`,
      });
    }
    const topicId = parseTopicIdValue(body.topicId);
    if (topicId === INVALID_TOPIC_ID) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'topicId',
        message: 'topicId 必须是字符串。',
      });
    }
    const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (!operationId || operationId.length > 200) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 不能为空且不能超过 200 个字符。',
      });
    }
    const configVersion = Number(body.configVersion);
    if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'configVersion',
        message: 'configVersion 必须是正整数。',
      });
    }
    let scopeHash: string | null = null;
    if (body.scopeHash !== undefined && body.scopeHash !== null && body.scopeHash !== '') {
      if (typeof body.scopeHash !== 'string') {
        return reply.code(400).send({
          error: 'invalid_request',
          field: 'scopeHash',
          message: 'scopeHash 必须是字符串。',
        });
      }
      scopeHash = body.scopeHash.trim();
    }
    if (!topicId && scopeHash) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'scopeHash',
        message: '全库检索不应带 scopeHash。',
      });
    }

    const settings = await getSettingsRow();
    if (!settings || !settings.apiKeyCiphertext) {
      return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
    }
    if (settings.enabled !== 1) {
      return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
    }
    if (settings.configVersion !== configVersion) {
      return reply.code(409).send({
        error: 'config_changed',
        message: 'AI 模型配置已变化，请重新展开后再试。',
      });
    }

    let topicScope: TopicScope | null = null;
    if (topicId) {
      topicScope = buildTopicAskScope(topicId);
      if (!topicScope) {
        return reply.code(404).send({ error: 'topic_not_found', message: '主题已不存在。' });
      }
      if (scopeHash && scopeHash !== topicScope.scopeHash) {
        return reply.code(409).send({
          error: 'topic_scope_changed',
          message: '主题范围已变化，请重新展开后再试。',
        });
      }
    }

    const config = publicKeywordConfig(settings);
    const request: KeywordSuggestionRequest = {
      operationId,
      question,
      keywords: keywordResult.value,
      topicId,
      scopeHash: scopeHash ?? null,
      configVersion,
    };
    let apiKey = '';
    try {
      const outcome = await runKeywordSuggestionOnce(request, async () => {
        apiKey = await decryptKeywordApiKey(settings.apiKeyCiphertext);
        const controller = new AbortController();
        const onClose = () => controller.abort();
        req.raw.once('close', onClose);
        try {
          const generated = await generateKeywordSuggestions(
            {
              baseUrl: settings.baseUrl,
              modelId: settings.modelId,
              apiKey,
              allowLocal: settings.allowLocal === 1,
            },
            { question, keywords: keywordResult.value, signal: controller.signal }
          );
          return {
            question,
            keywords: keywordResult.value,
            terms: generated.terms,
            config,
            usage: generated.usage,
            durationMs: generated.durationMs,
            generatedAt: Date.now(),
            ...(topicScope ? { topic: topicScopeSummary(topicScope) } : {}),
          };
        } finally {
          req.raw.removeListener('close', onClose);
        }
      });
      return reply.send({ ...outcome.response, replayed: outcome.replayed });
    } catch (error) {
      if (error instanceof AiError && error.code === 'generation_in_progress') {
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: '这个操作正在进行或已被另一个请求使用。',
        });
      }
      const classified = classifyKeywordSuggestionError(error, apiKey);
      fastify.log.info({ errorCode: classified.errorCode }, '检索词建议未成功');
      return reply.code(502).send({
        error: 'ai_failed',
        errorCode: classified.errorCode,
        message: classified.message,
      });
    }
  });

  fastify.get('/api/ask/candidates', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as {
      question?: string;
      keywords?: string;
      expanded?: string | string[];
      from?: string;
      to?: string;
      limit?: string;
    };
    const question = parseQuestion(query.question);
    if (!question) {
      return reply.code(400).send({
        error: 'invalid_question',
        field: 'question',
        message: `问题不能为空且不能超过 ${ASK_MAX_QUESTION_CHARS} 个字符。`,
      });
    }
    const rangeResult = parseAskRange(query.from, query.to);
    if (!rangeResult.ok) return reply.code(400).send(rangeResult);
    const keywordResult = normalizeKeywords(query.keywords, question);
    if (!keywordResult.ok) {
      return reply.code(400).send({
        error: 'invalid_keywords',
        field: 'keywords',
        message: `关键词不能超过 ${ASK_MAX_KEYWORDS_CHARS} 个字符。`,
      });
    }
    const expandedResult = normalizeExpandedTerms(query.expanded, keywordResult.value);
    if (!expandedResult.ok) {
      return reply.code(400).send({
        error: 'invalid_expanded_keywords',
        field: 'expanded',
        message: expandedResult.message,
      });
    }
    const limit = Math.max(
      1,
      Math.min(ASK_MAX_CANDIDATES, Number.parseInt(query.limit ?? String(ASK_DEFAULT_CANDIDATES), 10) || ASK_DEFAULT_CANDIDATES)
    );
    const search = searchAskCandidates({
      question,
      keywords: keywordResult.value,
      expandedTerms: expandedResult.value,
      range: rangeResult.range,
      limit,
    });
    const settings = await getSettingsRow();
    const response: AskSearchResponse = {
      question,
      keywords: keywordResult.value,
      suggestedKeywords: keywordResult.value.join(' '),
      expandedKeywords: expandedResult.value,
      range: rangeResult.range,
      total: search.total,
      limit,
      candidates: search.candidates,
      ai: {
        configured: Boolean(settings && settings.apiKeyCiphertext),
        enabled: Boolean(settings && settings.enabled === 1),
        config: settings ? publicConfigOfSettings(settings) : null,
      },
      generatedAt: Date.now(),
    };
    return response;
  });

  fastify.post('/api/ask/preview', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = parseQuestion(body.question);
    if (!question) {
      return reply.code(400).send({
        error: 'invalid_question',
        field: 'question',
        message: `问题不能为空且不能超过 ${ASK_MAX_QUESTION_CHARS} 个字符。`,
      });
    }
    const rangeResult = parseAskRange(body.from, body.to);
    if (!rangeResult.ok) return reply.code(400).send(rangeResult);
    const keywordResult = normalizeKeywords(body.keywords, question);
    if (!keywordResult.ok) {
      return reply.code(400).send({
        error: 'invalid_keywords',
        field: 'keywords',
        message: `关键词不能超过 ${ASK_MAX_KEYWORDS_CHARS} 个字符。`,
      });
    }
    const keyResult = normalizeSourceKeys(body.sourceKeys);
    if (!keyResult.ok) {
      return reply.code(400).send({ error: 'invalid_sources', message: keyResult.message });
    }
    const topicId = parseTopicIdValue(body.topicId);
    if (topicId === INVALID_TOPIC_ID) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'topicId',
        message: 'topicId 必须是字符串。',
      });
    }
    let topicScope: TopicScope | null = null;
    if (topicId) {
      topicScope = buildTopicAskScope(topicId);
      if (!topicScope) {
        return reply.code(404).send({ error: 'topic_not_found', message: '主题已不存在。' });
      }
      const outOfScope = keyResult.keys.filter(
        (key) => !topicScope!.allowedSourceKeys.includes(key)
      );
      if (outOfScope.length > 0) {
        return reply.code(400).send({
          error: 'source_out_of_scope',
          sourceKeys: outOfScope,
          message: '所选记录不在这个主题的范围内，请重新选择。',
        });
      }
    }
    const read = readAskRecords(keyResult.keys);
    if (read.unavailableKeys.length > 0) {
      return reply.code(409).send({
        error: 'sources_unavailable',
        sourceKeys: read.unavailableKeys,
        message: '有记录已被删除或不可访问，请重新检索。',
      });
    }
    const settings = await getSettingsRow();
    const config = settings ? publicConfigOfSettings(settings) : null;
    const prompt = buildAskUserPrompt({
      question,
      keywords: keywordResult.value,
      range: rangeResult.range,
      records: read.records,
    });
    const response: AskPreviewResponse = {
      question,
      keywords: keywordResult.value,
      range: rangeResult.range,
      config,
      ai: {
        configured: Boolean(settings && settings.apiKeyCiphertext),
        enabled: Boolean(settings && settings.enabled === 1),
      },
      records: read.records,
      coverage: {
        selectedRecords: read.records.length,
        selectedChars: prompt.length,
        maxRecords: ASK_MAX_RECORDS,
        maxChars: ASK_MAX_CHARS,
        withinLimit: read.records.length <= ASK_MAX_RECORDS && prompt.length <= ASK_MAX_CHARS,
      },
      contextToken: askContextToken({
        question,
        keywords: keywordResult.value,
        range: rangeResult.range,
        configVersion: config?.configVersion ?? null,
        records: read.records,
        topic: topicScope
          ? {
              topicId: topicScope.topicId,
              topicRevision: topicScope.topicRevision,
              scopeHash: topicScope.scopeHash,
            }
          : null,
      }),
      ...(topicScope ? { scope: topicScopeSummary(topicScope) } : {}),
    };
    return response;
  });

  fastify.post('/api/ask/queries', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = parseQuestion(body.question);
    if (!question) {
      return reply.code(400).send({
        error: 'invalid_question',
        field: 'question',
        message: `问题不能为空且不能超过 ${ASK_MAX_QUESTION_CHARS} 个字符。`,
      });
    }
    const rangeResult = parseAskRange(body.from, body.to);
    if (!rangeResult.ok) return reply.code(400).send(rangeResult);
    const keywordResult = normalizeKeywords(body.keywords, question);
    if (!keywordResult.ok) {
      return reply.code(400).send({
        error: 'invalid_keywords',
        field: 'keywords',
        message: `关键词不能超过 ${ASK_MAX_KEYWORDS_CHARS} 个字符。`,
      });
    }
    const keyResult = normalizeSourceKeys(body.sourceKeys);
    if (!keyResult.ok) {
      return reply.code(400).send({ error: 'invalid_sources', message: keyResult.message });
    }
    const topicId = parseTopicIdValue(body.topicId);
    if (topicId === INVALID_TOPIC_ID) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'topicId',
        message: 'topicId 必须是字符串。',
      });
    }
    const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (!operationId || operationId.length > 200) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 不能为空且不能超过 200 个字符。',
      });
    }
    const providedToken = typeof body.contextToken === 'string' ? body.contextToken.trim() : '';
    if (!providedToken) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'contextToken',
        message: '请先核对发送内容并带上 contextToken。',
      });
    }
    const requestFingerprint = queryFingerprint({
      question,
      keywords: keywordResult.value,
      range: rangeResult.range,
      sourceKeys: keyResult.keys,
      contextToken: providedToken,
      topicId,
    });

    const existing = sqlite
      .prepare(
        `SELECT ${ASK_QUERY_COLUMNS}, operation_fingerprint AS operationFingerprint
           FROM record_queries WHERE operation_id = ?`
      )
      .get(operationId) as AskQueryRow | undefined;
    if (existing) {
      if (existing.operationFingerprint !== requestFingerprint) {
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: 'operationId 已被另一个请求使用。',
        });
      }
      const replayScope = topicId ? buildTopicAskScope(topicId) : null;
      return reply.code(200).send({
        query: publicAskOf(existing),
        replayed: true,
        ...(replayScope ? { scope: topicScopeSummary(replayScope) } : {}),
      });
    }

    let topicScope: TopicScope | null = null;
    if (topicId) {
      topicScope = buildTopicAskScope(topicId);
      if (!topicScope) {
        return reply.code(404).send({ error: 'topic_not_found', message: '主题已不存在。' });
      }
      const outOfScope = keyResult.keys.filter(
        (key) => !topicScope!.allowedSourceKeys.includes(key)
      );
      if (outOfScope.length > 0) {
        return reply.code(400).send({
          error: 'source_out_of_scope',
          sourceKeys: outOfScope,
          message: '所选记录不在这个主题的范围内，请重新选择。',
        });
      }
    }

    const settings = await getSettingsRow();
    if (!settings || !settings.apiKeyCiphertext) {
      return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
    }
    if (settings.enabled !== 1) {
      return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
    }
    const read = readAskRecords(keyResult.keys);
    if (read.unavailableKeys.length > 0) {
      return reply.code(409).send({
        error: 'sources_unavailable',
        sourceKeys: read.unavailableKeys,
        message: '有记录已被删除或不可访问，请重新检索。',
      });
    }
    const prompt = buildAskUserPrompt({
      question,
      keywords: keywordResult.value,
      range: rangeResult.range,
      records: read.records,
    });
    if (read.records.length > ASK_MAX_RECORDS || prompt.length > ASK_MAX_CHARS) {
      return reply.code(409).send({
        error: 'query_too_large',
        message: '记录过多或内容过长，请减少勾选。',
        recordCount: read.records.length,
        maxRecords: ASK_MAX_RECORDS,
        charCount: prompt.length,
        maxChars: ASK_MAX_CHARS,
      });
    }
    const expectedToken = askContextToken({
      question,
      keywords: keywordResult.value,
      range: rangeResult.range,
      configVersion: settings.configVersion,
      records: read.records,
      topic: topicScope
        ? {
            topicId: topicScope.topicId,
            topicRevision: topicScope.topicRevision,
            scopeHash: topicScope.scopeHash,
          }
        : null,
    });
    if (expectedToken !== providedToken) {
      return reply.code(409).send({
        error: 'context_changed',
        message: topicScope
          ? '主题成员或来源已变化，请刷新预览并重新确认。'
          : '核对后记录或配置有变化，请刷新预览并重新确认。',
      });
    }

    const queryId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    let created: Parameters<typeof publicAskOf>[0];
    try {
      created = sqlite.transaction(() => {
        const pendingCount = (
          sqlite
            .prepare(`SELECT COUNT(*) AS c FROM record_queries WHERE status = 'pending'`)
            .get() as { c: number }
        ).c;
        if (pendingCount >= 2) {
          throw new HttpError(429, {
            error: 'too_many_queries',
            message: '当前问答任务过多，请稍后再试。',
          });
        }
        const row = db
          .insert(recordQueries)
          .values({
            id: queryId,
            question,
            keywords: keywordResult.value.join(' '),
            rangeFrom: rangeResult.range.from,
            rangeTo: rangeResult.range.to,
            status: 'pending',
            answerJson: null,
            sourcesJson: JSON.stringify(sourcesSnapshotOf(read.records)),
            configId: settings.id,
            configVersion: settings.configVersion,
            configName: settings.name,
            modelId: settings.modelId,
            operationId,
            operationFingerprint: requestFingerprint,
            contextToken: expectedToken,
            createdAt,
            updatedAt: createdAt,
          })
          .returning()
          .all()[0]!;
        return row as unknown as Parameters<typeof publicAskOf>[0];
      })();
    } catch (error) {
      if (error instanceof HttpError) return reply.code(error.status).send(error.body);
      const raced = sqlite
        .prepare(
          `SELECT ${ASK_QUERY_COLUMNS}, operation_fingerprint AS operationFingerprint
             FROM record_queries WHERE operation_id = ?`
        )
        .get(operationId) as AskQueryRow | undefined;
      if (raced) {
        if (raced.operationFingerprint === requestFingerprint) {
          const racedScope = topicId ? buildTopicAskScope(topicId) : null;
          return reply.code(200).send({
            query: publicAskOf(raced),
            replayed: true,
            ...(racedScope ? { scope: topicScopeSummary(racedScope) } : {}),
          });
        }
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: 'operationId 已被另一个请求使用。',
        });
      }
      throw error;
    }

    const backgroundConfig: BackgroundAskConfig = {
      baseUrl: settings.baseUrl,
      modelId: settings.modelId,
      allowLocal: settings.allowLocal === 1,
      apiKeyCiphertext: settings.apiKeyCiphertext,
    };
    setImmediate(() => {
      void runAsk(
        fastify,
        queryId,
        {
          question,
          keywords: keywordResult.value,
          range: rangeResult.range,
          records: read.records,
        },
        backgroundConfig
      );
    });
    return reply.code(202).send({
      query: publicAskOf(created),
      replayed: false,
      ...(topicScope ? { scope: topicScopeSummary(topicScope) } : {}),
    });
  });

  fastify.get('/api/ask/queries', { preHandler: requireAuth }, async (req) => {
    const query = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(50, Number.parseInt(query.limit ?? '20', 10) || 20));
    const rows = sqlite
      .prepare(`SELECT ${ASK_QUERY_COLUMNS} FROM record_queries ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as AskQueryRow[];
    return { queries: rows.map((row) => askListItemOf(row)) };
  });

  fastify.get('/api/ask/queries/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = queryRowById(id);
    if (!row) {
      return reply.code(404).send({ error: 'query_not_found', message: '这次提问不存在。' });
    }
    return { query: publicAskOf(row) };
  });

  fastify.post('/api/ask/queries/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = queryRowById(id);
    if (!row) {
      return reply.code(404).send({ error: 'query_not_found', message: '这次提问不存在。' });
    }
    if (row.status !== 'pending') {
      return reply.code(409).send({ error: 'not_cancellable', message: '这次提问已结束，无法取消。' });
    }
    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE record_queries
            SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run('已取消本次提问。', t, t, id);
    if (result.changes === 0) {
      return reply.code(409).send({ error: 'not_cancellable', message: '这次提问已结束，无法取消。' });
    }
    runningQueries.get(id)?.abort();
    const updated = queryRowById(id);
    return { query: publicAskOf(updated!) };
  });
}
