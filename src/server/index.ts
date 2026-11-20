import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/db';
import { MAX_CAPTURE_CHARS } from './aiSettings';

// 尝试文本上限：此前服务端完全没有校验，直连 API 可以写任意长度（实测 2 万字返回 200）
const ATTEMPT_STEP_MAX = 500;
const ATTEMPT_RESULT_MAX = 4000;

// 枚举白名单：此前 state/outcome 接受任意字符串并原样落库（实测存进 "zzz_bad"）
const ATTEMPT_STATES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const ATTEMPT_OUTCOMES = ['success', 'failure', 'partial', 'undetermined'] as const;

type ValidationError = { error: string; message: string; field: string };

/** 字符串字段类型校验：undefined 视为未提供，null 按调用方 allowNull 决定 */
function expectString(
  value: unknown,
  field: string,
  label: string,
  allowNull = false
): ValidationError | null {
  if (value === undefined) return null;
  if (value === null) {
    return allowNull ? null : { error: `invalid_${field}`, message: `${label}不能为空。`, field };
  }
  if (typeof value !== 'string') {
    return { error: `invalid_${field}`, message: `${label}必须是文本。`, field };
  }
  return null;
}

/** 数字字段类型校验（拒绝 NaN / Infinity / 非数字类型） */
function expectNumber(value: unknown, field: string, label: string): ValidationError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `invalid_${field}`, message: `${label}必须是数字。`, field };
  }
  return null;
}

/** 枚举字段校验 */
function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  label: string
): ValidationError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return {
      error: `invalid_${field}`,
      message: `${label}只能是 ${allowed.join(' / ')}。`,
      field,
    };
  }
  return null;
}
import {
  accounts,
  captures,
  attempts,
  attemptReferences,
  mutationReceipts,
} from '../db/schema';
import {
  getCaptureGenerationCounts,
  markInterruptedGenerations,
  registerAiRoutes,
} from './aiRoutes';
import { registerActivityRoutes } from './activity';
import { invalidateGenerationContextsForDeletedAttempts } from './aiExperience';
import {
  getReviewExportRows,
  invalidateStageReviewSourcesForDeletedAttempts,
  invalidateStageReviewSourcesForDeletedCapture,
  markInterruptedReviews,
} from './reviewData';
import { registerReviewRoutes } from './reviewRoutes';
import { registerReviewAiRoutes } from './reviewAi';
import {
  ScheduleHttpError,
  cancelFutureActiveSchedules,
  countSchedulesForAttempt,
  countSchedulesForAttemptIds,
  deleteSchedulesForAttempt,
  deleteSchedulesForAttemptIds,
  getFutureActiveSchedules,
  type ScheduleBlock,
} from './scheduleService';
import { registerScheduleRoutes } from './scheduleRoutes';
import { registerNextActionRoutes } from './nextActionRoutes';
import { registerResearchRoutes } from './researchRoutes';
import { registerGraphRoutes } from './graphRoutes';
import { registerLinkRoutes } from './linkRoutes';
import { getCaptureResearchCount, getResearchExportRows } from './researchService';
import {
  SESSION_COOKIE,
  createSession,
  isAllowedHost,
  isAllowedOrigin,
  resolveSession,
  revokeSession,
} from './auth';
import { markInterruptedAskQueries, registerAskRoutes } from './askAi';
import {
  invalidateAskSourcesForDeletedAttempts,
  invalidateAskSourcesForDeletedCapture,
} from './askData';
import { registerExperienceRoutes } from './experienceRoutes';
import { registerTopicRoutes } from './topicRoutes';
import { registerTopicExportRoutes } from './topicExportRoutes';
import { cleanupTopicsForDeletedCapture, clearTopicNextForAttempt } from './topicService';
import {
  buildExperiencePublic,
  clearExperienceAttemptContexts,
  experienceAttemptContext,
  experienceImpactsForAttemptIds,
  experienceImpactsForCapture,
  getExperienceExportRows,
  invalidateExperienceSourcesForDeletedAttempts,
  invalidateExperienceSourcesForDeletedCapture,
  searchExperiences,
} from './experienceService';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

declare module 'fastify' {
  interface FastifyRequest {
    session: { accountId: string | null };
  }
}

const fastify = Fastify({
  logger: {
    level: 'info',
    // 普通日志不记录请求体（用户正文）
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  },
});

const interruptedCount = markInterruptedGenerations();
if (interruptedCount > 0) {
  fastify.log.info({ interruptedCount }, '已将重启前未完成的 AI 生成标记为 interrupted');
}

const interruptedReviews = markInterruptedReviews();
if (interruptedReviews > 0) {
  fastify.log.info({ interruptedReviews }, '已将重启前未完成的阶段回顾标记为 interrupted');
}

const interruptedAskQueries = markInterruptedAskQueries();
if (interruptedAskQueries > 0) {
  fastify.log.info({ interruptedAskQueries }, '已将重启前未完成的问我的记录标记为 interrupted');
}

await fastify.register(cookie, {
  secret: process.env.SESSION_SECRET ?? 'shinian-local-dev-secret',
});

