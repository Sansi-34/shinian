// 拾念 SHINIAN · 阶段回顾数据层
// 契约：docs/review-api-contract.md；共享类型：src/server/reviewTypes.ts
//
// 本文件负责：范围解析、记录/统计快照、来源实时状态、已保存回顾读取、
// 导出数据、删除清洗和四个只读/保存路由。模型生成（POST /api/reviews、
// /api/review/preview、取消）由 reviewAi.ts 负责。

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/db';
import { type StageReview } from '../db/schema';
import { errorMessageForCode, getSettingsRow, type AiErrorCode } from './aiSettings';
import {
  REVIEW_MAX_CHARS,
  REVIEW_MAX_RANGE_DAYS,
  REVIEW_MAX_RANGE_RECORDS,
  REVIEW_MAX_RECORDS,
  type ReviewAiConfig,
  type ReviewAiSummary,
  type ReviewAttemptState,
  type ReviewContent,
  type ReviewListItem,
  type ReviewOutcome,
  type ReviewPreviewCoverage,
  type ReviewPublic,
  type ReviewRange,
  type ReviewRangeCoverage,
  type ReviewReason,
  type ReviewRecord,
  type ReviewSections,
  type ReviewSource,
  type ReviewSourcePublic,
  type ReviewStatDefinition,
  type ReviewStats,
  type ReviewPreset,
} from './reviewTypes';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_TIMEZONE_LENGTH = 80;
const INTERRUPTED_DETAIL = '服务重启，本次回顾已中断，可重新生成。';
const DELETED_SOURCE_REASON = '来源记录已删除';
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

// ---------- 通用小工具 ----------

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/u)[0]?.trim() ?? '';
  const value = line || text.trim();
  return value.length > max ? value.slice(0, max) : value;
}

function isWithin(value: number | null | undefined, from: number, to: number): boolean {
  return value !== null && value !== undefined && value >= from && value < to;
}

function normalizeOutcome(value: string | null): ReviewOutcome | null {
  return value === 'success' || value === 'failure' || value === 'undetermined' ? value : null;
}

function normalizeAttemptState(value: string | null): ReviewAttemptState | null {
  return value === 'todo' ||
    value === 'in_progress' ||
    value === 'done' ||
    value === 'cancelled'
    ? value
    : null;
}

// ---------- 范围解析 ----------

export type ReviewRangeInput = {
  from: number;
  to: number;
  timezone: string;
  preset: ReviewPreset;
};

export type ParseReviewRangeResult =
  | { ok: true; value: ReviewRangeInput }
  | { ok: false; status: number; error: string; message: string; field?: string };

function rangeError(
  error: string,
  message: string,
  field?: string
): ParseReviewRangeResult {
  return { ok: false, status: 400, error, message, ...(field ? { field } : {}) };
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^\d+$/u.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function formatInTimezone(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function parseReviewRange(
  raw: {
    from?: unknown;
    to?: unknown;
    timezone?: unknown;
    preset?: unknown;
  },
  maxRangeDays: number = REVIEW_MAX_RANGE_DAYS
): ParseReviewRangeResult {
  const from = parseTimestamp(raw.from);
  if (from === null || from <= 0) {
    return rangeError('invalid_range', 'from 必须是大于 0 的整数毫秒时间戳。', 'from');
  }
  const to = parseTimestamp(raw.to);
  if (to === null) {
    return rangeError('invalid_range', 'to 必须是整数毫秒时间戳。', 'to');
  }
  if (to <= from) {
    return rangeError('invalid_range', 'to 必须大于 from。', 'to');
  }
  if (from > MAX_DATE_MS || to > MAX_DATE_MS) {
    return rangeError('invalid_range', '时间戳超出可表示的时间范围。', 'to');
  }
  if (to - from > maxRangeDays * DAY_MS) {
    return rangeError(
      'invalid_range',
      `时间范围不能超过 ${maxRangeDays} 天。`,
      'to'
    );
  }

  if (
    typeof raw.timezone !== 'string' ||
    !raw.timezone.trim() ||
    raw.timezone.trim().length > MAX_TIMEZONE_LENGTH ||
    !isValidTimezone(raw.timezone.trim())
  ) {
    return rangeError(
      'invalid_timezone',
      'timezone 必须是有效的 IANA 时区名称（例如 Asia/Shanghai）。',
      'timezone'
    );
  }
  const timezone = raw.timezone.trim();

  const rawPreset = raw.preset;
  let preset: ReviewPreset;
  if (rawPreset === undefined || rawPreset === null || rawPreset === '') {
    preset = 'custom';
  } else if (typeof rawPreset === 'string') {
    const value = rawPreset.trim();
    if (value !== '7d' && value !== '30d' && value !== 'custom') {
      return rangeError('invalid_preset', 'preset 只能是 7d、30d 或 custom。', 'preset');
    }
    preset = value;
  } else {
    return rangeError('invalid_preset', 'preset 只能是 7d、30d 或 custom。', 'preset');
  }

  return { ok: true, value: { from, to, timezone, preset } };
}

export function makeReviewRange(value: ReviewRangeInput): ReviewRange {
  const days = Math.max(1, Math.round((value.to - value.from) / DAY_MS));
  return {
    from: value.from,
    to: value.to,
    fromIso: new Date(value.from).toISOString(),
    toIso: new Date(value.to).toISOString(),
    fromLocal: formatInTimezone(value.from, value.timezone),
    toLocal: formatInTimezone(value.to, value.timezone),
    timezone: value.timezone,
    preset: value.preset,
    days,
    endExclusive: true,
  };
}

// ---------- 数据库行与读取 ----------

type CaptureRow = {
  id: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
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
};

type ReferenceRow = {
  id: string;
  fromAttemptId: string;
  toAttemptId: string;
  revision: number;
  note: string | null;
  snapshotResultText: string | null;
  snapshotRevision: number;
  createdAt: number;
};

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

function readReviewRow(id: string): StageReview | undefined {
  return sqlite
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM stage_reviews WHERE id = ?`)
    .get(id) as StageReview | undefined;
}

function readCaptureRow(id: string): CaptureRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, raw_text AS rawText, revision, created_at AS createdAt,
              updated_at AS updatedAt, archived_at AS archivedAt
         FROM captures WHERE id = ?`
    )
    .get(id) as CaptureRow | undefined;
}

function readAttemptRow(id: string): AttemptRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
              outcome, observed_at AS observedAt, revision, created_at AS createdAt,
              updated_at AS updatedAt
         FROM attempts WHERE id = ?`
    )
    .get(id) as AttemptRow | undefined;
}

function readReferenceRow(id: string): ReferenceRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId,
              revision, note, snapshot_result_text AS snapshotResultText,
              snapshot_revision AS snapshotRevision, created_at AS createdAt
         FROM attempt_references WHERE id = ?`
    )
    .get(id) as ReferenceRow | undefined;
}

