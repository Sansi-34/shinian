import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, sqlite } from '../db/db';
import {
  aiGenerations,
  attemptReferences,
  attempts,
  captures,
  type AiGeneration,
  type AiSettings,
  type Attempt,
} from '../db/schema';
import {
  AiError,
  MAX_CAPTURE_CHARS,
  MAX_CONSTRAINT_CHARS,
  classifyError,
  computeTestFingerprint,
  decryptApiKey,
  deleteAiSettings,
  errorMessageForCode,
  getPublicSettings,
  getSettingsRow,
  publicConfigOf,
  recordTestResult,
  saveAiSettings,
  validateAndNormalizeBaseUrl,
  type AiErrorCode,
} from './aiSettings';
import { generateSuggestion, testConnection } from './aiProvider';
import {
  buildContextSnapshot,
  contextTokenForSources,
  getExperienceCandidates,
  publicExperienceOf,
  readExperienceSources,
  type ExperienceContext,
  type ExperienceSource,
  type GenerationSource,
} from './aiExperience';

const INTERRUPTED_DETAIL = '服务重启，本次生成已中断，可重新生成。';

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
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

function fingerprint(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function parseStoredJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export type PublicGeneration = {
  id: string;
  captureId: string;
  captureRevision: number;
  inputText: string;
  constraint: string | null;
  configId: string;
  configVersion: number;
  configName: string;
  modelId: string;
  status: string;
  kind: string | null;
  suggestion: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  adoptedAttemptId: string | null;
  adoptedAt: number | null;
  dismissedAt: number | null;
  isExpired: boolean;
  createdAt: number;
  finishedAt: number | null;
  sources: GenerationSource[];
  sourcesChanged: boolean;
  contextInvalidated: boolean;
  contextInvalidReason: string | null;
};

export function publicGenerationOf(row: AiGeneration): PublicGeneration {
  const cap = sqlite
    .prepare('SELECT revision FROM captures WHERE id = ?')
    .get(row.captureId) as { revision: number } | undefined;
  return {
    id: row.id,
    captureId: row.captureId,
    captureRevision: row.captureRevision,
    inputText: row.captureText,
    constraint: row.constraintText,
    configId: row.configId,
    configVersion: row.configVersion,
    configName: row.configName,
    modelId: row.modelId,
    status: row.status,
    kind: row.kind,
    suggestion: parseStoredJson<unknown>(row.suggestionJson),
    errorCode: row.errorCode,
    errorMessage: row.errorCode
      ? (row.errorDetail ?? errorMessageForCode(row.errorCode as AiErrorCode))
      : null,
    usage: parseStoredJson<{ inputTokens: number; outputTokens: number; totalTokens: number }>(
      row.usageJson
    ),
    durationMs: row.durationMs,
    adoptedAttemptId: row.adoptedAttemptId,
    adoptedAt: row.adoptedAt,
    dismissedAt: row.dismissedAt,
    isExpired:
      row.status === 'succeeded' && (!cap || cap.revision !== row.captureRevision),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    ...publicExperienceOf(row),
  };
}

async function getGenerationRow(id: string): Promise<AiGeneration | undefined> {
  const rows = await db.select().from(aiGenerations).where(eq(aiGenerations.id, id)).limit(1);
  return rows[0];
}

async function getAttemptRow(id: string): Promise<Attempt | undefined> {
  const rows = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  return rows[0];
}

type ReceiptRow = {
  operation_key: string;
  target_type: string;
  request_fingerprint: string;
  response_json: string;
};

function getReceipt(operationKey: string): ReceiptRow | undefined {
  return sqlite
    .prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?')
    .get(operationKey) as ReceiptRow | undefined;
}

type SourceIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

function normalizeSourceAttemptIds(value: unknown, requireNonEmpty: boolean): SourceIdsResult {
  if (value === undefined || value === null) {
    return requireNonEmpty
      ? { ok: false, message: '请选择 1–3 条旧经验。' }
      : { ok: true, ids: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'sourceAttemptIds 必须是数组。' };
  }
  if (value.length === 0) {
    return requireNonEmpty
      ? { ok: false, message: '请选择 1–3 条旧经验。' }
      : { ok: true, ids: [] };
  }
  if (value.length > 3) {
    return { ok: false, message: '最多只能选择 3 条旧经验。' };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 120) {
      return { ok: false, message: '来源 ID 不正确。' };
    }
    const id = item.trim();
    if (seen.has(id)) return { ok: false, message: '来源不能重复。' };
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

function readCapture(captureId: string):
  | { id: string; rawText: string; revision: number }
  | undefined {
  return sqlite
    .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
    .get(captureId) as { id: string; rawText: string; revision: number } | undefined;
}

function normalizeConstraint(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    return { ok: false };
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > MAX_CONSTRAINT_CHARS) return { ok: false };
  return { ok: true, value: text || null };
}

function sourceIdsFingerprint(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

type SuggestionSourceRef = {
  attemptId: string;
  note: string;
};

function suggestionSourceRefs(raw: string | null): SuggestionSourceRef[] {
  const parsed = parseStoredJson<{ sources?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.sources)) return [];
  const result: SuggestionSourceRef[] = [];
  for (const item of parsed.sources) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as any).attemptId === 'string' &&
      typeof (item as any).note === 'string'
    ) {
      result.push({
        attemptId: (item as any).attemptId,
        note: (item as any).note,
      });
    }
  }
  return result;
}

