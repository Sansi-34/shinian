import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, sqlite } from '../db/db';
import { stageReviews, type StageReview } from '../db/schema';
import { AiError, classifyError, decryptApiKey, getAiTimeoutMs, getSettingsRow } from './aiSettings';
import { callModel, extractJsonText, type ModelCallResult, type ProviderConfig } from './aiProvider';
import {
  makeReviewRange,
  parseReviewRange,
  publicReviewOf,
  readReviewRecordsByKeys,
  toReviewSources,
} from './reviewData';
import type {
  ReviewAiConfig,
  ReviewContent,
  ReviewPreviewCoverage,
  ReviewPreviewResponse,
  ReviewRange,
  ReviewRecord,
  ReviewStats,
} from './reviewTypes';
import { REVIEW_MAX_CHARS, REVIEW_MAX_RECORDS, REVIEW_MAX_SELECT_KEYS } from './reviewTypes';

export { markInterruptedReviews } from './reviewData';

export const REVIEW_SYSTEM_PROMPT = [
  '你是「拾念」的阶段回顾助手：把用户在一段时间内真实记录的念头、尝试、结果与引用，整理成简短、具体、可核对的回顾。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏。JSON 字段：',
  '{"overview":string,"attempts":Item[],"observations":Item[],"connections":Item[],"experiences":Item[],"uncertainties":string[],"insufficientData":boolean,"dataNotes":string|null}',
  'Item 为 {"text":string,"basis":"observation"|"inference","sourceIds":string[]}；每个 item 的 sourceIds 至少 1 条、最多 6 条，只能使用记录列表每条开头方括号中的完整 ID（capture:… / attempt:… / reference:…），不得编造、改写或使用未列出的 ID。',
  '规则：',
  '- basis="observation" 只写记录中直接可见的事实；basis="inference" 写由记录推出的关联、解释或下次可参考的做法。推断必须能从所引用的记录出发，不夸大。',
  '- 只依据本次发送的记录。记录不足时 insufficientData=true，并在 uncertainties 或 dataNotes 中明确说明缺什么；此时四个数组可以为空。',
  '- 所有四个区块都为空时，insufficientData 必须为 true。',
  '- 修改旧记录只表示修改，不得当作新的尝试、新的完成或新的结果；不得推算不存在的历史状态或结束时间。',
  '- 「用户完成一次练习，只能说明完成了该练习」：不得据此推断能力、水平、天赋、疗效或长期效果。',
  '- 不把尝试开始当作结束；不把当前状态当作期间内发生的状态变化；结果时间缺失时要说明时间未知。',
  '- 不做心理诊断，不写鼓励套话、空泛总结或建议清单；句子简短、具体，尽量引用记录中的条件与结果。',
  '- 不调用任何工具。',
].join('\n');

const reviewItemSchema = z.object({
  text: z.string().trim().min(1).max(500),
  basis: z.enum(['observation', 'inference']),
  sourceIds: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
});
const reviewContentSchema = z.object({
  overview: z.string().trim().min(1).max(800),
  attempts: z.array(reviewItemSchema).max(8),
  observations: z.array(reviewItemSchema).max(10),
  connections: z.array(reviewItemSchema).max(8),
  experiences: z.array(reviewItemSchema).max(8),
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(8),
  insufficientData: z.boolean(),
  dataNotes: z.string().trim().max(500).nullable(),
});

function invalidReview(detail: string): AiError {
  return new AiError('invalid_response', '响应格式不支持。', detail);
}