function readCapturesInRange(from: number, to: number): CaptureRow[] {
  return sqlite
    .prepare(
      `SELECT id, raw_text AS rawText, revision, created_at AS createdAt,
              updated_at AS updatedAt, archived_at AS archivedAt
         FROM captures
        WHERE (created_at >= ? AND created_at < ?)
           OR (created_at < ? AND updated_at >= ? AND updated_at < ?)`
    )
    .all(from, to, from, from, to) as CaptureRow[];
}

function readAttemptsInRange(from: number, to: number): AttemptRow[] {
  return sqlite
    .prepare(
      `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
              outcome, observed_at AS observedAt, revision, created_at AS createdAt,
              updated_at AS updatedAt
         FROM attempts
        WHERE (created_at >= ? AND created_at < ?)
           OR (updated_at >= ? AND updated_at < ?)
           OR (observed_at IS NOT NULL AND observed_at >= ? AND observed_at < ?)`
    )
    .all(from, to, from, to, from, to) as AttemptRow[];
}

function readReferencesInRange(from: number, to: number): ReferenceRow[] {
  return sqlite
    .prepare(
      `SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId,
              revision, note, snapshot_result_text AS snapshotResultText,
              snapshot_revision AS snapshotRevision, created_at AS createdAt
         FROM attempt_references
        WHERE created_at >= ? AND created_at < ?`
    )
    .all(from, to) as ReferenceRow[];
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function readAttemptsByIds(ids: string[]): AttemptRow[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows: AttemptRow[] = [];
  for (const chunk of chunked(unique, 500)) {
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(
      ...(sqlite
        .prepare(
          `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
                  outcome, observed_at AS observedAt, revision, created_at AS createdAt,
                  updated_at AS updatedAt
             FROM attempts WHERE id IN (${placeholders})`
        )
        .all(...chunk) as AttemptRow[])
    );
  }
  return rows;
}

function readCapturesByIds(ids: string[]): CaptureRow[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows: CaptureRow[] = [];
  for (const chunk of chunked(unique, 500)) {
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(
      ...(sqlite
        .prepare(
          `SELECT id, raw_text AS rawText, revision, created_at AS createdAt,
                  updated_at AS updatedAt, archived_at AS archivedAt
             FROM captures WHERE id IN (${placeholders})`
        )
        .all(...chunk) as CaptureRow[])
    );
  }
  return rows;
}

// ---------- 统计定义 ----------

const REASON_ORDER: ReviewReason[] = [
  'capture_created',
  'capture_modified',
  'attempt_started',
  'attempt_modified',
  'attempt_current_ended',
  'result_recorded',
  'result_time_unknown',
  'reference_created',
];

function buildStatDefinitions(stats: ReviewStats): ReviewStatDefinition[] {
  const definitions: Array<{ key: keyof ReviewStats; label: string; definition: string }> = [
    {
      key: 'capturesCreated',
      label: '记录的念头',
      definition: '创建时间落在范围内（含已归档）',
    },
    {
      key: 'capturesModified',
      label: '修改的念头',
      definition: '创建于范围之前、最后修改时间落在范围内；仅表示修改，不算新记录',
    },
    {
      key: 'attemptsStarted',
      label: '开始尝试',
      definition: '创建时间落在范围内；只表示开始，不代表已结束',
    },
    {
      key: 'attemptsModified',
      label: '修改的尝试',
      definition: '创建于范围之前、最后修改时间落在范围内；不计入新开始',
    },
    {
      key: 'attemptsCurrentlyEnded',
      label: '当前已结束/已放弃',
      definition:
        '当前状态为已结束或已放弃，且最后修改时间落在范围内；只表示当前状态和最后修改时间，不表示实际结束时间',
    },
    {
      key: 'resultsRecorded',
      label: '写下结果',
      definition: '结果记录时间（observedAt）落在范围内；编辑旧结果不改变该时间',
    },
    {
      key: 'resultsMissingObservedAt',
      label: '结果时间未知',
      definition:
        '有结果但没有结果记录时间，且创建或最后修改时间落在范围内；不计入结果数',
    },
    {
      key: 'referencesCreated',
      label: '新建引用',
      definition: '引用创建时间落在范围内',
    },
    {
      key: 'totalRecords',
      label: '范围内记录',
      definition: '范围内唯一记录键数量（同一尝试与其结果只算一条记录）',
    },
  ];
  return definitions.map((entry) => ({
    key: entry.key,
    label: entry.label,
    value: stats[entry.key],
    definition: entry.definition,
  }));
}

function hasResult(attempt: AttemptRow): boolean {
  return (attempt.resultText ?? '').trim().length > 0 || attempt.outcome !== null;
}

// ---------- 范围记录采集 ----------

type WorkingRecord = {
  record: ReviewRecord;
  relevance: number;
};

export type ReviewRangeData = {
  records: ReviewRecord[];
  sections: ReviewSections;
  stats: ReviewStats;
  statDefinitions: ReviewStatDefinition[];
  coverage: ReviewRangeCoverage;
};

export function collectReviewRangeData(range: ReviewRange): ReviewRangeData {
  const { from, to } = range;
  const captureRows = readCapturesInRange(from, to);
  const attemptRows = readAttemptsInRange(from, to);
  const referenceRows = readReferencesInRange(from, to);

  const captureById = new Map<string, CaptureRow>();
  for (const capture of captureRows) captureById.set(capture.id, capture);

  const attemptById = new Map<string, AttemptRow>();
  for (const attempt of attemptRows) attemptById.set(attempt.id, attempt);

  // 引用记录两端的尝试可能不在范围内，需要补读用于标题/版本/所属念头。
  const referencedAttemptIds: string[] = [];
  for (const reference of referenceRows) {
    if (!attemptById.has(reference.fromAttemptId)) referencedAttemptIds.push(reference.fromAttemptId);
    if (!attemptById.has(reference.toAttemptId)) referencedAttemptIds.push(reference.toAttemptId);
  }
  for (const attempt of readAttemptsByIds(referencedAttemptIds)) {
    attemptById.set(attempt.id, attempt);
  }

  const missingCaptureIds: string[] = [];
  for (const attempt of attemptById.values()) {
    if (!captureById.has(attempt.captureId)) missingCaptureIds.push(attempt.captureId);
  }
  for (const capture of readCapturesByIds(missingCaptureIds)) {
    captureById.set(capture.id, capture);
  }

  const working: WorkingRecord[] = [];

  const pushRecord = (record: ReviewRecord, relevance: number) => {
    record.reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
    working.push({ record, relevance });
  };

  // 念头：范围内创建 / 范围前创建但范围内修改
  for (const capture of captureRows) {
    const reasons: ReviewReason[] = [];
    if (isWithin(capture.createdAt, from, to)) reasons.push('capture_created');
    if (capture.createdAt < from && isWithin(capture.updatedAt, from, to)) {
      reasons.push('capture_modified');
    }
    if (reasons.length === 0) continue;
    let relevance = Number.NEGATIVE_INFINITY;
    if (reasons.includes('capture_created')) relevance = Math.max(relevance, capture.createdAt);
    if (reasons.includes('capture_modified')) relevance = Math.max(relevance, capture.updatedAt);
    pushRecord(
      {
        key: `capture:${capture.id}`,
        type: 'capture',
        sourceId: capture.id,
        captureId: capture.id,
        attemptId: null,
        relatedAttemptId: null,
        title: firstLine(capture.rawText, 120),
        text: capture.rawText,
        resultText: null,
        outcome: null,
        state: null,
        createdAt: capture.createdAt,
        updatedAt: capture.updatedAt,
        observedAt: null,
        revision: capture.revision,
        captureRevision: capture.revision,
        relatedRevision: null,
        archived: capture.archivedAt !== null,
        reasons,
        fromAttemptId: null,
        toAttemptId: null,
        note: null,
      },
      relevance
    );
  }

  // 尝试：开始 / 修改 / 当前已结束 / 结果
  for (const attempt of attemptRows) {
    const reasons: ReviewReason[] = [];
    const createdInRange = isWithin(attempt.createdAt, from, to);
    const updatedInRange = isWithin(attempt.updatedAt, from, to);
    if (createdInRange) reasons.push('attempt_started');
    if (attempt.createdAt < from && updatedInRange) reasons.push('attempt_modified');
    if (
      (attempt.state === 'done' || attempt.state === 'cancelled') &&
      updatedInRange
    ) {
      reasons.push('attempt_current_ended');
    }
    if (hasResult(attempt) && isWithin(attempt.observedAt, from, to)) {
      reasons.push('result_recorded');
    } else if (
      hasResult(attempt) &&
      attempt.observedAt === null &&
      (createdInRange || updatedInRange)
    ) {
      reasons.push('result_time_unknown');
    }
    if (reasons.length === 0) continue;

    let relevance = Number.NEGATIVE_INFINITY;
    if (reasons.includes('attempt_started')) relevance = Math.max(relevance, attempt.createdAt);
    if (reasons.includes('attempt_modified')) relevance = Math.max(relevance, attempt.updatedAt);
    if (reasons.includes('attempt_current_ended')) {
      relevance = Math.max(relevance, attempt.updatedAt);
    }
    if (reasons.includes('result_recorded') && attempt.observedAt !== null) {
      relevance = Math.max(relevance, attempt.observedAt);
    }
    if (reasons.includes('result_time_unknown')) relevance = Math.max(relevance, attempt.updatedAt);
    if (!Number.isFinite(relevance)) relevance = attempt.updatedAt;

    const capture = captureById.get(attempt.captureId);
    pushRecord(
      {
        key: `attempt:${attempt.id}`,
        type: 'attempt',
        sourceId: attempt.id,
        captureId: attempt.captureId,
        attemptId: attempt.id,
        relatedAttemptId: null,
        title: firstLine(attempt.step, 120),
        text: attempt.step,
        resultText: attempt.resultText,
        outcome: normalizeOutcome(attempt.outcome),
        state: normalizeAttemptState(attempt.state),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
        observedAt: attempt.observedAt,
        revision: attempt.revision,
        captureRevision: capture?.revision ?? 1,
        relatedRevision: null,
        archived: capture ? capture.archivedAt !== null : false,
        reasons,
        fromAttemptId: null,
        toAttemptId: null,
        note: null,
      },
      relevance
    );
  }

  // 引用：范围内创建
  for (const reference of referenceRows) {
    const fromAttempt = attemptById.get(reference.fromAttemptId);
    const toAttempt = attemptById.get(reference.toAttemptId);
    if (!fromAttempt || !toAttempt) continue;
    const capture = captureById.get(fromAttempt.captureId);
    pushRecord(
      {
        key: `reference:${reference.id}`,
        type: 'reference',
        sourceId: reference.id,
        captureId: fromAttempt.captureId,
        attemptId: reference.fromAttemptId,
        relatedAttemptId: reference.toAttemptId,
        title: firstLine(toAttempt.step, 120),
        text: fromAttempt.step,
        resultText: reference.snapshotResultText ?? toAttempt.resultText,
        outcome: null,
        state: null,
        createdAt: reference.createdAt,
        updatedAt: null,
        observedAt: null,
        // 引用本身不可修改：revision/relatedRevision 记录两端尝试版本，用于来源变更判断。
        revision: fromAttempt.revision,
        captureRevision: capture?.revision ?? 1,
        relatedRevision: toAttempt.revision,
        archived: capture ? capture.archivedAt !== null : false,
        reasons: ['reference_created'],
        fromAttemptId: reference.fromAttemptId,
        toAttemptId: reference.toAttemptId,
        note: reference.note,
      },
      reference.createdAt
    );
  }

  working.sort((a, b) => b.relevance - a.relevance || a.record.key.localeCompare(b.record.key));
  const allRecords = working.map((entry) => entry.record);

  const stats: ReviewStats = {
    capturesCreated: captureRows.filter((capture) => isWithin(capture.createdAt, from, to)).length,
    capturesModified: captureRows.filter(
      (capture) => capture.createdAt < from && isWithin(capture.updatedAt, from, to)
    ).length,
    attemptsStarted: attemptRows.filter((attempt) => isWithin(attempt.createdAt, from, to)).length,
    attemptsModified: attemptRows.filter(
      (attempt) => attempt.createdAt < from && isWithin(attempt.updatedAt, from, to)
    ).length,
    attemptsCurrentlyEnded: attemptRows.filter(
      (attempt) =>
        (attempt.state === 'done' || attempt.state === 'cancelled') &&
        isWithin(attempt.updatedAt, from, to)
    ).length,
    resultsRecorded: attemptRows.filter(
      (attempt) => hasResult(attempt) && isWithin(attempt.observedAt, from, to)
    ).length,
    resultsMissingObservedAt: attemptRows.filter(
      (attempt) =>
        hasResult(attempt) &&
        attempt.observedAt === null &&
        (isWithin(attempt.createdAt, from, to) || isWithin(attempt.updatedAt, from, to))
    ).length,
    referencesCreated: referenceRows.length,
    totalRecords: allRecords.length,
  };

  const truncated = allRecords.length > REVIEW_MAX_RANGE_RECORDS;
  const records = truncated ? allRecords.slice(0, REVIEW_MAX_RANGE_RECORDS) : allRecords;

  const sections: ReviewSections = {
    captures: [],
    attempts: [],
    results: [],
    references: [],
    modifications: [],
  };
  const sectionSeen: Record<keyof ReviewSections, Set<string>> = {
    captures: new Set(),
    attempts: new Set(),
    results: new Set(),
    references: new Set(),
    modifications: new Set(),
  };
  const pushSection = (section: keyof ReviewSections, key: string) => {
    if (sectionSeen[section].has(key)) return;
    sectionSeen[section].add(key);
    sections[section].push(key);
  };
  for (const record of records) {
    for (const reason of record.reasons) {
      switch (reason) {
        case 'capture_created':
          pushSection('captures', record.key);
          break;
        case 'attempt_started':
        case 'attempt_current_ended':
          pushSection('attempts', record.key);
          break;
        case 'result_recorded':
        case 'result_time_unknown':
          pushSection('results', record.key);
          break;
        case 'reference_created':
          pushSection('references', record.key);
          break;
        case 'capture_modified':
        case 'attempt_modified':
          pushSection('modifications', record.key);
          break;
      }
    }
  }

  const coverage: ReviewRangeCoverage = {
    totalRecords: allRecords.length,
    uniqueKeys: new Set(allRecords.map((record) => record.key)).size,
    truncated,
    maxRangeRecords: REVIEW_MAX_RANGE_RECORDS,
  };

  return { records, sections, stats, statDefinitions: buildStatDefinitions(stats), coverage };
}

export type ReviewRecordsByKeysResult = {
  records: ReviewRecord[];
  missingKeys: string[];
  sections: ReviewSections;
  stats: ReviewStats;
  coverage: ReviewRangeCoverage;
};

/**
 * 按记录键读取范围内记录。records 按传入 keys 顺序返回；sections/stats/coverage
 * 始终描述整个范围（预览的 selected/excluded 由调用方计算）。
 */
export function readReviewRecordsByKeys(
  range: ReviewRange,
  keys: string[]
): ReviewRecordsByKeysResult {
  const data = collectReviewRangeData(range);
  const byKey = new Map(data.records.map((record) => [record.key, record]));
  const records: ReviewRecord[] = [];
  const missingKeys: string[] = [];
  const seen = new Set<string>();
  for (const rawKey of keys) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const record = byKey.get(key);
    if (record) records.push(record);
    else missingKeys.push(key);
  }
  return {
    records,
    missingKeys,
    sections: data.sections,
    stats: data.stats,
    coverage: data.coverage,
  };
}

