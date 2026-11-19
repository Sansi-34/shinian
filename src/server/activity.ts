import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/db';

/**
 * 事件展示栏：从现有业务表派生最近动态，不新增事件表，也不复制用户正文。
 * 事件只在读取时聚合；删除念头/尝试后，对应事件自然消失。
 */

export type ActivityEventType = 'capture' | 'attempt' | 'result' | 'reference' | 'ai';

export type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  action: string;
  at: number;
  title: string;
  text: string;
  detail: string | null;
  captureId: string;
  attemptId: string | null;
  outcome: string | null;
  kind: string | null;
};

type CaptureRow = {
  id: string;
  raw_text: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type AttemptRow = {
  id: string;
  capture_id: string;
  step: string;
  state: string;
  result_text: string | null;
  outcome: string | null;
  observed_at: number | null;
  created_at: number;
  updated_at: number;
  origin: string;
};

type NextActionScheduleRow = {
  id: string;
  attempt_id: string;
  starts_at: number;
  ends_at: number;
  timezone: string;
  created_at: number;
  step: string;
  capture_id: string;
};

type ReferenceRow = {
  id: string;
  from_attempt_id: string;
  to_attempt_id: string;
  note: string | null;
  created_at: number;
  from_step: string | null;
  to_step: string | null;
};

type GenerationRow = {
  id: string;
  capture_id: string;
  status: string;
  kind: string | null;
  suggestion_json: string | null;
  error_detail: string | null;
  config_name: string;
  model_id: string;
  adopted_attempt_id: string | null;
  adopted_at: number | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

const FILTERS: Array<{ type: 'all' | ActivityEventType; label: string }> = [
  { type: 'all', label: '全部' },
  { type: 'capture', label: '念头' },
  { type: 'attempt', label: '尝试' },
  { type: 'result', label: '结果' },
  { type: 'reference', label: '引用' },
  { type: 'ai', label: 'AI' },
];

function parseSuggestion(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function suggestionStep(suggestion: Record<string, unknown> | null): string {
  const step = suggestion?.step;
  const why = suggestion?.why;
  const question = suggestion?.question;
  if (typeof step === 'string' && step.trim()) return step.trim();
  if (typeof why === 'string' && why.trim()) return why.trim();
  if (typeof question === 'string' && question.trim()) return question.trim();
  return 'AI 没有返回可用建议。';
}

function aiTitle(kind: string | null, status: string): string {
  if (status === 'failed') return 'AI 生成失败';
  if (status === 'cancelled') return 'AI 生成已取消';
  if (status === 'interrupted') return 'AI 生成已中断';
  if (kind === 'defer') return 'AI 建议：先记着';
  if (kind === 'clarify') return 'AI 建议：需要补充';
  return 'AI 建议已生成';
}

function outcomeLabel(outcome: string | null): string | null {
  if (outcome === 'success') return '结果：成功';
  if (outcome === 'failure') return '结果：失败';
  if (outcome === 'undetermined') return '结果：未判定';
  return null;
}

function formatMoment(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function buildActivityEvents(): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const captures = sqlite
    .prepare(
      `SELECT id, raw_text, created_at, updated_at, archived_at
         FROM captures`
    )
    .all() as CaptureRow[];

  for (const capture of captures) {
    events.push({
      id: `capture-created-${capture.id}`,
      type: 'capture',
      action: 'capture_created',
      at: capture.created_at,
      title: '记下念头',
      text: capture.raw_text,
      detail: null,
      captureId: capture.id,
      attemptId: null,
      outcome: null,
      kind: null,
    });

    if (capture.archived_at !== null) {
      events.push({
        id: `capture-archived-${capture.id}`,
        type: 'capture',
        action: 'capture_archived',
        at: capture.archived_at,
        title: '归档念头',
        text: capture.raw_text,
        detail: '已从默认列表移到已归档。',
        captureId: capture.id,
        attemptId: null,
        outcome: null,
        kind: null,
      });
    } else if (capture.updated_at > capture.created_at + 1000) {
      events.push({
        id: `capture-updated-${capture.id}`,
        type: 'capture',
        action: 'capture_updated',
        at: capture.updated_at,
        title: '更新念头',
        text: capture.raw_text,
        detail: null,
        captureId: capture.id,
        attemptId: null,
        outcome: null,
        kind: null,
      });
    }
  }

  const attempts = sqlite
    .prepare(
      `SELECT id, capture_id, step, state, result_text, outcome, observed_at,
              created_at, updated_at, origin
         FROM attempts`
    )
    .all() as AttemptRow[];
  const attemptById = new Map(attempts.map((a) => [a.id, a]));

  for (const attempt of attempts) {
    const isNextAction = attempt.origin === 'review_next_action';
    events.push({
      id: `attempt-created-${attempt.id}`,
      type: 'attempt',
      action: isNextAction ? 'next_action_created' : 'attempt_created',
      at: attempt.created_at,
      title: isNextAction ? '从回顾创建下一步' : '开始尝试',
      text: attempt.step,
      detail: null,
      captureId: attempt.capture_id,
      attemptId: attempt.id,
      outcome: null,
      kind: null,
    });

    if (attempt.result_text || attempt.outcome) {
      events.push({
        id: `attempt-result-${attempt.id}`,
        type: 'result',
        action: isNextAction ? 'next_action_result' : 'attempt_result',
        at: attempt.observed_at ?? attempt.updated_at,
        title: isNextAction ? '下一步完成并记录结果' : '记录结果',
        text: attempt.result_text?.trim() || '未填写观察文字',
        detail: outcomeLabel(attempt.outcome),
        captureId: attempt.capture_id,
        attemptId: attempt.id,
        outcome: attempt.outcome,
        kind: null,
      });
    } else if (attempt.state === 'cancelled' && attempt.updated_at > attempt.created_at + 1000) {
      events.push({
        id: `attempt-cancelled-${attempt.id}`,
        type: 'attempt',
        action: 'attempt_cancelled',
        at: attempt.updated_at,
        title: '放弃尝试',
        text: attempt.step,
        detail: '这条尝试已标记为已放弃。',
        captureId: attempt.capture_id,
        attemptId: attempt.id,
        outcome: null,
        kind: null,
      });
    }
  }

  // 下一步行动加入日程：只从 active 安排派生，不新增事件表。
  const nextActionSchedules = sqlite
    .prepare(
      `SELECT s.id, s.attempt_id, s.starts_at, s.ends_at, s.timezone, s.created_at,
              a.step, a.capture_id
         FROM schedule_blocks s
         JOIN attempts a ON a.id = s.attempt_id
        WHERE s.status = 'active' AND a.origin = 'review_next_action'
        ORDER BY s.created_at ASC, s.id ASC`
    )
    .all() as NextActionScheduleRow[];
  for (const schedule of nextActionSchedules) {
    events.push({
      id: `next-action-scheduled-${schedule.id}`,
      type: 'attempt',
      action: 'next_action_scheduled',
      at: schedule.created_at,
      title: '下一步加入日程',
      text: schedule.step,
      detail: `${formatMoment(schedule.starts_at, schedule.timezone)} – ${formatMoment(
        schedule.ends_at,
        schedule.timezone
      )} · ${schedule.timezone}`,
      captureId: schedule.capture_id,
      attemptId: schedule.attempt_id,
      outcome: null,
      kind: null,
    });
  }

  const references = sqlite
    .prepare(
      `SELECT r.id, r.from_attempt_id, r.to_attempt_id, r.note, r.created_at,
              f.step AS from_step, t.step AS to_step
         FROM attempt_references r
         LEFT JOIN attempts f ON f.id = r.from_attempt_id
         LEFT JOIN attempts t ON t.id = r.to_attempt_id`
    )
    .all() as ReferenceRow[];
  for (const reference of references) {
    const from = attemptById.get(reference.from_attempt_id);
    const to = attemptById.get(reference.to_attempt_id);
    const referencedStep = reference.to_step ?? to?.step ?? null;
    events.push({
      id: `reference-created-${reference.id}`,
      type: 'reference',
      action: 'reference_created',
      at: reference.created_at,
      title: '引用旧结果',
      text: reference.from_step ?? from?.step ?? '一条尝试',
      detail: [
        referencedStep ? `引用：${referencedStep}` : null,
        reference.note?.trim() ? `用途：${reference.note.trim()}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
      captureId: from?.capture_id ?? '',
      attemptId: reference.from_attempt_id,
      outcome: null,
      kind: null,
    });
  }

  const generations = sqlite
    .prepare(
      `SELECT id, capture_id, status, kind, suggestion_json, error_detail,
              config_name, model_id, adopted_attempt_id, adopted_at,
              created_at, updated_at, finished_at
         FROM ai_generations`
    )
    .all() as GenerationRow[];
  for (const generation of generations) {
    // 未完成的请求不是可展示的事件；服务重启会把它变成 interrupted，届时再出现。
    if (generation.status === 'pending') continue;
    const suggestion = parseSuggestion(generation.suggestion_json);
    const adopted = Boolean(generation.adopted_attempt_id);
    const at = adopted
      ? generation.adopted_at ?? generation.finished_at ?? generation.updated_at
      : generation.finished_at ?? generation.updated_at;
    let title = aiTitle(generation.kind, generation.status);
    let text = suggestionStep(suggestion);
    if (generation.status === 'failed') {
      title = 'AI 生成失败';
      text = generation.error_detail?.trim() || '模型没有返回可用建议。';
    } else if (generation.status === 'cancelled') {
      text = '这次生成已被用户取消。';
    } else if (generation.status === 'interrupted') {
      text = '服务重启，这次生成被中断，可重新生成。';
    } else if (adopted) {
      title = '采用 AI 建议';
    }
    events.push({
      id: `ai-${adopted ? 'adopted' : 'generated'}-${generation.id}`,
      type: 'ai',
      action: adopted ? 'ai_adopted' : `ai_${generation.status}`,
      at,
      title,
      text,
      detail: `${generation.config_name} · ${generation.model_id}`,
      captureId: generation.capture_id,
      attemptId: generation.adopted_attempt_id,
      outcome: null,
      kind: generation.kind,
    });
  }

  events.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return events;
}

function isEventType(value: string | undefined): value is 'all' | ActivityEventType {
  return (
    value === undefined ||
    value === 'all' ||
    value === 'capture' ||
    value === 'attempt' ||
    value === 'result' ||
    value === 'reference' ||
    value === 'ai'
  );
}

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(200, n));
}

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

export function registerActivityRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/activity', { preHandler: requireAuth }, async (req, reply) => {
    const { type, limit } = req.query as { type?: string; limit?: string };
    if (!isEventType(type)) {
      return reply.code(400).send({
        error: 'invalid_type',
        message: '动态类型必须是 all、capture、attempt、result、reference 或 ai。',
      });
    }

    const events = buildActivityEvents();
    const counts = new Map<string, number>();
    for (const event of events) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    }

    const now = Date.now();
    const stats = {
      totalEvents: events.length,
      last7Days: events.filter((e) => e.at >= now - 7 * 24 * 60 * 60 * 1000).length,
      captures: counts.get('capture') ?? 0,
      // 下一步加入日程是派生展示事件，不计入真实尝试数。
      attempts: events.filter((e) => e.type === 'attempt' && e.action !== 'next_action_scheduled')
        .length,
      results: counts.get('result') ?? 0,
      references: counts.get('reference') ?? 0,
      aiRequests: counts.get('ai') ?? 0,
      aiAdopted: events.filter((e) => e.action === 'ai_adopted').length,
    };

    const filtered = type && type !== 'all' ? events.filter((e) => e.type === type) : events;
    return {
      generatedAt: now,
      total: filtered.length,
      events: filtered.slice(0, parseLimit(limit)),
      stats,
      filters: FILTERS.map((filter) => ({
        ...filter,
        count: filter.type === 'all' ? events.length : counts.get(filter.type) ?? 0,
      })),
    };
  });
}