/** 严格解析模型回顾：Zod 结构校验 + 来源/空区块语义校验。失败抛 invalid_response。 */
export function parseReviewOutput(raw: string, sentKeys: string[]): ReviewContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw invalidReview('模型返回内容不是合法 JSON。');
  }
  const result = reviewContentSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalidReview(
      `回顾 JSON 字段校验失败：${issue ? `${issue.path.join('.') || 'root'}：${issue.message}` : '未知字段错误'}`
    );
  }
  const content = result.data;
  const sent = new Set(sentKeys);
  const sections = {
    attempts: content.attempts,
    observations: content.observations,
    connections: content.connections,
    experiences: content.experiences,
  };
  for (const [name, items] of Object.entries(sections)) {
    for (const item of items) {
      const seen = new Set<string>();
      for (const id of item.sourceIds) {
        if (!sent.has(id)) throw invalidReview(`回顾 ${name} 包含未发送的来源：${id}`);
        if (seen.has(id)) throw invalidReview(`回顾 ${name} 的 sourceIds 重复：${id}`);
        seen.add(id);
      }
    }
  }
  const allEmpty =
    content.attempts.length === 0 &&
    content.observations.length === 0 &&
    content.connections.length === 0 &&
    content.experiences.length === 0;
  if (allEmpty && !content.insufficientData) {
    throw invalidReview('四个区块均为空且 insufficientData=false。');
  }
  if (content.insufficientData && !/不足|有限|缺少|缺失|太少|无法/.test(content.overview)) {
    throw invalidReview('insufficientData=true 时 overview 必须说明数据不足。');
  }
  return content;
}

export type ReviewPromptInput = {
  range: ReviewRange;
  stats: ReviewStats;
  records: ReviewRecord[];
};

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

