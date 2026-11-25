// 把本地存储的行数据整理成前端现有契约里的形状。
import type {
  ActivityEvent,
  ActivityResponse,
  AskCandidate,
  AskSearchResponse,
  Attempt,
  Capture,
  CaptureLinkCandidatesResponse,
  CaptureLinkItem,
  CaptureLinksResponse,
  CaptureReferenceIn,
  CaptureReferenceOut,
  CaptureReferencesResponse,
  RecentAttempt,
  ReferenceFrom,
  ReferenceTo,
  ReviewDailyResponse,
  ReviewRecord,
  ReviewReason,
  ReviewRange,
  ReviewRangeResponse,
  ReviewStats,
  ScheduleBlock,
  SearchAttemptHit,
  SearchCaptureHit,
  Topic,
  TopicAskExperiencesResponse,
  TopicAttempt,
  TopicMember,
} from '../types';
import type {
  AttemptRow,
  CaptureRow,
  ExperienceRow,
  ScheduleRow,
  StandaloneDb,
  TopicRow,
} from './store';

export function labelOf(text: string, max = 34): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function snippetAround(text: string, query: string, pad = 32): string {
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return labelOf(text, 90);
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + q.length + pad);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function includesQuery(haystack: string | null | undefined, q: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(q.toLowerCase());
}

export function captureView(row: CaptureRow): Capture {
  return {
    id: row.id,
    rawText: row.rawText,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    kind: row.kind,
  };
}

export function attemptView(row: AttemptRow): Attempt {
  return {
    id: row.id,
    captureId: row.captureId,
    step: row.step,
    state: row.state,
    resultText: row.resultText,
    outcome: row.outcome,
    sourceUrl: row.sourceUrl,
    observedAt: row.observedAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    origin: row.origin,
    actionDescription: row.actionDescription,
    estimatedMinutes: row.estimatedMinutes,
    sourceReviewId: row.sourceReviewId,
    sourceAttemptId: row.sourceAttemptId,
    sourceAttemptRevision: row.sourceAttemptRevision,
    sourceExperienceId: row.sourceExperienceId,
  } as Attempt;
}

export function captureOf(db: StandaloneDb, id: string): CaptureRow | null {
  return db.captures.find((c) => c.id === id) ?? null;
}

export function attemptOf(db: StandaloneDb, id: string): AttemptRow | null {
  return db.attempts.find((a) => a.id === id) ?? null;
}

export function experienceOf(db: StandaloneDb, id: string): ExperienceRow | null {
  return db.experiences.find((e) => e.id === id) ?? null;
}

export function topicOf(db: StandaloneDb, id: string): TopicRow | null {
  return db.topics.find((t) => t.id === id) ?? null;
}

export function scheduleOf(db: StandaloneDb, id: string): ScheduleRow | null {
  return db.schedules.find((s) => s.id === id) ?? null;
}

export function recentAttemptView(db: StandaloneDb, row: AttemptRow): RecentAttempt {
  const capture = captureOf(db, row.captureId);
  return {
    ...attemptView(row),
    captureText: capture?.rawText ?? '',
    captureArchived: Boolean(capture?.archivedAt),
    captureArchivedAt: capture?.archivedAt ?? null,
  } as RecentAttempt;
}

export function captureLinkView(
  db: StandaloneDb,
  row: { id: string; fromCaptureId: string; toCaptureId: string; note: string | null; revision: number; createdAt: number; updatedAt: number },
  side: 'out' | 'in'
): CaptureLinkItem {
  const captureId = side === 'out' ? row.toCaptureId : row.fromCaptureId;
  const capture = captureOf(db, captureId);
  return {
    id: row.id,
    fromCaptureId: row.fromCaptureId,
    toCaptureId: row.toCaptureId,
    note: row.note,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    direction: side,
    capture: {
      id: captureId,
      rawText: capture?.rawText ?? '',
      summary: labelOf(capture?.rawText ?? '', 60),
      createdAt: capture?.createdAt ?? row.createdAt,
      updatedAt: capture?.updatedAt ?? row.updatedAt,
      archivedAt: capture?.archivedAt ?? null,
      archived: Boolean(capture?.archivedAt),
      kind: capture?.kind ?? 'thought',
      href: capture?.kind === 'experience' ? `/experience/${captureId}` : `/capture/${captureId}`,
    },
  };
}

export function captureLinksView(db: StandaloneDb, captureId: string): CaptureLinksResponse {
  const outRows = db.links.filter((l) => l.fromCaptureId === captureId);
  const inRows = db.links.filter((l) => l.toCaptureId === captureId);
  return {
    captureId,
    out: outRows.map((row) => captureLinkView(db, row, 'out')),
    in: inRows.map((row) => captureLinkView(db, row, 'in')),
    counts: { out: outRows.length, in: inRows.length },
  };
}

