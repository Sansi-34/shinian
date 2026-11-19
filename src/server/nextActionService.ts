// 拾念 SHINIAN · 「回顾后的下一步行动」服务层
// 契约：docs/next-action-api-contract.md
//
// 下一步行动复用 attempts（origin='review_next_action'）：
// - 来源关系写 attempt_references（当前存在的来源 Attempt）；
// - 可选日程写 schedule_blocks；
// - 创建/更新回执写 mutation_receipts（target_type='next_action' / 'next_action_update'）。
// 所有写路径由 sqlite.transaction 包裹；先完成校验再写入，失败整体回滚。

import { createHash } from 'node:crypto';
import { sqlite } from '../db/db';
import type { StageReview } from '../db/schema';
import {
  ScheduleHttpError,
  listConflictingActive,
  listSchedulesForAttempt,
  parseScheduleInput,
  type ScheduleBlock,
} from './scheduleService';
import { publicReviewOf } from './reviewData';
import type { ReviewContent, ReviewItem } from './reviewTypes';

const DAY_MS = 86_400_000;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ESTIMATED_MINUTES = 1440;

export type NextActionState = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type NextActionOutcome = 'success' | 'failure' | 'undetermined';

export type NextActionSourcePublic = {
  key: string;
  type: string;
  sourceId: string;
  attemptId: string | null;
  captureId: string | null;
  title: string | null;
  text: string | null;
  resultText: string | null;
  state: string | null;
  revision: number | null;
  currentRevision: number | null;
  changed: boolean;
  deleted: boolean;
};

export type NextAction = {
  id: string;
  captureId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  state: NextActionState;
  resultText: string | null;
  outcome: NextActionOutcome | null;
  observedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin: 'review_next_action';
  sourceReviewId: string;
  sourceExperienceIndex: number;
  sourceAttemptId: string | null;
  sourceAttemptRevision: number | null;
  capture: { id: string; rawText: string; revision: number; archivedAt: number | null } | null;
  sourceReview: {
    id: string;
    savedAt: number | null;
    range: unknown;
    contentInvalidated: boolean;
    sourcesChanged: boolean;
  } | null;
  experience: { text: string; basis: string; sourceIds: string[] } | null;
  sources: NextActionSourcePublic[];
  schedules: ScheduleBlock[];
  canEdit: boolean;
  /** 部分来源已删除时为 true（只引用仍存在的来源）。 */
  deleted: boolean;
};

export type PreviewSourceAttempt = {
  attemptId: string;
  captureId: string | null;
  step: string | null;
  state: string | null;
  resultText: string | null;
  outcome: string | null;
  revision: number | null;
  captureRevision: number | null;
  captureText: string | null;
  exists: boolean;
  changed: boolean;
  deleted: boolean;
};

export type NextActionPreview = {
  review: {
    id: string;
    savedAt: number;
    range: unknown;
    contentInvalidated: boolean;
    sourcesChanged: boolean;
  };
  experienceIndex: number;
  experience: { text: string; basis: string; sourceIds: string[] };
  sourceAttempts: PreviewSourceAttempt[];
  captures: Array<{ id: string; rawText: string; revision: number; archivedAt: number | null }>;
  defaults: {
    captureId: string;
    title: string;
    description: string;
    estimatedMinutes: number;
    suggestedDate: string;
    timezone: string;
  };
  contextToken: string;
};

export type CreateNextActionOutcome = {
  status: number;
  body: { nextAction: NextAction; replayed: boolean; deleted?: boolean };
};

export type UpdateNextActionOutcome = {
  status: number;
  body: { nextAction: NextAction; replayed: boolean };
};

export class NextActionHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : String(body.error ?? 'next action error'));
    this.name = 'NextActionHttpError';
    this.status = status;
    this.body = body;
  }
}

// ---------- 数据库行 ----------

type AttemptRow = {
  id: string;
  captureId: string;
  step: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
  sourceUrl: string | null;
  observedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin: string;
  actionDescription: string | null;
  estimatedMinutes: number | null;
  sourceReviewId: string | null;
  sourceExperienceIndex: number | null;
  sourceAttemptId: string | null;
  sourceAttemptRevision: number | null;
};

