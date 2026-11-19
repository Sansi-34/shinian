// 拾念 SHINIAN · 「主题」数据层
// 主题只保存稳定 ID 与用户写下的说明；成员正文、经验标题、attempt 状态都在读取时回表。
// 写路径统一：SQLite 事务 + mutation_receipts 幂等 + topics.revision CAS。
import crypto from 'node:crypto';
import { sqlite } from '../db/db';
import { buildExperiencePublic } from './experienceService';
import { searchAskCandidates, type AskSearchScope } from './askData';
import type { AskRange } from './askTypes';
import {
  TOPIC_CANDIDATE_DEFAULT_LIMIT,
  TOPIC_CANDIDATE_MAX_LIMIT,
  TOPIC_LIST_DEFAULT_LIMIT,
  TOPIC_LIST_MAX_LIMIT,
  TOPIC_ATTEMPT_DEFAULT_LIMIT,
  TOPIC_ATTEMPT_MAX_LIMIT,
  TOPIC_MAX_CAPTURES,
  TOPIC_OPERATION_ID_MAX,
  TOPIC_TEXT_MAX,
  TOPIC_TITLE_MAX,
  type TopicAskExperience,
  type TopicAttemptItem,
  type TopicAttemptStateFilter,
  type TopicDetail,
  type TopicListItem,
  type TopicMember,
  type TopicMemberCandidate,
  type TopicMemberKind,
  type TopicMembers,
  type TopicNextAttempt,
  type TopicNextAttemptClearedReason,
  type TopicResultState,
  type TopicScope,
  type TopicScopeSummary,
  type TopicSummary,
} from './topicTypes';

export class TopicHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? 'topic error'));
    this.status = status;
    this.body = body;
  }
}

type TopicRow = {
  id: string;
  title: string;
  exploringQuestion: string | null;
  continueNote: string | null;
  nextAttemptId: string | null;
  nextAttemptClearedReason: string | null;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type MemberRow = {
  id: string;
  captureId: string;
  memberKind: string;
  memberCreatedAt: number;
  rawText: string;
  revision: number;
  archivedAt: number | null;
  captureCreatedAt: number;
  captureUpdatedAt: number;
  captureKind: string;
  experienceTitle: string | null;
  understandingOrigin: string | null;
  needsRevision: number | null;
};

type AttemptRow = {
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
};

type ReceiptRow = {
  operation_key: string;
  target_type: string;
  request_fingerprint: string;
  response_json: string;
};

const MAX_TOPIC_QUERY_CHARS = 120;

function now(): number {
  return Date.now();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstLine(text: string, max: number): string {
  const line = normalizeSpace(text.split(/\r?\n/u)[0] ?? '');
  const value = line || normalizeSpace(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function asKind(value: string | null | undefined): TopicMemberKind {
  return value === 'experience' ? 'experience' : 'thought';
}

function asClearedReason(value: string | null | undefined): TopicNextAttemptClearedReason {
  return value === 'attempt_deleted' || value === 'attempt_cancelled' || value === 'member_removed'
    ? value
    : null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new TopicHttpError(400, { error: 'invalid_cursor', message: '分页游标不正确。' });
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const match = /^offset:(\d+)$/u.exec(text);
    if (!match) throw new Error('bad');
    return Number.parseInt(match[1]!, 10);
  } catch {
    throw new TopicHttpError(400, { error: 'invalid_cursor', message: '分页游标不正确。' });
  }
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function clampOffset(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function parseOperationId(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return null;
    throw new TopicHttpError(400, {
      error: 'invalid_operation_id',
      field: 'operationId',
      message: 'operationId 不能为空且不能超过 200 个字符。',
    });
  }
  if (typeof raw !== 'string') {
    throw new TopicHttpError(400, {
      error: 'invalid_operation_id',
      field: 'operationId',
      message: 'operationId 不能为空且不能超过 200 个字符。',
    });
  }
  const value = raw.trim();
  if (!value || value.length > TOPIC_OPERATION_ID_MAX) {
    throw new TopicHttpError(400, {
      error: 'invalid_operation_id',
      field: 'operationId',
      message: 'operationId 不能为空且不能超过 200 个字符。',
    });
  }
  return value;
}

function parseExpectedRevision(raw: unknown, required = true): number | null {
  if (raw === undefined || raw === null) {
    if (!required) return null;
    throw new TopicHttpError(428, {
      error: 'revision_required',
      message: '缺少版本号，请刷新后重试。',
    });
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new TopicHttpError(400, {
      error: 'invalid_request',
      field: 'expectedRevision',
      message: 'expectedRevision 必须是正整数。',
    });
  }
  return raw;
}

function parseTitle(raw: unknown, field = 'title'): string {
  if (typeof raw !== 'string') {
    throw new TopicHttpError(400, { error: 'invalid_title', field, message: '标题不能为空且不能超过 120 个字符。' });
  }
  const value = raw.trim();
  if (!value || value.length > TOPIC_TITLE_MAX) {
    throw new TopicHttpError(400, { error: 'invalid_title', field, message: '标题不能为空且不能超过 120 个字符。' });
  }
  return value;
}

function parseOptionalText(raw: unknown, field: 'exploringQuestion' | 'continueNote'): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new TopicHttpError(400, {
      error: field === 'exploringQuestion' ? 'invalid_exploring_question' : 'invalid_continue_note',
      field,
      message: '说明文字必须是不超过 1000 个字符的字符串。',
    });
  }
  const value = raw.trim();
  if (value.length > TOPIC_TEXT_MAX) {
    throw new TopicHttpError(400, {
      error: field === 'exploringQuestion' ? 'invalid_exploring_question' : 'invalid_continue_note',
      field,
      message: '说明文字不能超过 1000 个字符。',
    });
  }
  return value ? value : null;
}

function parseCaptureIds(raw: unknown, required: boolean): string[] {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new TopicHttpError(400, { error: 'invalid_capture_ids', field: 'captureIds', message: '请至少选择 1 条记录。' });
    }
    return [];
  }
  if (!Array.isArray(raw) || raw.length > TOPIC_MAX_CAPTURES) {
    throw new TopicHttpError(400, {
      error: 'invalid_capture_ids',
      field: 'captureIds',
      message: `captureIds 必须是最多 ${TOPIC_MAX_CAPTURES} 个字符串的数组。`,
    });
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new TopicHttpError(400, { error: 'invalid_capture_ids', field: 'captureIds', message: 'captureId 必须是字符串。' });
    }
    const value = item.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  if (required && ids.length === 0) {
    throw new TopicHttpError(400, { error: 'invalid_capture_ids', field: 'captureIds', message: '请至少选择 1 条记录。' });
  }
  return ids;
}

function parseTopicIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > TOPIC_MAX_CAPTURES) {
    throw new TopicHttpError(400, {
      error: 'invalid_topic_ids',
      field: 'topicIds',
      message: `topicIds 必须是 1–${TOPIC_MAX_CAPTURES} 个字符串的数组。`,
    });
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new TopicHttpError(400, { error: 'invalid_topic_ids', field: 'topicIds', message: 'topicId 必须是字符串。' });
    }
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  if (ids.length === 0) {
    throw new TopicHttpError(400, { error: 'invalid_topic_ids', field: 'topicIds', message: '请至少选择 1 个主题。' });
  }
  return ids;
}

function parseArchivedFilter(raw: unknown): '0' | '1' | 'all' {
  if (raw === undefined || raw === null || raw === '') return '0';
  if (raw === '0' || raw === 0) return '0';
  if (raw === '1' || raw === 1) return '1';
  if (raw === 'all') return 'all';
  throw new TopicHttpError(400, { error: 'invalid_archived', field: 'archived', message: 'archived 只能是 0、1 或 all。' });
}