export function toReviewSources(records: ReviewRecord[]): ReviewSource[] {
  return records.map((record) => ({
    key: record.key,
    type: record.type,
    sourceId: record.sourceId,
    captureId: record.captureId,
    attemptId: record.attemptId,
    relatedAttemptId: record.relatedAttemptId,
    title: record.title,
    text: record.text,
    resultText: record.resultText,
    outcome: record.outcome,
    state: record.state,
    observedAt: record.observedAt,
    revision: record.revision,
    captureRevision: record.captureRevision,
    relatedRevision: record.relatedRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

// ---------- 来源实时状态与公开回顾 ----------

type CurrentSourceStatus =
  | {
      exists: true;
      changed: boolean;
      currentRevision: number;
      currentCaptureRevision: number;
      currentRelatedRevision: number | null;
      openCaptureId: string | null;
      openAttemptId: string | null;
    }
  | { exists: false };

function currentSourceStatus(source: ReviewSource): CurrentSourceStatus {
  if (source.type === 'capture') {
    const capture = readCaptureRow(source.sourceId);
    if (!capture) return { exists: false };
    return {
      exists: true,
      changed: capture.revision !== source.captureRevision,
      currentRevision: capture.revision,
      currentCaptureRevision: capture.revision,
      currentRelatedRevision: null,
      openCaptureId: capture.id,
      openAttemptId: null,
    };
  }

  if (source.type === 'attempt') {
    const attempt = readAttemptRow(source.sourceId);
    if (!attempt) return { exists: false };
    const capture = readCaptureRow(attempt.captureId);
    if (!capture) return { exists: false };
    return {
      exists: true,
      changed:
        attempt.revision !== source.revision ||
        capture.revision !== source.captureRevision,
      currentRevision: attempt.revision,
      currentCaptureRevision: capture.revision,
      currentRelatedRevision: null,
      openCaptureId: attempt.captureId,
      openAttemptId: attempt.id,
    };
  }

  if (source.type === 'reference') {
    const reference = readReferenceRow(source.sourceId);
    if (!reference) return { exists: false };
    const fromAttempt = readAttemptRow(reference.fromAttemptId);
    const toAttempt = readAttemptRow(reference.toAttemptId);
    if (!fromAttempt || !toAttempt) return { exists: false };
    const capture = readCaptureRow(fromAttempt.captureId);
    if (!capture) return { exists: false };
    return {
      exists: true,
      changed:
        fromAttempt.revision !== source.revision ||
        toAttempt.revision !== source.relatedRevision ||
        capture.revision !== source.captureRevision,
      currentRevision: fromAttempt.revision,
      currentCaptureRevision: capture.revision,
      currentRelatedRevision: toAttempt.revision,
      openCaptureId: fromAttempt.captureId,
      openAttemptId: fromAttempt.id,
    };
  }

  return { exists: false };
}

/**
 * 已删除来源只保留 key/type/sourceId/deleted，绝不回显快照正文。
 * ReviewSourcePublic 的完整字段在删除态下没有值，这里按契约做最小响应。
 */
function deletedSourcePublic(source: Partial<ReviewSource>): ReviewSourcePublic {
  const type = typeof source.type === 'string' ? source.type : 'capture';
  const sourceId = typeof source.sourceId === 'string' ? source.sourceId : '';
  return {
    key: typeof source.key === 'string' ? source.key : `${type}:${sourceId}`,
    type,
    sourceId,
    deleted: true,
    exists: false,
  } as unknown as ReviewSourcePublic;
}

function normalizePreset(value: string): ReviewPreset {
  return value === '7d' || value === '30d' ? value : 'custom';
}

function parseUsage(
  raw: string | null
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  const parsed = parseJson<{ inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }>(
    raw
  );
  if (!parsed || typeof parsed !== 'object') return null;
  const inputTokens = typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0;
  const outputTokens = typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0;
  const totalTokens =
    typeof parsed.totalTokens === 'number' ? parsed.totalTokens : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

export function publicReviewOf(row: StageReview): ReviewPublic {
  const stats = parseJson<ReviewStats>(row.statsJson);
  const coverage = parseJson<ReviewPreviewCoverage>(row.coverageJson);
  const content = parseJson<ReviewContent>(row.contentJson);
  const storedSources = parseJson<ReviewSource[]>(row.sourcesJson);
  const rawSources = Array.isArray(storedSources) ? storedSources : [];

  const sources: ReviewSourcePublic[] = [];
  for (const source of rawSources) {
    if (!source || typeof source !== 'object') continue;
    if (source.deleted === true) {
      sources.push(deletedSourcePublic(source));
      continue;
    }
    const status = currentSourceStatus(source);
    if (!status.exists) {
      sources.push(deletedSourcePublic(source));
      continue;
    }
    sources.push({
      ...source,
      exists: true,
      changed: status.changed,
      deleted: false,
      currentRevision: status.currentRevision,
      currentCaptureRevision: status.currentCaptureRevision,
      currentRelatedRevision: status.currentRelatedRevision,
      openCaptureId: status.openCaptureId,
      openAttemptId: status.openAttemptId,
    });
  }

  const sourcesChanged = sources.some(
    (source) => source.deleted === true || source.changed === true
  );
  const contentInvalidated =
    row.contentInvalidatedAt !== null || sources.some((source) => source.deleted === true);

  const config: ReviewAiConfig | null =
    row.configId && row.configName && row.modelId && row.configVersion !== null
      ? {
          id: row.configId,
          name: row.configName,
          modelId: row.modelId,
          configVersion: row.configVersion,
        }
      : null;

  const errorMessage = row.errorCode
    ? (row.errorDetail ?? errorMessageForCode(row.errorCode as AiErrorCode))
    : null;

  return {
    id: row.id,
    status: row.status as ReviewPublic['status'],
    range: makeReviewRange({
      from: row.rangeFrom,
      to: row.rangeTo,
      timezone: row.timezone,
      preset: normalizePreset(row.rangePreset),
    }),
    config,
    stats: stats && typeof stats === 'object' ? stats : null,
    coverage: coverage && typeof coverage === 'object' ? coverage : null,
    content: contentInvalidated ? null : content && typeof content === 'object' ? content : null,
    sources,
    savedAt: row.savedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorMessage,
    usage: parseUsage(row.usageJson),
    durationMs: row.durationMs,
    contentInvalidated,
    contentInvalidReason: row.contentInvalidReason,
    sourcesChanged,
    canSave: row.status === 'succeeded' && content !== null && row.savedAt === null,
  };
}

// ---------- 已保存回顾列表 ----------

function readSavedReviewRows(limit: number): StageReview[] {
  return sqlite
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM stage_reviews
        WHERE saved_at IS NOT NULL
        ORDER BY saved_at DESC, created_at DESC
        LIMIT ?`
    )
    .all(limit) as StageReview[];
}

function countSavedReviews(): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM stage_reviews WHERE saved_at IS NOT NULL')
    .get() as { count: number };
  return row.count;
}

function listItemOf(row: StageReview): ReviewListItem {
  const review = publicReviewOf(row);
  return {
    id: review.id,
    range: review.range,
    savedAt: review.savedAt ?? row.updatedAt,
    createdAt: review.createdAt,
    overview: review.content?.overview ?? '',
    stats: review.stats,
    contentInvalidated: review.contentInvalidated,
    sourceCount: review.sources.length,
    changedSourceCount: review.sources.filter(
      (source) => source.deleted === true || source.changed === true
    ).length,
  };
}

// ---------- 导出 ----------

/** 只导出用户已保存的回顾；JSON 字段为结构化对象（stats/coverage/content/sources）。 */
export function getReviewExportRows(): unknown[] {
  const rows = sqlite
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM stage_reviews
        WHERE saved_at IS NOT NULL
        ORDER BY saved_at ASC, id ASC`
    )
    .all() as StageReview[];
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    rangeFrom: row.rangeFrom,
    rangeTo: row.rangeTo,
    timezone: row.timezone,
    preset: row.rangePreset,
    stats: parseJson<ReviewStats>(row.statsJson),
    coverage: parseJson<ReviewPreviewCoverage>(row.coverageJson),
    // 来源删除后无法可靠拆分生成段落，导出时同样撤下整段模型正文。
    content:
      row.contentInvalidatedAt !== null ? null : parseJson<ReviewContent>(row.contentJson),
    contentInvalidatedAt: row.contentInvalidatedAt,
    contentInvalidReason: row.contentInvalidReason,
    sources: parseJson<ReviewSource[]>(row.sourcesJson),
    configName: row.configName,
    modelId: row.modelId,
    savedAt: row.savedAt,
    createdAt: row.createdAt,
  }));
}

// ---------- 服务启动恢复 ----------

/** 服务启动时所有 pending → interrupted。 */
export function markInterruptedReviews(): number {
  const now = Date.now();
  const result = sqlite
    .prepare(
      `UPDATE stage_reviews
          SET status = 'interrupted', error_code = 'interrupted', error_detail = ?,
              finished_at = ?, updated_at = ?
        WHERE status = 'pending'`
    )
    .run(INTERRUPTED_DETAIL, now, now);
  return result.changes;
}

// ---------- 删除清洗 ----------

type StoredSource = {
  key?: unknown;
  type?: unknown;
  sourceId?: unknown;
  attemptId?: unknown;
  relatedAttemptId?: unknown;
  deleted?: unknown;
};

function cleanReviewSources(predicate: (source: StoredSource) => boolean): number {
  const rows = sqlite
    .prepare('SELECT id, sources_json AS sourcesJson FROM stage_reviews WHERE sources_json IS NOT NULL')
    .all() as Array<{ id: string; sourcesJson: string | null }>;
  if (rows.length === 0) return 0;

  const update = sqlite.prepare(
    `UPDATE stage_reviews
        SET sources_json = ?, content_invalidated_at = ?, content_invalid_reason = ?,
            updated_at = ?
      WHERE id = ?`
  );
  const now = Date.now();
  let changed = 0;

  for (const row of rows) {
    const parsed = parseJson<unknown>(row.sourcesJson);
    if (!Array.isArray(parsed)) continue;
    let touched = false;
    const next = parsed.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const source = item as StoredSource;
      if (!predicate(source)) return item;
      if (source.deleted === true) return item;
      touched = true;
      const type = typeof source.type === 'string' ? source.type : 'unknown';
      const sourceId = typeof source.sourceId === 'string' ? source.sourceId : '';
      return {
        key: typeof source.key === 'string' ? source.key : `${type}:${sourceId}`,
        type,
        sourceId,
        deleted: true,
      };
    });
    if (!touched) continue;
    update.run(JSON.stringify(next), now, DELETED_SOURCE_REASON, now, row.id);
    changed += 1;
  }
  return changed;
}