type CaptureRow = {
  id: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

type ReceiptRow = {
  operation_key: string;
  target_type: string;
  request_fingerprint: string;
  response_json: string;
};

const ATTEMPT_COLUMNS = `id, capture_id AS captureId, step, state, result_text AS resultText,
  outcome, source_url AS sourceUrl, observed_at AS observedAt, revision,
  created_at AS createdAt, updated_at AS updatedAt, origin,
  action_description AS actionDescription, estimated_minutes AS estimatedMinutes,
  source_review_id AS sourceReviewId, source_experience_index AS sourceExperienceIndex,
  source_attempt_id AS sourceAttemptId, source_attempt_revision AS sourceAttemptRevision`;

const CAPTURE_COLUMNS = `id, raw_text AS rawText, revision, created_at AS createdAt,
  updated_at AS updatedAt, archived_at AS archivedAt`;

const REVIEW_COLUMNS = `id, status, range_from AS rangeFrom, range_to AS rangeTo, timezone,
  range_preset AS rangePreset, stats_json AS statsJson, coverage_json AS coverageJson,
  content_json AS contentJson, sources_json AS sourcesJson, config_id AS configId,
  config_version AS configVersion, config_name AS configName, model_id AS modelId,
  error_code AS errorCode, error_detail AS errorDetail, usage_json AS usageJson,
  duration_ms AS durationMs, operation_id AS operationId,
  operation_fingerprint AS operationFingerprint, context_token AS contextToken,
  saved_at AS savedAt, content_invalidated_at AS contentInvalidatedAt,
  content_invalid_reason AS contentInvalidReason, created_at AS createdAt,
  updated_at AS updatedAt, finished_at AS finishedAt`;

function readAttemptById(id: string): AttemptRow | undefined {
  return sqlite
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`)
    .get(id) as AttemptRow | undefined;
}

function readCaptureById(id: string): CaptureRow | undefined {
  return sqlite
    .prepare(`SELECT ${CAPTURE_COLUMNS} FROM captures WHERE id = ?`)
    .get(id) as CaptureRow | undefined;
}

function readReviewRow(id: string): StageReview | undefined {
  return sqlite
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM stage_reviews WHERE id = ?`)
    .get(id) as StageReview | undefined;
}

function getReceipt(operationKey: string): ReceiptRow | undefined {
  return sqlite
    .prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?')
    .get(operationKey) as ReceiptRow | undefined;
}

// ---------- 通用工具 ----------

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeOutcome(value: string | null): NextActionOutcome | null {
  return value === 'success' || value === 'failure' || value === 'undetermined' ? value : null;
}

function normalizeState(value: string): NextActionState {
  return value === 'in_progress' || value === 'done' || value === 'cancelled' ? value : 'todo';
}

function localDateString(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function firstSentenceDraft(text: string): { title: string; description: string } {
  const normalized = text.trim();
  if (!normalized) return { title: '下一步行动', description: '' };
  const breakIndex = normalized.search(/[。！？!?\n]/u);
  let title = breakIndex >= 0 ? normalized.slice(0, breakIndex) : normalized;
  let description = breakIndex >= 0 ? normalized.slice(breakIndex + 1).trim() : '';
  if (Array.from(title).length > 60) title = Array.from(title).slice(0, 60).join('');
  if (Array.from(description).length > MAX_DESCRIPTION_LENGTH) {
    description = Array.from(description).slice(0, MAX_DESCRIPTION_LENGTH).join('');
  }
  return { title: title.trim() || '下一步行动', description };
}

// ---------- 回顾与经验解析 ----------

type StoredSource = {
  key?: unknown;
  type?: unknown;
  sourceId?: unknown;
  captureId?: unknown;
  attemptId?: unknown;
  title?: unknown;
  revision?: unknown;
  captureRevision?: unknown;
  deleted?: unknown;
};

type ResolvedSource = {
  key: string;
  stored: StoredSource;
  attemptId: string;
};

type ReviewContext = {
  row: StageReview;
  content: ReviewContent;
  experience: ReviewItem;
  experienceIndex: number;
  sources: ResolvedSource[];
  existing: ResolvedSource[];
  captures: CaptureRow[];
  sourceAttempts: PreviewSourceAttempt[];
  defaultCapture: CaptureRow;
};

function parseExperienceIndexValue(value: unknown, field = 'experienceIndex'): number {
  let parsed: number | null = null;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && /^\d+$/u.test(value.trim())) parsed = Number(value.trim());
  if (parsed === null || !Number.isInteger(parsed) || parsed < 0) {
    throw new NextActionHttpError(400, {
      error: 'invalid_experience_index',
      message: 'experienceIndex 必须是大于等于 0 的整数。',
      field,
    });
  }
  return parsed;
}

function parseStoredSources(raw: string | null): StoredSource[] {
  const parsed = parseJson<unknown>(raw);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is StoredSource => Boolean(item && typeof item === 'object'))
    : [];
}

