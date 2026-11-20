// 拾念 SHINIAN v0.1 - 前端类型定义

export type Capture = {
  id: string;
  rawText: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** thought = 念头；experience = 经验笔记（旧接口缺省视为念头） */
  kind?: 'thought' | 'experience';
};

export type AttemptState = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type AttemptOutcome = 'success' | 'failure' | 'undetermined';
export type AttemptOrigin =
  | 'manual'
  | 'ai_suggestion'
  | 'review_next_action'
  | 'research_experiment'
  | 'experience_retry';

export type Attempt = {
  id: string;
  captureId: string;
  step: string;
  state: AttemptState;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  sourceUrl: string | null;
  observedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** 旧接口没有该字段；缺省视为 manual */
  origin?: AttemptOrigin;
  actionDescription?: string | null;
  estimatedMinutes?: number | null;
  sourceReviewId?: string | null;
  sourceExperienceIndex?: number | null;
  sourceAttemptId?: string | null;
  sourceAttemptRevision?: number | null;
  /** 研究一下：小实验来源 */
  sourceResearchId?: string | null;
  sourceResearchExperimentIndex?: number | null;
  researchSuggestedJson?: string | null;
  researchSourceIdsJson?: string | null;
};

/** 首页「继续已有尝试」使用的最近尝试（只读） */
export type RecentAttempt = Attempt & {
  captureText: string;
  captureArchived: boolean;
  captureArchivedAt: number | null;
};

export type AttemptReference = {
  id: string;
  fromAttemptId: string;
  toAttemptId: string;
  revision: number;
  note: string | null;
  snapshotResultText: string | null;
  snapshotRevision: number;
  createdAt: number;
};

export type ReferenceSourceInfo = {
  id: string;
  captureId: string;
  step: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  revision: number;
  updatedSinceSnapshot: boolean;
};

export type ReferenceFrom = AttemptReference & { source: ReferenceSourceInfo | null };

export type ReferenceTo = AttemptReference & {
  referencing: {
    id: string;
    captureId: string;
    step: string;
    state: AttemptState;
    revision: number;
  } | null;
};

export type SearchExperienceHit = ExperienceListItem & {
  matchReason: string;
  snippet: string;
};

export type SearchCaptureHit = {
  id: string;
  rawText: string;
  archived: boolean;
  snippet: string;
  matchField: string;
};

export type SearchAttemptHit = {
  id: string;
  captureId: string;
  step: string;
  state: AttemptState;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  snippet: string;
  matchField: string;
};

export type DeletePreview = {
  captureId: string;
  attemptCount: number;
  referencesFromAttempts: number;
  referencesToAttempts: number;
  /** 手动关联（两端任一侧）数量 */
  captureLinkCount?: number;
  /** AI 生成记录数；服务端未部署 AI 时可能缺省 */
  generationCount?: number;
  /** 全部关联日程（含已取消）；服务端未部署日程时可能缺省 */
  scheduleCount?: number;
  /** 关联研究任务数；服务端未部署研究时可能缺省 */
  researchCount?: number;
  /** 这条记录（或其尝试）被哪些经验当作依据；删除前展示正文处理规则 */
  affectedExperiences?: ExperienceImpact[];
  /** 删除的对象本身是经验时的公开详情 */
  experience?: ExperiencePublic | null;
};

export type CreateAttemptInput = {
  step: string;
  state?: AttemptState;
  resultText?: string | null;
  outcome?: AttemptOutcome | null;
  sourceUrl?: string | null;
  operationId: string;
};

// ===== AI 设置与生成 =====

export type AiTestStatus = 'success' | 'failure';

export type AiModelsResponse = {
  configured: boolean;
  enabled: boolean;
  configName: string | null;
  baseUrl: string | null;
  currentModelId: string | null;
  models: string[];
  fetched: boolean;
  note: string | null;
};

export type AssistDraftAttempt = {
  step: string;
  state: 'todo' | 'done';
  resultText: string | null;
  outcome: 'success' | 'failure' | 'undetermined' | null;
};

export type AssistDraft = {
  captureText: string;
  attempts: AssistDraftAttempt[];
  autoOpen?: boolean;
};

export type AssistCaptureResponse = {
  reply: string;
  draft: AssistDraft | null;
  modelId: string;
  configName: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number;
};

export type AiTestResult = {
  status: AiTestStatus;
  testedAt: number;
  modelId: string;
  baseUrl: string;
  durationMs: number;
  errorCode: string | null;
  errorDetail: string | null;
  /** 地址、模型或密钥在测试后发生变化时为 true */
  stale: boolean;
};

export type AiConfig = {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  allowLocal: boolean;
  hasApiKey: boolean;
  configVersion: number;
  createdAt: number;
  updatedAt: number;
  test: AiTestResult | null;
};

export type AiSettings = {
  configured: boolean;
  config: AiConfig | null;
  masterKey: { path: string; exists: boolean };
  limits: {
    maxCaptureChars: number;
    maxConstraintChars: number;
    timeoutMs: number;
  };
};

export type SaveAiSettingsInput = {
  name: string;
  baseUrl: string;
  modelId: string;
  /** 首次保存必填；已有配置时省略或空字符串表示保留原密钥 */
  apiKey?: string;
  enabled?: boolean;
  allowLocal?: boolean;
};

export type AiSuggestionKind = 'executable' | 'defer' | 'clarify';

export type AiSuggestionSourceRef = {
  attemptId: string;
  note: string;
};

export type AiSuggestion = {
  kind: AiSuggestionKind;
  step: string | null;
  why: string;
  estimatedMinutes: number | null;
  question: string | null;
  /** 新模型会返回；旧记录没有该字段 */
  sources?: AiSuggestionSourceRef[];
};

/** 「参考旧经验」候选尝试 */
export type ExperienceCandidate = {
  id: string;
  captureId: string;
  captureText: string;
  captureArchived: boolean;
  captureRevision: number;
  step: string;
  resultText: string;
  outcome: AttemptOutcome | null;
  observedAt: number | null;
  sourceUrl: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  matchReasons: string[];
};

export type ExperienceCandidatesResponse = {
  captureId: string;
  query: string;
  suggestedQuery: string;
  limit: number;
  total: number;
  candidates: ExperienceCandidate[];
};

/** 预览接口返回的真实来源内容 */
export type ExperiencePreviewSource = {
  attemptId: string;
  captureId: string;
  captureText: string;
  captureRevision: number;
  attemptRevision: number;
  step: string;
  resultText: string;
  outcome: AttemptOutcome | null;
  observedAt: number | null;
  sourceUrl: string | null;
  captureArchived: boolean;
};

export type ExperiencePreview = {
  capture: { id: string; rawText: string; revision: number };
  constraint: string | null;
  config: { id: string; name: string; modelId: string; configVersion: number };
  sources: ExperiencePreviewSource[];
  contextToken: string;
};

/** 生成结果中公开的来源快照；删除的来源不返回正文 */
export type GenerationSource = {
  attemptId: string;
  note: string | null;
  attemptRevision: number | null;
  captureId: string | null;
  step: string | null;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  observedAt: number | null;
  sourceUrl: string | null;
  captureText: string | null;
  currentExists: boolean;
  currentRevision: number | null;
  changed: boolean;
  deleted: boolean;
};

export type AiGenerationStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AiGeneration = {
  id: string;
  captureId: string;
  captureRevision: number;
  inputText: string;
  constraint: string | null;
  configId: string;
  configVersion: number;
  configName: string;
  modelId: string;
  status: AiGenerationStatus;
  kind: AiSuggestionKind | null;
  suggestion: AiSuggestion | null;
  errorCode: string | null;
  /** 已脱敏，可直接展示 */
  errorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  adoptedAttemptId: string | null;
  adoptedAt: number | null;
  dismissedAt: number | null;
  isExpired: boolean;
  createdAt: number;
  finishedAt: number | null;
  /** 新接口返回；旧生成记录可能没有 */
  sources?: GenerationSource[];
  sourcesChanged?: boolean;
  contextInvalidated?: boolean;
  contextInvalidReason?: string | null;
};

