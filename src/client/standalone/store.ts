// 浏览器本地存储版：把原本落在 SQLite 的记录改存到访问者自己的 localStorage。
// 只在该站点以 standalone 模式构建时启用，桌面/本地服务模式完全不受影响。

export type CaptureKind = 'thought' | 'experience';
export type AttemptState = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type AttemptOutcome = 'success' | 'failure' | 'undetermined';
export type AttemptOrigin =
  | 'manual'
  | 'ai_suggestion'
  | 'review_next_action'
  | 'research_experiment'
  | 'experience_retry';

export type CaptureRow = {
  id: string;
  rawText: string;
  kind: CaptureKind;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

export type AttemptRow = {
  id: string;
  captureId: string;
  step: string;
  state: AttemptState;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  sourceUrl: string | null;
  observedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin: AttemptOrigin;
  actionDescription: string | null;
  estimatedMinutes: number | null;
  sourceExperienceId: string | null;
  sourceReviewId: string | null;
  sourceAttemptId: string | null;
  sourceAttemptRevision: number | null;
};

export type CaptureLinkRow = {
  id: string;
  fromCaptureId: string;
  toCaptureId: string;
  note: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type AttemptRefRow = {
  id: string;
  fromAttemptId: string;
  toAttemptId: string;
  note: string | null;
  snapshotResultText: string | null;
  snapshotRevision: number;
  revision: number;
  createdAt: number;
};

export type ExperienceSourceRow = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  addedAt: number;
};

export type ExperienceAttemptRow = {
  experienceId: string;
  attemptId: string;
  adoptedVersion: number;
  adoptedTitle: string;
  adoptedUnderstanding: string;
  basisSourceKeys: string[];
};

export type ExperienceRow = {
  id: string;
  title: string;
  understanding: string;
  conditions: string;
  limitations: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  needsRevision: boolean;
  revisionReason: string | null;
  derivation: {
    by: 'model' | 'user';
    modelBasis: 'observation' | 'inference' | null;
    originKind: 'ask' | 'attempt' | 'manual';
    originQueryId: string | null;
    originPointIndex: number | null;
    originAttemptId: string | null;
    contextCaptureId: string | null;
    confirmNote: string;
  };
  sources: ExperienceSourceRow[];
};

export type TopicRow = {
  id: string;
  name: string;
  exploringQuestion: string | null;
  continueNote: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  nextAttemptId: string | null;
  nextAttemptClearedReason: string | null;
};

export type TopicMemberRow = {
  topicId: string;
  captureId: string;
  addedAt: number;
};

export type ScheduleRow = {
  id: string;
  attemptId: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  note: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt: number | null;
};

export type StandaloneDb = {
  version: number;
  account: { id: string; username: string; createdAt: number } | null;
  captures: CaptureRow[];
  attempts: AttemptRow[];
  links: CaptureLinkRow[];
  references: AttemptRefRow[];
  experiences: ExperienceRow[];
  experienceAttempts: ExperienceAttemptRow[];
  topics: TopicRow[];
  topicMembers: TopicMemberRow[];
  schedules: ScheduleRow[];
  ops: Record<string, { at: number; result: unknown }>;
};

const STORAGE_KEY = 'shinian.standalone.v1';
const DB_VERSION = 1;

let cache: StandaloneDb | null = null;

export function emptyDb(): StandaloneDb {
  return {
    version: DB_VERSION,
    account: null,
    captures: [],
    attempts: [],
    links: [],
    references: [],
    experiences: [],
    experienceAttempts: [],
    topics: [],
    topicMembers: [],
    schedules: [],
    ops: {},
  };
}

export function now(): number {
  return Date.now();
}

export function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function loadDb(): StandaloneDb {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StandaloneDb>;
      if (parsed && parsed.version === DB_VERSION) {
        cache = { ...emptyDb(), ...parsed } as StandaloneDb;
        return cache;
      }
    }
  } catch {
    // 损坏的本地数据不应该让整个页面打不开：回到空库并重新保存。
  }
  cache = emptyDb();
  saveDb(cache);
  return cache;
}

export function saveDb(db: StandaloneDb): void {
  cache = db;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // 存储配额已满时保留内存态，至少本次会话可用。
  }
}

export function mutate<T>(fn: (db: StandaloneDb) => T): T {
  const db = loadDb();
  const result = fn(db);
  saveDb(db);
  return result;
}

let seededAccountChecked = false;

export function ensureAccount(): NonNullable<StandaloneDb['account']> {
  const db = loadDb();
  if (db.account) return db.account;
  const account = { id: uid(), username: '我', createdAt: now() };
  if (!seededAccountChecked) {
    db.account = account;
    saveDb(db);
    seededAccountChecked = true;
  } else {
    db.account = account;
  }
  return account;
}

export function rememberOperation<T>(db: StandaloneDb, operationId: string | undefined, result: T): T {
  if (!operationId) return result;
  const keys = Object.keys(db.ops);
  if (keys.length > 400) {
    for (const key of keys.slice(0, 100)) delete db.ops[key];
  }
  db.ops[operationId] = { at: now(), result };
  return result;
}

export function replayOperation<T>(db: StandaloneDb, operationId: string | undefined): T | null {
  if (!operationId) return null;
  const hit = db.ops[operationId];
  if (!hit) return null;
  return hit.result as T;
}

export function clearStandaloneData(): void {
  cache = emptyDb();
  saveDb(cache);
}

export function exportAll(): unknown {
  const db = loadDb();
  return {
    exportedAt: now(),
    app: '拾念 SHINIAN',
    mode: 'standalone',
    account: db.account,
    captures: db.captures,
    attempts: db.attempts,
    links: db.links,
    references: db.references,
    experiences: db.experiences,
    experienceAttempts: db.experienceAttempts,
    topics: db.topics,
    topicMembers: db.topicMembers,
    schedules: db.schedules,
  };
}