export function captureLinkCandidates(
  db: StandaloneDb,
  excludeId: string,
  query: string,
  limit: number
): CaptureLinkCandidatesResponse {
  const linked = new Set(
    db.links
      .filter((l) => l.fromCaptureId === excludeId || l.toCaptureId === excludeId)
      .map((l) => (l.fromCaptureId === excludeId ? l.toCaptureId : l.fromCaptureId))
  );
  const rows = db.captures
    .filter((c) => c.id !== excludeId && c.kind === 'thought' && (!query || includesQuery(c.rawText, query)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return {
    query,
    excludeId,
    total: rows.length,
    limit,
    captures: rows.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      summary: labelOf(c.rawText, 60),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archivedAt: c.archivedAt,
      archived: Boolean(c.archivedAt),
      kind: c.kind,
      snippet: snippetAround(c.rawText, query),
      alreadyLinked: linked.has(c.id),
      href: `/capture/${c.id}`,
    })),
  };
}

export function referencesView(db: StandaloneDb, attemptId: string): {
  fromRefs: ReferenceFrom[];
  toRefs: ReferenceTo[];
} {
  const fromRefs: ReferenceFrom[] = db.references
    .filter((r) => r.fromAttemptId === attemptId)
    .map((r) => {
      const target = attemptOf(db, r.toAttemptId);
      return {
        ...r,
        source: target
          ? {
              id: target.id,
              captureId: target.captureId,
              step: target.step,
              resultText: target.resultText,
              outcome: target.outcome,
              revision: target.revision,
              updatedSinceSnapshot: target.revision !== r.snapshotRevision,
            }
          : null,
      };
    });
  const toRefs: ReferenceTo[] = db.references
    .filter((r) => r.toAttemptId === attemptId)
    .map((r) => {
      const referencing = attemptOf(db, r.fromAttemptId);
      return {
        ...r,
        referencing: referencing
          ? {
              id: referencing.id,
              captureId: referencing.captureId,
              step: referencing.step,
              state: referencing.state,
              revision: referencing.revision,
            }
          : null,
      };
    });
  return { fromRefs, toRefs };
}

export function captureReferencesView(db: StandaloneDb, captureId: string): CaptureReferencesResponse {
  const attemptIds = new Set(
    db.attempts.filter((a) => a.captureId === captureId).map((a) => a.id)
  );
  const out: CaptureReferenceOut[] = db.references
    .filter((r) => attemptIds.has(r.fromAttemptId))
    .map((r) => {
      const from = attemptOf(db, r.fromAttemptId);
      const to = attemptOf(db, r.toAttemptId);
      const toCapture = to ? captureOf(db, to.captureId) : null;
      return {
        id: r.id,
        note: r.note,
        snapshotResultText: r.snapshotResultText,
        snapshotRevision: r.snapshotRevision,
        createdAt: r.createdAt,
        from: { id: r.fromAttemptId, step: from?.step ?? '', state: from?.state ?? 'todo' },
        to: {
          id: r.toAttemptId,
          step: to?.step ?? '（来源已删除）',
          state: to?.state ?? 'todo',
          resultText: to?.resultText ?? null,
          outcome: to?.outcome ?? null,
          revision: to?.revision ?? 0,
          captureId: to?.captureId ?? '',
          captureText: toCapture?.rawText ?? '',
          archived: Boolean(toCapture?.archivedAt),
          updatedSinceSnapshot: Boolean(to && to.revision !== r.snapshotRevision),
        },
      };
    });
  const inRefs: CaptureReferenceIn[] = db.references
    .filter((r) => attemptIds.has(r.toAttemptId))
    .map((r) => {
      const to = attemptOf(db, r.toAttemptId);
      const from = attemptOf(db, r.fromAttemptId);
      const fromCapture = from ? captureOf(db, from.captureId) : null;
      return {
        id: r.id,
        note: r.note,
        snapshotResultText: r.snapshotResultText,
        snapshotRevision: r.snapshotRevision,
        createdAt: r.createdAt,
        from: {
          id: r.fromAttemptId,
          step: from?.step ?? '（来源已删除）',
          state: from?.state ?? 'todo',
          captureId: from?.captureId ?? '',
          captureText: fromCapture?.rawText ?? '',
          archived: Boolean(fromCapture?.archivedAt),
        },
        to: {
          id: r.toAttemptId,
          step: to?.step ?? '',
          state: to?.state ?? 'todo',
          resultText: to?.resultText ?? null,
          outcome: to?.outcome ?? null,
          revision: to?.revision ?? 0,
        },
      };
    });
  return { captureId, out, in: inRefs, counts: { out: out.length, in: inRefs.length } };
}

