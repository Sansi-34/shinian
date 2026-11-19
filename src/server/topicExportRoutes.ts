// 拾念 SHINIAN · 单主题 Markdown ZIP 导出 HTTP 路由
import type { FastifyInstance } from 'fastify';
import {
  TopicExportHttpError,
  generateTopicExport,
  previewTopicExport,
} from './topicExportService';

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function sendError(reply: any, req: any, error: unknown) {
  if (error instanceof TopicExportHttpError) {
    return reply.code(error.status).send(error.body);
  }
  req.log.error({ err: error }, 'topic export failed');
  return reply.code(500).send({ error: 'export_failed', message: '导出失败，请稍后重试。' });
}

export function registerTopicExportRoutes(fastify: FastifyInstance): void {
  fastify.post('/api/topics/:id/export/preview', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return previewTopicExport(id, req.body ?? {});
    } catch (error) {
      return sendError(reply, req, error);
    }
  });

  fastify.post('/api/topics/:id/export', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = generateTopicExport(id, req.body ?? {});
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Length', String(result.zip.length))
        .send(result.zip);
    } catch (error) {
      return sendError(reply, req, error);
    }
  });
}
