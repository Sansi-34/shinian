// 拾念 SHINIAN · 知识网络投影
// 只读聚合 captures / attempts / attempt_references / capture_links / research …
// 节点 ID 使用类型前缀的稳定业务 ID（capture:xxx / attempt:xxx），可写入 URL 并在刷新后恢复。
import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/db';

type GraphNodeType = 'capture' | 'experience' | 'attempt' | 'research' | 'review' | 'schedule';
type GraphLinkType =
  | 'contains'
  | 'references'
  | 'related'
  | 'researches'
  | 'adopted'
  | 'scheduled'
  | 'reviews'
  | 'evidence'
  | 'used'
  | 'context';

type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  detail: string;
  createdAt: number;
  state: string | null;
  archived: boolean;
  href: string;
  degree: number;
  /** 以下字段用于详情与搜索，列表展示不必全部使用 */
  captureId?: string | null;
  captureLabel?: string | null;
  resultText?: string | null;
  observedAt?: number | null;
  outcome?: string | null;
  sourceUrl?: string | null;
  origin?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
};

type GraphLink = {
  id: string;
  source: string;
  target: string;
  type: GraphLinkType;
  label: string;
};

type GraphMeta = {
  scope: 'global' | 'local';
  limit: number | null;
  totalCaptures: number;
  shownCaptures: number;
  totalExperiences: number;
  shownExperiences: number;
  truncated: boolean;
  focus: string | null;
  depth: 1 | 2 | null;
};

type GraphData = {
  stats: {
    captures: number;
    experiences: number;
    attempts: number;
    research: number;
    reviews: number;
    schedules: number;
    links: number;
    manualLinks: number;
  };
  nodes: GraphNode[];
  links: GraphLink[];
  meta: GraphMeta;
};

type CaptureRow = {
  id: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  kind: string;
  experienceTitle: string | null;
};

type AttemptRow = {
  id: string;
  captureId: string;
  step: string;
  state: string;
  outcome: string | null;
  resultText: string | null;
  observedAt: number | null;
  sourceUrl: string | null;
  origin: string;
  actionDescription: string | null;
  createdAt: number;
  updatedAt: number;
  sourceResearchId: string | null;
};

type ResearchRow = {
  id: string;
  captureId: string;
  question: string;
  status: string;
  savedAt: number | null;
  createdAt: number;
  resultJson: string | null;
};

type ReviewRow = {
  id: string;
  status: string;
  rangeFrom: number;
  rangeTo: number;
  savedAt: number | null;
  createdAt: number;
  sourcesJson: string | null;
  contentJson: string | null;
  contentInvalidatedAt: number | null;
  contentInvalidReason: string | null;
};

type ScheduleRow = {
  id: string;
  attemptId: string;
  startsAt: number;
  endsAt: number;
  status: string;
  note: string | null;
};

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function short(text: string, max = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 图上的念头标签取第一句/冒号前的主语，避免把整段正文挤到节点下面。 */
function labelOf(text: string, max = 26): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const first = clean.split(/[：:。\n]/)[0]?.trim() || clean;
  return short(first, max);
}

function parseJson(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function snippetOf(text: string, term: string, max = 90): string {
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return text.slice(0, max);
  const start = Math.max(0, idx - 24);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + max) +
    (start + max < text.length ? '…' : '')
  );
}

function boolArchived(query: { archived?: string }): boolean {
  return query.archived === '1' || query.archived === 'true';
}

function emptyMeta(scope: 'global' | 'local', limit: number | null): GraphMeta {
  return {
    scope,
    limit,
    totalCaptures: 0,
    shownCaptures: 0,
    totalExperiences: 0,
    shownExperiences: 0,
    truncated: false,
    focus: null,
    depth: null,
  };
}