function formatLocal(ms: number, timeZone: string): string {
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

function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function eventTime(record: ReviewRecord): number {
  return record.type === 'attempt' ? (record.observedAt ?? record.createdAt) : record.createdAt;
}

export function sortReviewRecords(records: ReviewRecord[]): ReviewRecord[] {
  return [...records].sort((a, b) => eventTime(a) - eventTime(b) || a.key.localeCompare(b.key));
}

function formatRecord(record: ReviewRecord, timeZone: string): string[] {
  const lines: string[] = [];
  const fmt = (ms: number) => formatLocal(ms, timeZone);
  const modified = record.reasons.some((r) => r === 'capture_modified' || r === 'attempt_modified');
  const modifiedText = modified && record.updatedAt ? `｜最后修改于 ${fmt(record.updatedAt)}` : '';
  if (record.type === 'capture') {
    lines.push(
      `[${record.key}] 念头｜创建于 ${fmt(record.createdAt)}${record.archived ? '｜已归档' : ''}${modifiedText}`
    );
    lines.push(`正文：${oneLine(record.text) || oneLine(record.title) || '（空）'}`);
  } else if (record.type === 'attempt') {
    const state = record.state ? `｜当前状态：${STATE_LABELS[record.state] ?? record.state}` : '';
    const hasResult = Boolean(oneLine(record.resultText));
    const resultTime = hasResult
      ? record.observedAt
        ? `｜结果记录于 ${fmt(record.observedAt)}`
        : '｜结果记录时间未保存'
      : '';
    const outcome = hasResult && record.outcome ? `｜评价：${OUTCOME_LABELS[record.outcome] ?? record.outcome}` : '';
    lines.push(`[${record.key}] 尝试｜开始于 ${fmt(record.createdAt)}${state}${resultTime}${outcome}${modifiedText}`);
    lines.push(`步骤：${oneLine(record.text) || oneLine(record.title) || '（空）'}`);
    if (hasResult) lines.push(`结果：${oneLine(record.resultText)}`);
    lines.push(`所属念头：${record.captureId}`);
  } else {
    const from = record.fromAttemptId ?? record.attemptId ?? '未知';
    const to = record.toAttemptId ?? record.relatedAttemptId ?? '未知';
    const fromStep = oneLine(record.text) || '（无标题）';
    const toStep = oneLine(record.title) || '（无标题）';
    lines.push(`[${record.key}] 引用｜创建于 ${fmt(record.createdAt)}`);
    lines.push(`从「${fromStep}」（${from}）引用「${toStep}」（${to}）`);
    lines.push(`说明：${oneLine(record.note) || '（无）'}`);
    if (oneLine(record.resultText)) lines.push(`被引用结果：${oneLine(record.resultText)}`);
  }
  return lines;
}

/** 与实际发送内容完全一致的 user prompt；selectedChars 用它计算。 */
export function buildReviewUserPrompt(input: ReviewPromptInput): string {
  const { range, stats, records } = input;
  const sorted = sortReviewRecords(records);
  const lines = [
    '请回顾下面这段时间里用户真实记录的念头、尝试、结果与引用。',
    '',
    `时间范围（${range.timezone}）：${range.fromLocal} 至 ${range.toLocal}（起始包含，结束不包含）`,
    '程序统计（仅按现有字段计算，不代表历史状态推断）：',
    `- 记录的念头：${stats.capturesCreated} 条（创建时间在范围内，含已归档）`,
    `- 修改的旧念头：${stats.capturesModified} 条（仅表示修改，不算新记录）`,
    `- 开始的尝试：${stats.attemptsStarted} 条（只表示开始，不代表已结束）`,
    `- 修改的旧尝试：${stats.attemptsModified} 条（仅表示修改，不计入新开始）`,
    `- 当前已结束/已放弃的尝试：${stats.attemptsCurrentlyEnded} 条（当前状态 + 最后修改时间在范围内，不表示实际结束时间）`,
    `- 记录下的结果：${stats.resultsRecorded} 条（结果记录时间在范围内）`,
    `- 有结果但结果时间未知：${stats.resultsMissingObservedAt} 条（不计入结果数）`,
    `- 新建的引用：${stats.referencesCreated} 条`,
    `- 本次发送：${sorted.length} 条记录（范围内唯一记录共 ${stats.totalRecords} 条，按事件时间升序）`,
    '',
    '记录列表（方括号内是唯一来源 ID；sourceIds 只能使用这些完整 ID）：',
  ];
  for (const record of sorted) lines.push(...formatRecord(record, range.timezone));
  lines.push(
    '',
    '请只输出一个 JSON 对象，不要 Markdown 或代码围栏；每个 item 至少引用 1 条上面方括号中的 ID，不得编造或使用未列出的 ID。'
  );
  return lines.join('\n');
}

export type GenerateReviewInput = ReviewPromptInput & { signal?: AbortSignal };
export type GenerateReviewResult = { content: ReviewContent; usage: ModelCallResult['usage']; durationMs: number };

export async function generateReview(
  config: ProviderConfig,
  input: GenerateReviewInput
): Promise<GenerateReviewResult> {
  const result = await callModel(config, {
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewUserPrompt(input),
    maxOutputTokens: 1200,
    temperature: 0.2,
    timeoutMs: getAiTimeoutMs(),
    signal: input.signal,
  });
  const content = parseReviewOutput(
    result.text,
    input.records.map((record) => record.key)
  );
  return { content, usage: result.usage, durationMs: result.durationMs };
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

type KeysResult = { ok: true; keys: string[] } | { ok: false };

function normalizeIncludeKeys(value: unknown): KeysResult {
  if (!Array.isArray(value) || value.length === 0 || value.length > REVIEW_MAX_SELECT_KEYS) {
    return { ok: false };
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false };
    const key = item.trim();
    if (!key || key.length > 160 || !/^(capture|attempt|reference):[A-Za-z0-9._:-]+$/.test(key)) {
      return { ok: false };
    }
    // 契约：重复键视为请求不合法（400 invalid_keys），不静默去重，
    // 避免“以为排除了某条”的误判。
    if (seen.has(key)) return { ok: false };
    seen.add(key);
    keys.push(key);
  }
  return keys.length > 0 && keys.length <= REVIEW_MAX_SELECT_KEYS ? { ok: true, keys } : { ok: false };
}

export function reviewContextToken(
  range: ReviewRange,
  records: ReviewRecord[],
  configVersion: number | null
): string {
  const items = [...records]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((record) => ({ key: record.key, revision: record.revision, updatedAt: record.updatedAt }));
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        preset: range.preset,
        configVersion,
        items,
      }),
      'utf8'
    )
    .digest('hex');
}

