// 浏览器本地存储版的 API 路由：路径与返回形状对齐现有 Fastify 服务。
import {
  ensureAccount,
  loadDb,
  now,
  rememberOperation,
  replayOperation,
  saveDb,
  uid,
  type AttemptRow,
  type CaptureRow,
  type ExperienceRow,
  type ScheduleRow,
  type StandaloneDb,
  type TopicRow,
} from './store';
import {
  activityView,
  askSearchResponse,
  attemptOf,
  attemptView,
  captureLinkCandidates,
  captureLinkView,
  captureLinksView,
  captureOf,
  captureReferencesView,
  captureView,
  experienceListItemView,
  experienceOf,
  experiencePublicView,
  experienceSources,
  includesQuery,
  labelOf,
  localDateInZone,
  recentAttemptView,
  referencesView,
  reviewDailyData,
  reviewRangeData,
  scheduleOf,
  scheduleView,
  searchResults,
  snippetAround,
  topicAskExperiences,
  topicAttemptView,
  topicOf,
  topicView,
} from './views';

export type LocalResponse = { status: number; body: any };

type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
};

type Route = {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: (ctx: Ctx) => LocalResponse;
};

const routes: Route[] = [];

function route(method: string, path: string, handler: (ctx: Ctx) => LocalResponse): void {
  const keys: string[] = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler });
}

const ok = (body: any): LocalResponse => ({ status: 200, body });
const err = (status: number, error: string, message: string): LocalResponse => ({
  status,
  body: { error, message },
});

const AI_OFFLINE =
  '线上体验版未接入模型，这项能力需要在本地版配置 OpenAI 兼容模型后使用。';
const RESEARCH_OFFLINE = '线上体验版不接入 GitHub 调研，请在本地版使用。';