export type AiConfigStatus =
  | 'unconfigured'
  | 'disabled'
  | 'untested'
  | 'success'
  | 'failure'
  | 'stale';

export const AI_CONFIG_STATUS_LABEL: Record<AiConfigStatus, string> = {
  unconfigured: '未配置',
  disabled: '已停用',
  untested: '待测试',
  success: '连接成功',
  failure: '连接失败',
  stale: '测试已过期',
};

/** 由当前配置实时推导状态徽标（测试是否过期以服务端 stale 为准） */
export function getAiConfigStatus(config: AiConfig | null): AiConfigStatus {
  if (!config) return 'unconfigured';
  if (!config.enabled) return 'disabled';
  if (!config.test) return 'untested';
  if (config.test.stale) return 'stale';
  return config.test.status === 'success' ? 'success' : 'failure';
}

export const AI_GENERATION_STATUS_LABEL: Record<AiGenerationStatus, string> = {
  pending: '正在生成',
  succeeded: '已生成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** 契约 §6 错误分类文案 */
export const AI_ERROR_LABEL: Record<string, string> = {
  unreachable: '地址不可达',
  auth: '认证失败',
  model_unavailable: '模型不可用',
  timeout: '请求超时',
  invalid_response: '响应格式不支持',
  rate_limited: '请求过于频繁',
  redirect_blocked: '地址重定向被拒绝',
  invalid_url: '地址格式不支持',
  local_not_allowed: '本机地址未获允许',
  cancelled: '已取消',
  interrupted: '服务重启中断',
  ai_not_configured: '未配置',
  ai_disabled: '已停用',
  generation_in_progress: '正在生成',
  too_many_generations: '生成任务过多',
  suggestion_expired: '建议已过期',
  not_adoptable: '该建议不能直接采用',
  version_conflict: '念头已更新',
  operation_key_conflict: '操作冲突，请重试',
  test_in_progress: '已有测试正在进行',
  capture_too_long: '念头原文过长',
  constraint_too_long: '补充限制过长',
  invalid_request: '请求格式不正确',
  generation_not_found: '生成记录不存在',
  capture_not_found: '念头不存在',
  context_changed: '预览后内容已变化',
  source_unavailable: '部分来源不可用',
  sources_changed: '建议依据已变化',
  invalid_sources: '请选择 1–3 条旧经验',
  // 阶段回顾
  invalid_range: '时间范围无效',
  invalid_timezone: '时区无效',
  invalid_preset: '范围类型无效',
  invalid_keys: '部分记录不可用',
  records_changed: '记录已变化',
  review_too_large: '内容超过可发送上限',
  no_records: '没有可发送的记录',
  too_many_reviews: '同时进行的回顾过多',
  not_cancellable: '这次回顾无法取消',
  not_savable: '这次回顾暂不能保存',
  review_not_found: '回顾不存在',
};

export function aiErrorText(code?: string | null, fallback?: string | null): string {
  if (code && AI_ERROR_LABEL[code]) return AI_ERROR_LABEL[code];
  if (fallback) return fallback;
  return '请求失败';
}

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
  outcome: AttemptOutcome | null;
  kind: AiSuggestionKind | null;
};

export type ActivityStats = {
  totalEvents: number;
  last7Days: number;
  captures: number;
  attempts: number;
  results: number;
  references: number;
  aiRequests: number;
  aiAdopted: number;
};

export type ActivityFilter = {
  type: 'all' | ActivityEventType;
  label: string;
  count: number;
};

export type ActivityResponse = {
  generatedAt: number;
  total: number;
  events: ActivityEvent[];
  stats: ActivityStats;
  filters: ActivityFilter[];
};

export const ACTIVITY_TYPE_LABEL: Record<ActivityEventType, string> = {
  capture: '念头',
  attempt: '尝试',
  result: '结果',
  reference: '引用',
  ai: 'AI',
};

// ===== 阶段回顾（docs/review-api-contract.md） =====

export type ReviewPreset = '7d' | '30d' | 'custom';
export type ReviewStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type ReviewRecordType = 'capture' | 'attempt' | 'reference';
export type ReviewBasis = 'observation' | 'inference';

export type ReviewReason =
  | 'capture_created'
  | 'capture_modified'
  | 'attempt_started'
  | 'attempt_modified'
  | 'attempt_current_ended'
  | 'result_recorded'
  | 'result_time_unknown'
  | 'reference_created';

/** 服务端确认过的时间边界：from 含、to 不含 */
export type ReviewRange = {
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
  fromLocal: string;
  toLocal: string;
  timezone: string;
  preset: ReviewPreset;
  days: number;
  endExclusive: boolean;
};

/** 范围内的一条实际记录（键：capture:… / attempt:… / reference:…） */
export type ReviewRecord = {
  key: string;
  type: ReviewRecordType;
  sourceId: string;
  captureId: string;
  attemptId: string | null;
  relatedAttemptId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  createdAt: number;
  updatedAt: number | null;
  observedAt: number | null;
  revision: number;
  captureRevision: number;
  relatedRevision: number | null;
  archived: boolean;
  reasons: ReviewReason[];
  fromAttemptId: string | null;
  toAttemptId: string | null;
  note: string | null;
};

export type ReviewStats = {
  capturesCreated: number;
  capturesModified: number;
  attemptsStarted: number;
  attemptsModified: number;
  attemptsCurrentlyEnded: number;
  resultsRecorded: number;
  resultsMissingObservedAt: number;
  referencesCreated: number;
  totalRecords: number;
};

export type ReviewStatDefinition = {
  key: string;
  label: string;
  value: number;
  definition: string;
};

export type ReviewSections = {
  captures: string[];
  attempts: string[];
  results: string[];
  references: string[];
  modifications: string[];
};

export type ReviewRangeCoverage = {
  totalRecords: number;
  uniqueKeys: number;
  truncated: boolean;
  maxRangeRecords: number;
};

export type ReviewLimits = {
  maxRecords: number;
  maxChars: number;
  maxRangeDays: number;
};

export type ReviewAiConfig = {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
};

export type ReviewAiSummary = {
  configured: boolean;
  enabled: boolean;
  config: ReviewAiConfig | null;
};

export type ReviewPreviewCoverage = {
  totalRecords: number;
  selectedRecords: number;
  excludedRecords: number;
  selectedChars: number;
  maxRecords: number;
  maxChars: number;
  withinLimit: boolean;
  truncated: boolean;
  sectionCounts: {
    captures: number;
    attempts: number;
    results: number;
    references: number;
    modifications: number;
  };
};

export type ReviewItem = {
  text: string;
  basis: ReviewBasis;
  sourceIds: string[];
};

export type ReviewContent = {
  overview: string;
  attempts: ReviewItem[];
  observations: ReviewItem[];
  connections: ReviewItem[];
  experiences: ReviewItem[];
  uncertainties: string[];
  insufficientData: boolean;
  dataNotes: string | null;
};

/** 保存时的来源快照 + 当前状态；已删除来源不返回正文 */
export type ReviewSource = {
  key: string;
  type: ReviewRecordType;
  sourceId: string;
  captureId: string;
  attemptId: string | null;
  relatedAttemptId: string | null;
  title: string;
  text: string | null;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  revision: number;
  captureRevision: number;
  relatedRevision: number | null;
  createdAt: number;
  updatedAt: number | null;
  exists: boolean;
  changed: boolean;
  deleted: boolean;
  currentRevision: number | null;
  currentCaptureRevision: number | null;
  currentRelatedRevision: number | null;
  openCaptureId: string | null;
  openAttemptId: string | null;
};