function parseAttemptStateFilter(raw: unknown): TopicAttemptStateFilter {
  if (raw === undefined || raw === null || raw === '') return 'all';
  if (raw === 'all' || raw === 'recorded' || raw === 'pending' || raw === 'cancelled') return raw;
  throw new TopicHttpError(400, {
    error: 'invalid_attempt_state',
    field: 'state',
    message: 'state 只能是 all、recorded、pending 或 cancelled。',
  });
}

// ---------------------------------------------------------------- 回执
function readReceipt(operationId: string): ReceiptRow | undefined {
  return sqlite
    .prepare(
      `SELECT operation_key, target_type, request_fingerprint, response_json
         FROM mutation_receipts WHERE operation_key = ?`
    )
    .get(operationId) as ReceiptRow | undefined;
}

function replayReceipt<T>(receipt: ReceiptRow, fingerprint: string, targetType: string): T {
  if (receipt.target_type !== targetType || receipt.request_fingerprint !== fingerprint) {
    throw new TopicHttpError(409, {
      error: 'operation_key_conflict',
      message: 'operationId 已被另一个请求使用。',
    });
  }
  return JSON.parse(receipt.response_json) as T;
}

function writeReceipt(operationId: string, targetType: string, fingerprint: string, payload: unknown, t: number): void {
  sqlite
    .prepare(
      `INSERT INTO mutation_receipts (operation_key, target_type, request_fingerprint, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(operationId, targetType, fingerprint, JSON.stringify(payload), t);
}

// ---------------------------------------------------------------- 读取基础行
const TOPIC_COLUMNS = `id, title, exploring_question AS exploringQuestion,
  continue_note AS continueNote, next_attempt_id AS nextAttemptId,
  next_attempt_cleared_reason AS nextAttemptClearedReason, revision,
  archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt`;

function readTopicRow(topicId: string): TopicRow | undefined {
  return sqlite
    .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`)
    .get(topicId) as TopicRow | undefined;
}

function readMemberRows(topicId: string): MemberRow[] {
  return sqlite
    .prepare(
      `SELECT m.id, m.capture_id AS captureId, m.member_kind AS memberKind,
              m.created_at AS memberCreatedAt FROM topic_members m
         JOIN captures c ON c.id = m.capture_id
        WHERE m.topic_id = ?
        ORDER BY m.created_at ASC, m.id ASC`
    )
    .all(topicId)
    .map((basis) => {
      const row = basis as { id: string; captureId: string; memberKind: string; memberCreatedAt: number };
      const capture = sqlite
        .prepare(
          `SELECT raw_text AS rawText, revision, archived_at AS archivedAt,
                  created_at AS captureCreatedAt, updated_at AS captureUpdatedAt, kind AS captureKind
             FROM captures WHERE id = ?`
        )
        .get(row.captureId) as
        | {
            rawText: string;
            revision: number;
            archivedAt: number | null;
            captureCreatedAt: number;
            captureUpdatedAt: number;
            captureKind: string;
          }
        | undefined;
      const note = sqlite
        .prepare(
          `SELECT title AS experienceTitle, understanding_origin AS understandingOrigin,
                  needs_revision AS needsRevision
             FROM experience_notes WHERE capture_id = ?`
        )
        .get(row.captureId) as
        | { experienceTitle: string; understandingOrigin: string; needsRevision: number }
        | undefined;
      return {
        ...row,
        rawText: capture?.rawText ?? '',
        revision: capture?.revision ?? 1,
        archivedAt: capture?.archivedAt ?? null,
        captureCreatedAt: capture?.captureCreatedAt ?? 0,
        captureUpdatedAt: capture?.captureUpdatedAt ?? 0,
        captureKind: capture?.captureKind ?? 'thought',
        experienceTitle: note?.experienceTitle ?? null,
        understandingOrigin: note?.understandingOrigin ?? null,
        needsRevision: note?.needsRevision ?? null,
      } satisfies MemberRow;
    });
}

function buildMember(row: MemberRow): TopicMember {
  const kind = asKind(row.memberKind);
  const isExperience = kind === 'experience';
  const sourceCount = isExperience
    ? (
        sqlite
          .prepare('SELECT COUNT(*) AS c FROM experience_sources WHERE experience_id = ? AND deleted = 0')
          .get(row.captureId) as { c: number }
      ).c
    : undefined;
  const hasPracticeResult = isExperience
    ? Boolean(
        (
          sqlite
            .prepare(
              `SELECT 1 AS ok FROM experience_sources
                WHERE experience_id = ? AND deleted = 0
                  AND source_result_text IS NOT NULL AND TRIM(source_result_text) <> ''
                LIMIT 1`
            )
            .get(row.captureId) as { ok: number } | undefined
        )?.ok
      )
    : undefined;
  const href = isExperience ? `/experience/${row.captureId}` : `/capture/${row.captureId}`;
  const member: TopicMember = {
    id: row.id,
    captureId: row.captureId,
    kind,
    type: kind,
    title: isExperience ? row.experienceTitle ?? firstLine(row.rawText, 80) : firstLine(row.rawText, 80),
    summary: firstLine(row.rawText, 160),
    rawText: row.rawText,
    revision: row.revision,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    createdAt: row.captureCreatedAt,
    updatedAt: row.captureUpdatedAt,
    addedAt: row.memberCreatedAt,
    href,
    openHref: href,
  };
  if (isExperience) {
    member.sourceCount = sourceCount ?? 0;
    member.derivationBy = row.understandingOrigin === 'model_draft' ? 'model' : 'user';
    member.needsRevision = Boolean(row.needsRevision);
    member.hasPracticeResult = hasPracticeResult ?? false;
    member.experienceId = row.captureId;
  }
  return member;
}

function readMemberSummary(topicId: string): TopicMembers {
  const rows = readMemberRows(topicId).map(buildMember);
  return {
    thoughts: rows.filter((item) => item.kind === 'thought'),
    experiences: rows.filter((item) => item.kind === 'experience'),
  };
}

function readNextAttempt(
  topicId: string,
  attemptId: string
): { attempt: TopicNextAttempt | null; reason: TopicNextAttemptClearedReason } {
  const row = sqlite
    .prepare(
      `SELECT a.id, a.capture_id AS captureId, a.step, a.state,
              a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
              a.revision, a.created_at AS createdAt, a.updated_at AS updatedAt,
              c.raw_text AS captureText, c.archived_at AS captureArchivedAt
         FROM attempts a JOIN captures c ON c.id = a.capture_id
        WHERE a.id = ?`
    )
    .get(attemptId) as AttemptRow | undefined;
  if (!row) return { attempt: null, reason: 'attempt_deleted' };
  const membership = sqlite
    .prepare('SELECT member_kind AS memberKind FROM topic_members WHERE topic_id = ? AND capture_id = ?')
    .get(topicId, row.captureId) as { memberKind: string } | undefined;
  if (!membership || membership.memberKind !== 'thought') {
    return { attempt: null, reason: 'member_removed' };
  }
  if (row.state === 'cancelled') return { attempt: null, reason: 'attempt_cancelled' };
  const title = firstLine(row.captureText, 100);
  return {
    attempt: {
      id: row.id,
      attemptId: row.id,
      captureId: row.captureId,
      captureTitle: title,
      captureText: title,
      step: row.step,
      href: `/attempt/${row.id}`,
      state: row.state,
      resultText: row.resultText,
      outcome: row.outcome,
      observedAt: row.observedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      revision: row.revision,
      isCompleted: row.state === 'done',
      resultRecorded: row.state === 'done',
      captureArchived: row.captureArchivedAt !== null,
      captureArchivedAt: row.captureArchivedAt,
    },
    reason: null,
  };
}