/**
 * 删除尝试前调用：清洗 type=attempt 且 sourceId 命中，以及 type=reference 且
 * attemptId/relatedAttemptId 命中的来源。同步实现，可直接在 sqlite.transaction 内调用。
 */
export function invalidateStageReviewSourcesForDeletedAttempts(attemptIds: string[]): number {
  const targets = new Set(
    (Array.isArray(attemptIds) ? attemptIds : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    )
  );
  if (targets.size === 0) return 0;
  return cleanReviewSources((source) => {
    const type = typeof source.type === 'string' ? source.type : '';
    const sourceId = typeof source.sourceId === 'string' ? source.sourceId : '';
    if (type === 'attempt' && targets.has(sourceId)) return true;
    if (type === 'reference') {
      const attemptId = typeof source.attemptId === 'string' ? source.attemptId : '';
      const relatedAttemptId =
        typeof source.relatedAttemptId === 'string' ? source.relatedAttemptId : '';
      if (targets.has(attemptId) || targets.has(relatedAttemptId)) return true;
    }
    return false;
  });
}

/**
 * 删除念头前（先清洗该念头所有尝试后）调用：清洗 type=capture 且 sourceId 命中的来源。
 * 同步实现，可直接在 sqlite.transaction 内调用。
 */
export function invalidateStageReviewSourcesForDeletedCapture(captureId: string): number {
  if (!captureId) return 0;
  return cleanReviewSources((source) => {
    const type = typeof source.type === 'string' ? source.type : '';
    const sourceId = typeof source.sourceId === 'string' ? source.sourceId : '';
    return type === 'capture' && sourceId === captureId;
  });
}