function contextSourceChanged(context: ExperienceContext | null): boolean {
  if (!context || !Array.isArray(context.sources)) return false;
  for (const source of context.sources) {
    if (!source || source.deleted === true) return true;
    const current = sqlite
      .prepare(
        `SELECT a.revision AS attemptRevision, c.revision AS captureRevision
           FROM attempts a JOIN captures c ON c.id = a.capture_id
          WHERE a.id = ?`
      )
      .get(source.attemptId) as
      | { attemptRevision: number; captureRevision: number }
      | undefined;
    if (!current) return true;
    if (
      current.attemptRevision !== source.attemptRevision ||
      current.captureRevision !== source.captureRevision
    ) {
      return true;
    }
  }
  return false;
}

/** 删除预览/删除使用：某念头的生成记录计数。 */
export function getCaptureGenerationCounts(captureId: string): {
  total: number;
  pending: number;
} {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
         FROM ai_generations WHERE capture_id = ?`
    )
    .get(captureId) as { total: number; pending: number };
  return { total: row.total, pending: row.pending };
}

/** 服务启动时：所有 pending → interrupted。 */
export function markInterruptedGenerations(): number {
  const t = Date.now();
  const result = sqlite
    .prepare(
      `UPDATE ai_generations
          SET status = 'interrupted', error_code = 'interrupted', error_detail = ?,
              finished_at = ?, updated_at = ?
        WHERE status = 'pending'`
    )
    .run(INTERRUPTED_DETAIL, t, t);
  return result.changes;
}

let testInProgress = false;
const runningGenerations = new Map<string, AbortController>();

type BackgroundConfig = {
  baseUrl: string;
  modelId: string;
  allowLocal: boolean;
  apiKeyCiphertext: string;
};

async function runGeneration(
  fastify: FastifyInstance,
  generationId: string,
  captureText: string,
  constraint: string | null,
  sources: ExperienceSource[],
  config: BackgroundConfig
): Promise<void> {
  const initial = sqlite
    .prepare('SELECT status FROM ai_generations WHERE id = ?')
    .get(generationId) as { status: string } | undefined;
  // 在后台任务真正开始前已被取消：不再发起模型请求。
  if (!initial || initial.status !== 'pending') return;
  const controller = new AbortController();
  runningGenerations.set(generationId, controller);
  const startedAt = Date.now();
  let apiKey = '';
  try {
    apiKey = decryptApiKey(config.apiKeyCiphertext);
    const result = await generateSuggestion(
      {
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        apiKey,
        allowLocal: config.allowLocal,
      },
      { captureText, constraint, sources, signal: controller.signal }
    );
    const finishedAt = Date.now();
    sqlite
      .prepare(
        `UPDATE ai_generations
            SET status = 'succeeded', kind = ?, suggestion_json = ?, error_code = NULL,
                error_detail = NULL, usage_json = ?, duration_ms = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(
        result.suggestion.kind,
        JSON.stringify(result.suggestion),
        result.usage ? JSON.stringify(result.usage) : null,
        result.durationMs,
        finishedAt,
        finishedAt,
        generationId
      );
  } catch (error) {
    const classified = classifyError(error, apiKey ? [apiKey] : []);
    const durationMs = Date.now() - startedAt;
    const finishedAt = Date.now();
    const aborted = controller.signal.aborted;
    if (aborted && classified.code !== 'timeout') {
      sqlite
        .prepare(
          `UPDATE ai_generations
              SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run('已取消本次生成。', durationMs, finishedAt, finishedAt, generationId);
    } else {
      sqlite
        .prepare(
          `UPDATE ai_generations
              SET status = 'failed', error_code = ?, error_detail = ?,
                  duration_ms = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run(classified.code, classified.detail.slice(0, 500), durationMs, finishedAt, finishedAt, generationId);
    }
    fastify.log.info({ generationId, errorCode: classified.code }, 'AI 生成未成功');
  } finally {
    runningGenerations.delete(generationId);
  }
}

