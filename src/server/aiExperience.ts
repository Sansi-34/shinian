import crypto from 'node:crypto';
import { sqlite } from '../db/db';
import type { AiGeneration } from '../db/schema';

export type ExperienceCandidate = {
  id: string;
  captureId: string;
  captureText: string;
  captureArchived: boolean;
  captureRevision: number;
  step: string;
  resultText: string;
  outcome: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  matchReasons: string[];
};

export type ExperienceCandidatesResponse = {
  captureId: string;
  query: string;
  suggestedQuery: string;
  limit: number;
  total: number;
  candidates: ExperienceCandidate[];
};

export type ExperienceSource = {
  attemptId: string;
  captureId: string;
  captureText: string;
  captureRevision: number;
  attemptRevision: number;
  step: string;
  resultText: string;
  outcome: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  captureArchived: boolean;
};

export type ExperienceContextSource = {
  attemptId: string;
  attemptRevision: number;
  captureId: string;
  captureRevision: number;
  step: string;
  resultText: string;
  outcome: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  captureText: string;
  captureArchived: boolean;
  deleted?: boolean;
};

export type ExperienceContext = {
  capture: { id: string; revision: number; text: string };
  constraint: string | null;
  config: { id: string; version: number; name: string; modelId: string };
  sources: ExperienceContextSource[];
};

export type GenerationSource = {
  attemptId: string;
  note: string | null;
  attemptRevision: number | null;
  captureId: string | null;
  step: string | null;
  resultText: string | null;
  outcome: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  captureText: string | null;
  currentExists: boolean;
  currentRevision: number | null;
  changed: boolean;
  deleted: boolean;
};

export type GenerationExperiencePublic = {
  sources: GenerationSource[];
  sourcesChanged: boolean;
  contextInvalidated: boolean;
  contextInvalidReason: string | null;
};

type RawSourceRow = {
  attemptId: string;
  captureId: string;
  captureText: string;
  captureRevision: number;
  attemptRevision: number;
  step: string;
  resultText: string;
  outcome: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  archivedAt: number | null;
};

type RawCandidateRow = RawSourceRow & {
  revision: number;
  createdAt: number;
  updatedAt: number;
};

const STOP_WORDS = new Set([
  '请',
  '帮我',
  '我想',
  '我要',
  '想',
  '要',
  '把',
  '在',
  '给',
  '做',
  '试',
  '看看',
  '如何',
  '怎么',
  '一个',
  '一下',
  '可以',
  '需要',
  '时候',
  '东西',
  '事情',
  '这个',
  '那个',
  '这',
  '那',
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '或',
  '有',
  '吗',
  '呢',
  '吧',
  '我',
  '你',
  '他',
  '她',
  '它',
  '们',
]);

const SUFFIXES = [
  '怎么办',
  '怎么样',
  '怎么',
  '如何',
  '可以',
  '一下',
  '的话',
  '时候',
  '吗',
  '呢',
  '吧',
  '了',
  '的',
  '着',
  '过',
  '时',
];

/** 提取一个简短、可用于 LIKE 的服务端建议查询词。 */
export function suggestQueryForCapture(rawText: string): string {
  const text = rawText.trim();
  if (!text) return '';
  const chunks = text
    .split(/[\s，。！？、；：,.!?;:()[\]{}"“”'‘’/\\|+=~`@#$%^&*<>_-]+/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const terms: string[] = [];
  const add = (term: string) => {
    const value = term.trim();
    if (value.length < 2 || STOP_WORDS.has(value.toLowerCase())) return;
    if (!terms.includes(value)) terms.push(value);
  };

  for (const chunk of chunks) {
    let token = chunk;
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(token)) {
      add(token.toLowerCase());
      if (terms.length >= 6) break;
      continue;
    }
    token = token.replace(/^(请|帮我|我想|我要|想|要|把|在|给|做|试|看看|如何|怎么)/u, '');
    let stripped = true;
    while (stripped && token.length > 1) {
      stripped = false;
      for (const suffix of SUFFIXES) {
        if (token.length > suffix.length && token.endsWith(suffix)) {
          token = token.slice(0, -suffix.length);
          stripped = true;
        }
      }
    }
    add(token);
    if (terms.length >= 6) break;
  }
  return terms.slice(0, 6).join(' ') || text.slice(0, 40);
}

function countKeywordHits(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= haystack.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      hits += 1;
      from = index + needle.length;
    }
  }
  return hits;
}

