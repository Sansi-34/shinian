import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { desc } from 'drizzle-orm';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

// 服务端签发的会话：Cookie 只存随机 token，退出时撤销，过期后拒绝。
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
});

export const captures = sqliteTable('captures', {
  id: text('id').primaryKey(),
  rawText: text('raw_text').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archivedAt: integer('archived_at'),
  // thought = 普通念头；experience = 用户保存的经验笔记（正文为用户整理的理解）
  kind: text('kind').notNull().default('thought'),
});

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id').notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    state: text('state').notNull().default('todo'), // todo | in_progress | done | cancelled
    resultText: text('result_text'), // 用户填写的观察（选填）
    outcome: text('outcome'), // success | failure | undetermined
    sourceUrl: text('source_url'),
    observedAt: integer('observed_at'), // 结果发生/记录时间（ms），选填
    revision: integer('revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // 下一步行动：复用 attempts，origin 区分来源；既有 Attempt 默认 manual。
    origin: text('origin').notNull().default('manual'), // manual | ai_suggestion | review_next_action
    actionDescription: text('action_description'),
    estimatedMinutes: integer('estimated_minutes'),
    sourceReviewId: text('source_review_id'),
    sourceExperienceIndex: integer('source_experience_index'),
    // 不设外键：来源 Attempt 删除后保留不可读 ID，页面按来源状态显示「来源已删除」。
    sourceAttemptId: text('source_attempt_id'),
    sourceAttemptRevision: integer('source_attempt_revision'),
    // 研究一下：来自某次研究的小实验。研究删除后保留 ID，页面显示「来源研究已删除」。
    sourceResearchId: text('source_research_id'),
    sourceResearchExperimentIndex: integer('source_research_experiment_index'),
    researchSuggestedJson: text('research_suggested_json'),
    researchSourceIdsJson: text('research_source_ids_json'),
  },
  (table) => ({
    originCreatedIdx: index('attempts_origin_created_idx').on(table.origin, desc(table.createdAt)),
    sourceReviewIdx: index('attempts_source_review_idx').on(table.sourceReviewId),
    sourceResearchIdx: index('attempts_source_research_idx').on(table.sourceResearchId),
  })
);

export const attemptReferences = sqliteTable(
  'attempt_references',
  {
    id: text('id').primaryKey(),
    fromAttemptId: text('from_attempt_id').notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    toAttemptId: text('to_attempt_id').notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    note: text('note'), // 这次准备怎么用
    snapshotResultText: text('snapshot_result_text'), // 引用当时的来源结果文本
    snapshotRevision: integer('snapshot_revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    uniquePair: uniqueIndex('attempt_references_pair_unique').on(
      table.fromAttemptId,
      table.toAttemptId
    ),
  })
);

// 念头之间的手动关联：有方向（A 关联到 B），用稳定 ID 保存；编辑文字不影响。
// 反链与正链读取同一行，只是方向不同。删除任一端念头时级联删除。
export const captureLinks = sqliteTable(
  'capture_links',
  {
    id: text('id').primaryKey(),
    fromCaptureId: text('from_capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    toCaptureId: text('to_capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    note: text('note'),
    revision: integer('revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pairUnique: uniqueIndex('capture_links_pair_unique').on(
      table.fromCaptureId,
      table.toCaptureId
    ),
    fromIdx: index('capture_links_from_idx').on(table.fromCaptureId),
    toIdx: index('capture_links_to_idx').on(table.toCaptureId),
  })
);