// 会话与 Host 校验：Cookie 只携带服务端签发的随机会话 ID。
// Host 校验覆盖读写请求；写请求额外拒绝跨站 Origin。
fastify.addHook('onRequest', async (request, reply) => {
  request.session = { accountId: null };
  const host = request.headers.host;
  if (!isAllowedHost(host)) {
    return reply.code(403).send({ error: 'host rejected' });
  }
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.method !== 'OPTIONS' &&
    !isAllowedOrigin(request.headers.origin, host)
  ) {
    return reply.code(403).send({ error: 'origin rejected' });
  }
  const token = request.cookies?.[SESSION_COOKIE];
  request.session.accountId = resolveSession(token);
});

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

const now = () => Date.now();

function setSessionCookie(reply: any, token: string, expiresAt: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    expires: new Date(expiresAt),
  });
}

// ---------- 会话 ----------
fastify.post('/api/session/create', async (req, reply) => {
  const { username } = (req.body ?? {}) as { username?: string };
  const name = (username ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'username required' });

  const [existing] = await db.select().from(accounts).where(eq(accounts.username, name)).limit(1);
  let accountId: string;
  if (existing) {
    accountId = existing.id;
  } else {
    accountId = `user-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(accounts).values({ id: accountId, username: name, createdAt: now() });
  }
  const session = createSession(accountId);
  setSessionCookie(reply, session.token, session.expiresAt);
  return { ok: true, accountId, username: name };
});

fastify.get('/api/session/check', async (req, reply) => {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, req.session.accountId))
    .limit(1);
  if (!account) return reply.code(401).send({ error: 'unauthenticated' });
  return { ok: true, accountId: account.id, username: account.username };
});

fastify.post('/api/session/destroy', async (req, reply) => {
  revokeSession(req.cookies?.[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

// ---------- 念头 ----------
// 默认只返回普通念头；经验是独立类型，走 /api/experiences，避免两类内容混在一起。
fastify.get('/api/captures', { preHandler: requireAuth }, async (req) => {
  const { archived, q, kind } = req.query as { archived?: string; q?: string; kind?: string };
  const wantArchived = archived === '1' || archived === 'true';
  const wantKind = kind === 'all' ? null : kind === 'experience' ? 'experience' : 'thought';
  const conditions = [
    wantArchived ? sql`${captures.archivedAt} IS NOT NULL` : sql`${captures.archivedAt} IS NULL`,
    wantKind ? sql`${captures.kind} = ${wantKind}` : null,
    q ? sql`${captures.rawText} LIKE ${'%' + q + '%'}` : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  const rows = await db
    .select()
    .from(captures)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(captures.createdAt));
  return { captures: rows };
});

fastify.post('/api/captures', { preHandler: requireAuth }, async (req, reply) => {
  const { rawText } = (req.body ?? {}) as { rawText?: unknown };
  const typeError = expectString(rawText, 'raw_text', '念头正文');
  if (typeError) return reply.code(400).send(typeError);
  const text = (typeof rawText === 'string' ? rawText : '').trim();
  if (!text) return reply.code(400).send({ error: 'rawText required' });
  // 正文上限与前端 maxLength、AI 发送上限保持同一条规则（此前只在 AI 发送时校验）
  if (text.length > MAX_CAPTURE_CHARS) {
    return reply.code(400).send({
      error: 'raw_text_too_long',
      message: `念头原文不能超过 ${MAX_CAPTURE_CHARS} 个字符。`,
      field: 'rawText',
    });
  }
  const id = `cap-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = now();
  const [row] = await db
    .insert(captures)
    .values({ id, rawText: text, revision: 1, createdAt: t, updatedAt: t })
    .returning();
  return { capture: row };
});

fastify.get('/api/captures/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  if (!row) return reply.code(404).send({ error: 'capture not found' });
  return { capture: row };
});

fastify.patch('/api/captures/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rawText, revision } = (req.body ?? {}) as { rawText?: unknown; revision?: number };
  const typeError = expectString(rawText, 'raw_text', '念头正文');
  if (typeError) return reply.code(400).send(typeError);
  const [existing] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  if (!existing) return reply.code(404).send({ error: 'capture not found' });

  if (revision === undefined) {
    return reply.code(428).send({ error: 'revision required' });
  }
  if (revision !== existing.revision) {
    return reply.code(409).send({
      error: 'version conflict',
      currentRevision: existing.revision,
      currentRawText: existing.rawText,
    });
  }
  const text = (typeof rawText === 'string' ? rawText : '').trim();
  if (!text) return reply.code(400).send({ error: 'rawText required' });
  if (text.length > MAX_CAPTURE_CHARS) {
    return reply.code(400).send({
      error: 'raw_text_too_long',
      message: `念头原文不能超过 ${MAX_CAPTURE_CHARS} 个字符。`,
      field: 'rawText',
    });
  }

  // 预检查只是给出更友好的错误；真正的并发保护靠下面 WHERE 里的 revision。
  // 先前这里只按 id 更新，两个请求同时通过预检查时会互相覆盖（后写胜出）。
  // 现在与 attempts 的更新保持一致：条件更新 + 命中行数判断。
  const [row] = await db
    .update(captures)
    .set({ rawText: text, revision: sql`${captures.revision} + 1`, updatedAt: now() })
    .where(and(eq(captures.id, id), eq(captures.revision, revision)))
    .returning();

  if (!row) {
    // 预检查后仍被别的请求抢先提交：重新读最新值，让客户端拿到当前版本再决定。
    const [raced] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
    if (!raced) return reply.code(404).send({ error: 'capture not found' });
    return reply.code(409).send({
      error: 'version conflict',
      currentRevision: raced.revision,
      currentRawText: raced.rawText,
    });
  }
  return { capture: row };
});

