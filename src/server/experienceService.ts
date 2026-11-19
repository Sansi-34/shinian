// 拾念 SHINIAN · 经验笔记数据层
// 经验复用 captures 行（kind='experience'），因此稳定 ID、手动关联、图谱、归档、删除与导出都走既有链路。
// 这里只处理经验特有的：标题/条件/限制、依据快照、参考经验的尝试、来源失效清洗。
import { createHash } from 'node:crypto';
import { sqlite } from '../db/db';
import type {
  ExperienceAttemptPublic,
  ExperienceDraft,
  ExperienceDraftSource,
  ExperienceImpact,
  ExperienceListItem,
  ExperienceModelBasis,
  ExperienceOriginKind,
  ExperiencePublic,
  ExperienceSearchHit,
  ExperienceSourcePublic,
} from './experienceTypes';
import {
  EXPERIENCE_CONDITIONS_MAX,
  EXPERIENCE_LIMITATIONS_MAX,
  EXPERIENCE_MAX_SOURCES,
  EXPERIENCE_TITLE_MAX,
  EXPERIENCE_UNDERSTANDING_MAX,
} from './experienceTypes';

export class ExperienceHttpError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? 'experience error'));
    this.status = status;
    this.body = body;
  }
}

type CaptureRow = {
  id: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  kind: string;
};

type NoteRow = {
  capture_id: string;
  title: string;
  understanding_origin: string;
  model_basis: string | null;
  origin_kind: string;
  origin_query_id: string | null;
  origin_point_index: number | null;
  origin_attempt_id: string | null;
  context_capture_id: string | null;
  conditions_text: string | null;
  limitations_text: string | null;
  needs_revision: number;
  revision_reason: string | null;
  created_at: number;
  updated_at: number;
};

type SourceRow = {
  id: string;
  experience_id: string;
  source_key: string;
  source_type: string;
  source_id: string;
  source_capture_id: string | null;
  source_title: string;
  source_text: string;
  source_result_text: string | null;
  outcome: string | null;
  state: string | null;
  observed_at: number | null;
  source_revision: number;
  source_capture_revision: number | null;
  source_kind: string | null;
  deleted: number;
  created_at: number;
  updated_at: number;
};

type AttemptSourceRow = {
  id: string;
  captureId: string;
  step: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
  observedAt: number | null;
  createdAt: number;
  revision: number;
  captureText: string;
  captureRevision: number;
  captureKind: string;
};

type ExperienceAttemptRow = {
  attempt_id: string;
  experience_capture_id: string;
  adopted_version: number;
  adopted_title: string;
  adopted_understanding: string;
  basis_source_keys_json: string | null;
  deleted: number;
  created_at: number;
};

type AskQueryRow = {
  id: string;
  question: string;
  status: string;
  answerJson: string | null;
  sourcesJson: string | null;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

function firstLine(value: string, max: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function cleanText(value: unknown, field: string, max: number, required: boolean): string {
  if (value == null) {
    if (required) {
      throw new ExperienceHttpError(400, {
        error: 'invalid_request',
        message: `${field}不能为空。`,
        field,
      });
    }
    return '';
  }
  if (typeof value !== 'string') {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: `${field}格式不正确。`,
      field,
    });
  }
  const text = value.trim();
  if (required && text.length === 0) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: `${field}不能为空。`,
      field,
    });
  }
  if (text.length > max) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: `${field}最多 ${max} 字。`,
      field,
    });
  }
  return text;
}