export type ReviewPublic = {
  id: string;
  status: ReviewStatus;
  range: ReviewRange;
  config: ReviewAiConfig | null;
  stats: ReviewStats | null;
  coverage: ReviewPreviewCoverage | null;
  content: ReviewContent | null;
  sources: ReviewSource[];
  savedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  contentInvalidated: boolean;
  contentInvalidReason: string | null;
  sourcesChanged: boolean;
  canSave: boolean;
};

export type ReviewListItem = {
  id: string;
  range: ReviewRange;
  savedAt: number;
  createdAt: number;
  overview: string;
  stats: ReviewStats | null;
  contentInvalidated: boolean;
  sourceCount: number;
  changedSourceCount: number;
};

export type ReviewRangeInput = {
  from: number;
  to: number;
  timezone: string;
  preset: ReviewPreset;
};

export type ReviewPreviewInput = ReviewRangeInput & {
  includeKeys: string[];
};

export type CreateReviewInput = ReviewPreviewInput & {
  contextToken: string;
  operationId: string;
};

export type ReviewDailyDay = {
  date: string;
  capturesCount: number;
  attemptsCount: number;
  aiCount: number;
  aiTokens: number;
  aiBreakdown: {
    generations: number;
    reviews: number;
    asks: number;
    research: number;
    assist?: number;
  };
};

export type ReviewDailyResponse = {
  range: ReviewRange;
  today: string;
  days: ReviewDailyDay[];
};

export type ReviewRangeResponse = {
  range: ReviewRange;
  stats: ReviewStats;
  statDefinitions: ReviewStatDefinition[];
  records: ReviewRecord[];
  sections: ReviewSections;
  coverage: ReviewRangeCoverage;
  limits: ReviewLimits;
  ai: ReviewAiSummary;
  generatedAt: number;
};

export type ReviewPreviewResponse = {
  range: ReviewRange;
  stats: ReviewStats;
  config: ReviewAiConfig | null;
  ai: { configured: boolean; enabled: boolean };
  records: ReviewRecord[];
  coverage: ReviewPreviewCoverage;
  contextToken: string;
};

export const REVIEW_PRESET_LABEL: Record<ReviewPreset, string> = {
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  custom: '自定义日期范围',
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: '正在生成',
  succeeded: '已生成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export const REVIEW_BASIS_LABEL: Record<ReviewBasis, string> = {
  observation: '记录中的观察',
  inference: '模型推断',
};

export const REVIEW_RECORD_TYPE_LABEL: Record<ReviewRecordType, string> = {
  capture: '念头',
  attempt: '尝试',
  reference: '引用',
};

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  capture_created: '新建',
  capture_modified: '修改',
  attempt_started: '开始',
  attempt_modified: '修改',
  attempt_current_ended: '当前已结束',
  result_recorded: '结果',
  result_time_unknown: '结果时间未记录',
  reference_created: '新建引用',
};

// ===== 回顾后的下一步行动（docs/next-action-api-contract.md） =====

/** 下一步行动复用 Attempt；列表/详情接口返回该结构。 */
export type NextActionSource = {
  key: string;
  type: ReviewRecordType;
  sourceId: string;
  attemptId: string | null;
  captureId: string | null;
  title: string | null;
  /** 来源存在时才有；已删除来源不返回正文 */
  text?: string | null;
  resultText?: string | null;
  state: AttemptState | null;
  revision: number | null;
  currentRevision: number | null;
  changed: boolean;
  deleted: boolean;
};

export type NextActionReviewSummary = {
  id: string;
  savedAt: number | null;
  range: ReviewRange | null;
  contentInvalidated: boolean;
  sourcesChanged: boolean;
};

export type NextActionExperience = {
  text: string;
  basis: ReviewBasis;
  sourceIds: string[];
};

export type NextAction = {
  /** = attemptId */
  id: string;
  captureId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  state: AttemptState;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  observedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin: 'review_next_action';
  sourceReviewId: string;
  sourceExperienceIndex: number;
  sourceAttemptId: string | null;
  sourceAttemptRevision: number | null;
  capture: { id: string; rawText: string; revision: number; archivedAt: number | null } | null;
  sourceReview: NextActionReviewSummary | null;
  /** 模型建议正文；保存前展示时必须标「模型推断/建议」 */
  experience: NextActionExperience | null;
  sources: NextActionSource[];
  schedules: ScheduleBlock[];
  canEdit: boolean;
  /** 部分来源已删除时为 true */
  deleted?: boolean;
};

export type NextActionPreviewSourceAttempt = {
  attemptId: string;
  captureId: string | null;
  step: string | null;
  state: AttemptState | null;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  revision: number | null;
  captureRevision: number | null;
  captureText: string | null;
  exists: boolean;
  changed: boolean;
  deleted: boolean;
};

export type NextActionPreviewCapture = {
  id: string;
  rawText: string;
  revision: number;
  archivedAt: number | null;
};

export type NextActionPreviewDefaults = {
  captureId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  suggestedDate: string;
  timezone: string;
};

export type NextActionPreview = {
  review: NextActionReviewSummary;
  experienceIndex: number;
  experience: NextActionExperience;
  sourceAttempts: NextActionPreviewSourceAttempt[];
  captures: NextActionPreviewCapture[];
  defaults: NextActionPreviewDefaults;
  contextToken: string;
};

export type NextActionScheduleInput = {
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  timezone: string;
  note?: string | null;
  startDisambiguation?: LocalTimeDisambiguation;
  endDisambiguation?: LocalTimeDisambiguation;
  confirmOverlap?: boolean;
  conflictToken?: string | null;
  expectedConflictIds?: string[];
};

export type CreateNextActionInput = {
  captureId: string;
  captureRevision: number;
  experienceIndex: number;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  contextToken: string;
  operationId: string;
  schedule: NextActionScheduleInput | null;
};

export type UpdateNextActionInput = {
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  revision: number;
  operationId: string;
};

export type NextActionConflict = {
  error: 'schedule_conflict' | 'schedule_conflict_changed';
  message: string;
  conflicts: ScheduleBlock[];
  conflictToken: string | null;
  requiresConfirmation: true;
  options?: { changeTime?: boolean; saveUnscheduled?: boolean; viewConflicts?: boolean };
};

/** 创建/更新写接口的错误中文映射（服务端 body.error） */
export const NEXT_ACTION_ERROR_LABEL: Record<string, string> = {
  unauthenticated: '登录已过期，请重新登录。',
  review_not_found: '回顾不存在。',
  review_not_saved: '这条回顾还没有保存，保存后才能创建下一步。',
  invalid_experience_index: '这条经验条目不存在。',
  source_unavailable: '这条经验的来源尝试已删除或不可用，无法创建下一步。',
  source_deleted: '来源已删除，无法继续使用这条经验。',
  sources_changed: '来源记录有变化，请确认后继续。',
  capture_not_found: '念头不存在或已删除。',
  capture_changed: '念头内容已变化，请刷新来源后重试。',
  invalid_title: '标题需为 1–120 字。',
  invalid_description: '行动说明最多 2000 字。',
  invalid_estimated_minutes: '预计耗时需在 1–1440 分钟之间。',
  invalid_schedule_time: '安排时间不正确。',
  invalid_timezone: '时区无效。',
  nonexistent_local_time: '这个本地时间在夏令时切换中不存在，请换一个时间。',
  ambiguous_local_time: '这个本地时间在夏令时切换中出现两次，请选择使用哪一次。',
  schedule_conflict: '与现有安排重叠。',
  schedule_conflict_changed: '冲突安排有变化，请重新确认。',
  operation_key_conflict: '操作冲突，请重新提交。',
  revision_required: '缺少版本信息，请刷新后重试。',
  revision_conflict: '版本冲突：行动刚被其他窗口修改，你的草稿仍保留。',
  next_action_not_found: '下一步行动不存在或已被删除。',
  not_next_action: '这条记录不是下一步行动。',
};

