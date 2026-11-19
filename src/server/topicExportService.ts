// 拾念 SHINIAN · 单主题 Markdown ZIP 导出（只读）
// 不调用模型、不访问外部网络、不写业务数据、不修改 Obsidian 仓库。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sqlite } from '../db/db';
import { assertSafeZipPath, createZip } from './zip';

export const TOPIC_EXPORT_FORMAT_VERSION = 1;
export const TOPIC_EXPORT_MAX_FILES = 2000;
export const TOPIC_EXPORT_MAX_ATTEMPTS = 2000;
export const TOPIC_EXPORT_MAX_BYTES = 20 * 1024 * 1024;
export const TOPIC_EXPORT_MAX_BASIS_KEYS = 200;

const SOURCE_KEY_RE = /^(attempt|capture):[A-Za-z0-9._:-]+$/u;
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;

export class TopicExportHttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? 'topic export error'));
    this.name = 'TopicExportHttpError';
    this.status = status;
    this.body = body;
  }
}

export type TopicExportOptions = {
  includeArchived: boolean;
  includeBasisKeys: string[];
};

export type TopicExportRequest = TopicExportOptions & {
  expectedScopeHash?: string;
};

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

type CaptureRow = {
  id: string;
  kind: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

type ExperienceNoteRow = {
  captureId: string;
  title: string;
  understandingOrigin: string;
  modelBasis: string | null;
  originKind: string;
  originQueryId: string | null;
  originPointIndex: number | null;
  originAttemptId: string | null;
  contextCaptureId: string | null;
  conditionsText: string | null;
  limitationsText: string | null;
  needsRevision: number;
  revisionReason: string | null;
  createdAt: number;
  updatedAt: number;
};

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
  sourceResearchId: string | null;
  sourceResearchExperimentIndex: number | null;
  researchSuggestedJson: string | null;
  researchSourceIdsJson: string | null;
};

type MemberRow = {
  id: string;
  captureId: string;
  memberKind: string;
  addedAt: number;
  kind: 'thought' | 'experience';
  capture: CaptureRow;
  note: ExperienceNoteRow | null;
};