export function experienceSourceView(db: StandaloneDb, sourceKey: string) {
  if (sourceKey.startsWith('attempt:')) {
    const id = sourceKey.slice('attempt:'.length);
    const attempt = attemptOf(db, id);
    const capture = attempt ? captureOf(db, attempt.captureId) : null;
    return {
      sourceKey,
      type: 'attempt' as const,
      id,
      captureId: attempt?.captureId ?? null,
      title: attempt ? labelOf(attempt.step, 42) : '（这条尝试已删除）',
      text: attempt?.step ?? '',
      resultText: attempt?.resultText ?? null,
      outcome: attempt?.outcome ?? null,
      state: attempt?.state ?? null,
      observedAt: attempt?.observedAt ?? null,
      deleted: !attempt,
      exists: Boolean(attempt),
      changed: false,
      kind: attempt ? 'attempt' : 'unknown',
      openHref: attempt ? `/attempt/${attempt.id}` : null,
      graphHref: attempt ? `/graph?node=${encodeURIComponent(`attempt:${attempt.id}`)}` : null,
      canReference: Boolean(attempt),
      addedAt: 0,
      captureText: capture?.rawText ?? '',
      captureArchived: Boolean(capture?.archivedAt),
      captureRevision: capture?.revision ?? 0,
    };
  }
  const id = sourceKey.slice('capture:'.length);
  const capture = captureOf(db, id);
  return {
    sourceKey,
    type: 'capture' as const,
    id,
    captureId: id,
    title: capture ? labelOf(capture.rawText, 42) : '（这条记录已删除）',
    text: capture?.rawText ?? '',
    resultText: null,
    outcome: null,
    state: null,
    observedAt: null,
    deleted: !capture,
    exists: Boolean(capture),
    changed: false,
    kind: capture ? (capture.kind === 'experience' ? 'experience' : 'thought') : 'unknown',
    openHref: capture
      ? capture.kind === 'experience'
        ? `/experience/${capture.id}`
        : `/capture/${capture.id}`
      : null,
    graphHref: capture
      ? `/graph?node=${encodeURIComponent(
          `${capture.kind === 'experience' ? 'experience' : 'capture'}:${capture.id}`
        )}`
      : null,
    canReference: Boolean(capture),
    addedAt: 0,
    captureText: capture?.rawText ?? '',
    captureArchived: Boolean(capture?.archivedAt),
    captureRevision: capture?.revision ?? 0,
  };
}

export function experienceSources(db: StandaloneDb, exp: ExperienceRow) {
  return exp.sources.map((s) => ({ ...experienceSourceView(db, s.sourceKey), addedAt: s.addedAt }));
}

export function experienceAttempts(db: StandaloneDb, exp: ExperienceRow) {
  return db.experienceAttempts
    .filter((a) => a.experienceId === exp.id)
    .map((link) => {
      const attempt = attemptOf(db, link.attemptId);
      return {
        id: link.attemptId,
        title: attempt?.step ?? '（这次尝试已删除）',
        state: attempt?.state ?? 'todo',
        resultText: attempt?.resultText ?? null,
        outcome: attempt?.outcome ?? null,
        observedAt: attempt?.observedAt ?? null,
        createdAt: attempt?.createdAt ?? 0,
        adoptedVersion: link.adoptedVersion,
        adoptedTitle: link.adoptedTitle,
        adoptedUnderstanding: link.adoptedUnderstanding,
        basisSourceKeys: link.basisSourceKeys,
        deleted: !attempt,
        exists: Boolean(attempt),
        archived: false,
        currentVersion: null,
        changed: Boolean(attempt && attempt.revision !== link.adoptedVersion),
      };
    });
}

export function experiencePublicView(db: StandaloneDb, exp: ExperienceRow) {
  const sources = experienceSources(db, exp);
  const attempts = experienceAttempts(db, exp);
  const deletedSourceCount = sources.filter((s) => s.deleted).length;
  return {
    id: exp.id,
    title: exp.title,
    understanding: exp.understanding,
    conditions: exp.conditions,
    limitations: exp.limitations,
    derivation: exp.derivation,
    needsRevision: exp.needsRevision,
    revisionReason: exp.revisionReason,
    revision: exp.revision,
    createdAt: exp.createdAt,
    updatedAt: exp.updatedAt,
    archivedAt: exp.archivedAt,
    archived: Boolean(exp.archivedAt),
    sources,
    sourceCount: sources.length,
    changedSourceCount: sources.filter((s) => s.changed).length,
    deletedSourceCount,
    hasPracticeResult: attempts.some((a) => Boolean(a.resultText && a.resultText.trim())),
    attempts,
    linkCount: sources.length,
    canEdit: !exp.archivedAt,
  };
}