function timestampOf(row: RawCandidateRow): number {
  return row.observedAt ?? row.updatedAt ?? row.createdAt;
}

function referencePartnersForCapture(captureId: string): Set<string> {
  const current = sqlite
    .prepare('SELECT id FROM attempts WHERE capture_id = ?')
    .all(captureId) as Array<{ id: string }>;
  if (current.length === 0) return new Set();
  const currentIds = new Set(current.map((row) => row.id));
  const placeholders = current.map(() => '?').join(',');
  const references = sqlite
    .prepare(
      `SELECT from_attempt_id AS fromId, to_attempt_id AS toId
         FROM attempt_references
        WHERE from_attempt_id IN (${placeholders}) OR to_attempt_id IN (${placeholders})`
    )
    .all(...current.map((row) => row.id), ...current.map((row) => row.id)) as Array<{
    fromId: string;
    toId: string;
  }>;
  const partners = new Set<string>();
  for (const reference of references) {
    if (currentIds.has(reference.fromId)) partners.add(reference.toId);
    if (currentIds.has(reference.toId)) partners.add(reference.fromId);
  }
  return partners;
}

export function getExperienceCandidates(
  captureId: string,
  rawQuery: string | undefined,
  rawLimit: string | number | undefined
): ExperienceCandidatesResponse | null {
  const cap = sqlite
    .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
    .get(captureId) as { id: string; rawText: string; revision: number } | undefined;
  if (!cap) return null;

  const suggestedQuery = suggestQueryForCapture(cap.rawText);
  const query = (rawQuery ?? '').trim() || suggestedQuery;
  const parsedLimit =
    typeof rawLimit === 'number' ? rawLimit : Number.parseInt(String(rawLimit ?? ''), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(30, parsedLimit)) : 12;

  const rows = sqlite
    .prepare(
      `SELECT a.id AS attemptId, a.capture_id AS captureId,
              a.step AS step, a.result_text AS resultText, a.outcome AS outcome,
              a.observed_at AS observedAt, a.source_url AS sourceUrl,
              a.revision AS revision, a.created_at AS createdAt, a.updated_at AS updatedAt,
              c.raw_text AS captureText, c.revision AS captureRevision, c.archived_at AS archivedAt
         FROM attempts a
         JOIN captures c ON c.id = a.capture_id
        WHERE a.result_text IS NOT NULL AND trim(a.result_text) <> ''`
    )
    .all() as RawCandidateRow[];

  const keywords = query.split(/\s+/u).map((word) => word.trim()).filter(Boolean);
  const partners = referencePartnersForCapture(captureId);
  const matched: Array<{
    row: RawCandidateRow;
    score: number;
    matchReasons: string[];
    timestamp: number;
  }> = [];

  for (const row of rows) {
    const resultHits = countKeywordHits(row.resultText, keywords);
    const titleHits = countKeywordHits(row.step, keywords);
    const captureHits = countKeywordHits(row.captureText, keywords);
    const hasReference = partners.has(row.attemptId);
    const matchReasons: string[] = [];
    if (resultHits > 0) matchReasons.push('结果命中');
    if (titleHits > 0) matchReasons.push('标题命中');
    if (captureHits > 0) matchReasons.push('所属念头命中');
    if (hasReference) matchReasons.push('引用关系');
    const score = resultHits * 100 + titleHits * 20 + captureHits * 5 + (hasReference ? 40 : 0);
    if (keywords.length > 0 && score === 0) continue;
    matched.push({ row, score, matchReasons, timestamp: timestampOf(row) });
  }

  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.row.attemptId.localeCompare(b.row.attemptId);
  });

  return {
    captureId,
    query,
    suggestedQuery,
    limit,
    total: matched.length,
    candidates: matched.slice(0, limit).map(({ row, matchReasons }) => ({
      id: row.attemptId,
      captureId: row.captureId,
      captureText: row.captureText,
      captureArchived: row.archivedAt !== null,
      captureRevision: row.captureRevision,
      step: row.step,
      resultText: row.resultText,
      outcome: row.outcome,
      observedAt: row.observedAt,
      sourceUrl: row.sourceUrl,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      matchReasons,
    })),
  };
}