fastify.post('/api/captures/:id/archive', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await db
    .update(captures)
    .set({ archivedAt: now(), updatedAt: now() })
    .where(eq(captures.id, id))
    .returning();
  if (!row) return reply.code(404).send({ error: 'capture not found' });
  return { capture: row };
});

fastify.post('/api/captures/:id/restore', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await db
    .update(captures)
    .set({ archivedAt: null, updatedAt: now() })
    .where(eq(captures.id, id))
    .returning();
  if (!row) return reply.code(404).send({ error: 'capture not found' });
  return { capture: row };
});

// 永久删除预览：影响范围
fastify.get('/api/captures/:id/delete-preview', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [cap] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  if (!cap) return reply.code(404).send({ error: 'capture not found' });

  const attemptRows = await db.select().from(attempts).where(eq(attempts.captureId, id));
  const attemptIds = attemptRows.map((a) => a.id);
  let refsOut = 0;
  let refsIn = 0;
  if (attemptIds.length > 0) {
    const placeholders = attemptIds.map(() => '?').join(',');
    refsOut = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM attempt_references WHERE from_attempt_id IN (${placeholders})`
        )
        .get(...attemptIds) as any
    ).c;
    refsIn = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM attempt_references WHERE to_attempt_id IN (${placeholders})`
        )
        .get(...attemptIds) as any
    ).c;
  }
  return {
    captureId: id,
    attemptCount: attemptRows.length,
    referencesFromAttempts: refsOut,
    referencesToAttempts: refsIn,
    captureLinkCount: (
      sqlite
        .prepare(
          'SELECT COUNT(*) AS c FROM capture_links WHERE from_capture_id = ? OR to_capture_id = ?'
        )
        .get(id, id) as any
    ).c,
    generationCount: getCaptureGenerationCounts(id).total,
    scheduleCount: countSchedulesForAttemptIds(attemptIds).total,
    researchCount: getCaptureResearchCount(id).total,
    // 作为别人的依据被删除时，列出受影响的经验与正文处理规则。
    affectedExperiences: experienceImpactsForCapture(id, attemptIds),
    experience: cap.kind === 'experience' ? buildExperiencePublic(id) : null,
    // 删除经验不会删除它的来源；预览里列出会被保留的来源与后续尝试。
    experienceDeletePreview: undefined,
  };
});

// 永久删除：事务内删除关联引用 → 尝试 → 念头
fastify.delete('/api/captures/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [cap] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  if (!cap) return reply.code(404).send({ error: 'capture not found' });

  const attemptRows = await db.select({ id: attempts.id }).from(attempts).where(eq(attempts.captureId, id));
  const attemptIds = attemptRows.map((a) => a.id);
  const researchCount = getCaptureResearchCount(id).total;

  let deletedReferences = 0;
  let deletedGenerations = 0;
  let deletedSchedules = 0;
  let deletedLinks = 0;
  let deletedTopicMembers = 0;
  let clearedTopicNext = 0;
  const tx = sqlite.transaction(() => {
    invalidateGenerationContextsForDeletedAttempts(attemptIds);
    invalidateStageReviewSourcesForDeletedAttempts(attemptIds);
    invalidateAskSourcesForDeletedAttempts(attemptIds);
    invalidateAskSourcesForDeletedCapture(id);
    // 经验依据：先清洗快照与派生正文，再删来源本身；删除经验不会反向删除来源。
    invalidateExperienceSourcesForDeletedAttempts(attemptIds);
    invalidateExperienceSourcesForDeletedCapture(id);
    if (cap.kind === 'experience') {
      clearExperienceAttemptContexts(id);
    }
    // 主题：删除成员关系、清空引用本 capture 下 attempt 的固定下一步；主题本身保留。
    const topicCleanup = cleanupTopicsForDeletedCapture(id);
    deletedTopicMembers = topicCleanup.deletedTopicMembers;
    clearedTopicNext = topicCleanup.clearedTopicNext;
    deletedLinks = sqlite
      .prepare(
        'DELETE FROM capture_links WHERE from_capture_id = ? OR to_capture_id = ?'
      )
      .run(id, id).changes;
    if (attemptIds.length > 0) {
      deletedSchedules = deleteSchedulesForAttemptIds(attemptIds);
      const placeholders = attemptIds.map(() => '?').join(',');
      const del = sqlite
        .prepare(
          `DELETE FROM attempt_references WHERE from_attempt_id IN (${placeholders}) OR to_attempt_id IN (${placeholders})`
        )
        .run(...attemptIds, ...attemptIds);
      deletedReferences = del.changes;
      sqlite.prepare(`DELETE FROM attempts WHERE capture_id = ?`).run(id);
    }
    deletedGenerations = sqlite
      .prepare(`DELETE FROM ai_generations WHERE capture_id = ?`)
      .run(id).changes;
    invalidateStageReviewSourcesForDeletedCapture(id);
    sqlite.prepare(`DELETE FROM captures WHERE id = ?`).run(id);
  });
  tx();

  return {
    ok: true,
    deletedCaptureId: id,
    deletedAttempts: attemptIds.length,
    deletedReferences,
    deletedGenerations,
    deletedSchedules,
    deletedLinks,
    deletedResearch: researchCount,
    deletedTopicMembers,
    clearedTopicNext,
  };
});

// ---------- 尝试 ----------
function fingerprint(payload: unknown): string {
  return JSON.stringify(payload);
}