function newCaptureId(): string {
  return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getReceipt(operationKey: string) {
  return sqlite.prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?').get(operationKey) as
    | {
        operation_key: string;
        target_type: string;
        request_fingerprint: string;
        response_json: string;
      }
    | undefined;
}

function replay<T>(receipt: { request_fingerprint: string; response_json: string }, fp: string, target: string): T {
  if (receipt.request_fingerprint !== fp) {
    throw new ExperienceHttpError(409, {
      error: 'operation_conflict',
      message: '这个操作编号已经用于另一份内容，请重新打开编辑面板后再保存。',
    });
  }
  void target;
  return JSON.parse(receipt.response_json) as T;
}

function readCapture(id: string): CaptureRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, raw_text AS rawText, revision, created_at AS createdAt,
              updated_at AS updatedAt, archived_at AS archivedAt, kind
         FROM captures WHERE id = ?`
    )
    .get(id) as CaptureRow | undefined;
}

function readNote(captureId: string): NoteRow | undefined {
  return sqlite
    .prepare('SELECT * FROM experience_notes WHERE capture_id = ?')
    .get(captureId) as NoteRow | undefined;
}

function readSourceRows(experienceId: string): SourceRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM experience_sources WHERE experience_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(experienceId) as SourceRow[];
}

function readAttemptSource(id: string): AttemptSourceRow | undefined {
  return sqlite
    .prepare(
      `SELECT a.id, a.capture_id AS captureId, a.step, a.state,
              a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
              a.created_at AS createdAt, a.revision,
              c.raw_text AS captureText, c.revision AS captureRevision, c.kind AS captureKind
         FROM attempts a JOIN captures c ON c.id = a.capture_id
        WHERE a.id = ?`
    )
    .get(id) as AttemptSourceRow | undefined;
}

function normalizeSourceKey(raw: unknown): string {
  const key = String(raw ?? '').trim();
  if (!/^(attempt|capture):[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: '来源记录格式不正确。',
      field: 'sourceKeys',
    });
  }
  return key;
}

function normalizeSourceKeys(raw: unknown, field = 'sourceKeys'): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: '来源记录格式不正确。',
      field,
    });
  }
  const keys = Array.from(new Set(raw.map(normalizeSourceKey)));
  if (keys.length > EXPERIENCE_MAX_SOURCES) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: `最多关联 ${EXPERIENCE_MAX_SOURCES} 条来源记录。`,
      field,
    });
  }
  return keys;
}

/** 读取来源当前内容并生成采用时快照。来源必须可访问。 */
function buildSourceSnapshot(sourceKey: string): {
  sourceType: 'attempt' | 'capture';
  sourceId: string;
  sourceCaptureId: string | null;
  sourceTitle: string;
  sourceText: string;
  sourceResultText: string | null;
  outcome: string | null;
  state: string | null;
  observedAt: number | null;
  sourceRevision: number;
  sourceCaptureRevision: number | null;
  sourceKind: 'attempt' | 'thought' | 'experience';
} {
  const [type, id] = sourceKey.split(':') as ['attempt' | 'capture', string];
  if (type === 'attempt') {
    const row = readAttemptSource(id);
    if (!row) {
      throw new ExperienceHttpError(409, {
        error: 'source_unavailable',
        message: '有来源记录已被删除，请刷新后重新选择。',
        sourceKeys: [sourceKey],
      });
    }
    return {
      sourceType: 'attempt',
      sourceId: id,
      sourceCaptureId: row.captureId,
      sourceTitle: firstLine(row.step, 200),
      sourceText: row.step,
      sourceResultText: row.resultText,
      outcome: row.outcome,
      state: row.state,
      observedAt: row.observedAt,
      sourceRevision: row.revision,
      sourceCaptureRevision: row.captureRevision,
      sourceKind: 'attempt',
    };
  }
  const row = readCapture(id);
  if (!row) {
    throw new ExperienceHttpError(409, {
      error: 'source_unavailable',
      message: '有来源记录已被删除，请刷新后重新选择。',
      sourceKeys: [sourceKey],
    });
  }
  const note = row.kind === 'experience' ? readNote(id) : undefined;
  return {
    sourceType: 'capture',
    sourceId: id,
    sourceCaptureId: id,
    sourceTitle: note ? note.title : firstLine(row.rawText, 200),
    sourceText: row.rawText,
    sourceResultText: null,
    outcome: null,
    state: null,
    observedAt: null,
    sourceRevision: row.revision,
    sourceCaptureRevision: row.revision,
    sourceKind: row.kind === 'experience' ? 'experience' : 'thought',
  };
}

function sourcePublic(row: SourceRow): ExperienceSourcePublic {
  if (row.deleted) {
    return {
      sourceKey: row.source_key,
      type: row.source_type as 'attempt' | 'capture',
      id: row.source_id,
      captureId: row.source_capture_id,
      title: '来源已删除',
      text: '',
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      deleted: true,
      exists: false,
      changed: false,
      kind: 'unknown',
      openHref: null,
      graphHref: null,
      canReference: false,
      addedAt: row.created_at,
    };
  }

  if (row.source_type === 'attempt') {
    const current = readAttemptSource(row.source_id);
    if (!current) {
      return {
        sourceKey: row.source_key,
        type: 'attempt',
        id: row.source_id,
        captureId: row.source_capture_id,
        title: '来源已删除',
        text: '',
        resultText: null,
        outcome: null,
        state: null,
        observedAt: null,
        deleted: true,
        exists: false,
        changed: false,
        kind: 'unknown',
        openHref: null,
        graphHref: null,
        canReference: false,
        addedAt: row.created_at,
      };
    }
    const changed =
      current.revision > row.source_revision ||
      current.captureRevision > (row.source_capture_revision ?? current.captureRevision);
    return {
      sourceKey: row.source_key,
      type: 'attempt',
      id: row.source_id,
      captureId: current.captureId,
      title: firstLine(current.step, 160),
      text: current.step,
      resultText: current.resultText,
      outcome: current.outcome,
      state: current.state,
      observedAt: current.observedAt,
      deleted: false,
      exists: true,
      changed,
      kind: 'attempt',
      openHref: `/attempt/${current.id}`,
      graphHref: `/graph?focus=attempt:${current.id}`,
      canReference: Boolean(current.resultText && current.resultText.trim()),
      addedAt: row.created_at,
    };
  }

  const current = readCapture(row.source_id);
  if (!current) {
    return {
      sourceKey: row.source_key,
      type: 'capture',
      id: row.source_id,
      captureId: row.source_capture_id,
      title: '来源已删除',
      text: '',
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      deleted: true,
      exists: false,
      changed: false,
      kind: 'unknown',
      openHref: null,
      graphHref: null,
      canReference: false,
      addedAt: row.created_at,
    };
  }
  const note = current.kind === 'experience' ? readNote(current.id) : undefined;
  const changed = current.revision > row.source_revision;
  return {
    sourceKey: row.source_key,
    type: 'capture',
    id: current.id,
    captureId: current.id,
    title: note ? note.title : firstLine(current.rawText, 160),
    text: current.rawText,
    resultText: null,
    outcome: null,
    state: null,
    observedAt: null,
    deleted: false,
    exists: true,
    changed,
    kind: current.kind === 'experience' ? 'experience' : 'thought',
    openHref: current.kind === 'experience' ? `/experience/${current.id}` : `/capture/${current.id}`,
    graphHref: `/graph?focus=${current.kind === 'experience' ? 'experience' : 'capture'}:${current.id}`,
    canReference: false,
    addedAt: row.created_at,
  };
}

function readExperienceAttempts(experienceId: string): ExperienceAttemptPublic[] {
  const rows = sqlite
    .prepare(
      `SELECT ea.*, a.step, a.state, a.result_text AS resultText, a.outcome,
              a.observed_at AS observedAt, a.created_at AS attemptCreatedAt
         FROM experience_attempts ea
         LEFT JOIN attempts a ON a.id = ea.attempt_id
        WHERE ea.experience_capture_id = ?
        ORDER BY ea.created_at ASC, ea.attempt_id ASC`
    )
    .all(experienceId) as Array<
    ExperienceAttemptRow & {
      step: string | null;
      state: string | null;
      resultText: string | null;
      outcome: string | null;
      observedAt: number | null;
      attemptCreatedAt: number | null;
    }
  >;
  return rows.map((row) => ({
    id: row.attempt_id,
    title: row.step ?? '这次尝试已删除',
    state: row.state ?? 'todo',
    resultText: row.deleted ? null : row.resultText,
    outcome: row.deleted ? null : row.outcome,
    observedAt: row.observedAt,
    createdAt: row.attemptCreatedAt ?? row.created_at,
    adoptedVersion: row.adopted_version,
    adoptedTitle: row.adopted_title,
    adoptedUnderstanding: row.adopted_understanding,
    basisSourceKeys: parseJson<string[]>(row.basis_source_keys_json) ?? [],
    deleted: Boolean(row.deleted),
  }));
}

function listNoteRows(options: { archived: 'exclude' | 'include' | 'only'; limit: number; q?: string }): {
  note: NoteRow;
  capture: CaptureRow;
}[] {
  const conditions: string[] = ["c.kind = 'experience'"];
  const params: unknown[] = [];
  if (options.archived === 'exclude') conditions.push('c.archived_at IS NULL');
  if (options.archived === 'only') conditions.push('c.archived_at IS NOT NULL');
  if (options.q) {
    conditions.push(
      '(LOWER(n.title) LIKE ? OR LOWER(c.raw_text) LIKE ? OR LOWER(COALESCE(n.conditions_text, \'\')) LIKE ? OR LOWER(COALESCE(n.limitations_text, \'\')) LIKE ?)'
    );
    const q = `%${options.q.toLowerCase()}%`;
    params.push(q, q, q, q);
  }
  const rows = sqlite
    .prepare(
      `SELECT n.*, c.raw_text AS rawText, c.revision, c.created_at AS createdAt,
              c.updated_at AS updatedAt, c.archived_at AS archivedAt, c.kind
         FROM experience_notes n JOIN captures c ON c.id = n.capture_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?`
    )
    .all(...params, options.limit) as Array<NoteRow & CaptureRow>;
  return rows.map((row) => ({
    note: row,
    capture: {
      id: row.capture_id,
      rawText: row.rawText,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      kind: row.kind,
    },
  }));
}

function listItemOf(note: NoteRow, capture: CaptureRow): ExperienceListItem {
  const sourceRows = readSourceRows(capture.id);
  const active = sourceRows.filter((row) => !row.deleted);
  const attemptsCount = (
    sqlite
      .prepare('SELECT COUNT(*) AS c FROM experience_attempts WHERE experience_capture_id = ?')
      .get(capture.id) as { c: number }
  ).c;
  return {
    id: capture.id,
    title: note.title,
    summary: firstLine(capture.rawText, 160),
    conditions: note.conditions_text ?? '',
    limitations: note.limitations_text ?? '',
    revision: capture.revision,
    updatedAt: capture.updatedAt,
    createdAt: capture.createdAt,
    archived: capture.archivedAt !== null,
    needsRevision: Boolean(note.needs_revision),
    revisionReason: note.revision_reason,
    sourceCount: active.length,
    attemptCount: attemptsCount,
    hasPracticeResult: active.some((row) => Boolean(row.source_result_text && row.source_result_text.trim())),
    derivationBy: note.understanding_origin === 'model_draft' ? 'model' : 'user',
  };
}

export function listExperiences(options: {
  archived?: 'exclude' | 'include' | 'only';
  limit?: number;
  q?: string;
}): ExperienceListItem[] {
  return listNoteRows({
    archived: options.archived ?? 'exclude',
    limit: Math.max(1, Math.min(100, options.limit ?? 50)),
    q: options.q,
  }).map(({ note, capture }) => listItemOf(note, capture));
}

export function buildExperiencePublic(id: string): ExperiencePublic | null {
  const capture = readCapture(id);
  if (!capture || capture.kind !== 'experience') return null;
  const note = readNote(id);
  if (!note) return null;
  const sources = readSourceRows(id).map(sourcePublic);
  const active = sources.filter((source) => !source.deleted);
  const attempts = readExperienceAttempts(id);
  const linkCount = (
    sqlite
      .prepare('SELECT COUNT(*) AS c FROM capture_links WHERE from_capture_id = ? OR to_capture_id = ?')
      .get(id, id) as { c: number }
  ).c;
  const model = note.understanding_origin === 'model_draft';
  return {
    id,
    title: note.title,
    understanding: capture.rawText,
    conditions: note.conditions_text ?? '',
    limitations: note.limitations_text ?? '',
    derivation: {
      by: model ? 'model' : 'user',
      modelBasis: model ? ((note.model_basis as ExperienceModelBasis | null) ?? null) : null,
      originKind: note.origin_kind as ExperienceOriginKind,
      originQueryId: note.origin_query_id,
      originPointIndex: note.origin_point_index,
      originAttemptId: note.origin_attempt_id,
      contextCaptureId: note.context_capture_id,
      confirmNote: model
        ? '由模型整理，你已经确认保存；这只表示愿意保留，不代表已被证实。'
        : '由你自己整理并保存；可以继续修订。',
    },
    needsRevision: Boolean(note.needs_revision),
    revisionReason: note.revision_reason,
    revision: capture.revision,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt,
    archivedAt: capture.archivedAt,
    archived: capture.archivedAt !== null,
    sources,
    sourceCount: active.length,
    changedSourceCount: active.filter((source) => source.changed).length,
    deletedSourceCount: sources.filter((source) => source.deleted).length,
    hasPracticeResult: active.some((source) =>
      Boolean(source.resultText && source.resultText.trim())
    ),
    attempts,
    linkCount,
    canEdit: true,
  };
}

function indexTitle(value: string): string {
  return firstLine(value, 60);
}

function draftSourceOf(sourceKey: string): ExperienceDraftSource | null {
  const snapshot = buildSourceSnapshotOrNull(sourceKey);
  if (!snapshot) return null;
  if (snapshot.sourceType === 'attempt') {
    return {
      sourceKey,
      type: 'attempt',
      id: snapshot.sourceId,
      captureId: snapshot.sourceCaptureId,
      title: snapshot.sourceTitle,
      text: snapshot.sourceText,
      resultText: snapshot.sourceResultText,
      outcome: snapshot.outcome,
      state: snapshot.state,
      observedAt: snapshot.observedAt,
      kind: 'attempt',
      openHref: `/attempt/${snapshot.sourceId}`,
      exists: true,
      changed: false,
    };
  }
  const current = readCapture(snapshot.sourceId)!;
  return {
    sourceKey,
    type: 'capture',
    id: snapshot.sourceId,
    captureId: snapshot.sourceId,
    title: snapshot.sourceTitle,
    text: snapshot.sourceText,
    resultText: null,
    outcome: null,
    state: null,
    observedAt: null,
    kind: current.kind === 'experience' ? 'experience' : 'thought',
    openHref: current.kind === 'experience' ? `/experience/${current.id}` : `/capture/${current.id}`,
    exists: true,
    changed: false,
  };
}

function buildSourceSnapshotOrNull(sourceKey: string): ReturnType<typeof buildSourceSnapshot> | null {
  try {
    return buildSourceSnapshot(sourceKey);
  } catch (error) {
    if (error instanceof ExperienceHttpError && error.status === 409) return null;
    throw error;
  }
}

export function draftFromAsk(queryId: string, pointIndex: number): ExperienceDraft {
  const query = sqlite
    .prepare(
      `SELECT id, question, status, answer_json AS answerJson, sources_json AS sourcesJson
         FROM record_queries WHERE id = ?`
    )
    .get(queryId) as AskQueryRow | undefined;
  if (!query) {
    throw new ExperienceHttpError(404, { error: 'ask_not_found', message: '这次问答已不存在。' });
  }
  if (query.status !== 'succeeded') {
    throw new ExperienceHttpError(409, {
      error: 'ask_not_succeeded',
      message: '这次问答还没有生成完成，暂时不能整理成经验。',
    });
  }
  const answer = parseJson<{
    points?: Array<{ text?: string; basis?: string; condition?: string | null; sourceIds?: string[] }>;
  }>(query.answerJson);
  const points = answer?.points ?? [];
  const point = points[pointIndex];
  if (!point || typeof point.text !== 'string') {
    throw new ExperienceHttpError(404, {
      error: 'point_not_found',
      message: '这条观点已不存在。',
    });
  }
  const basis: ExperienceModelBasis = point.basis === 'inference' ? 'inference' : 'observation';
  const pointSourceKeys = normalizeSourceKeys(point.sourceIds ?? []);
  const sources = pointSourceKeys
    .map((key) => draftSourceOf(key))
    .filter((source): source is ExperienceDraftSource => Boolean(source));

  if (sources.length === 0) {
    throw new ExperienceHttpError(409, {
      error: 'point_sources_unavailable',
      message: '这条观点引用的原始记录已不可访问，不能据此保存经验。',
    });
  }

  return {
    originKind: 'ask',
    title: indexTitle(point.text),
    understanding: point.text,
    conditions: point.condition ?? '',
    limitations: '',
    by: 'model',
    modelBasis: basis,
    originQueryId: query.id,
    originPointIndex: pointIndex,
    originAttemptId: null,
    contextCaptureId: null,
    sources,
    hint:
      basis === 'inference'
        ? '这条观点由模型推断整理，保存后仍会保留「由模型推断整理」的出处，不会被当成已证实。'
        : '这条观点由模型从原始记录整理，保存后会注明「由模型整理」，并保留下方依据记录。',
  };
}

export function draftFromAttempt(attemptId: string): ExperienceDraft {
  const attempt = readAttemptSource(attemptId);
  if (!attempt) {
    throw new ExperienceHttpError(404, { error: 'attempt_not_found', message: '这次尝试已不存在。' });
  }
  if (!attempt.resultText || !attempt.resultText.trim()) {
    throw new ExperienceHttpError(409, {
      error: 'attempt_result_required',
      message: '这次尝试还没有实际结果，先记录结果再整理成经验。',
    });
  }
  const source = draftSourceOf(`attempt:${attemptId}`);
  if (!source) {
    throw new ExperienceHttpError(409, {
      error: 'source_unavailable',
      message: '这次尝试已不可访问。',
    });
  }
  return {
    originKind: 'attempt',
    title: indexTitle(attempt.step),
    understanding: '',
    conditions: '',
    limitations: '',
    by: 'user',
    modelBasis: null,
    originQueryId: null,
    originPointIndex: null,
    originAttemptId: attemptId,
    contextCaptureId: attempt.captureKind === 'thought' ? attempt.captureId : null,
    sources: [source],
    hint: '这里只预填了实际结果；「我的理解」需要你自己写。整理不调用模型，输入后可以直接保存。',
  };
}

export type CreateExperienceInput = {
  title: unknown;
  understanding: unknown;
  conditions?: unknown;
  limitations?: unknown;
  by?: unknown;
  modelBasis?: unknown;
  originKind?: unknown;
  originQueryId?: unknown;
  originPointIndex?: unknown;
  originAttemptId?: unknown;
  contextCaptureId?: unknown;
  sourceKeys?: unknown;
  operationId?: unknown;
};

function normalizeOriginKind(raw: unknown, fallback: ExperienceOriginKind): ExperienceOriginKind {
  if (raw == null) return fallback;
  if (raw === 'ask' || raw === 'attempt' || raw === 'manual') return raw;
  throw new ExperienceHttpError(400, {
    error: 'invalid_request',
    message: '整理出处不正确。',
    field: 'originKind',
  });
}

export type CreateExperienceOutcome = {
  status: number;
  body: { experience: ExperiencePublic; replayed: boolean };
};

export function createExperience(input: CreateExperienceInput): CreateExperienceOutcome {
  const title = cleanText(input.title, '标题', EXPERIENCE_TITLE_MAX, true);
  const understanding = cleanText(
    input.understanding,
    '我的理解',
    EXPERIENCE_UNDERSTANDING_MAX,
    true
  );
  const conditions = cleanText(input.conditions, '适用条件', EXPERIENCE_CONDITIONS_MAX, false);
  const limitations = cleanText(input.limitations, '限制或还不确定的地方', EXPERIENCE_LIMITATIONS_MAX, false);
  const originKind = normalizeOriginKind(input.originKind, 'manual');
  const by = input.by === 'model' ? 'model' : 'user';
  const modelBasis =
    input.modelBasis === 'observation' || input.modelBasis === 'inference'
      ? (input.modelBasis as ExperienceModelBasis)
      : null;
  if (by === 'model' && !modelBasis) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: '模型整理需要注明是观察还是推断。',
      field: 'modelBasis',
    });
  }
  const operationId = String(input.operationId ?? '').trim();
  if (!operationId) {
    throw new ExperienceHttpError(400, {
      error: 'operationId required',
      message: '缺少操作编号，请重新打开编辑面板。',
    });
  }

  const sourceKeys = normalizeSourceKeys(input.sourceKeys);
  if (sourceKeys.length === 0) {
    throw new ExperienceHttpError(422, {
      error: 'source_required',
      message: '至少关联一条仍可访问的原记录，才能保存经验。',
      field: 'sourceKeys',
    });
  }

  const originQueryId = input.originQueryId == null ? null : String(input.originQueryId);
  const originPointIndex =
    input.originPointIndex == null || input.originPointIndex === ''
      ? null
      : Number(input.originPointIndex);
  if (originPointIndex !== null && (!Number.isInteger(originPointIndex) || originPointIndex < 0)) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: '观点位置不正确。',
      field: 'originPointIndex',
    });
  }
  const originAttemptId = input.originAttemptId == null ? null : String(input.originAttemptId);
  const contextCaptureId = input.contextCaptureId == null ? null : String(input.contextCaptureId);
  if (originKind === 'ask') {
    if (!originQueryId || originPointIndex === null || by !== 'model') {
      throw new ExperienceHttpError(400, {
        error: 'invalid_request',
        message: '问答来源的经验需要标明哪条观点。',
      });
    }
  }

  const fp = sha256(
    JSON.stringify({
      op: 'experience_create',
      title,
      understanding,
      conditions,
      limitations,
      by,
      modelBasis,
      originKind,
      originQueryId,
      originPointIndex,
      originAttemptId,
      contextCaptureId,
      sourceKeys,
    })
  );
  const existing = getReceipt(operationId);
  if (existing) {
    const payload = replay<{ experienceId: string }>(existing, fp, 'experience');
    const experience = buildExperiencePublic(payload.experienceId);
    if (!experience) throw new Error('experience receipt points to missing row');
    return { status: 200, body: { experience, replayed: true } };
  }

  // 出处可核对：问答观点仍在、尝试仍有实际结果；来源全部可访问。
  if (originKind === 'ask' && originQueryId && originPointIndex !== null) {
    const draft = draftFromAsk(originQueryId, originPointIndex);
    if (modelBasis && draft.modelBasis !== modelBasis) {
      throw new ExperienceHttpError(409, {
        error: 'point_basis_changed',
        message: '这条观点的性质与当前记录不一致，请重新打开编辑面板。',
      });
    }
    if (!draft.sources.some((source) => sourceKeys.includes(source.sourceKey))) {
      throw new ExperienceHttpError(422, {
        error: 'point_source_required',
        message: '这份经验需要至少保留该观点实际使用的一条来源记录。',
        field: 'sourceKeys',
      });
    }
  }
  if (originKind === 'attempt' && originAttemptId) {
    const attempt = readAttemptSource(originAttemptId);
    if (!attempt || !attempt.resultText || !attempt.resultText.trim()) {
      throw new ExperienceHttpError(409, {
        error: 'attempt_unavailable',
        message: '这次尝试的结果已不可访问，不能据此保存经验。',
      });
    }
    if (!sourceKeys.includes(`attempt:${originAttemptId}`)) {
      throw new ExperienceHttpError(422, {
        error: 'attempt_source_required',
        message: '这份经验需要保留这次实际尝试作为依据。',
        field: 'sourceKeys',
      });
    }
  }
  if (contextCaptureId) {
    const context = readCapture(contextCaptureId);
    if (!context || context.kind !== 'thought') {
      throw new ExperienceHttpError(409, {
        error: 'context_unavailable',
        message: '所属念头已不可用，可以另选一个念头。',
      });
    }
  }

  const snapshots = sourceKeys.map((key) => ({ key, snapshot: buildSourceSnapshot(key) }));

  const captureId = newCaptureId();
  const now = Date.now();
  const created = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO captures (id, raw_text, revision, created_at, updated_at, archived_at, kind)
         VALUES (?, ?, 1, ?, ?, NULL, 'experience')`
      )
      .run(captureId, understanding, now, now);
    sqlite
      .prepare(
        `INSERT INTO experience_notes
           (capture_id, title, understanding_origin, model_basis, origin_kind,
            origin_query_id, origin_point_index, origin_attempt_id, context_capture_id,
            conditions_text, limitations_text, needs_revision, revision_reason,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      )
      .run(
        captureId,
        title,
        by === 'model' ? 'model_draft' : 'user_edited',
        by === 'model' ? modelBasis : null,
        originKind,
        originQueryId,
        originPointIndex,
        originAttemptId,
        contextCaptureId,
        conditions || null,
        limitations || null,
        now,
        now
      );
    for (const { key, snapshot } of snapshots) {
      sqlite
        .prepare(
          `INSERT INTO experience_sources
             (id, experience_id, source_key, source_type, source_id, source_capture_id,
              source_title, source_text, source_result_text, outcome, state, observed_at,
              source_revision, source_capture_revision, source_kind, deleted,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          newId('expsrc'),
          captureId,
          key,
          snapshot.sourceType,
          snapshot.sourceId,
          snapshot.sourceCaptureId,
          snapshot.sourceTitle,
          snapshot.sourceText,
          snapshot.sourceResultText,
          snapshot.outcome,
          snapshot.state,
          snapshot.observedAt,
          snapshot.sourceRevision,
          snapshot.sourceCaptureRevision,
          snapshot.sourceKind,
          now,
          now
        );
    }
    sqlite
      .prepare(
        `INSERT INTO mutation_receipts (operation_key, target_type, request_fingerprint, response_json, created_at)
         VALUES (?, 'experience', ?, ?, ?)`
      )
      .run(operationId, fp, JSON.stringify({ experienceId: captureId }), now);
    return captureId;
  })();

  const experience = buildExperiencePublic(created);
  if (!experience) throw new Error('experience insert failed');
  return { status: 201, body: { experience, replayed: false } };
}