function readExperience(content: ReviewContent | null, index: number): ReviewItem {
  const experiences = content && Array.isArray(content.experiences) ? content.experiences : [];
  const item = experiences[index];
  if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) {
    throw new NextActionHttpError(400, {
      error: 'invalid_experience_index',
      message: '这条回顾中没有指定索引的经验。',
      field: 'experienceIndex',
    });
  }
  return {
    text: item.text,
    basis: item.basis === 'observation' ? 'observation' : 'inference',
    sourceIds: Array.isArray(item.sourceIds)
      ? item.sourceIds.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function buildPreviewSourceAttempt(source: ResolvedSource): PreviewSourceAttempt {
  const attempt = readAttemptById(source.attemptId);
  const storedRevision = asNumber(source.stored.revision);
  const storedCaptureRevision = asNumber(source.stored.captureRevision);
  if (!attempt) {
    return {
      attemptId: source.attemptId,
      captureId: asString(source.stored.captureId),
      step: null,
      state: null,
      resultText: null,
      outcome: null,
      revision: storedRevision,
      captureRevision: storedCaptureRevision,
      captureText: null,
      exists: false,
      changed: false,
      deleted: true,
    };
  }
  const capture = readCaptureById(attempt.captureId);
  if (!capture) {
    return {
      attemptId: source.attemptId,
      captureId: attempt.captureId,
      step: null,
      state: null,
      resultText: null,
      outcome: null,
      revision: storedRevision,
      captureRevision: storedCaptureRevision,
      captureText: null,
      exists: false,
      changed: false,
      deleted: true,
    };
  }
  return {
    attemptId: attempt.id,
    captureId: capture.id,
    step: attempt.step,
    state: attempt.state,
    resultText: attempt.resultText,
    outcome: normalizeOutcome(attempt.outcome),
    revision: attempt.revision,
    captureRevision: capture.revision,
    captureText: capture.rawText,
    exists: true,
    changed:
      attempt.revision !== (storedRevision ?? 0) ||
      capture.revision !== (storedCaptureRevision ?? 0),
    deleted: false,
  };
}

function resolveReviewContext(reviewId: string, experienceIndex: number): ReviewContext {
  const row = readReviewRow(reviewId);
  if (!row) {
    throw new NextActionHttpError(404, { error: 'review_not_found', message: '回顾不存在。' });
  }
  if (row.savedAt === null) {
    throw new NextActionHttpError(409, {
      error: 'review_not_saved',
      message: '请先保存这条回顾，再创建下一步行动。',
    });
  }
  const content = parseJson<ReviewContent>(row.contentJson);
  const storedSourcesEarly = parseStoredSources(row.sourcesJson);
  if (
    row.contentInvalidatedAt !== null ||
    storedSourcesEarly.some((source) => source.deleted === true)
  ) {
    throw new NextActionHttpError(409, {
      error: 'review_content_withheld',
      message: '这条回顾的来源已被删除，生成正文已撤下，不能再从它创建下一步。',
    });
  }
  const experience = readExperience(content, experienceIndex);
  const storedSources = storedSourcesEarly;
  const byKey = new Map<string, StoredSource>();
  for (const source of storedSources) {
    if (typeof source.key === 'string') byKey.set(source.key, source);
  }

  const keys: string[] = [];
  const sources: ResolvedSource[] = [];
  const seenKeys = new Set<string>();
  for (const key of experience.sourceIds) {
    if (typeof key !== 'string' || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const stored = byKey.get(key);
    if (!stored || stored.type !== 'attempt') continue;
    const attemptId = typeof stored.sourceId === 'string' ? stored.sourceId : '';
    if (!attemptId) continue;
    keys.push(key);
    sources.push({ key, stored, attemptId });
  }
  sources.sort((a, b) => a.key.localeCompare(b.key));

  const sourceAttempts = sources.map(buildPreviewSourceAttempt);
  const existing = sources.filter((_, index) => sourceAttempts[index].exists);
  const captureById = new Map<string, CaptureRow>();
  for (const item of sourceAttempts) {
    if (!item.exists || !item.captureId) continue;
    const capture = readCaptureById(item.captureId);
    if (capture) captureById.set(capture.id, capture);
  }
  const captures = [...captureById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const defaultCapture = captures[0];

  return {
    row,
    content: content ?? {
      overview: '',
      attempts: [],
      observations: [],
      connections: [],
      experiences: [],
      uncertainties: [],
      insufficientData: false,
      dataNotes: null,
    },
    experience,
    experienceIndex,
    sources,
    existing,
    captures,
    sourceAttempts,
    defaultCapture,
  };
}

function contextToken(
  reviewId: string,
  savedAt: number,
  experienceIndex: number,
  captureId: string,
  captureRevision: number,
  existing: ResolvedSource[]
): string {
  const sources = existing
    .map((source) => {
      const attempt = readAttemptById(source.attemptId);
      return { attemptId: source.attemptId, revision: attempt?.revision ?? null };
    })
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  return sha256(
    JSON.stringify({
      v: 1,
      reviewId,
      savedAt,
      experienceIndex,
      captureId,
      captureRevision,
      sources,
    })
  );
}

// ---------- 公开对象 ----------

function toNextActionSource(
  source: ResolvedSource,
  referenceRevision: number | null
): NextActionSourcePublic {
  const attempt = readAttemptById(source.attemptId);
  const deleted = !attempt;
  const storedRevision = asNumber(source.stored.revision);
  // 行动来源的 revision 以创建时 attempt_references.snapshot_revision 为准；
  // 没有引用行（来源已删除）时才退回回顾快照里的版本。
  const actionRevision = referenceRevision ?? storedRevision;
  return {
    key: source.key,
    type: typeof source.stored.type === 'string' ? source.stored.type : 'attempt',
    sourceId: source.attemptId,
    attemptId: attempt?.id ?? source.attemptId,
    captureId: attempt?.captureId ?? asString(source.stored.captureId),
    title: deleted ? null : attempt.step,
    text: deleted ? null : attempt.step,
    resultText: deleted ? null : attempt.resultText,
    state: deleted ? null : attempt.state,
    revision: actionRevision,
    currentRevision: attempt?.revision ?? null,
    changed: !deleted && attempt.revision !== (actionRevision ?? 0),
    deleted,
  };
}

export function buildNextAction(id: string): NextAction | null {
  const row = readAttemptById(id);
  if (!row || row.origin !== 'review_next_action') return null;
  const capture = readCaptureById(row.captureId);
  const review = row.sourceReviewId ? readReviewRow(row.sourceReviewId) : undefined;
  const content = review ? parseJson<ReviewContent>(review.contentJson) : null;
  const experienceIndex = row.sourceExperienceIndex ?? 0;
  const experiences = content && Array.isArray(content.experiences) ? content.experiences : [];
  const experienceItem = experiences[experienceIndex];

  const storedSources = review ? parseStoredSources(review.sourcesJson) : [];
  const byKey = new Map<string, StoredSource>();
  for (const source of storedSources) {
    if (typeof source.key === 'string') byKey.set(source.key, source);
  }
  const referenceRows = sqlite
    .prepare(
      `SELECT to_attempt_id AS toAttemptId, snapshot_revision AS snapshotRevision
         FROM attempt_references WHERE from_attempt_id = ?`
    )
    .all(id) as Array<{ toAttemptId: string; snapshotRevision: number }>;
  const referenceRevisionByAttempt = new Map<string, number>();
  for (const reference of referenceRows) {
    referenceRevisionByAttempt.set(reference.toAttemptId, reference.snapshotRevision);
  }
  const sources: NextActionSourcePublic[] = [];
  const seenAttempts = new Set<string>();
  for (const key of experienceItem?.sourceIds ?? []) {
    if (typeof key !== 'string') continue;
    const stored = byKey.get(key);
    if (!stored || stored.type !== 'attempt') continue;
    const attemptId = typeof stored.sourceId === 'string' ? stored.sourceId : '';
    if (!attemptId || seenAttempts.has(attemptId)) continue;
    seenAttempts.add(attemptId);
    sources.push(
      toNextActionSource(
        { key, stored, attemptId },
        referenceRevisionByAttempt.get(attemptId) ?? null
      )
    );
  }

  const publicReview = review ? publicReviewOf(review) : null;

  return {
    id: row.id,
    captureId: row.captureId,
    title: row.step,
    description: row.actionDescription,
    estimatedMinutes: row.estimatedMinutes,
    state: normalizeState(row.state),
    resultText: row.resultText,
    outcome: normalizeOutcome(row.outcome),
    observedAt: row.observedAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    origin: 'review_next_action',
    sourceReviewId: row.sourceReviewId ?? '',
    sourceExperienceIndex: experienceIndex,
    sourceAttemptId: row.sourceAttemptId,
    sourceAttemptRevision: row.sourceAttemptRevision,
    capture: capture
      ? {
          id: capture.id,
          rawText: capture.rawText,
          revision: capture.revision,
          archivedAt: capture.archivedAt,
        }
      : null,
    sourceReview: review
      ? {
          id: review.id,
          savedAt: review.savedAt,
          range: publicReview?.range ?? null,
          contentInvalidated: publicReview?.contentInvalidated ?? false,
          sourcesChanged: publicReview?.sourcesChanged ?? false,
        }
      : null,
    experience:
      experienceItem && typeof experienceItem.text === 'string'
        ? {
            text: experienceItem.text,
            basis: experienceItem.basis === 'observation' ? 'observation' : 'inference',
            sourceIds: Array.isArray(experienceItem.sourceIds)
              ? experienceItem.sourceIds.filter((value): value is string => typeof value === 'string')
              : [],
          }
        : null,
    sources,
    schedules: listSchedulesForAttempt(row.id),
    canEdit: true,
    deleted: sources.some((source) => source.deleted),
  };
}

export function getNextActionById(id: string): NextAction | null {
  return buildNextAction(id);
}

export function listNextActionsByReview(reviewId: string): NextAction[] {
  const rows = sqlite
    .prepare(
      `SELECT id FROM attempts
        WHERE origin = 'review_next_action' AND source_review_id = ?
        ORDER BY created_at DESC, id DESC`
    )
    .all(reviewId) as Array<{ id: string }>;
  return rows
    .map((row) => buildNextAction(row.id))
    .filter((action): action is NextAction => action !== null);
}

export function listNextActionsByCapture(captureId: string): NextAction[] {
  const rows = sqlite
    .prepare(
      `SELECT id FROM attempts
        WHERE origin = 'review_next_action' AND capture_id = ?
        ORDER BY created_at DESC, id DESC`
    )
    .all(captureId) as Array<{ id: string }>;
  return rows
    .map((row) => buildNextAction(row.id))
    .filter((action): action is NextAction => action !== null);
}

// ---------- 预览 ----------

export function previewNextAction(reviewId: string, rawExperienceIndex: unknown): NextActionPreview {
  const experienceIndex = parseExperienceIndexValue(rawExperienceIndex);
  const context = resolveReviewContext(reviewId, experienceIndex);
  if (context.existing.length === 0 || !context.defaultCapture) {
    throw new NextActionHttpError(409, {
      error: 'source_unavailable',
      message: '这条经验没有仍可用的来源尝试，无法创建下一步行动。',
      sourceAttempts: context.sourceAttempts,
    });
  }
  const publicReview = publicReviewOf(context.row);
  const draft = firstSentenceDraft(context.experience.text);
  const token = contextToken(
    context.row.id,
    context.row.savedAt ?? 0,
    experienceIndex,
    context.defaultCapture.id,
    context.defaultCapture.revision,
    context.existing
  );
  return {
    review: {
      id: context.row.id,
      savedAt: context.row.savedAt ?? 0,
      range: publicReview.range,
      contentInvalidated: publicReview.contentInvalidated,
      sourcesChanged: publicReview.sourcesChanged,
    },
    experienceIndex,
    experience: context.experience,
    sourceAttempts: context.sourceAttempts,
    captures: context.captures.map((capture) => ({
      id: capture.id,
      rawText: capture.rawText,
      revision: capture.revision,
      archivedAt: capture.archivedAt,
    })),
    defaults: {
      captureId: context.defaultCapture.id,
      title: draft.title,
      description: draft.description,
      estimatedMinutes: 30,
      suggestedDate: localDateString(Date.now() + DAY_MS, context.row.timezone),
      timezone: context.row.timezone,
    },
    contextToken: token,
  };
}

// ---------- 输入校验 ----------

type ParsedSchedule = ReturnType<typeof parseScheduleInput>;

type CreateInput = {
  captureId: string;
  captureRevision: number;
  experienceIndex: number;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  schedule: ParsedSchedule | null;
};

function requireOperationId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new NextActionHttpError(400, {
      error: 'invalid_request',
      message: 'operationId 必填。',
      field: 'operationId',
    });
  }
  const value = raw.trim();
  if (value.length > 200) {
    throw new NextActionHttpError(400, {
      error: 'invalid_request',
      message: 'operationId 不能超过 200 个字符。',
      field: 'operationId',
    });
  }
  return value;
}

function requireRevision(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new NextActionHttpError(428, {
      error: 'revision_required',
      message: 'revision 必填且必须是正整数。',
      field: 'revision',
    });
  }
  return raw;
}