function buildTopicSummary(topicId: string, clearInvalidNext: boolean): TopicSummary | null {
  let row = readTopicRow(topicId);
  if (!row) return null;
  const counts = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS memberCount,
         SUM(CASE WHEN member_kind = 'thought' THEN 1 ELSE 0 END) AS thoughtCount,
         SUM(CASE WHEN member_kind = 'experience' THEN 1 ELSE 0 END) AS experienceCount
       FROM topic_members WHERE topic_id = ?`
    )
    .get(topicId) as { memberCount: number; thoughtCount: number | null; experienceCount: number | null };
  const attemptStats = sqlite
    .prepare(
      `SELECT COUNT(*) AS attemptCount, MAX(COALESCE(a.observed_at, a.created_at)) AS latestAttemptAt
         FROM attempts a
         JOIN topic_members m ON m.capture_id = a.capture_id
        WHERE m.topic_id = ? AND m.member_kind = 'thought'`
    )
    .get(topicId) as { attemptCount: number; latestAttemptAt: number | null };
  let nextAttempt: TopicNextAttempt | null = null;
  let clearedReason: TopicNextAttemptClearedReason = asClearedReason(row.nextAttemptClearedReason);
  if (row.nextAttemptId) {
    const resolved = readNextAttempt(topicId, row.nextAttemptId);
    nextAttempt = resolved.attempt;
    clearedReason = resolved.reason;
    if (clearedReason && clearInvalidNext) {
      const t = now();
      sqlite
        .prepare(
          `UPDATE topics
              SET next_attempt_id = NULL, next_attempt_cleared_reason = ?,
                  revision = revision + 1, updated_at = ?
            WHERE id = ? AND next_attempt_id = ?`
        )
        .run(clearedReason, t, topicId, row.nextAttemptId);
      row = { ...row, nextAttemptId: null, nextAttemptClearedReason: clearedReason, revision: row.revision + 1, updatedAt: t };
    } else if (!clearedReason) {
      clearedReason = null;
    }
  }
  const thoughtCount = counts.thoughtCount ?? 0;
  const experienceCount = counts.experienceCount ?? 0;
  return {
    id: row.id,
    title: row.title,
    name: row.title,
    exploringQuestion: row.exploringQuestion,
    continueNote: row.continueNote,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    memberCount: counts.memberCount,
    thoughtCount,
    experienceCount,
    attemptCount: attemptStats.attemptCount,
    latestAttemptAt: attemptStats.latestAttemptAt,
    lastAttemptAt: attemptStats.latestAttemptAt,
    nextAttemptId: row.nextAttemptId,
    nextAttempt,
    nextAttemptClearedReason: clearedReason,
  };
}

// ---------------------------------------------------------------- 列表
export function listTopics(options: {
  archived?: unknown;
  q?: unknown;
  limit?: unknown;
  offset?: unknown;
  cursor?: unknown;
}): { topics: TopicListItem[]; total: number; limit: number; offset: number; hasMore: boolean; nextCursor: string | null } {
  const archived = parseArchivedFilter(options.archived);
  const limit = clampLimit(options.limit, TOPIC_LIST_DEFAULT_LIMIT, TOPIC_LIST_MAX_LIMIT);
  const decoded = decodeCursor(typeof options.cursor === 'string' ? options.cursor : null);
  const offset = decoded ?? clampOffset(options.offset);
  const q = typeof options.q === 'string' ? options.q.trim() : '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (archived === '0') where.push('archived_at IS NULL');
  if (archived === '1') where.push('archived_at IS NOT NULL');
  if (q) {
    where.push(
      "(title LIKE ? ESCAPE '\\' OR COALESCE(exploring_question,'') LIKE ? ESCAPE '\\' OR COALESCE(continue_note,'') LIKE ? ESCAPE '\\')"
    );
    const pattern = likePattern(q);
    params.push(pattern, pattern, pattern);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (sqlite.prepare(`SELECT COUNT(*) AS c FROM topics ${whereSql}`).get(...params) as { c: number }).c;
  const rows = sqlite
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics ${whereSql}
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as TopicRow[];
  const topics = rows
    .map((row) => buildTopicSummary(row.id, false))
    .filter((item): item is TopicSummary => Boolean(item));
  const hasMore = offset + topics.length < total;
  return {
    topics,
    total,
    limit,
    offset,
    hasMore,
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

// ---------------------------------------------------------------- 创建
export function createTopic(input: Record<string, unknown>): {
  status: number;
  body: { topic: TopicSummary; members: TopicMembers; memberList: TopicMember[]; replayed: boolean };
} {
  const title = parseTitle(input.title ?? input.name, input.title === undefined ? 'name' : 'title');
  const exploringQuestion = parseOptionalText(input.exploringQuestion, 'exploringQuestion');
  const continueNote = parseOptionalText(input.continueNote, 'continueNote');
  const captureIds = parseCaptureIds(input.captureIds, false);
  const operationId = parseOperationId(input.operationId, true)!;
  let nextAttemptId: string | null = null;
  if (input.nextAttemptId !== undefined && input.nextAttemptId !== null && input.nextAttemptId !== '') {
    if (typeof input.nextAttemptId !== 'string') {
      throw new TopicHttpError(400, { error: 'invalid_next_attempt', reason: 'attempt_not_found', message: '固定的尝试不正确。' });
    }
    nextAttemptId = input.nextAttemptId.trim() || null;
  }
  const fingerprint = sha256(
    JSON.stringify({
      op: 'topic_create',
      title,
      exploringQuestion,
      continueNote,
      captureIds,
      nextAttemptId,
    })
  );
  const existingReceipt = readReceipt(operationId);
  if (existingReceipt) {
    const payload = replayReceipt<{ topicId: string }>(existingReceipt, fingerprint, 'topic');
    const detail = buildTopicDetail(payload.topicId);
    if (!detail) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    return { status: 200, body: { ...detail, replayed: true } };
  }

  const captureRows = readCapturesByIds(captureIds);
  const missing = captureIds.filter((id) => !captureRows.has(id));
  if (missing.length > 0) {
    throw new TopicHttpError(400, {
      error: 'capture_not_found',
      captureIds: missing,
      message: '有记录已不存在，请刷新后重试。',
    });
  }
  if (nextAttemptId) validateNextAttemptInput(nextAttemptId, new Set(captureIds), captureRows);

  const topicId = newId('topic');
  const t = now();
  const created = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO topics
           (id, title, exploring_question, continue_note, next_attempt_id, next_attempt_cleared_reason,
            revision, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?)`
      )
      .run(topicId, title, exploringQuestion, continueNote, nextAttemptId, t, t);
    const insertMember = sqlite.prepare(
      `INSERT INTO topic_members (id, topic_id, capture_id, member_kind, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const captureId of captureIds) {
      const kind = asKind(captureRows.get(captureId)?.kind);
      insertMember.run(newId('tmem'), topicId, captureId, kind, t);
    }
    writeReceipt(operationId, 'topic', fingerprint, { topicId }, t);
    return true;
  })();
  void created;
  const detail = buildTopicDetail(topicId);
  if (!detail) throw new Error('topic insert failed');
  return { status: 201, body: { ...detail, replayed: false } };
}

function readCapturesByIds(ids: string[]): Map<string, { kind: string; rawText: string }> {
  const map = new Map<string, { kind: string; rawText: string }>();
  if (ids.length === 0) return map;
  const rows = sqlite
    .prepare(
      `SELECT id, kind, raw_text AS rawText FROM captures WHERE id IN (${placeholders(ids.length)})`
    )
    .all(...ids) as Array<{ id: string; kind: string; rawText: string }>;
  for (const row of rows) map.set(row.id, { kind: row.kind, rawText: row.rawText });
  return map;
}

function validateNextAttemptInput(
  attemptId: string,
  allowedCaptureIds: Set<string>,
  captureRows: Map<string, { kind: string }>
): void {
  const row = sqlite
    .prepare('SELECT id, state, capture_id AS captureId FROM attempts WHERE id = ?')
    .get(attemptId) as { id: string; state: string; captureId: string } | undefined;
  if (!row) {
    throw new TopicHttpError(400, {
      error: 'invalid_next_attempt',
      reason: 'attempt_not_found',
      message: '固定的尝试已不存在。',
    });
  }
  const captureKind = captureRows.get(row.captureId)?.kind;
  if (!allowedCaptureIds.has(row.captureId) || captureKind !== 'thought') {
    throw new TopicHttpError(400, {
      error: 'invalid_next_attempt',
      reason: 'not_thought_member',
      message: '只能固定本主题普通念头下的尝试。',
    });
  }
  if (row.state === 'cancelled') {
    throw new TopicHttpError(400, {
      error: 'invalid_next_attempt',
      reason: 'attempt_cancelled',
      message: '已放弃的尝试不能作为下一步。',
    });
  }
  if (row.state === 'done') {
    throw new TopicHttpError(400, {
      error: 'invalid_next_attempt',
      reason: 'attempt_completed',
      message: '已完成的尝试不能作为下一步。',
    });
  }
  if (row.state !== 'todo' && row.state !== 'in_progress') {
    throw new TopicHttpError(400, {
      error: 'invalid_next_attempt',
      reason: 'invalid_state',
      message: '这个尝试当前状态不能作为下一步。',
    });
  }
}

// ---------------------------------------------------------------- 详情
export function buildTopicDetail(topicId: string): TopicDetail | null {
  const topic = buildTopicSummary(topicId, true);
  if (!topic) return null;
  const members = readMemberSummary(topicId);
  const memberList = [...members.thoughts, ...members.experiences];
  return {
    topic: {
      ...topic,
      // 兼容前端 normalizeTopic：既有实现优先读取 topic.memberList / topic.members。
      memberList,
      members: memberList,
    } as TopicSummary,
    members,
    memberList,
    clearedReason: topic.nextAttemptClearedReason,
  };
}

export function getTopicDetail(topicId: string): TopicDetail {
  const detail = buildTopicDetail(topicId);
  if (!detail) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
  return detail;
}

// ---------------------------------------------------------------- 修订
export function updateTopic(topicId: string, input: Record<string, unknown>): {
  status: number;
  body: { topic: TopicSummary; replayed: boolean };
} {
  const expectedRevision = parseExpectedRevision(input.expectedRevision ?? input.revision)!;
  const operationId = parseOperationId(input.operationId, true)!;
  const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title') || Object.prototype.hasOwnProperty.call(input, 'name');
  const hasQuestion = Object.prototype.hasOwnProperty.call(input, 'exploringQuestion');
  const hasNote = Object.prototype.hasOwnProperty.call(input, 'continueNote');
  const title = hasTitle ? parseTitle(input.title ?? input.name, input.title === undefined ? 'name' : 'title') : null;
  const exploringQuestion = hasQuestion ? parseOptionalText(input.exploringQuestion, 'exploringQuestion') : null;
  const continueNote = hasNote ? parseOptionalText(input.continueNote, 'continueNote') : null;
  const fingerprint = sha256(
    JSON.stringify({
      op: 'topic_update',
      topicId,
      expectedRevision,
      hasTitle,
      title,
      hasQuestion,
      exploringQuestion,
      hasNote,
      continueNote,
    })
  );
  const existingReceipt = readReceipt(operationId);
  if (existingReceipt) {
    replayReceipt(existingReceipt, fingerprint, 'topic_update');
    const topic = buildTopicSummary(topicId, false);
    if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    return { status: 200, body: { topic, replayed: true } };
  }
  const t = now();
  const topic = sqlite.transaction(() => {
    const current = readTopicRow(topicId);
    if (!current) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    if (current.revision !== expectedRevision) {
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: current.revision,
        currentTopic: buildTopicSummary(topicId, false),
      });
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (hasTitle) {
      sets.push('title = ?');
      values.push(title);
    }
    if (hasQuestion) {
      sets.push('exploring_question = ?');
      values.push(exploringQuestion);
    }
    if (hasNote) {
      sets.push('continue_note = ?');
      values.push(continueNote);
    }
    sets.push('revision = revision + 1', 'updated_at = ?');
    values.push(t);
    values.push(topicId, expectedRevision);
    const result = sqlite
      .prepare(`UPDATE topics SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
      .run(...values);
    if (result.changes !== 1) {
      const raced = readTopicRow(topicId);
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: raced?.revision ?? null,
        currentTopic: raced ? buildTopicSummary(topicId, false) : null,
      });
    }
    writeReceipt(operationId, 'topic_update', fingerprint, { topicId }, t);
    return buildTopicSummary(topicId, false)!;
  })();
  return { status: 200, body: { topic, replayed: false } };
}

