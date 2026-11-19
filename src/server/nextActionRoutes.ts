// 「回顾后的下一步行动」路由（docs/next-action-api-contract.md §3）。
// 认证与 Origin 校验复用 src/server/index.ts 的全局钩子。

import type { FastifyInstance } from 'fastify';
import { ScheduleHttpError } from './scheduleService';
import {
  NextActionHttpError,
  createNextAction,
  getNextActionById,
  listNextActionsByCapture,
  listNextActionsByReview,
  previewNextAction,
  updateNextAction,
} from './nextActionService';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

function sendNextActionError(req: any, reply: any, error: unknown) {
  if (error instanceof NextActionHttpError || error instanceof ScheduleHttpError) {
    return reply.code(error.status).send(error.body);
  }
  req.log.error({ err: error }, 'next action request failed');
  return reply.code(500).send({
    error: 'internal_error',
    message: '下一步行动操作失败，请稍后重试。',
  });
}

export function registerNextActionRoutes(fastify: FastifyInstance): void {
  // GET /api/reviews/:id/next-action-preview?experienceIndex=0
  fastify.get(
    '/api/reviews/:id/next-action-preview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = (req.query ?? {}) as Record<string, unknown>;
      try {
        return previewNextAction(id, query.experienceIndex);
      } catch (error) {
        return sendNextActionError(req, reply, error);
      }
    }
  );

  // POST /api/reviews/:id/next-actions
  fastify.post('/api/reviews/:id/next-actions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const outcome = createNextAction(id, body);
      return reply.code(outcome.status).send(outcome.body);
    } catch (error) {
      return sendNextActionError(req, reply, error);
    }
  });

  // GET /api/reviews/:id/next-actions
  fastify.get('/api/reviews/:id/next-actions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { actions: listNextActionsByReview(id) };
    } catch (error) {
      return sendNextActionError(req, reply, error);
    }
  });

  // GET /api/captures/:id/next-actions
  fastify.get('/api/captures/:id/next-actions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { actions: listNextActionsByCapture(id) };
    } catch (error) {
      return sendNextActionError(req, reply, error);
    }
  });

  // GET /api/next-actions/:id
  fastify.get('/api/next-actions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const action = getNextActionById(id);
      if (!action) {
        return reply.code(404).send({
          error: 'next_action_not_found',
          message: '下一步行动不存在。',
        });
      }
      return { action };
    } catch (error) {
      return sendNextActionError(req, reply, error);
    }
  });

  // PATCH /api/next-actions/:id
  fastify.patch('/api/next-actions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const outcome = updateNextAction(id, body);
      return reply.code(outcome.status).send(outcome.body);
    } catch (error) {
      return sendNextActionError(req, reply, error);
    }
  });
}