function parseLimit(raw: string | null, fallback: number, max = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (/^-?\d+$/.test(text)) {
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ---------- 会话 ----------

route('POST', '/session/create', ({ body }) => {
  const db = loadDb();
  const username = String(body?.username ?? '').trim() || '我';
  const account = db.account ?? { id: uid(), username, createdAt: now() };
  account.username = username;
  db.account = account;
  saveDb(db);
  return ok({ ok: true, accountId: account.id, username: account.username });
});

route('GET', '/session/check', () => {
  const account = ensureAccount();
  const db = loadDb();
  saveDb(db);
  return ok({ ok: true, accountId: account.id, username: account.username });
});

route('POST', '/session/destroy', () => ok({ ok: true }));

// ---------- 念头 ----------

route('GET', '/captures', ({ query }) => {
  const db = loadDb();
  const archived = query.get('archived') === '1';
  const q = (query.get('q') ?? '').trim();
  let rows = db.captures.filter(
    (c) => c.kind === 'thought' && (archived ? c.archivedAt != null : c.archivedAt == null)
  );
  if (q) rows = rows.filter((c) => includesQuery(c.rawText, q));
  rows = rows.sort((a, b) => b.createdAt - a.createdAt);
  return ok({ captures: rows.map(captureView) });
});

route('POST', '/captures', ({ body }) => {
  const db = loadDb();
  const rawText = String(body?.rawText ?? '').trim();
  if (!rawText) return err(400, 'invalid_capture', '念头不能为空');
  if (rawText.length > 4000) return err(400, 'invalid_capture', '念头最多 4000 字');
  const t = now();
  const row: CaptureRow = {
    id: uid(),
    rawText,
    kind: 'thought',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    archivedAt: null,
  };
  db.captures.push(row);
  saveDb(db);
  return ok({ capture: captureView(row) });
});

route('GET', '/captures/:id', ({ params }) => {
  const db = loadDb();
  const row = captureOf(db, params.id);
  if (!row) return err(404, 'capture_not_found', '记录不存在或已删除');
  return ok({ capture: captureView(row) });
});

route('PATCH', '/captures/:id', ({ params, body }) => {
  const db = loadDb();
  const row = captureOf(db, params.id);
  if (!row) return err(404, 'capture_not_found', '记录不存在或已删除');
  if (Number(body?.revision) !== row.revision) {
    return err(409, 'revision_conflict', '这条记录刚被修改，请刷新后再保存');
  }
  const rawText = String(body?.rawText ?? '').trim();
  if (!rawText) return err(400, 'invalid_capture', '念头不能为空');
  if (rawText.length > 4000) return err(400, 'invalid_capture', '念头最多 4000 字');
  row.rawText = rawText;
  row.revision += 1;
  row.updatedAt = now();
  saveDb(db);
  return ok({ capture: captureView(row) });
});

route('POST', '/captures/:id/archive', ({ params }) => {
  const db = loadDb();
  const row = captureOf(db, params.id);
  if (!row) return err(404, 'capture_not_found', '记录不存在或已删除');
  row.archivedAt = now();
  row.updatedAt = row.archivedAt;
  row.revision += 1;
  saveDb(db);
  return ok({ capture: captureView(row) });
});

route('POST', '/captures/:id/restore', ({ params }) => {
  const db = loadDb();
  const row = captureOf(db, params.id);
  if (!row) return err(404, 'capture_not_found', '记录不存在或已删除');
  row.archivedAt = null;
  row.updatedAt = now();
  row.revision += 1;
  saveDb(db);
  return ok({ capture: captureView(row) });
});

function affectedExperienceImpact(db: StandaloneDb, captureId: string, attemptIds: Set<string>) {
  return db.experiences
    .filter((exp) =>
      exp.sources.some(
        (s) =>
          (s.type === 'capture' && s.id === captureId) ||
          (s.type === 'attempt' && attemptIds.has(s.id))
      )
    )
    .map((exp) => {
      const affected = exp.sources.filter(
        (s) =>
          (s.type === 'capture' && s.id === captureId) ||
          (s.type === 'attempt' && attemptIds.has(s.id))
      ).length;
      return {
        id: exp.id,
        title: exp.title,
        deletedSourceCount: affected,
        willClearUnderstanding: affected >= exp.sources.length,
      };
    });
}

route('GET', '/captures/:id/delete-preview', ({ params }) => {
  const db = loadDb();
  const capture = captureOf(db, params.id);
  if (!capture) return err(404, 'capture_not_found', '记录不存在或已删除');
  const attemptIds = new Set(db.attempts.filter((a) => a.captureId === capture.id).map((a) => a.id));
  const affected = affectedExperienceImpact(db, capture.id, attemptIds);
  return ok({
    captureId: capture.id,
    attemptCount: attemptIds.size,
    referencesFromAttempts: db.references.filter((r) => attemptIds.has(r.fromAttemptId)).length,
    referencesToAttempts: db.references.filter((r) => attemptIds.has(r.toAttemptId)).length,
    captureLinkCount: db.links.filter(
      (l) => l.fromCaptureId === capture.id || l.toCaptureId === capture.id
    ).length,
    generationCount: 0,
    scheduleCount: db.schedules.filter((s) => attemptIds.has(s.attemptId)).length,
    researchCount: 0,
    affectedExperiences: affected,
    experience: null,
  });
});

route('DELETE', '/captures/:id', ({ params }) => {
  const db = loadDb();
  const capture = captureOf(db, params.id);
  if (!capture) return err(404, 'capture_not_found', '记录不存在或已删除');
  const attemptIds = new Set(db.attempts.filter((a) => a.captureId === capture.id).map((a) => a.id));
  const deletedReferences = db.references.filter(
    (r) => attemptIds.has(r.fromAttemptId) || attemptIds.has(r.toAttemptId)
  ).length;
  const deletedSchedules = db.schedules.filter((s) => attemptIds.has(s.attemptId)).length;
  db.captures = db.captures.filter((c) => c.id !== capture.id);
  db.attempts = db.attempts.filter((a) => !attemptIds.has(a.id));
  db.references = db.references.filter(
    (r) => !attemptIds.has(r.fromAttemptId) && !attemptIds.has(r.toAttemptId)
  );
  db.schedules = db.schedules.filter((s) => !attemptIds.has(s.attemptId));
  db.links = db.links.filter(
    (l) => l.fromCaptureId !== capture.id && l.toCaptureId !== capture.id
  );
  db.topicMembers = db.topicMembers.filter((m) => m.captureId !== capture.id);
  saveDb(db);
  return ok({
    ok: true,
    deletedAttempts: attemptIds.size,
    deletedReferences,
    deletedGenerations: 0,
    deletedSchedules,
  });
});

// ---------- 尝试 ----------

route('POST', '/captures/:captureId/attempts', ({ params, body }) => {
  const db = loadDb();
  const capture = captureOf(db, params.captureId);
  if (!capture) return err(404, 'capture_not_found', '记录不存在或已删除');
  const replay = replayOperation<{ attempt: any }>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const step = String(body?.step ?? '').trim();
  if (!step) return err(400, 'invalid_attempt', '请写下这一步要做什么');
  if (step.length > 500) return err(400, 'invalid_attempt', '尝试步骤最多 500 字');
  const state = ['todo', 'in_progress', 'done', 'cancelled'].includes(String(body?.state))
    ? (String(body.state) as AttemptRow['state'])
    : 'todo';
  const resultText =
    typeof body?.resultText === 'string' && body.resultText.trim() ? body.resultText.trim() : null;
  const outcome = ['success', 'failure', 'undetermined'].includes(String(body?.outcome))
    ? (String(body.outcome) as AttemptRow['outcome'])
    : null;
  const t = now();
  const row: AttemptRow = {
    id: uid(),
    captureId: capture.id,
    step,
    state,
    resultText,
    outcome,
    sourceUrl: typeof body?.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null,
    observedAt: resultText || state === 'done' ? t : null,
    revision: 1,
    createdAt: t,
    updatedAt: t,
    origin: 'manual',
    actionDescription: null,
    estimatedMinutes: null,
    sourceExperienceId: null,
    sourceReviewId: null,
    sourceAttemptId: null,
    sourceAttemptRevision: null,
  };
  db.attempts.push(row);
  capture.updatedAt = t;
  const result = { attempt: attemptView(row) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('GET', '/captures/:captureId/attempts', ({ params }) => {
  const db = loadDb();
  const rows = db.attempts
    .filter((a) => a.captureId === params.captureId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return ok({ attempts: rows.map(attemptView) });
});

route('GET', '/attempts/recent', ({ query }) => {
  const db = loadDb();
  const limit = parseLimit(query.get('limit'), 6, 50);
  const rows = [...db.attempts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  return ok({ attempts: rows.map((row) => recentAttemptView(db, row)) });
});

route('GET', '/attempts/:id', ({ params }) => {
  const db = loadDb();
  const row = attemptOf(db, params.id);
  if (!row) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const capture = captureOf(db, row.captureId);
  let experienceRef = null;
  if (row.sourceExperienceId) {
    const exp = experienceOf(db, row.sourceExperienceId);
    const link = db.experienceAttempts.find((l) => l.attemptId === row.id);
    experienceRef = exp
      ? {
          experienceId: exp.id,
          adoptedVersion: link?.adoptedVersion ?? exp.revision,
          adoptedTitle: link?.adoptedTitle ?? exp.title,
          adoptedUnderstanding: link?.adoptedUnderstanding ?? exp.understanding,
          deleted: false,
          exists: true,
          archived: Boolean(exp.archivedAt),
          currentVersion: exp.revision,
          changed: Boolean(link && link.adoptedVersion !== exp.revision),
        }
      : {
          experienceId: row.sourceExperienceId,
          adoptedVersion: 0,
          adoptedTitle: '（来源经验已删除）',
          adoptedUnderstanding: '',
          deleted: true,
          exists: false,
          archived: false,
          currentVersion: null,
          changed: false,
        };
  }
  return ok({ attempt: attemptView(row), capture: capture ? captureView(capture) : null, experienceRef });
});

route('PATCH', '/attempts/:id', ({ params, body }) => {
  const db = loadDb();
  const row = attemptOf(db, params.id);
  if (!row) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  if (Number(body?.revision) !== row.revision) {
    return err(409, 'revision_conflict', '这次尝试刚被修改，请刷新后再保存');
  }
  if (body?.state !== undefined) {
    if (!['todo', 'in_progress', 'done', 'cancelled'].includes(String(body.state))) {
      return err(400, 'invalid_attempt', '尝试状态无效');
    }
    row.state = String(body.state) as AttemptRow['state'];
  }
  if (body?.resultText !== undefined) {
    const text = typeof body.resultText === 'string' ? body.resultText.trim() : '';
    row.resultText = text || null;
  }
  if (body?.outcome !== undefined) {
    row.outcome =
      body.outcome == null
        ? null
        : ['success', 'failure', 'undetermined'].includes(String(body.outcome))
          ? (String(body.outcome) as AttemptRow['outcome'])
          : null;
  }
  if (body?.sourceUrl !== undefined) {
    row.sourceUrl =
      typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null;
  }
  if (body?.observedAt !== undefined) {
    row.observedAt = typeof body.observedAt === 'number' ? body.observedAt : null;
  } else if ((row.resultText || row.state === 'done') && row.observedAt == null) {
    row.observedAt = now();
  }
  row.revision += 1;
  row.updatedAt = now();
  let cancelledScheduleCount = 0;
  if ((row.state === 'done' || row.state === 'cancelled') && body?.futureScheduleAction === 'cancel') {
    const t = now();
    for (const s of db.schedules) {
      if (s.attemptId === row.id && s.status === 'active' && s.startsAt >= t) {
        s.status = 'cancelled';
        s.cancelledAt = t;
        s.updatedAt = t;
        s.revision += 1;
        cancelledScheduleCount += 1;
      }
    }
  }
  saveDb(db);
  return ok({ attempt: attemptView(row), cancelledScheduleCount });
});

route('GET', '/attempts/:id/delete-preview', ({ params }) => {
  const db = loadDb();
  const row = attemptOf(db, params.id);
  if (!row) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const schedules = db.schedules.filter((s) => s.attemptId === row.id);
  const affected = affectedExperienceImpact(db, row.captureId, new Set([row.id]));
  return ok({
    attemptId: row.id,
    scheduleCount: schedules.length,
    activeScheduleCount: schedules.filter((s) => s.status === 'active').length,
    referencesFromAttempts: db.references.filter((r) => r.fromAttemptId === row.id).length,
    referencesToAttempts: db.references.filter((r) => r.toAttemptId === row.id).length,
    affectedExperiences: affected,
  });
});

route('DELETE', '/attempts/:id', ({ params }) => {
  const db = loadDb();
  const row = attemptOf(db, params.id);
  if (!row) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const deletedReferences = db.references.filter(
    (r) => r.fromAttemptId === row.id || r.toAttemptId === row.id
  ).length;
  const deletedSchedules = db.schedules.filter((s) => s.attemptId === row.id).length;
  db.attempts = db.attempts.filter((a) => a.id !== row.id);
  db.references = db.references.filter(
    (r) => r.fromAttemptId !== row.id && r.toAttemptId !== row.id
  );
  db.schedules = db.schedules.filter((s) => s.attemptId !== row.id);
  db.experienceAttempts = db.experienceAttempts.filter((l) => l.attemptId !== row.id);
  saveDb(db);
  return ok({ ok: true, deletedReferences, deletedSchedules });
});

// ---------- 尝试引用 ----------

route('POST', '/attempts/:fromId/references', ({ params, body }) => {
  const db = loadDb();
  const from = attemptOf(db, params.fromId);
  if (!from) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const to = attemptOf(db, String(body?.toId ?? ''));
  if (!to) return err(404, 'attempt_not_found', '被引用的尝试不存在或已删除');
  if (to.id === from.id) return err(400, 'invalid_reference', '不能引用自己');
  const t = now();
  const row = {
    id: uid(),
    fromAttemptId: from.id,
    toAttemptId: to.id,
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null,
    snapshotResultText: to.resultText,
    snapshotRevision: to.revision,
    revision: 1,
    createdAt: t,
  };
  db.references.push(row);
  const result = { reference: row };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('GET', '/attempts/:id/references', ({ params }) => {
  const db = loadDb();
  const row = attemptOf(db, params.id);
  if (!row) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  return ok(referencesView(db, row.id));
});

route('DELETE', '/attempt_references/:id', ({ params }) => {
  const db = loadDb();
  const before = db.references.length;
  db.references = db.references.filter((r) => r.id !== params.id);
  if (db.references.length === before) return err(404, 'reference_not_found', '这条引用已不存在');
  saveDb(db);
  return ok({ ok: true });
});

// ---------- 念头关联 ----------

route('GET', '/captures/:captureId/links', ({ params }) => {
  const db = loadDb();
  if (!captureOf(db, params.captureId)) return err(404, 'capture_not_found', '记录不存在或已删除');
  return ok(captureLinksView(db, params.captureId));
});

route('GET', '/capture-links/candidates', ({ query }) => {
  const db = loadDb();
  const excludeId = query.get('excludeId') ?? '';
  return ok(captureLinkCandidates(db, excludeId, (query.get('q') ?? '').trim(), parseLimit(query.get('limit'), 12, 50)));
});

route('POST', '/captures/:captureId/links', ({ params, body }) => {
  const db = loadDb();
  const from = captureOf(db, params.captureId);
  if (!from) return err(404, 'capture_not_found', '记录不存在或已删除');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const to = captureOf(db, String(body?.toCaptureId ?? ''));
  if (!to) return err(404, 'capture_not_found', '要关联的记录不存在或已删除');
  if (to.id === from.id) return err(400, 'invalid_link', '不能关联自己');
  const exists = db.links.some(
    (l) =>
      (l.fromCaptureId === from.id && l.toCaptureId === to.id) ||
      (l.fromCaptureId === to.id && l.toCaptureId === from.id)
  );
  if (exists) return err(409, 'duplicate_link', '这两条记录已经关联');
  const t = now();
  const row = {
    id: uid(),
    fromCaptureId: from.id,
    toCaptureId: to.id,
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null,
    revision: 1,
    createdAt: t,
    updatedAt: t,
  };
  db.links.push(row);
  const result = { link: captureLinkView(db, row, 'out') };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('DELETE', '/capture_links/:linkId', ({ params }) => {
  const db = loadDb();
  const before = db.links.length;
  db.links = db.links.filter((l) => l.id !== params.linkId);
  if (db.links.length === before) return err(404, 'link_not_found', '这条关联已不存在');
  saveDb(db);
  return ok({ ok: true, deletedId: params.linkId });
});

route('GET', '/captures/:captureId/references', ({ params }) => {
  const db = loadDb();
  if (!captureOf(db, params.captureId)) return err(404, 'capture_not_found', '记录不存在或已删除');
  return ok(captureReferencesView(db, params.captureId));
});

// ---------- 搜索 ----------

route('GET', '/search', ({ query }) => {
  const db = loadDb();
  return ok(searchResults(db, (query.get('q') ?? '').trim()));
});

// ---------- 知识网络 ----------

function buildGraph(
  db: StandaloneDb,
  options: { archived: boolean; focus: string | null; depth: 1 | 2 | null }
) {
  const captures = db.captures.filter((c) => options.archived || !c.archivedAt);
  const captureIds = new Set(captures.map((c) => c.id));
  const attempts = db.attempts.filter((a) => captureIds.has(a.captureId));
  const attemptIds = new Set(attempts.map((a) => a.id));
  const experiences = db.experiences.filter((e) => options.archived || !e.archivedAt);

  const nodes: any[] = [];
  const nodeMap = new Map<string, any>();
  const addNode = (node: any) => {
    const full = { ...node, degree: 0 };
    nodes.push(full);
    nodeMap.set(full.id, full);
  };
  const captureNodeId = new Map<string, string>();

  for (const c of captures) {
    if (c.kind === 'experience') continue;
    captureNodeId.set(c.id, `capture:${c.id}`);
    addNode({
      id: `capture:${c.id}`,
      type: 'capture',
      label: labelOf(c.rawText),
      detail: c.rawText,
      createdAt: c.createdAt,
      state: null,
      archived: Boolean(c.archivedAt),
      href: `/capture/${c.id}`,
      captureId: c.id,
      captureLabel: labelOf(c.rawText, 28),
      origin: null,
    });
  }
  for (const e of experiences) {
    captureNodeId.set(e.id, `experience:${e.id}`);
    addNode({
      id: `experience:${e.id}`,
      type: 'experience',
      label: labelOf(e.title, 28),
      detail: e.understanding || '这份经验还没有正文。',
      createdAt: e.createdAt,
      state: null,
      archived: Boolean(e.archivedAt),
      href: `/experience/${e.id}`,
      captureId: e.id,
      captureLabel: labelOf(e.title, 28),
      origin: null,
    });
  }
  for (const a of attempts) {
    addNode({
      id: `attempt:${a.id}`,
      type: 'attempt',
      label: labelOf(a.actionDescription || a.step, 28),
      detail: a.actionDescription || a.step,
      createdAt: a.createdAt,
      state: a.state,
      archived: false,
      href: `/attempt/${a.id}`,
      captureId: a.captureId,
      captureLabel: labelOf(captureOf(db, a.captureId)?.rawText ?? '', 28),
      resultText: a.resultText,
      observedAt: a.observedAt,
      outcome: a.outcome,
      sourceUrl: a.sourceUrl,
      origin: a.origin,
    });
  }
  for (const s of db.schedules.filter((s) => s.status === 'active' && attemptIds.has(s.attemptId))) {
    addNode({
      id: `schedule:${s.id}`,
      type: 'schedule',
      label: new Date(s.startsAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
      detail: s.note || '已安排的时间段',
      createdAt: s.startsAt,
      state: s.status,
      archived: false,
      href: '/schedule',
      captureId: null,
      captureLabel: null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      origin: null,
    });
  }

  const links: any[] = [];
  const linkKeys = new Set<string>();
  const addLink = (source: string, target: string, type: string, label: string) => {
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    const key = `${type}|${source}|${target}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ id: `edge:${key}`, source, target, type, label });
    nodeMap.get(source).degree += 1;
    nodeMap.get(target).degree += 1;
  };

  for (const a of attempts) addLink(`capture:${a.captureId}`, `attempt:${a.id}`, 'contains', '包含尝试');
  for (const r of db.references) {
    addLink(`attempt:${r.fromAttemptId}`, `attempt:${r.toAttemptId}`, 'references', '引用了旧结果');
  }
  for (const l of db.links) {
    const from = captureNodeId.get(l.fromCaptureId);
    const to = captureNodeId.get(l.toCaptureId);
    if (from && to) addLink(from, to, 'related', '手动关联');
  }
  for (const e of experiences) {
    for (const s of e.sources) {
      const target =
        s.type === 'attempt' ? `attempt:${s.id}` : captureNodeId.get(s.id);
      if (target) addLink(`experience:${e.id}`, target, 'evidence', '依据这条记录');
    }
    if (e.derivation.contextCaptureId) {
      const ctx = captureNodeId.get(e.derivation.contextCaptureId);
      if (ctx) addLink(ctx, `experience:${e.id}`, 'context', '所属念头');
    }
  }
  for (const l of db.experienceAttempts) {
    if (l.experienceId) addLink(`attempt:${l.attemptId}`, `experience:${l.experienceId}`, 'used', '参考这条经验再试');
  }
  for (const s of db.schedules.filter((s) => s.status === 'active')) {
    addLink(`attempt:${s.attemptId}`, `schedule:${s.id}`, 'scheduled', '安排时间');
  }

  let shownNodes = nodes;
  let shownLinks = links;
  if (options.focus) {
    const allowed = new Set<string>([options.focus]);
    const depth = options.depth ?? 1;
    let frontier = [options.focus];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const link of links) {
        if (frontier.includes(link.source) && !allowed.has(link.target)) {
          allowed.add(link.target);
          next.push(link.target);
        }
        if (frontier.includes(link.target) && !allowed.has(link.source)) {
          allowed.add(link.source);
          next.push(link.source);
        }
      }
      frontier = next;
    }
    shownNodes = nodes.filter((n) => allowed.has(n.id));
    shownLinks = links.filter((l) => allowed.has(l.source) && allowed.has(l.target));
  }

  const shownCaptures = shownNodes.filter((n) => n.type === 'capture').length;
  const shownExperiences = shownNodes.filter((n) => n.type === 'experience').length;
  return {
    stats: {
      captures: captures.filter((c) => c.kind === 'thought').length,
      experiences: experiences.length,
      attempts: attempts.length,
      research: 0,
      reviews: 0,
      schedules: db.schedules.filter((s) => s.status === 'active').length,
      links: links.length,
      manualLinks: db.links.length,
    },
    nodes: shownNodes,
    links: shownLinks,
    meta: {
      scope: options.focus ? 'local' : 'global',
      limit: null,
      totalCaptures: captures.filter((c) => c.kind === 'thought').length,
      shownCaptures,
      totalExperiences: experiences.length,
      shownExperiences,
      truncated: false,
      focus: options.focus,
      depth: options.focus ? (options.depth ?? 1) : null,
    },
  };
}

route('GET', '/graph', ({ query }) => {
  const db = loadDb();
  return ok(buildGraph(db, { archived: query.get('archived') === '1', focus: null, depth: null }));
});

route('GET', '/graph/focus', ({ query }) => {
  const db = loadDb();
  const node = query.get('node') ?? '';
  if (!node) return err(400, 'invalid_node', '缺少要聚焦的节点');
  return ok(
    buildGraph(db, {
      archived: query.get('archived') === '1',
      focus: node,
      depth: query.get('depth') === '2' ? 2 : 1,
    })
  );
});

route('GET', '/graph/search', ({ query }) => {
  const db = loadDb();
  const q = (query.get('q') ?? '').trim();
  const allowedTypes = new Set((query.get('types') ?? '').split(',').filter(Boolean));
  const limit = parseLimit(query.get('limit'), 20, 100);
  if (!q) return ok({ query: q, archived: query.get('archived') === '1', types: [], total: 0, results: [] });
  const graph = buildGraph(db, { archived: query.get('archived') === '1', focus: null, depth: null });
  const results = graph.nodes
    .filter((n) => (allowedTypes.size ? allowedTypes.has(n.type) : true))
    .filter((n) => includesQuery(n.label, q) || includesQuery(n.detail, q))
    .slice(0, limit)
    .map((n) => ({
      node: n,
      captureId: n.captureId ?? null,
      captureLabel: n.captureLabel ?? null,
      matchField: includesQuery(n.label, q) ? 'label' : 'detail',
      snippet: snippetAround(n.detail || n.label, q),
      archived: Boolean(n.archived),
    }));
  return ok({
    query: q,
    archived: query.get('archived') === '1',
    types: [...allowedTypes],
    total: results.length,
    results,
  });
});

// ---------- 经验 ----------

route('GET', '/experiences', ({ query }) => {
  const db = loadDb();
  const archived = query.get('archived') ?? 'exclude';
  const q = (query.get('q') ?? '').trim();
  const limit = parseLimit(query.get('limit'), 200, 500);
  let rows = db.experiences.filter((e) =>
    archived === 'only' ? e.archivedAt != null : archived === 'include' ? true : e.archivedAt == null
  );
  if (q) {
    rows = rows.filter(
      (e) =>
        includesQuery(e.title, q) ||
        includesQuery(e.understanding, q) ||
        includesQuery(e.conditions, q) ||
        includesQuery(e.limitations, q)
    );
  }
  rows = rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  return ok({ experiences: rows.map(experienceListItemView) });
});

route('GET', '/experiences/source-candidates', ({ query }) => {
  const db = loadDb();
  const q = (query.get('q') ?? '').trim();
  const exclude = query.get('excludeExperienceId');
  const candidates: any[] = [];
  for (const a of db.attempts) {
    if (!a.resultText || !a.resultText.trim()) continue;
    if (q && !includesQuery(a.step, q) && !includesQuery(a.resultText, q)) continue;
    const capture = captureOf(db, a.captureId);
    candidates.push({
      sourceKey: `attempt:${a.id}`,
      type: 'attempt',
      id: a.id,
      captureId: a.captureId,
      title: labelOf(a.step, 42),
      text: a.step,
      resultText: a.resultText,
      outcome: a.outcome,
      state: a.state,
      observedAt: a.observedAt,
      kind: 'attempt',
      openHref: `/attempt/${a.id}`,
      exists: true,
      changed: false,
      captureText: capture?.rawText ?? '',
    });
  }
  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    if (exclude && c.id === exclude) continue;
    if (q && !includesQuery(c.rawText, q)) continue;
    candidates.push({
      sourceKey: `capture:${c.id}`,
      type: 'capture',
      id: c.id,
      captureId: c.id,
      title: labelOf(c.rawText, 42),
      text: c.rawText,
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      kind: 'thought',
      openHref: `/capture/${c.id}`,
      exists: true,
      changed: false,
      captureText: c.rawText,
    });
  }
  return ok({ candidates: candidates.slice(0, 30) });
});

route('GET', '/experiences/:id', ({ params }) => {
  const db = loadDb();
  const exp = experienceOf(db, params.id);
  if (!exp) return err(404, 'experience_not_found', '这份经验已不存在');
  return ok({ experience: experiencePublicView(db, exp) });
});

route('POST', '/experiences', ({ body }) => {
  const db = loadDb();
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const title = String(body?.title ?? '').trim();
  const understanding = String(body?.understanding ?? '').trim();
  if (!title) return err(400, 'invalid_experience', '经验标题不能为空');
  if (title.length > 120) return err(400, 'invalid_experience', '经验标题最多 120 字');
  if (!understanding) return err(400, 'invalid_experience', '请写下你的理解');
  const rawSourceKeys: string[] = Array.isArray(body?.sourceKeys)
    ? body.sourceKeys.map((key: any) => String(key))
    : [];
  const sourceKeys: string[] = [...new Set<string>(rawSourceKeys)].filter((key: string) => {
    if (key.startsWith('attempt:')) return Boolean(attemptOf(db, key.slice(8)));
    if (key.startsWith('capture:')) return Boolean(captureOf(db, key.slice(8)));
    return false;
  });
  if (!sourceKeys.length) return err(400, 'source_required', '至少关联一条仍可访问的原记录');
  const t = now();
  const exp: ExperienceRow = {
    id: uid(),
    title,
    understanding,
    conditions: String(body?.conditions ?? '').trim(),
    limitations: String(body?.limitations ?? '').trim(),
    revision: 1,
    createdAt: t,
    updatedAt: t,
    archivedAt: null,
    needsRevision: false,
    revisionReason: null,
    derivation: {
      by: body?.by === 'model' ? 'model' : 'user',
      modelBasis: body?.modelBasis === 'observation' || body?.modelBasis === 'inference' ? body.modelBasis : null,
      originKind: ['ask', 'attempt', 'manual'].includes(String(body?.originKind))
        ? body.originKind
        : 'manual',
      originQueryId: typeof body?.originQueryId === 'string' ? body.originQueryId : null,
      originPointIndex: typeof body?.originPointIndex === 'number' ? body.originPointIndex : null,
      originAttemptId: typeof body?.originAttemptId === 'string' ? body.originAttemptId : null,
      contextCaptureId: typeof body?.contextCaptureId === 'string' ? body.contextCaptureId : null,
      confirmNote: '由你自己整理并保存',
    },
    sources: sourceKeys.map((key: string) => ({
      sourceKey: key,
      type: key.startsWith('attempt:') ? 'attempt' : 'capture',
      id: key.slice(key.indexOf(':') + 1),
      addedAt: t,
    })),
  };
  db.experiences.push(exp);
  const result = { experience: experiencePublicView(db, exp) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('PATCH', '/experiences/:id', ({ params, body }) => {
  const db = loadDb();
  const exp = experienceOf(db, params.id);
  if (!exp) return err(404, 'experience_not_found', '这份经验已不存在');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  if (Number(body?.revision) !== exp.revision) {
    return err(409, 'revision_conflict', '这份经验刚被修改，请刷新后再保存');
  }
  const title = String(body?.title ?? '').trim();
  const understanding = String(body?.understanding ?? '').trim();
  if (!title) return err(400, 'invalid_experience', '经验标题不能为空');
  if (!understanding) return err(400, 'invalid_experience', '请写下你的理解');
  exp.title = title;
  exp.understanding = understanding;
  exp.conditions = String(body?.conditions ?? '').trim();
  exp.limitations = String(body?.limitations ?? '').trim();
  if (Array.isArray(body?.sourceKeys)) {
    const rawKeys: string[] = body.sourceKeys.map((key: any) => String(key));
    const sourceKeys: string[] = [...new Set<string>(rawKeys)].filter(
      (key: string) => {
        if (key.startsWith('attempt:')) return Boolean(attemptOf(db, key.slice(8)));
        if (key.startsWith('capture:')) return Boolean(captureOf(db, key.slice(8)));
        return false;
      }
    );
    if (!sourceKeys.length) {
      return err(400, 'source_required', '至少关联一条仍可访问的原记录');
    }
    const existing = new Map(exp.sources.map((s) => [s.sourceKey, s.addedAt]));
    exp.sources = sourceKeys.map((key: string) => ({
      sourceKey: key,
      type: key.startsWith('attempt:') ? 'attempt' : 'capture',
      id: key.slice(key.indexOf(':') + 1),
      addedAt: existing.get(key) ?? now(),
    }));
  }
  exp.revision += 1;
  exp.updatedAt = now();
  const result = { experience: experiencePublicView(db, exp) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('GET', '/experiences/:id/delete-preview', ({ params }) => {
  const db = loadDb();
  const exp = experienceOf(db, params.id);
  if (!exp) return err(404, 'experience_not_found', '这份经验已不存在');
  return ok({
    experienceId: exp.id,
    title: exp.title,
    sourceCount: exp.sources.length,
    attemptCount: db.experienceAttempts.filter((l) => l.experienceId === exp.id).length,
    linkCount: exp.sources.length,
    sources: experienceSources(db, exp).map((s) => ({ title: s.title, type: s.type, exists: s.exists })),
    attempts: db.experienceAttempts
      .filter((l) => l.experienceId === exp.id)
      .map((l) => {
        const a = attemptOf(db, l.attemptId);
        return {
          id: l.attemptId,
          title: a?.step ?? '（已删除）',
          resultText: a?.resultText ?? null,
          outcome: a?.outcome ?? null,
        };
      }),
  });
});

route('DELETE', '/experiences/:id', ({ params }) => {
  const db = loadDb();
  const exp = experienceOf(db, params.id);
  if (!exp) return err(404, 'experience_not_found', '这份经验已不存在');
  db.experiences = db.experiences.filter((e) => e.id !== exp.id);
  db.experienceAttempts = db.experienceAttempts.filter((l) => l.experienceId !== exp.id);
  db.topicMembers = db.topicMembers.filter((m) => m.captureId !== exp.id);
  saveDb(db);
  return ok({ ok: true, deletedExperienceId: exp.id });
});

route('GET', '/captures/:captureId/experience-candidates', ({ params, query }) => {
  const db = loadDb();
  const capture = captureOf(db, params.captureId);
  if (!capture) return err(404, 'capture_not_found', '记录不存在或已删除');
  const q = (query.get('q') ?? '').trim();
  const limit = parseLimit(query.get('limit'), 12, 50);
  const rows = db.attempts
    .filter((a) => a.captureId === capture.id && a.resultText && a.resultText.trim())
    .filter((a) => !q || includesQuery(a.step, q) || includesQuery(a.resultText, q))
    .sort((a, b) => (b.observedAt ?? b.updatedAt) - (a.observedAt ?? a.updatedAt))
    .slice(0, limit);
  return ok({
    captureId: capture.id,
    query: q,
    suggestedQuery: '',
    limit,
    total: rows.length,
    candidates: rows.map((a) => ({
      id: a.id,
      captureId: a.captureId,
      captureText: capture.rawText,
      captureArchived: Boolean(capture.archivedAt),
      captureRevision: capture.revision,
      step: a.step,
      resultText: a.resultText,
      outcome: a.outcome,
      observedAt: a.observedAt,
      sourceUrl: a.sourceUrl,
      revision: a.revision,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      matchReasons: ['同一条念头下已记录结果'],
    })),
  });
});

route('GET', '/attempts/:id/experience-draft', ({ params }) => {
  const db = loadDb();
  const attempt = attemptOf(db, params.id);
  if (!attempt) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  if (!attempt.resultText || !attempt.resultText.trim()) {
    return err(400, 'attempt_result_required', '这次尝试还没有实际结果');
  }
  const capture = captureOf(db, attempt.captureId);
  return ok({
    draft: {
      originKind: 'attempt',
      title: labelOf(capture?.rawText ?? attempt.step, 40),
      understanding: '',
      conditions: '',
      limitations: '',
      by: 'user',
      modelBasis: null,
      originQueryId: null,
      originPointIndex: null,
      originAttemptId: attempt.id,
      contextCaptureId: attempt.captureId,
      sources: [
        {
          sourceKey: `attempt:${attempt.id}`,
          type: 'attempt',
          id: attempt.id,
          captureId: attempt.captureId,
          title: labelOf(attempt.step, 42),
          text: attempt.step,
          resultText: attempt.resultText,
          outcome: attempt.outcome,
          state: attempt.state,
          observedAt: attempt.observedAt,
          kind: 'attempt',
          openHref: `/attempt/${attempt.id}`,
          exists: true,
          changed: false,
        },
      ],
      hint: '把这次真实观察整理成可复用的经验。',
    },
  });
});

route('POST', '/experiences/:id/attempts', ({ params, body }) => {
  const db = loadDb();
  const exp = experienceOf(db, params.id);
  if (!exp) return err(404, 'experience_not_found', '这份经验已不存在');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  if (Number(body?.experienceRevision) !== exp.revision) {
    return err(409, 'experience_version_conflict', '经验刚刚被修改，请刷新后再试');
  }
  const capture = captureOf(db, String(body?.captureId ?? ''));
  if (!capture) return err(400, 'capture_unavailable', '请选择一个仍可用的念头');
  const title = String(body?.title ?? '').trim();
  if (!title) return err(400, 'invalid_attempt', '请写下这一步要做什么');
  const t = now();
  const attempt: AttemptRow = {
    id: uid(),
    captureId: capture.id,
    step: title,
    state: 'todo',
    resultText: null,
    outcome: null,
    sourceUrl: null,
    observedAt: null,
    revision: 1,
    createdAt: t,
    updatedAt: t,
    origin: 'experience_retry',
    actionDescription: String(body?.description ?? '').trim() || null,
    estimatedMinutes: null,
    sourceExperienceId: exp.id,
    sourceReviewId: null,
    sourceAttemptId: null,
    sourceAttemptRevision: null,
  };
  db.attempts.push(attempt);
  db.experienceAttempts.push({
    experienceId: exp.id,
    attemptId: attempt.id,
    adoptedVersion: exp.revision,
    adoptedTitle: exp.title,
    adoptedUnderstanding: exp.understanding,
    basisSourceKeys: Array.isArray(body?.basisSourceKeys) ? body.basisSourceKeys.map(String) : [],
  });
  const result = { attempt: attemptView(attempt), experienceId: exp.id };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

// ---------- 主题 ----------

route('GET', '/topics', ({ query }) => {
  const db = loadDb();
  const archived = query.get('archived') === '1' ? 'only' : query.get('archived') === 'all' ? 'include' : 'exclude';
  const q = (query.get('q') ?? '').trim();
  const offset = Math.max(0, Number(query.get('offset')) || 0);
  const limit = parseLimit(query.get('limit'), 20, 100);
  let rows = db.topics.filter((t) =>
    archived === 'only' ? t.archivedAt != null : archived === 'include' ? true : t.archivedAt == null
  );
  if (q) {
    rows = rows.filter(
      (t) => includesQuery(t.name, q) || includesQuery(t.exploringQuestion, q) || includesQuery(t.continueNote, q)
    );
  }
  rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const page = rows.slice(offset, offset + limit);
  return ok({
    topics: page.map((t) => topicView(db, t)),
    total: rows.length,
    offset,
    limit,
    hasMore: offset + limit < rows.length,
    nextCursor: null,
  });
});

route('POST', '/topics', ({ body }) => {
  const db = loadDb();
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const name = String(body?.title ?? body?.name ?? '').trim();
  if (!name) return err(400, 'invalid_topic_name', '主题名称不能为空');
  if (name.length > 80) return err(400, 'invalid_topic_name', '主题名称最多 80 字');
  const t = now();
  const topic: TopicRow = {
    id: uid(),
    name,
    exploringQuestion:
      typeof body?.exploringQuestion === 'string' && body.exploringQuestion.trim()
        ? body.exploringQuestion.trim()
        : null,
    continueNote:
      typeof body?.continueNote === 'string' && body.continueNote.trim()
        ? body.continueNote.trim()
        : null,
    revision: 1,
    createdAt: t,
    updatedAt: t,
    archivedAt: null,
    nextAttemptId: null,
    nextAttemptClearedReason: null,
  };
  db.topics.push(topic);
  const result = { topic: topicView(db, topic) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('GET', '/topics/:id', ({ params }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  return ok({ topic: topicView(db, topic) });
});

route('PATCH', '/topics/:id', ({ params, body }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const expected = body?.expectedRevision ?? body?.revision;
  if (expected != null && Number(expected) !== topic.revision) {
    return err(409, 'revision_conflict', '主题刚被修改，请刷新后再保存');
  }
  if (body?.title !== undefined || body?.name !== undefined) {
    const name = String(body.title ?? body.name ?? '').trim();
    if (!name || name.length > 80) return err(400, 'invalid_topic_name', '主题名称需为 1–80 字');
    topic.name = name;
  }
  if (body?.exploringQuestion !== undefined) {
    const value = body.exploringQuestion == null ? '' : String(body.exploringQuestion).trim();
    if (value.length > 500) return err(400, 'invalid_exploring_question', '探索问题最多 500 字');
    topic.exploringQuestion = value || null;
  }
  if (body?.continueNote !== undefined) {
    const value = body.continueNote == null ? '' : String(body.continueNote).trim();
    if (value.length > 500) return err(400, 'invalid_continue_note', '继续备注最多 500 字');
    topic.continueNote = value || null;
  }
  topic.revision += 1;
  topic.updatedAt = now();
  const result = { topic: topicView(db, topic) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('POST', '/topics/:id/archive', ({ params, body }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  if (body?.expectedRevision != null && Number(body.expectedRevision) !== topic.revision) {
    return err(409, 'revision_conflict', '主题刚被修改，请刷新后再保存');
  }
  topic.archivedAt = now();
  topic.updatedAt = topic.archivedAt;
  topic.revision += 1;
  saveDb(db);
  return ok({ topic: topicView(db, topic) });
});

route('POST', '/topics/:id/restore', ({ params, body }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  if (body?.expectedRevision != null && Number(body.expectedRevision) !== topic.revision) {
    return err(409, 'revision_conflict', '主题刚被修改，请刷新后再保存');
  }
  topic.archivedAt = null;
  topic.updatedAt = now();
  topic.revision += 1;
  saveDb(db);
  return ok({ topic: topicView(db, topic) });
});

route('GET', '/topics/:id/delete-preview', ({ params }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const view = topicView(db, topic);
  return ok({
    topicId: topic.id,
    name: topic.name,
    memberCount: view.memberCount,
    thoughtCount: view.thoughtCount,
    experienceCount: view.experienceCount,
    attemptCount: view.attemptCount,
    nextAttemptStep: view.nextAttempt?.step ?? null,
  });
});

route('DELETE', '/topics/:id', ({ params }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  db.topics = db.topics.filter((t) => t.id !== topic.id);
  db.topicMembers = db.topicMembers.filter((m) => m.topicId !== topic.id);
  saveDb(db);
  return ok({ ok: true, deletedTopicId: topic.id, clearedNextAttempt: Boolean(topic.nextAttemptId) });
});

route('GET', '/topics/:id/member-candidates', ({ params, query }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const q = (query.get('q') ?? '').trim();
  const memberIds = new Set(db.topicMembers.filter((m) => m.topicId === topic.id).map((m) => m.captureId));
  const candidates: any[] = [];
  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    if (q && !includesQuery(c.rawText, q)) continue;
    candidates.push({
      captureId: c.id,
      type: 'thought',
      title: labelOf(c.rawText, 60),
      summary: labelOf(c.rawText, 80),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archived: Boolean(c.archivedAt),
      sourceCount: null,
      hasPracticeResult: false,
      needsRevision: false,
      alreadyMember: memberIds.has(c.id),
      openHref: `/capture/${c.id}`,
    });
  }
  for (const e of db.experiences) {
    if (q && !includesQuery(e.title, q) && !includesQuery(e.understanding, q)) continue;
    candidates.push({
      captureId: e.id,
      type: 'experience',
      title: e.title,
      summary: labelOf(e.understanding, 80),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      archived: Boolean(e.archivedAt),
      sourceCount: e.sources.length,
      hasPracticeResult: false,
      needsRevision: e.needsRevision,
      alreadyMember: memberIds.has(e.id),
      openHref: `/experience/${e.id}`,
    });
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  return ok({ query: q, total: candidates.length, limit: 40, nextCursor: null, candidates: candidates.slice(0, 40) });
});

route('POST', '/topics/:id/members', ({ params, body }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const captureIds = Array.isArray(body?.captureIds) ? body.captureIds.map(String) : [];
  const existing = new Set(db.topicMembers.filter((m) => m.topicId === topic.id).map((m) => m.captureId));
  let added = 0;
  let skipped = 0;
  for (const id of captureIds) {
    const exists = Boolean(captureOf(db, id)) || Boolean(experienceOf(db, id));
    if (!exists || existing.has(id)) {
      skipped += 1;
      continue;
    }
    db.topicMembers.push({ topicId: topic.id, captureId: id, addedAt: now() });
    existing.add(id);
    added += 1;
  }
  topic.updatedAt = now();
  topic.revision += 1;
  saveDb(db);
  return ok({ added, skipped, topic: topicView(db, topic) });
});

route('DELETE', '/topics/:id/members/:captureId', ({ params }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const before = db.topicMembers.length;
  db.topicMembers = db.topicMembers.filter(
    (m) => !(m.topicId === topic.id && m.captureId === params.captureId)
  );
  if (db.topicMembers.length === before) {
    return err(404, 'member_not_found', '这条记录已不在主题中');
  }
  let clearedNext = false;
  if (topic.nextAttemptId) {
    const fixed = attemptOf(db, topic.nextAttemptId);
    if (!fixed || fixed.captureId === params.captureId) {
      topic.nextAttemptId = null;
      topic.nextAttemptClearedReason = '成员已移出主题';
      clearedNext = true;
    }
  }
  topic.revision += 1;
  topic.updatedAt = now();
  saveDb(db);
  return ok({ removed: true, clearedNext, topic: topicView(db, topic) });
});

route('GET', '/topics/:id/attempts', ({ params, query }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const memberIds = new Set(
    db.topicMembers
      .filter((m) => m.topicId === topic.id)
      .map((m) => m.captureId)
      .filter((id) => Boolean(captureOf(db, id)))
  );
  const state = query.get('state') ?? query.get('attemptState');
  let rows = db.attempts.filter((a) => memberIds.has(a.captureId));
  if (state) rows = rows.filter((a) => a.state === state);
  rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const offset = Math.max(0, Number(query.get('offset')) || 0);
  const limit = parseLimit(query.get('limit'), 20, 100);
  const page = rows.slice(offset, offset + limit);
  const view = topicView(db, topic);
  return ok({
    attempts: page.map((a) => topicAttemptView(db, a)),
    total: rows.length,
    nextCursor: null,
    hasMore: offset + limit < rows.length,
    nextAttemptClearedReason: view.nextAttemptClearedReason,
    offset,
    limit,
  });
});

function setNextAttempt({ params, body }: Ctx): LocalResponse {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  if (body?.expectedRevision != null && Number(body.expectedRevision) !== topic.revision) {
    return err(409, 'revision_conflict', '主题刚被修改，请刷新后再保存');
  }
  const attemptId = body?.attemptId == null ? null : String(body.attemptId);
  if (attemptId) {
    const attempt = attemptOf(db, attemptId);
    if (!attempt) return err(400, 'attempt_not_available', '这个尝试不存在');
    const inTopic = db.topicMembers.some(
      (m) => m.topicId === topic.id && m.captureId === attempt.captureId
    );
    if (!inTopic) return err(400, 'member_not_in_topic', '这个尝试不属于主题成员');
    if (attempt.state === 'done' || attempt.state === 'cancelled') {
      return err(400, 'next_attempt_invalid', '已结束的尝试不能固定为下次继续');
    }
  }
  topic.nextAttemptId = attemptId;
  topic.nextAttemptClearedReason = null;
  topic.revision += 1;
  topic.updatedAt = now();
  saveDb(db);
  const view = topicView(db, topic);
  return ok({ topic: view, nextAttempt: view.nextAttempt, clearedReason: null });
}

route('PUT', '/topics/:id/next-attempt', setNextAttempt);
route('POST', '/topics/:id/next-attempt', setNextAttempt);

route('GET', '/captures/:captureId/topics', ({ params }) => {
  const db = loadDb();
  const topics = db.topicMembers
    .filter((m) => m.captureId === params.captureId)
    .map((m) => topicOf(db, m.topicId))
    .filter((t): t is TopicRow => Boolean(t))
    .map((t) => ({
      id: t.id,
      name: t.name,
      archived: Boolean(t.archivedAt),
      archivedAt: t.archivedAt,
      exploringQuestion: t.exploringQuestion,
    }));
  return ok({ captureId: params.captureId, topics });
});

route('POST', '/captures/:captureId/topics', ({ params, body }) => {
  const db = loadDb();
  if (!captureOf(db, params.captureId) && !experienceOf(db, params.captureId)) {
    return err(404, 'capture_not_found', '记录不存在或已删除');
  }
  const topicIds = Array.isArray(body?.topicIds) ? body.topicIds.map(String) : [];
  let added = 0;
  let skipped = 0;
  for (const id of topicIds) {
    const topic = topicOf(db, id);
    if (!topic) {
      skipped += 1;
      continue;
    }
    const exists = db.topicMembers.some(
      (m) => m.topicId === id && m.captureId === params.captureId
    );
    if (exists) {
      skipped += 1;
      continue;
    }
    db.topicMembers.push({ topicId: id, captureId: params.captureId, addedAt: now() });
    topic.updatedAt = now();
    topic.revision += 1;
    added += 1;
  }
  saveDb(db);
  return ok({ added, skipped });
});

route('GET', '/topics/:id/ask-candidates', ({ params, query }) => {
  const db = loadDb();
  const topic = topicOf(db, params.id);
  if (!topic) return err(404, 'topic_not_found', '主题不存在或已删除');
  const memberIds = new Set(
    db.topicMembers
      .filter((m) => m.topicId === topic.id)
      .map((m) => m.captureId)
      .filter((id) => Boolean(captureOf(db, id)))
  );
  const question = (query.get('question') ?? '').trim();
  const keywords = (query.get('keywords') ?? '')
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const limit = parseLimit(query.get('limit'), 20, 50);
  const search = askSearchResponse(db, {
    question,
    keywords,
    limit,
    from: asTimestamp(query.get('from')),
    to: asTimestamp(query.get('to')),
    captureIdFilter: memberIds,
  });
  const view = topicView(db, topic);
  return ok({
    ...search,
    topic: { id: topic.id, name: topic.name },
    scope: {
      topicId: topic.id,
      topicName: topic.name,
      allowedSourceCount: view.recordCount,
      thoughtCount: view.thoughtCount,
      attemptCount: view.attemptCount,
      experienceCount: view.experienceCount,
      recordCount: view.recordCount,
    },
  });
});

route('GET', '/topics/:id/ask-experiences', ({ params }) => {
  return ok(topicAskExperiences(loadDb(), params.id));
});

route('POST', '/topics/:id/export/preview', () =>
  err(400, 'export_unavailable', '线上体验版暂不支持 ZIP 导出，请在本地版使用。')
);

route('POST', '/topics/:id/export', () =>
  err(400, 'export_unavailable', '线上体验版暂不支持 ZIP 导出，请在本地版使用。')
);

// ---------- 日程 ----------

function zoneOffsetMs(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - ts;
}

function zonedToUtc(date: string, time: string, timezone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
  const offset = zoneOffsetMs(guess, timezone);
  let ts = guess - offset;
  const second = zoneOffsetMs(ts, timezone);
  if (second !== offset) ts = guess - second;
  return ts;
}

route('GET', '/schedules', ({ query }) => {
  const db = loadDb();
  const timezone = query.get('timezone') || 'Asia/Shanghai';
  const fromAt = asTimestamp(query.get('from'));
  const toAt = asTimestamp(query.get('to'));
  if (fromAt == null || toAt == null) return err(400, 'invalid_range', '日期范围无效');
  const rows = db.schedules
    .filter((s) => s.startsAt < toAt && s.endsAt > fromAt)
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((s) => scheduleView(db, s));
  return ok({
    range: {
      from: localDateInZone(fromAt, timezone),
      to: localDateInZone(toAt, timezone),
      timezone,
      fromAt,
      toAt,
      fromIso: new Date(fromAt).toISOString(),
      toIso: new Date(toAt).toISOString(),
    },
    schedules: rows,
    generatedAt: now(),
  });
});

route('GET', '/attempts/:attemptId/schedules', ({ params }) => {
  const db = loadDb();
  if (!attemptOf(db, params.attemptId)) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const rows = db.schedules
    .filter((s) => s.attemptId === params.attemptId)
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((s) => scheduleView(db, s));
  return ok({ schedules: rows, serverNow: now() });
});

function scheduleTimestamps(body: any): { startsAt: number; endsAt: number } {
  const timezone = String(body?.timezone || 'Asia/Shanghai');
  const startsAt = zonedToUtc(String(body?.date ?? ''), String(body?.startTime ?? ''), timezone);
  const endDate = body?.endDate ? String(body.endDate) : String(body?.date ?? '');
  const endsAt = zonedToUtc(endDate, String(body?.endTime ?? ''), timezone);
  return { startsAt, endsAt };
}

route('POST', '/attempts/:attemptId/schedules', ({ params, body }) => {
  const db = loadDb();
  const attempt = attemptOf(db, params.attemptId);
  if (!attempt) return err(404, 'attempt_not_found', '这次尝试不存在或已删除');
  const replay = replayOperation<any>(db, body?.operationId);
  if (replay) return ok({ ...replay, replayed: true });
  const { startsAt, endsAt } = scheduleTimestamps(body);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return err(400, 'invalid_schedule', '结束时间需要晚于开始时间');
  }
  if ((endsAt - startsAt) / 86400000 > 7) {
    return err(400, 'invalid_schedule', '单次安排最长 7 天');
  }
  const overlaps = db.schedules.filter(
    (s) => s.status === 'active' && s.startsAt < endsAt && s.endsAt > startsAt
  );
  if (overlaps.length && !body?.confirmOverlap) {
    return {
      status: 409,
      body: {
        error: 'schedule_conflict',
        message: '这个时间段已有安排',
        conflicts: overlaps.map((s) => scheduleView(db, s)),
        conflictToken: uid(),
        requiresConfirmation: true,
      },
    };
  }
  const t = now();
  const row: ScheduleRow = {
    id: uid(),
    attemptId: attempt.id,
    startsAt,
    endsAt,
    timezone: String(body?.timezone || 'Asia/Shanghai'),
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null,
    status: 'active',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    cancelledAt: null,
  };
  db.schedules.push(row);
  const result = { schedule: scheduleView(db, row) };
  rememberOperation(db, body?.operationId, result);
  saveDb(db);
  return ok(result);
});

route('PATCH', '/schedules/:id', ({ params, body }) => {
  const db = loadDb();
  const row = scheduleOf(db, params.id);
  if (!row) return err(404, 'schedule_not_found', '这条安排已不存在');
  if (Number(body?.revision) !== row.revision) {
    return err(409, 'revision_conflict', '这条安排刚被修改，请刷新后再保存');
  }
  const { startsAt, endsAt } = scheduleTimestamps(body);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    return err(400, 'invalid_schedule', '结束时间需要晚于开始时间');
  }
  row.startsAt = startsAt;
  row.endsAt = endsAt;
  row.timezone = String(body?.timezone || row.timezone);
  row.note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null;
  row.status = 'active';
  row.cancelledAt = null;
  row.revision += 1;
  row.updatedAt = now();
  saveDb(db);
  return ok({ schedule: scheduleView(db, row) });
});

route('POST', '/schedules/:id/cancel', ({ params, body }) => {
  const db = loadDb();
  const row = scheduleOf(db, params.id);
  if (!row) return err(404, 'schedule_not_found', '这条安排已不存在');
  if (Number(body?.revision) !== row.revision) {
    return err(409, 'revision_conflict', '这条安排刚被修改，请刷新后再保存');
  }
  row.status = 'cancelled';
  row.cancelledAt = now();
  row.updatedAt = row.cancelledAt;
  row.revision += 1;
  saveDb(db);
  return ok({ schedule: scheduleView(db, row) });
});

// ---------- 阶段回顾 ----------

function reviewInput(query: URLSearchParams, body?: any) {
  const raw = body ?? {};
  const from = asTimestamp(raw.from ?? query.get('from'));
  const to = asTimestamp(raw.to ?? query.get('to'));
  const timezone = String(raw.timezone ?? query.get('timezone') ?? 'Asia/Shanghai');
  const presetRaw = String(raw.preset ?? query.get('preset') ?? '30d');
  const preset = presetRaw === '7d' || presetRaw === 'custom' ? presetRaw : '30d';
  return { from, to, timezone, preset: preset as '7d' | '30d' | 'custom' };
}

route('GET', '/review/range', ({ query }) => {
  const input = reviewInput(query);
  if (input.from == null || input.to == null) return err(400, 'invalid_range', '日期范围无效');
  if (input.to <= input.from) return err(400, 'invalid_range', '结束日期需要晚于开始日期');
  if ((input.to - input.from) / 86400000 > 366) {
    return err(400, 'range_too_large', '单次回顾范围最多 366 天');
  }
  return ok(reviewRangeData(loadDb(), { ...input, from: input.from, to: input.to }));
});

route('GET', '/review/daily', ({ query }) => {
  const input = reviewInput(query);
  if (input.from == null || input.to == null) return err(400, 'invalid_range', '日期范围无效');
  if (input.to <= input.from) return err(400, 'invalid_range', '结束日期需要晚于开始日期');
  return ok(reviewDailyData(loadDb(), { ...input, from: input.from, to: input.to }));
});

route('POST', '/review/preview', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('POST', '/reviews', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('GET', '/reviews', () => ok({ total: 0, reviews: [] }));
route('GET', '/reviews/:id', () => err(404, 'review_not_found', '这次回顾不存在或已删除'));
route('POST', '/reviews/:id/save', () => err(404, 'review_not_found', '这次回顾不存在或已删除'));
route('POST', '/reviews/:id/cancel', () => err(404, 'review_not_found', '这次回顾不存在或已删除'));

// ---------- 下一步行动 ----------

route('GET', '/next-actions/:id', () => err(404, 'next_action_not_found', '这条下一步行动已不存在'));
route('PATCH', '/next-actions/:id', () => err(404, 'next_action_not_found', '这条下一步行动已不存在'));
route('GET', '/reviews/:id/next-actions', () => ok({ actions: [] }));
route('GET', '/captures/:id/next-actions', () => ok({ actions: [] }));
route('GET', '/reviews/:id/next-action/preview', () => err(404, 'next_action_not_found', '这次回顾没有可用的下一步行动'));
route('POST', '/reviews/:id/next-actions', () => err(400, 'ai_not_configured', AI_OFFLINE));

// ---------- 动态 ----------

route('GET', '/activity', ({ query }) => {
  const db = loadDb();
  return ok(
    activityView(db, {
      type: query.get('type') ?? 'all',
      limit: parseLimit(query.get('limit'), 60, 200),
    })
  );
});

// ---------- 问我的记录 ----------

route('GET', '/ask/candidates', ({ query }) => {
  const db = loadDb();
  const question = (query.get('question') ?? '').trim();
  const keywordText = [query.get('keywords') ?? '', ...query.getAll('expanded')].join(' ');
  const keywords = keywordText
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return ok(
    askSearchResponse(db, {
      question,
      keywords,
      limit: parseLimit(query.get('limit'), 20, 50),
      from: asTimestamp(query.get('from')),
      to: asTimestamp(query.get('to')),
    })
  );
});

route('POST', '/ask/keyword-suggestions', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('POST', '/ask/preview', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('POST', '/ask/queries', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('GET', '/ask/queries', () => ok({ queries: [] }));
route('GET', '/ask/queries/:id', () => err(404, 'query_not_found', '这次提问不存在'));
route('POST', '/ask/queries/:id/cancel', () => err(404, 'query_not_found', '这次提问不存在'));
route('GET', '/ask/queries/:id/experience-draft', () => err(404, 'ask_not_found', '这次问答已不存在'));

// ---------- AI 设置与生成 ----------

route('GET', '/settings/ai', () =>
  ok({
    configured: false,
    config: null,
    masterKey: { path: '浏览器本机存储', exists: true },
    limits: { maxCaptureChars: 4000, maxConstraintChars: 500, timeoutMs: 60000 },
  })
);
route('GET', '/settings/ai/models', () =>
  ok({
    configured: false,
    enabled: false,
    configName: null,
    baseUrl: null,
    currentModelId: null,
    models: [],
    fetched: false,
    note: AI_OFFLINE,
  })
);
route('POST', '/settings/ai', () => err(400, 'ai_unsupported', AI_OFFLINE));
route('DELETE', '/settings/ai', () => ok({ ok: true }));
route('POST', '/settings/ai/test', () => err(400, 'ai_unsupported', AI_OFFLINE));
route('POST', '/ai/assist-capture', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('POST', '/ai/assist-capture/stream', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('POST', '/captures/:id/suggestions', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('GET', '/captures/:id/suggestions/latest', () => ok({ generation: null }));
route('POST', '/captures/:id/experience/preview', () => err(400, 'ai_not_configured', AI_OFFLINE));
route('GET', '/generations/:id', () => err(404, 'generation_not_found', '这条建议不存在'));
route('POST', '/generations/:id/cancel', () => err(404, 'generation_not_found', '这条建议不存在'));
route('POST', '/generations/:id/dismiss', () => err(404, 'generation_not_found', '这条建议不存在'));
route('POST', '/generations/:id/accept', () => err(404, 'generation_not_found', '这条建议不存在'));

// ---------- GitHub 调研 ----------

const githubSettings = {
  configured: false,
  hasToken: false,
  tokenFingerprint: null,
  updatedAt: null,
  apiBase: 'https://api.github.com',
  note: RESEARCH_OFFLINE,
};
route('GET', '/settings/github', () => ok(githubSettings));
route('PUT', '/settings/github', () => err(400, 'github_unsupported', RESEARCH_OFFLINE));
route('DELETE', '/settings/github', () => ok({ ok: true, configured: false, hasToken: false }));
route('POST', '/settings/github/test', () => err(400, 'github_unsupported', RESEARCH_OFFLINE));
route('GET', '/research', () => ok({ research: [] }));
route('GET', '/captures/:id/research', () =>
  ok({ captureId: '', count: { total: 0, active: 0 }, research: [] })
);
route('POST', '/captures/:id/research/preview', () => err(400, 'github_unsupported', RESEARCH_OFFLINE));
route('POST', '/captures/:id/research', () => err(400, 'github_unsupported', RESEARCH_OFFLINE));
route('GET', '/research/:id', () => err(404, 'research_not_found', '这次研究不存在'));
route('POST', '/research/:id/select', () => err(404, 'research_not_found', '这次研究不存在'));
route('POST', '/research/:id/retry', () => err(404, 'research_not_found', '这次研究不存在'));
route('POST', '/research/:id/cancel', () => err(404, 'research_not_found', '这次研究不存在'));
route('POST', '/research/:id/save', () => err(404, 'research_not_found', '这次研究不存在'));
route('DELETE', '/research/:id', () => err(404, 'research_not_found', '这次研究不存在'));
route('POST', '/research/:id/experiments/:index/accept', () => err(404, 'research_not_found', '这次研究不存在'));
route('GET', '/attempts/:id/research', () => ok({ research: null }));

// ---------- 入口 ----------

export function handleLocalRequest(method: string, pathWithQuery: string, body: any): LocalResponse {
  const [rawPath, rawQuery = ''] = pathWithQuery.split('?');
  const path = rawPath.replace(/^\/api/, '') || '/';
  const query = new URLSearchParams(rawQuery);
  const upper = method.toUpperCase();
  for (const r of routes) {
    if (r.method !== upper) continue;
    const match = r.regex.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(match[i + 1]);
    });
    try {
      return r.handler({ params, query, body });
    } catch (error) {
      return err(
        500,
        'local_storage_failed',
        error instanceof Error ? error.message : '本地数据处理失败'
      );
    }
  }
  return err(404, 'not_found', `本地体验版没有这个接口：${upper} ${path}`);
}