function reviewFingerprint(input: {
  range: ReviewRange;
  includeKeys: string[];
  contextToken: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        op: 'review-generate',
        from: input.range.from,
        to: input.range.to,
        timezone: input.range.timezone,
        preset: input.range.preset,
        includeKeys: [...input.includeKeys].sort(),
        contextToken: input.contextToken,
      }),
      'utf8'
    )
    .digest('hex');
}

function countSections(records: ReviewRecord[]): ReviewPreviewCoverage['sectionCounts'] {
  const counts = { captures: 0, attempts: 0, results: 0, references: 0, modifications: 0 };
  for (const record of records) {
    const reasons = new Set(record.reasons);
    if (reasons.has('capture_created')) counts.captures += 1;
    if (reasons.has('attempt_started') || reasons.has('attempt_current_ended')) counts.attempts += 1;
    if (reasons.has('result_recorded') || reasons.has('result_time_unknown')) counts.results += 1;
    if (reasons.has('reference_created')) counts.references += 1;
    if (reasons.has('capture_modified') || reasons.has('attempt_modified')) counts.modifications += 1;
  }
  return counts;
}

function buildCoverage(
  read: { records: ReviewRecord[]; stats: ReviewStats; coverage: { truncated: boolean } },
  selectedChars: number
): ReviewPreviewCoverage {
  return {
    totalRecords: read.stats.totalRecords,
    selectedRecords: read.records.length,
    excludedRecords: Math.max(0, read.stats.totalRecords - read.records.length),
    selectedChars,
    maxRecords: REVIEW_MAX_RECORDS,
    maxChars: REVIEW_MAX_CHARS,
    withinLimit: read.records.length <= REVIEW_MAX_RECORDS && selectedChars <= REVIEW_MAX_CHARS,
    truncated: read.coverage.truncated,
    sectionCounts: countSections(read.records),
  };
}

function publicConfigOfSettings(row: {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
}): ReviewAiConfig {
  return { id: row.id, name: row.name, modelId: row.modelId, configVersion: row.configVersion };
}

type BackgroundReviewConfig = {
  baseUrl: string;
  modelId: string;
  allowLocal: boolean;
  apiKeyCiphertext: string;
};

const runningReviews = new Map<string, AbortController>();