/** 从数据库读取来源真实内容；客户端只提供 ID。 */
export function readExperienceSources(attemptIds: string[]): {
  sources: ExperienceSource[];
  unavailableIds: string[];
} {
  const sources: ExperienceSource[] = [];
  const unavailableIds: string[] = [];
  for (const attemptId of attemptIds) {
    const row = sqlite
      .prepare(
        `SELECT a.id AS attemptId, a.capture_id AS captureId,
                a.step AS step, a.result_text AS resultText, a.outcome AS outcome,
                a.observed_at AS observedAt, a.source_url AS sourceUrl,
                a.revision AS attemptRevision,
                c.raw_text AS captureText, c.revision AS captureRevision, c.archived_at AS archivedAt
           FROM attempts a
           JOIN captures c ON c.id = a.capture_id
          WHERE a.id = ?`
      )
      .get(attemptId) as RawSourceRow | undefined;
    if (!row || !row.resultText || !row.resultText.trim()) {
      unavailableIds.push(attemptId);
      continue;
    }
    sources.push({
      attemptId: row.attemptId,
      captureId: row.captureId,
      captureText: row.captureText,
      captureRevision: row.captureRevision,
      attemptRevision: row.attemptRevision,
      step: row.step,
      resultText: row.resultText,
      outcome: row.outcome,
      observedAt: row.observedAt,
      sourceUrl: row.sourceUrl,
      captureArchived: row.archivedAt !== null,
    });
  }
  return { sources, unavailableIds };
}

export function computeContextToken(input: {
  captureId: string;
  captureRevision: number;
  constraint: string | null;
  configVersion: number;
  sources: Array<{ attemptId: string; attemptRevision: number }>;
}): string {
  const sources = [...input.sources]
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
    .map((source) => ({
      attemptId: source.attemptId,
      attemptRevision: source.attemptRevision,
    }));
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        captureId: input.captureId,
        captureRevision: input.captureRevision,
        constraint: input.constraint,
        configVersion: input.configVersion,
        sources,
      }),
      'utf8'
    )
    .digest('hex');
}