export function nextActionErrorText(code?: string | null, fallback?: string | null): string {
  if (code && NEXT_ACTION_ERROR_LABEL[code]) return NEXT_ACTION_ERROR_LABEL[code];
  if (fallback) return fallback;
  return '请求失败，请重试。';
}

// ===== 日程安排（docs/schedule-api-contract.md） =====

export type ScheduleStatus = 'active' | 'cancelled';
export type FutureScheduleAction = 'keep' | 'cancel';
export type LocalTimeDisambiguation = 'earlier' | 'later';

export type ScheduleAttemptSummary = {
  id: string;
  step: string;
  state: AttemptState;
  captureId: string;
  /** 旧接口没有该字段；缺省视为 manual */
  origin?: AttemptOrigin;
  sourceReviewId?: string | null;
};

export type ScheduleCaptureSummary = {
  id: string;
  rawText: string;
};

export type ScheduleBlock = {
  id: string;
  attemptId: string;
  /** UTC 毫秒 */
  startsAt: number;
  /** UTC 毫秒 */
  endsAt: number;
  /** 安排创建时采用的 IANA 时区 */
  timezone: string;
  note: string | null;
  status: ScheduleStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt: number | null;
  attempt: ScheduleAttemptSummary | null;
  capture: ScheduleCaptureSummary | null;
};

export type ScheduleRange = {
  from: string;
  to: string;
  timezone: string;
  fromAt: number;
  toAt: number;
  fromIso: string;
  toIso: string;
};

export type ScheduleRangeResponse = {
  range: ScheduleRange;
  schedules: ScheduleBlock[];
  generatedAt: number;
};

export type AttemptSchedulesResponse = {
  schedules: ScheduleBlock[];
  serverNow: number;
};

/** 创建/修改共用的时间表单字段；日期与时间均为表单所在时区的墙上时间。 */
export type ScheduleFormInput = {
  date: string;
  endDate?: string;
  startTime: string;
  endTime: string;
  timezone: string;
  note?: string | null;
  startDisambiguation?: LocalTimeDisambiguation;
  endDisambiguation?: LocalTimeDisambiguation;
  confirmOverlap?: boolean;
  conflictToken?: string | null;
  expectedConflictIds?: string[];
};

export type CreateScheduleInput = ScheduleFormInput & {
  operationId: string;
};

export type UpdateScheduleInput = ScheduleFormInput & {
  revision: number;
};

export type ScheduleConflictResponse = {
  error: 'schedule_conflict' | 'schedule_conflict_changed';
  message: string;
  conflicts: ScheduleBlock[];
  conflictToken: string;
  requiresConfirmation: true;
};

export type ScheduleAmbiguousTimeBody = {
  error: 'ambiguous_local_time';
  message: string;
  zone: string;
  local: string;
  choices: LocalTimeDisambiguation[];
  /** 服务端可能指出歧义发生在开始或结束字段 */
  field?: 'start' | 'end';
};

export type ScheduleCreateResponse = {
  schedule: ScheduleBlock;
  replayed?: boolean;
};

export type ScheduleUpdateResponse = {
  schedule: ScheduleBlock;
};

export type ScheduleCancelResponse = {
  schedule: ScheduleBlock;
};

export type AttemptDeletePreview = {
  attemptId: string;
  scheduleCount: number;
  activeScheduleCount: number;
  referencesFromAttempts: number;
  referencesToAttempts: number;
  /** 这次结果被哪些经验当作依据；删除前展示会受影响的正文处理 */
  affectedExperiences?: ExperienceImpact[];
};

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  active: '有效',
  cancelled: '已取消',
};

export const STATE_LABEL: Record<AttemptState, string> = {
  todo: '待尝试',
  in_progress: '进行中',
  done: '已结束',
  cancelled: '已放弃',
};

export const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  success: '成功',
  failure: '失败',
  undetermined: '未判定',
};

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 研究一下：GitHub 开源项目调研 =====

export type ResearchStatus =
  | 'searching'
  | 'candidates'
  | 'fetching'
  | 'generating'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type ResearchConstraints = {
  goal: string | null;
  environment: string | null;
  language: string | null;
  timeBudget: string | null;
  requirements: string | null;
};

export type ResearchSearchInput =
  | { mode: 'keyword'; query: string; repos: [] }
  | { mode: 'repositories'; query: null; repos: string[] };

export type RepositoryCandidate = {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  archived: boolean;
  fork: boolean;
  defaultBranch: string | null;
  stars: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  license: { spdxId: string | null; name: string | null; url: string | null } | null;
  fetchedAt: number;
  via: 'search' | 'direct';
  apiUrl: string;
};

export type CandidateFailure = {
  id: string;
  fullName: string | null;
  input: string;
  code: string;
  detail: string;
  status: number | null;
  resetAt: number | null;
  fetchedAt: number;
  kind?: string;
};

export type ResearchSourceKind = 'repo_meta' | 'readme' | 'license' | 'releases';

export type ResearchSource = {
  sourceKey: string;
  repoFullName: string;
  repoId: string;
  kind: string;
  url: string;
  filePath: string | null;
  refName: string | null;
  commitSha: string | null;
  excerpt: string;
  fetchedAt: number;
  status: 'ok' | 'missing' | 'failed' | string;
  errorCode: string | null;
  errorDetail: string | null;
};

export type ResearchCitation = { text: string; sourceIds: string[] };

export type ResearchProject = {
  repo: string;
  summary: string;
  matches: ResearchCitation[];
  gaps: ResearchCitation[];
  unknowns: string[];
  licenseNote: string;
};

export type ResearchExperiment = {
  title: string;
  description: string;
  estimatedMinutes: number | null;
  repo: string;
  sourceIds: string[];
  verifies: string;
};

export type ResearchResult = {
  summary: string;
  projects: ResearchProject[];
  experiments: ResearchExperiment[];
  insufficient: boolean;
  limitations: string[];
};

export type ResearchStats = {
  github: {
    requests: number;
    searchRequests: number;
    detailRequests: number;
    byRepo: Record<string, number>;
  } | null;
  candidates: number;
  selected: number;
  sourceCount: number;
  sourcesSent: number;
  failedRepos: number;
  missingSources: number;
  promptChars: number;
};

export type ResearchAttemptLink = {
  attemptId: string;
  experimentIndex: number;
  title: string;
  state: AttemptState;
  createdAt: number;
};

export type ResearchPublic = {
  id: string;
  captureId: string;
  captureRevision: number;
  captureText: string;
  question: string;
  constraints: ResearchConstraints | null;
  search: { mode: string; query: string | null; repos: string[]; display: string };
  status: ResearchStatus;
  revision: number;
  savedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  limits: {
    maxCandidates: number;
    maxSelected: number;
    maxRepoInputs: number;
    maxQuestionChars: number;
    maxConstraintChars: number;
    maxReadmeChars: number;
    maxPromptChars: number;
    concurrency: number;
    githubTimeoutMs: number;
    githubRetries: number;
    modelTimeoutMs: number;
    modelMaxOutputTokens: number;
  };
  candidates: RepositoryCandidate[];
  candidateFailures: CandidateFailure[];
  candidatesFetchedAt: number | null;
  candidatesTotal: number | null;
  candidatesRate: { limit: number | null; remaining: number | null; resetAt: number | null } | null;
  selectedCandidateIds: string[];
  sources: ResearchSource[];
  result: ResearchResult | null;
  config: { id: string | null; name: string | null; modelId: string | null; version: number | null };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  stats: ResearchStats | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetail: string | null;
  failed: CandidateFailure[];
  attempts: ResearchAttemptLink[];
  sentSourceIds: string[];
  canCancel: boolean;
  canSave: boolean;
  canSelect: boolean;
  canRetrySearch: boolean;
  canRetryFetch: boolean;
  canRetryGenerate: boolean;
  saved: boolean;
};

