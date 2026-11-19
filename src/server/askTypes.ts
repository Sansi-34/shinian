// 拾念 SHINIAN · 「问我的记录」共享类型
// 契约：docs/ask-api-contract.md
import type { TopicScopeSummary } from './topicTypes';

export type AskCandidateType = 'attempt' | 'capture';
export type AskQueryStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type AskBasis = 'observation' | 'inference';
export type AskMatchKind = 'direct' | 'relation' | 'expanded';

export const ASK_MAX_QUESTION_CHARS = 500;
export const ASK_MAX_KEYWORDS_CHARS = 200;
export const ASK_MAX_SUGGESTION_TERMS = 5;
export const ASK_MAX_SUGGESTION_TERM_CHARS = 40;
export const ASK_MAX_SUGGESTION_TOTAL_CHARS = 120;
export const ASK_MAX_RECORDS = 8;
export const ASK_MAX_CHARS = 12000;
export const ASK_MAX_CANDIDATES = 50;
export const ASK_DEFAULT_CANDIDATES = 20;
export const ASK_MAX_RANGE_DAYS = 3660;

export type AskKeywordSuggestionsResponse = {
  question: string;
  keywords: string[];
  terms: string[];
  config: AskAiConfig;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  durationMs: number;
  generatedAt: number;
  /** 提供 topicId 时返回服务端当前主题范围摘要；模型本身不接收主题信息。 */
  topic?: TopicScopeSummary | null;
  replayed?: boolean;
};

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
  state: string | null;
  outcome: string | null;
  archived: boolean;
  matchReasons: string[];
  matchKind: AskMatchKind;
  /** 实际命中的原始或扩展检索词；用于界面解释，不表示可信度。 */
  matchedKeywords: string[];
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
  expandedKeywords: string[];
  range: AskRange;
  total: number;
  limit: number;
  candidates: AskCandidate[];
  ai: AskAiSummary;
  generatedAt: number;
};

export type AskRecord = {
  sourceKey: string;
  type: AskCandidateType;
  id: string;
  captureId: string;
  title: string;
  text: string;
  resultText: string | null;
  outcome: string | null;
  state: string | null;
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
  /** 提供 topicId 时的主题范围摘要；普通问答不出现。 */
  scope?: TopicScopeSummary | null;
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
  outcome: string | null;
  state: string | null;
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
  outcome: string | null;
  state: string | null;
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