export function registerAiRoutes(fastify: FastifyInstance): void {
  // ---------- 设置 ----------
  fastify.get('/api/settings/ai', { preHandler: requireAuth }, async () => {
    return getPublicSettings();
  });

  fastify.put('/api/settings/ai', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await saveAiSettings(body);
    if (!result.ok) {
      return reply.code(400).send({
        error: 'invalid_settings',
        field: result.field,
        message: result.message,
      });
    }
    return getPublicSettings();
  });

  fastify.delete('/api/settings/ai', { preHandler: requireAuth }, async () => {
    await deleteAiSettings();
    return { ok: true };
  });

  fastify.post('/api/settings/ai/test', { preHandler: requireAuth }, async (req, reply) => {
    if (testInProgress) {
      return reply.code(409).send({
        error: 'test_in_progress',
        message: '已有连接测试正在进行，请稍后再试。',
      });
    }
    testInProgress = true;
    try {
      const row = await getSettingsRow();
      if (!row) {
        return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
      }
      if (row.enabled !== 1) {
        return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
      }
      if (!row.apiKeyCiphertext) {
        return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 API Key。' });
      }

      const testedAt = Date.now();
      const startedAt = Date.now();
      // 测试指纹必须取测试开始时的设置快照；测试期间改配置会让结果自动 stale。
      const testFingerprint = computeTestFingerprint({
        baseUrl: row.baseUrl,
        modelId: row.modelId,
        apiKeyFingerprint: row.apiKeyFingerprint,
        allowLocal: row.allowLocal === 1,
      });
      let apiKey = '';
      let updated: AiSettings | undefined;
      try {
        const urlResult = validateAndNormalizeBaseUrl(row.baseUrl, row.allowLocal === 1);
        if (!urlResult.ok) {
          throw new AiError(urlResult.code, urlResult.message, urlResult.message);
        }
        apiKey = decryptApiKey(row.apiKeyCiphertext);
        const result = await testConnection({
          baseUrl: urlResult.baseUrl,
          modelId: row.modelId,
          apiKey,
          allowLocal: row.allowLocal === 1,
        });
        updated = await recordTestResult({
          ok: true,
          testedAt,
          modelId: row.modelId,
          baseUrl: urlResult.baseUrl,
          durationMs: result.durationMs,
          testFingerprint,
        });
      } catch (error) {
        const classified = classifyError(error, apiKey ? [apiKey] : []);
        updated = await recordTestResult({
          ok: false,
          testedAt,
          modelId: row.modelId,
          baseUrl: row.baseUrl,
          durationMs: Date.now() - startedAt,
          testFingerprint,
          errorCode: classified.code,
          errorDetail: classified.detail.slice(0, 500),
        });
      }
      const config = updated ? publicConfigOf(updated) : null;
      return { test: config?.test ?? null, config };
    } finally {
      testInProgress = false;
    }
  });

  // ---------- 参考旧经验：候选与预览 ----------
  fastify.get(
    '/api/captures/:id/experience-candidates',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = req.query as { q?: string; limit?: string };
      const result = getExperienceCandidates(
        id,
        typeof query.q === 'string' ? query.q : undefined,
        typeof query.limit === 'string' ? query.limit : undefined
      );
      if (!result) {
        return reply.code(404).send({ error: 'capture_not_found', message: '念头不存在。' });
      }
      return result;
    }
  );

  fastify.post(
    '/api/captures/:id/experience/preview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as {
        captureRevision?: unknown;
        constraint?: unknown;
        sourceAttemptIds?: unknown;
      };
      if (
        typeof body.captureRevision !== 'number' ||
        !Number.isInteger(body.captureRevision) ||
        body.captureRevision < 1
      ) {
        return reply.code(400).send({
          error: 'invalid_request',
          field: 'captureRevision',
          message: 'captureRevision 必须是正整数。',
        });
      }
      const sourceResult = normalizeSourceAttemptIds(body.sourceAttemptIds, true);
      if (!sourceResult.ok) {
        return reply.code(400).send({ error: 'invalid_sources', message: sourceResult.message });
      }
      const constraintResult = normalizeConstraint(body.constraint);
      if (!constraintResult.ok) {
        return reply.code(400).send({
          error: 'invalid_request',
          field: 'constraint',
          message: `补充限制不能超过 ${MAX_CONSTRAINT_CHARS} 个字符。`,
        });
      }
      const cap = readCapture(id);
      if (!cap) {
        return reply.code(404).send({ error: 'capture_not_found', message: '念头不存在。' });
      }
      if (cap.revision !== body.captureRevision) {
        return reply.code(409).send({
          error: 'version_conflict',
          currentRevision: cap.revision,
          currentRawText: cap.rawText,
        });
      }
      const settings = await getSettingsRow();
      if (!settings || !settings.apiKeyCiphertext) {
        return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
      }
      if (settings.enabled !== 1) {
        return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
      }
      const sourceRead = readExperienceSources(sourceResult.ids);
      if (sourceRead.unavailableIds.length > 0) {
        return reply.code(409).send({
          error: 'source_unavailable',
          sourceIds: sourceRead.unavailableIds,
        });
      }
      const contextToken = contextTokenForSources({
        captureId: cap.id,
        captureRevision: cap.revision,
        constraint: constraintResult.value,
        configVersion: settings.configVersion,
        sources: sourceRead.sources,
      });
      return {
        capture: { id: cap.id, rawText: cap.rawText, revision: cap.revision },
        constraint: constraintResult.value,
        config: {
          id: settings.id,
          name: settings.name,
          modelId: settings.modelId,
          configVersion: settings.configVersion,
        },
        sources: sourceRead.sources.map((source) => ({
          attemptId: source.attemptId,
          captureId: source.captureId,
          captureText: source.captureText,
          captureRevision: source.captureRevision,
          attemptRevision: source.attemptRevision,
          step: source.step,
          resultText: source.resultText,
          outcome: source.outcome,
          observedAt: source.observedAt,
          sourceUrl: source.sourceUrl,
          captureArchived: source.captureArchived,
        })),
        contextToken,
      };
    }
  );

  // ---------- 生成建议 ----------
  fastify.post('/api/captures/:id/suggestions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      captureRevision?: unknown;
      constraint?: unknown;
      operationId?: unknown;
      sourceAttemptIds?: unknown;
      contextToken?: unknown;
    };

    if (
      typeof body.captureRevision !== 'number' ||
      !Number.isInteger(body.captureRevision) ||
      body.captureRevision < 1
    ) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'captureRevision',
        message: 'captureRevision 必须是正整数。',
      });
    }
    const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (!operationId) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 不能为空。',
      });
    }
    if (operationId.length > 200) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 过长。',
      });
    }
    if (body.constraint !== undefined && body.constraint !== null && typeof body.constraint !== 'string') {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'constraint',
        message: 'constraint 必须是字符串。',
      });
    }
    const constraint = typeof body.constraint === 'string' ? body.constraint.trim() : '';
    if (constraint.length > MAX_CONSTRAINT_CHARS) {
      return reply.code(400).send({
        error: 'constraint_too_long',
        message: `补充限制不能超过 ${MAX_CONSTRAINT_CHARS} 个字符。`,
      });
    }

    const sourceResult = normalizeSourceAttemptIds(body.sourceAttemptIds, false);
    if (!sourceResult.ok) {
      return reply.code(400).send({ error: 'invalid_sources', message: sourceResult.message });
    }
    const sourceIds = sourceResult.ids;
    const providedContextToken =
      typeof body.contextToken === 'string' ? body.contextToken.trim() : '';
    if (sourceIds.length > 0 && !providedContextToken) {
      return reply.code(400).send({
        error: 'invalid_sources',
        message: '选择旧经验后必须先预览并带上 contextToken。',
      });
    }

    const fingerprintPayload: Record<string, unknown> = {
      op: 'ai-suggestion',
      captureId: id,
      captureRevision: body.captureRevision,
      constraint,
    };
    if (sourceIds.length > 0) {
      fingerprintPayload.sourceAttemptIds = sourceIdsFingerprint(sourceIds);
      fingerprintPayload.contextToken = providedContextToken;
    }
    const requestFingerprint = fingerprint(fingerprintPayload);

    const existingRows = await db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.operationId, operationId))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (existing.operationFingerprint !== requestFingerprint) {
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: 'operationId 已被另一个请求使用。',
        });
      }
      return reply.code(200).send({
        generation: publicGenerationOf(existing),
        replayed: true,
      });
    }

    const settings = await getSettingsRow();
    if (!settings) {
      return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 AI 模型。' });
    }
    if (settings.enabled !== 1) {
      return reply.code(409).send({ error: 'ai_disabled', message: 'AI 模型已停用。' });
    }
    if (!settings.apiKeyCiphertext) {
      return reply.code(409).send({ error: 'ai_not_configured', message: '尚未配置 API Key。' });
    }

    const generationId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    let created: AiGeneration;
    let backgroundSources: ExperienceSource[] = [];
    let storedContextToken: string | null = null;
    let storedContextJson: string | null = null;
    try {
      created = sqlite.transaction(() => {
        const cap = sqlite
          .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
          .get(id) as { id: string; rawText: string; revision: number } | undefined;
        if (!cap) {
          throw new HttpError(404, { error: 'capture_not_found', message: '念头不存在。' });
        }
        if (cap.revision !== body.captureRevision) {
          throw new HttpError(409, {
            error: 'version_conflict',
            currentRevision: cap.revision,
            currentRawText: cap.rawText,
          });
        }
        if (cap.rawText.length > MAX_CAPTURE_CHARS) {
          throw new HttpError(400, {
            error: 'capture_too_long',
            message: `念头原文不能超过 ${MAX_CAPTURE_CHARS} 个字符。`,
          });
        }
        if (sourceIds.length > 0) {
          const sourceRead = readExperienceSources(sourceIds);
          if (sourceRead.unavailableIds.length > 0) {
            throw new HttpError(409, {
              error: 'source_unavailable',
              sourceIds: sourceRead.unavailableIds,
            });
          }
          const expectedToken = contextTokenForSources({
            captureId: cap.id,
            captureRevision: cap.revision,
            constraint: constraint || null,
            configVersion: settings.configVersion,
            sources: sourceRead.sources,
          });
          if (expectedToken !== providedContextToken) {
            throw new HttpError(409, {
              error: 'context_changed',
              message: '预览后记录或配置有变化，请刷新内容并重新确认。',
            });
          }
          const snapshot = buildContextSnapshot({
            capture: { id: cap.id, revision: cap.revision, text: cap.rawText },
            constraint: constraint || null,
            config: {
              id: settings.id,
              version: settings.configVersion,
              name: settings.name,
              modelId: settings.modelId,
            },
            sources: sourceRead.sources,
          });
          backgroundSources = sourceRead.sources;
          storedContextJson = JSON.stringify(snapshot);
          storedContextToken = expectedToken;
        }
        const pendingSame = sqlite
          .prepare(`SELECT id FROM ai_generations WHERE capture_id = ? AND status = 'pending' LIMIT 1`)
          .get(id) as { id: string } | undefined;
        if (pendingSame) {
          throw new HttpError(409, {
            error: 'generation_in_progress',
            generationId: pendingSame.id,
          });
        }
        const pendingCount = (
          sqlite
            .prepare(`SELECT COUNT(*) AS c FROM ai_generations WHERE status = 'pending'`)
            .get() as { c: number }
        ).c;
        if (pendingCount >= 2) {
          throw new HttpError(429, {
            error: 'too_many_generations',
            message: '当前生成任务过多，请稍后再试。',
          });
        }
        const [row] = db
          .insert(aiGenerations)
          .values({
            id: generationId,
            captureId: id,
            captureRevision: cap.revision,
            captureText: cap.rawText,
            constraintText: constraint || null,
            configId: settings.id,
            configVersion: settings.configVersion,
            configName: settings.name,
            baseUrl: settings.baseUrl,
            modelId: settings.modelId,
            status: 'pending',
            operationId,
            operationFingerprint: requestFingerprint,
            contextJson: storedContextJson,
            contextToken: storedContextToken,
            createdAt,
            updatedAt: createdAt,
          })
          .returning()
          .all();
        return row;
      })();
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.status).send(error.body);
      }
      // 并发下同一 operationId 已插入：回放已有记录
      const replayRows = await db
        .select()
        .from(aiGenerations)
        .where(eq(aiGenerations.operationId, operationId))
        .limit(1);
      if (replayRows[0]) {
        if (replayRows[0].operationFingerprint === requestFingerprint) {
          return reply.code(200).send({
            generation: publicGenerationOf(replayRows[0]),
            replayed: true,
          });
        }
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: 'operationId 已被另一个请求使用。',
        });
      }
      throw error;
    }

    const backgroundConfig: BackgroundConfig = {
      baseUrl: settings.baseUrl,
      modelId: settings.modelId,
      allowLocal: settings.allowLocal === 1,
      apiKeyCiphertext: settings.apiKeyCiphertext,
    };
    const captureText = created.captureText;
    const constraintText = created.constraintText;
    setImmediate(() => {
      void runGeneration(
        fastify,
        generationId,
        captureText,
        constraintText,
        backgroundSources,
        backgroundConfig
      );
    });

    return reply.code(202).send({
      generation: publicGenerationOf(created),
      replayed: false,
    });
  });

  fastify.get('/api/generations/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getGenerationRow(id);
    if (!row) {
      return reply.code(404).send({ error: 'generation_not_found', message: '生成记录不存在。' });
    }
    return { generation: publicGenerationOf(row) };
  });

  fastify.get(
    '/api/captures/:id/suggestions/latest',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cap = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
      if (!cap[0]) {
        return reply.code(404).send({ error: 'capture_not_found', message: '念头不存在。' });
      }
      const rows = await db
        .select()
        .from(aiGenerations)
        .where(and(eq(aiGenerations.captureId, id), isNull(aiGenerations.dismissedAt)))
        .orderBy(desc(aiGenerations.createdAt))
        .limit(1);
      return { generation: rows[0] ? publicGenerationOf(rows[0]) : null };
    }
  );

  fastify.post('/api/generations/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getGenerationRow(id);
    if (!row) {
      return reply.code(404).send({ error: 'generation_not_found', message: '生成记录不存在。' });
    }
    if (row.status !== 'pending') {
      return reply.code(409).send({ error: 'not_pending', message: '该生成已结束，无需取消。' });
    }
    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE ai_generations
            SET status = 'cancelled', error_code = 'cancelled', error_detail = ?,
                finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run('已取消本次生成。', t, t, id);
    const updated = await getGenerationRow(id);
    if (result.changes === 0 || !updated) {
      return reply.code(409).send({ error: 'not_pending', message: '该生成已结束，无需取消。' });
    }
    runningGenerations.get(id)?.abort();
    return { generation: publicGenerationOf(updated) };
  });

  fastify.post('/api/generations/:id/dismiss', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getGenerationRow(id);
    if (!row) {
      return reply.code(404).send({ error: 'generation_not_found', message: '生成记录不存在。' });
    }
    if (row.status === 'pending') {
      return reply.code(409).send({
        error: 'not_pending',
        message: '生成尚未结束，请先取消再暂时放下。',
      });
    }
    const t = Date.now();
    sqlite
      .prepare(`UPDATE ai_generations SET dismissed_at = ?, updated_at = ? WHERE id = ?`)
      .run(t, t, id);
    const updated = await getGenerationRow(id);
    return { generation: publicGenerationOf(updated!) };
  });

  // ---------- 采用建议 ----------
  fastify.post('/api/generations/:id/accept', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { step?: unknown; operationId?: unknown };
    const step = typeof body.step === 'string' ? body.step.trim() : '';
    if (!step || step.length > 500) {
      return reply.code(400).send({
        error: 'invalid_step',
        field: 'step',
        message: '步骤需为 1–500 个字符。',
      });
    }
    const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
    if (!operationId) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 不能为空。',
      });
    }
    if (operationId.length > 200) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'operationId',
        message: 'operationId 过长。',
      });
    }

    const requestFingerprint = fingerprint({ op: 'ai-accept', generationId: id, step });

    const receipt = getReceipt(operationId);
    if (receipt) {
      if (receipt.target_type !== 'ai_accept' || receipt.request_fingerprint !== requestFingerprint) {
        return reply.code(409).send({
          error: 'operation_key_conflict',
          message: 'operationId 已被另一个请求使用。',
        });
      }
      const stored = parseStoredJson<{ attemptId?: string; generationId?: string }>(
        receipt.response_json
      );
      const attempt = stored?.attemptId ? await getAttemptRow(stored.attemptId) : undefined;
      const generation = await getGenerationRow(stored?.generationId ?? id);
      if (attempt && generation) {
        return { attempt, generation: publicGenerationOf(generation), replayed: true };
      }
    }

    const generation = await getGenerationRow(id);
    if (!generation) {
      return reply.code(404).send({ error: 'generation_not_found', message: '生成记录不存在。' });
    }
    if (generation.adoptedAttemptId) {
      const attempt = await getAttemptRow(generation.adoptedAttemptId);
      if (attempt) {
        return {
          attempt,
          generation: publicGenerationOf(generation),
          replayed: true,
        };
      }
    }
    if (generation.status !== 'succeeded' || generation.kind !== 'executable') {
      return reply.code(409).send({
        error: 'not_adoptable',
        message: '该建议不能直接采用。',
      });
    }

    const attemptId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let outcome: { replayed: boolean; attempt: Attempt };
    try {
      outcome = sqlite.transaction(() => {
        const gen = sqlite
          .prepare('SELECT * FROM ai_generations WHERE id = ?')
          .get(id) as Record<string, any> | undefined;
        if (!gen) {
          throw new HttpError(404, { error: 'generation_not_found', message: '生成记录不存在。' });
        }
        if (gen.status !== 'succeeded' || gen.kind !== 'executable') {
          throw new HttpError(409, { error: 'not_adoptable', message: '该建议不能直接采用。' });
        }
        if (gen.adopted_attempt_id) {
          const rows = db
            .select()
            .from(attempts)
            .where(eq(attempts.id, String(gen.adopted_attempt_id)))
            .limit(1)
            .all();
          if (!rows[0]) {
            throw new HttpError(409, { error: 'not_adoptable', message: '关联的尝试不存在。' });
          }
          return { replayed: true, attempt: rows[0] };
        }
        const sameReceipt = sqlite
          .prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?')
          .get(operationId) as ReceiptRow | undefined;
        if (sameReceipt) {
          if (
            sameReceipt.target_type !== 'ai_accept' ||
            sameReceipt.request_fingerprint !== requestFingerprint
          ) {
            throw new HttpError(409, {
              error: 'operation_key_conflict',
              message: 'operationId 已被另一个请求使用。',
            });
          }
          const stored = parseStoredJson<{ attemptId?: string }>(sameReceipt.response_json);
          const rows = stored?.attemptId
            ? db.select().from(attempts).where(eq(attempts.id, stored.attemptId)).limit(1).all()
            : [];
          if (rows[0]) return { replayed: true, attempt: rows[0] };
          throw new HttpError(409, {
            error: 'not_adoptable',
            message: '原尝试已删除，无法重复采用。',
          });
        }
        const cap = sqlite
          .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
          .get(String(gen.capture_id)) as
          | { id: string; rawText: string; revision: number }
          | undefined;
        if (!cap || cap.revision !== Number(gen.capture_revision)) {
          throw new HttpError(409, {
            error: 'suggestion_expired',
            currentRevision: cap?.revision ?? null,
            currentRawText: cap?.rawText ?? null,
          });
        }
        const context = parseStoredJson<ExperienceContext>(
          typeof gen.context_json === 'string' ? gen.context_json : null
        );
        const suggestionRefs = suggestionSourceRefs(
          typeof gen.suggestion_json === 'string' ? gen.suggestion_json : null
        );
        if (
          context &&
          (gen.context_invalidated_at != null || contextSourceChanged(context))
        ) {
          throw new HttpError(409, {
            error: 'sources_changed',
            message: '建议依据已变化，请重新生成。',
            sources: publicExperienceOf(generation).sources,
          });
        }
        const [inserted] = db
          .insert(attempts)
          .values({
            id: attemptId,
            captureId: String(gen.capture_id),
            step,
            state: 'todo',
            resultText: null,
            outcome: null,
            sourceUrl: null,
            observedAt: null,
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .returning()
          .all();
        if (context) {
          for (const suggestionRef of suggestionRefs) {
            const source = context.sources.find(
              (entry) => entry.attemptId === suggestionRef.attemptId
            );
            if (!source) {
              throw new HttpError(409, {
                error: 'sources_changed',
                message: '建议依据已变化，请重新生成。',
                sources: publicExperienceOf(generation).sources,
              });
            }
            const referenceId = `ref-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`;
            db.insert(attemptReferences)
              .values({
                id: referenceId,
                fromAttemptId: inserted!.id,
                toAttemptId: source.attemptId,
                revision: 1,
                note: `AI 建议引用：${suggestionRef.note}`,
                snapshotResultText: source.resultText ?? null,
                snapshotRevision: source.attemptRevision,
                createdAt: Date.now(),
              })
              .returning()
              .all();
          }
        }
        const adoptedAt = Date.now();
        const updateResult = sqlite
          .prepare(
            `UPDATE ai_generations
                SET adopted_attempt_id = ?, adopted_at = ?, updated_at = ?
              WHERE id = ? AND status = 'succeeded'`
          )
          .run(inserted!.id, adoptedAt, adoptedAt, id);
        if (updateResult.changes !== 1) {
          throw new HttpError(409, { error: 'not_adoptable', message: '该建议不能直接采用。' });
        }
        sqlite
          .prepare(
            `INSERT INTO mutation_receipts
               (operation_key, target_type, request_fingerprint, response_json, created_at)
             VALUES (?, 'ai_accept', ?, ?, ?)`
          )
          .run(
            operationId,
            requestFingerprint,
            JSON.stringify({ attemptId: inserted!.id, generationId: id }),
            adoptedAt
          );
        return { replayed: false, attempt: inserted! };
      })();
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.status).send(error.body);
      }
      // 并发下同一 operationId 已写入回执：回放；不同请求则冲突
      const raced = getReceipt(operationId);
      if (raced) {
        if (raced.target_type !== 'ai_accept' || raced.request_fingerprint !== requestFingerprint) {
          return reply.code(409).send({
            error: 'operation_key_conflict',
            message: 'operationId 已被另一个请求使用。',
          });
        }
        const stored = parseStoredJson<{ attemptId?: string; generationId?: string }>(
          raced.response_json
        );
        const attempt = stored?.attemptId ? await getAttemptRow(stored.attemptId) : undefined;
        const gen = await getGenerationRow(stored?.generationId ?? id);
        if (attempt && gen) {
          return { attempt, generation: publicGenerationOf(gen), replayed: true };
        }
      }
      throw error;
    }

    const finalGeneration = await getGenerationRow(id);
    return {
      attempt: outcome.attempt,
      generation: publicGenerationOf(finalGeneration!),
      ...(outcome.replayed ? { replayed: true } : {}),
    };
  });
}