export type ResearchPreview = {
  capture: { id: string; rawText: string; revision: number };
  question: string;
  constraints: ResearchConstraints;
  search: ResearchSearchInput & { mode: 'keyword' | 'repositories' };
  searchDisplay: string;
  limits: ResearchPublic['limits'];
  estimatedGithubRequests: number;
  maxDetailRequests: number;
  modelCalls: number;
  ai: {
    configured: boolean;
    enabled: boolean;
    config: { id: string; name: string; modelId: string; version: number } | null;
  };
  github: { hasToken: boolean; apiBase: string };
  modelInput: {
    question: string;
    constraints: ResearchConstraints;
    note: string;
  };
  contextToken: string;
};

export type ResearchListItem = {
  id: string;
  captureId?: string;
  question: string;
  status: ResearchStatus;
  savedAt: number | null;
  createdAt: number;
  revision?: number;
  summary?: string | null;
  attemptCount?: number;
  errorCode?: string | null;
};

export type ResearchAttemptDetail = {
  exists: boolean;
  id: string;
  question: string | null;
  status: string | null;
  savedAt: number | null;
  experimentIndex: number;
  suggestion: {
    title?: string;
    description?: string;
    estimatedMinutes?: number | null;
    repo?: string;
    verifies?: string;
    sourceIds?: string[];
  } | null;
  sources: ResearchSource[];
  deleted: boolean;
};

export const RESEARCH_STATUS_LABEL: Record<ResearchStatus, string> = {
  searching: '正在检索 GitHub',
  candidates: '候选已就绪',
  fetching: '正在读取仓库资料',
  generating: '正在生成对比',
  succeeded: '对比已生成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '已中断',
};

export const RESEARCH_SOURCE_KIND_LABEL: Record<string, string> = {
  repo_meta: '元数据（本次实际查到）',
  readme: 'README（作者声明）',
  license: '许可证（检测结果）',
  releases: '发布信息（本次实际查到）',
};

export const RESEARCH_ERROR_TEXT: Record<string, string> = {
  rate_limited: 'GitHub 请求额度已用完',
  timeout: '请求超时',
  not_found: 'GitHub 资源不存在（404）',
  auth: 'GitHub Token 认证失败',
  forbidden: 'GitHub 拒绝了请求',
  unreachable: 'GitHub 地址不可达',
  invalid_response: '响应格式不支持',
  invalid_repo: '仓库地址不合法',
  cancelled: '已取消',
  interrupted: '服务重启中断',
  no_candidates: '没有找到可用仓库',
  all_repos_failed: '所选仓库均读取失败',
  ai_not_configured: '未配置 AI 模型',
  ai_disabled: 'AI 模型已停用',
  ai_failed: '模型生成失败',
  sources_changed: '研究资料已变化',
  version_conflict: '研究版本已变化',
  research_not_found: '研究不存在',
  experiment_not_found: '小实验建议不存在',
  not_adoptable: '这次研究暂时不能采用',
  too_many_research: '同时进行的研究过多',
  research_running: '研究正在进行',
  not_selectable: '当前状态不能选择候选',
  not_retryable: '当前状态不能重试',
  no_selection: '还没有选择候选仓库',
  no_sources: '还没有可用资料',
  not_savable: '研究结果尚未生成',
  invalid_selection: '请选择 1–3 个仓库',
  invalid_question: '研究问题不正确',
  invalid_search: '检索条件不正确',
  context_changed: '预览后内容或配置已变化',
  operation_key_conflict: '操作冲突，请重试',
};

export function researchErrorText(code?: string | null, fallback?: string | null): string {
  if (code && RESEARCH_ERROR_TEXT[code]) return RESEARCH_ERROR_TEXT[code];
  if (fallback) return fallback;
  return '请求失败';
}

// 生成稳定操作 ID（重复点击/网络重试共用）
export function newOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ===== 问我的记录（docs/ask-api-contract.md） =====

export type AskCandidateType = 'attempt' | 'capture';
export type AskQueryStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type AskBasis = 'observation' | 'inference';
export type AskMatchKind = 'direct' | 'relation' | 'expanded';

export const ASK_MAX_QUESTION_CHARS = 500;
export const ASK_MAX_RECORDS = 8;
export const ASK_DEFAULT_CANDIDATES = 20;
export const ASK_MAX_SUGGESTION_TERMS = 5;
export const ASK_MAX_SUGGESTION_TERM_CHARS = 40;

export type AskRange = {
  from: number | null;
  to: number | null;
  fromLocal: string | null;
  toLocal: string | null;
};

export type AskCandidate = {
  sourceKey: string;
  type: AskCandidateType;
  id: string;
  captureId: string;
  title: string;
  snippet: string;
  date: number | null;
  dateKind: 'observed' | 'created';
  state: AttemptState | null;
  outcome: AttemptOutcome | null;
  archived: boolean;
  matchReasons: string[];
  matchKind: AskMatchKind;
  /** 由 expanded 检索词命中的词；direct/relation 候选也可能带扩展词命中。 */
  matchedKeywords?: string[];
  referenceCount: number;
  openHref: string;
};

export type AskAiConfig = {
  id: string;
  name: string;
  modelId: string;
  configVersion: number;
};

export type AskAiSummary = {
  configured: boolean;
  enabled: boolean;
  config: AskAiConfig | null;
};

export type AskSearchResponse = {
  question: string;
  keywords: string[];
  suggestedKeywords: string;
  range: AskRange;
  total: number;
  limit: number;
  candidates: AskCandidate[];
  ai: AskAiSummary;
  generatedAt: number;
  /** 本次检索实际使用的扩展词（服务端回显）。 */
  expandedKeywords?: string[];
};

export type AskKeywordSuggestionsResponse = {
  question: string;
  keywords: string[];
  terms: string[];
  config: AskAiConfig;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number;
  generatedAt: number;
  /** 带 topicId 时服务端返回的主题范围摘要；模型本身不接收主题信息。 */
  topic?: TopicAskScope | null;
  replayed?: boolean;
};

export type AskKeywordSuggestInput = {
  operationId: string;
  question: string;
  keywords?: string;
  topicId?: string | null;
  scopeHash?: string | null;
  configVersion: number;
};

export type AskRecord = {
  sourceKey: string;
  type: AskCandidateType;
  id: string;
  captureId: string;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  createdAt: number;
  revision: number;
  captureRevision: number;
  captureText: string;
  archived: boolean;
};

export type AskPreviewCoverage = {
  selectedRecords: number;
  selectedChars: number;
  maxRecords: number;
  maxChars: number;
  withinLimit: boolean;
};

export type AskPreviewResponse = {
  question: string;
  keywords: string[];
  range: AskRange;
  config: AskAiConfig | null;
  ai: { configured: boolean; enabled: boolean };
  records: AskRecord[];
  coverage: AskPreviewCoverage;
  contextToken: string;
  /** 带 topicId 提问时服务端返回的主题范围（仅展示，不可伪造） */
  scope?: TopicAskScope | null;
};

export type AskPoint = {
  text: string;
  basis: AskBasis;
  condition: string | null;
  sourceIds: string[];
};

export type AskContradictionSide = {
  sourceId: string;
  condition: string;
};

