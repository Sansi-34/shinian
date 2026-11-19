// 拾念 SHINIAN · 经验笔记的对外类型
// 经验是用户明确保存的「我目前这样理解」，与问答历史、原始尝试分开。
export const EXPERIENCE_TITLE_MAX = 120;
export const EXPERIENCE_UNDERSTANDING_MAX = 4000;
export const EXPERIENCE_CONDITIONS_MAX = 2000;
export const EXPERIENCE_LIMITATIONS_MAX = 2000;
export const EXPERIENCE_MAX_SOURCES = 8;

export type ExperienceOriginKind = 'ask' | 'attempt' | 'manual';
export type ExperienceModelBasis = 'observation' | 'inference';

export type ExperienceSourcePublic = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: string | null;
  state: string | null;
  observedAt: number | null;
  deleted: boolean;
  exists: boolean;
  changed: boolean;
  /** 来源本身的类型；experience 表示这条来源只是另一份整理，不是原始观察 */
  kind: 'attempt' | 'thought' | 'experience' | 'unknown';
  openHref: string | null;
  graphHref: string | null;
  canReference: boolean;
  addedAt: number;
};

export type ExperienceAttemptPublic = {
  id: string;
  title: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
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
    /** 正文来自模型整理时，明确说明「用户确认保存」不等于已证实 */
    confirmNote: string;
  };
  needsRevision: boolean;
  revisionReason: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archived: boolean;
  sources: ExperienceSourcePublic[];
  sourceCount: number;
  changedSourceCount: number;
  deletedSourceCount: number;
  /** 是否有带实际结果的依据；false 时界面明确显示「尚无实践结果支持」 */
  hasPracticeResult: boolean;
  attempts: ExperienceAttemptPublic[];
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

export type ExperienceSearchHit = ExperienceListItem & {
  matchReason: string;
  snippet: string;
};

export type ExperienceDraftSource = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: string | null;
  state: string | null;
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