function buildGraph(includeArchived: boolean, captureLimit: number | null): GraphData {
  const archivedWhere = includeArchived ? '' : 'WHERE archived_at IS NULL';
  const thoughtWhere = includeArchived
    ? "WHERE kind = 'thought'"
    : "WHERE kind = 'thought' AND archived_at IS NULL";
  const totalCaptures = (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM captures ${thoughtWhere}`).get() as { n: number }
  ).n;
  const totalExperiences = (
    sqlite
      .prepare(
        includeArchived
          ? "SELECT COUNT(*) AS n FROM captures WHERE kind = 'experience'"
          : "SELECT COUNT(*) AS n FROM captures WHERE kind = 'experience' AND archived_at IS NULL"
      )
      .get() as { n: number }
  ).n;
  const captureSql = `SELECT c.id, c.raw_text AS rawText, c.revision, c.created_at AS createdAt,
                c.updated_at AS updatedAt, c.archived_at AS archivedAt, c.kind,
                (SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id) AS experienceTitle
           FROM captures c
          ${archivedWhere}
          ORDER BY c.created_at DESC, c.id DESC`;
  const captures = (
    captureLimit == null
      ? sqlite.prepare(captureSql).all()
      : sqlite.prepare(`${captureSql}\n LIMIT ?`).all(captureLimit)
  ) as CaptureRow[];
  const captureIds = new Set(captures.map((c) => c.id));
  const thoughtIds = new Set(captures.filter((c) => c.kind !== 'experience').map((c) => c.id));
  const nodeIdByCapture = new Map(
    captures.map((c) => [c.id, c.kind === 'experience' ? `experience:${c.id}` : `capture:${c.id}`])
  );
  if (captureIds.size === 0) {
    return {
      stats: {
        captures: 0,
        experiences: 0,
        attempts: 0,
        research: 0,
        reviews: 0,
        schedules: 0,
        links: 0,
        manualLinks: 0,
      },
      nodes: [],
      links: [],
      meta: {
        ...emptyMeta('global', captureLimit),
        totalCaptures,
        totalExperiences,
        shownCaptures: 0,
        shownExperiences: 0,
        truncated: totalCaptures > 0 || totalExperiences > 0,
      },
    };
  }
  const captureLabelById = new Map(
    captures.map((c) => [
      c.id,
      labelOf(c.kind === 'experience' ? c.experienceTitle ?? c.rawText : c.rawText, 28),
    ])
  );
  const captureArchivedById = new Map(captures.map((c) => [c.id, Boolean(c.archivedAt)]));

  const attempts = (
    sqlite
      .prepare(
        `SELECT id, capture_id AS captureId, step, state, outcome, result_text AS resultText,
                observed_at AS observedAt, source_url AS sourceUrl, origin,
                action_description AS actionDescription,
                created_at AS createdAt, updated_at AS updatedAt,
                source_research_id AS sourceResearchId
           FROM attempts
          ORDER BY created_at DESC, id DESC`
      )
      .all() as AttemptRow[]
  ).filter((a) => thoughtIds.has(a.captureId));
  const attemptIds = new Set(attempts.map((a) => a.id));

  const research = (
    sqlite
      .prepare(
        `SELECT id, capture_id AS captureId, question, status, saved_at AS savedAt,
                created_at AS createdAt, result_json AS resultJson
           FROM research_runs
          ORDER BY created_at DESC, id DESC`
      )
      .all() as ResearchRow[]
  ).filter((r) => thoughtIds.has(r.captureId));
  const researchIds = new Set(research.map((r) => r.id));

  const reviews = sqlite
    .prepare(
      `SELECT id, status, range_from AS rangeFrom, range_to AS rangeTo, saved_at AS savedAt,
              created_at AS createdAt, sources_json AS sourcesJson, content_json AS contentJson,
              content_invalidated_at AS contentInvalidatedAt,
              content_invalid_reason AS contentInvalidReason
         FROM stage_reviews
        WHERE sources_json IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .all(captureLimit == null ? 2000 : Math.max(120, captureLimit)) as ReviewRow[];

  const schedules = (
    sqlite
      .prepare(
        `SELECT id, attempt_id AS attemptId, starts_at AS startsAt, ends_at AS endsAt,
                status, note
           FROM schedule_blocks
          WHERE status = 'active'
          ORDER BY starts_at ASC, id ASC`
      )
      .all() as ScheduleRow[]
  ).filter((s) => attemptIds.has(s.attemptId));

  const nodes: GraphNode[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const addNode = (node: Omit<GraphNode, 'degree'>) => {
    const full = { ...node, degree: 0 };
    nodes.push(full);
    nodeMap.set(full.id, full);
    return full;
  };

  for (const c of captures) {
    if (c.kind === 'experience') continue;
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

  // 经验是用户整理的理解：小节点、低饱和色，默认不抢过原始念头。
  for (const c of captures) {
    if (c.kind !== 'experience') continue;
    addNode({
      id: `experience:${c.id}`,
      type: 'experience',
      label: labelOf(c.experienceTitle ?? c.rawText, 28),
      detail: c.rawText || '这份经验的正文已清空，待重新整理。',
      createdAt: c.createdAt,
      state: null,
      archived: Boolean(c.archivedAt),
      href: `/experience/${c.id}`,
      captureId: c.id,
      captureLabel: labelOf(c.experienceTitle ?? c.rawText, 28),
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
      archived: captureArchivedById.get(a.captureId) ?? false,
      href: `/attempt/${a.id}`,
      captureId: a.captureId,
      captureLabel: captureLabelById.get(a.captureId) ?? null,
      resultText: a.resultText,
      observedAt: a.observedAt,
      outcome: a.outcome,
      sourceUrl: a.sourceUrl,
      origin: a.origin,
    });
  }

  for (const r of research) {
    const parsed = parseJson(r.resultJson);
    addNode({
      id: `research:${r.id}`,
      type: 'research',
      label: short(r.question, 34),
      detail: parsed?.summary || r.question,
      createdAt: r.createdAt,
      state: r.status,
      archived: captureArchivedById.get(r.captureId) ?? false,
      href: `/research/${r.id}`,
      captureId: r.captureId,
      captureLabel: captureLabelById.get(r.captureId) ?? null,
      origin: null,
    });
  }

  for (const rv of reviews) {
    const invalidated = rv.contentInvalidatedAt !== null;
    const parsed = invalidated ? null : parseJson(rv.contentJson);
    addNode({
      id: `review:${rv.id}`,
      type: 'review',
      label: short(invalidated ? '内容已撤下的阶段回顾' : parsed?.overview || '阶段回顾', 30),
      detail: invalidated
        ? rv.contentInvalidReason || '来源记录已删除，生成正文已撤下。'
        : parsed?.overview || '一段时间的真实记录与回顾',
      createdAt: rv.savedAt ?? rv.createdAt,
      state: rv.status,
      archived: false,
      href: `/review/${rv.id}`,
      captureId: null,
      captureLabel: null,
      origin: invalidated ? 'content_withheld' : null,
    });
  }

  for (const s of schedules) {
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
      href: `/schedule`,
      captureId: null,
      captureLabel: null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      origin: null,
    });
  }

  const links: GraphLink[] = [];
  const linkKeys = new Set<string>();
  const addLink = (source: string, target: string, type: GraphLinkType, label: string) => {
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    const key = `${type}|${source}|${target}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ id: `edge:${key}`, source, target, type, label });
    nodeMap.get(source)!.degree += 1;
    nodeMap.get(target)!.degree += 1;
  };

  for (const a of attempts) addLink(`capture:${a.captureId}`, `attempt:${a.id}`, 'contains', '包含尝试');
  for (const r of research) addLink(`capture:${r.captureId}`, `research:${r.id}`, 'researches', '发起研究');

  const refs = sqlite
    .prepare(
      'SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId FROM attempt_references'
    )
    .all() as Array<{ id: string; fromAttemptId: string; toAttemptId: string }>;
  for (const ref of refs) {
    addLink(
      `attempt:${ref.fromAttemptId}`,
      `attempt:${ref.toAttemptId}`,
      'references',
      '引用了旧结果'
    );
  }

  const manualLinks = sqlite
    .prepare(
      `SELECT id, from_capture_id AS fromCaptureId, to_capture_id AS toCaptureId, note
         FROM capture_links`
    )
    .all() as Array<{
    id: string;
    fromCaptureId: string;
    toCaptureId: string;
    note: string | null;
  }>;
  for (const link of manualLinks) {
    const fromNode = nodeIdByCapture.get(link.fromCaptureId);
    const toNode = nodeIdByCapture.get(link.toCaptureId);
    if (!fromNode || !toNode) continue;
    addLink(fromNode, toNode, 'related', '手动关联');
  }

  // 经验关系：依据（原始记录）、被尝试引用、所属念头。三者含义不同，不能混成「证据」。
  const experienceSourceRows = sqlite
    .prepare(
      `SELECT experience_id AS experienceId, source_type AS sourceType, source_id AS sourceId
         FROM experience_sources WHERE deleted = 0`
    )
    .all() as Array<{ experienceId: string; sourceType: string; sourceId: string }>;
  for (const row of experienceSourceRows) {
    const target =
      row.sourceType === 'attempt' ? `attempt:${row.sourceId}` : nodeIdByCapture.get(row.sourceId);
    if (target) addLink(`experience:${row.experienceId}`, target, 'evidence', '依据这条记录');
  }
  const experienceAttemptRows = sqlite
    .prepare(
      `SELECT attempt_id AS attemptId, experience_capture_id AS experienceId
         FROM experience_attempts WHERE deleted = 0`
    )
    .all() as Array<{ attemptId: string; experienceId: string }>;
  for (const row of experienceAttemptRows) {
    addLink(`attempt:${row.attemptId}`, `experience:${row.experienceId}`, 'used', '参考这条经验再试');
  }
  const experienceContextRows = sqlite
    .prepare(
      `SELECT capture_id AS experienceId, context_capture_id AS contextCaptureId
         FROM experience_notes WHERE context_capture_id IS NOT NULL`
    )
    .all() as Array<{ experienceId: string; contextCaptureId: string }>;
  for (const row of experienceContextRows) {
    const contextNode = nodeIdByCapture.get(row.contextCaptureId);
    if (contextNode) addLink(contextNode, `experience:${row.experienceId}`, 'context', '所属念头');
  }

  for (const a of attempts) {
    if (a.sourceResearchId && researchIds.has(a.sourceResearchId)) {
      addLink(`research:${a.sourceResearchId}`, `attempt:${a.id}`, 'adopted', '从研究采用为尝试');
    }
  }
  for (const s of schedules) addLink(`attempt:${s.attemptId}`, `schedule:${s.id}`, 'scheduled', '安排时间');

  for (const rv of reviews) {
    const sources = parseJson(rv.sourcesJson);
    if (!Array.isArray(sources)) continue;
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      const type = typeof src.type === 'string' ? src.type : '';
      const sourceId = typeof src.sourceId === 'string' ? src.sourceId : '';
      if (type === 'capture' && nodeMap.has(`capture:${sourceId}`)) {
        addLink(`review:${rv.id}`, `capture:${sourceId}`, 'reviews', '回顾念头');
      } else if (type === 'attempt' && nodeMap.has(`attempt:${sourceId}`)) {
        addLink(`review:${rv.id}`, `attempt:${sourceId}`, 'reviews', '回顾尝试');
      } else if (type === 'reference' && src.fromAttemptId && src.toAttemptId) {
        addLink(`review:${rv.id}`, `attempt:${src.fromAttemptId}`, 'reviews', '回顾引用');
      }
    }
  }

  return {
    stats: {
      captures: captures.filter((c) => c.kind !== 'experience').length,
      experiences: captures.filter((c) => c.kind === 'experience').length,
      attempts: attempts.length,
      research: research.length,
      reviews: reviews.length,
      schedules: schedules.length,
      links: links.length,
      manualLinks: manualLinks.filter((l) => {
        const fromNode = nodeIdByCapture.get(l.fromCaptureId);
        const toNode = nodeIdByCapture.get(l.toCaptureId);
        return Boolean(fromNode && toNode && nodeMap.has(fromNode) && nodeMap.has(toNode));
      }).length,
    },
    nodes,
    links,
    meta: {
      scope: 'global',
      limit: captureLimit,
      totalCaptures,
      shownCaptures: captures.filter((c) => c.kind !== 'experience').length,
      totalExperiences,
      shownExperiences: captures.filter((c) => c.kind === 'experience').length,
      truncated: totalCaptures + totalExperiences > captures.length,
      focus: null,
      depth: null,
    },
  };
}

/** 以某个稳定节点 ID 为中心，取一跳或两跳子图；局部图始终从完整数据读取，不受全局展示上限影响。 */
function localGraph(all: GraphData, nodeId: string, depth: 1 | 2): GraphData | null {
  const center = all.nodes.find((n) => n.id === nodeId);
  if (!center) return null;
  const adjacency = new Map<string, Set<string>>();
  for (const n of all.nodes) adjacency.set(n.id, new Set());
  for (const link of all.links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }
  const keep = new Set<string>([nodeId]);
  let frontier = [nodeId];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (keep.has(neighbor)) continue;
        keep.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }
  const nodes = all.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, degree: 0 }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const links = all.links.filter((l) => nodeById.has(l.source) && nodeById.has(l.target));
  for (const l of links) {
    nodeById.get(l.source)!.degree += 1;
    nodeById.get(l.target)!.degree += 1;
  }
  return {
    stats: {
      captures: nodes.filter((n) => n.type === 'capture').length,
      experiences: nodes.filter((n) => n.type === 'experience').length,
      attempts: nodes.filter((n) => n.type === 'attempt').length,
      research: nodes.filter((n) => n.type === 'research').length,
      reviews: nodes.filter((n) => n.type === 'review').length,
      schedules: nodes.filter((n) => n.type === 'schedule').length,
      links: links.length,
      manualLinks: links.filter((l) => l.type === 'related').length,
    },
    nodes,
    links,
    meta: {
      scope: 'local',
      limit: null,
      totalCaptures: all.meta.totalCaptures,
      shownCaptures: nodes.filter((n) => n.type === 'capture').length,
      totalExperiences: all.meta.totalExperiences,
      shownExperiences: nodes.filter((n) => n.type === 'experience').length,
      truncated: false,
      focus: nodeId,
      depth,
    },
  };
}

export function registerGraphRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/graph', { preHandler: requireAuth }, async (req) => {
    const query = req.query as { archived?: string; limit?: string };
    const includeArchived = boolArchived(query);
    const limit = Math.max(20, Math.min(600, Number.parseInt(query.limit ?? '240', 10) || 240));
    return buildGraph(includeArchived, limit);
  });

  fastify.get('/api/graph/search', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as { q?: string; archived?: string; types?: string; limit?: string };
    const term = (query.q ?? '').trim();
    if (term.length < 1) return reply.code(400).send({ error: 'q_required' });
    if (term.length > 120) return reply.code(400).send({ error: 'query_too_long' });
    const allowedTypes = new Set<GraphNodeType>([
      'capture',
      'experience',
      'attempt',
      'research',
      'review',
      'schedule',
    ]);
    const requested = (query.types ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is GraphNodeType => allowedTypes.has(t as GraphNodeType));
    const typeFilter = requested.length ? new Set<GraphNodeType>(requested) : allowedTypes;
    const limit = Math.max(1, Math.min(50, Number.parseInt(query.limit ?? '30', 10) || 30));
    const includeArchived = boolArchived(query);
    const graph = buildGraph(includeArchived, null);
    const needle = term.toLowerCase();
    const captureNodeById = new Map(
      graph.nodes.filter((n) => n.type === 'capture').map((n) => [n.captureId, n])
    );

    const matchField = (node: GraphNode): string | null => {
      if (node.type === 'capture') {
        return node.detail.toLowerCase().includes(needle) ? 'capture.rawText' : null;
      }
      if (node.type === 'experience') {
        if (node.label.toLowerCase().includes(needle)) return 'experience.title';
        return node.detail.toLowerCase().includes(needle) ? 'experience.understanding' : null;
      }
      if (node.type === 'attempt') {
        if (node.detail.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)) {
          return 'attempt.step';
        }
        if (node.resultText?.toLowerCase().includes(needle)) return 'attempt.resultText';
        return null;
      }
      if (node.type === 'research') {
        return node.detail.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)
          ? 'research.question'
          : null;
      }
      if (node.type === 'review') {
        return node.detail.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)
          ? 'review.content'
          : null;
      }
      return node.detail.toLowerCase().includes(needle) ? 'schedule.note' : null;
    };

    const typeRank: Record<GraphNodeType, number> = {
      capture: 0,
      experience: 1,
      attempt: 2,
      research: 3,
      review: 4,
      schedule: 5,
    };
    const matches = graph.nodes
      .filter((n) => typeFilter.has(n.type))
      .map((node) => {
        const field = matchField(node);
        if (!field) return null;
        const capture = node.captureId ? captureNodeById.get(node.captureId) : null;
        const raw =
          field === 'attempt.resultText' ? node.resultText ?? node.detail : node.detail;
        return {
          node,
          captureId: node.captureId ?? null,
          captureLabel: node.captureLabel ?? capture?.label ?? null,
          matchField: field,
          snippet: snippetOf(raw, term),
          archived: node.archived,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => {
        const rank = typeRank[a.node.type] - typeRank[b.node.type];
        if (rank !== 0) return rank;
        return b.node.createdAt - a.node.createdAt;
      });
    const results = matches.slice(0, limit);

    return {
      query: term,
      archived: includeArchived,
      types: Array.from(typeFilter),
      total: matches.length,
      results,
    };
  });

  fastify.get('/api/graph/focus', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as { node?: string; archived?: string; depth?: string };
    const nodeId = (query.node ?? '').trim();
    if (!nodeId || !/^[a-z]+:[a-zA-Z0-9_-]+$/.test(nodeId)) {
      return reply.code(400).send({ error: 'node_required' });
    }
    const includeArchived = boolArchived(query);
    const depth = query.depth === '2' ? 2 : 1;
    const all = buildGraph(includeArchived, null);
    const local = localGraph(all, nodeId, depth);
    if (!local) {
      return reply.code(404).send({ error: 'node_not_found' });
    }
    return local;
  });
}