async function runReview(
  fastify: FastifyInstance,
  reviewId: string,
  input: ReviewPromptInput,
  config: BackgroundReviewConfig
): Promise<void> {
  const initial = sqlite
    .prepare('SELECT status FROM stage_reviews WHERE id = ?')
    .get(reviewId) as { status: string } | undefined;
  if (!initial || initial.status !== 'pending') return;
  const controller = new AbortController();
  runningReviews.set(reviewId, controller);
  const startedAt = Date.now();
  let apiKey = '';
  try {
    apiKey = decryptApiKey(config.apiKeyCiphertext);
    const result = await generateReview(
      { baseUrl: config.baseUrl, modelId: config.modelId, apiKey, allowLocal: config.allowLocal },
      { ...input, signal: controller.signal }
    );
    const finishedAt = Date.now();
    const updated = sqlite
      .prepare(
        `UPDATE stage_reviews
            SET status = 'succeeded', content_json = ?, error_code = NULL, error_detail = NULL,
                usage_json = ?, duration_ms = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(
        JSON.stringify(result.content),
        result.usage ? JSON.stringify(result.usage) : null,
        result.durationMs,
        finishedAt,
        finishedAt,
        reviewId
      );
    if (updated.changes === 0) {
      fastify.log.info({ reviewId }, '回顾已取消，丢弃迟到的成功响应');
    }
  } catch (error) {
    const classified = classifyError(error, apiKey ? [apiKey] : []);
    const durationMs = Date.now() - startedAt;
    const finishedAt = Date.now();
    if (controller.signal.aborted && classified.code !== 'timeout') {
      sqlite
        .prepare(
          `UPDATE stage_reviews
              SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run('已取消本次回顾。', durationMs, finishedAt, finishedAt, reviewId);
    } else {
      sqlite
        .prepare(
          `UPDATE stage_reviews
              SET status = 'failed', error_code = ?, error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run(classified.code, classified.detail.slice(0, 500), durationMs, finishedAt, finishedAt, reviewId);
    }
    fastify.log.info({ reviewId, errorCode: classified.code }, 'AI 回顾生成未成功');
  } finally {
    runningReviews.delete(reviewId);
  }
}

export function registerReviewAiRoutes(fastify: FastifyInstance): void {
  fastify.post('/api/review/preview', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseReviewRange(body);
    if (!parsed.ok) {
      return reply
        .code(parsed.status)
        .send({ error: parsed.error, message: parsed.message, ...(parsed.field ? { field: parsed.field } : {}) });
    }
    const keysResult = normalizeIncludeKeys(body.includeKeys);
    if (!keysResult.ok) {
      return reply
        .code(400)
        .send({ error: 'invalid_keys', message: 'includeKeys 必须是 1–300 个不重复的记录 ID。' });
    }
    const range = makeReviewRange(parsed.value);
    const read = readReviewRecordsByKeys(range, keysResult.keys);
    if (read.missingKeys.length > 0) {
      return reply.code(409).send({ error: 'records_changed', missingKeys: read.missingKeys });
    }
    const settings = await getSettingsRow();
    const config = settings ? publicConfigOfSettings(settings) : null;
    const records = sortReviewRecords(read.records);
    const selectedChars = buildReviewUserPrompt({ range, stats: read.stats, records }).length;
    const response: ReviewPreviewResponse = {
      range,
      stats: read.stats,
      config,
      ai: {
        configured: Boolean(settings && settings.apiKeyCiphertext),
        enabled: Boolean(settings && settings.enabled === 1),
      },
      records,
      coverage: buildCoverage({ ...read, records }, selectedChars),
      contextToken: reviewContextToken(range, records, config?.configVersion ?? null),
    };
    return response;
  });

  fastify.post('/api/reviews', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseReviewRange(body);
    if (!parsed.ok) {
      return reply
        .code(parsed.status)
        .send({ error: parsed.error, message: parsed.message, ...(parsed.field ? { field: parsed.field } : {}) });
    }
    const keysResult = normalizeIncludeKeys(body.includeKeys);
    if (!keysResult.ok) {
      return reply
        .code(400)
        .send({ error: 'invalid_keys', message: 'includeKeys 必须是 1–300 个不重复的记录 ID。' });
    }
    const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (!operationId || operationId.length > 200) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 不能为空且不能超过 200 个字符。',
      });
    }
    const range = makeReviewRange(parsed.value);
    const includeKeys = keysResult.keys;
    const providedToken = typeof body.contextToken === 'string' ? body.contextToken.trim() : '';
    const requestFingerprint = reviewFingerprint({ range, includeKeys, contextToken: providedToken });

    const existingRows = await db
      .select()
      .from(stageReviews)
      .where(eq(stageReviews.operationId, operationId))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (existing.operationFingerprint !== requestFingerprint) {
        return reply
          .code(409)
          .send({ error: 'operation_key_conflict', message: 'operationId 已被另一个请求使用。' });
      }
      return reply.code(200).send({ review: publicReviewOf(existing), replayed: true });
    }

    const settings = await getSettingsRow();
    if (!settings || !settings.apiKeyCiphertext) {
      return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
    }
    if (settings.enabled !== 1) {
      return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
    }
    const read = readReviewRecordsByKeys(range, includeKeys);
    if (read.missingKeys.length > 0) {
      return reply.code(409).send({ error: 'records_changed', missingKeys: read.missingKeys });
    }
    if (read.records.length === 0) {
      return reply.code(409).send({ error: 'no_records', message: '所选范围内没有可回顾的记录。' });
    }
    const records = sortReviewRecords(read.records);
    const prompt = buildReviewUserPrompt({ range, stats: read.stats, records });
    if (records.length > REVIEW_MAX_RECORDS || prompt.length > REVIEW_MAX_CHARS) {
      return reply.code(409).send({
        error: 'review_too_large',
        message: '记录过多或内容过长，请缩小范围或取消部分勾选。',
        recordCount: records.length,
        maxRecords: REVIEW_MAX_RECORDS,
        charCount: prompt.length,
        maxChars: REVIEW_MAX_CHARS,
      });
    }
    const expectedToken = reviewContextToken(range, records, settings.configVersion);
    if (!providedToken || expectedToken !== providedToken) {
      return reply.code(409).send({
        error: 'context_changed',
        message: '预览后记录或配置有变化，请刷新内容并重新确认。',
      });
    }

    const coverage = buildCoverage({ ...read, records }, prompt.length);
    const reviewId = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    let created: StageReview;
    try {
      created = sqlite.transaction(() => {
        const pendingCount = (
          sqlite.prepare(`SELECT COUNT(*) AS c FROM stage_reviews WHERE status = 'pending'`).get() as {
            c: number;
          }
        ).c;
        if (pendingCount >= 2) {
          throw new HttpError(429, {
            error: 'too_many_reviews',
            message: '当前回顾任务过多，请稍后再试。',
          });
        }
        const [row] = db
          .insert(stageReviews)
          .values({
            id: reviewId,
            status: 'pending',
            rangeFrom: range.from,
            rangeTo: range.to,
            timezone: range.timezone,
            rangePreset: range.preset,
            statsJson: JSON.stringify(read.stats),
            coverageJson: JSON.stringify(coverage),
            contentJson: null,
            sourcesJson: JSON.stringify(toReviewSources(records)),
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
          .all();
        return row!;
      })();
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.status).send(error.body);
      }
      const racedRows = await db
        .select()
        .from(stageReviews)
        .where(eq(stageReviews.operationId, operationId))
        .limit(1);
      if (racedRows[0]) {
        if (racedRows[0].operationFingerprint === requestFingerprint) {
          return reply.code(200).send({ review: publicReviewOf(racedRows[0]), replayed: true });
        }
        return reply
          .code(409)
          .send({ error: 'operation_key_conflict', message: 'operationId 已被另一个请求使用。' });
      }
      throw error;
    }

    const backgroundConfig: BackgroundReviewConfig = {
      baseUrl: settings.baseUrl,
      modelId: settings.modelId,
      allowLocal: settings.allowLocal === 1,
      apiKeyCiphertext: settings.apiKeyCiphertext,
    };
    setImmediate(() => {
      void runReview(fastify, reviewId, { range, stats: read.stats, records }, backgroundConfig);
    });
    return reply.code(202).send({ review: publicReviewOf(created), replayed: false });
  });

  fastify.post('/api/reviews/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await db.select().from(stageReviews).where(eq(stageReviews.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'review_not_found', message: '回顾记录不存在。' });
    }
    if (row.status !== 'pending') {
      return reply.code(409).send({ error: 'not_cancellable', message: '该回顾已结束，无法取消。' });
    }
    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE stage_reviews
            SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run('已取消本次回顾。', t, t, id);
    if (result.changes === 0) {
      return reply.code(409).send({ error: 'not_cancellable', message: '该回顾已结束，无法取消。' });
    }
    runningReviews.get(id)?.abort();
    const updated = await db.select().from(stageReviews).where(eq(stageReviews.id, id)).limit(1);
    return { review: publicReviewOf(updated[0]!) };
  });
}