function getReceipt(operationKey: string) {
  return sqlite
    .prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?')
    .get(operationKey) as
    | { operation_key: string; target_type: string; request_fingerprint: string; response_json: string }
    | undefined;
}

fastify.post('/api/captures/:captureId/attempts', { preHandler: requireAuth }, async (req, reply) => {
  const { captureId } = req.params as { captureId: string };
  const body = (req.body ?? {}) as {
    step?: unknown;
    state?: unknown;
    resultText?: unknown;
    outcome?: unknown;
    sourceUrl?: unknown;
    operationId?: string;
  };
  {
    const errors = [
      expectString(body.step, 'step', '尝试步骤'),
      expectString(body.resultText, 'result_text', '结果', true),
      expectString(body.sourceUrl, 'source_url', '来源链接', true),
      expectEnum(body.state, ATTEMPT_STATES, 'state', '尝试状态'),
      expectEnum(body.outcome, ATTEMPT_OUTCOMES, 'outcome', '结果结论'),
    ].filter((item): item is ValidationError => item !== null);
    if (errors.length > 0) return reply.code(400).send(errors[0]);
  }
  const step = (typeof body.step === 'string' ? body.step : '').trim();
  if (!step) return reply.code(400).send({ error: 'step required' });
  const bodyState = typeof body.state === 'string' ? body.state : null;
  const bodyResultText = typeof body.resultText === 'string' ? body.resultText : null;
  const bodyOutcome = typeof body.outcome === 'string' ? body.outcome : null;
  const bodySourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl : null;
  if (step.length > ATTEMPT_STEP_MAX) {
    return reply.code(400).send({
      error: 'step_too_long',
      message: `尝试步骤不能超过 ${ATTEMPT_STEP_MAX} 个字符。`,
      field: 'step',
    });
  }
  if (!body.operationId) return reply.code(400).send({ error: 'operationId required' });

  const [cap] = await db.select().from(captures).where(eq(captures.id, captureId)).limit(1);
  if (!cap) return reply.code(404).send({ error: 'capture not found' });

  const fp = fingerprint({
    op: 'create-attempt',
    captureId,
    step,
    state: bodyState ?? 'todo',
    resultText: bodyResultText,
    outcome: bodyOutcome,
    sourceUrl: bodySourceUrl,
  });

  const existing = getReceipt(body.operationId);
  if (existing) {
    if (existing.request_fingerprint !== fp) {
      return reply.code(409).send({ error: 'operation key reused with different payload' });
    }
    return { attempt: JSON.parse(existing.response_json), replayed: true };
  }

  const id = `att-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = now();
  const observedAt = body.resultText ? t : null;

  const result = (() => {
    try {
      return sqlite.transaction(() => {
        const [row] = db
          .insert(attempts)
          .values({
            id,
            captureId,
            step,
            state: bodyState ?? 'todo',
            resultText: bodyResultText,
            outcome: bodyOutcome,
            sourceUrl: bodySourceUrl,
            observedAt,
            revision: 1,
            createdAt: t,
            updatedAt: t,
          })
          .returning()
          .all();
        db.insert(mutationReceipts)
          .values({
            operationKey: body.operationId!,
            targetType: 'attempt',
            requestFingerprint: fp,
            responseJson: JSON.stringify(row),
            createdAt: t,
          })
          .run();
        return row;
      })();
    } catch (err: any) {
      // 并发下另一请求已用同一操作 ID 完成：回放其响应
      const receipt = getReceipt(body.operationId!);
      if (receipt && receipt.request_fingerprint === fp) {
        return JSON.parse(receipt.response_json);
      }
      throw err;
    }
  })();

  return { attempt: result };
});

fastify.get('/api/captures/:captureId/attempts', { preHandler: requireAuth }, async (req) => {
  const { captureId } = req.params as { captureId: string };
  const rows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.captureId, captureId))
    .orderBy(desc(attempts.createdAt));
  return { attempts: rows };
});

// 首页「继续已有尝试」：只读最近尝试，不改变状态、不自动排序用户优先级。
fastify.get('/api/attempts/recent', { preHandler: requireAuth }, async (req) => {
  const query = req.query as { limit?: string };
  const limit = Math.max(1, Math.min(10, Number.parseInt(query.limit ?? '6', 10) || 6));
  const rows = sqlite
    .prepare(
      `SELECT a.id, a.capture_id AS captureId, a.step, a.state,
              a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
              a.revision, a.created_at AS createdAt, a.updated_at AS updatedAt,
              c.raw_text AS captureText, c.archived_at AS captureArchivedAt
         FROM attempts a
         JOIN captures c ON c.id = a.capture_id
        WHERE c.archived_at IS NULL
        ORDER BY CASE a.state
                   WHEN 'in_progress' THEN 0
                   WHEN 'todo' THEN 1
                   ELSE 2
                 END,
                 a.updated_at DESC, a.created_at DESC
        LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    captureId: string;
    step: string;
    state: string;
    resultText: string | null;
    outcome: string | null;
    observedAt: number | null;
    revision: number;
    createdAt: number;
    updatedAt: number;
    captureText: string;
    captureArchivedAt: number | null;
  }>;
  return {
    attempts: rows.map((row) => ({
      ...row,
      captureArchived: row.captureArchivedAt !== null,
    })),
  };
});

