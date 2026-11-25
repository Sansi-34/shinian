// 拾念 SHINIAN v0.1 - API 客户端
import type {
  ActivityResponse,
  AiConfig,
  AiGeneration,
  AiModelsResponse,
  AiSettings,
  AssistCaptureResponse,
  AiTestResult,
  Attempt,
  AttemptReference,
  RecentAttempt,
  Capture,
  CaptureLinkCandidatesResponse,
  CaptureLinkItem,
  CaptureLinksResponse,
  CaptureReferencesResponse,
  CreateAttemptInput,
  CreateReviewInput,
  DeletePreview,
  ExperienceCandidatesResponse,
  ExperiencePreview,
  ReferenceFrom,
  ReferenceTo,
  CreateNextActionInput,
  NextAction,
  NextActionPreview,
  UpdateNextActionInput,
  ReviewDailyResponse,
  ReviewListItem,
  ReviewPreviewInput,
  ReviewPreviewResponse,
  ReviewPublic,
  ReviewRangeInput,
  ReviewRangeResponse,
  SaveAiSettingsInput,
  ScheduleCancelResponse,
  ScheduleCreateResponse,
  ScheduleRangeResponse,
  ScheduleUpdateResponse,
  CreateScheduleInput,
  UpdateScheduleInput,
  AttemptDeletePreview,
  AttemptSchedulesResponse,
  FutureScheduleAction,
  SearchAttemptHit,
  SearchCaptureHit,
  SearchExperienceHit,
  ResearchPreview,
  ResearchPublic,
  ResearchListItem,
  ResearchSearchInput,
  ResearchConstraints,
  ResearchAttemptDetail,
  GraphResponse,
  GraphNodeType,
  GraphSearchResponse,
  AskSearchParams,
  AskSearchResponse,
  AskPreviewInput,
  AskPreviewResponse,
  CreateAskQueryInput,
  AskPublic,
  AskListItem,
  AskCandidate,
  AskKeywordSuggestInput,
  AskKeywordSuggestionsResponse,
  ExperiencePublic,
  ExperienceListItem,
  ExperienceDraft,
  ExperienceDraftSource,
  ExperienceAttemptRef,
  ExperienceDeletePreview,
  AddTopicMembersResponse,
  CaptureTopicsResponse,
  CreateTopicInput,
  Topic,
  TopicAskCandidatesResponse,
  TopicAskExperiencesResponse,
  TopicAttempt,
  TopicAttemptsResponse,
  TopicDeletePreview,
  TopicMember,
  TopicMemberCandidatesResponse,
  TopicMemberType,
  TopicExportBasisCandidate,
  TopicExportDownloadInput,
  TopicExportDownloadResult,
  TopicExportEntityType,
  TopicExportFileEntry,
  TopicExportLimitKey,
  TopicExportPreview,
  TopicExportPreviewInput,
  UpdateTopicInput,
} from './types';

const API_BASE = '/api';

// 线上体验版（Qoder Site）不接后端，请求改为读写访问者浏览器里的 localStorage。
const STANDALONE_MODE = import.meta.env.VITE_SHINIAN_STANDALONE === '1';