type CaptureLinkRow = {
  id: string;
  fromCaptureId: string;
  toCaptureId: string;
  note: string | null;
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

type ExperienceSourceRow = {
  id: string;
  experienceId: string;
  sourceKey: string;
  sourceType: string;
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
  sourceKind: string | null;
  deleted: number;
  createdAt: number;
  updatedAt: number;
};

type ExperienceAttemptRow = {
  attemptId: string;
  experienceCaptureId: string;
  adoptedVersion: number;
  adoptedTitle: string;
  adoptedUnderstanding: string;
  basisSourceKeysJson: string | null;
  deleted: number;
  createdAt: number;
};

type EntityType = 'thought' | 'experience' | 'attempt';
type FileEntityType = EntityType | 'index' | 'readme' | 'manifest';

type ExportFileEntry = {
  path: string;
  entityType: FileEntityType;
  entityId: string | null;
  title: string;
  archived: boolean;
  basis: boolean;
  revision: number | null;
  bytes?: number | null;
  sha256?: string | null;
};

type BasisCandidate = {
  sourceKey: string;
  entityType: EntityType;
  entityId: string;
  title: string;
  summary: string;
  sourceExperienceId: string;
  sourceExperienceTitle: string;
  referencedBy: string[];
  deleted: boolean;
  selectable: boolean;
  reason: string;
};

type BasisInternal = BasisCandidate & {
  sourceType: 'attempt' | 'capture';
  capture?: CaptureRow;
  attempt?: AttemptRow;
  parentCapture?: CaptureRow;
};

type BasisEntity = {
  sourceKey: string;
  entityType: EntityType;
  entityId: string;
  title: string;
  basis: true;
  capture?: CaptureRow;
  attempt?: AttemptRow;
  parentCapture?: CaptureRow;
};

type OmittedRelations = {
  total: number;
  byType: {
    manualLink: number;
    attemptReference: number;
    experienceSource: number;
    experienceAdoption: number;
  };
};

type ExportCounts = {
  thoughts: number;
  experiences: number;
  attempts: number;
  basisThoughts: number;
  basisExperiences: number;
  basisAttempts: number;
  files: number;
  manualLinks: number;
  attemptReferences: number;
  experienceSources: number;
  experienceAdoptions: number;
};

type ExportLimits = {
  maxFiles: number;
  maxAttempts: number;
  maxBytes: number;
  maxBasisKeys: number;
  exceeded: string[];
};

type ExportRelation = {
  id: string;
  type:
    | 'topic_member'
    | 'contains_attempt'
    | 'manual_link'
    | 'attempt_reference'
    | 'experience_source'
    | 'experience_adoption';
  direction: string;
  from: string;
  to: string;
  fromFile: string | null;
  toFile: string | null;
  note?: string | null;
  snapshotResultText?: string | null;
  snapshotRevision?: number | null;
  sourceRevision?: number | null;
  adoptedVersion?: number | null;
  adoptedTitle?: string | null;
  adoptedUnderstanding?: string | null;
};

type Snapshot = {
  topic: TopicRow;
  options: TopicExportOptions;
  invalidKeys: string[];
  allMembers: MemberRow[];
  includedMembers: MemberRow[];
  allThoughtAttempts: AttemptRow[];
  includedTopicAttempts: AttemptRow[];
  basisEntities: BasisEntity[];
  basisCandidates: BasisCandidate[];
  candidateByKey: Map<string, BasisInternal>;
  capturesById: Map<string, CaptureRow>;
  notesById: Map<string, ExperienceNoteRow>;
  attemptsById: Map<string, AttemptRow>;
  includedCaptureKeys: Set<string>;
  includedAttemptKeys: Set<string>;
  captureLinks: CaptureLinkRow[];
  attemptReferences: ReferenceRow[];
  experienceSources: ExperienceSourceRow[];
  experienceAttempts: ExperienceAttemptRow[];
  relations: ExportRelation[];
  omitted: OmittedRelations;
  counts: ExportCounts;
  archived: { members: number; thoughts: number; experiences: number };
  files: ExportFileEntry[];
  fileByEntity: Map<string, ExportFileEntry>;
  attemptsByCapture: Map<string, ExportFileEntry[]>;
  manualLinksOut: Map<string, ExportRelation[]>;
  manualLinksIn: Map<string, ExportRelation[]>;
  refsOut: Map<string, ExportRelation[]>;
  refsIn: Map<string, ExportRelation[]>;
  expSourcesOut: Map<string, ExportRelation[]>;
  adoptionsByAttempt: Map<string, ExportRelation[]>;
  adoptionsByExperience: Map<string, ExportRelation[]>;
  omittedManualOut: Set<string>;
  omittedManualIn: Set<string>;
  omittedRefsOut: Set<string>;
  omittedRefsIn: Set<string>;
  omittedExpSources: Set<string>;
  omittedAdoptionsByExperience: Set<string>;
  omittedAdoptionsByAttempt: Set<string>;
  nextAttempt: AttemptRow | null;
  warnings: string[];
  limits: ExportLimits;
  estimatedBytes: number;
  scopeHash: string;
};

type RenderedExport = {
  contents: Map<string, string>;
  filesWithHashes: ExportFileEntry[];
  estimatedBytes: number;
};

const STATE_LABEL: Record<string, string> = {
  todo: '待开始',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
};
const OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  failure: '失败',
  undetermined: '未判定',
};
const RELATION_LABEL: Record<ExportRelation['type'], string> = {
  topic_member: '主题收录',
  contains_attempt: '念头包含尝试',
  manual_link: '手动关联',
  attempt_reference: '尝试引用旧结果',
  experience_source: '经验依据原记录',
  experience_adoption: '后续尝试采用经验',
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstLine(text: string | null | undefined, max = 160): string {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function normalizeLf(text: string): string {
  return String(text ?? '').replace(/\r\n?/gu, '\n');
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

function mdInline(text: string | null | undefined): string {
  return firstLine(text, 500)
    .replace(/\\/gu, '\\\\')
    .replace(/\[/gu, '\\[')
    .replace(/\]/gu, '\\]')
    .replace(/\(/gu, '\\(')
    .replace(/\)/gu, '\\)')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function fencedText(text: string | null | undefined): string {
  const value = normalizeLf(text ?? '');
  let longest = 2;
  for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value || '（空）'}\n${fence}`;
}

function safeFileId(id: string): string {
  if (!SAFE_ID_RE.test(id)) {
    throw new TopicExportHttpError(500, {
      error: 'export_failed',
      message: '导出失败：记录 ID 不符合安全文件名规则。',
    });
  }
  return id;
}

function filePathOf(type: EntityType, id: string): string {
  const safe = safeFileId(id);
  if (type === 'thought') return `records/thoughts/thought-${safe}.md`;
  if (type === 'experience') return `records/experiences/experience-${safe}.md`;
  return `records/attempts/attempt-${safe}.md`;
}

function entityKeyOf(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

function captureEntityKey(id: string, kind: string): string {
  return entityKeyOf(kind === 'experience' ? 'experience' : 'thought', id);
}

function sourceEntityKey(row: ExperienceSourceRow): string {
  if (row.sourceType === 'attempt') return entityKeyOf('attempt', row.sourceId);
  const kind = row.sourceKind === 'experience' ? 'experience' : 'thought';
  return entityKeyOf(kind, row.sourceId);
}

function placeholders(count: number): string {
  return new Array(Math.max(1, count)).fill('?').join(',');
}

function rows<T>(sql: string, params: Array<string | number | null> = []): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}

function row<T>(sql: string, params: Array<string | number | null> = []): T | undefined {
  return sqlite.prepare(sql).get(...params) as T | undefined;
}

function parseOptions(raw: unknown, requireHash: boolean): TopicExportRequest {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TopicExportHttpError(400, {
      error: 'invalid_request',
      message: '请求体必须是 JSON 对象。',
    });
  }
  const body = raw as Record<string, unknown>;
  let includeArchived = true;
  if (body.includeArchived !== undefined) {
    if (typeof body.includeArchived !== 'boolean') {
      throw new TopicExportHttpError(400, {
        error: 'invalid_request',
        message: 'includeArchived 必须是布尔值。',
        field: 'includeArchived',
      });
    }
    includeArchived = body.includeArchived;
  }
  let includeBasisKeys: string[] = [];
  if (body.includeBasisKeys !== undefined) {
    if (!Array.isArray(body.includeBasisKeys)) {
      throw new TopicExportHttpError(400, {
        error: 'invalid_request',
        message: 'includeBasisKeys 必须是字符串数组。',
        field: 'includeBasisKeys',
      });
    }
    const normalized = body.includeBasisKeys.map((item) => {
      if (typeof item !== 'string' || !SOURCE_KEY_RE.test(item.trim())) {
        throw new TopicExportHttpError(400, {
          error: 'invalid_request',
          message: '一跳依据格式不正确。',
          field: 'includeBasisKeys',
        });
      }
      return item.trim();
    });
    includeBasisKeys = Array.from(new Set(normalized)).sort(compareStrings);
    if (includeBasisKeys.length > TOPIC_EXPORT_MAX_BASIS_KEYS) {
      throw new TopicExportHttpError(400, {
        error: 'invalid_request',
        message: `includeBasisKeys 最多只能选择 ${TOPIC_EXPORT_MAX_BASIS_KEYS} 个一跳依据。`,
        field: 'includeBasisKeys',
      });
    }
  }
  const result: TopicExportRequest = { includeArchived, includeBasisKeys };
  if (requireHash) {
    const hash = body.expectedScopeHash;
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw new TopicExportHttpError(400, {
        error: 'invalid_request',
        message: 'expectedScopeHash 必须是预览返回的 64 位小写十六进制字符串。',
        field: 'expectedScopeHash',
      });
    }
    result.expectedScopeHash = hash;
  }
  return result;
}

function readTopic(topicId: string): TopicRow {
  const topic = row<TopicRow>(
    `SELECT id, title, exploring_question AS exploringQuestion, continue_note AS continueNote,
            next_attempt_id AS nextAttemptId,
            next_attempt_cleared_reason AS nextAttemptClearedReason,
            revision, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM topics WHERE id = ?`,
    [topicId]
  );
  if (!topic) {
    throw new TopicExportHttpError(404, { error: 'topic_not_found', message: '主题已不存在。' });
  }
  return topic;
}

function readMemberRows(topicId: string): MemberRow[] {
  const raw = rows<{
    memberId: string;
    captureId: string;
    memberKind: string;
    addedAt: number;
    cId: string;
    cKind: string;
    cRawText: string;
    cRevision: number;
    cCreatedAt: number;
    cUpdatedAt: number;
    cArchivedAt: number | null;
    enCaptureId: string | null;
    enTitle: string | null;
    enUnderstandingOrigin: string | null;
    enModelBasis: string | null;
    enOriginKind: string | null;
    enOriginQueryId: string | null;
    enOriginPointIndex: number | null;
    enOriginAttemptId: string | null;
    enContextCaptureId: string | null;
    enConditionsText: string | null;
    enLimitationsText: string | null;
    enNeedsRevision: number | null;
    enRevisionReason: string | null;
    enCreatedAt: number | null;
    enUpdatedAt: number | null;
  }>(
    `SELECT m.id AS memberId, m.capture_id AS captureId, m.member_kind AS memberKind,
            m.created_at AS addedAt,
            c.id AS cId, c.kind AS cKind, c.raw_text AS cRawText, c.revision AS cRevision,
            c.created_at AS cCreatedAt, c.updated_at AS cUpdatedAt, c.archived_at AS cArchivedAt,
            en.capture_id AS enCaptureId, en.title AS enTitle,
            en.understanding_origin AS enUnderstandingOrigin, en.model_basis AS enModelBasis,
            en.origin_kind AS enOriginKind, en.origin_query_id AS enOriginQueryId,
            en.origin_point_index AS enOriginPointIndex, en.origin_attempt_id AS enOriginAttemptId,
            en.context_capture_id AS enContextCaptureId, en.conditions_text AS enConditionsText,
            en.limitations_text AS enLimitationsText, en.needs_revision AS enNeedsRevision,
            en.revision_reason AS enRevisionReason, en.created_at AS enCreatedAt,
            en.updated_at AS enUpdatedAt
       FROM topic_members m
       JOIN captures c ON c.id = m.capture_id
       LEFT JOIN experience_notes en ON en.capture_id = m.capture_id
      WHERE m.topic_id = ?
      ORDER BY m.created_at ASC, m.id ASC`,
    [topicId]
  );
  return raw.map((item) => {
    const capture: CaptureRow = {
      id: item.cId,
      kind: item.cKind,
      rawText: item.cRawText,
      revision: item.cRevision,
      createdAt: item.cCreatedAt,
      updatedAt: item.cUpdatedAt,
      archivedAt: item.cArchivedAt,
    };
    const note: ExperienceNoteRow | null = item.enCaptureId
      ? {
          captureId: item.enCaptureId,
          title: item.enTitle ?? firstLine(item.cRawText, 80),
          understandingOrigin: item.enUnderstandingOrigin ?? 'user_edited',
          modelBasis: item.enModelBasis ?? null,
          originKind: item.enOriginKind ?? 'manual',
          originQueryId: item.enOriginQueryId ?? null,
          originPointIndex: item.enOriginPointIndex ?? null,
          originAttemptId: item.enOriginAttemptId ?? null,
          contextCaptureId: item.enContextCaptureId ?? null,
          conditionsText: item.enConditionsText ?? null,
          limitationsText: item.enLimitationsText ?? null,
          needsRevision: item.enNeedsRevision ?? 0,
          revisionReason: item.enRevisionReason ?? null,
          createdAt: item.enCreatedAt ?? item.cCreatedAt,
          updatedAt: item.enUpdatedAt ?? item.cUpdatedAt,
        }
      : null;
    return {
      id: item.memberId,
      captureId: item.captureId,
      memberKind: item.memberKind,
      addedAt: item.addedAt,
      kind: capture.kind === 'experience' ? 'experience' : 'thought',
      capture,
      note,
    };
  });
}

function readCapturesByIds(ids: string[]): Map<string, CaptureRow> {
  const map = new Map<string, CaptureRow>();
  if (ids.length === 0) return map;
  const found = rows<CaptureRow>(
    `SELECT id, kind, raw_text AS rawText, revision, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt
       FROM captures WHERE id IN (${placeholders(ids.length)})`,
    ids
  );
  for (const capture of found) map.set(capture.id, capture);
  return map;
}

function readAttemptRowsForCaptures(captureIds: string[]): AttemptRow[] {
  if (captureIds.length === 0) return [];
  return rows<AttemptRow>(
    `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
            outcome, source_url AS sourceUrl, observed_at AS observedAt, revision,
            created_at AS createdAt, updated_at AS updatedAt, origin,
            action_description AS actionDescription, estimated_minutes AS estimatedMinutes,
            source_review_id AS sourceReviewId, source_experience_index AS sourceExperienceIndex,
            source_attempt_id AS sourceAttemptId, source_attempt_revision AS sourceAttemptRevision,
            source_research_id AS sourceResearchId,
            source_research_experiment_index AS sourceResearchExperimentIndex,
            research_suggested_json AS researchSuggestedJson,
            research_source_ids_json AS researchSourceIdsJson
       FROM attempts
      WHERE capture_id IN (${placeholders(captureIds.length)})
      ORDER BY created_at ASC, id ASC`,
    captureIds
  );
}

function readAttemptRowsByIds(ids: string[]): AttemptRow[] {
  if (ids.length === 0) return [];
  return rows<AttemptRow>(
    `SELECT id, capture_id AS captureId, step, state, result_text AS resultText,
            outcome, source_url AS sourceUrl, observed_at AS observedAt, revision,
            created_at AS createdAt, updated_at AS updatedAt, origin,
            action_description AS actionDescription, estimated_minutes AS estimatedMinutes,
            source_review_id AS sourceReviewId, source_experience_index AS sourceExperienceIndex,
            source_attempt_id AS sourceAttemptId, source_attempt_revision AS sourceAttemptRevision,
            source_research_id AS sourceResearchId,
            source_research_experiment_index AS sourceResearchExperimentIndex,
            research_suggested_json AS researchSuggestedJson,
            research_source_ids_json AS researchSourceIdsJson
       FROM attempts
      WHERE id IN (${placeholders(ids.length)})
      ORDER BY created_at ASC, id ASC`,
    ids
  );
}

function readExperienceNotes(ids: string[]): Map<string, ExperienceNoteRow> {
  const map = new Map<string, ExperienceNoteRow>();
  if (ids.length === 0) return map;
  const found = rows<ExperienceNoteRow>(
    `SELECT capture_id AS captureId, title,
            understanding_origin AS understandingOrigin, model_basis AS modelBasis,
            origin_kind AS originKind, origin_query_id AS originQueryId,
            origin_point_index AS originPointIndex, origin_attempt_id AS originAttemptId,
            context_capture_id AS contextCaptureId, conditions_text AS conditionsText,
            limitations_text AS limitationsText, needs_revision AS needsRevision,
            revision_reason AS revisionReason, created_at AS createdAt, updated_at AS updatedAt
       FROM experience_notes WHERE capture_id IN (${placeholders(ids.length)})`,
    ids
  );
  for (const note of found) map.set(note.captureId, note);
  return map;
}

function readRelationRows(
  allMemberCaptureIds: string[],
  allAttemptIds: string[],
  allExperienceIds: string[]
): {
  captureLinks: CaptureLinkRow[];
  attemptReferences: ReferenceRow[];
  experienceSources: ExperienceSourceRow[];
  experienceAttempts: ExperienceAttemptRow[];
} {
  const captureLinks: CaptureLinkRow[] = [];
  if (allMemberCaptureIds.length) {
    const ph = placeholders(allMemberCaptureIds.length);
    captureLinks.push(
      ...rows<CaptureLinkRow>(
        `SELECT id, from_capture_id AS fromCaptureId, to_capture_id AS toCaptureId,
                note, revision, created_at AS createdAt, updated_at AS updatedAt
           FROM capture_links
          WHERE from_capture_id IN (${ph}) OR to_capture_id IN (${ph})
          ORDER BY created_at ASC, id ASC`,
        [...allMemberCaptureIds, ...allMemberCaptureIds]
      )
    );
  }
  const attemptReferences: ReferenceRow[] = [];
  if (allAttemptIds.length) {
    const ph = placeholders(allAttemptIds.length);
    attemptReferences.push(
      ...rows<ReferenceRow>(
        `SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId,
                revision, note, snapshot_result_text AS snapshotResultText,
                snapshot_revision AS snapshotRevision, created_at AS createdAt
           FROM attempt_references
          WHERE from_attempt_id IN (${ph}) OR to_attempt_id IN (${ph})
          ORDER BY created_at ASC, id ASC`,
        [...allAttemptIds, ...allAttemptIds]
      )
    );
  }
  const experienceSources: ExperienceSourceRow[] = [];
  if (allExperienceIds.length) {
    const ph = placeholders(allExperienceIds.length);
    experienceSources.push(
      ...rows<ExperienceSourceRow>(
        `SELECT id, experience_id AS experienceId, source_key AS sourceKey,
                source_type AS sourceType, source_id AS sourceId,
                source_capture_id AS sourceCaptureId, source_title AS sourceTitle,
                source_text AS sourceText, source_result_text AS sourceResultText,
                outcome, state, observed_at AS observedAt,
                source_revision AS sourceRevision,
                source_capture_revision AS sourceCaptureRevision,
                source_kind AS sourceKind, deleted,
                created_at AS createdAt, updated_at AS updatedAt
           FROM experience_sources
          WHERE experience_id IN (${ph})
          ORDER BY created_at ASC, id ASC`,
        allExperienceIds
      )
    );
  }
  const experienceAttempts: ExperienceAttemptRow[] = [];
  if (allAttemptIds.length || allExperienceIds.length) {
    const attemptPh = placeholders(Math.max(1, allAttemptIds.length));
    const expPh = placeholders(Math.max(1, allExperienceIds.length));
    const attemptParams = allAttemptIds.length ? allAttemptIds : ['__none__'];
    const expParams = allExperienceIds.length ? allExperienceIds : ['__none__'];
    experienceAttempts.push(
      ...rows<ExperienceAttemptRow>(
        `SELECT attempt_id AS attemptId, experience_capture_id AS experienceCaptureId,
                adopted_version AS adoptedVersion, adopted_title AS adoptedTitle,
                adopted_understanding AS adoptedUnderstanding,
                basis_source_keys_json AS basisSourceKeysJson, deleted,
                created_at AS createdAt
           FROM experience_attempts
          WHERE attempt_id IN (${attemptPh}) OR experience_capture_id IN (${expPh})
          ORDER BY created_at ASC, attempt_id ASC`,
        [...attemptParams, ...expParams]
      )
    );
  }
  return { captureLinks, attemptReferences, experienceSources, experienceAttempts };
}

function titleOfCapture(capture: CaptureRow, note: ExperienceNoteRow | null): string {
  if (note?.title?.trim()) return firstLine(note.title, 120);
  return firstLine(capture.rawText, 120) || '（无标题）';
}

function summaryOfCapture(capture: CaptureRow): string {
  return firstLine(capture.rawText, 160);
}

function buildBasisCandidates(
  includedExperiences: MemberRow[],
  experienceSources: ExperienceSourceRow[],
  initialIncludedKeys: Set<string>,
  capturesById: Map<string, CaptureRow>,
  attemptsById: Map<string, AttemptRow>
): Map<string, BasisInternal> {
  const expOrder = new Map<string, number>();
  const expTitle = new Map<string, string>();
  includedExperiences.forEach((member, index) => {
    expOrder.set(member.captureId, index);
    expTitle.set(member.captureId, titleOfCapture(member.capture, member.note));
  });
  const byKey = new Map<string, BasisInternal & { references: Array<{ order: number; title: string }> }>();

  for (const source of experienceSources) {
    if (!expOrder.has(source.experienceId)) continue;
    if (source.sourceType !== 'attempt' && source.sourceType !== 'capture') continue;
    if (source.sourceType === 'capture' && source.sourceKind === 'experience') continue;
    const [rawType, rawId] = source.sourceKey.split(':');
    if (!rawId || (rawType !== 'attempt' && rawType !== 'capture')) continue;
    const sourceType = rawType as 'attempt' | 'capture';
    const entityType: EntityType = sourceType === 'attempt' ? 'attempt' : 'thought';
    const entityKey = entityKeyOf(entityType, rawId);
    if (initialIncludedKeys.has(entityKey)) continue;

    let candidate = byKey.get(source.sourceKey);
    if (!candidate) {
      const deleted = Boolean(source.deleted);
      let capture: CaptureRow | undefined;
      let attempt: AttemptRow | undefined;
      let parentCapture: CaptureRow | undefined;
      let title = '来源已删除';
      let summary = '';
      let missing = deleted;
      if (!deleted) {
        if (sourceType === 'attempt') {
          attempt = attemptsById.get(rawId) ?? readAttemptRowsByIds([rawId])[0];
          if (attempt) {
            attemptsById.set(attempt.id, attempt);
            parentCapture =
              capturesById.get(attempt.captureId) ?? readCapturesByIds([attempt.captureId]).get(attempt.captureId);
            if (parentCapture) capturesById.set(parentCapture.id, parentCapture);
            title = firstLine(attempt.step, 120);
            summary = firstLine(attempt.resultText || attempt.actionDescription || attempt.step, 160);
          } else {
            missing = true;
          }
        } else {
          capture = capturesById.get(rawId) ?? readCapturesByIds([rawId]).get(rawId);
          if (capture && capture.kind !== 'experience') {
            capturesById.set(capture.id, capture);
            title = firstLine(capture.rawText, 120);
            summary = summaryOfCapture(capture);
          } else {
            missing = true;
          }
        }
      }
      candidate = {
        sourceKey: source.sourceKey,
        entityType,
        entityId: rawId,
        title: missing ? '来源已删除' : title,
        summary: missing ? '' : summary,
        sourceExperienceId: source.experienceId,
        sourceExperienceTitle: expTitle.get(source.experienceId) ?? '（未命名经验）',
        referencedBy: [],
        deleted: missing,
        selectable: !missing,
        reason: missing ? '来源已删除' : '经验依据',
        sourceType,
        capture,
        attempt,
        parentCapture,
        references: [],
      } as BasisInternal & { references: Array<{ order: number; title: string }> };
      byKey.set(source.sourceKey, candidate);
    }
    candidate.references.push({
      order: expOrder.get(source.experienceId) ?? 0,
      title: expTitle.get(source.experienceId) ?? '（未命名经验）',
    });
  }

  const result = new Map<string, BasisInternal>();
  for (const [key, candidate] of byKey) {
    const titles = Array.from(
      new Set(
        candidate.references
          .sort((a, b) => a.order - b.order || compareStrings(a.title, b.title))
          .map((item) => item.title)
      )
    );
    const { references: _references, ...publicCandidate } = candidate;
    void _references;
    result.set(key, { ...publicCandidate, referencedBy: titles });
  }
  return result;
}

function normalizedTomlDate(ms: number): string {
  return new Date(ms).toISOString();
}

function frontmatter(input: {
  entity: 'index' | 'readme' | EntityType;
  id: string;
  captureId?: string;
  topic: TopicRow;
  createdAt: number;
  updatedAt: number;
  revision: number | null;
  archived: boolean;
}): string {
  const lines = [
    '---',
    `shinian_entity: ${yamlScalar(input.entity)}`,
    `shinian_id: ${yamlScalar(input.id)}`,
  ];
  if (input.captureId) lines.push(`shinian_capture_id: ${yamlScalar(input.captureId)}`);
  lines.push(
    `shinian_topic_id: ${yamlScalar(input.topic.id)}`,
    `shinian_created_at: ${yamlScalar(input.createdAt)}`,
    `shinian_updated_at: ${yamlScalar(input.updatedAt)}`,
    `shinian_revision: ${yamlScalar(input.revision)}`,
    `shinian_archived: ${yamlScalar(input.archived)}`,
    '---',
    ''
  );
  return lines.join('\n');
}

function encodedRelativeLink(fromPath: string, toPath: string): string {
  const dir = path.posix.dirname(fromPath);
  const relative = path.posix.relative(dir, toPath);
  const normalized = path.posix.normalize(path.posix.join(dir, relative));
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new TopicExportHttpError(500, {
      error: 'export_failed',
      message: '导出失败：生成了越界的内部链接。',
    });
  }
  return relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function markdownLink(fromPath: string, target: ExportFileEntry | null | undefined): string | null {
  if (!target) return null;
  return `[${mdInline(target.title)}](${encodedRelativeLink(fromPath, target.path)})`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}

function hashScope(snapshot: Snapshot): string {
  const allMembers = snapshot.allMembers
    .map((member) => ({
      key: `${member.id}:${member.captureId}`,
      memberKind: member.memberKind,
      kind: member.kind,
      addedAt: member.addedAt,
      capture: member.capture,
      note: member.note,
    }))
    .sort((a, b) => compareStrings(a.key, b.key));
  const allThoughtAttemptRows = snapshot.allThoughtAttempts
    .map((attempt) => ({ ...attempt }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const allAttemptRowsInScope = Array.from(snapshot.attemptsById.values())
    .map((attempt) => ({ ...attempt }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const basisEntities = snapshot.basisEntities
    .map((basis) => ({
      sourceKey: basis.sourceKey,
      entityType: basis.entityType,
      entityId: basis.entityId,
      title: basis.title,
      capture: basis.capture ?? null,
      attempt: basis.attempt ?? null,
      parentCapture: basis.parentCapture ?? null,
    }))
    .sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
  const captures = Array.from(snapshot.capturesById.values())
    .map((capture) => ({ ...capture }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const notes = Array.from(snapshot.notesById.values())
    .map((note) => ({ ...note }))
    .sort((a, b) => compareStrings(a.captureId, b.captureId));
  const captureLinks = snapshot.captureLinks
    .map((link) => ({ ...link }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const attemptReferences = snapshot.attemptReferences
    .map((ref) => ({ ...ref }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const experienceSources = snapshot.experienceSources
    .map((source) =>
      source.deleted
        ? {
            id: source.id,
            experienceId: source.experienceId,
            sourceKey: source.sourceKey,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceRevision: source.sourceRevision,
            deleted: source.deleted,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
          }
        : { ...source }
    )
    .sort((a, b) => compareStrings(a.id, b.id));
  const experienceAttempts = snapshot.experienceAttempts
    .map((item) =>
      item.deleted
        ? {
            attemptId: item.attemptId,
            experienceCaptureId: item.experienceCaptureId,
            adoptedVersion: item.adoptedVersion,
            deleted: item.deleted,
            createdAt: item.createdAt,
          }
        : { ...item }
    )
    .sort((a, b) => compareStrings(`${a.attemptId}:${a.experienceCaptureId}`, `${b.attemptId}:${b.experienceCaptureId}`));
  const basisCandidates = snapshot.basisCandidates
    .map((candidate) => ({ ...candidate }))
    .sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
  const signature = {
    formatVersion: TOPIC_EXPORT_FORMAT_VERSION,
    topic: snapshot.topic,
    options: snapshot.options,
    allMembers,
    allThoughtAttemptRows,
    allAttemptRowsInScope,
    basisEntities,
    captures,
    notes,
    captureLinks,
    attemptReferences,
    experienceSources,
    experienceAttempts,
    basisCandidates,
    includedCaptureKeys: Array.from(snapshot.includedCaptureKeys).sort(compareStrings),
    includedAttemptKeys: Array.from(snapshot.includedAttemptKeys).sort(compareStrings),
    counts: snapshot.counts,
    omitted: snapshot.omitted,
    archived: snapshot.archived,
    files: snapshot.files.map((file) => ({ ...file, bytes: undefined, sha256: undefined })),
    relations: snapshot.relations.map((relation) => ({ ...relation })),
    warnings: [...snapshot.warnings].sort(compareStrings),
    limits: snapshot.limits,
  };
  return createHash('sha256').update(stableStringify(signature)).digest('hex');
}

function relationTypeLabel(type: ExportRelation['type']): string {
  return RELATION_LABEL[type];
}

function renderReadme(snapshot: Snapshot): string {
  const topic = snapshot.topic;
  const fm = frontmatter({
    entity: 'readme',
    id: topic.id,
    topic,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    revision: null,
    archived: topic.archivedAt !== null,
  });
  return `${fm}# 拾念主题导出说明

这是「${mdInline(topic.title)}」的一次性 Markdown 导出副本。

## 如何阅读

1. 先打开 [主题索引](${encodedRelativeLink('README.md', '主题索引.md')})。
2. 索引中的「主题收录」列出本主题包含的念头与经验；链接会打开 \`records/\` 下的记录。
3. 记录里的链接是标准 Markdown 相对链接，Obsidian 会据此生成反链。反链由链接推导，不额外编造新的业务关系。
4. \`manifest.json\` 保存文件、实体、关系类型与方向的机器可读映射。

## 范围

- 导出时当前内容：每个记录文件都标注稳定 ID、创建/更新时间与当前版本。
- 历史快照：引用、依据、采用关系建立时保存的旧文本，单独标为「历史快照，不代表当前内容」。
- 未包含/已删除来源：只写占位文字，不写标题或正文，不生成指向不存在文件的链接。
- 普通 Markdown 图谱不能完整表达拾念的全部关系类型与交互；本包不等同于拾念界面。

## 重要说明

- 这是**独立副本**：之后在拾念中的修改或删除不会自动更新已下载的文件。
- 本导出是单向的，不提供导入、双向同步、目录监听或增量更新。
- 正文中的远程链接只作为文本保存，导出过程不会执行脚本或下载远程资源。
- 文件使用 UTF-8 与 LF 换行；请用支持 UTF-8 的 Markdown 阅读器打开。
`;
}

function renderIndex(snapshot: Snapshot): string {
  const topic = snapshot.topic;
  const fm = frontmatter({
    entity: 'index',
    id: topic.id,
    topic,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    revision: topic.revision,
    archived: topic.archivedAt !== null,
  });
  const indexPath = '主题索引.md';
  const chunks: string[] = [fm, `# ${mdInline(topic.title)}`, '', '> 拾念主题导出 · 稳定 ID：`' + topic.id + '`', ''];
  chunks.push('## 探索问题', '', fencedText(topic.exploringQuestion || '（未填写）'), '');
  chunks.push('## 继续说明', '', fencedText(topic.continueNote || '（未填写）'), '');
  chunks.push('## 主题收录记录', '');
  const memberEntries = snapshot.files.filter(
    (file) =>
      (file.entityType === 'thought' || file.entityType === 'experience') && !file.basis
  );
  if (memberEntries.length === 0) {
    chunks.push('本次导出没有包含主题成员。', '');
  } else {
    for (const file of memberEntries) {
      const link = markdownLink(indexPath, file);
      const label = file.entityType === 'experience' ? '经验' : '念头';
      chunks.push(`- ${label}：${link ?? mdInline(file.title)}${file.archived ? ' · 已归档' : ''}`);
    }
    chunks.push('');
  }
  const attemptEntries = snapshot.files.filter((file) => file.entityType === 'attempt');
  chunks.push('## 包含的真实尝试', '');
  if (attemptEntries.length === 0) {
    chunks.push('本次导出没有包含尝试。', '');
  } else {
    for (const file of attemptEntries) {
      chunks.push(`- ${markdownLink(indexPath, file) ?? mdInline(file.title)}${file.basis ? ' · 一跳依据' : ''}`);
    }
    chunks.push('');
  }
  chunks.push('## 下次继续', '');
  if (snapshot.nextAttempt) {
    const file = snapshot.fileByEntity.get(entityKeyOf('attempt', snapshot.nextAttempt.id));
    chunks.push(
      `- ${markdownLink(indexPath, file) ?? mdInline(snapshot.nextAttempt.step)} · 状态：${STATE_LABEL[snapshot.nextAttempt.state] ?? snapshot.nextAttempt.state}`
    );
  } else if (topic.nextAttemptId) {
    chunks.push('固定的下一步已失效或未包含在本次导出，未生成链接。');
  } else {
    chunks.push('尚未固定下一步。');
  }
  chunks.push('');
  chunks.push('## 知识依据关系（与主题收录分开）', '');
  const knowledgeRelations = snapshot.relations.filter(
    (relation) =>
      relation.type !== 'topic_member' &&
      relation.type !== 'contains_attempt' &&
      relation.fromFile &&
      relation.toFile
  );
  if (knowledgeRelations.length === 0) {
    chunks.push('本次导出没有包含两端都在包内的知识依据关系。', '');
  } else {
    for (const relation of knowledgeRelations) {
      const fromFile = snapshot.files.find((file) => file.path === relation.fromFile);
      const toFile = snapshot.files.find((file) => file.path === relation.toFile);
      const fromLink = markdownLink(indexPath, fromFile) ?? `\`${relation.from}\``;
      const toLink = markdownLink(indexPath, toFile) ?? `\`${relation.to}\``;
      const suffix =
        relation.type === 'attempt_reference' && relation.snapshotRevision
          ? ` · 引用时快照 revision ${relation.snapshotRevision}`
          : relation.type === 'experience_source' && relation.sourceRevision
            ? ` · 依据建立时 source revision ${relation.sourceRevision}`
            : relation.type === 'experience_adoption' && relation.adoptedVersion
              ? ` · 采用时经验版本 v${relation.adoptedVersion}`
              : '';
      chunks.push(`- ${relationTypeLabel(relation.type)}（${relation.direction}）：${fromLink} → ${toLink}${suffix}`);
    }
    chunks.push('');
  }
  chunks.push('## 未包含的关联', '');
  chunks.push(`共 ${snapshot.omitted.total} 条关系指向未包含或已删除的记录；包内不生成这些链接，也不写对方标题或正文。`);
  chunks.push(
    `- 手动关联 ${snapshot.omitted.byType.manualLink} 条 · 尝试引用 ${snapshot.omitted.byType.attemptReference} 条 · 经验依据 ${snapshot.omitted.byType.experienceSource} 条 · 经验采用 ${snapshot.omitted.byType.experienceAdoption} 条`,
    ''
  );
  const basisFiles = snapshot.files.filter((file) => file.basis);
  chunks.push('## 用户追加的一跳直接依据', '');
  if (basisFiles.length === 0) {
    chunks.push('本次未追加主题外依据。', '');
  } else {
    for (const file of basisFiles) {
      chunks.push(`- ${markdownLink(indexPath, file) ?? mdInline(file.title)} · 仅追加该条记录本身`);
    }
    chunks.push('');
  }
  chunks.push('## 导出范围与限制', '');
  chunks.push(`- 包含归档主题成员：${snapshot.options.includeArchived ? '是' : '否'}`);
  chunks.push(`- 文件数：${snapshot.counts.files} · 尝试数：${snapshot.counts.attempts}`);
  chunks.push(`- 一跳依据：${snapshot.options.includeBasisKeys.length} 条`);
  chunks.push('- 下载后是独立副本，之后在拾念中的修改或删除不会自动更新已下载文件。');
  chunks.push('- 普通 Markdown 图谱不能完整表达拾念的所有关系类型与交互，不承诺界面一致。');
  chunks.push('');
  return chunks.join('\n');
}

function omittedPlaceholder(kind: 'missing' | 'notIncluded'): string {
  return kind === 'missing' ? '来源已删除' : '来源未包含在本次导出';
}

function renderThoughtFile(snapshot: Snapshot, file: ExportFileEntry): string {
  const capture = snapshot.capturesById.get(file.entityId ?? '')!;
  const note = snapshot.notesById.get(capture.id) ?? null;
  const fm = frontmatter({
    entity: 'thought',
    id: capture.id,
    captureId: capture.id,
    topic: snapshot.topic,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt,
    revision: capture.revision,
    archived: capture.archivedAt !== null,
  });
  const chunks = [fm, `# ${mdInline(file.title)}`, '', '> 拾念 · 普通念头 · 导出时当前内容', ''];
  chunks.push(`稳定 ID：\`${capture.id}\` · 当前版本 v${capture.revision}${capture.archivedAt !== null ? ' · 已归档' : ''}`, '');
  chunks.push('## 原文（导出时当前内容）', '', fencedText(capture.rawText), '');
  const attempts = snapshot.attemptsByCapture.get(capture.id) ?? [];
  chunks.push('## 相关尝试（念头包含尝试）', '');
  if (attempts.length === 0) {
    chunks.push('本次导出没有包含该念头下的尝试。', '');
  } else {
    for (const attemptFile of attempts) {
      const link = markdownLink(file.path, attemptFile);
      const attempt = snapshot.attemptsById.get(attemptFile.entityId ?? '');
      const state = attempt ? STATE_LABEL[attempt.state] ?? attempt.state : '';
      chunks.push(`- ${link ?? mdInline(attemptFile.title)} · 状态：${state}`);
    }
    chunks.push('');
  }
  chunks.push('## 手动关联（关联到）', '');
  const out = snapshot.manualLinksOut.get(entityKeyOf('thought', capture.id)) ?? [];
  let omittedOutCount = snapshot.omittedManualOut.has(capture.id) ? 1 : 0;
  if (out.length === 0 && omittedOutCount === 0) chunks.push('没有主动关联出去的记录。');
  for (const relation of out) {
    const target = snapshot.files.find((entry) => entry.path === relation.toFile);
    chunks.push(
      `- 关联到 ${markdownLink(file.path, target) ?? mdInline(target?.title ?? '')}${relation.note ? ` · 说明：${mdInline(relation.note)}` : ''}`
    );
  }
  if (omittedOutCount > 0) chunks.push(`- ${omittedPlaceholder('notIncluded')}（另有 ${omittedOutCount} 条出向关联未包含）`);
  chunks.push('');
  chunks.push('## 手动关联（被关联，同一关系的反向视图）', '');
  const incoming = snapshot.manualLinksIn.get(entityKeyOf('thought', capture.id)) ?? [];
  const omittedInCount = snapshot.omittedManualIn.has(capture.id) ? 1 : 0;
  if (incoming.length === 0 && omittedInCount === 0) chunks.push('没有其他记录关联到这里。');
  for (const relation of incoming) {
    const source = snapshot.files.find((entry) => entry.path === relation.fromFile);
    chunks.push(
      `- 被 ${markdownLink(file.path, source) ?? mdInline(source?.title ?? '')} 关联${relation.note ? ` · 说明：${mdInline(relation.note)}` : ''}`
    );
  }
  if (omittedInCount > 0) chunks.push(`- ${omittedPlaceholder('notIncluded')}（另有 ${omittedInCount} 条入向关联未包含）`);
  chunks.push('');
  if (note) {
    chunks.push('> 该 capture 同时是经验笔记时，仍只导出为一份经验文件；本文件不会出现。', '');
  }
  return chunks.join('\n');
}

function renderExperienceFile(snapshot: Snapshot, file: ExportFileEntry): string {
  const capture = snapshot.capturesById.get(file.entityId ?? '')!;
  const note: ExperienceNoteRow = snapshot.notesById.get(capture.id) ?? {
    captureId: capture.id,
    title: file.title,
    understandingOrigin: 'user_edited',
    modelBasis: null,
    originKind: 'manual',
    originQueryId: null,
    originPointIndex: null,
    originAttemptId: null,
    contextCaptureId: null,
    conditionsText: null,
    limitationsText: null,
    needsRevision: 0,
    revisionReason: null,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt,
  };
  const fm = frontmatter({
    entity: 'experience',
    id: capture.id,
    captureId: capture.id,
    topic: snapshot.topic,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt,
    revision: capture.revision,
    archived: capture.archivedAt !== null,
  });
  const chunks = [fm, `# ${mdInline(file.title)}`, '', '> 拾念 · 经验笔记 · 导出时当前内容', ''];
  chunks.push(`稳定 ID：\`${capture.id}\` · 当前版本 v${capture.revision}${capture.archivedAt !== null ? ' · 已归档' : ''}`, '');
  const byModel = note.understandingOrigin === 'model_draft';
  chunks.push(`整理方式：${byModel ? '模型辅助整理，用户尚未改写正文' : '用户整理'}`);
  if (note.modelBasis === 'observation') chunks.push('模型依据：来自可观察记录');
  if (note.modelBasis === 'inference') chunks.push('模型依据：模型推断整理');
  if (note.needsRevision) chunks.push(`待修订：${mdInline(note.revisionReason || '用户标记待修订')}`);
  chunks.push('');
  chunks.push('## 我的理解（导出时当前内容）', '', fencedText(capture.rawText), '');
  chunks.push('## 适用条件（导出时当前内容）', '', fencedText(note.conditionsText || '（未填写）'), '');
  chunks.push('## 限制或还不确定的地方（导出时当前内容）', '', fencedText(note.limitationsText || '（未填写）'), '');
  const originText =
    note.originKind === 'attempt'
      ? '从一次尝试整理'
      : note.originKind === 'ask'
        ? '从「问我的记录」的一条观点整理'
        : '手动整理';
  chunks.push('## 整理出处', '', `- ${originText}`);
  if (note.originAttemptId) {
    const originFile = snapshot.fileByEntity.get(entityKeyOf('attempt', note.originAttemptId));
    if (originFile) chunks.push(`- 整理自本次导出包含的尝试：${markdownLink(file.path, originFile) ?? mdInline(originFile.title)}`);
    else chunks.push('- 整理自一次尝试：来源未包含在本次导出');
  }
  chunks.push('');
  chunks.push('## 依据（经验依据原记录）', '');
  const sources = snapshot.expSourcesOut.get(entityKeyOf('experience', capture.id)) ?? [];
  const sourceRows = snapshot.experienceSources.filter(
    (source) => source.experienceId === capture.id && expOrderMatches(snapshot, source.experienceId)
  );
  if (sources.length === 0 && snapshot.omittedExpSources.has(capture.id) === false && sourceRows.length === 0) {
    chunks.push('没有已包含的依据。', '');
  } else {
    for (const source of sourceRows) {
      if (source.deleted) {
        chunks.push('- 来源已删除（不恢复快照正文）');
        continue;
      }
      const relation = sources.find((item) => item.id === source.id);
      if (!relation) {
        chunks.push('- 来源未包含在本次导出');
        continue;
      }
      const target = snapshot.files.find((entry) => entry.path === relation.toFile);
      chunks.push(`- 依据 ${markdownLink(file.path, target) ?? mdInline(target?.title ?? '')}`);
      chunks.push(`  - 依据建立时快照（source revision ${source.sourceRevision}，历史内容，不代表当前）：`);
      chunks.push(`    ${fencedText(source.sourceText).split('\n').join('\n    ')}`);
      if (source.sourceResultText) {
        chunks.push(`    - 依据建立时的结果快照（历史内容）：${fencedText(source.sourceResultText).split('\n').join('\n    ')}`);
      }
      const current = snapshot.capturesById.get(source.sourceId) ?? snapshot.attemptsById.get(source.sourceId);
      if (current && 'revision' in current && current.revision !== source.sourceRevision) {
        chunks.push('  - 来源已更新：当前正文见链接目标，以上仅为历史快照。');
      }
    }
    chunks.push('');
  }
  const adoptions = snapshot.adoptionsByExperience.get(entityKeyOf('experience', capture.id)) ?? [];
  chunks.push('## 后续实践（同一采用关系的反向视图）', '');
  if (adoptions.length === 0) {
    if (snapshot.omittedAdoptionsByExperience.has(capture.id)) chunks.push('来源未包含在本次导出');
    else chunks.push('本次导出没有包含采用这份经验的后续尝试。');
  } else {
    for (const adoption of adoptions) {
      const attemptFile = snapshot.files.find((entry) => entry.path === adoption.fromFile);
      chunks.push(
        `- 被 ${markdownLink(file.path, attemptFile) ?? mdInline(attemptFile?.title ?? '')} 采用 · 采用时经验版本 v${adoption.adoptedVersion ?? '?'}`
      );
    }
  }
  chunks.push('');
  return chunks.join('\n');
}

function expOrderMatches(snapshot: Snapshot, experienceId: string): boolean {
  return snapshot.includedCaptureKeys.has(entityKeyOf('experience', experienceId));
}

function resultTextLabel(attempt: AttemptRow): string {
  if (attempt.resultText && attempt.resultText.trim()) return fencedText(attempt.resultText);
  if (attempt.state === 'done') return '已标记完成但未填写实际结果（不能据此判断成败）。';
  return '尚未填写实际结果（不能据此判断成败）。';
}

function renderAttemptFile(snapshot: Snapshot, file: ExportFileEntry): string {
  const attempt = snapshot.attemptsById.get(file.entityId ?? '')!;
  const parentCapture = snapshot.capturesById.get(attempt.captureId);
  const fm = frontmatter({
    entity: 'attempt',
    id: attempt.id,
    captureId: attempt.captureId,
    topic: snapshot.topic,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    revision: attempt.revision,
    archived: parentCapture?.archivedAt !== null && parentCapture?.archivedAt !== undefined,
  });
  const chunks = [fm, `# ${mdInline(file.title)}`, '', '> 拾念 · 尝试 · 导出时当前内容', ''];
  chunks.push(`稳定 ID：\`${attempt.id}\` · 当前版本 v${attempt.revision} · 所属念头 ID：\`${attempt.captureId}\``, '');
  chunks.push('## 行动（导出时当前内容）', '', fencedText(attempt.step), '');
  if (attempt.actionDescription) {
    chunks.push('## 行动说明（导出时当前内容）', '', fencedText(attempt.actionDescription), '');
  }
  chunks.push('## 状态', '', `- 状态：${STATE_LABEL[attempt.state] ?? attempt.state}`);
  chunks.push(`- 评价：${attempt.outcome ? OUTCOME_LABEL[attempt.outcome] ?? attempt.outcome : '未填写（用户观察评价，不是系统结论）'}`);
  chunks.push(`- 观察时间：${attempt.observedAt ? normalizedTomlDate(attempt.observedAt) : '未填写'}`);
  if (attempt.sourceUrl) chunks.push(`- 来源链接（仅文本，导出不访问）：\`${mdInline(attempt.sourceUrl)}\``);
  chunks.push('');
  chunks.push('## 实际结果（用户观察，导出时当前内容）', '', resultTextLabel(attempt), '');
  chunks.push('## 所属念头', '');
  const parentKey = captureEntityKey(attempt.captureId, parentCapture?.kind ?? 'thought');
  const parentFile = snapshot.fileByEntity.get(parentKey);
  if (parentFile) chunks.push(`- ${markdownLink(file.path, parentFile) ?? mdInline(parentFile.title)}`);
  else if (parentCapture) chunks.push('- 来源未包含在本次导出');
  else chunks.push('- 来源已删除');
  chunks.push('');
  const outRefs = snapshot.refsOut.get(entityKeyOf('attempt', attempt.id)) ?? [];
  chunks.push('## 引用（我参考了什么）', '');
  if (outRefs.length === 0 && !snapshot.omittedRefsOut.has(attempt.id)) chunks.push('没有引用旧结果。');
  for (const relation of outRefs) {
    const target = snapshot.files.find((entry) => entry.path === relation.toFile);
    chunks.push(`- 引用了 ${markdownLink(file.path, target) ?? mdInline(target?.title ?? '')}`);
    chunks.push(`  - 引用时快照（revision ${relation.snapshotRevision ?? '?'}，历史内容，不代表当前）：${fencedText(relation.snapshotResultText).split('\n').join('\n    ')}`);
    const targetAttempt = snapshot.attemptsById.get(relation.to.replace(/^attempt:/u, ''));
    if (targetAttempt && targetAttempt.revision !== (relation.snapshotRevision ?? targetAttempt.revision)) {
      chunks.push('  - 来源结果已更新；当前结果见链接目标。');
    }
  }
  if (snapshot.omittedRefsOut.has(attempt.id)) chunks.push('- 来源未包含在本次导出');
  chunks.push('');
  const inRefs = snapshot.refsIn.get(entityKeyOf('attempt', attempt.id)) ?? [];
  chunks.push('## 被引用（后来哪里用过这条结果）', '');
  if (inRefs.length === 0 && !snapshot.omittedRefsIn.has(attempt.id)) chunks.push('还没有其他尝试引用这条结果。');
  for (const relation of inRefs) {
    const source = snapshot.files.find((entry) => entry.path === relation.fromFile);
    chunks.push(`- 被 ${markdownLink(file.path, source) ?? mdInline(source?.title ?? '')} 引用`);
    chunks.push(`  - 引用时快照（revision ${relation.snapshotRevision ?? '?'}，历史内容，不代表当前）：${fencedText(relation.snapshotResultText).split('\n').join('\n    ')}`);
  }
  if (snapshot.omittedRefsIn.has(attempt.id)) chunks.push('- 来源未包含在本次导出');
  chunks.push('');
  const adoptions = snapshot.adoptionsByAttempt.get(entityKeyOf('attempt', attempt.id)) ?? [];
  chunks.push('## 采用经验', '');
  if (adoptions.length === 0) {
    if (snapshot.omittedAdoptionsByAttempt.has(attempt.id)) chunks.push('- 来源未包含在本次导出 / 来源经验已删除');
    else chunks.push('没有采用经验的历史记录。');
  } else {
    for (const adoption of adoptions) {
      const expFile = snapshot.files.find((entry) => entry.path === adoption.toFile);
      chunks.push(
        `- 采用 ${markdownLink(file.path, expFile) ?? mdInline(expFile?.title ?? '')} · 采用时经验版本 v${adoption.adoptedVersion ?? '?'}`
      );
      chunks.push(`  - 采用时标题（历史快照）：${mdInline(adoption.adoptedTitle ?? '')}`);
      chunks.push(`  - 采用时理解（历史快照，不代表当前正文）：${fencedText(adoption.adoptedUnderstanding).split('\n').join('\n    ')}`);
      const current = snapshot.capturesById.get(adoption.to.replace(/^experience:/u, ''));
      if (current && current.revision !== (adoption.adoptedVersion ?? current.revision)) {
        chunks.push(`  - 经验已更新（采用时 v${adoption.adoptedVersion}，当前 v${current.revision}）；当前正文见链接目标。`);
      }
    }
  }
  chunks.push('');
  return chunks.join('\n');
}

function renderEntry(snapshot: Snapshot, file: ExportFileEntry): string {
  if (file.entityType === 'index') return renderIndex(snapshot);
  if (file.entityType === 'readme') return renderReadme(snapshot);
  if (file.entityType === 'thought') return renderThoughtFile(snapshot, file);
  if (file.entityType === 'experience') return renderExperienceFile(snapshot, file);
  if (file.entityType === 'attempt') return renderAttemptFile(snapshot, file);
  throw new TopicExportHttpError(500, { error: 'export_failed', message: '导出失败：未知文件类型。' });
}

function buildManifest(
  snapshot: Snapshot,
  generatedAt: string,
  scopeHash: string,
  filesWithHashes: ExportFileEntry[]
): string {
  const payload = {
    formatVersion: TOPIC_EXPORT_FORMAT_VERSION,
    app: '拾念 SHINIAN',
    generatedAt,
    zipRoot: `shinian-topic-${snapshot.topic.id}/`,
    topic: {
      id: snapshot.topic.id,
      title: snapshot.topic.title,
      revision: snapshot.topic.revision,
      archived: snapshot.topic.archivedAt !== null,
      archivedAt: snapshot.topic.archivedAt,
      createdAt: snapshot.topic.createdAt,
      updatedAt: snapshot.topic.updatedAt,
    },
    scopeHash,
    scope: {
      includeArchived: snapshot.options.includeArchived,
      includeBasisKeys: snapshot.options.includeBasisKeys,
      counts: snapshot.counts,
      archived: snapshot.archived,
      omittedRelations: snapshot.omitted,
      limits: snapshot.limits,
      warnings: snapshot.warnings,
    },
    files: filesWithHashes,
    entities: Object.fromEntries(
      Array.from(snapshot.fileByEntity.entries()).map(([key, file]) => [
        key,
        { path: file.path, entityType: file.entityType, title: file.title, revision: file.revision },
      ])
    ),
    relations: snapshot.relations.map((relation) => ({
      id: relation.id,
      type: relation.type,
      label: relationTypeLabel(relation.type),
      direction: relation.direction,
      from: relation.from,
      to: relation.to,
      fromFile: relation.fromFile,
      toFile: relation.toFile,
      note: relation.note ?? null,
    })),
    notes: [
      '这是拾念 SHINIAN 的一次性导出副本；之后在拾念中的修改或删除不会自动更新已下载文件。',
      'manifest.json 是只读摘要，不是导入格式。',
      '普通 Markdown 图谱不能完整表达拾念的所有关系类型与交互，不承诺界面完全一致。',
      'Obsidian 反链由标准 Markdown 相对链接自动生成；包内不额外编造反向业务关系。',
    ],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderExportFiles(snapshot: Snapshot, generatedAt: string, scopeHash: string): RenderedExport {
  const contents = new Map<string, string>();
  for (const file of snapshot.files) {
    if (file.entityType === 'manifest') continue;
    contents.set(file.path, renderEntry(snapshot, file));
  }
  const filesWithHashes: ExportFileEntry[] = snapshot.files.map((file) => {
    if (file.entityType === 'manifest') return { ...file, bytes: null, sha256: null };
    const content = contents.get(file.path) ?? '';
    const buffer = Buffer.from(content, 'utf8');
    return {
      ...file,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  });
  const manifest = buildManifest(snapshot, generatedAt, scopeHash, filesWithHashes);
  contents.set('manifest.json', manifest);
  let estimatedBytes = 0;
  for (const content of contents.values()) estimatedBytes += Buffer.byteLength(content, 'utf8');
  return { contents, filesWithHashes, estimatedBytes };
}

function buildSnapshot(topicId: string, request: TopicExportRequest, allowInvalidBasis: boolean): Snapshot {
  const built = sqlite.transaction(() => {
    const topic = readTopic(topicId);
    const allMembers = readMemberRows(topicId);
    const includedMembers = request.includeArchived
      ? allMembers
      : allMembers.filter((member) => member.capture.archivedAt === null);
    const allThoughtCaptureIds = allMembers
      .filter((member) => member.kind === 'thought')
      .map((member) => member.captureId);
    const includedThoughtCaptureIds = includedMembers
      .filter((member) => member.kind === 'thought')
      .map((member) => member.captureId);
    const allExperienceCaptureIds = allMembers
      .filter((member) => member.kind === 'experience')
      .map((member) => member.captureId);
    const includedExperienceMembers = includedMembers.filter((member) => member.kind === 'experience');

    const capturesById = readCapturesByIds(Array.from(new Set(allMembers.map((member) => member.captureId))));
    for (const member of allMembers) capturesById.set(member.captureId, member.capture);
    const notesById = readExperienceNotes(allExperienceCaptureIds);
    for (const member of allMembers) {
      if (member.note) notesById.set(member.captureId, member.note);
    }

    const allThoughtAttempts = readAttemptRowsForCaptures(allThoughtCaptureIds);
    const attemptsById = new Map<string, AttemptRow>();
    for (const attempt of allThoughtAttempts) attemptsById.set(attempt.id, attempt);
    const includedTopicAttempts = allThoughtAttempts.filter((attempt) =>
      includedThoughtCaptureIds.includes(attempt.captureId)
    );
    const initialIncludedKeys = new Set<string>();
    for (const member of includedMembers) {
      initialIncludedKeys.add(entityKeyOf(member.kind, member.captureId));
    }
    for (const attempt of includedTopicAttempts) {
      initialIncludedKeys.add(entityKeyOf('attempt', attempt.id));
    }

    const relationRows = readRelationRows(
      Array.from(new Set(allMembers.map((member) => member.captureId))),
      allThoughtAttempts.map((attempt) => attempt.id),
      allExperienceCaptureIds
    );

    const candidateByKey = buildBasisCandidates(
      includedExperienceMembers,
      relationRows.experienceSources,
      initialIncludedKeys,
      capturesById,
      attemptsById
    );
    const basisCandidates = Array.from(candidateByKey.values())
      .map((candidate) => ({
        sourceKey: candidate.sourceKey,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        title: candidate.title,
        summary: candidate.summary,
        sourceExperienceId: candidate.sourceExperienceId,
        sourceExperienceTitle: candidate.sourceExperienceTitle,
        referencedBy: [...candidate.referencedBy],
        deleted: candidate.deleted,
        selectable: candidate.selectable,
        reason: candidate.reason,
      }))
      .sort((a, b) => Number(a.deleted) - Number(b.deleted) || compareStrings(a.sourceKey, b.sourceKey));

    const invalidKeys = request.includeBasisKeys.filter((key) => {
      const candidate = candidateByKey.get(key);
      return !candidate || !candidate.selectable || candidate.deleted;
    });
    const validKeys = request.includeBasisKeys.filter((key) => !invalidKeys.includes(key));
    if (invalidKeys.length > 0 && !allowInvalidBasis) {
      throw new TopicExportHttpError(400, {
        error: 'invalid_request',
        message: '有勾选的一跳依据已不在当前预览范围或已删除，请重新预览。',
        field: 'includeBasisKeys',
        invalidKeys,
      });
    }
    const options: TopicExportOptions = {
      includeArchived: request.includeArchived,
      includeBasisKeys: validKeys,
    };

    const basisEntities: BasisEntity[] = [];
    for (const key of validKeys) {
      const candidate = candidateByKey.get(key)!;
      basisEntities.push({
        sourceKey: key,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        title: candidate.title,
        basis: true,
        capture: candidate.capture,
        attempt: candidate.attempt,
        parentCapture: candidate.parentCapture,
      });
      if (candidate.attempt) attemptsById.set(candidate.attempt.id, candidate.attempt);
      if (candidate.capture) {
        capturesById.set(candidate.capture.id, candidate.capture);
        if (candidate.capture.kind === 'experience') {
          const note = readExperienceNotes([candidate.capture.id]).get(candidate.capture.id);
          if (note) notesById.set(note.captureId, note);
        }
      }
      if (candidate.parentCapture) capturesById.set(candidate.parentCapture.id, candidate.parentCapture);
    }

    const includedCaptureKeys = new Set<string>();
    const includedAttemptKeys = new Set<string>();
    const files: ExportFileEntry[] = [];
    const fileByEntity = new Map<string, ExportFileEntry>();
    const attemptsByCapture = new Map<string, ExportFileEntry[]>();

    const addMetaFile = (entry: ExportFileEntry) => {
      files.push(entry);
      assertSafeZipPath(entry.path);
    };
    addMetaFile({
      path: '主题索引.md',
      entityType: 'index',
      entityId: null,
      title: topic.title,
      archived: topic.archivedAt !== null,
      basis: false,
      revision: topic.revision,
    });
    addMetaFile({
      path: 'README.md',
      entityType: 'readme',
      entityId: null,
      title: 'README',
      archived: topic.archivedAt !== null,
      basis: false,
      revision: null,
    });
    addMetaFile({
      path: 'manifest.json',
      entityType: 'manifest',
      entityId: null,
      title: 'manifest.json',
      archived: false,
      basis: false,
      revision: null,
    });

    const addEntity = (type: EntityType, id: string, title: string, archived: boolean, basis: boolean, revision: number) => {
      const entry: ExportFileEntry = {
        path: filePathOf(type, id),
        entityType: type,
        entityId: id,
        title,
        archived,
        basis,
        revision,
      };
      assertSafeZipPath(entry.path);
      files.push(entry);
      fileByEntity.set(entityKeyOf(type, id), entry);
      if (type === 'thought' || type === 'experience') includedCaptureKeys.add(entityKeyOf(type, id));
      if (type === 'attempt') includedAttemptKeys.add(entityKeyOf(type, id));
      return entry;
    };

    const topicThoughts = includedMembers.filter((member) => member.kind === 'thought');
    const topicExperiences = includedMembers.filter((member) => member.kind === 'experience');
    for (const member of topicThoughts) {
      addEntity(
        'thought',
        member.captureId,
        titleOfCapture(member.capture, member.note),
        member.capture.archivedAt !== null,
        false,
        member.capture.revision
      );
    }
    for (const member of topicExperiences) {
      addEntity(
        'experience',
        member.captureId,
        titleOfCapture(member.capture, member.note),
        member.capture.archivedAt !== null,
        false,
        member.capture.revision
      );
    }
    const memberOrder = new Map<string, number>();
    includedMembers.forEach((member, index) => memberOrder.set(member.captureId, index));
    const sortedTopicAttempts = [...includedTopicAttempts].sort(
      (a, b) =>
        (memberOrder.get(a.captureId) ?? 0) - (memberOrder.get(b.captureId) ?? 0) ||
        a.createdAt - b.createdAt ||
        compareStrings(a.id, b.id)
    );
    for (const attempt of sortedTopicAttempts) {
      const entry = addEntity(
        'attempt',
        attempt.id,
        firstLine(attempt.step, 120) || '（无标题尝试）',
        capturesById.get(attempt.captureId)?.archivedAt !== null &&
          capturesById.get(attempt.captureId)?.archivedAt !== undefined,
        false,
        attempt.revision
      );
      const list = attemptsByCapture.get(attempt.captureId) ?? [];
      list.push(entry);
      attemptsByCapture.set(attempt.captureId, list);
    }
    const basisThoughts = basisEntities
      .filter((basis) => basis.entityType === 'thought')
      .sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
    const basisExperiences = basisEntities
      .filter((basis) => basis.entityType === 'experience')
      .sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
    const basisAttempts = basisEntities
      .filter((basis) => basis.entityType === 'attempt')
      .sort((a, b) => compareStrings(a.sourceKey, b.sourceKey));
    for (const basis of basisThoughts) {
      const capture = basis.capture!;
      addEntity('thought', capture.id, basis.title, capture.archivedAt !== null, true, capture.revision);
    }
    for (const basis of basisExperiences) {
      const capture = basis.capture!;
      addEntity('experience', capture.id, basis.title, capture.archivedAt !== null, true, capture.revision);
    }
    for (const basis of basisAttempts) {
      const attempt = basis.attempt!;
      const parent = basis.parentCapture ?? capturesById.get(attempt.captureId);
      const entry = addEntity(
        'attempt',
        attempt.id,
        basis.title,
        parent?.archivedAt !== null && parent?.archivedAt !== undefined,
        true,
        attempt.revision
      );
      const list = attemptsByCapture.get(attempt.captureId) ?? [];
      if (list.some((item) => item.path === entry.path) === false) list.push(entry);
      attemptsByCapture.set(attempt.captureId, list);
    }

    // 关系：重建读取，加入 basis 实体，避免只看到主题内端点。
    const allCaptureIdsForLinks = Array.from(
      new Set([
        ...allMembers.map((member) => member.captureId),
        ...basisThoughts.map((basis) => basis.entityId),
        ...basisExperiences.map((basis) => basis.entityId),
      ])
    );
    const allAttemptIdsForRefs = Array.from(
      new Set([...allThoughtAttempts.map((attempt) => attempt.id), ...basisAttempts.map((basis) => basis.entityId)])
    );
    const allRelations = readRelationRows(
      allCaptureIdsForLinks,
      allAttemptIdsForRefs,
      Array.from(new Set([...allExperienceCaptureIds, ...basisExperiences.map((basis) => basis.entityId)]))
    );

    const relations: ExportRelation[] = [];
    const omitted: OmittedRelations = {
      total: 0,
      byType: { manualLink: 0, attemptReference: 0, experienceSource: 0, experienceAdoption: 0 },
    };
    const manualLinksOut = new Map<string, ExportRelation[]>();
    const manualLinksIn = new Map<string, ExportRelation[]>();
    const refsOut = new Map<string, ExportRelation[]>();
    const refsIn = new Map<string, ExportRelation[]>();
    const expSourcesOut = new Map<string, ExportRelation[]>();
    const adoptionsByAttempt = new Map<string, ExportRelation[]>();
    const adoptionsByExperience = new Map<string, ExportRelation[]>();
    const omittedManualOut = new Set<string>();
    const omittedManualIn = new Set<string>();
    const omittedRefsOut = new Set<string>();
    const omittedRefsIn = new Set<string>();
    const omittedExpSources = new Set<string>();
    const omittedAdoptionsByExperience = new Set<string>();
    const omittedAdoptionsByAttempt = new Set<string>();

    for (const member of includedMembers) {
      const key = entityKeyOf(member.kind, member.captureId);
      const file = fileByEntity.get(key);
      if (!file) continue;
      relations.push({
        id: `topic_member:${member.id}`,
        type: 'topic_member',
        direction: '主题收录',
        from: `topic:${topic.id}`,
        to: key,
        fromFile: '主题索引.md',
        toFile: file.path,
      });
    }
    for (const attempt of sortedTopicAttempts) {
      const parentKey = captureEntityKey(attempt.captureId, capturesById.get(attempt.captureId)?.kind ?? 'thought');
      const parentFile = fileByEntity.get(parentKey);
      const attemptFile = fileByEntity.get(entityKeyOf('attempt', attempt.id));
      if (parentFile && attemptFile) {
        relations.push({
          id: `contains:${attempt.id}`,
          type: 'contains_attempt',
          direction: '包含',
          from: parentKey,
          to: entityKeyOf('attempt', attempt.id),
          fromFile: parentFile.path,
          toFile: attemptFile.path,
        });
      }
    }

    for (const link of allRelations.captureLinks) {
      const fromKey = captureEntityKey(link.fromCaptureId, capturesById.get(link.fromCaptureId)?.kind ?? 'thought');
      const toKey = captureEntityKey(link.toCaptureId, capturesById.get(link.toCaptureId)?.kind ?? 'thought');
      const fromIncluded = includedCaptureKeys.has(fromKey);
      const toIncluded = includedCaptureKeys.has(toKey);
      if (fromIncluded && toIncluded) {
        const relation: ExportRelation = {
          id: `manual_link:${link.id}`,
          type: 'manual_link',
          direction: '关联到',
          from: fromKey,
          to: toKey,
          fromFile: fileByEntity.get(fromKey)?.path ?? null,
          toFile: fileByEntity.get(toKey)?.path ?? null,
          note: link.note,
        };
        relations.push(relation);
        manualLinksOut.set(fromKey, [...(manualLinksOut.get(fromKey) ?? []), relation]);
        manualLinksIn.set(toKey, [...(manualLinksIn.get(toKey) ?? []), relation]);
      } else if (fromIncluded || toIncluded) {
        omitted.byType.manualLink += 1;
        if (fromIncluded) omittedManualOut.add(link.fromCaptureId);
        if (toIncluded) omittedManualIn.add(link.toCaptureId);
      }
    }
    for (const ref of allRelations.attemptReferences) {
      const fromKey = entityKeyOf('attempt', ref.fromAttemptId);
      const toKey = entityKeyOf('attempt', ref.toAttemptId);
      const fromIncluded = includedAttemptKeys.has(fromKey);
      const toIncluded = includedAttemptKeys.has(toKey);
      if (fromIncluded && toIncluded) {
        const relation: ExportRelation = {
          id: `attempt_reference:${ref.id}`,
          type: 'attempt_reference',
          direction: '引用了旧结果',
          from: fromKey,
          to: toKey,
          fromFile: fileByEntity.get(fromKey)?.path ?? null,
          toFile: fileByEntity.get(toKey)?.path ?? null,
          note: ref.note,
          snapshotResultText: ref.snapshotResultText,
          snapshotRevision: ref.snapshotRevision,
        };
        relations.push(relation);
        refsOut.set(fromKey, [...(refsOut.get(fromKey) ?? []), relation]);
        refsIn.set(toKey, [...(refsIn.get(toKey) ?? []), relation]);
      } else if (fromIncluded || toIncluded) {
        omitted.byType.attemptReference += 1;
        if (fromIncluded) omittedRefsOut.add(ref.fromAttemptId);
        if (toIncluded) omittedRefsIn.add(ref.toAttemptId);
      }
    }
    for (const source of allRelations.experienceSources) {
      const expKey = entityKeyOf('experience', source.experienceId);
      if (!includedCaptureKeys.has(expKey)) continue;
      const sourceKey = sourceEntityKey(source);
      const sourceIncluded = includedCaptureKeys.has(sourceKey) || includedAttemptKeys.has(sourceKey);
      if (!source.deleted && sourceIncluded) {
        const relation: ExportRelation = {
          id: `experience_source:${source.id}`,
          type: 'experience_source',
          direction: '依据',
          from: expKey,
          to: sourceKey,
          fromFile: fileByEntity.get(expKey)?.path ?? null,
          toFile: fileByEntity.get(sourceKey)?.path ?? null,
          sourceRevision: source.sourceRevision,
        };
        relations.push(relation);
        expSourcesOut.set(expKey, [...(expSourcesOut.get(expKey) ?? []), relation]);
      } else {
        omitted.byType.experienceSource += 1;
        omittedExpSources.add(source.experienceId);
      }
    }
    for (const adoption of allRelations.experienceAttempts) {
      const attemptKey = entityKeyOf('attempt', adoption.attemptId);
      const expKey = entityKeyOf('experience', adoption.experienceCaptureId);
      const attemptIncluded = includedAttemptKeys.has(attemptKey);
      const expIncluded = includedCaptureKeys.has(expKey);
      if (!adoption.deleted && attemptIncluded && expIncluded) {
        const relation: ExportRelation = {
          id: `experience_adoption:${adoption.attemptId}:${adoption.experienceCaptureId}`,
          type: 'experience_adoption',
          direction: '采用经验',
          from: attemptKey,
          to: expKey,
          fromFile: fileByEntity.get(attemptKey)?.path ?? null,
          toFile: fileByEntity.get(expKey)?.path ?? null,
          adoptedVersion: adoption.adoptedVersion,
          adoptedTitle: adoption.adoptedTitle,
          adoptedUnderstanding: adoption.adoptedUnderstanding,
        };
        relations.push(relation);
        adoptionsByAttempt.set(attemptKey, [...(adoptionsByAttempt.get(attemptKey) ?? []), relation]);
        adoptionsByExperience.set(expKey, [...(adoptionsByExperience.get(expKey) ?? []), relation]);
      } else if (attemptIncluded || expIncluded) {
        omitted.byType.experienceAdoption += 1;
        if (attemptIncluded) omittedAdoptionsByAttempt.add(adoption.attemptId);
        if (expIncluded) omittedAdoptionsByExperience.add(adoption.experienceCaptureId);
      }
    }
    omitted.total =
      omitted.byType.manualLink +
      omitted.byType.attemptReference +
      omitted.byType.experienceSource +
      omitted.byType.experienceAdoption;

    const counts: ExportCounts = {
      thoughts: topicThoughts.length,
      experiences: topicExperiences.length,
      attempts: sortedTopicAttempts.length + basisAttempts.length,
      basisThoughts: basisThoughts.length,
      basisExperiences: basisExperiences.length,
      basisAttempts: basisAttempts.length,
      files: files.length,
      manualLinks: relations.filter((relation) => relation.type === 'manual_link').length,
      attemptReferences: relations.filter((relation) => relation.type === 'attempt_reference').length,
      experienceSources: relations.filter((relation) => relation.type === 'experience_source').length,
      experienceAdoptions: relations.filter((relation) => relation.type === 'experience_adoption').length,
    };
    const archived = {
      members: allMembers.filter((member) => member.capture.archivedAt !== null).length,
      thoughts: allMembers.filter(
        (member) => member.kind === 'thought' && member.capture.archivedAt !== null
      ).length,
      experiences: allMembers.filter(
        (member) => member.kind === 'experience' && member.capture.archivedAt !== null
      ).length,
    };
    let nextAttempt: AttemptRow | null = null;
    if (topic.nextAttemptId) {
      const candidate = attemptsById.get(topic.nextAttemptId);
      if (
        candidate &&
        includedAttemptKeys.has(entityKeyOf('attempt', candidate.id)) &&
        candidate.state !== 'done' &&
        candidate.state !== 'cancelled'
      ) {
        nextAttempt = candidate;
      }
    }
    return {
      topic,
      options,
      invalidKeys,
      allMembers,
      includedMembers,
      allThoughtAttempts,
      includedTopicAttempts,
      basisEntities,
      basisCandidates,
      candidateByKey,
      capturesById,
      notesById,
      attemptsById,
      includedCaptureKeys,
      includedAttemptKeys,
      captureLinks: allRelations.captureLinks,
      attemptReferences: allRelations.attemptReferences,
      experienceSources: allRelations.experienceSources,
      experienceAttempts: allRelations.experienceAttempts,
      relations,
      omitted,
      counts,
      archived,
      files,
      fileByEntity,
      attemptsByCapture,
      manualLinksOut,
      manualLinksIn,
      refsOut,
      refsIn,
      expSourcesOut,
      adoptionsByAttempt,
      adoptionsByExperience,
      omittedManualOut,
      omittedManualIn,
      omittedRefsOut,
      omittedRefsIn,
      omittedExpSources,
      omittedAdoptionsByExperience,
      omittedAdoptionsByAttempt,
      nextAttempt,
      warnings: [] as string[],
      limits: {
        maxFiles: TOPIC_EXPORT_MAX_FILES,
        maxAttempts: TOPIC_EXPORT_MAX_ATTEMPTS,
        maxBytes: TOPIC_EXPORT_MAX_BYTES,
        maxBasisKeys: TOPIC_EXPORT_MAX_BASIS_KEYS,
        exceeded: [] as string[],
      },
      estimatedBytes: 0,
      scopeHash: '',
    } satisfies Snapshot;
  })();

  const previewRender = renderExportFiles(built, '1970-01-01T00:00:00.000Z', '');
  built.estimatedBytes = previewRender.estimatedBytes;
  const warnings: string[] = [];
  if (built.files.length > built.limits.maxFiles) {
    built.limits.exceeded.push('files');
    warnings.push(`文件数 ${built.files.length} 超过上限 ${built.limits.maxFiles}，请缩小主题或取消部分归档/依据。`);
  }
  if (built.counts.attempts > built.limits.maxAttempts) {
    built.limits.exceeded.push('attempts');
    warnings.push(`尝试数 ${built.counts.attempts} 超过上限 ${built.limits.maxAttempts}，请缩小主题。`);
  }
  if (built.estimatedBytes > built.limits.maxBytes) {
    built.limits.exceeded.push('bytes');
    warnings.push(`预计内容大小 ${built.estimatedBytes} 字节超过上限 ${built.limits.maxBytes} 字节。`);
  }
  if (built.basisCandidates.some((candidate) => candidate.deleted)) {
    warnings.push('有经验依据来源已删除；导出包内只保留「来源已删除」占位。');
  }
  if (built.topic.nextAttemptId && !built.nextAttempt) {
    warnings.push('固定的下一步已失效或未包含，索引中不生成链接。');
  }
  if (built.archived.members > 0 && !built.options.includeArchived) {
    warnings.push(`已排除 ${built.archived.members} 个归档主题成员；相关关系计入未包含关联。`);
  }
  if (built.estimatedBytes > built.limits.maxBytes * 0.8 && built.estimatedBytes <= built.limits.maxBytes) {
    warnings.push('预计大小接近上限。');
  }
  built.warnings = warnings.sort(compareStrings);
  built.scopeHash = hashScope(built);
  return built;
}

function publicFiles(files: ExportFileEntry[]): ExportFileEntry[] {
  return files.map((file) => ({
    path: file.path,
    entityType: file.entityType,
    entityId: file.entityId,
    title: file.title,
    archived: file.archived,
    basis: file.basis,
    revision: file.revision,
  }));
}

export function previewTopicExport(topicId: string, raw: unknown): Record<string, unknown> {
  const request = parseOptions(raw, false);
  const snapshot = buildSnapshot(topicId, request, false);
  return {
    topic: {
      id: snapshot.topic.id,
      title: snapshot.topic.title,
      revision: snapshot.topic.revision,
      archived: snapshot.topic.archivedAt !== null,
      archivedAt: snapshot.topic.archivedAt,
      createdAt: snapshot.topic.createdAt,
      updatedAt: snapshot.topic.updatedAt,
    },
    scope: {
      includeArchived: snapshot.options.includeArchived,
      includeBasisKeys: snapshot.options.includeBasisKeys,
      counts: snapshot.counts,
      archived: snapshot.archived,
      files: publicFiles(snapshot.files),
      basisCandidates: snapshot.basisCandidates,
      omittedRelations: snapshot.omitted,
      estimatedBytes: snapshot.estimatedBytes,
      limits: snapshot.limits,
      warnings: snapshot.warnings,
    },
    scopeHash: snapshot.scopeHash,
    canExport: snapshot.limits.exceeded.length === 0,
  };
}

function localStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function generateTopicExport(topicId: string, raw: unknown): {
  zip: Buffer;
  filename: string;
  manifest: string;
  estimatedBytes: number;
} {
  const request = parseOptions(raw, true);
  const snapshot = buildSnapshot(topicId, request, true);
  if (snapshot.invalidKeys.length > 0) {
    throw new TopicExportHttpError(409, {
      error: 'export_scope_changed',
      message: '导出范围已变化，请重新预览后再试。',
      currentScopeHash: snapshot.scopeHash,
      invalidKeys: snapshot.invalidKeys,
    });
  }
  if (request.expectedScopeHash !== snapshot.scopeHash) {
    throw new TopicExportHttpError(409, {
      error: 'export_scope_changed',
      message: '导出范围已变化，请重新预览后再试。',
      currentScopeHash: snapshot.scopeHash,
    });
  }
  if (snapshot.limits.exceeded.length > 0) {
    throw new TopicExportHttpError(413, {
      error: 'export_limit_exceeded',
      message: '导出内容超过上限，请缩小范围后重试。',
      details: {
        limits: snapshot.limits,
        actual: {
          files: snapshot.files.length,
          attempts: snapshot.counts.attempts,
          basisKeys: snapshot.options.includeBasisKeys.length,
          bytes: snapshot.estimatedBytes,
        },
        exceeded: snapshot.limits.exceeded,
      },
    });
  }
  const rendered = renderExportFiles(snapshot, new Date().toISOString(), snapshot.scopeHash);
  const zipRoot = `shinian-topic-${safeFileId(snapshot.topic.id)}/`;
  const zipFiles = snapshot.files.map((file) => {
    const entryPath = `${zipRoot}${file.path}`;
    assertSafeZipPath(entryPath);
    return { path: entryPath, data: rendered.contents.get(file.path) ?? '' };
  });
  const zip = createZip(zipFiles);
  if (zip.length > TOPIC_EXPORT_MAX_BYTES) {
    throw new TopicExportHttpError(413, {
      error: 'export_limit_exceeded',
      message: '导出内容超过上限，请缩小范围后重试。',
      details: {
        limits: snapshot.limits,
        actual: {
          files: snapshot.files.length,
          attempts: snapshot.counts.attempts,
          basisKeys: snapshot.options.includeBasisKeys.length,
          bytes: zip.length,
        },
        exceeded: ['bytes'],
      },
    });
  }
  const filename = `shinian-topic-${safeFileId(snapshot.topic.id)}-${localStamp()}.zip`;
  return {
    zip,
    filename,
    manifest: rendered.contents.get('manifest.json') ?? '',
    estimatedBytes: rendered.estimatedBytes,
  };
}
