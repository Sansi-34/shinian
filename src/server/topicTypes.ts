// 拾念 SHINIAN · 「主题」共享类型
// 契约：docs/topic-api-contract.md
// 原则：成员只存稳定 ID，不复制正文；主题说明不进入模型 prompt。
import type { ExperienceSourcePublic } from './experienceTypes';

export const TOPIC_TITLE_MAX = 120;
export const TOPIC_TEXT_MAX = 1000;
export const TOPIC_MAX_CAPTURES = 50;
export const TOPIC_LIST_DEFAULT_LIMIT = 20;
export const TOPIC_LIST_MAX_LIMIT = 50;
export const TOPIC_CANDIDATE_DEFAULT_LIMIT = 20;
export const TOPIC_CANDIDATE_MAX_LIMIT = 30;
export const TOPIC_ATTEMPT_DEFAULT_LIMIT = 20;
export const TOPIC_ATTEMPT_MAX_LIMIT = 50;
export const TOPIC_OPERATION_ID_MAX = 200;

export type TopicMemberKind = 'thought' | 'experience';
export type TopicArchivedFilter = '0' | '1' | 'all';
export type TopicAttemptStateFilter = 'all' | 'recorded' | 'pending' | 'cancelled';
export type TopicResultState = 'recorded' | 'pending_no_result' | 'cancelled';
export type TopicNextAttemptClearedReason =
  | 'attempt_deleted'
  | 'attempt_cancelled'
  | 'member_removed'
  | null;

export type TopicNextAttempt = {
  id: string;
  /** 与 id 相同；供按语义取用的前端适配层使用。 */
  attemptId: string;
  captureId: string;
  captureTitle: string;
  /** 与 captureTitle 相同（兼容字段）。 */
  captureText: string;
  step: string;
  href: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
  observedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  isCompleted: boolean;
  /** 与 isCompleted 相同：是否有实际结果记录（state='done'）。 */
  resultRecorded: boolean;
  captureArchived: boolean;
  captureArchivedAt: number | null;
};

export type TopicSummary = {
  id: string;
  title: string;
  /** 兼容前端既有 `name` 字段；与 title 相同。 */
  name: string;
  exploringQuestion: string | null;
  continueNote: string | null;
  archived: boolean;
  archivedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
  thoughtCount: number;
  experienceCount: number;
  /** 普通念头成员下真实 attempts 数量（兼容字段）。 */
  attemptCount: number;
  latestAttemptAt: number | null;
  /** 与 latestAttemptAt 相同（兼容字段）。 */
  lastAttemptAt: number | null;
  nextAttemptId: string | null;
  nextAttempt: TopicNextAttempt | null;
  nextAttemptClearedReason: TopicNextAttemptClearedReason;
};

export type TopicMember = {
  id: string;
  captureId: string;
  kind: TopicMemberKind;
  /** 与 kind 相同（兼容字段）。 */
  type: TopicMemberKind;
  title: string;
  summary: string;
  rawText: string;
  revision: number;
  archived: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** 成员加入时间；与 addedAt 相同。 */
  addedAt: number;
  href: string;
  /** 与 href 相同（兼容字段）。 */
  openHref: string;
  /** 仅 experience 成员：有效依据数。 */
  sourceCount?: number;
  derivationBy?: 'model' | 'user';
  needsRevision?: boolean;
  hasPracticeResult?: boolean;
  /** 仅 experience 成员：经验自身 capture ID（与 captureId 相同）。 */
  experienceId?: string;
};

export type TopicMembers = {
  thoughts: TopicMember[];
  experiences: TopicMember[];
};

export type TopicDetail = {
  topic: TopicSummary;
  members: TopicMembers;
  /** 扁平成员数组（兼容前端既有适配层）。 */
  memberList: TopicMember[];
  clearedReason: TopicNextAttemptClearedReason;
};

export type TopicListItem = TopicSummary;

export type TopicMemberCandidate = {
  captureId: string;
  kind: TopicMemberKind;
  type: TopicMemberKind;
  title: string;
  summary: string;
  archived: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  alreadyMember: false;
  openHref: string;
  sourceCount?: number;
  hasPracticeResult?: boolean;
  needsRevision?: boolean;
};

export type TopicAttemptItem = {
  id: string;
  captureId: string;
  captureTitle: string;
  captureText: string;
  captureArchived: boolean;
  captureArchivedAt: number | null;
  step: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
  observedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  href: string;
  resultState: TopicResultState;
};

export type TopicScopeSummary = {
  topicId: string;
  /** 主题标题；与 topicName 相同。 */
  topicTitle: string;
  topicName: string;
  scopeHash: string;
  topicRevision: number;
  thoughtCount: number;
  experienceCount: number;
  /** 普通念头成员下直接 attempts 数量。 */
  attemptCount: number;
  /** allowed sourceKey 去重数量；与 recordCount 相同。 */
  allowedSourceCount: number;
  recordCount: number;
};

export type TopicAskExperienceSource = ExperienceSourcePublic;

export type TopicAskExperience = {
  id: string;
  title: string;
  summary: string;
  needsRevision: boolean;
  hasPracticeResult: boolean;
  sourceCount: number;
  derivationBy: 'model' | 'user';
  sources: TopicAskExperienceSource[];
  selectableSourceKeys: string[];
};

export type TopicScope = TopicScopeSummary & {
  thoughtCaptureIds: string[];
  thoughtAttemptIds: string[];
  experienceIds: string[];
  experienceSourceKeys: string[];
  allowedSourceKeys: string[];
};