export type AskContradiction = {
  text: string;
  sides: AskContradictionSide[];
};

export type AskAnswer = {
  summary: string;
  points: AskPoint[];
  contradictions: AskContradiction[];
  missing: string[];
  insufficientEvidence: boolean;
};

export type AskSourceSnapshot = {
  sourceKey: string;
  type: AskCandidateType;
  id: string;
  captureId: string;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  createdAt: number | null;
  revision: number;
  captureRevision: number;
  captureText: string;
  archived: boolean;
  deleted?: boolean;
};

export type AskSourcePublic = {
  sourceKey: string;
  type: AskCandidateType;
  id: string;
  captureId: string;
  title: string | null;
  text: string | null;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  createdAt: number | null;
  archived: boolean;
  exists: boolean;
  changed: boolean;
  deleted: boolean;
  openHref: string | null;
  graphHref: string | null;
  canReuse: boolean;
};

export type AskPublic = {
  id: string;
  question: string;
  keywords: string[];
  range: AskRange;
  status: AskQueryStatus;
  answer: AskAnswer | null;
  sources: AskSourcePublic[];
  config: AskAiConfig | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  answerInvalidated: boolean;
  answerInvalidReason: string | null;
  hiddenPointCount: number;
  canCancel: boolean;
  /** 带 topicId 提问时返回的主题范围 */
  scope?: TopicAskScope | null;
};

export type AskListItem = {
  id: string;
  question: string;
  status: AskQueryStatus;
  createdAt: number;
  finishedAt: number | null;
  summary: string | null;
  sourceCount: number;
  deletedSourceCount: number;
  insufficientEvidence: boolean;
};

export type AskSearchParams = {
  question: string;
  keywords?: string;
  from?: number | null;
  to?: number | null;
  limit?: number;
  expandedKeywords?: string[];
};

export type AskPreviewInput = {
  question: string;
  keywords: string;
  from: number | null;
  to: number | null;
  sourceKeys: string[];
  /** 主题范围；提供时服务端强制 allowed source scope */
  topicId?: string | null;
};

export type CreateAskQueryInput = AskPreviewInput & {
  contextToken: string;
  operationId: string;
};

export const ASK_STATUS_LABEL: Record<AskQueryStatus, string> = {
  pending: '正在回答',
  succeeded: '已回答',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export const ASK_TYPE_LABEL: Record<AskCandidateType, string> = {
  attempt: '尝试',
  capture: '念头',
};

export const ASK_BASIS_LABEL: Record<AskBasis, string> = {
  observation: '记录中的观察',
  inference: '模型推断',
};

export const ASK_ERROR_LABEL: Record<string, string> = {
  timeout: '模型请求超时',
  invalid_response: '回答格式不支持',
  ai_not_configured: '尚未配置 AI 模型',
  ai_disabled: 'AI 模型已停用',
  context_changed: '核对后记录或配置有变化',
  config_changed: '模型配置已变化',
  topic_scope_changed: '主题范围已变化',
  ai_failed: '模型请求失败',
  sources_unavailable: '部分来源已被删除或不可访问',
  query_too_large: '记录过多或内容过长',
  too_many_queries: '同时进行的提问过多',
  operation_key_conflict: '操作冲突，请重试',
  query_not_found: '这次提问不存在',
  not_cancellable: '这次提问已结束，无法取消',
  invalid_question: '问题不能为空或过长',
  invalid_keywords: '关键词过长',
  invalid_range: '日期范围无效',
  invalid_sources: '请选择 1–8 条记录',
  source_out_of_scope: '所选记录不在这个主题的范围内，请重新选择',
  topic_not_found: '主题不存在或已删除',
  cancelled: '已取消',
  interrupted: '服务重启中断',
};

export function askErrorText(code?: string | null, fallback?: string | null): string {
  if (code && ASK_ERROR_LABEL[code]) return ASK_ERROR_LABEL[code];
  if (fallback) return fallback;
  return '请求失败';
}

// ===== 知识网络（只读投影） =====

export type GraphNodeType = 'capture' | 'experience' | 'attempt' | 'research' | 'review' | 'schedule';

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  detail: string;
  createdAt: number;
  state: string | null;
  archived: boolean;
  href: string;
  degree: number;
  captureId?: string | null;
  captureLabel?: string | null;
  resultText?: string | null;
  observedAt?: number | null;
  outcome?: string | null;
  sourceUrl?: string | null;
  origin?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
};

export type GraphLink = {
  id: string;
  source: string;
  target: string;
  type:
    | 'contains'
    | 'references'
    | 'related'
    | 'researches'
    | 'adopted'
    | 'scheduled'
    | 'reviews'
    | 'evidence'
    | 'used'
    | 'context';
  label: string;
};

export type GraphResponse = {
  stats: {
    captures: number;
    experiences?: number;
    attempts: number;
    research: number;
    reviews: number;
    schedules: number;
    links: number;
    manualLinks?: number;
  };
  nodes: GraphNode[];
  links: GraphLink[];
  meta?: {
    scope: 'global' | 'local';
    limit: number | null;
    totalCaptures: number;
    shownCaptures: number;
    totalExperiences?: number;
    shownExperiences?: number;
    truncated: boolean;
    focus: string | null;
    depth: 1 | 2 | null;
  };
};

export type GraphSearchHit = {
  node: GraphNode;
  captureId: string | null;
  captureLabel: string | null;
  matchField: string;
  snippet: string;
  archived: boolean;
};

export type GraphSearchResponse = {
  query: string;
  archived: boolean;
  types: GraphNodeType[];
  total: number;
  results: GraphSearchHit[];
};

export const GRAPH_TYPE_LABEL: Record<GraphNodeType, string> = {
  capture: '念头',
  experience: '经验',
  attempt: '尝试',
  research: '研究',
  review: '回顾',
  schedule: '安排',
};

// ===== 念头关联（有方向的链接 + 反链） =====

export type CaptureLinkCapture = {
  id: string;
  rawText: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archived: boolean;
  kind?: 'thought' | 'experience';
  title?: string;
  href?: string;
};

export type CaptureLinkItem = {
  id: string;
  fromCaptureId: string;
  toCaptureId: string;
  note: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  direction: 'out' | 'in';
  capture: CaptureLinkCapture;
};

export type CaptureLinksResponse = {
  captureId: string;
  out: CaptureLinkItem[];
  in: CaptureLinkItem[];
  counts: { out: number; in: number };
};

export type CaptureLinkCandidate = CaptureLinkCapture & {
  snippet: string;
  alreadyLinked: boolean;
};

export type CaptureLinkCandidatesResponse = {
  query: string;
  excludeId: string | null;
  total: number;
  limit: number;
  captures: CaptureLinkCandidate[];
};

export type CaptureReferenceOut = {
  id: string;
  note: string | null;
  snapshotResultText: string | null;
  snapshotRevision: number;
  createdAt: number;
  from: { id: string; step: string; state: AttemptState };
  to: {
    id: string;
    step: string;
    state: AttemptState;
    resultText: string | null;
    outcome: AttemptOutcome | null;
    revision: number;
    captureId: string;
    captureText: string;
    archived: boolean;
    updatedSinceSnapshot: boolean;
  };
};

export type CaptureReferenceIn = {
  id: string;
  note: string | null;
  snapshotResultText: string | null;
  snapshotRevision: number;
  createdAt: number;
  from: {
    id: string;
    step: string;
    state: AttemptState;
    captureId: string;
    captureText: string;
    archived: boolean;
  };
  to: {
    id: string;
    step: string;
    state: AttemptState;
    resultText: string | null;
    outcome: AttemptOutcome | null;
    revision: number;
  };
};

export type CaptureReferencesResponse = {
  captureId: string;
  out: CaptureReferenceOut[];
  in: CaptureReferenceIn[];
  counts: { out: number; in: number };
};