export function setTopicArchived(topicId: string, archive: boolean, input: Record<string, unknown>): {
  status: number;
  body: { topic: TopicSummary; replayed: boolean };
} {
  const expectedRevision = parseExpectedRevision(input.expectedRevision ?? input.revision, false);
  const operationId = parseOperationId(input.operationId, false);
  const targetType = archive ? 'topic_archive' : 'topic_restore';
  const fingerprint = sha256(
    JSON.stringify({ op: targetType, topicId, expectedRevision: expectedRevision ?? 'auto' })
  );
  if (operationId) {
    const receipt = readReceipt(operationId);
    if (receipt) {
      replayReceipt(receipt, fingerprint, targetType);
      const topic = buildTopicSummary(topicId, false);
      if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
      return { status: 200, body: { topic, replayed: true } };
    }
  }
  const t = now();
  const topic = sqlite.transaction(() => {
    const current = readTopicRow(topicId);
    if (!current) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    const revision = expectedRevision ?? current.revision;
    if (current.revision !== revision) {
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: current.revision,
        currentTopic: buildTopicSummary(topicId, false),
      });
    }
    const result = archive
      ? sqlite
          .prepare(
            `UPDATE topics SET archived_at = COALESCE(archived_at, ?), revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`
          )
          .run(t, t, topicId, revision)
      : sqlite
          .prepare(
            `UPDATE topics SET archived_at = NULL, revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`
          )
          .run(t, topicId, revision);
    if (result.changes !== 1) {
      const raced = readTopicRow(topicId);
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: raced?.revision ?? null,
        currentTopic: raced ? buildTopicSummary(topicId, false) : null,
      });
    }
    if (operationId) writeReceipt(operationId, targetType, fingerprint, { topicId }, t);
    return buildTopicSummary(topicId, false)!;
  })();
  return { status: 200, body: { topic, replayed: false } };
}

