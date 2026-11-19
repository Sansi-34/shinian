// 拾念 SHINIAN · 经验笔记 API
// 两个入口（问答单条观点、有结果的尝试）+ 编辑/保存 + 参考它再试一步。
import type { FastifyInstance } from 'fastify';
import {
  buildExperiencePublic,
  createAttemptFromExperience,
  createExperience,
  draftFromAsk,
  draftFromAttempt,
  experienceDeletePreview,
  listExperiences,
  searchExperiences,
  sourceCandidates,
  updateExperience,
  ExperienceHttpError,
} from './experienceService';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function sendError(reply: any, error: unknown) {
  if (error instanceof ExperienceHttpError) {
    return reply.code(error.status).send(error.body);
  }
  throw error;
}

export function registerExperienceRoutes(fastify: FastifyInstance): void {
  // 经验列表（默认不含归档）；q 仅用于管理页的轻量筛选，不改动搜索的命中原因口径。
  fastify.get('/api/experiences', { preHandler: requireAuth }, async (req) => {
    const { archived, limit, q } = req.query as {
      archived?: string;
      limit?: string;
      q?: string;
    };
    const archivedMode =
      archived === 'include' ? 'include' : archived === 'only' ? 'only' : 'exclude';
    const limitNumber = Number(limit ?? 50);
    return {
      experiences: listExperiences({
        archived: archivedMode,
        limit: Number.isFinite(limitNumber) ? limitNumber : 50,
        q: typeof q === 'string' ? q : undefined,
      }),
    };
  });

  // 补选来源：只列有真实结果的尝试和普通念头；不把经验摘要当成新的事实证据。
  fastify.get('/api/experiences/source-candidates', { preHandler: requireAuth }, async (req) => {
    const { q, excludeExperienceId } = req.query as {
      q?: string;
      excludeExperienceId?: string;
    };
    return {
      candidates: sourceCandidates(
        typeof q === 'string' ? q : '',
        typeof excludeExperienceId === 'string' ? excludeExperienceId : null
      ),
    };
  });

  fastify.get('/api/experiences/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const experience = buildExperiencePublic(id);
    if (!experience) {
      return reply.code(404).send({ error: 'experience_not_found', message: '这份经验已不存在。' });
    }
    return { experience };
  });

  fastify.get('/api/experiences/:id/delete-preview', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return experienceDeletePreview(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/experiences', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const outcome = createExperience((req.body ?? {}) as any);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.patch('/api/experiences/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = updateExperience(id, (req.body ?? {}) as any);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // 参考经验，再试一步：复用 attempts 实体和结果表单；只有用户勾选的依据尝试进入引用关系。
  fastify.post('/api/experiences/:id/attempts', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = createAttemptFromExperience(id, (req.body ?? {}) as any);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // 两个入口的预填：只返回所选观点实际使用的来源 / 这次尝试的实际结果。
  fastify.get(
    '/api/ask/queries/:id/experience-draft',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { pointIndex } = req.query as { pointIndex?: string };
      const index = Number(pointIndex);
      if (!Number.isInteger(index) || index < 0) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: '观点位置不正确。',
          field: 'pointIndex',
        });
      }
      try {
        return { draft: draftFromAsk(id, index) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.get(
    '/api/attempts/:id/experience-draft',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return { draft: draftFromAttempt(id) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // 经验搜索与管理页共用：返回标题、摘要与命中原因。
  fastify.get('/api/experiences/search', { preHandler: requireAuth }, async (req) => {
    const { q } = req.query as { q?: string };
    return { hits: searchExperiences(typeof q === 'string' ? q : '') };
  });
}