export function experienceListItemView(exp: ExperienceRow) {
  return {
    id: exp.id,
    title: exp.title,
    summary: labelOf(exp.understanding, 80),
    conditions: exp.conditions,
    limitations: exp.limitations,
    revision: exp.revision,
    updatedAt: exp.updatedAt,
    createdAt: exp.createdAt,
    archived: Boolean(exp.archivedAt),
    needsRevision: exp.needsRevision,
    revisionReason: exp.revisionReason,
    sourceCount: exp.sources.length,
    attemptCount: exp.sources.filter((s) => s.type === 'attempt').length,
    hasPracticeResult: false,
    derivationBy: exp.derivation.by,
  };
}

function topicMembers(db: StandaloneDb, topicId: string): TopicMember[] {
  return db.topicMembers
    .filter((m) => m.topicId === topicId)
    .map((m) => {
      const capture = captureOf(db, m.captureId);
      const exp = db.experiences.find((e) => e.id === m.captureId) ?? null;
      if (exp) {
        return {
          captureId: m.captureId,
          type: 'experience' as const,
          title: exp.title,
          summary: labelOf(exp.understanding, 80),
          rawText: null,
          createdAt: exp.createdAt,
          updatedAt: exp.updatedAt,
          archived: Boolean(exp.archivedAt),
          archivedAt: exp.archivedAt,
          addedAt: m.addedAt,
          sourceCount: exp.sources.length,
          hasPracticeResult: false,
          needsRevision: exp.needsRevision,
          experienceId: exp.id,
          openHref: `/experience/${exp.id}`,
        };
      }
      return {
        captureId: m.captureId,
        type: 'thought' as const,
        title: capture ? labelOf(capture.rawText, 60) : '（这条记录已删除）',
        summary: capture ? labelOf(capture.rawText, 80) : '',
        rawText: capture?.rawText ?? null,
        createdAt: capture?.createdAt ?? m.addedAt,
        updatedAt: capture?.updatedAt ?? null,
        archived: Boolean(capture?.archivedAt),
        archivedAt: capture?.archivedAt ?? null,
        addedAt: m.addedAt,
        sourceCount: null,
        hasPracticeResult: false,
        needsRevision: false,
        experienceId: null,
        openHref: capture ? `/capture/${capture.id}` : null,
      };
    });
}

export function topicAttemptView(db: StandaloneDb, row: AttemptRow): TopicAttempt {
  const capture = captureOf(db, row.captureId);
  const recorded = Boolean(row.resultText && row.resultText.trim());
  return {
    ...attemptView(row),
    captureText: capture?.rawText ?? '',
    captureArchived: Boolean(capture?.archivedAt),
    captureArchivedAt: capture?.archivedAt ?? null,
    resultRecorded: recorded,
    resultState:
      row.state === 'cancelled' ? 'cancelled' : recorded ? 'recorded' : 'pending_no_result',
    href: `/attempt/${row.id}`,
  } as TopicAttempt;
}