// ---------------------------------------------------------------- 删除预览 / 删除
export function topicDeletePreview(topicId: string): Record<string, unknown> {
  const topic = buildTopicSummary(topicId, false);
  if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
  const members = readMemberRows(topicId);
  const thoughtIds = members.filter((row) => row.memberKind === 'thought').map((row) => row.captureId);
  const experienceIds = members.filter((row) => row.memberKind === 'experience').map((row) => row.captureId);
  let attemptCount = 0;
  let scheduleCount = 0;
  if (thoughtIds.length > 0) {
    const stats = sqlite
      .prepare(
        `SELECT COUNT(*) AS attempts,
                (SELECT COUNT(*) FROM schedule_blocks s
                  WHERE s.attempt_id IN (SELECT id FROM attempts WHERE capture_id IN (${placeholders(
                    thoughtIds.length
                  )}))) AS schedules
           FROM attempts WHERE capture_id IN (${placeholders(thoughtIds.length)})`
      )
      .get(...thoughtIds, ...thoughtIds) as { attempts: number; schedules: number };
    attemptCount = stats.attempts;
    scheduleCount = stats.schedules;
  }
  let experienceSourceCount = 0;
  if (experienceIds.length > 0) {
    experienceSourceCount = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM experience_sources
            WHERE deleted = 0 AND experience_id IN (${placeholders(experienceIds.length)})`
        )
        .get(...experienceIds) as { c: number }
    ).c;
  }
  return {
    topic,
    memberCount: topic.memberCount,
    thoughtCount: topic.thoughtCount,
    experienceCount: topic.experienceCount,
    fixedAttemptId: topic.nextAttemptId,
    preserved: {
      captures: topic.memberCount,
      attempts: attemptCount,
      schedules: scheduleCount,
      experienceSources: experienceSourceCount,
    },
    willDelete: { topic: 1, topicMembers: topic.memberCount },
    note: '删除主题只会移除主题与成员关系，不会删除念头、经验、尝试、日程或依据记录。',
  };
}

export function deleteTopic(topicId: string): { ok: true; deletedTopicId: string; deletedMembers: number } {
  return sqlite.transaction(() => {
    const row = readTopicRow(topicId);
    if (!row) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    const memberCount = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM topic_members WHERE topic_id = ?').get(topicId) as { c: number }
    ).c;
    sqlite.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
    return { ok: true as const, deletedTopicId: topicId, deletedMembers: memberCount };
  })();
}

// ---------------------------------------------------------------- 成员候选 / 成员操作
export function listMemberCandidates(
  topicId: string,
  options: { q?: unknown; type?: unknown; limit?: unknown; offset?: unknown; cursor?: unknown }
): {
  query: string;
  type: string;
  total: number;
  limit: number;
  nextCursor: string | null;
  candidates: TopicMemberCandidate[];
} {
  const topic = readTopicRow(topicId);
  if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
  const q = typeof options.q === 'string' ? options.q.trim() : '';
  if (q.length > MAX_TOPIC_QUERY_CHARS) throw new TopicHttpError(400, { error: 'query_too_long', message: '搜索词不能超过 120 个字符。' });
  const typeRaw = typeof options.type === 'string' ? options.type : 'all';
  if (typeRaw !== 'all' && typeRaw !== 'thought' && typeRaw !== 'experience') {
    throw new TopicHttpError(400, { error: 'invalid_type', field: 'type', message: 'type 只能是 thought、experience 或 all。' });
  }
  const limit = clampLimit(options.limit, TOPIC_CANDIDATE_DEFAULT_LIMIT, TOPIC_CANDIDATE_MAX_LIMIT);
  const decoded = decodeCursor(typeof options.cursor === 'string' ? options.cursor : null);
  const offset = decoded ?? clampOffset(options.offset);
  const where: string[] = ['c.id NOT IN (SELECT capture_id FROM topic_members WHERE topic_id = ?)'];
  const params: unknown[] = [topicId];
  if (typeRaw === 'thought' || typeRaw === 'experience') {
    where.push('c.kind = ?');
    params.push(typeRaw);
  } else {
    where.push("c.kind IN ('thought','experience')");
  }
  if (q) {
    where.push(
      "(c.raw_text LIKE ? ESCAPE '\\' OR COALESCE((SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id), '') LIKE ? ESCAPE '\\')"
    );
    const pattern = likePattern(q);
    params.push(pattern, pattern);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (
    sqlite.prepare(`SELECT COUNT(*) AS c FROM captures c ${whereSql}`).get(...params) as { c: number }
  ).c;
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.raw_text AS rawText, c.kind, c.created_at AS createdAt,
              c.updated_at AS updatedAt, c.archived_at AS archivedAt,
              (SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id) AS experienceTitle,
              (SELECT n.needs_revision FROM experience_notes n WHERE n.capture_id = c.id) AS needsRevision
         FROM captures c
         ${whereSql}
        ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Array<{
    id: string;
    rawText: string;
    kind: string;
    createdAt: number;
    updatedAt: number;
    archivedAt: number | null;
    experienceTitle: string | null;
    needsRevision: number | null;
  }>;
  const candidates: TopicMemberCandidate[] = rows.map((row) => {
    const kind = asKind(row.kind);
    const isExperience = kind === 'experience';
    const sourceCount = isExperience
      ? (
          sqlite
            .prepare('SELECT COUNT(*) AS c FROM experience_sources WHERE experience_id = ? AND deleted = 0')
            .get(row.id) as { c: number }
        ).c
      : undefined;
    const hasPracticeResult = isExperience
      ? Boolean(
          (
            sqlite
              .prepare(
                `SELECT 1 AS ok FROM experience_sources
                  WHERE experience_id = ? AND deleted = 0
                    AND source_result_text IS NOT NULL AND TRIM(source_result_text) <> ''
                  LIMIT 1`
              )
              .get(row.id) as { ok: number } | undefined
          )?.ok
        )
      : undefined;
    const href = isExperience ? `/experience/${row.id}` : `/capture/${row.id}`;
    return {
      captureId: row.id,
      kind,
      type: kind,
      title: isExperience ? row.experienceTitle ?? firstLine(row.rawText, 80) : firstLine(row.rawText, 80),
      summary: firstLine(row.rawText, 160),
      archived: row.archivedAt !== null,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      alreadyMember: false,
      openHref: href,
      ...(isExperience
        ? {
            sourceCount: sourceCount ?? 0,
            hasPracticeResult: hasPracticeResult ?? false,
            needsRevision: Boolean(row.needsRevision),
          }
        : {}),
    };
  });
  const hasMore = offset + candidates.length < total;
  return {
    query: q,
    type: typeRaw,
    total,
    limit,
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    candidates,
  };
}

export function addTopicMembers(topicId: string, input: Record<string, unknown>): {
  status: number;
  body: {
    members: TopicMember[];
    added: number;
    existing: number;
    addedCaptureIds: string[];
    existingCaptureIds: string[];
    skipped: number;
    addedIds: string[];
    skippedIds: string[];
    replayed: boolean;
    topic: TopicSummary;
  };
} {
  const captureIds = parseCaptureIds(input.captureIds, true);
  const operationId = parseOperationId(input.operationId, true)!;
  const fingerprint = sha256(JSON.stringify({ op: 'topic_members', topicId, captureIds }));
  const receipt = readReceipt(operationId);
  if (receipt) {
    const payload = replayReceipt<{ topicId: string; addedIds?: string[]; skippedIds?: string[] }>(
      receipt,
      fingerprint,
      'topic_members'
    );
    const detail = buildTopicDetail(payload.topicId);
    if (!detail) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    const addedIds = payload.addedIds ?? [];
    const skippedIds = payload.skippedIds ?? [];
    return {
      status: 200,
      body: {
        members: detail.memberList,
        added: addedIds.length,
        existing: skippedIds.length,
        addedCaptureIds: addedIds,
        existingCaptureIds: skippedIds,
        skipped: skippedIds.length,
        addedIds,
        skippedIds,
        replayed: true,
        topic: detail.topic,
      },
    };
  }
  const t = now();
  const outcome = sqlite.transaction(() => {
    const topic = readTopicRow(topicId);
    if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    const captureRows = readCapturesByIds(captureIds);
    const missing = captureIds.filter((id) => !captureRows.has(id));
    if (missing.length > 0) {
      throw new TopicHttpError(400, {
        error: 'capture_not_found',
        captureIds: missing,
        message: '有记录已不存在，请刷新后重试。',
      });
    }
    const existingRows = sqlite
      .prepare('SELECT capture_id AS captureId FROM topic_members WHERE topic_id = ?')
      .all(topicId) as Array<{ captureId: string }>;
    const existingSet = new Set(existingRows.map((row) => row.captureId));
    const addedIds: string[] = [];
    const skippedIds: string[] = [];
    const insert = sqlite.prepare(
      `INSERT INTO topic_members (id, topic_id, capture_id, member_kind, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const captureId of captureIds) {
      if (existingSet.has(captureId)) {
        skippedIds.push(captureId);
        continue;
      }
      insert.run(newId('tmem'), topicId, captureId, asKind(captureRows.get(captureId)?.kind), t);
      addedIds.push(captureId);
    }
    sqlite
      .prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(t, topicId);
    writeReceipt(operationId, 'topic_members', fingerprint, { topicId, addedIds, skippedIds }, t);
    const detail = buildTopicDetail(topicId)!;
    return {
      members: detail.memberList,
      added: addedIds.length,
      existing: skippedIds.length,
      addedCaptureIds: addedIds,
      existingCaptureIds: skippedIds,
      skipped: skippedIds.length,
      addedIds,
      skippedIds,
      replayed: false,
      topic: detail.topic,
    };
  })();
  return { status: 200, body: outcome };
}