fastify.get('/api/attempts/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [row] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!row) return reply.code(404).send({ error: 'attempt not found' });
  const [cap] = await db.select().from(captures).where(eq(captures.id, row.captureId)).limit(1);
  return {
    attempt: row,
    capture: cap ?? null,
    // 参考经验创建的尝试：保留采用时版本与正文快照；经验删除后仍可辨认采用了哪一版。
    experienceRef: experienceAttemptContext(id),
  };
});

type RawAttemptRow = {
  id: string;
  capture_id: string;
  step: string;
  state: string;
  result_text: string | null;
  outcome: string | null;
  source_url: string | null;
  observed_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  origin: string;
  action_description: string | null;
  estimated_minutes: number | null;
  source_review_id: string | null;
  source_experience_index: number | null;
  source_attempt_id: string | null;
  source_attempt_revision: number | null;
};

function attemptRowToApi(row: RawAttemptRow) {
  return {
    id: row.id,
    captureId: row.capture_id,
    step: row.step,
    state: row.state,
    resultText: row.result_text,
    outcome: row.outcome,
    sourceUrl: row.source_url,
    observedAt: row.observed_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    origin: row.origin,
    actionDescription: row.action_description,
    estimatedMinutes: row.estimated_minutes,
    sourceReviewId: row.source_review_id,
    sourceExperienceIndex: row.source_experience_index,
    sourceAttemptId: row.source_attempt_id,
    sourceAttemptRevision: row.source_attempt_revision,
  };
}

// 更新尝试：revision CAS、状态保存与未来日程处理在同一事务中完成。
fastify.patch('/api/attempts/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as {
    state?: unknown;
    step?: unknown;
    resultText?: unknown;
    outcome?: unknown;
    sourceUrl?: unknown;
    observedAt?: unknown;
    revision?: number;
    futureScheduleAction?: string;
  };

  {
    const errors = [
      expectString(body.step, 'step', '尝试步骤'),
      expectString(body.resultText, 'result_text', '结果', true),
      expectString(body.sourceUrl, 'source_url', '来源链接', true),
      expectNumber(body.observedAt, 'observed_at', '发生时间'),
      expectEnum(body.state, ATTEMPT_STATES, 'state', '尝试状态'),
      expectEnum(body.outcome, ATTEMPT_OUTCOMES, 'outcome', '结果结论'),
    ].filter((item): item is ValidationError => item !== null);
    if (errors.length > 0) return reply.code(400).send(errors[0]);
  }

  if (body.revision === undefined) return reply.code(428).send({ error: 'revision required' });
  if (
    body.futureScheduleAction !== undefined &&
    body.futureScheduleAction !== null &&
    body.futureScheduleAction !== '' &&
    body.futureScheduleAction !== 'keep' &&
    body.futureScheduleAction !== 'cancel'
  ) {
    return reply.code(400).send({
      error: 'invalid_request',
      message: 'futureScheduleAction 只能是 keep 或 cancel。',
      field: 'futureScheduleAction',
    });
  }

  if (typeof body.step === 'string' && body.step.trim().length > ATTEMPT_STEP_MAX) {
    return reply.code(400).send({
      error: 'step_too_long',
      message: `尝试步骤不能超过 ${ATTEMPT_STEP_MAX} 个字符。`,
      field: 'step',
    });
  }
  if (typeof body.resultText === 'string' && body.resultText.trim().length > ATTEMPT_RESULT_MAX) {
    return reply.code(400).send({
      error: 'result_too_long',
      message: `结果不能超过 ${ATTEMPT_RESULT_MAX} 个字符。`,
      field: 'resultText',
    });
  }

  try {
    const outcome = sqlite.transaction(() => {
      const existing = sqlite
        .prepare('SELECT * FROM attempts WHERE id = ?')
        .get(id) as RawAttemptRow | undefined;
      if (!existing) {
        throw new ScheduleHttpError(404, { error: 'attempt not found' });
      }
      if (body.revision !== existing.revision) {
        throw new ScheduleHttpError(409, {
          error: 'version conflict',
          currentRevision: existing.revision,
          current: attemptRowToApi(existing),
        });
      }

      const nextState = body.state ?? existing.state;
      const becomesEnded =
        body.state !== undefined &&
        (nextState === 'done' || nextState === 'cancelled') &&
        nextState !== existing.state;

      let cancelledScheduleCount = 0;
      if (becomesEnded) {
        const futureSchedules: ScheduleBlock[] = getFutureActiveSchedules(id);
        if (futureSchedules.length > 0) {
          const action = body.futureScheduleAction;
          if (action !== 'keep' && action !== 'cancel') {
            throw new ScheduleHttpError(409, {
              error: 'future_schedules',
              message: '这个尝试还有未来安排',
              futureSchedules,
              currentRevision: existing.revision,
            });
          }
          if (action === 'cancel') {
            cancelledScheduleCount = cancelFutureActiveSchedules(id);
          }
        }
      }

      const hasResult = body.resultText !== undefined ? !!body.resultText : !!existing.result_text;
      const observedAt =
        body.observedAt !== undefined
          ? body.observedAt
          : hasResult
            ? existing.observed_at ?? now()
            : null;

      const t = now();
      const result = sqlite
        .prepare(
          `UPDATE attempts
              SET state = ?, result_text = ?, outcome = ?, source_url = ?,
                  observed_at = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`
        )
        .run(
          nextState,
          body.resultText !== undefined ? body.resultText : existing.result_text,
          body.outcome !== undefined ? body.outcome : existing.outcome,
          body.sourceUrl !== undefined ? body.sourceUrl : existing.source_url,
          observedAt,
          t,
          id,
          body.revision
        );
      if (result.changes !== 1) {
        const raced = sqlite
          .prepare('SELECT * FROM attempts WHERE id = ?')
          .get(id) as RawAttemptRow | undefined;
        throw new ScheduleHttpError(409, {
          error: 'version conflict',
          currentRevision: raced?.revision ?? null,
          current: raced ? attemptRowToApi(raced) : null,
        });
      }

      const updated = sqlite
        .prepare('SELECT * FROM attempts WHERE id = ?')
        .get(id) as RawAttemptRow;
      // 改到 cancelled：清空引用这次尝试的主题固定下一步（不影响原尝试记录）。
      const clearedTopicNext =
        nextState === 'cancelled' && existing.state !== 'cancelled'
          ? clearTopicNextForAttempt(id, 'attempt_cancelled')
          : 0;
      return { attempt: attemptRowToApi(updated), cancelledScheduleCount, clearedTopicNext };
    })();

    return outcome;
  } catch (error) {
    if (error instanceof ScheduleHttpError) {
      return reply.code(error.status).send(error.body);
    }
    req.log.error({ err: error, attemptId: id }, 'attempt patch failed');
    return reply.code(500).send({ error: 'internal_error', message: '更新尝试失败，请稍后重试。' });
  }
});