function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new NextActionHttpError(400, {
      error: 'invalid_title',
      message: 'title 必须是 1–120 字的字符串。',
      field: 'title',
    });
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_TITLE_LENGTH) {
    throw new NextActionHttpError(400, {
      error: 'invalid_title',
      message: 'title 必须是 1–120 字的字符串。',
      field: 'title',
    });
  }
  return value;
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new NextActionHttpError(400, {
      error: 'invalid_description',
      message: 'description 必须是不超过 2000 字的字符串。',
      field: 'description',
    });
  }
  const value = raw.trim();
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new NextActionHttpError(400, {
      error: 'invalid_description',
      message: 'description 不能超过 2000 字。',
      field: 'description',
    });
  }
  return value || null;
}

function validateEstimatedMinutes(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_ESTIMATED_MINUTES) {
    throw new NextActionHttpError(400, {
      error: 'invalid_estimated_minutes',
      message: 'estimatedMinutes 必须是 1–1440 的整数或 null。',
      field: 'estimatedMinutes',
    });
  }
  return raw;
}

function parseScheduleField(raw: unknown): ParsedSchedule | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleHttpError(400, {
      error: 'invalid_schedule_time',
      message: 'schedule 必须是对象或 null。',
      field: 'schedule',
    });
  }
  const value = raw as Record<string, unknown>;
  if (value.enabled === false) return null;
  return parseScheduleInput(value);
}