// 操作回执：稳定操作 ID 去重（新增尝试、新增引用、新增关联）
export const mutationReceipts = sqliteTable('mutation_receipts', {
  operationKey: text('operation_key').primaryKey(),
  targetType: text('target_type').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

// AI 模型配置：单机单人部署，固定一条 id='default'
export const aiSettings = sqliteTable('ai_settings', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  modelId: text('model_id').notNull(),
  apiKeyCiphertext: text('api_key_ciphertext').notNull(),
  apiKeyFingerprint: text('api_key_fingerprint').notNull(),
  enabled: integer('enabled').notNull().default(1),
  allowLocal: integer('allow_local').notNull().default(0),
  configVersion: integer('config_version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  testStatus: text('test_status'),
  testedAt: integer('tested_at'),
  testModelId: text('test_model_id'),
  testBaseUrl: text('test_base_url'),
  testDurationMs: integer('test_duration_ms'),
  testErrorCode: text('test_error_code'),
  testErrorDetail: text('test_error_detail'),
  testFingerprint: text('test_fingerprint'),
});

// AI 生成记录：模型调用不在事务内执行，状态更新一律条件 UPDATE
export const aiGenerations = sqliteTable(
  'ai_generations',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    captureRevision: integer('capture_revision').notNull(),
    captureText: text('capture_text').notNull(),
    constraintText: text('constraint_text'),
    configId: text('config_id').notNull(),
    configVersion: integer('config_version').notNull(),
    configName: text('config_name').notNull(),
    baseUrl: text('base_url').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(), // pending | succeeded | failed | cancelled | interrupted
    kind: text('kind'), // executable | defer | clarify
    suggestionJson: text('suggestion_json'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
    adoptedAttemptId: text('adopted_attempt_id').references(() => attempts.id, {
      onDelete: 'set null',
    }),
    adoptedAt: integer('adopted_at'),
    dismissedAt: integer('dismissed_at'),
    operationId: text('operation_id').unique(),
    operationFingerprint: text('operation_fingerprint'),
    contextJson: text('context_json'),
    contextToken: text('context_token'),
    contextInvalidatedAt: integer('context_invalidated_at'),
    contextInvalidReason: text('context_invalid_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => ({
    captureCreatedIdx: index('ai_generations_capture_created_idx').on(
      table.captureId,
      desc(table.createdAt)
    ),
    statusIdx: index('ai_generations_status_idx').on(table.status),
  })
);

// 阶段回顾：一段时间的统计/记录快照 + 按需 AI 回顾。保存前是生成记录，saved_at 非空表示用户已保存。
export const stageReviews = sqliteTable(
  'stage_reviews',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(), // pending | succeeded | failed | cancelled | interrupted
    rangeFrom: integer('range_from').notNull(), // inclusive ms
    rangeTo: integer('range_to').notNull(), // exclusive ms
    timezone: text('timezone').notNull(),
    rangePreset: text('range_preset').notNull(), // 7d | 30d | custom
    statsJson: text('stats_json'),
    coverageJson: text('coverage_json'),
    contentJson: text('content_json'),
    sourcesJson: text('sources_json'),
    configId: text('config_id'),
    configVersion: integer('config_version'),
    configName: text('config_name'),
    modelId: text('model_id'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
    operationId: text('operation_id').unique(),
    operationFingerprint: text('operation_fingerprint'),
    contextToken: text('context_token'),
    savedAt: integer('saved_at'),
    contentInvalidatedAt: integer('content_invalidated_at'),
    contentInvalidReason: text('content_invalid_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => ({
    savedIdx: index('stage_reviews_saved_idx').on(desc(table.savedAt)),
    createdIdx: index('stage_reviews_created_idx').on(desc(table.createdAt)),
    statusIdx: index('stage_reviews_status_idx').on(table.status),
  })
);

// 问我的记录：只读问答任务。保存问题、实际发送记录快照、带来源回答；不写业务记录。
export const recordQueries = sqliteTable(
  'record_queries',
  {
    id: text('id').primaryKey(),
    question: text('question').notNull(),
    keywords: text('keywords').notNull().default(''),
    rangeFrom: integer('range_from'),
    rangeTo: integer('range_to'),
    status: text('status').notNull(), // pending | succeeded | failed | cancelled | interrupted
    answerJson: text('answer_json'),
    sourcesJson: text('sources_json'),
    configId: text('config_id'),
    configVersion: integer('config_version'),
    configName: text('config_name'),
    modelId: text('model_id'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    operationId: text('operation_id').unique(),
    operationFingerprint: text('operation_fingerprint'),
    contextToken: text('context_token'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => ({
    createdIdx: index('record_queries_created_idx').on(desc(table.createdAt)),
    statusIdx: index('record_queries_status_idx').on(table.status),
  })
);

// 日程安排：一次尝试可以有多段安排；取消保留历史，删除 Attempt/Capture 时物理删除。
export const scheduleBlocks = sqliteTable(
  'schedule_blocks',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    startsAt: integer('starts_at').notNull(), // UTC 毫秒
    endsAt: integer('ends_at').notNull(), // UTC 毫秒，必须 > starts_at
    timezone: text('timezone').notNull(), // 创建时采用的 IANA 时区
    note: text('note'),
    status: text('status').notNull().default('active'), // active | cancelled
    revision: integer('revision').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    cancelledAt: integer('cancelled_at'),
  },
  (table) => ({
    statusRangeIdx: index('schedule_blocks_status_range_idx').on(
      table.status,
      table.startsAt,
      table.endsAt
    ),
    attemptStartIdx: index('schedule_blocks_attempt_start_idx').on(
      table.attemptId,
      table.startsAt
    ),
    startsIdx: index('schedule_blocks_starts_idx').on(table.startsAt),
  })
);

export type Account = typeof accounts.$inferSelect;
export type Capture = typeof captures.$inferSelect;export type Attempt = typeof attempts.$inferSelect;
export type AttemptReference = typeof attemptReferences.$inferSelect;
export type CaptureLink = typeof captureLinks.$inferSelect;
export type MutationReceipt = typeof mutationReceipts.$inferSelect;
export type AiSettings = typeof aiSettings.$inferSelect;
export type AiGeneration = typeof aiGenerations.$inferSelect;
export type StageReview = typeof stageReviews.$inferSelect;
export type RecordQuery = typeof recordQueries.$inferSelect;
export type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;

// 研究一下：一次研究任务。资料存 research_sources，候选与结果快照存本行。
export const researchRuns = sqliteTable(
  'research_runs',
  {
    id: text('id').primaryKey(),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    captureRevision: integer('capture_revision').notNull(),
    captureText: text('capture_text').notNull(),
    question: text('question').notNull(),
    constraintsJson: text('constraints_json'),
    searchMode: text('search_mode').notNull(), // keyword | repositories
    searchQuery: text('search_query'),
    repoInputsJson: text('repo_inputs_json'),
    status: text('status').notNull(),
    limitsJson: text('limits_json').notNull(),
    candidatesJson: text('candidates_json'),
    selectedCandidateIdsJson: text('selected_candidate_ids_json'),
    sentSourceIdsJson: text('sent_source_ids_json'),
    resultJson: text('result_json'),
    configId: text('config_id'),
    configVersion: integer('config_version'),
    configName: text('config_name'),
    modelId: text('model_id'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
    statsJson: text('stats_json'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    failedJson: text('failed_json'),
    operationId: text('operation_id').unique(),
    operationFingerprint: text('operation_fingerprint'),
    contextToken: text('context_token'),
    revision: integer('revision').notNull().default(1),
    savedAt: integer('saved_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => ({
    captureIdx: index('research_runs_capture_idx').on(table.captureId, desc(table.createdAt)),
    statusIdx: index('research_runs_status_idx').on(table.status),
    savedIdx: index('research_runs_saved_idx').on(desc(table.savedAt)),
  })
);

// 每份实际获取的资料：来源 URL、获取时间、仓库、路径、分支/文件 sha、提供给模型的摘录。
export const researchSources = sqliteTable(
  'research_sources',
  {
    id: text('id').primaryKey(),
    researchId: text('research_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    kind: text('kind').notNull(), // repo_meta | readme | license | releases
    url: text('url').notNull(),
    filePath: text('file_path'),
    refName: text('ref_name'),
    commitSha: text('commit_sha'),
    excerpt: text('excerpt').notNull().default(''),
    fetchedAt: integer('fetched_at').notNull(),
    status: text('status').notNull(), // ok | missing | failed
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
  },
  (table) => ({
    runKeyUnique: uniqueIndex('research_sources_run_key_unique').on(
      table.researchId,
      table.sourceKey
    ),
    runIdx: index('research_sources_run_idx').on(table.researchId, table.repoFullName),
  })
);

// GitHub Token：可选；只在读取公开仓库时使用，AES-256-GCM 加密保存。
export const githubSettings = sqliteTable('github_settings', {
  id: text('id').primaryKey(),
  tokenCiphertext: text('token_ciphertext').notNull(),
  tokenFingerprint: text('token_fingerprint').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type ResearchRun = typeof researchRuns.$inferSelect;
export type ResearchSourceRow = typeof researchSources.$inferSelect;
export type GithubSettings = typeof githubSettings.$inferSelect;

// 预留：来源链接登记（本轮仅存储于 attempt.source_url，不启用独立表）
export const sourceLinks = sqliteTable('source_links', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  label: text('label'),
  createdAt: integer('created_at').notNull(),
});

// 经验笔记：正文（我的理解）存在 captures.raw_text，本表保存标题、条件、限制与整理出处。
// 用 captures 作为实体是为了复用稳定的 capture_id、手动关联、图谱节点、归档与删除预览。
export const experienceNotes = sqliteTable('experience_notes', {
  captureId: text('capture_id')
    .primaryKey()
    .references(() => captures.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  // model_draft = 由模型整理且用户尚未改过正文；user_edited = 用户改过正文
  understandingOrigin: text('understanding_origin').notNull().default('model_draft'),
  // observation | inference（仅模型整理时有值，用于保留「由模型推断整理」出处）
  modelBasis: text('model_basis'),
  originKind: text('origin_kind').notNull().default('manual'), // ask | attempt | manual
  originQueryId: text('origin_query_id'),
  originPointIndex: integer('origin_point_index'),
  originAttemptId: text('origin_attempt_id'),
  contextCaptureId: text('context_capture_id'),
  conditionsText: text('conditions_text'),
  limitationsText: text('limitations_text'),
  needsRevision: integer('needs_revision').notNull().default(0),
  revisionReason: text('revision_reason'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 经验的依据记录：保存采用时的标题/结果/版本快照。来源删除后清空正文，只保留不可读 ID。
export const experienceSources = sqliteTable(
  'experience_sources',
  {
    id: text('id').primaryKey(),
    experienceId: text('experience_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    sourceType: text('source_type').notNull(), // attempt | capture
    sourceId: text('source_id').notNull(),
    sourceCaptureId: text('source_capture_id'),
    sourceTitle: text('source_title').notNull(),
    sourceText: text('source_text').notNull().default(''),
    sourceResultText: text('source_result_text'),
    outcome: text('outcome'),
    state: text('state'),
    observedAt: integer('observed_at'),
    sourceRevision: integer('source_revision').notNull(),
    sourceCaptureRevision: integer('source_capture_revision'),
    sourceKind: text('source_kind'),
    deleted: integer('deleted').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    uniqueKey: uniqueIndex('experience_sources_unique').on(table.experienceId, table.sourceKey),
    keyIdx: index('experience_sources_key_idx').on(table.sourceKey),
  })
);

// 参考经验创建的尝试：保存采用时版本与正文快照；经验删除后保留 ID 与版本，清空正文。
export const experienceAttempts = sqliteTable(
  'experience_attempts',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    experienceCaptureId: text('experience_capture_id').notNull(),
    adoptedVersion: integer('adopted_version').notNull(),
    adoptedTitle: text('adopted_title').notNull(),
    adoptedUnderstanding: text('adopted_understanding').notNull(),
    basisSourceKeysJson: text('basis_source_keys_json'),
    deleted: integer('deleted').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    experienceIdx: index('experience_attempts_experience_idx').on(table.experienceCaptureId),
  })
);

export type ExperienceNote = typeof experienceNotes.$inferSelect;
export type ExperienceSourceRow = typeof experienceSources.$inferSelect;
export type ExperienceAttemptRow = typeof experienceAttempts.$inferSelect;

// 主题：一组稳定 capture ID 的集合，不复制正文；next_attempt_id 只指向主题 thought 成员下的尝试。
export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    exploringQuestion: text('exploring_question'),
    continueNote: text('continue_note'),
    nextAttemptId: text('next_attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
    // 固定尝试被删除/取消/移出成员后保留一次简短原因，详情页据此提示；设置新固定项时清空。
    nextAttemptClearedReason: text('next_attempt_cleared_reason'),
    revision: integer('revision').notNull().default(1),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    archivedUpdatedIdx: index('topics_archived_updated_idx').on(
      table.archivedAt,
      desc(table.updatedAt)
    ),
    updatedIdx: index('topics_updated_idx').on(desc(table.updatedAt)),
  })
);

// 主题成员：只存稳定 ID 与加入时类型；同主题同记录唯一，同一条经验可加入多个主题。
export const topicMembers = sqliteTable(
  'topic_members',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    captureId: text('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    memberKind: text('member_kind').notNull(), // thought | experience
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    topicCaptureUnique: uniqueIndex('topic_members_topic_capture_unique').on(
      table.topicId,
      table.captureId
    ),
    topicCreatedIdx: index('topic_members_topic_created_idx').on(
      table.topicId,
      table.createdAt
    ),
    captureIdx: index('topic_members_capture_idx').on(table.captureId),
  })
);

export type Topic = typeof topics.$inferSelect;
export type TopicMemberRow = typeof topicMembers.$inferSelect;

export const ALL_TABLES = [
  accounts,
  captures,
  attempts,
  attemptReferences,
  captureLinks,
  mutationReceipts,
  aiSettings,
  aiGenerations,
  stageReviews,
  scheduleBlocks,
  experienceNotes,
  experienceSources,
  experienceAttempts,
  topics,
  topicMembers,
];