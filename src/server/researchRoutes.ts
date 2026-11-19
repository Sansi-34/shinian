import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/db';
import {
  getPublicGithubSettings,
  saveGithubToken,
  deleteGithubToken,
  readGithubToken,
} from './githubSettings';
import { GithubApiError, getGithubUser } from './githubClient';
import {
  RESEARCH_LIMITS,
  adoptResearchExperiment,
  attemptResearchLink,
  cancelResearch,
  createResearchRun,
  deleteResearch,
  getCaptureResearchCount,
  getResearchRow,
  limitsPublic,
  markInterruptedResearch,
  normalizeConstraints,
  normalizeQuestion,
  normalizeSearchInput,
  publicResearchOf,
  researchContextToken,
  retryResearch,
  saveResearch,
  startSelection,
} from './researchService';
import { getSettingsRow } from './aiSettings';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  done();
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function registerResearchRoutes(fastify: FastifyInstance): void {
  markInterruptedResearch();

  // ---------- GitHub Token 设置 ----------
  fastify.get('/api/settings/github', { preHandler: requireAuth }, async () => {
    return getPublicGithubSettings();
  });

  fastify.put('/api/settings/github', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { token?: unknown };
    const result = await saveGithubToken(body.token);
    if (!result.ok) {
      return reply.code(400).send({ error: 'invalid_token', message: result.message });
    }
    return { ...(await getPublicGithubSettings()), changed: result.changed };
  });

  fastify.delete('/api/settings/github', { preHandler: requireAuth }, async () => {
    await deleteGithubToken();
    return { ok: true, ...(await getPublicGithubSettings()) };
  });

  fastify.post('/api/settings/github/test', { preHandler: requireAuth }, async (req, reply) => {
    const token = await readGithubToken();
    if (!token) {
      return reply.code(409).send({
        error: 'github_not_configured',
        message: '尚未配置 GitHub Token；不填写 Token 也可以读取公开仓库，但额度较低。',
      });
    }
    try {
      const result = await getGithubUser(token);
      return {
        ok: true,
        login: result.login,
        scopes: result.scopes,
        rate: result.rate,
        apiBase: (await getPublicGithubSettings()).apiBase,
      };
    } catch (error) {
      if (error instanceof GithubApiError) {
        return reply.code(error.code === 'rate_limited' ? 429 : 400).send({
          error: error.code,
          message: error.message,
          detail: error.detail,
          resetAt: error.resetAt,
        });
      }
      return reply.code(500).send({ error: 'unreachable', message: 'GitHub 连接测试失败。' });
    }
  });

  // ---------- 研究入口预览 ----------
  fastify.post(
    '/api/captures/:id/research/preview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        typeof body.captureRevision !== 'number' ||
        !Number.isInteger(body.captureRevision) ||
        body.captureRevision < 1
      ) {
        return reply.code(400).send({ error: 'invalid_request', field: 'captureRevision' });
      }
      const cap = sqlite
        .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
        .get(id) as { id: string; rawText: string; revision: number } | undefined;
      if (!cap) return reply.code(404).send({ error: 'capture_not_found' });
      if (cap.revision !== body.captureRevision) {
        return reply.code(409).send({
          error: 'version_conflict',
          currentRevision: cap.revision,
          currentRawText: cap.rawText,
        });
      }
      const questionResult = normalizeQuestion(body.question, cap.rawText);
      if (!questionResult.ok) {
        return reply.code(400).send({ error: 'invalid_question', message: questionResult.message });
      }
      const searchResult = normalizeSearchInput(body.search);
      if (!searchResult.ok) {
        return reply.code(400).send({
          error: 'invalid_search',
          field: searchResult.field,
          message: searchResult.message,
        });
      }
      const constraints = normalizeConstraints(body.constraints);
      const settings = await getSettingsRow();
      const github = await getPublicGithubSettings();
      const contextToken = researchContextToken({
        captureId: cap.id,
        captureRevision: cap.revision,
        question: questionResult.value,
        constraints,
        search: searchResult.search,
        configVersion: settings?.configVersion ?? null,
      });
      const suggestedRequests =
        searchResult.search.mode === 'repositories'
          ? searchResult.search.repos.length
          : 1;
      return {
        capture: { id: cap.id, rawText: cap.rawText, revision: cap.revision },
        question: questionResult.value,
        constraints,
        search: searchResult.search,
        searchDisplay: searchResult.display,
        limits: limitsPublic(),
        estimatedGithubRequests: suggestedRequests,
        maxDetailRequests: RESEARCH_LIMITS.maxSelected * 4 + RESEARCH_LIMITS.maxSelected,
        modelCalls: settings?.enabled === 1 ? 1 : 0,
        ai: {
          configured: Boolean(settings),
          enabled: settings?.enabled === 1,
          config: settings
            ? {
                id: settings.id,
                name: settings.name,
                modelId: settings.modelId,
                version: settings.configVersion,
              }
            : null,
        },
        github: { hasToken: github.hasToken, apiBase: github.apiBase },
        modelInput: {
          question: questionResult.value,
          constraints,
          note: '确认后先向 GitHub 读取候选；你选择最多 3 个仓库后，才会把仓库元数据、README 摘录（每份最多 4000 字符）、许可证与发布信息发送给模型。',
        },
        contextToken,
      };
    }
  );

  fastify.post('/api/captures/:id/research', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.captureRevision !== 'number' ||
      !Number.isInteger(body.captureRevision) ||
      body.captureRevision < 1
    ) {
      return reply.code(400).send({ error: 'invalid_request', field: 'captureRevision' });
    }
    const cap = sqlite
      .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
      .get(id) as { id: string; rawText: string; revision: number } | undefined;
    if (!cap) return reply.code(404).send({ error: 'capture_not_found' });
    const questionResult = normalizeQuestion(body.question, cap.rawText);
    if (!questionResult.ok) {
      return reply.code(400).send({ error: 'invalid_question', message: questionResult.message });
    }
    const searchResult = normalizeSearchInput(body.search);
    if (!searchResult.ok) {
      return reply.code(400).send({
        error: 'invalid_search',
        field: searchResult.field,
        message: searchResult.message,
      });
    }
    if (typeof body.contextToken !== 'string' || !body.contextToken.trim()) {
      return reply.code(400).send({
        error: 'invalid_request',
        field: 'contextToken',
        message: '请先确认预览再开始研究。',
      });
    }
    if (typeof body.operationId !== 'string' || !body.operationId.trim()) {
      return reply.code(400).send({ error: 'invalid_request', field: 'operationId' });
    }
    const result = await createResearchRun({
      captureId: id,
      captureRevision: body.captureRevision,
      question: questionResult.value,
      constraints: normalizeConstraints(body.constraints),
      search: searchResult.search,
      contextToken: body.contextToken.trim(),
      operationId: body.operationId.trim(),
      fastify,
    });
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply
      .code(result.replayed ? 200 : 202)
      .send({ research: publicResearchOf(result.run), replayed: result.replayed });
  });

  // ---------- 研究列表与详情 ----------
  fastify.get('/api/captures/:id/research', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cap = sqlite.prepare('SELECT id FROM captures WHERE id = ?').get(id);
    if (!cap) return reply.code(404).send({ error: 'capture_not_found' });
    const runs = sqlite
      .prepare('SELECT * FROM research_runs WHERE capture_id = ? ORDER BY created_at DESC')
      .all(id) as Array<Record<string, any>>;
    return {
      captureId: id,
      count: getCaptureResearchCount(id),
      research: runs.map((row) => {
        const result = parseJson<{ summary?: string }>(row.result_json);
        const attemptCount = (
          sqlite
            .prepare('SELECT COUNT(*) AS c FROM attempts WHERE source_research_id = ?')
            .get(row.id) as { c: number }
        ).c;
        return {
          id: row.id,
          question: row.question,
          status: row.status,
          searchMode: row.search_mode,
          searchQuery: row.search_query,
          savedAt: row.saved_at,
          createdAt: row.created_at,
          revision: row.revision,
          summary: result?.summary ?? null,
          attemptCount,
          errorCode: row.error_code,
        };
      }),
    };
  });

  fastify.get('/api/research', { preHandler: requireAuth }, async (req) => {
    const query = req.query as { saved?: string; limit?: string; captureId?: string };
    const limit = Math.max(1, Math.min(50, Number.parseInt(query.limit ?? '20', 10) || 20));
    const savedOnly = query.saved === '1' || query.saved === 'true';
    const rows = sqlite
      .prepare(
        `SELECT * FROM research_runs
          ${savedOnly ? 'WHERE saved_at IS NOT NULL' : ''}
          ORDER BY COALESCE(saved_at, created_at) DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, any>>;
    return {
      research: rows.map((row) => {
        const result = parseJson<{ summary?: string }>(row.result_json);
        const attemptCount = (
          sqlite
            .prepare('SELECT COUNT(*) AS c FROM attempts WHERE source_research_id = ?')
            .get(row.id) as { c: number }
        ).c;
        return {
          id: row.id,
          captureId: row.capture_id,
          question: row.question,
          status: row.status,
          savedAt: row.saved_at,
          createdAt: row.created_at,
          summary: result?.summary ?? null,
          attemptCount,
        };
      }),
    };
  });

  fastify.get('/api/research/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getResearchRow(id);
    if (!run) return reply.code(404).send({ error: 'research_not_found' });
    return {
      research: publicResearchOf(run),
      ai: await (async () => {
        const settings = await getSettingsRow();
        return {
          configured: Boolean(settings),
          enabled: settings?.enabled === 1,
          config: settings
            ? { id: settings.id, name: settings.name, modelId: settings.modelId, version: settings.configVersion }
            : null,
        };
      })(),
      github: { hasToken: (await getPublicGithubSettings()).hasToken },
    };
  });

  fastify.post('/api/research/:id/select', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { candidateIds?: unknown };
    if (!Array.isArray(body.candidateIds)) {
      return reply.code(400).send({ error: 'invalid_request', field: 'candidateIds' });
    }
    const ids = body.candidateIds.filter((item): item is string => typeof item === 'string');
    if (ids.length < 1 || ids.length > RESEARCH_LIMITS.maxSelected) {
      return reply.code(400).send({
        error: 'invalid_selection',
        message: `请选择 1–${RESEARCH_LIMITS.maxSelected} 个仓库。`,
      });
    }
    const ok = await startSelection(fastify, id, ids);
    const run = await getResearchRow(id);
    if (!ok || !run) {
      return reply.code(409).send({
        error: 'not_selectable',
        message: '当前状态不能选择候选；请刷新后重试。',
        research: run ? publicResearchOf(run) : null,
      });
    }
    return reply.code(202).send({ research: publicResearchOf(run) });
  });

  fastify.post('/api/research/:id/retry', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { action?: unknown; repoIds?: unknown };
    const action =
      body.action === 'search' || body.action === 'fetch' || body.action === 'generate'
        ? body.action
        : null;
    if (!action) {
      return reply.code(400).send({ error: 'invalid_action', message: 'action 必须是 search/fetch/generate。' });
    }
    const repoIds = Array.isArray(body.repoIds)
      ? body.repoIds.filter((item): item is string => typeof item === 'string')
      : [];
    const result = await retryResearch(fastify, id, action, repoIds);
    if (!result.ok) return reply.code(result.status).send(result.body);
    const run = await getResearchRow(id);
    return reply.code(result.status).send({ research: run ? publicResearchOf(run) : null });
  });

  fastify.post('/api/research/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = cancelResearch(id);
    if (!result.ok) return reply.code(result.status).send(result.body);
    const run = await getResearchRow(id);
    return { research: run ? publicResearchOf(run) : null };
  });

  fastify.post('/api/research/:id/save', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = saveResearch(id);
    if (!result.ok) return reply.code(result.status).send(result.body);
    const run = await getResearchRow(id);
    return { ...result.body, research: run ? publicResearchOf(run) : null };
  });

  fastify.delete('/api/research/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = deleteResearch(id);
    return reply.code(result.status).send(result.body);
  });

  // ---------- 从研究进入尝试 ----------
  fastify.post(
    '/api/research/:id/experiments/:index/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, index } = req.params as { id: string; index: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsedIndex = Number.parseInt(index, 10);
      if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
        return reply.code(400).send({ error: 'experiment_not_found' });
      }
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return reply.code(400).send({ error: 'invalid_title', message: '请填写行动标题。' });
      }
      if (
        typeof body.expectedRevision !== 'number' ||
        !Number.isInteger(body.expectedRevision) ||
        body.expectedRevision < 1
      ) {
        return reply.code(428).send({ error: 'revision_required', message: '缺少研究版本，请刷新后重试。' });
      }
      if (typeof body.operationId !== 'string' || !body.operationId.trim()) {
        return reply.code(400).send({ error: 'invalid_request', field: 'operationId' });
      }
      if (
        body.description !== undefined &&
        body.description !== null &&
        typeof body.description !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid_description' });
      }
      if (
        body.estimatedMinutes !== undefined &&
        body.estimatedMinutes !== null &&
        typeof body.estimatedMinutes !== 'number'
      ) {
        return reply.code(400).send({ error: 'invalid_estimated_minutes' });
      }
      const result = await adoptResearchExperiment({
        researchId: id,
        experimentIndex: parsedIndex,
        title: body.title,
        description: typeof body.description === 'string' ? body.description : null,
        estimatedMinutes:
          typeof body.estimatedMinutes === 'number' ? body.estimatedMinutes : null,
        expectedRevision: body.expectedRevision,
        operationId: body.operationId,
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply.code(result.replayed ? 200 : 201).send({
        attempt: result.attempt,
        researchId: id,
        replayed: result.replayed,
      });
    }
  );

  fastify.get('/api/attempts/:id/research', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = sqlite.prepare('SELECT id FROM attempts WHERE id = ?').get(id);
    if (!attempt) return reply.code(404).send({ error: 'attempt_not_found' });
    return { research: attemptResearchLink(id) };
  });
}
