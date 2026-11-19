// 拾念 SHINIAN · 阶段回顾共享类型（服务端 / 前端契约见 docs/review-api-contract.md）

export type ReviewStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type ReviewPreset = '7d' | '30d' | 'custom';
export type ReviewRecordType = 'capture' | 'attempt' | 'reference';
export type ReviewOutcome = 'success' | 'failure' | 'undetermined';
export type ReviewAttemptState = 'todo' | 'in_progress' | 'done' | 'cancelled';

export type ReviewReason =
  | 'capture_created'
  | 'capture_modified'
  | 'attempt_started'
  | 'attempt_modified'
  | 'attempt_current_ended'
  | 'result_recorded'
  | 'result_time_unknown'
  | 'reference_created';

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
  endExclusive: true;
};

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
  outcome: ReviewOutcome | null;
  state: ReviewAttemptState | null;
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
  key: keyof ReviewStats;
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

export type ReviewPreviewResponse = {
  range: ReviewRange;
  stats: ReviewStats;
  config: ReviewAiConfig | null;
  ai: { configured: boolean; enabled: boolean };
  records: ReviewRecord[];
  coverage: ReviewPreviewCoverage;
  contextToken: string;
};

export type ReviewItem = {
  text: string;
  basis: 'observation' | 'inference';
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

export type ReviewSource = {
  key: string;
  type: ReviewRecordType;
  sourceId: string;
  captureId: string;
  attemptId: string | null;
  relatedAttemptId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: ReviewOutcome | null;
  state: ReviewAttemptState | null;
  observedAt: number | null;
  revision: number;
  captureRevision: number;
  relatedRevision: number | null;
  createdAt: number;
  updatedAt: number | null;
  deleted?: boolean;
};

export type ReviewSourcePublic = ReviewSource & {
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
  sources: ReviewSourcePublic[];
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

export const REVIEW_MAX_RECORDS = 80;
export const REVIEW_MAX_CHARS = 16000;
export const REVIEW_MAX_RANGE_RECORDS = 500;
export const REVIEW_MAX_RANGE_DAYS = 366;
export const REVIEW_MAX_SELECT_KEYS = 300;