export function buildContextSnapshot(input: {
  capture: { id: string; revision: number; text: string };
  constraint: string | null;
  config: { id: string; version: number; name: string; modelId: string };
  sources: ExperienceSource[];
}): ExperienceContext {
  return {
    capture: {
      id: input.capture.id,
      revision: input.capture.revision,
      text: input.capture.text,
    },
    constraint: input.constraint,
    config: {
      id: input.config.id,
      version: input.config.version,
      name: input.config.name,
      modelId: input.config.modelId,
    },
    sources: input.sources.map((source) => ({
      attemptId: source.attemptId,
      attemptRevision: source.attemptRevision,
      captureId: source.captureId,
      captureRevision: source.captureRevision,
      step: source.step,
      resultText: source.resultText,
      outcome: source.outcome,
      observedAt: source.observedAt,
      sourceUrl: source.sourceUrl,
      captureText: source.captureText,
      captureArchived: source.captureArchived,
    })),
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function currentAttempt(attemptId: string):
  | { revision: number; captureRevision: number }
  | undefined {
  const row = sqlite
    .prepare(
      `SELECT a.revision AS revision, c.revision AS captureRevision
         FROM attempts a JOIN captures c ON c.id = a.capture_id
        WHERE a.id = ?`
    )
    .get(attemptId) as { revision: number; captureRevision: number } | undefined;
  return row;
}

/**
 * 生成结果公开来源：以 context_json 快照为主，合并 suggestion_json.sources 的
 * note；来源被删除时只保留 ID/deleted，绝不回显正文。
 */
export function publicExperienceOf(row: AiGeneration): GenerationExperiencePublic {
  const context = parseJson<ExperienceContext>(row.contextJson);
  if (!context || !Array.isArray(context.sources)) {
    return {
      sources: [],
      sourcesChanged: false,
      contextInvalidated: false,
      contextInvalidReason: null,
    };
  }
  const suggestion = parseJson<{
    sources?: Array<{ attemptId?: unknown; note?: unknown }>;
  }>(row.suggestionJson);
  const noteById = new Map<string, string>();
  if (suggestion && Array.isArray(suggestion.sources)) {
    for (const item of suggestion.sources) {
      if (typeof item?.attemptId === 'string' && typeof item.note === 'string') {
        noteById.set(item.attemptId, item.note);
      }
    }
  }

  const sources: GenerationSource[] = context.sources.map((source) => {
    const note = noteById.get(source.attemptId) ?? null;
    const isMarkedDeleted = source.deleted === true;
    const current = isMarkedDeleted ? undefined : currentAttempt(source.attemptId);
    if (isMarkedDeleted || !current) {
      return {
        attemptId: source.attemptId,
        note,
        attemptRevision: source.attemptRevision ?? null,
        captureId: source.captureId ?? null,
        step: null,
        resultText: null,
        outcome: null,
        observedAt: null,
        sourceUrl: null,
        captureText: null,
        currentExists: false,
        currentRevision: null,
        changed: true,
        deleted: true,
      };
    }
    return {
      attemptId: source.attemptId,
      note,
      attemptRevision: source.attemptRevision ?? null,
      captureId: source.captureId ?? null,
      step: source.step ?? null,
      resultText: source.resultText ?? null,
      outcome: source.outcome ?? null,
      observedAt: source.observedAt ?? null,
      sourceUrl: source.sourceUrl ?? null,
      captureText: source.captureText ?? null,
      currentExists: true,
      currentRevision: current.revision,
      changed:
        current.revision !== source.attemptRevision ||
        current.captureRevision !== source.captureRevision,
      deleted: false,
    };
  });

  return {
    sources,
    sourcesChanged: sources.some((source) => source.changed),
    contextInvalidated:
      row.contextInvalidatedAt !== null || sources.some((source) => source.deleted),
    contextInvalidReason: row.contextInvalidReason ?? null,
  };
}

/**
 * 来源 Attempt 删除前调用：清洗所有引用它的 ai_generations.context_json，
 * 只保留 {attemptId, deleted:true}，不留下可读正文。
 */
export function invalidateGenerationContextsForDeletedAttempts(attemptIds: string[]): number {
  const targets = new Set(attemptIds.filter(Boolean));
  if (targets.size === 0) return 0;
  const rows = sqlite
    .prepare('SELECT id, context_json AS contextJson, suggestion_json AS suggestionJson FROM ai_generations')
    .all() as Array<{ id: string; contextJson: string | null; suggestionJson: string | null }>;
  const update = sqlite.prepare(
    `UPDATE ai_generations
        SET context_json = ?, suggestion_json = ?, context_invalidated_at = ?,
            context_invalid_reason = ?, updated_at = ?
      WHERE id = ?`
  );
  const now = Date.now();
  let changed = 0;
  for (const row of rows) {
    const context = parseJson<ExperienceContext>(row.contextJson);
    if (!context || !Array.isArray(context.sources)) continue;
    let touched = false;
    context.sources = context.sources.map((source) => {
      if (source && targets.has(source.attemptId)) {
        touched = true;
        return { attemptId: source.attemptId, deleted: true } as ExperienceContextSource;
      }
      return source;
    });
    if (!touched) continue;

    // 生成正文无法可靠拆分到具体来源，撤下整段建议，只保留失效原因。
    update.run(
      JSON.stringify(context),
      null,
      now,
      '来源记录已删除，AI 建议正文已撤下',
      now,
      row.id
    );
    changed += 1;
  }
  return changed;
}

/** 预览/生成前的来源 token 重算；与 computeContextToken 共用同一序列化。 */
export function contextTokenForSources(input: {
  captureId: string;
  captureRevision: number;
  constraint: string | null;
  configVersion: number;
  sources: ExperienceSource[];
}): string {
  return computeContextToken({
    captureId: input.captureId,
    captureRevision: input.captureRevision,
    constraint: input.constraint,
    configVersion: input.configVersion,
    sources: input.sources.map((source) => ({
      attemptId: source.attemptId,
      attemptRevision: source.attemptRevision,
    })),
  });
}