// ===== 经验笔记（用户明确保存的理解） =====

export type ExperienceModelBasis = 'observation' | 'inference';
export type ExperienceOriginKind = 'ask' | 'attempt' | 'manual';

export type ExperienceSource = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  deleted: boolean;
  exists: boolean;
  changed: boolean;
  kind: 'attempt' | 'thought' | 'experience' | 'unknown';
  openHref: string | null;
  graphHref: string | null;
  canReference: boolean;
  addedAt: number;
};

export type ExperienceAttempt = {
  id: string;
  title: string;
  state: AttemptState;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  observedAt: number | null;
  createdAt: number;
  adoptedVersion: number;
  adoptedTitle: string;
  adoptedUnderstanding: string;
  basisSourceKeys: string[];
  deleted: boolean;
};

export type ExperiencePublic = {
  id: string;
  title: string;
  understanding: string;
  conditions: string;
  limitations: string;
  derivation: {
    by: 'model' | 'user';
    modelBasis: ExperienceModelBasis | null;
    originKind: ExperienceOriginKind;
    originQueryId: string | null;
    originPointIndex: number | null;
    originAttemptId: string | null;
    contextCaptureId: string | null;
    confirmNote: string;
  };
  needsRevision: boolean;
  revisionReason: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archived: boolean;
  sources: ExperienceSource[];
  sourceCount: number;
  changedSourceCount: number;
  deletedSourceCount: number;
  hasPracticeResult: boolean;
  attempts: ExperienceAttempt[];
  linkCount: number;
  canEdit: boolean;
};

export type ExperienceListItem = {
  id: string;
  title: string;
  summary: string;
  conditions: string;
  limitations: string;
  revision: number;
  updatedAt: number;
  createdAt: number;
  archived: boolean;
  needsRevision: boolean;
  revisionReason: string | null;
  sourceCount: number;
  attemptCount: number;
  hasPracticeResult: boolean;
  derivationBy: 'model' | 'user';
};

export type ExperienceDraftSource = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  kind: 'attempt' | 'thought' | 'experience';
  openHref: string | null;
  exists: boolean;
  changed: boolean;
};

export type ExperienceDraft = {
  originKind: ExperienceOriginKind;
  title: string;
  understanding: string;
  conditions: string;
  limitations: string;
  by: 'model' | 'user';
  modelBasis: ExperienceModelBasis | null;
  originQueryId: string | null;
  originPointIndex: number | null;
  originAttemptId: string | null;
  contextCaptureId: string | null;
  sources: ExperienceDraftSource[];
  hint: string;
};

export type ExperienceImpact = {
  id: string;
  title: string;
  deletedSourceCount: number;
  willClearUnderstanding: boolean;
};

export type ExperienceAttemptRef = {
  experienceId: string;
  adoptedVersion: number;
  adoptedTitle: string;
  adoptedUnderstanding: string;
  deleted: boolean;
  exists: boolean;
  archived: boolean;
  currentVersion: number | null;
  changed: boolean;
};

export type ExperienceDeletePreview = {
  experienceId: string;
  title: string;
  sourceCount: number;
  attemptCount: number;
  linkCount: number;
  sources: Array<{ title: string; type: string; exists: boolean }>;
  attempts: Array<{ id: string; title: string; resultText: string | null; outcome: string | null }>;
};

export const EXPERIENCE_MODE_LABEL: Record<'model' | 'user', string> = {
  model: '由模型整理',
  user: '由你自己整理',
};

export const EXPERIENCE_ERROR_LABEL: Record<string, string> = {
  experience_not_found: '这份经验已不存在',
  source_required: '至少关联一条仍可访问的原记录',
  source_unavailable: '有来源记录已不可访问',
  point_not_found: '这条观点已不存在',
  point_sources_unavailable: '观点引用的原始记录已不可访问',
  attempt_result_required: '这次尝试还没有实际结果',
  revision_conflict: '这份经验已在别处修改',
  revision_required: '缺少版本信息，请刷新后再保存',
  operation_conflict: '操作编号已用于另一份内容',
  experience_version_conflict: '经验刚刚被修改',
  experience_archived: '这份经验已归档',
  basis_source_unavailable: '选中的原始尝试已不可用',
  capture_unavailable: '请选择一个仍可用的念头',
  ask_not_found: '这次问答已不存在',
  ask_not_succeeded: '这次问答还没有生成完成',
  context_unavailable: '所属念头已不可用',
};

export function experienceErrorText(code?: string | null, fallback?: string | null): string {
  if (code && EXPERIENCE_ERROR_LABEL[code]) return EXPERIENCE_ERROR_LABEL[code];
  if (fallback) return fallback;
  return '操作失败，请稍后重试';
}

// ===== 主题工作台（docs/topic-api-contract.md） =====

export type TopicMemberType = 'thought' | 'experience';

/** 主题中的一个成员记录。经验成员与普通念头共用 captureId，但展示字段不同。 */
export type TopicMember = {
  captureId: string;
  type: TopicMemberType;
  title: string;
  summary: string;
  rawText: string | null;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  archivedAt: number | null;
  addedAt: number | null;
  /** 经验：直接依据数；普通念头为 null */
  sourceCount: number | null;
  /** 经验：是否已有实践结果；普通念头为 false */
  hasPracticeResult: boolean;
  /** 经验：是否需要核对来源 */
  needsRevision: boolean;
  experienceId: string | null;
  openHref: string | null;
};

/** 主题聚合的尝试：只来自普通念头成员。 */
export type TopicAttempt = Attempt & {
  captureText: string;
  captureArchived: boolean;
  captureArchivedAt?: number | null;
  /** 后端明确标出是否已记录结果；旧响应缺省时由 resultText/outcome/observedAt/state 推导 */
  resultRecorded?: boolean;
  /** 契约 §5 的服务端三态：recorded / pending_no_result / cancelled */
  resultState?: 'recorded' | 'pending_no_result' | 'cancelled';
  href?: string;
};

export type TopicNextAttempt = TopicAttempt | null;

export type Topic = {
  id: string;
  name: string;
  exploringQuestion: string | null;
  continueNote: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archived: boolean;
  memberCount: number;
  thoughtCount: number;
  experienceCount: number;
  /** 主题成员普通念头下的全部尝试数（后端可选返回） */
  attemptCount: number;
  /** 主题范围记录数（普通念头 + 直接尝试，后端可选返回） */
  recordCount: number;
  lastAttemptAt: number | null;
  nextAttempt: TopicNextAttempt;
  /** 固定尝试失效时后端返回的原因；显示后允许清除 */
  nextAttemptClearedReason: string | null;
  members: TopicMember[];
};

export type CreateTopicInput = {
  name: string;
  exploringQuestion?: string | null;
  continueNote?: string | null;
  operationId?: string;
};

export type UpdateTopicInput = {
  name?: string;
  exploringQuestion?: string | null;
  continueNote?: string | null;
  revision: number;
  operationId?: string;
};

export type TopicCandidate = {
  captureId: string;
  type: TopicMemberType;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  sourceCount: number | null;
  hasPracticeResult: boolean;
  needsRevision: boolean;
  alreadyMember: boolean;
  openHref: string | null;
};

export type TopicMemberCandidatesResponse = {
  query: string;
  type: 'all' | TopicMemberType;
  total: number;
  limit: number;
  nextCursor: string | null;
  candidates: TopicCandidate[];
};

export type TopicAttemptsResponse = {
  attempts: TopicAttempt[];
  total: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  nextAttemptClearedReason: string | null;
  offset?: number;
  limit?: number;
};