function parseCreateInput(raw: Record<string, unknown>): CreateInput {
  if (typeof raw.captureId !== 'string' || !raw.captureId.trim()) {
    throw new NextActionHttpError(400, {
      error: 'invalid_request',
      message: 'captureId 必填。',
      field: 'captureId',
    });
  }
  if (
    typeof raw.captureRevision !== 'number' ||
    !Number.isInteger(raw.captureRevision) ||
    raw.captureRevision < 1
  ) {
    throw new NextActionHttpError(400, {
      error: 'invalid_request',
      message: 'captureRevision 必填且必须是正整数。',
      field: 'captureRevision',
    });
  }
  return {
    captureId: raw.captureId.trim(),
    captureRevision: raw.captureRevision,
    experienceIndex: parseExperienceIndexValue(raw.experienceIndex),
    title: validateTitle(raw.title),
    description: validateDescription(raw.description),
    estimatedMinutes: validateEstimatedMinutes(raw.estimatedMinutes),
    schedule: parseScheduleField(raw.schedule),
  };
}

function normalizedScheduleForFingerprint(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.enabled === false) return null;
  return {
    date: value.date ?? null,
    endDate: value.endDate ?? null,
    startTime: value.startTime ?? null,
    endTime: value.endTime ?? null,
    timezone: value.timezone ?? null,
    note: typeof value.note === 'string' ? value.note.trim() : null,
    startDisambiguation: value.startDisambiguation ?? null,
    endDisambiguation: value.endDisambiguation ?? null,
    confirmOverlap: value.confirmOverlap === true,
    conflictToken: typeof value.conflictToken === 'string' ? value.conflictToken : null,
    expectedConflictIds: Array.isArray(value.expectedConflictIds)
      ? value.expectedConflictIds.filter((item): item is string => typeof item === 'string').sort()
      : null,
  };
}