export function topicView(db: StandaloneDb, topic: TopicRow): Topic {
  const members = topicMembers(db, topic.id);
  const thoughtMembers = members.filter((m) => m.type === 'thought');
  const memberAttempts = db.attempts
    .filter((a) => thoughtMembers.some((m) => m.captureId === a.captureId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  let nextAttempt: TopicAttempt | null = null;
  let clearedReason = topic.nextAttemptClearedReason;
  if (topic.nextAttemptId) {
    const fixed = attemptOf(db, topic.nextAttemptId);
    const belongs = fixed && thoughtMembers.some((m) => m.captureId === fixed.captureId);
    if (fixed && belongs) {
      nextAttempt = topicAttemptView(db, fixed);
    } else {
      clearedReason = fixed ? '这条尝试已不在主题范围' : '固定的尝试已删除';
    }
  }
  return {
    id: topic.id,
    name: topic.name,
    exploringQuestion: topic.exploringQuestion,
    continueNote: topic.continueNote,
    revision: topic.revision,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    archivedAt: topic.archivedAt,
    archived: Boolean(topic.archivedAt),
    memberCount: members.length,
    thoughtCount: thoughtMembers.length,
    experienceCount: members.length - thoughtMembers.length,
    attemptCount: memberAttempts.length,
    recordCount: members.length + memberAttempts.length,
    lastAttemptAt: memberAttempts[0]?.updatedAt ?? null,
    nextAttempt,
    nextAttemptClearedReason: clearedReason,
    members,
  };
}

export function scheduleView(db: StandaloneDb, row: ScheduleRow): ScheduleBlock {
  const attempt = attemptOf(db, row.attemptId);
  const capture = attempt ? captureOf(db, attempt.captureId) : null;
  return {
    id: row.id,
    attemptId: row.attemptId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    note: row.note,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
    attempt: attempt
      ? {
          id: attempt.id,
          step: attempt.step,
          state: attempt.state,
          captureId: attempt.captureId,
          origin: attempt.origin,
          sourceReviewId: attempt.sourceReviewId,
        }
      : null,
    capture: capture ? { id: capture.id, rawText: capture.rawText } : null,
  };
}

// ---------- 搜索 ----------

export function searchResults(db: StandaloneDb, query: string) {
  const q = query.trim();
  const captures: SearchCaptureHit[] = q
    ? db.captures
        .filter((c) => c.kind === 'thought' && includesQuery(c.rawText, q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) => ({
          id: c.id,
          rawText: c.rawText,
          archived: Boolean(c.archivedAt),
          snippet: snippetAround(c.rawText, q),
          matchField: 'rawText',
        }))
    : [];
  const attempts: SearchAttemptHit[] = q
    ? db.attempts
        .filter((a) => includesQuery(a.step, q) || includesQuery(a.resultText, q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((a) => {
          const inStep = includesQuery(a.step, q);
          const source = inStep ? a.step : (a.resultText ?? '');
          return {
            id: a.id,
            captureId: a.captureId,
            step: a.step,
            state: a.state,
            resultText: a.resultText,
            outcome: a.outcome,
            snippet: snippetAround(source, q),
            matchField: inStep ? 'step' : 'resultText',
          };
        })
    : [];
  const experiences = q
    ? db.experiences
        .filter(
          (e) =>
            includesQuery(e.title, q) ||
            includesQuery(e.understanding, q) ||
            includesQuery(e.conditions, q) ||
            includesQuery(e.limitations, q)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((e) => {
          const field = includesQuery(e.title, q)
            ? e.title
            : includesQuery(e.understanding, q)
              ? e.understanding
              : includesQuery(e.conditions, q)
                ? e.conditions
                : e.limitations;
          return {
            ...experienceListItemView(e),
            matchReason: '经验正文',
            snippet: snippetAround(field, q),
          };
        })
    : [];
  return { query: q, captures, attempts, experiences };
}

// ---------- 动态 ----------

export function activityView(
  db: StandaloneDb,
  options: { type?: string; limit?: number }
): ActivityResponse {
  const events: ActivityEvent[] = [];
  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    events.push({
      id: `capture:${c.id}`,
      type: 'capture',
      action: '记下念头',
      at: c.createdAt,
      title: labelOf(c.rawText, 40),
      text: c.rawText,
      detail: null,
      captureId: c.id,
      attemptId: null,
      outcome: null,
      kind: null,
    });
    if (c.updatedAt > c.createdAt) {
      events.push({
        id: `capture-update:${c.id}`,
        type: 'capture',
        action: '修改念头',
        at: c.updatedAt,
        title: labelOf(c.rawText, 40),
        text: c.rawText,
        detail: null,
        captureId: c.id,
        attemptId: null,
        outcome: null,
        kind: null,
      });
    }
  }
  for (const a of db.attempts) {
    const capture = captureOf(db, a.captureId);
    events.push({
      id: `attempt:${a.id}`,
      type: 'attempt',
      action: '发起尝试',
      at: a.createdAt,
      title: labelOf(a.step, 40),
      text: a.step,
      detail: null,
      captureId: a.captureId,
      attemptId: a.id,
      outcome: null,
      kind: null,
    });
    if (a.resultText && a.resultText.trim()) {
      events.push({
        id: `result:${a.id}`,
        type: 'result',
        action: '记录结果',
        at: a.observedAt ?? a.updatedAt,
        title: labelOf(a.step, 40),
        text: a.resultText,
        detail: capture ? labelOf(capture.rawText, 40) : null,
        captureId: a.captureId,
        attemptId: a.id,
        outcome: a.outcome,
        kind: null,
      });
    }
  }
  for (const r of db.references) {
    const from = attemptOf(db, r.fromAttemptId);
    events.push({
      id: `reference:${r.id}`,
      type: 'reference',
      action: '新建引用',
      at: r.createdAt,
      title: from ? labelOf(from.step, 40) : '引用了一次尝试',
      text: r.note ?? '',
      detail: null,
      captureId: from?.captureId ?? '',
      attemptId: r.fromAttemptId,
      outcome: null,
      kind: null,
    });
  }
  const filtered = options.type && options.type !== 'all'
    ? events.filter((e) => e.type === options.type)
    : events;
  filtered.sort((a, b) => b.at - a.at);
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const counts: Record<string, number> = { all: events.length };
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    generatedAt: Date.now(),
    total: filtered.length,
    events: filtered.slice(0, limit),
    stats: {
      totalEvents: events.length,
      last7Days: events.filter((e) => e.at >= weekAgo).length,
      captures: counts.capture ?? 0,
      attempts: counts.attempt ?? 0,
      results: counts.result ?? 0,
      references: counts.reference ?? 0,
      aiRequests: 0,
      aiAdopted: 0,
    },
    filters: [
      { type: 'all', label: '全部', count: counts.all ?? 0 },
      { type: 'capture', label: '念头', count: counts.capture ?? 0 },
      { type: 'attempt', label: '尝试', count: counts.attempt ?? 0 },
      { type: 'result', label: '结果', count: counts.result ?? 0 },
      { type: 'reference', label: '引用', count: counts.reference ?? 0 },
      { type: 'ai', label: 'AI', count: 0 },
    ],
  };
}

// ---------- 阶段回顾 ----------

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatInZone(ts: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function localDateInZone(ts: number, timezone: string): string {
  return formatInZone(ts, timezone).slice(0, 10);
}

export function buildRange(
  from: number,
  to: number,
  timezone: string,
  preset: '7d' | '30d' | 'custom'
): ReviewRange {
  return {
    from,
    to,
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to).toISOString(),
    fromLocal: formatInZone(from, timezone),
    toLocal: formatInZone(to, timezone),
    timezone,
    preset,
    days: Math.max(1, Math.round((to - from) / 86400000)),
    endExclusive: true,
  };
}

function reviewRecordBase(type: ReviewRecord['type'], sourceId: string) {
  return {
    key: `${type}:${sourceId}`,
    type,
    sourceId,
    relatedAttemptId: null,
    createdAt: 0,
    updatedAt: null,
    observedAt: null,
    relatedRevision: null,
    reasons: [] as ReviewReason[],
    fromAttemptId: null,
    toAttemptId: null,
    note: null,
  };
}

export function reviewRangeData(
  db: StandaloneDb,
  input: { from: number; to: number; timezone: string; preset: '7d' | '30d' | 'custom' }
): ReviewRangeResponse {
  const { from, to, timezone, preset } = input;
  const inRange = (ts: number | null | undefined) => ts != null && ts >= from && ts < to;
  const records: ReviewRecord[] = [];

  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    const reasons: ReviewReason[] = [];
    if (inRange(c.createdAt)) reasons.push('capture_created');
    if (c.updatedAt > c.createdAt && inRange(c.updatedAt)) reasons.push('capture_modified');
    if (!reasons.length) continue;
    records.push({
      ...reviewRecordBase('capture', c.id),
      captureId: c.id,
      attemptId: null,
      title: labelOf(c.rawText, 40),
      text: c.rawText,
      resultText: null,
      outcome: null,
      state: null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt > c.createdAt ? c.updatedAt : null,
      revision: c.revision,
      captureRevision: c.revision,
      archived: Boolean(c.archivedAt),
      reasons,
    });
  }

  for (const a of db.attempts) {
    const capture = captureOf(db, a.captureId);
    const reasons: ReviewReason[] = [];
    if (inRange(a.createdAt)) reasons.push('attempt_started');
    if (a.updatedAt > a.createdAt && inRange(a.updatedAt)) reasons.push('attempt_modified');
    if (a.state === 'done' || a.state === 'cancelled') {
      if (inRange(a.updatedAt)) reasons.push('attempt_current_ended');
    }
    if (a.resultText && a.resultText.trim()) {
      if (a.observedAt != null) {
        if (inRange(a.observedAt)) reasons.push('result_recorded');
      } else if (inRange(a.updatedAt)) {
        reasons.push('result_time_unknown');
      }
    }
    if (!reasons.length) continue;
    records.push({
      ...reviewRecordBase('attempt', a.id),
      captureId: a.captureId,
      attemptId: a.id,
      title: labelOf(a.step, 40),
      text: a.step,
      resultText: a.resultText,
      outcome: a.outcome,
      state: a.state,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt > a.createdAt ? a.updatedAt : null,
      observedAt: a.observedAt,
      revision: a.revision,
      captureRevision: capture?.revision ?? 1,
      archived: Boolean(capture?.archivedAt),
      reasons,
    });
  }

  for (const r of db.references) {
    if (!inRange(r.createdAt)) continue;
    const fromAttempt = attemptOf(db, r.fromAttemptId);
    records.push({
      ...reviewRecordBase('reference', r.id),
      captureId: fromAttempt?.captureId ?? '',
      attemptId: r.fromAttemptId,
      relatedAttemptId: r.toAttemptId,
      title: '引用了一次尝试结果',
      text: r.note ?? '',
      resultText: r.snapshotResultText,
      outcome: null,
      state: null,
      createdAt: r.createdAt,
      revision: r.revision,
      captureRevision: 1,
      relatedRevision: r.snapshotRevision,
      archived: false,
      reasons: ['reference_created'],
      fromAttemptId: r.fromAttemptId,
      toAttemptId: r.toAttemptId,
      note: r.note,
    });
  }

  const stats: ReviewStats = {
    capturesCreated: records.filter((r) => r.reasons.includes('capture_created')).length,
    capturesModified: records.filter((r) => r.reasons.includes('capture_modified')).length,
    attemptsStarted: records.filter((r) => r.reasons.includes('attempt_started')).length,
    attemptsModified: records.filter((r) => r.reasons.includes('attempt_modified')).length,
    attemptsCurrentlyEnded: records.filter((r) => r.reasons.includes('attempt_current_ended')).length,
    resultsRecorded: records.filter((r) => r.reasons.includes('result_recorded')).length,
    resultsMissingObservedAt: records.filter((r) => r.reasons.includes('result_time_unknown')).length,
    referencesCreated: records.filter((r) => r.reasons.includes('reference_created')).length,
    totalRecords: records.length,
  };

  const sections = {
    captures: records.filter((r) => r.type === 'capture').map((r) => r.title),
    attempts: records.filter((r) => r.type === 'attempt').map((r) => r.title),
    results: records.filter((r) => r.resultText).map((r) => r.title),
    references: records.filter((r) => r.type === 'reference').map((r) => r.title),
    modifications: records.filter((r) => r.reasons.includes('capture_modified') || r.reasons.includes('attempt_modified')).map((r) => r.title),
  };

  return {
    range: buildRange(from, to, timezone, preset),
    stats,
    statDefinitions: [
      { key: 'capturesCreated', label: '新念头', value: stats.capturesCreated, definition: '范围内新建的念头' },
      { key: 'attemptsStarted', label: '新尝试', value: stats.attemptsStarted, definition: '范围内发起的尝试' },
      { key: 'resultsRecorded', label: '记录结果', value: stats.resultsRecorded, definition: '范围内写下实际观察' },
      { key: 'referencesCreated', label: '新引用', value: stats.referencesCreated, definition: '范围内创建的尝试引用' },
    ],
    records,
    sections,
    coverage: {
      totalRecords: records.length,
      uniqueKeys: new Set(records.map((r) => r.key)).size,
      truncated: false,
      maxRangeRecords: 500,
    },
    limits: { maxRecords: 500, maxChars: 16000, maxRangeDays: 366 },
    ai: { configured: false, enabled: false, config: null },
    generatedAt: Date.now(),
  };
}

export function reviewDailyData(
  db: StandaloneDb,
  input: { from: number; to: number; timezone: string; preset: '7d' | '30d' | 'custom' }
): ReviewDailyResponse {
  const { from, to, timezone, preset } = input;
  const dayMap = new Map<string, { capturesCount: number; attemptsCount: number }>();
  const ensure = (date: string) => {
    if (!dayMap.has(date)) dayMap.set(date, { capturesCount: 0, attemptsCount: 0 });
    return dayMap.get(date)!;
  };
  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    if (c.createdAt >= from && c.createdAt < to) ensure(localDateInZone(c.createdAt, timezone)).capturesCount += 1;
  }
  for (const a of db.attempts) {
    if (a.createdAt >= from && a.createdAt < to) ensure(localDateInZone(a.createdAt, timezone)).attemptsCount += 1;
  }
  const days = [];
  const cursor = new Date(from);
  while (cursor.getTime() < to) {
    const date = localDateInZone(cursor.getTime(), timezone);
    const hit = dayMap.get(date);
    days.push({
      date,
      capturesCount: hit?.capturesCount ?? 0,
      attemptsCount: hit?.attemptsCount ?? 0,
      aiCount: 0,
      aiTokens: 0,
      aiBreakdown: { generations: 0, reviews: 0, asks: 0, research: 0 },
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return {
    range: buildRange(from, to, timezone, preset),
    today: localDateInZone(Date.now(), timezone),
    days,
  };
}

// ---------- 问我的记录：本地候选检索 ----------

export function askCandidates(
  db: StandaloneDb,
  params: {
    question: string;
    keywords: string[];
    limit: number;
    from?: number | null;
    to?: number | null;
    captureIdFilter?: Set<string> | null;
  }
): AskCandidate[] {
  const terms = [params.question, ...params.keywords]
    .join(' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const matchText = (text: string | null) =>
    terms.length === 0 ? false : terms.some((t) => includesQuery(text, t));
  const inRange = (ts: number | null) =>
    ts == null ||
    ((params.from == null || ts >= params.from) && (params.to == null || ts < params.to));
  const candidates: AskCandidate[] = [];
  const allowed = params.captureIdFilter;

  for (const a of db.attempts) {
    if (allowed && !allowed.has(a.captureId)) continue;
    if (!matchText(a.step) && !matchText(a.resultText)) continue;
    if (!inRange(a.observedAt ?? a.createdAt)) continue;
    const capture = captureOf(db, a.captureId);
    candidates.push({
      sourceKey: `attempt:${a.id}`,
      type: 'attempt',
      id: a.id,
      captureId: a.captureId,
      title: labelOf(a.step, 40),
      snippet: snippetAround(a.resultText || a.step, terms[0] ?? ''),
      date: a.observedAt ?? a.createdAt,
      dateKind: a.observedAt != null ? 'observed' : 'created',
      state: a.state,
      outcome: a.outcome,
      archived: Boolean(capture?.archivedAt),
      matchReasons: ['本地检索命中'],
      matchKind: 'direct',
      referenceCount: db.references.filter((r) => r.toAttemptId === a.id).length,
      openHref: `/attempt/${a.id}`,
    });
  }
  for (const c of db.captures) {
    if (c.kind !== 'thought') continue;
    if (allowed && !allowed.has(c.id)) continue;
    if (!matchText(c.rawText)) continue;
    if (!inRange(c.createdAt)) continue;
    candidates.push({
      sourceKey: `capture:${c.id}`,
      type: 'capture',
      id: c.id,
      captureId: c.id,
      title: labelOf(c.rawText, 40),
      snippet: snippetAround(c.rawText, terms[0] ?? ''),
      date: c.createdAt,
      dateKind: 'created',
      state: null,
      outcome: null,
      archived: Boolean(c.archivedAt),
      matchReasons: ['本地检索命中'],
      matchKind: 'direct',
      referenceCount: db.attempts.filter((a) => a.captureId === c.id).length,
      openHref: `/capture/${c.id}`,
    });
  }
  candidates.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return candidates.slice(0, params.limit);
}

export function askSearchResponse(
  db: StandaloneDb,
  params: {
    question: string;
    keywords: string[];
    limit: number;
    from?: number | null;
    to?: number | null;
    captureIdFilter?: Set<string> | null;
  }
): AskSearchResponse {
  const candidates = askCandidates(db, params);
  return {
    question: params.question,
    keywords: params.keywords,
    suggestedKeywords: '',
    range: {
      from: params.from ?? null,
      to: params.to ?? null,
      fromLocal: params.from != null ? formatInZone(params.from, 'Asia/Shanghai') : null,
      toLocal: params.to != null ? formatInZone(params.to, 'Asia/Shanghai') : null,
    },
    total: candidates.length,
    limit: params.limit,
    candidates,
    ai: { configured: false, enabled: false, config: null },
    generatedAt: Date.now(),
  };
}

const SOURCE_REASON = '经验依据';

export function topicAskExperiences(db: StandaloneDb, topicId: string): TopicAskExperiencesResponse {
  const topic = topicOf(db, topicId);
  if (!topic) return { topic: null, experiences: [] };
  const members = db.topicMembers.filter((m) => m.topicId === topicId);
  const experiences = db.experiences
    .filter((e) => members.some((m) => m.captureId === e.id))
    .map((e) => {
      const sources = experienceSources(db, e).map((s) => ({
        sourceKey: s.sourceKey,
        type: s.type,
        id: s.id,
        captureId: s.captureId ?? '',
        title: s.title,
        text: s.text,
        resultText: s.resultText,
        outcome: s.outcome,
        state: s.state,
        observedAt: s.observedAt,
        archived: false,
        deleted: s.deleted,
        originLabel: SOURCE_REASON,
        openHref: s.openHref,
      }));
      return {
        id: e.id,
        title: e.title,
        summary: labelOf(e.understanding, 80),
        needsRevision: e.needsRevision,
        hasPracticeResult: false,
        sourceCount: sources.length,
        derivationBy: e.derivation.by,
        selectableSourceKeys: sources.filter((s) => !s.deleted).map((s) => s.sourceKey),
        sources,
      };
    });
  return { topic: { id: topic.id, name: topic.name }, experiences };
}