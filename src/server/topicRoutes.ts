// 拾念 SHINIAN · 「主题」HTTP 路由
// 契约：docs/topic-api-contract.md
import type { FastifyInstance } from 'fastify';
import { getSettingsRow } from './aiSettings';
import { normalizeExpandedTerms, normalizeKeywords, parseAskRange } from './askData';
import {
  ASK_DEFAULT_CANDIDATES,
  ASK_MAX_CANDIDATES,
  ASK_MAX_KEYWORDS_CHARS,
  ASK_MAX_QUESTION_CHARS,
  type AskSearchResponse,
  type AskAiConfig,
} from './askTypes';
import {
  TopicHttpError,
  addCaptureToTopics,
  addTopicMembers,
  createTopic,
  deleteTopic,
  getTopicDetail,
  listMemberCandidates,
  listTopicAskExperiences,
  listTopicAttempts,
  listTopics,
  listTopicsForCapture,
  removeTopicMember,
  searchTopicAskCandidates,
  setTopicArchived,
  setTopicNextAttempt,
  topicDeletePreview,
  topicScopeSummary,
  updateTopic,
} from './topicService';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function sendError(reply: any, error: unknown) {
  if (error instanceof TopicHttpError) return reply.code(error.status).send(error.body);
  throw error;
}

function parseQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const question = value.trim();
  if (!question || question.length > ASK_MAX_QUESTION_CHARS) return null;
  return question;
}

function publicConfigOfSettings(row: {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
}): AskAiConfig {
  return { id: row.id, name: row.name, modelId: row.modelId, configVersion: row.configVersion };
}

export function registerTopicRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/topics', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    try {
      return listTopics({
        archived: query.archived,
        q: query.q,
        limit: query.limit,
        offset: query.offset,
        cursor: query.cursor,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/topics', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const outcome = createTopic((req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/topics/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return getTopicDetail(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.patch('/api/topics/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = updateTopic(id, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/topics/:id/archive', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = setTopicArchived(id, true, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/topics/:id/restore', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = setTopicArchived(id, false, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/topics/:id/delete-preview', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return topicDeletePreview(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete('/api/topics/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return deleteTopic(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/topics/:id/member-candidates', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    try {
      return listMemberCandidates(id, {
        q: query.q,
        type: query.type,
        limit: query.limit,
        offset: query.offset,
        cursor: query.cursor,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/topics/:id/members', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = addTopicMembers(id, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete('/api/topics/:id/members/:captureId', { preHandler: requireAuth }, async (req, reply) => {
    const { id, captureId } = req.params as { id: string; captureId: string };
    try {
      return removeTopicMember(id, captureId);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/topics/:id/attempts', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    try {
      return listTopicAttempts(id, {
        limit: query.limit,
        offset: query.offset,
        cursor: query.cursor,
        state: query.state,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put('/api/topics/:id/next-attempt', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = setTopicNextAttempt(id, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/topics/:id/ask-candidates', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    const question = parseQuestion(query.question);
    if (!question) {
      return reply.code(400).send({
        error: 'invalid_question',
        field: 'question',
        message: `问题不能为空且不能超过 ${ASK_MAX_QUESTION_CHARS} 个字符。`,
      });
    }
    const rangeResult = parseAskRange(query.from, query.to);
    if (!rangeResult.ok) return reply.code(400).send(rangeResult);
    const keywordResult = normalizeKeywords(query.keywords, question);
    if (!keywordResult.ok) {
      return reply.code(400).send({
        error: 'invalid_keywords',
        field: 'keywords',
        message: `关键词不能超过 ${ASK_MAX_KEYWORDS_CHARS} 个字符。`,
      });
    }
    const expandedResult = normalizeExpandedTerms(query.expanded, keywordResult.value);
    if (!expandedResult.ok) {
      return reply.code(400).send({
        error: 'invalid_expanded_keywords',
        field: 'expanded',
        message: expandedResult.message,
      });
    }
    const limit = Math.max(
      1,
      Math.min(
        ASK_MAX_CANDIDATES,
        Number.parseInt(typeof query.limit === 'string' ? query.limit : String(ASK_DEFAULT_CANDIDATES), 10) ||
          ASK_DEFAULT_CANDIDATES
      )
    );
    let result: ReturnType<typeof searchTopicAskCandidates>;
    try {
      result = searchTopicAskCandidates(id, {
        question,
        keywords: keywordResult.value,
        expandedTerms: expandedResult.value,
        range: rangeResult.range,
        limit,
      });
    } catch (error) {
      return sendError(reply, error);
    }
    if (!result) {
      return reply.code(404).send({ error: 'topic_not_found', message: '主题已不存在。' });
    }
    const settings = await getSettingsRow();
    const response: AskSearchResponse & {
      topic: { id: string; name: string };
      scope: ReturnType<typeof topicScopeSummary>;
    } = {
      question,
      keywords: keywordResult.value,
      suggestedKeywords: keywordResult.value.join(' '),
      expandedKeywords: expandedResult.value,
      range: rangeResult.range,
      total: result.total,
      limit,
      candidates: result.candidates,
      ai: {
        configured: Boolean(settings && settings.apiKeyCiphertext),
        enabled: Boolean(settings && settings.enabled === 1),
        config: settings ? publicConfigOfSettings(settings) : null,
      },
      generatedAt: Date.now(),
      topic: { id: result.scope.topicId, name: result.scope.topicName },
      scope: topicScopeSummary(result.scope),
    };
    return response;
  });

  fastify.get('/api/topics/:id/ask-experiences', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = listTopicAskExperiences(id);
      if (!result) return reply.code(404).send({ error: 'topic_not_found', message: '主题已不存在。' });
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/captures/:id/topics', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return listTopicsForCapture(id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/captures/:id/topics', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const outcome = addCaptureToTopics(id, (req.body ?? {}) as Record<string, unknown>);
      reply.code(outcome.status);
      return outcome.body;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
