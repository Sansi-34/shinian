// 拾念 SHINIAN · 念头关联（有方向的链接 + 反链）与念头级引用视图
// 关系只保存一条行：from → to。A 的「关联到」和 B 的「被关联」读取同一行。
import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/db';

type CaptureBriefRow = {
  id: string;
  rawText: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  kind?: string | null;
  title?: string | null;
};

type LinkRow = {
  id: string;
  fromCaptureId: string;
  toCaptureId: string;
  note: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

function requireAuth(req: any, reply: any, done: any) {
  if (!req.session?.accountId) return reply.code(401).send({ error: 'unauthenticated' });
  done();
}

function short(text: string, max = 56): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function snippetOf(text: string, term: string, max = 88): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!term) return short(clean, max);
  const lower = clean.toLowerCase();
  const needle = term.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return short(clean, max);
  const start = Math.max(0, idx - 24);
  return (
    (start > 0 ? '…' : '') +
    clean.slice(start, start + max) +
    (start + max < clean.length ? '…' : '')
  );
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function brief(row: CaptureBriefRow) {
  const kind = row.kind === 'experience' ? 'experience' : 'thought';
  return {
    id: row.id,
    kind,
    title: kind === 'experience' ? row.title ?? short(row.rawText, 56) : short(row.rawText, 56),
    rawText: row.rawText,
    summary: short(row.rawText, 56),
    href: kind === 'experience' ? `/experience/${row.id}` : `/capture/${row.id}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    archived: Boolean(row.archivedAt),
  };
}

function linkDto(row: LinkRow, other: CaptureBriefRow, direction: 'out' | 'in') {
  return {
    id: row.id,
    fromCaptureId: row.fromCaptureId,
    toCaptureId: row.toCaptureId,
    note: row.note,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    direction,
    capture: brief(other),
  };
}

export function registerLinkRoutes(fastify: FastifyInstance): void {
  // 选择关联对象：按关键词搜索念头；结果带短摘要与日期，便于区分同名记录。
  fastify.get('/api/capture-links/candidates', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as { q?: string; excludeId?: string; limit?: string };
    const term = (query.q ?? '').trim();
    if (term.length > 120) return reply.code(400).send({ error: 'query_too_long' });
    const excludeId = (query.excludeId ?? '').trim();
    const limit = Math.max(1, Math.min(30, Number.parseInt(query.limit ?? '12', 10) || 12));
    const where: string[] = [];
    const params: unknown[] = [];
    if (excludeId) {
      where.push('c.id <> ?');
      params.push(excludeId);
    }
    if (term) {
      where.push(
        "(c.raw_text LIKE ? ESCAPE '\\' OR COALESCE((SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id), '') LIKE ? ESCAPE '\\')"
      );
      params.push(likePattern(term), likePattern(term));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM captures c ${whereSql}`).get(...params) as { n: number }
    ).n;
    const rows = sqlite
      .prepare(
        `SELECT c.id, c.raw_text AS rawText, c.created_at AS createdAt,
                c.updated_at AS updatedAt, c.archived_at AS archivedAt, c.kind,
                (SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id) AS title
           FROM captures c
           ${whereSql}
          ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
          LIMIT ?`
      )
      .all(...params, limit) as CaptureBriefRow[];

    const linkedOutIds = new Set<string>();
    if (excludeId) {
      const links = sqlite
        .prepare('SELECT to_capture_id AS toId FROM capture_links WHERE from_capture_id = ?')
        .all(excludeId) as Array<{ toId: string }>;
      for (const l of links) linkedOutIds.add(l.toId);
    }

    return {
      query: term,
      excludeId: excludeId || null,
      total,
      limit,
      captures: rows.map((row) => ({
        ...brief(row),
        snippet: snippetOf(row.rawText, term),
        alreadyLinked: linkedOutIds.has(row.id),
      })),
    };
  });

  // 一条念头的正链（关联到）与反链（被关联）
  fastify.get('/api/captures/:id/links', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [capture] = sqlite
      .prepare('SELECT id FROM captures WHERE id = ?')
      .all(id) as Array<{ id: string }>;
    if (!capture) return reply.code(404).send({ error: 'capture_not_found' });

    const outRows = sqlite
      .prepare(
        `SELECT l.id, l.from_capture_id AS fromCaptureId, l.to_capture_id AS toCaptureId,
                l.note, l.revision, l.created_at AS createdAt, l.updated_at AS updatedAt,
                c.id AS otherId, c.raw_text AS otherRawText, c.created_at AS otherCreatedAt,
                c.updated_at AS otherUpdatedAt, c.archived_at AS otherArchivedAt,
                c.kind AS otherKind,
                (SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id) AS otherTitle
           FROM capture_links l
           JOIN captures c ON c.id = l.to_capture_id
          WHERE l.from_capture_id = ?
          ORDER BY l.created_at DESC, l.id DESC`
      )
      .all(id) as Array<LinkRow & {
      otherId: string;
      otherRawText: string;
      otherCreatedAt: number;
      otherUpdatedAt: number;
      otherArchivedAt: number | null;
      otherKind: string | null;
      otherTitle: string | null;
    }>;

    const inRows = sqlite
      .prepare(
        `SELECT l.id, l.from_capture_id AS fromCaptureId, l.to_capture_id AS toCaptureId,
                l.note, l.revision, l.created_at AS createdAt, l.updated_at AS updatedAt,
                c.id AS otherId, c.raw_text AS otherRawText, c.created_at AS otherCreatedAt,
                c.updated_at AS otherUpdatedAt, c.archived_at AS otherArchivedAt,
                c.kind AS otherKind,
                (SELECT n.title FROM experience_notes n WHERE n.capture_id = c.id) AS otherTitle
           FROM capture_links l
           JOIN captures c ON c.id = l.from_capture_id
          WHERE l.to_capture_id = ?
          ORDER BY l.created_at DESC, l.id DESC`
      )
      .all(id) as Array<LinkRow & {
      otherId: string;
      otherRawText: string;
      otherCreatedAt: number;
      otherUpdatedAt: number;
      otherArchivedAt: number | null;
      otherKind: string | null;
      otherTitle: string | null;
    }>;

    const toDto = (row: (typeof outRows)[number], direction: 'out' | 'in') =>
      linkDto(
        {
          id: row.id,
          fromCaptureId: row.fromCaptureId,
          toCaptureId: row.toCaptureId,
          note: row.note,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        {
          id: row.otherId,
          rawText: row.otherRawText,
          createdAt: row.otherCreatedAt,
          updatedAt: row.otherUpdatedAt,
          archivedAt: row.otherArchivedAt,
          kind: row.otherKind,
          title: row.otherTitle,
        },
        direction
      );

    return {
      captureId: id,
      out: outRows.map((row) => toDto(row, 'out')),
      in: inRows.map((row) => toDto(row, 'in')),
      counts: { out: outRows.length, in: inRows.length },
    };
  });

  // 建立关联：有方向、幂等、禁止自关联与同方向重复
  fastify.post('/api/captures/:id/links', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      toCaptureId?: string;
      note?: string | null;
      operationId?: string;
    };
    const toCaptureId = (body.toCaptureId ?? '').trim();
    const operationId = (body.operationId ?? '').trim();
    if (!toCaptureId) return reply.code(400).send({ error: 'to_capture_required' });
    if (!operationId) return reply.code(400).send({ error: 'operation_id_required' });
    if (id === toCaptureId) return reply.code(400).send({ error: 'self_link_not_allowed' });

    const note = (body.note ?? '').trim();
    if (note.length > 200) return reply.code(400).send({ error: 'note_too_long' });

    const [from] = sqlite.prepare('SELECT id FROM captures WHERE id = ?').all(id) as Array<{
      id: string;
    }>;
    if (!from) return reply.code(404).send({ error: 'capture_not_found' });
    const [to] = sqlite
      .prepare('SELECT id FROM captures WHERE id = ?')
      .all(toCaptureId) as Array<{ id: string }>;
    if (!to) return reply.code(404).send({ error: 'target_not_found' });

    const fingerprint = JSON.stringify({
      op: 'create-capture-link',
      fromCaptureId: id,
      toCaptureId,
      note: note || null,
    });
    const receipt = sqlite
      .prepare('SELECT request_fingerprint AS fp, response_json AS json FROM mutation_receipts WHERE operation_key = ?')
      .get(operationId) as { fp: string; json: string } | undefined;
    if (receipt) {
      if (receipt.fp !== fingerprint) {
        return reply.code(409).send({ error: 'operation_key_conflict' });
      }
      return { link: JSON.parse(receipt.json), replayed: true };
    }

    const existing = sqlite
      .prepare(
        `SELECT id FROM capture_links
          WHERE from_capture_id = ? AND to_capture_id = ?`
      )
      .get(id, toCaptureId) as { id: string } | undefined;
    if (existing) {
      return reply.code(409).send({ error: 'duplicate_link', existingId: existing.id });
    }

    const t = Date.now();
    const link: LinkRow = {
      id: `link-${t}-${Math.random().toString(36).slice(2, 8)}`,
      fromCaptureId: id,
      toCaptureId,
      note: note || null,
      revision: 1,
      createdAt: t,
      updatedAt: t,
    };
    try {
      sqlite.transaction(() => {
        sqlite
          .prepare(
            `INSERT INTO capture_links
               (id, from_capture_id, to_capture_id, note, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`
          )
          .run(link.id, link.fromCaptureId, link.toCaptureId, link.note, t, t);
        sqlite
          .prepare(
            `INSERT INTO mutation_receipts
               (operation_key, target_type, request_fingerprint, response_json, created_at)
             VALUES (?, 'capture_link', ?, ?, ?)`
          )
          .run(operationId, fingerprint, JSON.stringify(link), t);
      })();
    } catch (err: any) {
      const raced = sqlite
        .prepare(
          'SELECT id FROM capture_links WHERE from_capture_id = ? AND to_capture_id = ?'
        )
        .get(id, toCaptureId) as { id: string } | undefined;
      if (raced) {
        return reply.code(409).send({ error: 'duplicate_link', existingId: raced.id });
      }
      throw err;
    }
    return { link, replayed: false };
  });

  // 解除手动关联（只删这一条关系，不影响任何记录正文）
  fastify.delete('/api/capture_links/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = sqlite
      .prepare(
        'SELECT id, from_capture_id AS fromCaptureId, to_capture_id AS toCaptureId FROM capture_links WHERE id = ?'
      )
      .all(id) as Array<{ id: string; fromCaptureId: string; toCaptureId: string }>;
    if (!row) return reply.code(404).send({ error: 'link_not_found' });
    sqlite.prepare('DELETE FROM capture_links WHERE id = ?').run(id);
    return { ok: true, deletedId: id, fromCaptureId: row.fromCaptureId, toCaptureId: row.toCaptureId };
  });

  // 念头详情里的尝试引用汇总：我参考了什么 / 后来哪里用过这条结果
  fastify.get('/api/captures/:id/references', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [capture] = sqlite
      .prepare('SELECT id FROM captures WHERE id = ?')
      .all(id) as Array<{ id: string }>;
    if (!capture) return reply.code(404).send({ error: 'capture_not_found' });

    const attemptRows = sqlite
      .prepare('SELECT id, step FROM attempts WHERE capture_id = ?')
      .all(id) as Array<{ id: string; step: string }>;
    const attemptIds = new Set(attemptRows.map((a) => a.id));
    if (attemptIds.size === 0) {
      return { captureId: id, out: [], in: [], counts: { out: 0, in: 0 } };
    }

    const outRows = sqlite
      .prepare(
        `SELECT r.id, r.note, r.snapshot_result_text AS snapshotResultText,
                r.snapshot_revision AS snapshotRevision, r.created_at AS createdAt,
                fa.id AS fromId, fa.step AS fromStep, fa.state AS fromState,
                ta.id AS toId, ta.step AS toStep, ta.state AS toState,
                ta.result_text AS toResultText, ta.outcome AS toOutcome, ta.revision AS toRevision,
                tc.id AS toCaptureId, tc.raw_text AS toCaptureText, tc.archived_at AS toArchivedAt
           FROM attempt_references r
           JOIN attempts fa ON fa.id = r.from_attempt_id
           JOIN attempts ta ON ta.id = r.to_attempt_id
           JOIN captures tc ON tc.id = ta.capture_id
          WHERE fa.capture_id = ?
          ORDER BY r.created_at DESC, r.id DESC`
      )
      .all(id) as any[];

    const inRows = sqlite
      .prepare(
        `SELECT r.id, r.note, r.snapshot_result_text AS snapshotResultText,
                r.snapshot_revision AS snapshotRevision, r.created_at AS createdAt,
                fa.id AS fromId, fa.step AS fromStep, fa.state AS fromState,
                fc.id AS fromCaptureId, fc.raw_text AS fromCaptureText,
                fc.archived_at AS fromArchivedAt,
                ta.id AS toId, ta.step AS toStep, ta.state AS toState,
                ta.result_text AS toResultText, ta.outcome AS toOutcome, ta.revision AS toRevision
           FROM attempt_references r
           JOIN attempts ta ON ta.id = r.to_attempt_id
           JOIN attempts fa ON fa.id = r.from_attempt_id
           JOIN captures fc ON fc.id = fa.capture_id
          WHERE ta.capture_id = ?
          ORDER BY r.created_at DESC, r.id DESC`
      )
      .all(id) as any[];

    return {
      captureId: id,
      out: outRows.map((r) => ({
        id: r.id,
        note: r.note,
        snapshotResultText: r.snapshotResultText,
        snapshotRevision: r.snapshotRevision,
        createdAt: r.createdAt,
        from: { id: r.fromId, step: r.fromStep, state: r.fromState },
        to: {
          id: r.toId,
          step: r.toStep,
          state: r.toState,
          resultText: r.toResultText,
          outcome: r.toOutcome,
          revision: r.toRevision,
          captureId: r.toCaptureId,
          captureText: r.toCaptureText,
          archived: Boolean(r.toArchivedAt),
          updatedSinceSnapshot: r.toRevision !== r.snapshotRevision,
        },
      })),
      in: inRows.map((r) => ({
        id: r.id,
        note: r.note,
        snapshotResultText: r.snapshotResultText,
        snapshotRevision: r.snapshotRevision,
        createdAt: r.createdAt,
        from: {
          id: r.fromId,
          step: r.fromStep,
          state: r.fromState,
          captureId: r.fromCaptureId,
          captureText: r.fromCaptureText,
          archived: Boolean(r.fromArchivedAt),
        },
        to: {
          id: r.toId,
          step: r.toStep,
          state: r.toState,
          resultText: r.toResultText,
          outcome: r.toOutcome,
          revision: r.toRevision,
        },
      })),
      counts: { out: outRows.length, in: inRows.length },
    };
  });
}