export function removeTopicMember(topicId: string, captureId: string): {
  ok: true;
  removed: true;
  captureId: string;
  clearedNext: boolean;
  clearedNextAttempt: boolean;
  topic: TopicSummary;
} {
  const t = now();
  return sqlite.transaction(() => {
    const topic = readTopicRow(topicId);
    if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    const member = sqlite
      .prepare('SELECT id FROM topic_members WHERE topic_id = ? AND capture_id = ?')
      .get(topicId, captureId) as { id: string } | undefined;
    if (!member) throw new TopicHttpError(404, { error: 'member_not_found', message: '这条记录不在主题里。' });
    sqlite.prepare('DELETE FROM topic_members WHERE id = ?').run(member.id);
    let clearedNext = false;
    if (topic.nextAttemptId) {
      const attempt = sqlite
        .prepare('SELECT capture_id AS captureId FROM attempts WHERE id = ?')
        .get(topic.nextAttemptId) as { captureId: string } | undefined;
      if (attempt?.captureId === captureId) {
        sqlite
          .prepare('UPDATE topics SET next_attempt_id = NULL, next_attempt_cleared_reason = ? WHERE id = ?')
          .run('member_removed', topicId);
        clearedNext = true;
      }
    }
    sqlite
      .prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(t, topicId);
    return {
      ok: true as const,
      removed: true as const,
      captureId,
      clearedNext,
      clearedNextAttempt: clearedNext,
      topic: buildTopicSummary(topicId, false)!,
    };
  })();
}

// ---------------------------------------------------------------- 尝试聚合
export function listTopicAttempts(
  topicId: string,
  options: { limit?: unknown; offset?: unknown; cursor?: unknown; state?: unknown }
): {
  attempts: TopicAttemptItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
} {
  const topic = readTopicRow(topicId);
  if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
  const state = parseAttemptStateFilter(options.state);
  const limit = clampLimit(options.limit, TOPIC_ATTEMPT_DEFAULT_LIMIT, TOPIC_ATTEMPT_MAX_LIMIT);
  const decoded = decodeCursor(typeof options.cursor === 'string' ? options.cursor : null);
  const offset = decoded ?? clampOffset(options.offset);
  const conditions = [
    'm.topic_id = ?',
    "m.member_kind = 'thought'",
  ];
  const params: unknown[] = [topicId];
  if (state === 'recorded') {
    conditions.push("a.state <> 'cancelled'", "a.result_text IS NOT NULL AND TRIM(a.result_text) <> ''");
  } else if (state === 'pending') {
    conditions.push("a.state <> 'cancelled'", "(a.result_text IS NULL OR TRIM(a.result_text) = '')");
  } else if (state === 'cancelled') {
    conditions.push("a.state = 'cancelled'");
  }
  const whereSql = conditions.join(' AND ');
  const total = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM attempts a
           JOIN topic_members m ON m.capture_id = a.capture_id
          WHERE ${whereSql}`
      )
      .get(...params) as { c: number }
  ).c;
  const rows = sqlite
    .prepare(
      `SELECT a.id, a.capture_id AS captureId, c.raw_text AS captureText, a.step, a.state,
              a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
              a.created_at AS createdAt, a.updated_at AS updatedAt, a.revision,
              c.archived_at AS captureArchivedAt
         FROM attempts a
         JOIN topic_members m ON m.capture_id = a.capture_id
         JOIN captures c ON c.id = a.capture_id
        WHERE ${whereSql}
        ORDER BY COALESCE(a.observed_at, a.created_at) DESC, a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Array<{
    id: string;
    captureId: string;
    captureText: string;
    step: string;
    state: string;
    resultText: string | null;
    outcome: string | null;
    observedAt: number | null;
    createdAt: number;
    updatedAt: number;
    revision: number;
    captureArchivedAt: number | null;
  }>;
  const attempts: TopicAttemptItem[] = rows.map((row) => ({
    id: row.id,
    captureId: row.captureId,
    captureTitle: firstLine(row.captureText, 100),
    captureText: row.captureText,
    captureArchived: row.captureArchivedAt !== null,
    captureArchivedAt: row.captureArchivedAt,
    step: row.step,
    state: row.state,
    resultText: row.resultText,
    outcome: row.outcome,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    href: `/attempt/${row.id}`,
    resultState: resultStateOf(row.state, row.resultText),
  }));
  const hasMore = offset + attempts.length < total;
  return {
    attempts,
    total,
    limit,
    offset,
    hasMore,
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

function resultStateOf(state: string, resultText: string | null): TopicResultState {
  if (state === 'cancelled') return 'cancelled';
  if (resultText && resultText.trim()) return 'recorded';
  return 'pending_no_result';
}

// ---------------------------------------------------------------- 固定下一步
export function setTopicNextAttempt(topicId: string, input: Record<string, unknown>): {
  status: number;
  body: { topic: TopicSummary; clearedReason: TopicNextAttemptClearedReason; replayed: boolean };
} {
  let attemptId: string | null = null;
  if (input.attemptId !== undefined && input.attemptId !== null && input.attemptId !== '') {
    if (typeof input.attemptId !== 'string') {
      throw new TopicHttpError(400, { error: 'invalid_next_attempt', reason: 'attempt_not_found', message: '固定的尝试不正确。' });
    }
    attemptId = input.attemptId.trim() || null;
  }
  const expectedRevision = parseExpectedRevision(input.expectedRevision ?? input.revision)!;
  const operationId = parseOperationId(input.operationId, true)!;
  const fingerprint = sha256(
    JSON.stringify({ op: 'topic_next_attempt', topicId, attemptId, expectedRevision })
  );
  const receipt = readReceipt(operationId);
  if (receipt) {
    replayReceipt(receipt, fingerprint, 'topic_next_attempt');
    const topic = buildTopicSummary(topicId, false);
    if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    return { status: 200, body: { topic, clearedReason: null, replayed: true } };
  }
  const t = now();
  const outcome = sqlite.transaction(() => {
    const topic = readTopicRow(topicId);
    if (!topic) throw new TopicHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
    if (topic.revision !== expectedRevision) {
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: topic.revision,
        currentTopic: buildTopicSummary(topicId, false),
      });
    }
    let clearedReason: TopicNextAttemptClearedReason = null;
    if (topic.nextAttemptId) {
      clearedReason = readNextAttempt(topicId, topic.nextAttemptId).reason;
    }
    let nextAttemptId: string | null = null;
    if (attemptId) {
      const row = sqlite
        .prepare(
          `SELECT a.id, a.state, a.capture_id AS captureId, m.member_kind AS memberKind
             FROM attempts a
             LEFT JOIN topic_members m ON m.capture_id = a.capture_id AND m.topic_id = ?
            WHERE a.id = ?`
        )
        .get(topicId, attemptId) as
        | { id: string; state: string; captureId: string; memberKind: string | null }
        | undefined;
      if (!row) {
        throw new TopicHttpError(400, {
          error: 'invalid_next_attempt',
          reason: 'attempt_not_found',
          message: '固定的尝试已不存在。',
        });
      }
      if (row.memberKind !== 'thought') {
        throw new TopicHttpError(400, {
          error: 'invalid_next_attempt',
          reason: 'not_thought_member',
          message: '只能固定本主题普通念头下的尝试。',
        });
      }
      if (row.state === 'cancelled') {
        throw new TopicHttpError(400, {
          error: 'invalid_next_attempt',
          reason: 'attempt_cancelled',
          message: '已放弃的尝试不能作为下一步。',
        });
      }
      if (row.state === 'done') {
        throw new TopicHttpError(400, {
          error: 'invalid_next_attempt',
          reason: 'attempt_completed',
          message: '已完成的尝试不能作为下一步。',
        });
      }
      if (row.state !== 'todo' && row.state !== 'in_progress') {
        throw new TopicHttpError(400, {
          error: 'invalid_next_attempt',
          reason: 'invalid_state',
          message: '这个尝试当前状态不能作为下一步。',
        });
      }
      nextAttemptId = row.id;
    }
    const result = sqlite
      .prepare(
        `UPDATE topics SET next_attempt_id = ?, next_attempt_cleared_reason = NULL,
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`
      )
      .run(nextAttemptId, t, topicId, expectedRevision);
    if (result.changes !== 1) {
      const raced = readTopicRow(topicId);
      throw new TopicHttpError(409, {
        error: 'revision_conflict',
        message: '主题已在别处修改，请刷新后重试。',
        currentRevision: raced?.revision ?? null,
        currentTopic: raced ? buildTopicSummary(topicId, false) : null,
      });
    }
    writeReceipt(operationId, 'topic_next_attempt', fingerprint, { topicId }, t);
    return { topic: buildTopicSummary(topicId, false)!, clearedReason };
  })();
  return { status: 200, body: { ...outcome, replayed: false } };
}