export type UpdateExperienceInput = {
  title?: unknown;
  understanding?: unknown;
  conditions?: unknown;
  limitations?: unknown;
  sourceKeys?: unknown;
  revision?: unknown;
  operationId?: unknown;
};

export function updateExperience(id: string, input: UpdateExperienceInput): {
  status: number;
  body: { experience: ExperiencePublic; replayed: boolean };
} {
  const capture = readCapture(id);
  if (!capture || capture.kind !== 'experience' || !readNote(id)) {
    throw new ExperienceHttpError(404, { error: 'experience_not_found', message: '这份经验已不存在。' });
  }
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new ExperienceHttpError(428, { error: 'revision_required', message: '缺少版本号，请刷新后重试。' });
  }
  const title = cleanText(input.title, '标题', EXPERIENCE_TITLE_MAX, true);
  const understanding = cleanText(
    input.understanding,
    '我的理解',
    EXPERIENCE_UNDERSTANDING_MAX,
    true
  );
  const conditions = cleanText(input.conditions, '适用条件', EXPERIENCE_CONDITIONS_MAX, false);
  const limitations = cleanText(input.limitations, '限制或还不确定的地方', EXPERIENCE_LIMITATIONS_MAX, false);
  const hasSourceKeys = input.sourceKeys !== undefined;
  const sourceKeys = hasSourceKeys ? normalizeSourceKeys(input.sourceKeys) : [];
  const operationId = String(input.operationId ?? '').trim();

  const fp = sha256(
    JSON.stringify({
      op: 'experience_update',
      id,
      revision,
      title,
      understanding,
      conditions,
      limitations,
      sourceKeys: hasSourceKeys ? sourceKeys : null,
    })
  );
  if (operationId) {
    const existing = getReceipt(operationId);
    if (existing) {
      const payload = replay<{ experienceId: string }>(existing, fp, 'experience_update');
      const experience = buildExperiencePublic(payload.experienceId);
      if (!experience) throw new Error('experience receipt points to missing row');
      return { status: 200, body: { experience, replayed: true } };
    }
  }

  if (revision !== capture.revision) {
    throw new ExperienceHttpError(409, {
      error: 'revision_conflict',
      message: '这份经验已在别处修改，请保留你的文字，刷新后重新保存。',
      current: {
        revision: capture.revision,
        title: readNote(id)!.title,
        understanding: capture.rawText,
        updatedAt: capture.updatedAt,
      },
    });
  }

  if (hasSourceKeys && sourceKeys.length === 0) {
    throw new ExperienceHttpError(422, {
      error: 'source_required',
      message: '至少保留一条仍可访问的原记录。',
      field: 'sourceKeys',
    });
  }
  if (hasSourceKeys && sourceKeys.includes(`capture:${id}`)) {
    throw new ExperienceHttpError(400, {
      error: 'invalid_request',
      message: '经验不能把自己当作依据。',
      field: 'sourceKeys',
    });
  }
  const snapshots = hasSourceKeys
    ? sourceKeys.map((key) => ({ key, snapshot: buildSourceSnapshot(key) }))
    : [];

  const note = readNote(id)!;
  const now = Date.now();
  const changedUnderstanding = understanding !== capture.rawText;
  const nextOrigin = changedUnderstanding || note.understanding_origin !== 'model_draft'
    ? 'user_edited'
    : 'model_draft';
  const nextRevision = capture.revision + 1;

  sqlite.transaction(() => {
    if (hasSourceKeys) {
      const existingRows = readSourceRows(id);
      const keep = new Set(sourceKeys);
      for (const row of existingRows) {
        if (!keep.has(row.source_key)) {
          sqlite.prepare('DELETE FROM experience_sources WHERE id = ?').run(row.id);
        }
      }
      for (const { key, snapshot } of snapshots) {
        const existing = existingRows.find((row) => row.source_key === key);
        if (existing) {
          sqlite
            .prepare(
              `UPDATE experience_sources
                  SET source_title = ?, source_text = ?, source_result_text = ?,
                      outcome = ?, state = ?, observed_at = ?,
                      source_revision = ?, source_capture_revision = ?,
                      source_capture_id = ?, source_kind = ?, deleted = 0,
                      updated_at = ?
                WHERE id = ?`
            )
            .run(
              snapshot.sourceTitle,
              snapshot.sourceText,
              snapshot.sourceResultText,
              snapshot.outcome,
              snapshot.state,
              snapshot.observedAt,
              snapshot.sourceRevision,
              snapshot.sourceCaptureRevision,
              snapshot.sourceCaptureId,
              snapshot.sourceKind,
              now,
              existing.id
            );
        } else {
          sqlite
            .prepare(
              `INSERT INTO experience_sources
                 (id, experience_id, source_key, source_type, source_id, source_capture_id,
                  source_title, source_text, source_result_text, outcome, state, observed_at,
                  source_revision, source_capture_revision, source_kind, deleted,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
            )
            .run(
              newId('expsrc'),
              id,
              key,
              snapshot.sourceType,
              snapshot.sourceId,
              snapshot.sourceCaptureId,
              snapshot.sourceTitle,
              snapshot.sourceText,
              snapshot.sourceResultText,
              snapshot.outcome,
              snapshot.state,
              snapshot.observedAt,
              snapshot.sourceRevision,
              snapshot.sourceCaptureRevision,
              snapshot.sourceKind,
              now,
              now
            );
        }
      }
    }

    sqlite
      .prepare('UPDATE captures SET raw_text = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(understanding, nextRevision, now, id);
    sqlite
      .prepare(
        `UPDATE experience_notes
            SET title = ?, understanding_origin = ?, conditions_text = ?, limitations_text = ?,
                needs_revision = 0, revision_reason = NULL, updated_at = ?
          WHERE capture_id = ?`
      )
      .run(title, nextOrigin, conditions || null, limitations || null, now, id);

    if (operationId) {
      sqlite
        .prepare(
          `INSERT INTO mutation_receipts (operation_key, target_type, request_fingerprint, response_json, created_at)
           VALUES (?, 'experience_update', ?, ?, ?)`
        )
        .run(operationId, fp, JSON.stringify({ experienceId: id }), now);
    }
  })();

  const experience = buildExperiencePublic(id);
  if (!experience) throw new Error('experience update failed');
  return { status: 200, body: { experience, replayed: false } };
 }

export type CreateAttemptFromExperienceInput = {
  captureId?: unknown;
  title?: unknown;
  description?: unknown;
  basisSourceKeys?: unknown;
  experienceRevision?: unknown;
  operationId?: unknown;
};

export function createAttemptFromExperience(
  experienceId: string,
  input: CreateAttemptFromExperienceInput
): { status: number; body: { attempt: Record<string, unknown>; experienceId: string; replayed: boolean } } {
  const capture = readCapture(experienceId);
  const note = readNote(experienceId);
  if (!capture || capture.kind !== 'experience' || !note) {
    throw new ExperienceHttpError(404, { error: 'experience_not_found', message: '这份经验已不存在。' });
  }
  if (capture.archivedAt !== null) {
    throw new ExperienceHttpError(409, {
      error: 'experience_archived',
      message: '这份经验已归档，请先恢复再参考。',
    });
  }
  if (typeof input.experienceRevision === 'number' && input.experienceRevision !== capture.revision) {
    throw new ExperienceHttpError(409, {
      error: 'experience_version_conflict',
      message: '这份经验刚刚被修改，请刷新后再试一步。',
      currentRevision: capture.revision,
    });
  }
  const targetCaptureId = String(input.captureId ?? '').trim();
  const target = readCapture(targetCaptureId);
  if (!target || target.kind !== 'thought') {
    throw new ExperienceHttpError(409, {
      error: 'capture_unavailable',
      message: '请选择一个仍可用的念头作为这次尝试的归属。',
      field: 'captureId',
    });
  }
  const title = cleanText(input.title, '行动标题', EXPERIENCE_TITLE_MAX, true);
  const description = cleanText(input.description, '行动说明', EXPERIENCE_LIMITATIONS_MAX, false);
  const basisKeys = normalizeSourceKeys(input.basisSourceKeys, 'basisSourceKeys');
  const storedSources = readSourceRows(experienceId).filter((row) => !row.deleted);
  for (const key of basisKeys) {
    const row = storedSources.find((source) => source.source_key === key);
    if (!row || row.source_type !== 'attempt') {
      throw new ExperienceHttpError(422, {
        error: 'basis_source_unavailable',
        message: '选中的原始尝试已不可用，请刷新后重新选择。',
        sourceKeys: [key],
      });
    }
  }

  const operationId = String(input.operationId ?? '').trim();
  if (!operationId) {
    throw new ExperienceHttpError(400, {
      error: 'operationId required',
      message: '缺少操作编号，请重新打开面板。',
    });
  }
  const fp = sha256(
    JSON.stringify({
      op: 'experience_attempt',
      experienceId,
      captureId: targetCaptureId,
      title,
      description,
      basisKeys,
      experienceRevision: input.experienceRevision ?? null,
    })
  );
  const existing = getReceipt(operationId);
  if (existing) {
    const payload = replay<{ attemptId: string; experienceId: string }>(
      existing,
      fp,
      'experience_attempt'
    );
    const attempt = readAttemptApi(payload.attemptId);
    if (!attempt) throw new Error('experience attempt receipt points to missing row');
    return {
      status: 200,
      body: { attempt, experienceId: payload.experienceId, replayed: true },
    };
  }

  const attemptId = newId('att');
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO attempts
           (id, capture_id, step, state, result_text, outcome, source_url, observed_at,
            revision, created_at, updated_at, origin, action_description, estimated_minutes,
            source_review_id, source_experience_index, source_attempt_id, source_attempt_revision,
            source_research_id, source_research_experiment_index,
            research_suggested_json, research_source_ids_json)
         VALUES (?, ?, ?, 'todo', NULL, NULL, NULL, NULL, 1, ?, ?, 'experience_retry', ?,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      )
      .run(attemptId, targetCaptureId, title, now, now, description || null);
    sqlite
      .prepare(
        `INSERT INTO experience_attempts
           (attempt_id, experience_capture_id, adopted_version, adopted_title,
            adopted_understanding, basis_source_keys_json, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        attemptId,
        experienceId,
        capture.revision,
        note.title,
        capture.rawText,
        JSON.stringify(basisKeys),
        now
      );
    for (const key of basisKeys) {
      const sourceId = key.slice('attempt:'.length);
      const source = readAttemptSource(sourceId);
      if (!source) continue;
      sqlite
        .prepare(
          `INSERT INTO attempt_references
             (id, from_attempt_id, to_attempt_id, revision, note, snapshot_result_text, snapshot_revision, created_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(
          newId('ref'),
          attemptId,
          sourceId,
          '参考经验时选用',
          source.resultText,
          source.revision,
          now
        );
    }
    sqlite
      .prepare(
        `INSERT INTO mutation_receipts (operation_key, target_type, request_fingerprint, response_json, created_at)
         VALUES (?, 'experience_attempt', ?, ?, ?)`
      )
      .run(
        operationId,
        fp,
        JSON.stringify({ attemptId, experienceId }),
        now
      );
  })();

  const attempt = readAttemptApi(attemptId);
  return {
    status: 201,
    body: { attempt, experienceId, replayed: false },
  };
}

function readAttemptApi(attemptId: string): Record<string, unknown> {
  const attempt = sqlite
    .prepare(
      `SELECT id, capture_id AS captureId, step, state, result_text AS resultText, outcome,
              source_url AS sourceUrl, observed_at AS observedAt, revision,
              created_at AS createdAt, updated_at AS updatedAt, origin,
              action_description AS actionDescription, estimated_minutes AS estimatedMinutes,
              source_review_id AS sourceReviewId,
              source_experience_index AS sourceExperienceIndex,
              source_attempt_id AS sourceAttemptId,
              source_attempt_revision AS sourceAttemptRevision
         FROM attempts WHERE id = ?`
    )
    .get(attemptId) as Record<string, unknown> | undefined;
  if (!attempt) throw new Error('attempt row missing after create');
  return attempt;
}

export function experienceAttemptContext(attemptId: string): {
  experienceId: string;
  adoptedVersion: number;
  adoptedTitle: string;
  adoptedUnderstanding: string;
  deleted: boolean;
  exists: boolean;
  archived: boolean;
  currentVersion: number | null;
  changed: boolean;
} | null {
  const row = sqlite
    .prepare('SELECT * FROM experience_attempts WHERE attempt_id = ?')
    .get(attemptId) as ExperienceAttemptRow | undefined;
  if (!row) return null;
  const capture = readCapture(row.experience_capture_id);
  const exists = Boolean(capture && capture.kind === 'experience' && readNote(row.experience_capture_id));
  return {
    experienceId: row.experience_capture_id,
    adoptedVersion: row.adopted_version,
    adoptedTitle: row.adopted_title,
    adoptedUnderstanding: row.adopted_understanding,
    deleted: Boolean(row.deleted) || !exists,
    exists,
    archived: Boolean(capture?.archivedAt),
    currentVersion: exists ? capture!.revision : null,
    changed: Boolean(exists && capture!.revision > row.adopted_version),
  };
}

export function experienceDeletePreview(experienceId: string): {
  experienceId: string;
  title: string;
  sourceCount: number;
  attemptCount: number;
  linkCount: number;
  sources: Array<{ title: string; type: string; exists: boolean }>;
  attempts: Array<{ id: string; title: string; resultText: string | null; outcome: string | null }>;
} {
  const capture = readCapture(experienceId);
  const note = readNote(experienceId);
  if (!capture || !note || capture.kind !== 'experience') {
    throw new ExperienceHttpError(404, { error: 'experience_not_found', message: '这份经验已不存在。' });
  }
  const sources = readSourceRows(experienceId).map(sourcePublic);
  const attempts = readExperienceAttempts(experienceId);
  return {
    experienceId,
    title: note.title,
    sourceCount: sources.length,
    attemptCount: attempts.length,
    linkCount: (
      sqlite
        .prepare('SELECT COUNT(*) AS c FROM capture_links WHERE from_capture_id = ? OR to_capture_id = ?')
        .get(experienceId, experienceId) as { c: number }
    ).c,
    sources: sources.map((source) => ({
      title: source.title,
      type: source.type,
      exists: source.exists,
    })),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      title: attempt.title,
      resultText: attempt.resultText,
      outcome: attempt.outcome,
    })),
  };
}

/** 来源被删除前，列出会受影响的经验（用于删除预览）。 */
export function experienceImpactsForAttemptIds(attemptIds: string[]): ExperienceImpact[] {
  if (attemptIds.length === 0) return [];
  const placeholders = attemptIds.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT s.experience_id AS id, n.title AS title, n.understanding_origin AS origin
         FROM experience_sources s
         JOIN experience_notes n ON n.capture_id = s.experience_id
        WHERE s.deleted = 0
          AND ((s.source_type = 'attempt' AND s.source_id IN (${placeholders}))
               OR (s.source_type = 'capture' AND s.source_id IN (${placeholders})))`
    )
    .all(...attemptIds, ...attemptIds) as Array<{ id: string; title: string; origin: string }>;
  return impactsFromRows(rows, attemptIds, null);
}

export function experienceImpactsForCapture(captureId: string, attemptIds: string[]): ExperienceImpact[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT s.experience_id AS id, n.title AS title, n.understanding_origin AS origin
         FROM experience_sources s
         JOIN experience_notes n ON n.capture_id = s.experience_id
        WHERE s.deleted = 0
          AND ((s.source_type = 'capture' AND s.source_id = ?)
               OR s.source_capture_id = ?)`
    )
    .all(captureId, captureId) as Array<{ id: string; title: string; origin: string }>;
  return impactsFromRows(rows, attemptIds, captureId);
}

function impactsFromRows(
  rows: Array<{ id: string; title: string; origin: string }>,
  attemptIds: string[],
  captureId: string | null
): ExperienceImpact[] {
  return rows
    .filter((row) => (captureId ? row.id !== captureId : true))
    .map((row) => {
    let deletedCount = 0;
    if (captureId) {
      deletedCount = (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM experience_sources
              WHERE experience_id = ? AND deleted = 0
                AND ((source_type = 'capture' AND source_id = ?) OR source_capture_id = ?)`
          )
          .get(row.id, captureId, captureId) as { c: number }
      ).c;
    }
    if (attemptIds.length > 0) {
      const placeholders = attemptIds.map(() => '?').join(',');
      deletedCount += (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM experience_sources
              WHERE experience_id = ? AND deleted = 0 AND source_type = 'attempt'
                AND source_id IN (${placeholders})`
          )
          .get(row.id, ...attemptIds) as { c: number }
      ).c;
    }
    return {
      id: row.id,
      title: row.title,
      deletedSourceCount: deletedCount,
      willClearUnderstanding: row.origin === 'model_draft',
    };
    });
}

/** 删除尝试/念头后清洗依据快照；模型整理且无法拆分来源的正文按产品规则清空。 */
export function invalidateExperienceSourcesForDeletedAttempts(attemptIds: string[]): void {
  if (attemptIds.length === 0) return;
  const placeholders = attemptIds.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT experience_id AS id FROM experience_sources
        WHERE deleted = 0 AND source_type = 'attempt' AND source_id IN (${placeholders})`
    )
    .all(...attemptIds) as Array<{ id: string }>;
  if (rows.length === 0) return;
  const experienceIds = Array.from(new Set(rows.map((row) => row.id)));
  sqlite
    .prepare(
      `UPDATE experience_sources
          SET deleted = 1, source_title = '来源已删除', source_text = '',
              source_result_text = NULL, outcome = NULL, state = NULL, observed_at = NULL,
              updated_at = ?
        WHERE deleted = 0 AND source_type = 'attempt' AND source_id IN (${placeholders})`
    )
    .run(Date.now(), ...attemptIds);
  markExperiencesNeedRevision(experienceIds);
}

export function invalidateExperienceSourcesForDeletedCapture(captureId: string): void {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT experience_id AS id FROM experience_sources
        WHERE deleted = 0
          AND ((source_type = 'capture' AND source_id = ?) OR source_capture_id = ?)`
    )
    .all(captureId, captureId) as Array<{ id: string }>;
  if (rows.length === 0) return;
  const experienceIds = Array.from(new Set(rows.map((row) => row.id)));
  sqlite
    .prepare(
      `UPDATE experience_sources
          SET deleted = 1, source_title = '来源已删除', source_text = '',
              source_result_text = NULL, outcome = NULL, state = NULL, observed_at = NULL,
              updated_at = ?
        WHERE deleted = 0
          AND ((source_type = 'capture' AND source_id = ?) OR source_capture_id = ?)`
    )
    .run(Date.now(), captureId, captureId);
  markExperiencesNeedRevision(experienceIds);
}

function markExperiencesNeedRevision(experienceIds: string[]): void {
  const now = Date.now();
  for (const experienceId of experienceIds) {
    const capture = readCapture(experienceId);
    const note = readNote(experienceId);
    if (!capture || !note || capture.kind !== 'experience') continue;
    const activeCount = (
      sqlite
        .prepare('SELECT COUNT(*) AS c FROM experience_sources WHERE experience_id = ? AND deleted = 0')
        .get(experienceId) as { c: number }
    ).c;
    void activeCount;
    if (note.understanding_origin === 'model_draft') {
      const cleared = capture.rawText.length > 0;
      if (cleared) {
        sqlite
          .prepare("UPDATE captures SET raw_text = '', revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now, experienceId);
      }
      sqlite
        .prepare(
          `UPDATE experience_notes
              SET needs_revision = 1,
                  revision_reason = '依据记录已删除，模型整理的正文已清空，请重新整理。',
                  updated_at = ?
            WHERE capture_id = ?`
        )
        .run(now, experienceId);
    } else {
      sqlite
        .prepare(
          `UPDATE experience_notes
              SET needs_revision = 1,
                  revision_reason = '依据记录已删除；正文保留，请核对后修订。',
                  updated_at = ?
            WHERE capture_id = ?`
        )
        .run(now, experienceId);
    }
  }
}

/** 删除经验时清掉引用它的尝试里的经验正文，只保留「来源经验已删除」和采用时版本。 */
export function clearExperienceAttemptContexts(experienceId: string): void {
  sqlite
    .prepare(
      `UPDATE experience_attempts
          SET deleted = 1, adopted_title = '来源经验已删除', adopted_understanding = ''
        WHERE experience_capture_id = ?`
    )
    .run(experienceId);
}

export function searchExperiences(term: string, limit = 8): ExperienceSearchHit[] {
  const q = term.trim();
  if (!q) return [];
  const rows = listNoteRows({ archived: 'exclude', limit: Math.max(1, Math.min(20, limit)), q });
  return rows.map(({ note, capture }) => {
    const item = listItemOf(note, capture);
    const lowered = q.toLowerCase();
    const fields: Array<[string, string]> = [
      ['标题', note.title],
      ['我的理解', capture.rawText],
      ['适用条件', note.conditions_text ?? ''],
      ['限制', note.limitations_text ?? ''],
    ];
    const matched = fields.filter(([, value]) => value.toLowerCase().includes(lowered));
    const reason = matched.length > 0 ? matched.map(([name]) => `${name}命中`).join('、') : '标题命中';
    const snippetSource =
      matched.find(([name]) => name === '我的理解')?.[1] ??
      note.conditions_text ??
      note.limitations_text ??
      capture.rawText;
    return {
      ...item,
      matchReason: reason,
      snippet: firstLine(snippetSource, 160),
    };
  });
}

export function sourceCandidates(
  query: string,
  excludeExperienceId: string | null
): ExperienceDraftSource[] {
  const q = query.trim();
  const like = `%${q.toLowerCase()}%`;
  const attempts = sqlite
    .prepare(
      `SELECT a.id, a.capture_id AS captureId, a.step, a.state, a.result_text AS resultText,
              a.outcome, a.observed_at AS observedAt
         FROM attempts a JOIN captures c ON c.id = a.capture_id
        WHERE c.kind = 'thought' AND a.result_text IS NOT NULL AND TRIM(a.result_text) <> ''
          AND (? = '' OR LOWER(a.step) LIKE ? OR LOWER(a.result_text) LIKE ?)
        ORDER BY COALESCE(a.observed_at, a.created_at) DESC
        LIMIT 8`
    )
    .all(q, like, like) as Array<{
    id: string;
    captureId: string;
    step: string;
    state: string;
    resultText: string | null;
    outcome: string | null;
    observedAt: number | null;
  }>;
  const captures = sqlite
    .prepare(
      `SELECT id, raw_text AS rawText, created_at AS createdAt
         FROM captures
        WHERE kind = 'thought' AND id <> COALESCE(?, '')
          AND (? = '' OR LOWER(raw_text) LIKE ?)
        ORDER BY created_at DESC
        LIMIT 8`
    )
    .all(excludeExperienceId, q, like) as Array<{ id: string; rawText: string; createdAt: number }>;

  const out: ExperienceDraftSource[] = [];
  for (const row of attempts) {
    if (excludeExperienceId && row.captureId === excludeExperienceId) continue;
    out.push({
      sourceKey: `attempt:${row.id}`,
      type: 'attempt',
      id: row.id,
      captureId: row.captureId,
      title: firstLine(row.step, 120),
      text: row.step,
      resultText: row.resultText,
      outcome: row.outcome,
      state: row.state,
      observedAt: row.observedAt,
      kind: 'attempt',
      openHref: `/attempt/${row.id}`,
      exists: true,
      changed: false,
    });
  }
  for (const row of captures) {
    out.push({
      sourceKey: `capture:${row.id}`,
      type: 'capture',
      id: row.id,
      captureId: row.id,
      title: firstLine(row.rawText, 120),
      text: row.rawText,
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      kind: 'thought',
      openHref: `/capture/${row.id}`,
      exists: true,
      changed: false,
    });
  }
  return out.slice(0, 12);
}

export function getExperienceExportRows() {
  const notes = sqlite
    .prepare(
      `SELECT capture_id AS captureId, title, understanding_origin AS understandingOrigin,
              model_basis AS modelBasis, origin_kind AS originKind,
              origin_query_id AS originQueryId, origin_point_index AS originPointIndex,
              origin_attempt_id AS originAttemptId, context_capture_id AS contextCaptureId,
              conditions_text AS conditions, limitations_text AS limitations,
              needs_revision AS needsRevision, revision_reason AS revisionReason,
              created_at AS createdAt, updated_at AS updatedAt
         FROM experience_notes ORDER BY created_at ASC, capture_id ASC`
    )
    .all();
  const sources = sqlite
    .prepare(
      `SELECT id, experience_id AS experienceId, source_key AS sourceKey,
              source_type AS sourceType, source_id AS sourceId,
              source_capture_id AS sourceCaptureId, source_title AS sourceTitle,
              source_text AS sourceText, source_result_text AS sourceResultText,
              outcome, state, observed_at AS observedAt,
              source_revision AS sourceRevision,
              source_capture_revision AS sourceCaptureRevision,
              source_kind AS sourceKind, deleted,
              created_at AS createdAt, updated_at AS updatedAt
         FROM experience_sources ORDER BY created_at ASC, id ASC`
    )
    .all();
  const attempts = sqlite
    .prepare(
      `SELECT attempt_id AS attemptId, experience_capture_id AS experienceId,
              adopted_version AS adoptedVersion, adopted_title AS adoptedTitle,
              adopted_understanding AS adoptedUnderstanding,
              basis_source_keys_json AS basisSourceKeysJson, deleted,
              created_at AS createdAt
         FROM experience_attempts ORDER BY created_at ASC, attempt_id ASC`
    )
    .all();
  return {
    experienceNotes: notes,
    experienceSources: sources,
    experienceAttempts: attempts,
  };
}
