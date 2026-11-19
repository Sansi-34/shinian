// 日程安排路由（docs/schedule-api-contract.md §5.1–5.5）。
// 注册入口由 src/server/index.ts 调用；认证与 Origin 校验复用 index.ts 的全局钩子。

import type { FastifyInstance } from 'fastify';
import {
  ScheduleHttpError,
  attemptExists,
  cancelSchedule,
  createSchedule,
  listSchedulesForAttempt,
  listSchedulesInRange,
  updateSchedule,
} from './scheduleService';
import { parseScheduleRange } from './timezone';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

function sendScheduleError(req: any, reply: any, error: unknown) {
  if (error instanceof ScheduleHttpError) {
    return reply.code(error.status).send(error.body);
  }
  req.log.error({ err: error }, 'schedule request failed');
  return reply.code(500).send({
    error: 'internal_error',
    message: '日程操作失败，请稍后重试。',
  });
}

export function registerScheduleRoutes(fastify: FastifyInstance): void {
  // GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=Asia/Shanghai
  fastify.get('/api/schedules', { preHandler: requireAuth }, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const parsed = parseScheduleRange(query);
    if (!parsed.ok) {
      return reply.code(parsed.status).send({
        error: parsed.error,
        ...(parsed.field ? { field: parsed.field } : {}),
        message: parsed.message,
      });
    }
    try {
      const schedules = listSchedulesInRange(parsed.value.fromAt, parsed.value.toAt);
      return {
        range: parsed.value,
        schedules,
        generatedAt: Date.now(),
      };
    } catch (error) {
      return sendScheduleError(req, reply, error);
    }
  });

  // GET /api/attempts/:attemptId/schedules —— 含 cancelled 的完整历史
  fastify.get(
    '/api/attempts/:attemptId/schedules',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { attemptId } = req.params as { attemptId: string };
      try {
        if (!attemptExists(attemptId)) {
          return reply.code(404).send({ error: 'attempt_not_found', message: '尝试不存在。' });
        }
        return { schedules: listSchedulesForAttempt(attemptId), serverNow: Date.now() };
      } catch (error) {
        return sendScheduleError(req, reply, error);
      }
    }
  );

  // POST /api/attempts/:attemptId/schedules —— operationId 幂等 + 重叠确认
  fastify.post(
    '/api/attempts/:attemptId/schedules',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { attemptId } = req.params as { attemptId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const outcome = createSchedule(attemptId, body);
        return reply.code(outcome.status).send(outcome.body);
      } catch (error) {
        return sendScheduleError(req, reply, error);
      }
    }
  );

  // PATCH /api/schedules/:id —— revision CAS + 重叠确认
  fastify.patch('/api/schedules/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return { schedule: updateSchedule(id, body) };
    } catch (error) {
      return sendScheduleError(req, reply, error);
    }
  });

  // POST /api/schedules/:id/cancel —— 只取消安排，不修改 Attempt
  fastify.post('/api/schedules/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return { schedule: cancelSchedule(id, body) };
    } catch (error) {
      return sendScheduleError(req, reply, error);
    }
  });
}