// 删除尝试预览：日程、引用影响范围
fastify.get('/api/attempts/:id/delete-preview', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = sqlite.prepare('SELECT id FROM attempts WHERE id = ?').get(id);
  if (!existing) return reply.code(404).send({ error: 'attempt not found' });

  const scheduleCounts = countSchedulesForAttempt(id);
  const refsFrom = (
    sqlite
      .prepare('SELECT COUNT(*) AS c FROM attempt_references WHERE from_attempt_id = ?')
      .get(id) as { c: number }
  ).c;
  const refsTo = (
    sqlite
      .prepare('SELECT COUNT(*) AS c FROM attempt_references WHERE to_attempt_id = ?')
      .get(id) as { c: number }
  ).c;

  return {
    attemptId: id,
    scheduleCount: scheduleCounts.total,
    activeScheduleCount: scheduleCounts.active,
    referencesFromAttempts: refsFrom,
    referencesToAttempts: refsTo,
    // 这次结果被哪些经验当作依据；模型整理的正文会在删除时被清空。
    affectedExperiences: experienceImpactsForAttemptIds([id]),
  };
});

fastify.delete('/api/attempts/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [existing] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!existing) return reply.code(404).send({ error: 'attempt not found' });

  let deletedReferences = 0;
  let deletedSchedules = 0;
  let unfixedTopicCount = 0;
  const tx = sqlite.transaction(() => {
    invalidateGenerationContextsForDeletedAttempts([id]);
    invalidateStageReviewSourcesForDeletedAttempts([id]);
    invalidateAskSourcesForDeletedAttempts([id]);
    invalidateExperienceSourcesForDeletedAttempts([id]);
    unfixedTopicCount = clearTopicNextForAttempt(id, 'attempt_deleted');
    deletedSchedules = deleteSchedulesForAttempt(id);
    const del = sqlite
      .prepare('DELETE FROM attempt_references WHERE from_attempt_id = ? OR to_attempt_id = ?')
      .run(id, id);
    deletedReferences = del.changes;
    sqlite.prepare('DELETE FROM attempts WHERE id = ?').run(id);
  });
  tx();
  return { ok: true, deletedAttemptId: id, deletedReferences, deletedSchedules, unfixedTopicCount };
});