// ---------- 日程冲突 ----------

type ConflictParams = Record<string, string | number | null>;

function conflictTokenFor(
  params: ConflictParams,
  schedule: ParsedSchedule,
  conflicts: ScheduleBlock[]
): string {
  return sha256(
    JSON.stringify({
      v: 1,
      action: 'next-action-schedule',
      params,
      schedule: {
        startsAt: schedule.startsAt,
        endsAt: schedule.endsAt,
        timezone: schedule.timezone,
        note: schedule.note,
      },
      conflicts: conflicts
        .map((item) => ({ id: item.id, revision: item.revision, updatedAt: item.updatedAt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
  );
}

function assertOverlapConfirmed(
  params: ConflictParams,
  schedule: ParsedSchedule,
  conflicts: ScheduleBlock[],
  rawSchedule: Record<string, unknown>
): void {
  const token = conflictTokenFor(params, schedule, conflicts);
  if (rawSchedule.confirmOverlap !== true) {
    throw new ScheduleHttpError(409, {
      error: 'schedule_conflict',
      message: '与现有安排重叠',
      conflicts,
      conflictToken: token,
      requiresConfirmation: true,
      options: { changeTime: true, saveUnscheduled: true, viewConflicts: true },
    });
  }
  const providedToken =
    typeof rawSchedule.conflictToken === 'string' ? rawSchedule.conflictToken : null;
  let idsMatch = true;
  if (rawSchedule.expectedConflictIds !== undefined && rawSchedule.expectedConflictIds !== null) {
    if (!Array.isArray(rawSchedule.expectedConflictIds)) {
      idsMatch = false;
    } else {
      const providedIds = rawSchedule.expectedConflictIds
        .filter((item): item is string => typeof item === 'string')
        .sort();
      const currentIds = conflicts.map((item) => item.id).sort();
      idsMatch =
        providedIds.length === currentIds.length &&
        providedIds.every((item, index) => item === currentIds[index]);
    }
  }
  if (providedToken !== token || !idsMatch) {
    throw new ScheduleHttpError(409, {
      error: 'schedule_conflict_changed',
      message: '冲突已变化，请重新确认。',
      conflicts,
      conflictToken: token,
      requiresConfirmation: true,
      options: { changeTime: true, saveUnscheduled: true, viewConflicts: true },
    });
  }
}

// ---------- 幂等回执 ----------

function replayCreate(receipt: ReceiptRow | undefined, fingerprint: string): CreateNextActionOutcome {
  if (!receipt) {
    throw new NextActionHttpError(500, { error: 'internal_error', message: 'operationId 回执缺失。' });
  }
  if (receipt.target_type !== 'next_action' || receipt.request_fingerprint !== fingerprint) {
    throw new NextActionHttpError(409, {
      error: 'operation_key_conflict',
      message: 'operationId 已被另一个请求使用。',
    });
  }
  const stored = JSON.parse(receipt.response_json) as { actionId?: string } | NextAction;
  const actionId = (stored as { actionId?: string }).actionId ?? (stored as NextAction).id;
  const nextAction = actionId ? buildNextAction(actionId) : null;
  if (!nextAction) {
    throw new NextActionHttpError(404, {
      error: 'next_action_not_found',
      message: '这条下一步行动已被删除。',
    });
  }
  return {
    status: 200,
    body: { nextAction, replayed: true },
  };
}

function replayUpdate(receipt: ReceiptRow | undefined, fingerprint: string): UpdateNextActionOutcome {
  if (!receipt) {
    throw new NextActionHttpError(500, { error: 'internal_error', message: 'operationId 回执缺失。' });
  }
  if (receipt.target_type !== 'next_action_update' || receipt.request_fingerprint !== fingerprint) {
    throw new NextActionHttpError(409, {
      error: 'operation_key_conflict',
      message: 'operationId 已被另一个请求使用。',
    });
  }
  const stored = JSON.parse(receipt.response_json) as { actionId?: string } | NextAction;
  const actionId = (stored as { actionId?: string }).actionId ?? (stored as NextAction).id;
  const nextAction = actionId ? buildNextAction(actionId) : null;
  if (!nextAction) {
    throw new NextActionHttpError(404, {
      error: 'next_action_not_found',
      message: '这条下一步行动已被删除。',
    });
  }
  return {
    status: 200,
    body: { nextAction, replayed: true },
  };
}

// ---------- 创建 ----------

export function createNextAction(
  reviewId: string,
  rawBody: Record<string, unknown>
): CreateNextActionOutcome {
  const operationId = requireOperationId(rawBody.operationId);
  const input = parseCreateInput(rawBody);
  const fingerprint = sha256(
    JSON.stringify({
      op: 'create-next-action',
      reviewId,
      captureId: input.captureId,
      captureRevision: input.captureRevision,
      experienceIndex: input.experienceIndex,
      title: input.title,
      description: input.description,
      estimatedMinutes: input.estimatedMinutes,
      schedule: normalizedScheduleForFingerprint(rawBody.schedule),
    })
  );

  const existingReceipt = getReceipt(operationId);
  if (existingReceipt) return replayCreate(existingReceipt, fingerprint);

  const transaction = sqlite.transaction((): CreateNextActionOutcome => {
    const raced = getReceipt(operationId);
    if (raced) return replayCreate(raced, fingerprint);

    const context = resolveReviewContext(reviewId, input.experienceIndex);
    if (context.existing.length === 0) {
      throw new NextActionHttpError(409, {
        error: 'source_deleted',
        message: '这条经验的来源尝试已全部删除，无法创建下一步行动。',
        sourceAttempts: context.sourceAttempts,
      });
    }
    if (!context.defaultCapture) {
      throw new NextActionHttpError(409, {
        error: 'source_deleted',
        message: '这条经验的来源尝试已全部删除，无法创建下一步行动。',
        sourceAttempts: context.sourceAttempts,
      });
    }

    const capture = readCaptureById(input.captureId);
    if (!capture) {
      throw new NextActionHttpError(404, { error: 'capture_not_found', message: '念头不存在。' });
    }
    if (!context.captures.some((item) => item.id === capture.id)) {
      throw new NextActionHttpError(409, {
        error: 'capture_changed',
        message: '所选念头不属于这条回顾的来源，请重新预览。',
        currentRevision: capture.revision,
      });
    }
    if (capture.revision !== input.captureRevision) {
      throw new NextActionHttpError(409, {
        error: 'capture_changed',
        message: '念头已被修改，请重新预览后再创建。',
        currentRevision: capture.revision,
      });
    }

    const providedToken = typeof rawBody.contextToken === 'string' ? rawBody.contextToken.trim() : '';
    const selectedToken = contextToken(
      context.row.id,
      context.row.savedAt ?? 0,
      input.experienceIndex,
      capture.id,
      capture.revision,
      context.existing
    );
    const defaultToken = contextToken(
      context.row.id,
      context.row.savedAt ?? 0,
      input.experienceIndex,
      context.defaultCapture.id,
      context.defaultCapture.revision,
      context.existing
    );
    if (!providedToken || (providedToken !== selectedToken && providedToken !== defaultToken)) {
      const latestToken = contextToken(
        context.row.id,
        context.row.savedAt ?? 0,
        input.experienceIndex,
        context.defaultCapture.id,
        context.defaultCapture.revision,
        context.existing
      );
      throw new NextActionHttpError(409, {
        error: 'sources_changed',
        message: '来源记录有更新，请重新预览后再创建。',
        sourceAttempts: context.sourceAttempts,
        contextToken: latestToken,
      });
    }

    const params: ConflictParams = {
      reviewId,
      experienceIndex: input.experienceIndex,
      captureId: capture.id,
      captureRevision: capture.revision,
      title: input.title,
      description: input.description,
      estimatedMinutes: input.estimatedMinutes,
    };
    let conflicts: ScheduleBlock[] = [];
    if (input.schedule) {
      conflicts = listConflictingActive(input.schedule.startsAt, input.schedule.endsAt, null);
      const scheduleRaw = rawBody.schedule as Record<string, unknown>;
      // 冲突仍存在，或客户端声称已确认并带回 token：都要重新核对，防止冲突集合变化。
      if (
        conflicts.length > 0 ||
        (scheduleRaw.confirmOverlap === true && typeof scheduleRaw.conflictToken === 'string')
      ) {
        assertOverlapConfirmed(params, input.schedule, conflicts, scheduleRaw);
      }
    }

    const t = Date.now();
    const id = `att-${t}-${Math.random().toString(36).slice(2, 8)}`;
    const primary = context.existing[0];
    const primaryAttempt = readAttemptById(primary.attemptId);
    if (!primaryAttempt) throw new Error('next action primary source vanished');

    sqlite
      .prepare(
        `INSERT INTO attempts
           (id, capture_id, step, state, result_text, outcome, source_url, observed_at,
            revision, created_at, updated_at, origin, action_description, estimated_minutes,
            source_review_id, source_experience_index, source_attempt_id, source_attempt_revision)
         VALUES (?, ?, ?, 'todo', NULL, NULL, NULL, NULL, 1, ?, ?, 'review_next_action',
                 ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        capture.id,
        input.title,
        t,
        t,
        input.description,
        input.estimatedMinutes,
        reviewId,
        input.experienceIndex,
        primary.attemptId,
        primaryAttempt.revision
      );

    const insertReference = sqlite.prepare(
      `INSERT INTO attempt_references
         (id, from_attempt_id, to_attempt_id, revision, note, snapshot_result_text,
          snapshot_revision, created_at)
       VALUES (?, ?, ?, 1, NULL, ?, ?, ?)`
    );
    for (const source of context.existing) {
      const sourceAttempt = readAttemptById(source.attemptId);
      if (!sourceAttempt) continue;
      insertReference.run(
        `ref-${t}-${Math.random().toString(36).slice(2, 8)}`,
        id,
        sourceAttempt.id,
        sourceAttempt.resultText,
        sourceAttempt.revision,
        t
      );
    }

    if (input.schedule) {
      sqlite
        .prepare(
          `INSERT INTO schedule_blocks
             (id, attempt_id, starts_at, ends_at, timezone, note, status, revision,
              created_at, updated_at, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`
        )
        .run(
          `sch-${t}-${Math.random().toString(36).slice(2, 8)}`,
          id,
          input.schedule.startsAt,
          input.schedule.endsAt,
          input.schedule.timezone,
          input.schedule.note,
          t,
          t
        );
    }

    const nextAction = buildNextAction(id);
    if (!nextAction) throw new Error('next action insert failed');
    sqlite
      .prepare(
        `INSERT INTO mutation_receipts
           (operation_key, target_type, request_fingerprint, response_json, created_at)
         VALUES (?, 'next_action', ?, ?, ?)`
      )
      .run(operationId, fingerprint, JSON.stringify({ actionId: nextAction.id }), t);

    return {
      status: 201,
      body: {
        nextAction,
        replayed: false,
        deleted: nextAction.deleted,
      },
    };
  });

  try {
    return transaction();
  } catch (error) {
    if (error instanceof NextActionHttpError || error instanceof ScheduleHttpError) throw error;
    const raced = getReceipt(operationId);
    if (raced && raced.target_type === 'next_action' && raced.request_fingerprint === fingerprint) {
      return replayCreate(raced, fingerprint);
    }
    throw error;
  }
}

// ---------- 更新 ----------

export function updateNextAction(
  id: string,
  rawBody: Record<string, unknown>
): UpdateNextActionOutcome {
  const operationId = requireOperationId(rawBody.operationId);
  const revision = requireRevision(rawBody.revision);
  const title = rawBody.title === undefined ? undefined : validateTitle(rawBody.title);
  const description =
    rawBody.description === undefined ? undefined : validateDescription(rawBody.description);
  const estimatedMinutes =
    rawBody.estimatedMinutes === undefined
      ? undefined
      : validateEstimatedMinutes(rawBody.estimatedMinutes);

  const fingerprint = sha256(
    JSON.stringify({
      op: 'update-next-action',
      id,
      revision,
      title: title ?? null,
      description: description ?? null,
      estimatedMinutes: estimatedMinutes ?? null,
    })
  );

  const existingReceipt = getReceipt(operationId);
  if (existingReceipt) return replayUpdate(existingReceipt, fingerprint);

  const transaction = sqlite.transaction((): UpdateNextActionOutcome => {
    const raced = getReceipt(operationId);
    if (raced) return replayUpdate(raced, fingerprint);

    const current = readAttemptById(id);
    if (!current) {
      throw new NextActionHttpError(404, {
        error: 'next_action_not_found',
        message: '下一步行动不存在。',
      });
    }
    if (current.origin !== 'review_next_action') {
      throw new NextActionHttpError(409, {
        error: 'not_next_action',
        message: '只有从回顾创建的下一步行动可以这样修改。',
      });
    }
    if (current.revision !== revision) {
      throw new NextActionHttpError(409, {
        error: 'revision_conflict',
        message: '下一步行动已被其他窗口修改。',
        current: buildNextAction(id),
        currentRevision: current.revision,
      });
    }

    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE attempts
            SET step = ?, action_description = ?, estimated_minutes = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND origin = 'review_next_action'`
      )
      .run(
        title ?? current.step,
        description !== undefined ? description : current.actionDescription,
        estimatedMinutes !== undefined ? estimatedMinutes : current.estimatedMinutes,
        t,
        id,
        revision
      );
    if (result.changes !== 1) {
      throw new NextActionHttpError(409, {
        error: 'revision_conflict',
        message: '下一步行动已被其他窗口修改。',
        current: buildNextAction(id),
        currentRevision: readAttemptById(id)?.revision ?? null,
      });
    }

    const nextAction = buildNextAction(id);
    if (!nextAction) throw new Error('next action update vanished');
    sqlite
      .prepare(
        `INSERT INTO mutation_receipts
           (operation_key, target_type, request_fingerprint, response_json, created_at)
         VALUES (?, 'next_action_update', ?, ?, ?)`
      )
      .run(operationId, fingerprint, JSON.stringify({ actionId: nextAction.id }), t);

    return { status: 200, body: { nextAction, replayed: false } };
  });

  try {
    return transaction();
  } catch (error) {
    if (error instanceof NextActionHttpError) throw error;
    const raced = getReceipt(operationId);
    if (
      raced &&
      raced.target_type === 'next_action_update' &&
      raced.request_fingerprint === fingerprint
    ) {
      return replayUpdate(raced, fingerprint);
    }
    throw error;
  }
}