// 本地时间戳：shinian-export-YYYYMMDD-HHmmss.json
function exportStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `请求失败 (${status})`);
    this.status = status;
    this.body = body ?? {};
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (STANDALONE_MODE) {
    const { localRequest } = await import('./standalone');
    const { status, body } = await localRequest(path, options);
    if (status >= 400) throw new ApiError(status, body);
    return body as T;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      // 无请求体时不要声明 JSON，避免服务端把空 body 当作非法 JSON
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

// ---------- 主题：集中适配层 ----------
// 后端契约字段可能随实现调整；页面只依赖这里的 Topic 结构。
// 兼容：topic 包装、members 数组或 thoughts/experiences 分组、nextAttempt 为空等。

function topicNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function topicNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function topicText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTopicAttempt(raw: any): TopicAttempt {
  const attempt = raw?.attempt ?? raw ?? {};
  const capture = raw?.capture ?? attempt?.capture ?? {};
  return {
    ...attempt,
    id: String(attempt.id ?? attempt.attemptId ?? raw?.attemptId ?? ''),
    captureId: String(attempt.captureId ?? raw?.captureId ?? capture.id ?? ''),
    step: topicText(attempt.step ?? attempt.title ?? raw?.step),
    state: attempt.state ?? raw?.state ?? 'todo',
    resultText: attempt.resultText ?? raw?.resultText ?? null,
    outcome: attempt.outcome ?? raw?.outcome ?? null,
    sourceUrl: attempt.sourceUrl ?? raw?.sourceUrl ?? null,
    observedAt: topicNullableNumber(attempt.observedAt ?? raw?.observedAt),
    revision: topicNumber(attempt.revision ?? raw?.revision, 1),
    createdAt: topicNumber(attempt.createdAt ?? raw?.createdAt),
    updatedAt: topicNumber(attempt.updatedAt ?? raw?.updatedAt, topicNumber(attempt.createdAt ?? raw?.createdAt)),
    captureText: topicText(
      raw?.captureTitle ??
        raw?.captureText ??
        capture.rawText ??
        raw?.capture?.title ??
        attempt.captureText
    ),
    captureArchived: Boolean(raw?.captureArchived ?? capture.archived ?? capture.archivedAt != null),
    captureArchivedAt: topicNullableNumber(raw?.captureArchivedAt ?? capture.archivedAt),
    resultRecorded:
      typeof raw?.resultRecorded === 'boolean'
        ? raw.resultRecorded
        : typeof attempt.resultRecorded === 'boolean'
          ? attempt.resultRecorded
          : raw?.resultState === 'recorded'
            ? true
            : raw?.resultState === 'pending_no_result'
              ? false
              : undefined,
    resultState:
      raw?.resultState === 'recorded' ||
      raw?.resultState === 'pending_no_result' ||
      raw?.resultState === 'cancelled'
        ? raw.resultState
        : undefined,
    href:
      typeof raw?.href === 'string'
        ? raw.href
        : `/attempt/${attempt.id ?? attempt.attemptId ?? raw?.attemptId ?? ''}`,
  };
}

function normalizeTopicMember(raw: any, typeHint?: TopicMemberType): TopicMember {
  const capture = raw?.capture ?? raw ?? {};
  const kind = typeHint ?? raw?.type ?? raw?.kind ?? capture?.kind;
  const type: TopicMemberType = kind === 'experience' ? 'experience' : 'thought';
  const title =
    raw?.title ??
    capture?.title ??
    (type === 'experience' ? '（未命名经验）' : topicText(capture?.rawText ?? raw?.rawText).slice(0, 60));
  const summary = raw?.summary ?? capture?.summary ?? capture?.rawText ?? raw?.rawText ?? '';
  return {
    captureId: String(raw?.captureId ?? raw?.id ?? capture?.id ?? raw?.experienceId ?? ''),
    type,
    title: topicText(title) || '（无标题）',
    summary: topicText(summary),
    rawText: typeof capture?.rawText === 'string' ? capture.rawText : null,
    createdAt: topicNumber(raw?.createdAt ?? capture?.createdAt),
    updatedAt: topicNullableNumber(raw?.updatedAt ?? capture?.updatedAt),
    archived: Boolean(raw?.archived ?? capture?.archived ?? capture?.archivedAt != null),
    archivedAt: topicNullableNumber(raw?.archivedAt ?? capture?.archivedAt),
    addedAt: topicNullableNumber(raw?.addedAt ?? raw?.joinedAt),
    sourceCount:
      type === 'experience'
        ? topicNullableNumber(raw?.sourceCount ?? raw?.evidenceCount)
        : null,
    hasPracticeResult: Boolean(raw?.hasPracticeResult),
    needsRevision: Boolean(raw?.needsRevision ?? raw?.needs_revision),
    experienceId:
      type === 'experience'
        ? String(raw?.experienceId ?? raw?.id ?? capture?.id ?? '')
        : null,
    openHref:
      typeof raw?.href === 'string'
        ? raw.href
        : typeof raw?.openHref === 'string'
          ? raw.openHref
          : type === 'experience'
            ? `/experience/${raw?.experienceId ?? raw?.id ?? capture?.id ?? ''}`
            : `/capture/${raw?.captureId ?? raw?.id ?? capture?.id ?? ''}`,
  };
}

export function normalizeTopic(raw: any): Topic {
  const topic = raw?.topic ?? raw ?? {};
  const membersRaw = topic.memberList ?? topic.items ?? (Array.isArray(topic.members) ? topic.members : []);
  const groupedThoughts = topic.thoughts ?? topic.thoughtMembers ?? [];
  const groupedExperiences = topic.experiences ?? topic.experienceMembers ?? [];
  let members: TopicMember[] = [];
  if (Array.isArray(membersRaw)) {
    members = membersRaw.map((item: any) => normalizeTopicMember(item));
  }
  if (Array.isArray(groupedThoughts) && groupedThoughts.length > 0) {
    members = [
      ...members.filter((item) => item.type !== 'thought'),
      ...groupedThoughts.map((item: any) => normalizeTopicMember(item, 'thought')),
    ];
  }
  if (Array.isArray(groupedExperiences) && groupedExperiences.length > 0) {
    members = [
      ...members.filter((item) => item.type !== 'experience'),
      ...groupedExperiences.map((item: any) => normalizeTopicMember(item, 'experience')),
    ];
  }
  const thoughtCount = topicNumber(
    topic.thoughtCount,
    members.filter((item) => item.type === 'thought').length
  );
  const experienceCount = topicNumber(
    topic.experienceCount,
    members.filter((item) => item.type === 'experience').length
  );
  const archivedAt = topicNullableNumber(topic.archivedAt);
  const rawNext = topic.nextAttempt ?? topic.next_attempt ?? null;
  const nextAttempt = rawNext ? normalizeTopicAttempt(rawNext) : null;
  return {
    id: String(topic.id ?? topic.topicId ?? ''),
    name: topicText(topic.name ?? topic.title),
    exploringQuestion:
      typeof topic.exploringQuestion === 'string'
        ? topic.exploringQuestion
        : typeof topic.exploring_question === 'string'
          ? topic.exploring_question
          : null,
    continueNote:
      typeof topic.continueNote === 'string'
        ? topic.continueNote
        : typeof topic.continue_note === 'string'
          ? topic.continue_note
          : null,
    revision: topicNumber(topic.revision, 1),
    createdAt: topicNumber(topic.createdAt),
    updatedAt: topicNumber(topic.updatedAt, topicNumber(topic.createdAt)),
    archivedAt,
    archived: archivedAt != null || topic.archived === true,
    memberCount: topicNumber(topic.memberCount, members.length),
    thoughtCount,
    experienceCount,
    attemptCount: topicNumber(topic.attemptCount),
    recordCount: topicNumber(topic.recordCount, thoughtCount + topicNumber(topic.attemptCount)),
    lastAttemptAt: topicNullableNumber(topic.latestAttemptAt ?? topic.lastAttemptAt),
    nextAttempt,
    nextAttemptClearedReason:
      typeof topic.nextAttemptClearedReason === 'string'
        ? topic.nextAttemptClearedReason
        : typeof topic.clearedReason === 'string'
          ? topic.clearedReason
          : null,
    members,
  };
}

function normalizeTopicCandidate(raw: any, alreadyIds?: Set<string>): any {
  const capture = raw?.capture ?? raw ?? {};
  const kind = raw?.type ?? raw?.kind ?? capture?.kind;
  const type: TopicMemberType = kind === 'experience' ? 'experience' : 'thought';
  const id = String(raw?.captureId ?? raw?.id ?? capture?.id ?? raw?.experienceId ?? '');
  return {
    captureId: id,
    type,
    title:
      topicText(raw?.title ?? capture?.title) ||
      (type === 'experience' ? '（未命名经验）' : topicText(capture?.rawText ?? raw?.rawText).slice(0, 60)),
    summary: topicText(raw?.summary ?? capture?.summary ?? capture?.rawText ?? raw?.rawText),
    createdAt: topicNumber(raw?.createdAt ?? capture?.createdAt),
    updatedAt: topicNullableNumber(raw?.updatedAt ?? capture?.updatedAt),
    archived: Boolean(raw?.archived ?? capture?.archived ?? capture?.archivedAt != null),
    sourceCount: type === 'experience' ? topicNullableNumber(raw?.sourceCount ?? raw?.evidenceCount) : null,
    hasPracticeResult: Boolean(raw?.hasPracticeResult),
    needsRevision: Boolean(raw?.needsRevision),
    alreadyMember: Boolean(raw?.alreadyMember ?? (alreadyIds ? alreadyIds.has(id) : false)),
    openHref:
      typeof raw?.openHref === 'string'
        ? raw.openHref
        : type === 'experience'
          ? `/experience/${raw?.experienceId ?? raw?.id ?? capture?.id ?? ''}`
          : `/capture/${id}`,
  };
}

function normalizeTopicList(data: any): {
  topics: Topic[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
  offset: number;
  limit: number;
} {
  const rawList = Array.isArray(data) ? data : data?.topics ?? data?.items ?? data?.results ?? [];
  const topics = (Array.isArray(rawList) ? rawList : []).map((item: any) => normalizeTopic(item));
  const nextCursor =
    typeof data?.nextCursor === 'string'
      ? data.nextCursor
      : typeof data?.next_cursor === 'string'
        ? data.next_cursor
        : null;
  return {
    topics,
    nextCursor,
    hasMore: Boolean(data?.hasMore ?? data?.has_more ?? nextCursor),
    total: typeof data?.total === 'number' ? data.total : null,
    offset: topicNumber(data?.offset),
    limit: topicNumber(data?.limit, 20),
  };
}

function normalizeTopicAskCandidates(
  data: any,
  topicId: string,
  topicName: string
): TopicAskCandidatesResponse {
  const search = data?.search ?? data ?? {};
  const candidatesRaw = data?.candidates ?? search?.candidates ?? [];
  const candidates: AskCandidate[] = (Array.isArray(candidatesRaw) ? candidatesRaw : []).map((item: any) => ({
    sourceKey: String(item?.sourceKey ?? ''),
    type: item?.type === 'capture' ? 'capture' : 'attempt',
    id: String(item?.id ?? ''),
    captureId: String(item?.captureId ?? ''),
    title: topicText(item?.title),
    snippet: topicText(item?.snippet),
    date: topicNullableNumber(item?.date),
    dateKind: item?.dateKind === 'created' ? 'created' : 'observed',
    state: item?.state ?? null,
    outcome: item?.outcome ?? null,
    archived: Boolean(item?.archived),
    matchReasons: Array.isArray(item?.matchReasons) ? item.matchReasons.filter((r: any) => typeof r === 'string') : [],
    matchKind:
      item?.matchKind === 'relation'
        ? 'relation'
        : item?.matchKind === 'expanded'
          ? 'expanded'
          : 'direct',
    matchedKeywords: Array.isArray(item?.matchedKeywords)
      ? item.matchedKeywords.filter((term: any) => typeof term === 'string')
      : [],
    referenceCount: topicNumber(item?.referenceCount),
    openHref:
      typeof item?.openHref === 'string'
        ? item.openHref
        : item?.type === 'capture'
          ? `/capture/${item?.captureId ?? item?.id ?? ''}`
          : `/attempt/${item?.id ?? ''}`,
  }));
  const scopeRaw = data?.scope ?? data?.topicScope ?? {};
  const thoughtCount = topicNumber(scopeRaw?.thoughtCount ?? data?.thoughtCount);
  const attemptCount = topicNumber(scopeRaw?.attemptCount ?? data?.attemptCount);
  const allowedSourceCount = topicNumber(
    scopeRaw?.allowedSourceCount,
    topicNumber(scopeRaw?.recordCount, thoughtCount + attemptCount)
  );
  const scope: TopicAskCandidatesResponse['scope'] = {
    topicId,
    topicTitle: topicText(scopeRaw?.topicTitle),
    topicName:
      topicText(
        scopeRaw?.topicTitle ??
          scopeRaw?.topicName ??
          data?.topic?.title ??
          data?.topic?.name ??
          topicName
      ) || topicName,
    allowedSourceCount,
    scopeHash: topicText(scopeRaw?.scopeHash),
    topicRevision: topicNullableNumber(scopeRaw?.topicRevision) ?? undefined,
    thoughtCount,
    attemptCount,
    experienceCount: topicNumber(scopeRaw?.experienceCount ?? data?.experienceCount),
    recordCount: allowedSourceCount,
  };
  return {
    question: topicText(data?.question ?? search?.question),
    keywords: Array.isArray(data?.keywords) ? data.keywords.filter((k: any) => typeof k === 'string') : [],
    suggestedKeywords: topicText(data?.suggestedKeywords ?? search?.suggestedKeywords),
    range:
      data?.range && typeof data.range === 'object'
        ? data.range
        : { from: null, to: null, fromLocal: null, toLocal: null },
    total: topicNumber(data?.total, candidates.length),
    limit: topicNumber(data?.limit, 20),
    candidates,
    ai: data?.ai ?? { configured: false, enabled: false, config: null },
    generatedAt: topicNumber(data?.generatedAt),
    expandedKeywords: Array.isArray(data?.expandedKeywords ?? search?.expandedKeywords)
      ? (data?.expandedKeywords ?? search?.expandedKeywords).filter(
          (term: any) => typeof term === 'string'
        )
      : [],
    topic: {
      id: topicId,
      name:
        topicText(
          scopeRaw?.topicTitle ?? data?.topic?.title ?? data?.topic?.name ?? topicName
        ) || topicName,
    },
    scope,
  };
}

function normalizeTopicAskExperiences(data: any, topicId: string): TopicAskExperiencesResponse {
  const experiencesRaw = data?.experiences ?? data?.items ?? [];
  const experiences = (Array.isArray(experiencesRaw) ? experiencesRaw : []).map((raw: any) => {
    const title = topicText(raw?.title);
    const sourcesRaw = raw?.sources ?? raw?.basis ?? raw?.evidence ?? [];
    const sources = (Array.isArray(sourcesRaw) ? sourcesRaw : [])
      .map((source: any) => {
        const type = source?.type ?? source?.kind;
        if (type !== 'attempt' && type !== 'capture') return null;
        return {
          sourceKey: String(source?.sourceKey ?? ''),
          type,
          id: String(source?.id ?? ''),
          captureId: String(source?.captureId ?? source?.id ?? ''),
          title: topicText(source?.title),
          text: topicText(source?.text ?? source?.rawText),
          resultText: typeof source?.resultText === 'string' ? source.resultText : null,
          outcome: source?.outcome ?? null,
          state: source?.state ?? null,
          observedAt: topicNullableNumber(source?.observedAt),
          archived: Boolean(source?.archived),
          deleted: Boolean(source?.deleted === true || source?.exists === false),
          originLabel:
            typeof source?.originLabel === 'string'
              ? source.originLabel
              : `来自经验《${title || '未命名经验'}》的直接依据`,
          openHref:
            typeof source?.openHref === 'string'
              ? source.openHref
              : type === 'capture'
                ? `/capture/${source?.captureId ?? source?.id ?? ''}`
                : `/attempt/${source?.id ?? ''}`,
        };
      })
      .filter((source: any): source is NonNullable<typeof source> => Boolean(source));
    return {
      id: String(raw?.id ?? raw?.experienceId ?? ''),
      title: title || '（未命名经验）',
      summary: topicText(raw?.summary),
      needsRevision: Boolean(raw?.needsRevision),
      hasPracticeResult: Boolean(raw?.hasPracticeResult),
      sourceCount: topicNumber(raw?.sourceCount, sources.length),
      derivationBy: raw?.derivationBy === 'model' || raw?.derivationBy === 'user' ? raw.derivationBy : null,
      selectableSourceKeys: Array.isArray(raw?.selectableSourceKeys)
        ? raw.selectableSourceKeys.filter((key: unknown) => typeof key === 'string')
        : sources.map((source: any) => source.sourceKey).filter((key: string) => Boolean(key)),
      sources,
    };
  });
  return {
    topic: { id: topicId, name: topicText(data?.topic?.name) || '这个主题' },
    experiences,
  };
}

// ---------- 主题 Markdown 导出：预览/下载适配 ----------

const TOPIC_EXPORT_LIMIT_KEYS: TopicExportLimitKey[] = ['files', 'attempts', 'bytes'];

function normalizeTopicExportPreview(data: any): TopicExportPreview {
  const raw = data?.preview ?? data ?? {};
  const topicRaw = raw?.topic ?? {};
  const scopeRaw = raw?.scope ?? {};
  const countsRaw = scopeRaw?.counts ?? {};
  const archivedRaw = scopeRaw?.archived ?? {};
  const omittedRaw = scopeRaw?.omittedRelations ?? {};
  const omittedByType = omittedRaw?.byType ?? {};
  const limitsRaw = scopeRaw?.limits ?? {};

  const filesRaw = Array.isArray(scopeRaw?.files) ? scopeRaw.files : [];
  const files: TopicExportFileEntry[] = filesRaw
    .map((file: any) => ({
      path: topicText(file?.path),
      entityType: (typeof file?.entityType === 'string'
        ? file.entityType
        : 'thought') as TopicExportEntityType,
      entityId:
        file?.entityId == null || file.entityId === ''
          ? null
          : String(file.entityId),
      title: topicText(file?.title),
      archived: Boolean(file?.archived),
      basis: Boolean(file?.basis),
      revision: topicNullableNumber(file?.revision),
    }))
    .filter((file: TopicExportFileEntry) => Boolean(file.path));

  const basisRaw = Array.isArray(scopeRaw?.basisCandidates)
    ? scopeRaw.basisCandidates
    : [];
  const basisCandidates: TopicExportBasisCandidate[] = basisRaw
    .map((candidate: any) => {
      const deleted = Boolean(candidate?.deleted);
      return {
        sourceKey: String(candidate?.sourceKey ?? ''),
        entityType: (candidate?.entityType === 'thought'
          ? 'thought'
          : 'attempt') as 'thought' | 'attempt',
        entityId: String(candidate?.entityId ?? ''),
        title:
          topicText(candidate?.title) || (deleted ? '来源已删除' : '（未命名记录）'),
        summary: topicText(candidate?.summary),
        sourceExperienceId: String(candidate?.sourceExperienceId ?? ''),
        sourceExperienceTitle: topicText(candidate?.sourceExperienceTitle),
        referencedBy: Array.isArray(candidate?.referencedBy)
          ? candidate.referencedBy.filter(
              (title: unknown): title is string => typeof title === 'string'
            )
          : [],
        deleted,
        selectable: candidate?.selectable !== false && !deleted,
        reason: topicText(candidate?.reason),
      };
    })
    .filter((candidate: TopicExportBasisCandidate) => Boolean(candidate.sourceKey));

  const exceeded = Array.isArray(limitsRaw?.exceeded)
    ? limitsRaw.exceeded.filter((key: unknown): key is TopicExportLimitKey =>
        TOPIC_EXPORT_LIMIT_KEYS.includes(key as TopicExportLimitKey)
      )
    : [];
  const canExport =
    typeof raw?.canExport === 'boolean'
      ? raw.canExport
      : exceeded.length === 0;

  return {
    topic: {
      id: String(topicRaw?.id ?? ''),
      title: topicText(topicRaw?.title ?? topicRaw?.name),
      revision: topicNumber(topicRaw?.revision, 1),
      archived: Boolean(topicRaw?.archived),
      archivedAt: topicNullableNumber(topicRaw?.archivedAt),
      createdAt: topicNumber(topicRaw?.createdAt),
      updatedAt: topicNumber(topicRaw?.updatedAt, topicNumber(topicRaw?.createdAt)),
    },
    scope: {
      includeArchived: scopeRaw?.includeArchived !== false,
      includeBasisKeys: Array.isArray(scopeRaw?.includeBasisKeys)
        ? scopeRaw.includeBasisKeys.filter(
            (key: unknown): key is string => typeof key === 'string'
          )
        : [],
      counts: {
        thoughts: topicNumber(countsRaw?.thoughts),
        experiences: topicNumber(countsRaw?.experiences),
        attempts: topicNumber(countsRaw?.attempts),
        basisThoughts: topicNumber(countsRaw?.basisThoughts),
        basisExperiences: topicNumber(countsRaw?.basisExperiences),
        basisAttempts: topicNumber(countsRaw?.basisAttempts),
        files: topicNumber(countsRaw?.files, files.length),
        manualLinks: topicNumber(countsRaw?.manualLinks),
        attemptReferences: topicNumber(countsRaw?.attemptReferences),
        experienceSources: topicNumber(countsRaw?.experienceSources),
        experienceAdoptions: topicNumber(countsRaw?.experienceAdoptions),
      },
      archived: {
        members: topicNumber(archivedRaw?.members),
        thoughts: topicNumber(archivedRaw?.thoughts),
        experiences: topicNumber(archivedRaw?.experiences),
      },
      files,
      basisCandidates,
      omittedRelations: {
        total: topicNumber(omittedRaw?.total),
        byType: {
          manualLink: topicNumber(omittedByType?.manualLink),
          attemptReference: topicNumber(omittedByType?.attemptReference),
          experienceSource: topicNumber(omittedByType?.experienceSource),
          experienceAdoption: topicNumber(omittedByType?.experienceAdoption),
        },
      },
      estimatedBytes: topicNumber(scopeRaw?.estimatedBytes),
      limits: {
        maxFiles: topicNumber(limitsRaw?.maxFiles, 2000),
        maxAttempts: topicNumber(limitsRaw?.maxAttempts, 2000),
        maxBytes: topicNumber(limitsRaw?.maxBytes, 20 * 1024 * 1024),
        maxBasisKeys: topicNumber(limitsRaw?.maxBasisKeys, 200),
        exceeded,
      },
      warnings: Array.isArray(scopeRaw?.warnings)
        ? scopeRaw.warnings.filter(
            (warning: unknown): warning is string => typeof warning === 'string'
          )
        : [],
    },
    scopeHash: typeof raw?.scopeHash === 'string' ? raw.scopeHash : '',
    canExport,
  };
}

function safeDownloadFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function topicExportFilename(disposition: string, topicId: string): string {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      const decoded = safeDownloadFilename(decodeURIComponent(encoded[1].trim()));
      if (decoded) return decoded;
    } catch {
      // 非法编码时回退到普通 filename 或本地兜底名。
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition);
  const plainName = safeDownloadFilename(plain?.[1] ?? plain?.[2] ?? '');
  if (plainName) return plainName;
  return `shinian-topic-${topicId}-${exportStamp()}.zip`;
}

export const api = {
  async createAccount(username: string) {
    return request<{ ok: true; accountId: string; username: string }>('/session/create', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  },

  async checkSession() {
    return request<{ ok: true; accountId: string; username: string }>('/session/check');
  },

  async destroySession() {
    return request<{ ok: true }>('/session/destroy', { method: 'POST' });
  },

  // 念头
  async listCaptures(archived = false, q?: string) {
    const params = new URLSearchParams();
    if (archived) params.set('archived', '1');
    if (q) params.set('q', q);
    const qs = params.toString();
    return request<{ captures: Capture[] }>(`/captures${qs ? `?${qs}` : ''}`);
  },

  async createCapture(rawText: string) {
    return request<{ capture: Capture }>('/captures', {
      method: 'POST',
      body: JSON.stringify({ rawText }),
    });
  },

  async getCapture(id: string) {
    return request<{ capture: Capture }>(`/captures/${id}`);
  },

  // 知识网络（只读投影）
  async getGraph(includeArchived = false) {
    const qs = includeArchived ? '?archived=1' : '';
    return request<GraphResponse>(`/graph${qs}`);
  },

  async searchGraph(
    query: string,
    options: { archived?: boolean; types?: GraphNodeType[]; limit?: number } = {}
  ) {
    const params = new URLSearchParams({ q: query });
    if (options.archived) params.set('archived', '1');
    if (options.types?.length) params.set('types', options.types.join(','));
    if (options.limit) params.set('limit', String(options.limit));
    return request<GraphSearchResponse>(`/graph/search?${params.toString()}`);
  },

  async focusGraph(nodeId: string, includeArchived = false, depth: 1 | 2 = 1) {
    const params = new URLSearchParams({ node: nodeId, depth: String(depth) });
    if (includeArchived) params.set('archived', '1');
    return request<GraphResponse>(`/graph/focus?${params.toString()}`);
  },

  async updateCapture(id: string, rawText: string, revision: number) {
    return request<{ capture: Capture }>(`/captures/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rawText, revision }),
    });
  },

  async archiveCapture(id: string) {
    return request<{ capture: Capture }>(`/captures/${id}/archive`, { method: 'POST' });
  },

  async restoreCapture(id: string) {
    return request<{ capture: Capture }>(`/captures/${id}/restore`, { method: 'POST' });
  },

  async deletePreview(id: string) {
    return request<DeletePreview>(`/captures/${id}/delete-preview`);
  },

  async deleteCapture(id: string) {
    return request<{
      ok: true;
      deletedAttempts: number;
      deletedReferences: number;
      deletedGenerations?: number;
      deletedSchedules?: number;
    }>(`/captures/${id}`, { method: 'DELETE' });
  },

  // AI 设置
  async getAiSettings() {
    return request<AiSettings>('/settings/ai');
  },

  async getAiModels() {
    return request<AiModelsResponse>('/settings/ai/models');
  },

  async assistCapture(input: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  }) {
    return request<AssistCaptureResponse>('/ai/assist-capture', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async assistCaptureStream(
    input: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
    },
    callbacks: {
      onStart?: (info: { modelId: string; configName: string }) => void;
      onDelta?: (delta: string, accumulated: string) => void;
    },
    signal?: AbortSignal
  ): Promise<AssistCaptureResponse> {
    if (STANDALONE_MODE) {
      return request<AssistCaptureResponse>('/ai/assist-capture/stream', {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      });
    }
    const res = await fetch(`${API_BASE}/ai/assist-capture/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body);
    }
    if (!res.body) {
      throw new ApiError(502, { error: 'empty_stream', message: '服务端未返回响应流。' });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulated = '';
    let finalResult: AssistCaptureResponse | null = null;

    const handleFrame = (frame: string) => {
      if (!frame.trim()) return;
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      let payload: any;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }
      if (eventName === 'start') {
        callbacks.onStart?.({ modelId: payload.modelId ?? '', configName: payload.configName ?? '' });
      } else if (eventName === 'delta' && typeof payload.text === 'string') {
        accumulated += payload.text;
        callbacks.onDelta?.(payload.text, accumulated);
      } else if (eventName === 'done') {
        finalResult = payload as AssistCaptureResponse;
      } else if (eventName === 'error') {
        throw new ApiError(502, payload);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let splitIdx: number;
        while ((splitIdx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, splitIdx);
          buffer = buffer.slice(splitIdx + 2);
          handleFrame(frame);
        }
      }
      if (done) {
        buffer += decoder.decode().replace(/\r\n/g, '\n');
        if (buffer.trim()) handleFrame(buffer);
        break;
      }
    }

    if (!finalResult) {
      throw new ApiError(502, { error: 'incomplete_stream', message: '流式回复尚未完成即已中断。' });
    }
    return finalResult;
  },

  async saveAiSettings(input: SaveAiSettingsInput) {
    return request<AiSettings>('/settings/ai', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async deleteAiSettings() {
    return request<{ ok: true }>('/settings/ai', { method: 'DELETE' });
  },

  async testAiSettings() {
    return request<{ test: AiTestResult; config: AiConfig }>('/settings/ai/test', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // 参考旧经验：候选与预览
  async getExperienceCandidates(captureId: string, q?: string, limit = 12) {
    const params = new URLSearchParams();
    if (q && q.trim()) params.set('q', q.trim());
    params.set('limit', String(limit));
    return request<ExperienceCandidatesResponse>(
      `/captures/${captureId}/experience-candidates?${params.toString()}`
    );
  },

  async previewExperience(
    captureId: string,
    input: { captureRevision: number; constraint?: string; sourceAttemptIds: string[] }
  ) {
    return request<ExperiencePreview>(`/captures/${captureId}/experience/preview`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  // AI 建议生成：202 立即返回，前端轮询
  async createSuggestion(
    captureId: string,
    input: {
      captureRevision: number;
      constraint?: string;
      operationId: string;
      sourceAttemptIds?: string[];
      contextToken?: string;
    }
  ) {
    return request<{ generation: AiGeneration; replayed: boolean }>(
      `/captures/${captureId}/suggestions`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async getGeneration(id: string) {
    return request<{ generation: AiGeneration }>(`/generations/${id}`);
  },

  async getLatestSuggestion(captureId: string) {
    return request<{ generation: AiGeneration | null }>(
      `/captures/${captureId}/suggestions/latest`
    );
  },

  async cancelGeneration(id: string) {
    return request<{ generation: AiGeneration }>(`/generations/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async dismissGeneration(id: string) {
    return request<{ generation: AiGeneration }>(`/generations/${id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async acceptGeneration(id: string, input: { step: string; operationId: string }) {
    return request<{ attempt: Attempt; generation: AiGeneration; replayed?: boolean }>(
      `/generations/${id}/accept`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  // 尝试
  async createAttempt(captureId: string, input: CreateAttemptInput) {
    return request<{ attempt: Attempt; replayed?: boolean }>(`/captures/${captureId}/attempts`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async listAttempts(captureId: string) {
    return request<{ attempts: Attempt[] }>(`/captures/${captureId}/attempts`);
  },

  async listRecentAttempts(limit = 6) {
    return request<{ attempts: RecentAttempt[] }>(
      `/attempts/recent?limit=${encodeURIComponent(String(limit))}`
    );
  },

  async getAttempt(id: string) {
    return request<{
      attempt: Attempt;
      capture: Capture | null;
      experienceRef?: ExperienceAttemptRef | null;
    }>(`/attempts/${id}`);
  },

  async updateAttempt(
    id: string,
    patch: {
      state?: string;
      resultText?: string | null;
      outcome?: string | null;
      sourceUrl?: string | null;
      observedAt?: number | null;
      revision: number;
      /** 尝试改为 done/cancelled 时如何处理未来安排 */
      futureScheduleAction?: FutureScheduleAction;
    }
  ) {
    return request<{
      attempt: Attempt;
      cancelledScheduleCount?: number;
    }>(`/attempts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async getAttemptDeletePreview(id: string) {
    return request<AttemptDeletePreview>(`/attempts/${id}/delete-preview`);
  },

  async deleteAttempt(id: string) {
    return request<{ ok: true; deletedReferences: number; deletedSchedules?: number }>(
      `/attempts/${id}`,
      { method: 'DELETE' }
    );
  },

  // 日程安排（docs/schedule-api-contract.md）
  async listSchedules(params: { from: string; to: string; timezone: string }) {
    const q = new URLSearchParams({
      from: params.from,
      to: params.to,
      timezone: params.timezone,
    });
    return request<ScheduleRangeResponse>(`/schedules?${q.toString()}`);
  },

  async listAttemptSchedules(attemptId: string) {
    return request<AttemptSchedulesResponse>(`/attempts/${attemptId}/schedules`);
  },

  async createSchedule(attemptId: string, input: CreateScheduleInput) {
    return request<ScheduleCreateResponse>(`/attempts/${attemptId}/schedules`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateSchedule(id: string, input: UpdateScheduleInput) {
    return request<ScheduleUpdateResponse>(`/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async cancelSchedule(id: string, revision: number) {
    return request<ScheduleCancelResponse>(`/schedules/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    });
  },

  // 引用
  async createReference(
    fromId: string,
    input: { toId: string; note?: string; operationId: string }
  ) {
    return request<{ reference: AttemptReference; replayed?: boolean }>(
      `/attempts/${fromId}/references`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async listReferences(attemptId: string) {
    return request<{ fromRefs: ReferenceFrom[]; toRefs: ReferenceTo[] }>(
      `/attempts/${attemptId}/references`
    );
  },

  async deleteReference(id: string) {
    return request<{ ok: true }>(`/attempt_references/${id}`, { method: 'DELETE' });
  },

  // 念头关联（有方向的链接 + 反链）
  async listCaptureLinks(captureId: string) {
    return request<CaptureLinksResponse>(`/captures/${captureId}/links`);
  },

  async searchCaptureLinkCandidates(captureId: string, query = '', limit = 12) {
    const params = new URLSearchParams({ excludeId: captureId, limit: String(limit) });
    if (query.trim()) params.set('q', query.trim());
    return request<CaptureLinkCandidatesResponse>(
      `/capture-links/candidates?${params.toString()}`
    );
  },

  async createCaptureLink(
    captureId: string,
    input: { toCaptureId: string; note?: string | null; operationId: string }
  ) {
    return request<{ link: CaptureLinkItem; replayed?: boolean }>(`/captures/${captureId}/links`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteCaptureLink(linkId: string) {
    return request<{ ok: true; deletedId: string }>(`/capture_links/${linkId}`, {
      method: 'DELETE',
    });
  },

  // 念头详情里的尝试引用汇总
  async listCaptureReferences(captureId: string) {
    return request<CaptureReferencesResponse>(`/captures/${captureId}/references`);
  },

  // 事件展示栏：按最近时间返回念头/尝试/结果/引用/AI 动态
  async listActivity(params: { type?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (params.type && params.type !== 'all') q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<ActivityResponse>(`/activity${qs ? `?${qs}` : ''}`);
  },

  // 阶段回顾：范围与实际记录、预览确认、生成/轮询/取消、保存与列表
  async getReviewRange(input: ReviewRangeInput) {
    const q = new URLSearchParams({
      from: String(input.from),
      to: String(input.to),
      timezone: input.timezone,
      preset: input.preset,
    });
    return request<ReviewRangeResponse>(`/review/range?${q.toString()}`);
  },

  async getReviewDaily(input: ReviewRangeInput) {
    const q = new URLSearchParams({
      from: String(input.from),
      to: String(input.to),
      timezone: input.timezone,
      preset: input.preset,
    });
    return request<ReviewDailyResponse>(`/review/daily?${q.toString()}`);
  },

  async previewReview(input: ReviewPreviewInput) {
    return request<ReviewPreviewResponse>('/review/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createReview(input: CreateReviewInput) {
    return request<{ review: ReviewPublic; replayed: boolean }>('/reviews', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async getReview(id: string) {
    return request<{ review: ReviewPublic }>(`/reviews/${encodeURIComponent(id)}`);
  },

  async listSavedReviews(limit = 50) {
    return request<{ total: number; reviews: ReviewListItem[] }>(
      `/reviews?limit=${encodeURIComponent(String(limit))}`
    );
  },

  async saveReview(id: string, input: { operationId?: string } = {}) {
    return request<{ review: ReviewPublic; replayed: boolean }>(
      `/reviews/${encodeURIComponent(id)}/save`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async cancelReview(id: string) {
    return request<{ review: ReviewPublic }>(`/reviews/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // 问我的记录（docs/ask-api-contract.md）
  async searchAskCandidates(params: AskSearchParams) {
    const q = new URLSearchParams({ question: params.question });
    if (params.keywords !== undefined) q.set('keywords', params.keywords);
    if (params.from != null) q.set('from', String(params.from));
    if (params.to != null) q.set('to', String(params.to));
    if (params.limit != null) q.set('limit', String(params.limit));
    for (const term of params.expandedKeywords ?? []) {
      if (term.trim()) q.append('expanded', term.trim());
    }
    return request<AskSearchResponse>(`/ask/candidates?${q.toString()}`);
  },

  async suggestAskKeywords(
    input: AskKeywordSuggestInput,
    options: { signal?: AbortSignal } = {}
  ) {
    return request<AskKeywordSuggestionsResponse>('/ask/keyword-suggestions', {
      method: 'POST',
      body: JSON.stringify(input),
      signal: options.signal,
    });
  },

  async previewAsk(input: AskPreviewInput) {
    return request<AskPreviewResponse>('/ask/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createAskQuery(input: CreateAskQueryInput) {
    return request<{ query: AskPublic; replayed: boolean }>('/ask/queries', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async getAskQuery(id: string) {
    return request<{ query: AskPublic }>(`/ask/queries/${encodeURIComponent(id)}`);
  },

  async listAskQueries(limit = 10) {
    return request<{ queries: AskListItem[] }>(
      `/ask/queries?limit=${encodeURIComponent(String(limit))}`
    );
  },

  async cancelAskQuery(id: string) {
    return request<{ query: AskPublic }>(`/ask/queries/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // 回顾后的下一步行动（复用 attempts；docs/next-action-api-contract.md）
  async getNextActionPreview(reviewId: string, experienceIndex: number) {
    const query = new URLSearchParams({ experienceIndex: String(experienceIndex) });
    return request<NextActionPreview>(
      `/reviews/${encodeURIComponent(reviewId)}/next-action-preview?${query.toString()}`
    );
  },

  async createNextAction(reviewId: string, input: CreateNextActionInput) {
    return request<{ nextAction: NextAction; replayed: boolean }>(
      `/reviews/${encodeURIComponent(reviewId)}/next-actions`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async getNextAction(id: string) {
    return request<{ action: NextAction }>(`/next-actions/${encodeURIComponent(id)}`);
  },

  async listReviewNextActions(reviewId: string) {
    return request<{ actions: NextAction[] }>(
      `/reviews/${encodeURIComponent(reviewId)}/next-actions`
    );
  },

  async listCaptureNextActions(captureId: string) {
    return request<{ actions: NextAction[] }>(
      `/captures/${encodeURIComponent(captureId)}/next-actions`
    );
  },

  async updateNextAction(id: string, input: UpdateNextActionInput) {
    // 契约读取接口用 action；创建接口用 nextAction。这里兼容两种返回键。
    return request<{ action?: NextAction; nextAction?: NextAction }>(
      `/next-actions/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) }
    );
  },

  // 导出：返回文件 blob 与服务端建议的文件名
  async exportData() {
    if (STANDALONE_MODE) {
      const { localExport } = await import('./standalone');
      return localExport();
    }
    const res = await fetch(`${API_BASE}/export`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return { blob, filename: match?.[1] ?? `shinian-export-${exportStamp()}.json` };
  },

  // 搜索
  async search(q: string) {
    return request<{
      query: string;
      captures: SearchCaptureHit[];
      attempts: SearchAttemptHit[];
      experiences?: SearchExperienceHit[];
    }>(`/search?q=${encodeURIComponent(q)}`);
  },

  // 研究一下（GitHub 开源项目调研）
  async getGithubSettings() {
    return request<{
      configured: boolean;
      hasToken: boolean;
      tokenFingerprint: string | null;
      updatedAt: number | null;
      apiBase: string;
      note: string;
    }>('/settings/github');
  },

  async saveGithubToken(token: string) {
    return request<{
      configured: boolean;
      hasToken: boolean;
      tokenFingerprint: string | null;
      updatedAt: number | null;
      apiBase: string;
      note: string;
      changed: boolean;
    }>('/settings/github', { method: 'PUT', body: JSON.stringify({ token }) });
  },

  async deleteGithubToken() {
    return request<{ ok: true; configured: boolean; hasToken: boolean }>('/settings/github', {
      method: 'DELETE',
    });
  },

  async testGithubToken() {
    return request<{
      ok: true;
      login: string;
      scopes: string | null;
      rate: { limit: number | null; remaining: number | null; resetAt: number | null };
      apiBase: string;
    }>('/settings/github/test', { method: 'POST', body: JSON.stringify({}) });
  },

  async previewResearch(
    captureId: string,
    input: {
      captureRevision: number;
      question: string;
      constraints: ResearchConstraints;
      search: ResearchSearchInput;
    }
  ) {
    return request<ResearchPreview>(`/captures/${encodeURIComponent(captureId)}/research/preview`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createResearch(
    captureId: string,
    input: {
      captureRevision: number;
      question: string;
      constraints: ResearchConstraints;
      search: ResearchSearchInput;
      contextToken: string;
      operationId: string;
    }
  ) {
    return request<{ research: ResearchPublic; replayed: boolean }>(
      `/captures/${encodeURIComponent(captureId)}/research`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async listCaptureResearch(captureId: string) {
    return request<{
      captureId: string;
      count: { total: number; active: number };
      research: ResearchListItem[];
    }>(`/captures/${encodeURIComponent(captureId)}/research`);
  },

  async listSavedResearch(limit = 20) {
    return request<{ research: ResearchListItem[] }>(
      `/research?limit=${encodeURIComponent(String(limit))}`
    );
  },

  async getResearch(id: string) {
    return request<{
      research: ResearchPublic;
      ai: {
        configured: boolean;
        enabled: boolean;
        config: { id: string; name: string; modelId: string; version: number } | null;
      };
      github: { hasToken: boolean };
    }>(`/research/${encodeURIComponent(id)}`);
  },

  async selectResearchCandidates(id: string, candidateIds: string[]) {
    return request<{ research: ResearchPublic }>(
      `/research/${encodeURIComponent(id)}/select`,
      { method: 'POST', body: JSON.stringify({ candidateIds }) }
    );
  },

  async retryResearch(id: string, action: 'search' | 'fetch' | 'generate', repoIds: string[] = []) {
    return request<{ research: ResearchPublic }>(
      `/research/${encodeURIComponent(id)}/retry`,
      { method: 'POST', body: JSON.stringify({ action, repoIds }) }
    );
  },

  async cancelResearch(id: string) {
    return request<{ research: ResearchPublic }>(`/research/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async saveResearch(id: string) {
    return request<{ savedAt: number; replayed: boolean; research: ResearchPublic }>(
      `/research/${encodeURIComponent(id)}/save`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  },

  async deleteResearch(id: string) {
    return request<{
      ok: true;
      deletedResearchId: string;
      deletedSources: number;
      keptAttempts: number;
    }>(`/research/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async acceptResearchExperiment(
    researchId: string,
    index: number,
    input: {
      title: string;
      description: string | null;
      estimatedMinutes: number | null;
      expectedRevision: number;
      operationId: string;
    }
  ) {
    return request<{ attempt: Attempt; researchId: string; replayed: boolean }>(
      `/research/${encodeURIComponent(researchId)}/experiments/${index}/accept`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async getAttemptResearch(attemptId: string) {
    return request<{ research: ResearchAttemptDetail | null }>(
      `/attempts/${encodeURIComponent(attemptId)}/research`
    );
  },

  // ---------- 经验笔记 ----------
  async listExperiences(options: { archived?: 'exclude' | 'include' | 'only'; limit?: number; q?: string } = {}) {
    const params = new URLSearchParams();
    if (options.archived) params.set('archived', options.archived);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.q) params.set('q', options.q);
    const qs = params.toString();
    return request<{ experiences: ExperienceListItem[] }>(`/experiences${qs ? `?${qs}` : ''}`);
  },

  async getExperience(id: string) {
    return request<{ experience: ExperiencePublic }>(`/experiences/${encodeURIComponent(id)}`);
  },

  async createExperience(input: {
    title: string;
    understanding: string;
    conditions: string;
    limitations: string;
    by: 'model' | 'user';
    modelBasis: 'observation' | 'inference' | null;
    originKind: 'ask' | 'attempt' | 'manual';
    originQueryId: string | null;
    originPointIndex: number | null;
    originAttemptId: string | null;
    contextCaptureId: string | null;
    sourceKeys: string[];
    operationId: string;
  }) {
    return request<{ experience: ExperiencePublic; replayed: boolean }>('/experiences', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateExperience(
    id: string,
    input: {
      title: string;
      understanding: string;
      conditions: string;
      limitations: string;
      sourceKeys?: string[];
      revision: number;
      operationId?: string;
    }
  ) {
    return request<{ experience: ExperiencePublic; replayed: boolean }>(
      `/experiences/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) }
    );
  },

  async getAskExperienceDraft(queryId: string, pointIndex: number) {
    return request<{ draft: ExperienceDraft }>(
      `/ask/queries/${encodeURIComponent(queryId)}/experience-draft?pointIndex=${pointIndex}`
    );
  },

  async getAttemptExperienceDraft(attemptId: string) {
    return request<{ draft: ExperienceDraft }>(
      `/attempts/${encodeURIComponent(attemptId)}/experience-draft`
    );
  },

  async getExperienceSourceCandidates(q: string, excludeExperienceId: string | null) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (excludeExperienceId) params.set('excludeExperienceId', excludeExperienceId);
    return request<{ candidates: ExperienceDraftSource[] }>(
      `/experiences/source-candidates?${params.toString()}`
    );
  },

  async createAttemptFromExperience(
    experienceId: string,
    input: {
      captureId: string;
      title: string;
      description: string;
      basisSourceKeys: string[];
      experienceRevision: number;
      operationId: string;
    }
  ) {
    return request<{ attempt: Attempt; experienceId: string; replayed: boolean }>(
      `/experiences/${encodeURIComponent(experienceId)}/attempts`,
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  async getExperienceDeletePreview(id: string) {
    return request<ExperienceDeletePreview>(
      `/experiences/${encodeURIComponent(id)}/delete-preview`
    );
  },

  // ---------- 主题（docs/topic-api-contract.md） ----------
  async listTopics(
    options: {
      archived?: 'exclude' | 'only' | 'include';
      offset?: number;
      limit?: number;
      q?: string;
    } = {}
  ) {
    const params = new URLSearchParams();
    if (options.archived === 'only') params.set('archived', '1');
    else if (options.archived === 'include') params.set('archived', 'all');
    if (options.offset) params.set('offset', String(options.offset));
    if (options.limit) params.set('limit', String(options.limit));
    if (options.q?.trim()) params.set('q', options.q.trim());
    const qs = params.toString();
    const data = await request<any>(`/topics${qs ? `?${qs}` : ''}`);
    return normalizeTopicList(data);
  },

  async createTopic(input: CreateTopicInput) {
    const body: Record<string, unknown> = {
      title: input.name,
      exploringQuestion: input.exploringQuestion ?? null,
      continueNote: input.continueNote ?? null,
      operationId: input.operationId,
    };
    const data = await request<any>('/topics', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { topic: normalizeTopic(data), replayed: Boolean(data?.replayed) };
  },

  async getTopic(id: string) {
    const data = await request<any>(`/topics/${encodeURIComponent(id)}`);
    return { topic: normalizeTopic(data) };
  },

  async updateTopic(
    id: string,
    input: UpdateTopicInput & { expectedRevision?: number; operationId?: string }
  ) {
    const body: Record<string, unknown> = {
      exploringQuestion: input.exploringQuestion ?? null,
      continueNote: input.continueNote ?? null,
      expectedRevision: input.expectedRevision ?? input.revision,
      operationId: input.operationId,
    };
    if (input.name !== undefined) body.title = input.name;
    const data = await request<any>(`/topics/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { topic: normalizeTopic(data), replayed: Boolean(data?.replayed) };
  },

  async archiveTopic(id: string, expectedRevision: number, operationId?: string) {
    const data = await request<any>(`/topics/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, operationId }),
    });
    return { topic: normalizeTopic(data) };
  },

  async restoreTopic(id: string, expectedRevision: number, operationId?: string) {
    const data = await request<any>(`/topics/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, operationId }),
    });
    return { topic: normalizeTopic(data) };
  },

  async getTopicDeletePreview(id: string) {
    const data = await request<any>(`/topics/${encodeURIComponent(id)}/delete-preview`);
    const preview = data?.preview ?? data ?? {};
    const topic = preview.topic ?? {};
    return {
      topicId: String(preview.topicId ?? topic.id ?? preview.id ?? id),
      name:
        topicText(topic.title ?? topic.name ?? preview.name ?? preview.title) || '这个主题',
      memberCount: topicNumber(preview.memberCount ?? topic.memberCount),
      thoughtCount: topicNumber(preview.thoughtCount ?? topic.thoughtCount),
      experienceCount: topicNumber(preview.experienceCount ?? topic.experienceCount),
      attemptCount: topicNumber(preview.attemptCount ?? preview.preserved?.attempts),
      nextAttemptStep:
        typeof preview.nextAttemptStep === 'string'
          ? preview.nextAttemptStep
          : typeof preview.nextAttempt?.step === 'string'
            ? preview.nextAttempt.step
            : null,
    } satisfies TopicDeletePreview;
  },

  async deleteTopic(id: string) {
    return request<{
      ok: true;
      deletedTopicId?: string;
      clearedNextAttempt?: boolean;
    }>(`/topics/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async listTopicMemberCandidates(
    id: string,
    options: { q?: string; type?: 'all' | TopicMemberType; cursor?: string | null; limit?: number } = {}
  ) {
    const params = new URLSearchParams();
    if (options.q?.trim()) params.set('q', options.q.trim());
    if (options.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const data = await request<any>(
      `/topics/${encodeURIComponent(id)}/member-candidates${qs ? `?${qs}` : ''}`
    );
    const raw = data?.candidates ?? data?.captures ?? data?.items ?? [];
    const nextCursor =
      typeof data?.nextCursor === 'string'
        ? data.nextCursor
        : typeof data?.next_cursor === 'string'
          ? data.next_cursor
          : null;
    const all = (Array.isArray(raw) ? raw : []).map((item: any) => normalizeTopicCandidate(item));
    const filtered =
      options.type && options.type !== 'all'
        ? all.filter((candidate: any) => candidate.type === options.type)
        : all;
    return {
      query: topicText(data?.query),
      type: options.type ?? 'all',
      total: topicNumber(
        data?.total,
        filtered.length
      ),
      limit: topicNumber(data?.limit, options.limit ?? 20),
      nextCursor,
      candidates: filtered,
    } satisfies TopicMemberCandidatesResponse;
  },

  async addTopicMembers(
    id: string,
    input: { captureIds: string[]; operationId: string }
  ): Promise<AddTopicMembersResponse> {
    const data = await request<any>(`/topics/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      added: topicNumber(
        data?.added,
        Array.isArray(data?.addedCaptureIds) ? data.addedCaptureIds.length : 0
      ),
      skipped: topicNumber(
        data?.existing ?? data?.skipped,
        Array.isArray(data?.existingCaptureIds)
          ? data.existingCaptureIds.length
          : Array.isArray(data?.skippedIds)
            ? data.skippedIds.length
            : 0
      ),
      topic: data?.topic ? normalizeTopic(data.topic) : null,
    };
  },

  async removeTopicMember(topicId: string, captureId: string) {
    const data = await request<any>(
      `/topics/${encodeURIComponent(topicId)}/members/${encodeURIComponent(captureId)}`,
      { method: 'DELETE' }
    );
    return {
      removed: Boolean(data?.removed ?? true),
      clearedNext: Boolean(data?.clearedNext),
      topic: data?.topic ? normalizeTopic(data.topic) : null,
    };
  },

  async listTopicAttempts(
    id: string,
    options: {
      cursor?: string | null;
      offset?: number;
      limit?: number;
      state?: string;
      attemptState?: string;
    } = {}
  ): Promise<TopicAttemptsResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.offset) params.set('offset', String(options.offset));
    if (options.limit) params.set('limit', String(options.limit));
    if (options.state) params.set('state', options.state);
    // 兼容旧适配层读取 attemptState；服务端只认 state。
    if (options.attemptState) params.set('attemptState', options.attemptState);
    const qs = params.toString();
    const data = await request<any>(
      `/topics/${encodeURIComponent(id)}/attempts${qs ? `?${qs}` : ''}`
    );
    const raw = data?.attempts ?? data?.items ?? [];
    const nextCursor =
      typeof data?.nextCursor === 'string'
        ? data.nextCursor
        : typeof data?.next_cursor === 'string'
          ? data.next_cursor
          : null;
    return {
      attempts: (Array.isArray(raw) ? raw : []).map((item: any) => normalizeTopicAttempt(item)),
      total: typeof data?.total === 'number' ? data.total : null,
      nextCursor,
      hasMore: Boolean(data?.hasMore ?? data?.has_more ?? nextCursor),
      nextAttemptClearedReason:
        typeof data?.nextAttemptClearedReason === 'string'
          ? data.nextAttemptClearedReason
          : typeof data?.clearedReason === 'string'
            ? data.clearedReason
            : null,
      offset: topicNumber(data?.offset, options.offset ?? 0),
      limit: topicNumber(data?.limit, options.limit ?? 20),
    };
  },

  async setTopicNextAttempt(
    id: string,
    input: {
      attemptId: string | null;
      expectedRevision: number;
      operationId: string;
    }
  ) {
    const path = `/topics/${encodeURIComponent(id)}/next-attempt`;
    let data: any;
    try {
      data = await request<any>(path, { method: 'PUT', body: JSON.stringify(input) });
    } catch (e) {
      // 兼容只实现 POST 的后端；404/405 表示请求未生效，可安全重试。
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
        data = await request<any>(path, { method: 'POST', body: JSON.stringify(input) });
      } else {
        throw e;
      }
    }
    return {
      topic: data?.topic ? normalizeTopic(data.topic) : null,
      nextAttempt: data?.nextAttempt ? normalizeTopicAttempt(data.nextAttempt) : null,
      clearedReason:
        typeof data?.clearedReason === 'string'
          ? data.clearedReason
          : typeof data?.nextAttemptClearedReason === 'string'
            ? data.nextAttemptClearedReason
            : null,
    };
  },

  async getCaptureTopics(captureId: string): Promise<CaptureTopicsResponse> {
    const data = await request<any>(`/captures/${encodeURIComponent(captureId)}/topics`);
    const raw = data?.topics ?? data?.items ?? [];
    return {
      captureId: String(data?.captureId ?? captureId),
      topics: (Array.isArray(raw) ? raw : []).map((item: any) => {
        const archivedAt = topicNullableNumber(item?.archivedAt);
        return {
          id: String(item?.id ?? item?.topicId ?? ''),
          name: topicText(item?.name ?? item?.title),
          archived: archivedAt != null || item?.archived === true,
          archivedAt,
          exploringQuestion:
            typeof item?.exploringQuestion === 'string' ? item.exploringQuestion : null,
        };
      }),
    };
  },

  async addCaptureTopics(
    captureId: string,
    input: { topicIds: string[]; operationId: string }
  ) {
    const data = await request<any>(`/captures/${encodeURIComponent(captureId)}/topics`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      added: topicNumber(data?.added, Array.isArray(data?.addedIds) ? data.addedIds.length : 0),
      skipped: topicNumber(data?.existing ?? data?.skipped, 0),
    };
  },

  async listTopicAskCandidates(
    id: string,
    options: {
      question: string;
      keywords?: string;
      from?: number | null;
      to?: number | null;
      limit?: number;
      expandedKeywords?: string[];
    }
  ): Promise<TopicAskCandidatesResponse> {
    const params = new URLSearchParams({ question: options.question });
    if (options.keywords !== undefined) params.set('keywords', options.keywords);
    if (options.from != null) params.set('from', String(options.from));
    if (options.to != null) params.set('to', String(options.to));
    if (options.limit) params.set('limit', String(options.limit));
    for (const term of options.expandedKeywords ?? []) {
      if (term.trim()) params.append('expanded', term.trim());
    }
    const data = await request<any>(
      `/topics/${encodeURIComponent(id)}/ask-candidates?${params.toString()}`
    );
    return normalizeTopicAskCandidates(data, id, '这个主题');
  },

  async listTopicAskExperiences(id: string, experienceId?: string): Promise<TopicAskExperiencesResponse> {
    const params = new URLSearchParams();
    if (experienceId) params.set('experienceId', experienceId);
    const qs = params.toString();
    const data = await request<any>(
      `/topics/${encodeURIComponent(id)}/ask-experiences${qs ? `?${qs}` : ''}`
    );
    return normalizeTopicAskExperiences(data, id);
  },

  // ---------- 主题 Markdown 导出（docs/topic-export-api-contract.md） ----------
  async previewTopicExport(
    id: string,
    input: TopicExportPreviewInput = {}
  ): Promise<TopicExportPreview> {
    const data = await request<any>(
      `/topics/${encodeURIComponent(id)}/export/preview`,
      {
        method: 'POST',
        body: JSON.stringify({
          includeArchived: input.includeArchived !== false,
          includeBasisKeys: Array.isArray(input.includeBasisKeys)
            ? input.includeBasisKeys
            : [],
        }),
      }
    );
    return normalizeTopicExportPreview(data);
  },

  async downloadTopicExport(
    id: string,
    input: TopicExportDownloadInput
  ): Promise<TopicExportDownloadResult> {
    if (STANDALONE_MODE) {
      throw new ApiError(400, {
        error: 'export_unavailable',
        message: '线上体验版暂不支持 ZIP 导出，请在本地版使用。',
      });
    }
    const res = await fetch(`${API_BASE}/topics/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/zip',
      },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: any = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: 'export_failed', message: text.slice(0, 300) };
        }
      }
      throw new ApiError(res.status, body);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    return {
      blob,
      filename: topicExportFilename(disposition, id),
    };
  },
};

export default api;