// ---------------------------------------------------------------- 记录详情中的主题
export function listTopicsForCapture(captureId: string): Record<string, unknown> {
  const capture = sqlite.prepare('SELECT id FROM captures WHERE id = ?').get(captureId) as { id: string } | undefined;
  if (!capture) throw new TopicHttpError(404, { error: 'capture_not_found', message: '这条记录已不存在。' });
  const rows = sqlite
    .prepare(
      `SELECT t.id, m.member_kind AS memberKind, m.created_at AS memberCreatedAt
         FROM topics t JOIN topic_members m ON m.topic_id = t.id
        WHERE m.capture_id = ?
        ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC`
    )
    .all(captureId) as Array<{ id: string; memberKind: string; memberCreatedAt: number }>;
  return {
    captureId,
    topics: rows
      .map((row) => {
        const topic = buildTopicSummary(row.id, false);
        if (!topic) return null;
        return {
          ...topic,
          memberKind: asKind(row.memberKind),
          memberCreatedAt: row.memberCreatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
  };
}

export function addCaptureToTopics(captureId: string, input: Record<string, unknown>): {
  status: number;
  body: {
    topics: Array<{ topicId: string; title: string; name: string; added: boolean }>;
    added: number;
    existing: number;
    replayed: boolean;
  };
} {
  const topicIds = parseTopicIds(input.topicIds);
  const operationId = parseOperationId(input.operationId, true)!;
  const fingerprint = sha256(JSON.stringify({ op: 'capture_topics', captureId, topicIds }));
  const receipt = readReceipt(operationId);
  if (receipt) {
    const payload = replayReceipt<{ captureId: string; topicIds: string[]; addedTopicIds?: string[] }>(
      receipt,
      fingerprint,
      'capture_topics'
    );
    const addedTopicIds = new Set(payload.addedTopicIds ?? []);
    return {
      status: 200,
      body: {
        topics: payload.topicIds.map((topicId) => {
          const row = readTopicRow(topicId);
          return {
            topicId,
            title: row?.title ?? '',
            name: row?.title ?? '',
            added: addedTopicIds.has(topicId),
          };
        }),
        added: addedTopicIds.size,
        existing: payload.topicIds.length - addedTopicIds.size,
        replayed: true,
      },
    };
  }
  const capture = sqlite
    .prepare('SELECT id, kind FROM captures WHERE id = ?')
    .get(captureId) as { id: string; kind: string } | undefined;
  if (!capture) throw new TopicHttpError(404, { error: 'capture_not_found', message: '这条记录已不存在。' });
  const t = now();
  const outcome = sqlite.transaction(() => {
    const missing = topicIds.filter((topicId) => !readTopicRow(topicId));
    if (missing.length > 0) {
      throw new TopicHttpError(404, {
        error: 'topic_not_found',
        topicIds: missing,
        message: '有主题已不存在，请刷新后重试。',
      });
    }
    const insert = sqlite.prepare(
      `INSERT INTO topic_members (id, topic_id, capture_id, member_kind, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const topics: Array<{ topicId: string; title: string; name: string; added: boolean }> = [];
    const addedTopicIds: string[] = [];
    let added = 0;
    let existing = 0;
    for (const topicId of topicIds) {
      const row = readTopicRow(topicId)!;
      const has = sqlite
        .prepare('SELECT id FROM topic_members WHERE topic_id = ? AND capture_id = ?')
        .get(topicId, captureId) as { id: string } | undefined;
      if (has) {
        existing += 1;
        topics.push({ topicId, title: row.title, name: row.title, added: false });
        continue;
      }
      insert.run(newId('tmem'), topicId, captureId, asKind(capture.kind), t);
      sqlite.prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?').run(t, topicId);
      added += 1;
      addedTopicIds.push(topicId);
      topics.push({ topicId, title: row.title, name: row.title, added: true });
    }
    writeReceipt(operationId, 'capture_topics', fingerprint, { captureId, topicIds, addedTopicIds }, t);
    return { topics, added, existing, replayed: false };
  })();
  return { status: 200, body: outcome };
}

// ---------------------------------------------------------------- 删除清理（由 index.ts 的删除事务调用）
export function cleanupTopicsForDeletedCapture(captureId: string): {
  deletedTopicMembers: number;
  clearedTopicNext: number;
} {
  const t = now();
  const memberTopics = sqlite
    .prepare('SELECT DISTINCT topic_id AS topicId FROM topic_members WHERE capture_id = ?')
    .all(captureId) as Array<{ topicId: string }>;
  const nextTopics = sqlite
    .prepare(
      `SELECT DISTINCT t.id AS topicId FROM topics t
         JOIN attempts a ON a.id = t.next_attempt_id
        WHERE a.capture_id = ?`
    )
    .all(captureId) as Array<{ topicId: string }>;
  const deleted = sqlite.prepare('DELETE FROM topic_members WHERE capture_id = ?').run(captureId).changes;
  const cleared = sqlite
    .prepare(
      `UPDATE topics SET next_attempt_id = NULL, next_attempt_cleared_reason = 'member_removed',
              revision = revision + 1, updated_at = ?
        WHERE next_attempt_id IN (SELECT id FROM attempts WHERE capture_id = ?)`
    )
    .run(t, captureId).changes;
  const bumped = new Set(nextTopics.map((row) => row.topicId));
  for (const row of memberTopics) {
    if (bumped.has(row.topicId)) continue;
    sqlite.prepare('UPDATE topics SET revision = revision + 1, updated_at = ? WHERE id = ?').run(t, row.topicId);
  }
  return { deletedTopicMembers: deleted, clearedTopicNext: cleared };
}

/** 删除/取消 attempt 前显式清空固定引用；返回取消固定的主题数。 */
export function clearTopicNextForAttempt(
  attemptId: string,
  reason: TopicNextAttemptClearedReason = 'attempt_deleted'
): number {
  const t = now();
  return sqlite
    .prepare(
      `UPDATE topics SET next_attempt_id = NULL, next_attempt_cleared_reason = ?,
              revision = revision + 1, updated_at = ?
        WHERE next_attempt_id = ?`
    )
    .run(reason, t, attemptId).changes;
}

// ---------------------------------------------------------------- 主题问答范围
export function buildTopicAskScope(topicId: string): TopicScope | null {
  const topic = readTopicRow(topicId);
  if (!topic) return null;
  const thoughtRows = sqlite
    .prepare(
      `SELECT m.capture_id AS captureId FROM topic_members m
         JOIN captures c ON c.id = m.capture_id
        WHERE m.topic_id = ? AND m.member_kind = 'thought'
        ORDER BY m.capture_id ASC`
    )
    .all(topicId) as Array<{ captureId: string }>;
  const experienceRows = sqlite
    .prepare(
      `SELECT m.capture_id AS captureId FROM topic_members m
         JOIN captures c ON c.id = m.capture_id
        WHERE m.topic_id = ? AND m.member_kind = 'experience'
        ORDER BY m.capture_id ASC`
    )
    .all(topicId) as Array<{ captureId: string }>;
  const thoughtCaptureIds = thoughtRows.map((row) => row.captureId);
  const experienceIds = experienceRows.map((row) => row.captureId);
  const thoughtAttemptIds = thoughtCaptureIds.length
    ? (
        sqlite
          .prepare(
            `SELECT id FROM attempts WHERE capture_id IN (${placeholders(thoughtCaptureIds.length)})
              ORDER BY id ASC`
          )
          .all(...thoughtCaptureIds) as Array<{ id: string }>
      ).map((row) => row.id)
    : [];
  const allowed = new Set<string>();
  for (const id of thoughtCaptureIds) allowed.add(`capture:${id}`);
  for (const id of thoughtAttemptIds) allowed.add(`attempt:${id}`);

  const experienceSourceKeys = new Set<string>();
  if (experienceIds.length > 0) {
    const sourceRows = sqlite
      .prepare(
        `SELECT source_type AS sourceType, source_id AS sourceId
           FROM experience_sources
          WHERE deleted = 0 AND experience_id IN (${placeholders(experienceIds.length)})
          ORDER BY source_key ASC`
      )
      .all(...experienceIds) as Array<{ sourceType: string; sourceId: string }>;
    for (const source of sourceRows) {
      if (source.sourceType === 'attempt') {
        const current = sqlite
          .prepare(
            `SELECT a.id, c.kind FROM attempts a JOIN captures c ON c.id = a.capture_id WHERE a.id = ?`
          )
          .get(source.sourceId) as { id: string; kind: string } | undefined;
        if (current && current.kind !== 'experience') {
          experienceSourceKeys.add(`attempt:${source.sourceId}`);
          allowed.add(`attempt:${source.sourceId}`);
        }
      } else if (source.sourceType === 'capture') {
        const current = sqlite
          .prepare('SELECT id, kind FROM captures WHERE id = ?')
          .get(source.sourceId) as { id: string; kind: string } | undefined;
        if (current && current.kind !== 'experience') {
          experienceSourceKeys.add(`capture:${source.sourceId}`);
          allowed.add(`capture:${source.sourceId}`);
        }
      }
    }
  }

  const allowedSourceKeys = [...allowed].sort();
  const experienceSourceList = [...experienceSourceKeys].sort();
  const scopeHash = sha256(
    JSON.stringify({
      topicId,
      topicRevision: topic.revision,
      thoughtCaptureIds: [...thoughtCaptureIds].sort(),
      thoughtAttemptIds: [...thoughtAttemptIds].sort(),
      experienceIds: [...experienceIds].sort(),
      experienceSourceKeys: experienceSourceList,
    })
  );
  return {
    topicId,
    topicTitle: topic.title,
    topicName: topic.title,
    scopeHash,
    topicRevision: topic.revision,
    thoughtCount: thoughtCaptureIds.length,
    experienceCount: experienceIds.length,
    attemptCount: thoughtAttemptIds.length,
    allowedSourceCount: allowedSourceKeys.length,
    recordCount: allowedSourceKeys.length,
    thoughtCaptureIds,
    thoughtAttemptIds,
    experienceIds,
    experienceSourceKeys: experienceSourceList,
    allowedSourceKeys,
  };
}

export function topicScopeSummary(scope: TopicScope): TopicScopeSummary {
  return {
    topicId: scope.topicId,
    topicTitle: scope.topicTitle,
    topicName: scope.topicName,
    scopeHash: scope.scopeHash,
    topicRevision: scope.topicRevision,
    thoughtCount: scope.thoughtCount,
    experienceCount: scope.experienceCount,
    attemptCount: scope.attemptCount,
    allowedSourceCount: scope.allowedSourceCount,
    recordCount: scope.recordCount,
  };
}

export function searchTopicAskCandidates(
  topicId: string,
  input: {
    question: string;
    keywords: string[];
    expandedTerms?: string[];
    range: AskRange;
    limit: number;
  }
): { scope: TopicScope; total: number; candidates: ReturnType<typeof searchAskCandidates>['candidates'] } | null {
  const scope = buildTopicAskScope(topicId);
  if (!scope) return null;
  const scoped: AskSearchScope = {
    captureIds: scope.thoughtCaptureIds,
    attemptIds: scope.thoughtAttemptIds,
    directOnly: true,
  };
  const search = searchAskCandidates({ ...input, scope: scoped });
  return { scope, total: search.total, candidates: search.candidates };
}

export function listTopicAskExperiences(topicId: string): {
  topic: { id: string; name: string };
  experiences: TopicAskExperience[];
} | null {
  const scope = buildTopicAskScope(topicId);
  if (!scope) return null;
  const experiences: TopicAskExperience[] = [];
  for (const experienceId of scope.experienceIds) {
    const exp = buildExperiencePublic(experienceId);
    if (!exp) continue;
    const sources = exp.sources.filter(
      (source) =>
        !source.deleted &&
        source.exists &&
        (source.kind === 'attempt' || source.kind === 'thought') &&
        scope.allowedSourceKeys.includes(source.sourceKey)
    );
    experiences.push({
      id: exp.id,
      title: exp.title,
      summary: firstLine(exp.understanding, 160),
      needsRevision: exp.needsRevision,
      hasPracticeResult: sources.some((source) => Boolean(source.resultText && source.resultText.trim())),
      sourceCount: sources.length,
      derivationBy: exp.derivation.by,
      sources,
      selectableSourceKeys: sources.map((source) => source.sourceKey),
    });
  }
  return {
    topic: { id: scope.topicId, name: scope.topicName },
    experiences,
  };
}

// 语义常量：成员候选 q 的上限（与契约一致）。
export const TOPIC_QUERY_MAX_CHARS = MAX_TOPIC_QUERY_CHARS;