export type TopicDeletePreview = {
  topicId: string;
  name: string;
  memberCount: number;
  thoughtCount: number;
  experienceCount: number;
  attemptCount: number;
  nextAttemptStep: string | null;
};

export type CaptureTopic = {
  id: string;
  name: string;
  archived: boolean;
  archivedAt: number | null;
  exploringQuestion: string | null;
};

export type CaptureTopicsResponse = {
  captureId: string;
  topics: CaptureTopic[];
};

export type AddTopicMembersResponse = {
  added: number;
  skipped: number;
  topic: Topic | null;
};

/** 主题提问范围：默认只含成员普通念头及直接尝试，经验依据需手动加入。 */
export type TopicAskScope = {
  topicId: string;
  /** 契约字段名 topicTitle；前端统一读取 topicName 展示 */
  topicTitle?: string;
  topicName: string;
  /** allowed scope 中去重后的可用来源总数（服务端计算，客户端不可伪造） */
  allowedSourceCount: number;
  scopeHash?: string;
  topicRevision?: number;
  /** 普通念头数 */
  thoughtCount: number;
  /** 这些念头下的直接尝试数（服务端可选返回） */
  attemptCount: number;
  /** 主题中的经验成员数（默认不发送） */
  experienceCount: number;
  /** 默认范围记录数；缺省时使用 allowedSourceCount */
  recordCount: number;
};

export type TopicAskCandidatesResponse = AskSearchResponse & {
  topic: { id: string; name: string } | null;
  scope: TopicAskScope | null;
};

export type TopicAskSource = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string;
  title: string;
  text: string;
  resultText: string | null;
  outcome: AttemptOutcome | null;
  state: AttemptState | null;
  observedAt: number | null;
  archived: boolean;
  deleted: boolean;
  /** 由来：例如「经验《…》的直接依据」 */
  originLabel: string | null;
  openHref: string | null;
};

export type TopicAskExperience = {
  id: string;
  title: string;
  summary: string;
  needsRevision: boolean;
  hasPracticeResult: boolean;
  sourceCount: number;
  derivationBy: 'model' | 'user' | null;
  /** 属于 allowed scope、可直接用于 /api/ask/preview 的来源 */
  selectableSourceKeys: string[];
  sources: TopicAskSource[];
};

export type TopicAskExperiencesResponse = {
  topic: { id: string; name: string } | null;
  experiences: TopicAskExperience[];
};

export const TOPIC_MEMBER_TYPE_LABEL: Record<TopicMemberType, string> = {
  thought: '念头',
  experience: '经验',
};

export type TopicAttemptDisplayState = 'waiting' | 'recorded' | 'cancelled';

export const TOPIC_ATTEMPT_STATUS_LABEL: Record<TopicAttemptDisplayState, string> = {
  waiting: '等待记录结果',
  recorded: '已记录结果',
  cancelled: '已取消',
};

/** 三态标签：无结果绝不推断为失败。 */
export function topicAttemptDisplayState(attempt: {
  state: AttemptState;
  resultText?: string | null;
  outcome?: AttemptOutcome | null;
  observedAt?: number | null;
  resultRecorded?: boolean;
  resultState?: 'recorded' | 'pending_no_result' | 'cancelled';
}): TopicAttemptDisplayState {
  if (attempt.resultState === 'cancelled' || attempt.state === 'cancelled') return 'cancelled';
  if (attempt.resultState === 'recorded') return 'recorded';
  if (attempt.resultState === 'pending_no_result') return 'waiting';
  if (
    attempt.resultRecorded === true ||
    Boolean(attempt.resultText && attempt.resultText.trim())
  ) {
    return 'recorded';
  }
  return 'waiting';
}

export const TOPIC_ERROR_LABEL: Record<string, string> = {
  topic_not_found: '主题不存在或已删除',
  topic_archived: '主题已归档',
  invalid_topic_name: '主题名称需为 1–80 字',
  invalid_exploring_question: '探索问题最多 500 字',
  invalid_continue_note: '继续备注最多 500 字',
  revision_conflict: '主题刚被其他窗口修改，你的输入仍保留',
  revision_required: '缺少版本信息，请刷新后重试',
  operation_key_conflict: '操作冲突，请重试',
  member_not_found: '这条记录已不在主题中',
  member_not_in_topic: '这条尝试不属于主题成员',
  capture_not_found: '记录不存在或已删除',
  capture_archived: '记录已归档',
  attempt_not_available: '固定尝试已失效',
  next_attempt_invalid: '这个尝试不能固定为下次继续',
  duplicate_topic_member: '这条记录已在主题中',
  too_many_topics: '同时存在的主题过多',
  invalid_cursor: '分页位置已失效，请刷新',
};

export function topicErrorText(code?: string | null, fallback?: string | null): string {
  if (code && TOPIC_ERROR_LABEL[code]) return TOPIC_ERROR_LABEL[code];
  if (fallback) return fallback;
  return '操作失败，请稍后重试';
}

// ===== 主题 Markdown 导出（docs/topic-export-api-contract.md） =====

/** ZIP 中条目的实体类型：三个元数据文件 + 三类记录。 */
export type TopicExportEntityType =
  | 'index'
  | 'readme'
  | 'manifest'
  | 'thought'
  | 'experience'
  | 'attempt';

export type TopicExportTopic = {
  id: string;
  title: string;
  revision: number;
  archived: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** 预览文件清单与 manifest.json 的 files[] 共用形状。 */
export type TopicExportFileEntry = {
  path: string;
  entityType: TopicExportEntityType;
  entityId: string | null;
  title: string;
  archived: boolean;
  basis: boolean;
  revision: number | null;
};

/** 可追加的一跳直接依据；已删除来源仍会出现，但不可选。 */
export type TopicExportBasisCandidate = {
  sourceKey: string;
  entityType: 'thought' | 'attempt';
  entityId: string;
  title: string;
  summary: string;
  sourceExperienceId: string;
  sourceExperienceTitle: string;
  referencedBy: string[];
  deleted: boolean;
  selectable: boolean;
  reason: string;
};

export type TopicExportCounts = {
  thoughts: number;
  experiences: number;
  attempts: number;
  basisThoughts: number;
  basisExperiences: number;
  basisAttempts: number;
  files: number;
  manualLinks: number;
  attemptReferences: number;
  experienceSources: number;
  experienceAdoptions: number;
};

export type TopicExportArchivedCounts = {
  members: number;
  thoughts: number;
  experiences: number;
};

export type TopicExportOmittedRelations = {
  total: number;
  byType: {
    manualLink: number;
    attemptReference: number;
    experienceSource: number;
    experienceAdoption: number;
  };
};

export type TopicExportLimitKey = 'files' | 'attempts' | 'bytes';

export type TopicExportLimits = {
  maxFiles: number;
  maxAttempts: number;
  maxBytes: number;
  maxBasisKeys: number;
  exceeded: TopicExportLimitKey[];
};

export type TopicExportScope = {
  includeArchived: boolean;
  includeBasisKeys: string[];
  counts: TopicExportCounts;
  archived: TopicExportArchivedCounts;
  files: TopicExportFileEntry[];
  basisCandidates: TopicExportBasisCandidate[];
  omittedRelations: TopicExportOmittedRelations;
  estimatedBytes: number;
  limits: TopicExportLimits;
  warnings: string[];
};

export type TopicExportPreview = {
  topic: TopicExportTopic;
  scope: TopicExportScope;
  scopeHash: string;
  canExport: boolean;
};

export type TopicExportPreviewInput = {
  includeArchived?: boolean;
  includeBasisKeys?: string[];
};

export type TopicExportDownloadInput = {
  includeArchived: boolean;
  includeBasisKeys: string[];
  expectedScopeHash: string;
};

export type TopicExportDownloadResult = {
  blob: Blob;
  filename: string;
};