// ---------- 引用 ----------
fastify.post('/api/attempts/:fromId/references', { preHandler: requireAuth }, async (req, reply) => {
  const { fromId } = req.params as { fromId: string };
  const body = (req.body ?? {}) as { toId?: string; note?: string; operationId?: string };
  const toId = body.toId;
  if (!toId) return reply.code(400).send({ error: 'toId required' });
  if (!body.operationId) return reply.code(400).send({ error: 'operationId required' });
  if (fromId === toId) return reply.code(400).send({ error: 'self reference not allowed' });

  const [fromAttempt] = await db.select().from(attempts).where(eq(attempts.id, fromId)).limit(1);
  if (!fromAttempt) return reply.code(404).send({ error: 'from attempt not found' });
  const [toAttempt] = await db.select().from(attempts).where(eq(attempts.id, toId)).limit(1);
  if (!toAttempt) return reply.code(404).send({ error: 'to attempt not found' });

  const fp = fingerprint({ op: 'create-reference', fromId, toId, note: body.note ?? '' });
  const existing = getReceipt(body.operationId);
  if (existing) {
    if (existing.request_fingerprint !== fp) {
      return reply.code(409).send({ error: 'operation key reused with different payload' });
    }
    return { reference: JSON.parse(existing.response_json), replayed: true };
  }

  const [dup] = await db
    .select()
    .from(attemptReferences)
    .where(and(eq(attemptReferences.fromAttemptId, fromId), eq(attemptReferences.toAttemptId, toId)))
    .limit(1);
  if (dup) return reply.code(409).send({ error: 'duplicate reference', existingId: dup.id });

  const id = `ref-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = now();
  const result = (() => {
    try {
      return sqlite.transaction(() => {
        const [row] = db
          .insert(attemptReferences)
          .values({
            id,
            fromAttemptId: fromId,
            toAttemptId: toId,
            revision: 1,
            note: body.note ?? null,
            snapshotResultText: toAttempt.resultText ?? null,
            snapshotRevision: toAttempt.revision,
            createdAt: t,
          })
          .returning()
          .all();
        db.insert(mutationReceipts)
          .values({
            operationKey: body.operationId!,
            targetType: 'reference',
            requestFingerprint: fp,
            responseJson: JSON.stringify(row),
            createdAt: t,
          })
          .run();
        return row;
      })();
    } catch (err: any) {
      const receipt = getReceipt(body.operationId!);
      if (receipt && receipt.request_fingerprint === fp) {
        return JSON.parse(receipt.response_json);
      }
      throw err;
    }
  })();
  return { reference: result };
});

// 引用关系：两个方向，附带记录信息与「来源是否有更新」
fastify.get('/api/attempts/:id/references', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [attempt] = await db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!attempt) return reply.code(404).send({ error: 'attempt not found' });

  const outRows = await db
    .select()
    .from(attemptReferences)
    .where(eq(attemptReferences.fromAttemptId, id));
  const inRows = await db
    .select()
    .from(attemptReferences)
    .where(eq(attemptReferences.toAttemptId, id));

  const fromRefs = outRows.map((r) => {
    const src = sqlite.prepare('SELECT * FROM attempts WHERE id = ?').get(r.toAttemptId) as any;
    return {
      ...r,
      source: src
        ? {
            id: src.id,
            captureId: src.capture_id,
            step: src.step,
            resultText: src.result_text,
            outcome: src.outcome,
            revision: src.revision,
            updatedSinceSnapshot: src.revision !== r.snapshotRevision,
          }
        : null,
    };
  });

  const toRefs = inRows.map((r) => {
    const from = sqlite.prepare('SELECT * FROM attempts WHERE id = ?').get(r.fromAttemptId) as any;
    return {
      ...r,
      referencing: from
        ? {
            id: from.id,
            captureId: from.capture_id,
            step: from.step,
            state: from.state,
            revision: from.revision,
          }
        : null,
    };
  });

  return { fromRefs, toRefs };
});

fastify.delete('/api/attempt_references/:id', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [ref] = await db
    .select()
    .from(attemptReferences)
    .where(eq(attemptReferences.id, id))
    .limit(1);
  if (!ref) return reply.code(404).send({ error: 'reference not found' });
  await db.delete(attemptReferences).where(eq(attemptReferences.id, id));
  return { ok: true, deletedRefId: id };
});

// ---------- 统一搜索 ----------
// 覆盖：念头原文、尝试步骤、尝试结果；返回匹配字段 + 摘要 + 所属记录
fastify.get('/api/search', { preHandler: requireAuth }, async (req, reply) => {
  const { q } = req.query as { q?: string };
  const term = (q ?? '').trim();
  if (!term) return reply.code(400).send({ error: 'q required' });

  const like = `%${term}%`;
  const captureRows = await db
    .select()
    .from(captures)
    .where(and(sql`${captures.rawText} LIKE ${like}`, sql`${captures.kind} = 'thought'`))
    .orderBy(desc(captures.createdAt))
    .limit(50);

  const attemptRows = await db
    .select()
    .from(attempts)
    .where(sql`${attempts.step} LIKE ${like} OR ${attempts.resultText} LIKE ${like}`)
    .orderBy(desc(attempts.createdAt))
    .limit(50);

  const snippet = (text: string | null, max = 80) => {
    if (!text) return '';
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx < 0) return text.slice(0, max);
    const start = Math.max(0, idx - 20);
    return (
      (start > 0 ? '…' : '') +
      text.slice(start, start + max) +
      (start + max < text.length ? '…' : '')
    );
  };

  return {
    query: term,
    // 经验摘要单独返回，命中原因明确；打开后仍需回到下方原始记录核对。
    experiences: searchExperiences(term, 12),
    captures: captureRows.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      archived: c.archivedAt !== null,
      snippet: snippet(c.rawText),
      matchField: 'capture.rawText',
    })),
    attempts: attemptRows.map((a) => {
      const inStep = a.step.toLowerCase().includes(term.toLowerCase());
      const inResult = (a.resultText ?? '').toLowerCase().includes(term.toLowerCase());
      return {
        id: a.id,
        captureId: a.captureId,
        step: a.step,
        state: a.state,
        resultText: a.resultText,
        outcome: a.outcome,
        snippet: inStep ? snippet(a.step) : snippet(a.resultText),
        matchField: inStep ? 'attempt.step' : inResult ? 'attempt.resultText' : 'attempt.step',
      };
    }),
  };
});

// ---------- 数据导出 ----------
// 导出文件名使用本地时间：shinian-export-YYYYMMDD-HHmmss.json
function exportFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `shinian-export-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

// 只导出业务表与用户保存的阶段回顾；accounts / mutation_receipts / source_links / _migrations
// 等内部数据一律不导出。未保存的 AI 生成/回顾过程记录不进入导出。
fastify.get('/api/export', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const data = sqlite.transaction(() => {
      const captureRows = sqlite
        .prepare(
          `SELECT id, raw_text AS rawText, revision, created_at AS createdAt,
                  updated_at AS updatedAt, archived_at AS archivedAt, kind
           FROM captures
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      const attemptRows = sqlite
        .prepare(
          `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
                  outcome, source_url AS sourceUrl, observed_at AS observedAt,
                  revision, created_at AS createdAt, updated_at AS updatedAt,
                  origin, action_description AS actionDescription,
                  estimated_minutes AS estimatedMinutes,
                  source_review_id AS sourceReviewId,
                  source_experience_index AS sourceExperienceIndex,
                  source_attempt_id AS sourceAttemptId,
                  source_attempt_revision AS sourceAttemptRevision,
                  source_research_id AS sourceResearchId,
                  source_research_experiment_index AS sourceResearchExperimentIndex,
                  research_suggested_json AS researchSuggestedJson,
                  research_source_ids_json AS researchSourceIdsJson
           FROM attempts
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      const referenceRows = sqlite
        .prepare(
          `SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId,
                  revision, note, snapshot_result_text AS snapshotResultText,
                  snapshot_revision AS snapshotRevision, created_at AS createdAt
           FROM attempt_references
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      const scheduleRows = sqlite
        .prepare(
          `SELECT id, attempt_id AS attemptId, starts_at AS startsAt, ends_at AS endsAt,
                  timezone, note, status, revision, created_at AS createdAt,
                  updated_at AS updatedAt, cancelled_at AS cancelledAt
           FROM schedule_blocks
           ORDER BY starts_at ASC, id ASC`
        )
        .all();
      const captureLinkRows = sqlite
        .prepare(
          `SELECT id, from_capture_id AS fromCaptureId, to_capture_id AS toCaptureId,
                  note, revision, created_at AS createdAt, updated_at AS updatedAt
           FROM capture_links
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      const topicRows = sqlite
        .prepare(
          `SELECT id, title, exploring_question AS exploringQuestion,
                  continue_note AS continueNote, next_attempt_id AS nextAttemptId,
                  next_attempt_cleared_reason AS nextAttemptClearedReason,
                  revision, archived_at AS archivedAt, created_at AS createdAt,
                  updated_at AS updatedAt
           FROM topics
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      const topicMemberRows = sqlite
        .prepare(
          `SELECT id, topic_id AS topicId, capture_id AS captureId,
                  member_kind AS memberKind, created_at AS createdAt
           FROM topic_members
           ORDER BY created_at ASC, id ASC`
        )
        .all();
      return {
        captures: captureRows,
        attempts: attemptRows,
        attemptReferences: referenceRows,
        captureLinks: captureLinkRows,
        scheduleBlocks: scheduleRows,
        stageReviews: getReviewExportRows(),
        ...getResearchExportRows(),
        // 经验笔记（schemaVersion 6）：正文在 captures.kind='experience'，这里只补充经验字段与关系。
        ...getExperienceExportRows(),
        // 主题（schemaVersion 7）：只导出稳定 ID 关系与用户说明，不导出内部回执。
        topics: topicRows,
        topicMembers: topicMemberRows,
      };
    })();

    const payload = {
      schemaVersion: 7,
      appVersion: '0.1.0',
      exportedAt: new Date().toISOString(),
      data,
    };

    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${exportFileName()}"`)
      .header('Cache-Control', 'no-store')
      .send(JSON.stringify(payload, null, 2));
  } catch (err) {
    req.log.error({ err }, 'export failed');
    return reply.code(500).send({ error: '导出失败，请稍后重试' });
  }
});

// ---------- AI 设置 / 生成 ----------
registerAiRoutes(fastify);

// ---------- 事件展示栏 ----------
registerActivityRoutes(fastify);

// ---------- 阶段回顾 ----------
registerReviewRoutes(fastify);
registerReviewAiRoutes(fastify);

// ---------- 日程安排 ----------
registerScheduleRoutes(fastify);

// ---------- 回顾后的下一步行动 ----------
registerNextActionRoutes(fastify);

// ---------- 研究一下（GitHub 开源项目调研） ----------
registerResearchRoutes(fastify);

// ---------- 知识网络（只读投影） ----------
registerGraphRoutes(fastify);

// ---------- 念头关联 / 反链 / 念头级引用 ----------
registerLinkRoutes(fastify);

// ---------- 问我的记录（只读问答） ----------
registerAskRoutes(fastify);

// ---------- 经验笔记（用户明确保存的理解） ----------
registerExperienceRoutes(fastify);

// ---------- 主题（一组记录 + 探索问题 + 固定下一步） ----------
registerTopicRoutes(fastify);
registerTopicExportRoutes(fastify);

// ---------- 单页宣传站（站内同源直达，供左侧「拾」图标跳转） ----------
const landingHtmlPath = path.resolve(__dirname, '../../shinian-landing.html');
if (fs.existsSync(landingHtmlPath)) {
  fastify.get('/promo', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(landingHtmlPath));
  });
  fastify.get('/landing', async (_req, reply) => {
    return reply.redirect('/promo');
  });
}

// ---------- 静态前端 ----------
const clientDir = path.resolve(__dirname, '../../dist/client');
const hasClient = fs.existsSync(path.join(clientDir, 'index.html'));

if (hasClient) {
  await fastify.register(fastifyStatic, {
    root: clientDir,
    prefix: '/',
  });
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  fastify.get('/', async () => ({
    message: '拾念 SHINIAN v0.1 API（前端未构建，请运行 npm run build）',
  }));
}

const start = async () => {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  await fastify.listen({ port, host });
  fastify.log.info(`拾念本地服务: http://${host}:${port}`);
};

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