// ---------- 路由 ----------

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? 'error'));
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
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

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

function parseListLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, n);
}

function saveFingerprint(reviewId: string): string {
  return sha256(JSON.stringify({ op: 'review-save', reviewId }));
}

function dateKeyInTimezone(ms: number, timezone: string): string {
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

function enumerateDateKeysInRange(
  from: number,
  to: number,
  timezone: string,
  maxKeys = 380
): string[] {
  const startKey = dateKeyInTimezone(from, timezone);
  const endKey = dateKeyInTimezone(Math.max(from, to - 1), timezone);
  const keys: string[] = [];
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const cursor = new Date(Date.UTC(sy, sm - 1, sd));
  const endUtc = new Date(Date.UTC(ey, em - 1, ed));
  while (cursor.getTime() <= endUtc.getTime() && keys.length <= maxKeys) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    keys.push(`${y}-${m}-${d}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

type DailyBucket = {
  date: string;
  capturesCount: number;
  attemptsCount: number;
  aiCount: number;
  aiTokens: number;
  aiBreakdown: {
    generations: number;
    reviews: number;
    asks: number;
    research: number;
    assist: number;
  };
};

function parseTotalTokens(usageJson: string | null): number {
  const parsed = parseJson<{ totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown }>(
    usageJson
  );
  if (!parsed) return 0;
  if (typeof parsed.totalTokens === 'number' && Number.isFinite(parsed.totalTokens)) {
    return Math.max(0, Math.round(parsed.totalTokens));
  }
  const inp = typeof parsed.inputTokens === 'number' && Number.isFinite(parsed.inputTokens) ? parsed.inputTokens : 0;
  const out = typeof parsed.outputTokens === 'number' && Number.isFinite(parsed.outputTokens) ? parsed.outputTokens : 0;
  return Math.max(0, Math.round(inp + out));
}

function collectReviewDailyData(range: ReviewRange) {
  const keys = enumerateDateKeysInRange(range.from, range.to, range.timezone);
  const map = new Map<string, DailyBucket>();
  for (const date of keys) {
    map.set(date, {
      date,
      capturesCount: 0,
      attemptsCount: 0,
      aiCount: 0,
      aiTokens: 0,
      aiBreakdown: { generations: 0, reviews: 0, asks: 0, research: 0, assist: 0 },
    });
  }

  const capRows = sqlite
    .prepare('SELECT created_at AS createdAt FROM captures WHERE created_at >= ? AND created_at < ?')
    .all(range.from, range.to) as Array<{ createdAt: number }>;
  for (const r of capRows) {
    const b = map.get(dateKeyInTimezone(r.createdAt, range.timezone));
    if (b) b.capturesCount += 1;
  }

  const attRows = sqlite
    .prepare('SELECT created_at AS createdAt FROM attempts WHERE created_at >= ? AND created_at < ?')
    .all(range.from, range.to) as Array<{ createdAt: number }>;
  for (const r of attRows) {
    const b = map.get(dateKeyInTimezone(r.createdAt, range.timezone));
    if (b) b.attemptsCount += 1;
  }

  const aiTables: Array<{
    sql: string;
    field: keyof DailyBucket['aiBreakdown'];
  }> = [
    {
      sql: 'SELECT created_at AS createdAt, usage_json AS usageJson FROM ai_generations WHERE created_at >= ? AND created_at < ?',
      field: 'generations',
    },
    {
      sql: 'SELECT created_at AS createdAt, usage_json AS usageJson FROM stage_reviews WHERE created_at >= ? AND created_at < ?',
      field: 'reviews',
    },
    {
      sql: 'SELECT created_at AS createdAt, usage_json AS usageJson FROM record_queries WHERE created_at >= ? AND created_at < ?',
      field: 'asks',
    },
    {
      sql: 'SELECT created_at AS createdAt, usage_json AS usageJson FROM research_runs WHERE created_at >= ? AND created_at < ?',
      field: 'research',
    },
    {
      sql: 'SELECT created_at AS createdAt, usage_json AS usageJson FROM ai_assist_logs WHERE created_at >= ? AND created_at < ?',
      field: 'assist',
    },
  ];

  for (const { sql, field } of aiTables) {
    const rows = sqlite.prepare(sql).all(range.from, range.to) as Array<{
      createdAt: number;
      usageJson: string | null;
    }>;
    for (const r of rows) {
      const b = map.get(dateKeyInTimezone(r.createdAt, range.timezone));
      if (!b) continue;
      b.aiCount += 1;
      b.aiBreakdown[field] += 1;
      b.aiTokens += parseTotalTokens(r.usageJson);
    }
  }

  return {
    today: dateKeyInTimezone(Date.now(), range.timezone),
    days: keys.map((k) => map.get(k)!),
  };
}

export function registerReviewRoutes(fastify: FastifyInstance): void {
  // GET /api/review/range?from=&to=&timezone=&preset=
  fastify.get('/api/review/range', { preHandler: requireAuth }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const parsed = parseReviewRange({
      from: query.from,
      to: query.to,
      timezone: query.timezone,
      preset: query.preset,
    });
    if (!parsed.ok) {
      return reply.code(parsed.status).send({
        error: parsed.error,
        ...(parsed.field ? { field: parsed.field } : {}),
        message: parsed.message,
      });
    }

    try {
      const range = makeReviewRange(parsed.value);
      const data = collectReviewRangeData(range);
      const settings = await getSettingsRow();
      const configured = Boolean(settings && settings.apiKeyCiphertext);
      const ai: ReviewAiSummary = {
        configured,
        enabled: configured ? settings!.enabled === 1 : false,
        config: configured
          ? {
              id: settings!.id,
              name: settings!.name,
              modelId: settings!.modelId,
              configVersion: settings!.configVersion,
            }
          : null,
      };
      return {
        range,
        stats: data.stats,
        statDefinitions: data.statDefinitions,
        records: data.records,
        sections: data.sections,
        coverage: data.coverage,
        limits: {
          maxRecords: REVIEW_MAX_RECORDS,
          maxChars: REVIEW_MAX_CHARS,
          maxRangeDays: REVIEW_MAX_RANGE_DAYS,
        },
        ai,
        generatedAt: Date.now(),
      };
    } catch (error) {
      req.log.error({ err: error }, 'review range failed');
      return reply.code(500).send({
        error: 'internal_error',
        message: '读取阶段回顾数据失败，请稍后重试。',
      });
    }
  });

  // GET /api/review/daily?from=&to=&timezone=&preset= —— 每日念头活动与 AI 调用统计（支持近 12 个月 53 周视图）
  fastify.get('/api/review/daily', { preHandler: requireAuth }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const parsed = parseReviewRange(
      {
        from: query.from,
        to: query.to,
        timezone: query.timezone,
        preset: query.preset,
      },
      380
    );
    if (!parsed.ok) {
      return reply.code(parsed.status).send({
        error: parsed.error,
        ...(parsed.field ? { field: parsed.field } : {}),
        message: parsed.message,
      });
    }
    try {
      const range = makeReviewRange(parsed.value);
      const daily = collectReviewDailyData(range);
      return { range, ...daily };
    } catch (error) {
      req.log.error({ err: error }, 'review daily failed');
      return reply.code(500).send({
        error: 'internal_error',
        message: '读取每日统计失败，请稍后重试。',
      });
    }
  });

  // GET /api/reviews?limit=1..50 —— 只列已保存
  fastify.get('/api/reviews', { preHandler: requireAuth }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const limit = parseListLimit(query.limit);
    try {
      const total = countSavedReviews();
      const reviews = readSavedReviewRows(limit).map(listItemOf);
      return { total, reviews };
    } catch (error) {
      req.log.error({ err: error }, 'review list failed');
      return reply.code(500).send({
        error: 'internal_error',
        message: '读取已保存回顾失败，请稍后重试。',
      });
    }
  });

  // GET /api/reviews/:id
  fastify.get('/api/reviews/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = readReviewRow(id);
    if (!row) {
      return reply.code(404).send({ error: 'review_not_found', message: '回顾不存在。' });
    }
    return { review: publicReviewOf(row) };
  });

  // POST /api/reviews/:id/save
  fastify.post('/api/reviews/:id/save', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { operationId?: unknown };

    let operationId: string | null = null;
    if (body.operationId !== undefined && body.operationId !== null && body.operationId !== '') {
      if (typeof body.operationId !== 'string') {
        return reply.code(400).send({
          error: 'invalid_request',
          field: 'operationId',
          message: 'operationId 必须是字符串。',
        });
      }
      const trimmed = body.operationId.trim();
      if (!trimmed || trimmed.length > 200) {
        return reply.code(400).send({
          error: 'invalid_request',
          field: 'operationId',
          message: 'operationId 需为 1–200 个字符。',
        });
      }
      operationId = trimmed;
    }

    const initial = readReviewRow(id);
    if (!initial) {
      return reply.code(404).send({ error: 'review_not_found', message: '回顾不存在。' });
    }
    if (initial.savedAt !== null) {
      return { review: publicReviewOf(initial), replayed: true };
    }
    if (initial.status !== 'succeeded' || !parseJson<ReviewContent>(initial.contentJson)) {
      return reply
        .code(409)
        .send({ error: 'not_savable', message: '只有生成成功且有内容的回顾才能保存。' });
    }

    const requestFingerprint = saveFingerprint(id);
    if (operationId) {
      const receipt = getReceipt(operationId);
      if (receipt) {
        if (
          receipt.target_type !== 'review_save' ||
          receipt.request_fingerprint !== requestFingerprint
        ) {
          return reply.code(409).send({
            error: 'operation_key_conflict',
            message: 'operationId 已被另一个请求使用。',
          });
        }
        const stored = parseJson<{ reviewId?: string }>(receipt.response_json);
        const target = stored?.reviewId ? readReviewRow(stored.reviewId) : undefined;
        if (target && target.savedAt !== null) {
          return { review: publicReviewOf(target), replayed: true };
        }
      }
    }

    const now = Date.now();
    try {
      const outcome = sqlite.transaction(() => {
        const current = readReviewRow(id);
        if (!current) {
          throw new HttpError(404, { error: 'review_not_found', message: '回顾不存在。' });
        }
        if (current.savedAt !== null) {
          return { saved: false, row: current };
        }
        if (current.status !== 'succeeded' || !parseJson<ReviewContent>(current.contentJson)) {
          throw new HttpError(409, {
            error: 'not_savable',
            message: '只有生成成功且有内容的回顾才能保存。',
          });
        }

        if (operationId) {
          const receipt = getReceipt(operationId);
          if (receipt) {
            if (
              receipt.target_type !== 'review_save' ||
              receipt.request_fingerprint !== requestFingerprint
            ) {
              throw new HttpError(409, {
                error: 'operation_key_conflict',
                message: 'operationId 已被另一个请求使用。',
              });
            }
            const stored = parseJson<{ reviewId?: string }>(receipt.response_json);
            const target = stored?.reviewId ? readReviewRow(stored.reviewId) : undefined;
            if (target && target.savedAt !== null) {
              return { saved: false, row: target };
            }
          }
        }

        const result = sqlite
          .prepare(
            `UPDATE stage_reviews SET saved_at = ?, updated_at = ?
              WHERE id = ? AND saved_at IS NULL`
          )
          .run(now, now, id);
        if (result.changes !== 1) {
          const raced = readReviewRow(id);
          if (raced && raced.savedAt !== null) return { saved: false, row: raced };
          throw new HttpError(409, {
            error: 'not_savable',
            message: '只有生成成功且有内容的回顾才能保存。',
          });
        }

        if (operationId) {
          sqlite
            .prepare(
              `INSERT INTO mutation_receipts
                 (operation_key, target_type, request_fingerprint, response_json, created_at)
               VALUES (?, 'review_save', ?, ?, ?)`
            )
            .run(operationId, requestFingerprint, JSON.stringify({ reviewId: id }), now);
        }

        const updated = readReviewRow(id);
        if (!updated) {
          throw new HttpError(404, { error: 'review_not_found', message: '回顾不存在。' });
        }
        return { saved: true, row: updated };
      })();

      return {
        review: publicReviewOf(outcome.row),
        replayed: outcome.saved === false,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.status).send(error.body);
      }
      // 并发下 operationId 回执已写入：按回执回放
      if (operationId) {
        const raced = getReceipt(operationId);
        if (raced) {
          if (
            raced.target_type !== 'review_save' ||
            raced.request_fingerprint !== requestFingerprint
          ) {
            return reply.code(409).send({
              error: 'operation_key_conflict',
              message: 'operationId 已被另一个请求使用。',
            });
          }
          const stored = parseJson<{ reviewId?: string }>(raced.response_json);
          const target = stored?.reviewId ? readReviewRow(stored.reviewId) : undefined;
          if (target && target.savedAt !== null) {
            return { review: publicReviewOf(target), replayed: true };
          }
        }
      }
      req.log.error({ err: error, reviewId: id }, 'review save failed');
      return reply.code(500).send({
        error: 'internal_error',
        message: '保存回顾失败，请稍后重试。',
      });
    }
  });
}
