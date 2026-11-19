# 拾念 SHINIAN · 「阶段回顾」接口契约

日期：2026-11-13。本轮新增 `回顾` 页面与服务端阶段回顾接口：把一段时间内**实际记录**的念头、尝试、结果、引用汇总为可浏览的记录列表，并在用户确认发送内容后按需生成带真实来源的 AI 回顾。复用现有 AI 配置、OpenAI 兼容 adapter、异步生成/取消/轮询、来源版本校验、删除清洗和导出/备份体系。

实现如偏离本契约，必须在 `docs/review-notes.md` 记录并说明。

## 0. 范围与原则

- 本机单人；不新增账号、权限、多模型中心。
- 统计由程序计算，界面必须解释口径；不得把编辑旧记录推算为新完成一次尝试。
- 历史状态不可重建时使用准确描述：`attempts` 表只保存**当前**状态和最后修改时间，没有状态变化历史。
- 日期范围由前端按用户时区算出明确的时间边界（毫秒时间戳）后提交；服务端按 `from` 含、`to` 不含解释，不自行猜测时区。
- AI 只接收用户确认后的记录；每条涉及个人事实的回顾条目必须引用本次发送记录中的真实 ID。
- 模型不可用时，实际记录与统计仍完整可用。
- 删除来源时沿用现有 AI 生成策略：清除来源正文快照，保留模型回顾正文，标记「来源已删除/内容已失效」。

## 1. 数据模型

### 1.1 迁移 `0005_review.sql`

新增 `stage_reviews`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | `rev-...` |
| `status` | text not null | `pending` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `range_from` | integer not null | 起始毫秒，包含 |
| `range_to` | integer not null | 结束毫秒，不包含 |
| `timezone` | text not null | IANA 时区，例如 `Asia/Shanghai` |
| `range_preset` | text not null | `7d` / `30d` / `custom` |
| `stats_json` | text | 统计快照（程序计算） |
| `coverage_json` | text | 本次发送覆盖范围快照 |
| `content_json` | text | 校验后的模型回顾 JSON |
| `sources_json` | text | 发送记录的快照数组（含正文、版本、链接） |
| `config_id` / `config_version` / `config_name` / `model_id` | | 生成时的模型配置快照 |
| `error_code` / `error_detail` | text | 失败分类与脱敏说明 |
| `usage_json` / `duration_ms` | | 用量与耗时 |
| `operation_id` | text unique | 创建幂等键 |
| `operation_fingerprint` | text | 幂等指纹 |
| `context_token` | text | 预览/生成上下文指纹 |
| `saved_at` | integer | 非空表示用户已保存 |
| `content_invalidated_at` / `content_invalid_reason` | | 来源删除后的清洗标记 |
| `created_at` / `updated_at` / `finished_at` | integer not null / nullable | |

索引：`saved_at DESC`、`created_at DESC`、`status`。

### 1.2 记录键与来源

发送给模型的每条记录使用稳定键：

- 念头：`capture:<captureId>`
- 尝试：`attempt:<attemptId>`（结果也属于该尝试，不另造 ID）
- 引用：`reference:<referenceId>`

键只允许 `[A-Za-z0-9._:-]`，模型 `sourceIds` 必须使用这些完整键。回顾保存时 `sources_json` 至少包含：`key`、`type`、`sourceId`、`captureId`、`attemptId`、`relatedAttemptId`、`title`、`text`、`resultText`、`outcome`、`state`、`observedAt`、`revision`、`captureRevision`、`relatedRevision`、`createdAt`、`updatedAt`。

### 1.3 状态恢复

服务启动时所有 `stage_reviews.status='pending'` → `interrupted`，`error_code='interrupted'`，`error_detail='服务重启，本次回顾已中断，可重新生成。'`，写 `finished_at/updated_at`。

## 2. 时间范围与统计口径

### 2.1 范围参数

所有范围接口接收：

```json
{ "from": 1762444800000, "to": 1763049600000, "timezone": "Asia/Shanghai", "preset": "7d" }
```

- `from`、`to` 为 Unix 毫秒；`from` 包含、`to` 不包含。
- `from > 0`、`to > from`、跨度 ≤ 366 天，否则 400 `invalid_range`。
- `timezone` 必须是 `Intl.DateTimeFormat` 可识别的 IANA 名称（≤80 字符），否则 400 `invalid_timezone`。
- `preset` 仅 `7d` / `30d` / `custom`，缺省 `custom`；其他 400 `invalid_preset`。
- 前端「最近 7 天」= 本地今天往前 6 天的 00:00 到明天 00:00；「最近 30 天」同理；自定义 = 起始日 00:00 到结束日次日 00:00。
- 响应 `range` 必须带明确边界：

```json
{
  "from": 1762444800000,
  "to": 1763049600000,
  "fromIso": "2026-11-07T00:00:00.000Z",
  "toIso": "2026-11-14T00:00:00.000Z",
  "fromLocal": "2026-11-07 08:00",
  "toLocal": "2026-11-14 08:00",
  "timezone": "Asia/Shanghai",
  "preset": "7d",
  "days": 7,
  "endExclusive": true
}
```

`fromLocal/toLocal` 用用户时区格式化，供界面显示；`fromIso/toIso` 是精确的 UTC 边界。

### 2.2 统计字段

服务端计算并返回：

| 字段 | 口径（必须原样解释给用户） |
| --- | --- |
| `capturesCreated` | `captures.created_at` 落在范围内（含已归档） |
| `capturesModified` | `created_at < from` 且 `updated_at` 落在范围内的念头；仅表示修改，不算新记录 |
| `attemptsStarted` | `attempts.created_at` 落在范围内；只表示开始，不代表已结束 |
| `attemptsModified` | `created_at < from` 且 `updated_at` 落在范围内的尝试；不计入新开始 |
| `attemptsCurrentlyEnded` | 当前状态为 `done`/`cancelled` 且 `updated_at` 落在范围内；只表示“当前状态 + 最后修改时间”，不表示实际结束时间 |
| `resultsRecorded` | `observed_at` 落在范围内且（`result_text` 非空或 `outcome` 非空）的尝试；编辑旧结果不改变该时间 |
| `resultsMissingObservedAt` | 有结果但 `observed_at` 为空、且 `created_at` 或 `updated_at` 落在范围内的尝试；不计入结果数 |
| `referencesCreated` | `attempt_references.created_at` 落在范围内 |
| `totalRecords` | 范围内唯一记录键数量 |

每个统计数字随响应返回 `statDefinitions`：

```json
[
  { "key": "capturesCreated", "label": "记录的念头", "value": 3,
    "definition": "创建时间落在范围内（含已归档）" },
  { "key": "attemptsStarted", "label": "开始尝试", "value": 2,
    "definition": "创建时间落在范围内；只表示开始，不代表已结束" }
]
```

所有定义必须能由现有字段验证；不得写“完成了几次尝试”“结束了几次尝试”这类历史推断。

### 2.3 记录结构

```ts
type ReviewReason =
  | 'capture_created'
  | 'capture_modified'
  | 'attempt_started'
  | 'attempt_modified'
  | 'attempt_current_ended'
  | 'result_recorded'
  | 'result_time_unknown'
  | 'reference_created';

type ReviewRecord = {
  key: string;                 // capture:… / attempt:… / reference:…
  type: 'capture' | 'attempt' | 'reference';
  sourceId: string;
  captureId: string;
  attemptId: string | null;    // 引用记录为 fromAttemptId
  relatedAttemptId: string | null; // 引用记录为 toAttemptId
  title: string;
  text: string;
  resultText: string | null;
  outcome: 'success' | 'failure' | 'undetermined' | null;
  state: 'todo' | 'in_progress' | 'done' | 'cancelled' | null;
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
```

`sections` 是记录键数组：

- `captures`：范围内创建的念头（`capture_created`）。
- `attempts`：范围内开始的尝试（`attempt_started`），以及当前已结束/已放弃且最后修改在范围内的尝试（`attempt_current_ended`）。
- `results`：`result_recorded` 或 `result_time_unknown` 的尝试。
- `references`：范围内新建的引用（`reference_created`）。
- `modifications`：创建于范围之前、最后修改在范围内的念头/尝试（`capture_modified` / `attempt_modified`）。

同一条尝试可同时出现在 `attempts` 与 `results`；`records` 只返回唯一记录并按最近相关时间倒序。

## 3. HTTP API

所有接口均要求 `shinian_sid` 会话，未登录 401。错误统一 `{error, message?, ...}`。

### 3.1 `GET /api/review/range?from=&to=&timezone=&preset=`

返回范围、统计、记录与 AI 配置摘要；不调用模型。

```json
{
  "range": { "...": "见 2.1" },
  "stats": { "...": "见 2.2" },
  "statDefinitions": [ { "key": "...", "label": "...", "value": 0, "definition": "..." } ],
  "records": [ { "...": "ReviewRecord" } ],
  "sections": {
    "captures": ["capture:cap-..."],
    "attempts": ["attempt:att-..."],
    "results": ["attempt:att-..."],
    "references": ["reference:ref-..."],
    "modifications": []
  },
  "coverage": {
    "totalRecords": 4,
    "uniqueKeys": 4,
    "truncated": false,
    "maxRangeRecords": 500
  },
  "limits": { "maxRecords": 80, "maxChars": 16000, "maxRangeDays": 366 },
  "ai": {
    "configured": true,
    "enabled": true,
    "config": { "id": "default", "name": "本机模型", "modelId": "fake-review", "configVersion": 3 }
  },
  "generatedAt": 1763049600000
}
```

- 范围内唯一记录超过 500 条：只返回最近 500 条，`coverage.truncated=true`，界面提示缩小范围。
- 未配置模型时 `ai.configured=false, ai.config=null`，其余字段照常返回。

### 3.2 `POST /api/review/preview`

请求：

```json
{
  "from": 1762444800000,
  "to": 1763049600000,
  "timezone": "Asia/Shanghai",
  "preset": "7d",
  "includeKeys": ["capture:cap-...", "attempt:att-..."]
}
```

- `includeKeys` 必须为 1–300 个字符串、去重；否则 400 `invalid_keys`。
- 任一 key 不属于该范围当前记录 → 409 `records_changed`，附 `missingKeys`。
- 不要求 AI 已配置；未配置时仍返回 `config:null` 与记录，供用户查看将发送内容。
- 返回：

```json
{
  "range": { "...": "见 2.1" },
  "stats": { "...": "见 2.2" },
  "config": { "id": "default", "name": "本机模型", "modelId": "fake-review", "configVersion": 3 },
  "ai": { "configured": true, "enabled": true },
  "records": [ { "...": "本次选中的 ReviewRecord" } ],
  "coverage": {
    "totalRecords": 6,
    "selectedRecords": 5,
    "excludedRecords": 1,
    "selectedChars": 1830,
    "maxRecords": 80,
    "maxChars": 16000,
    "withinLimit": true,
    "truncated": false,
    "sectionCounts": { "captures": 2, "attempts": 3, "results": 2, "references": 1, "modifications": 1 }
  },
  "contextToken": "hex-sha256"
}
```

`selectedChars` 按实际将发送的 user prompt 字符数计算。`withinLimit=false` 时仍返回预览，但界面必须提示并禁用生成。

`contextToken = SHA-256(JSON({from,to,timezone,preset,configVersion,items:[{key,revision,updatedAt}] sorted by key}))`。`configVersion` 未配置时用 `null`。

### 3.3 `POST /api/reviews`

请求：

```json
{
  "from": 1762444800000,
  "to": 1763049600000,
  "timezone": "Asia/Shanghai",
  "preset": "7d",
  "includeKeys": ["capture:cap-...", "attempt:att-..."],
  "contextToken": "hex-sha256",
  "operationId": "uuid"
}
```

- 未配置/停用：409 `ai_not_configured` / `ai_disabled`。
- 无记录：409 `no_records`。
- 超过 80 条或 16000 字：409 `review_too_large`，附 `recordCount/maxRecords/charCount/maxChars`。
- 预览后记录或配置变化：409 `context_changed`，附 `message: '预览后记录或配置有变化，请刷新内容并重新确认。'`。
- 同一 `operationId` 同指纹返回已有记录 `{review, replayed:true}`（HTTP 200）；不同指纹 409 `operation_key_conflict`。
- 全局 pending 回顾 ≥ 2 → 429 `too_many_reviews`。
- 成功立即返回 202：`{ review: ReviewPublic, replayed:false }`，模型调用在后台。
- 生成记录保存 `stats_json`、`coverage_json`、`sources_json`、`context_token`、配置快照。

### 3.4 `GET /api/reviews/:id`

返回 `{ review: ReviewPublic }`，用于轮询与刷新恢复。不存在 404 `review_not_found`。

```json
{
  "review": {
    "id": "rev-...",
    "status": "pending",
    "range": { "...": "见 2.1" },
    "config": { "name": "本机模型", "modelId": "fake-review", "configVersion": 3 },
    "stats": { "...": "生成时的统计快照" },
    "coverage": { "...": "本次发送覆盖范围" },
    "content": null,
    "sources": [],
    "savedAt": null,
    "createdAt": 1763049600000,
    "updatedAt": 1763049600000,
    "finishedAt": null,
    "errorCode": null,
    "errorMessage": null,
    "usage": null,
    "durationMs": null,
    "contentInvalidated": false,
    "contentInvalidReason": null,
    "sourcesChanged": false,
    "canSave": false
  }
}
```

`status='succeeded'` 时 `content` 为：

```json
{
  "overview": "这段时间你记录了一次调光尝试……",
  "attempts": [
    { "text": "你实际比较了 500 Hz 与 2 kHz。", "basis": "observation", "sourceIds": ["attempt:att-..."] }
  ],
  "observations": [ { "text": "你记录到 500 Hz 仍有可见闪烁。", "basis": "observation", "sourceIds": ["attempt:att-..."] } ],
  "connections": [ { "text": "这条结果可能支持“频率影响闪烁”的推断。", "basis": "inference", "sourceIds": ["attempt:att-..."] } ],
  "experiences": [ { "text": "下次可先固定其他条件，只改变频率。", "basis": "inference", "sourceIds": ["attempt:att-..."] } ],
  "uncertainties": ["只有一次记录，不能说明长期效果。"],
  "insufficientData": false,
  "dataNotes": null
}
```

`sources` 为来源快照 + 当前状态：

```json
{
  "key": "attempt:att-...",
  "type": "attempt",
  "sourceId": "att-...",
  "captureId": "cap-...",
  "attemptId": "att-...",
  "relatedAttemptId": null,
  "title": "比较两种 PWM 频率",
  "text": "比较两种 PWM 频率",
  "resultText": "500 Hz 时仍有可见闪烁",
  "outcome": "failure",
  "state": "done",
  "observedAt": 1763000000000,
  "revision": 2,
  "captureRevision": 1,
  "relatedRevision": null,
  "createdAt": 1763000000000,
  "updatedAt": 1763000000000,
  "exists": true,
  "changed": false,
  "deleted": false,
  "currentRevision": 2,
  "currentCaptureRevision": 1,
  "currentRelatedRevision": null,
  "openCaptureId": "cap-...",
  "openAttemptId": "att-..."
}
```

- 来源不存在：返回 `{key,type,sourceId,deleted:true,exists:false,...正文为null}`，**不得回显已删除正文**。
- `changed=true`：来源当前 revision 与快照不同，或所属念头 revision 不同，或引用的任一端尝试 revision 不同。
- `sourcesChanged`：任一来源 `changed` 或 `deleted`。
- `contentInvalidated`：`content_invalidated_at` 非空或存在已删除来源。
- `canSave`：`status==='succeeded' && content!=null && savedAt==null`。

### 3.5 `GET /api/reviews?limit=1..50`

只列已保存回顾，按 `saved_at DESC`：

```json
{
  "total": 2,
  "reviews": [
    {
      "id": "rev-...",
      "range": { "...": "见 2.1" },
      "savedAt": 1763049600000,
      "createdAt": 1763049000000,
      "overview": "……",
      "stats": { "...": "保存时统计快照" },
      "contentInvalidated": false,
      "sourceCount": 4,
      "changedSourceCount": 0
    }
  ]
}
```

### 3.6 `POST /api/reviews/:id/save`

请求 `{operationId?: string}`。

- 仅 `succeeded` 且 content 非空可保存；否则 409 `not_savable`。
- 已保存：直接返回 `{review, replayed:true}`，不重复写。
- 首次保存写 `saved_at`，同事务写 `mutation_receipts`（`target_type='review_save'`）。
- 返回 `{review, replayed:false}`。

### 3.7 `POST /api/reviews/:id/cancel`

仅 `pending` 可取消：立即置 `cancelled`、`error_code='cancelled'`、`error_detail='已取消本次回顾。'`，abort 后台请求；迟到响应不得改回成功。非 pending → 409 `not_cancellable`。返回 `{review}`。

## 4. 模型输出 Schema 与校验

System prompt 必须包含以下要点（实现可微调措辞，但语义必须保留）：

- 只输出一个 JSON 对象，不要 Markdown/代码围栏。
- 字段：`overview`、`attempts`、`observations`、`connections`、`experiences`、`uncertainties`、`insufficientData`、`dataNotes`。
- 每个 item：`{ text: string, basis: 'observation'|'inference', sourceIds: string[] }`。
- `sourceIds` 只能使用记录列表方括号中的真实 ID，每条 item 至少 1 条，不得编造。
- 区分实际观察与模型推断。
- 不把修改旧记录当作新尝试/新完成；不推算不存在的历史状态。
- 「用户完成一次练习，只能说明完成了该练习」，不得推断能力、水平或长期效果。
- 数据不足时 `insufficientData=true` 并在 `uncertainties`/`dataNotes` 明确说明。
- 不做心理诊断，不写鼓励套话，简短具体。

Zod 结构：

```ts
const reviewItem = z.object({
  text: z.string().trim().min(1).max(500),
  basis: z.enum(['observation', 'inference']),
  sourceIds: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
});
const reviewSchema = z.object({
  overview: z.string().trim().min(1).max(800),
  attempts: z.array(reviewItem).max(8),
  observations: z.array(reviewItem).max(10),
  connections: z.array(reviewItem).max(8),
  experiences: z.array(reviewItem).max(8),
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(8),
  insufficientData: z.boolean(),
  dataNotes: z.string().trim().max(500).nullable(),
});
```

语义校验：

- 每个 `sourceId` 必须属于本次发送记录、item 内不得重复；否则 `failed / invalid_response`，可重试。
- 所有四个 section 都为空且 `insufficientData=false` → `invalid_response`。
- `insufficientData=true` 时允许 sections 为空，但 `overview` 必须说明数据不足。
- 允许 ```json 围栏；解析失败/字段失败/未知来源均为 `invalid_response`，不写入 content。

## 5. 输入规模与提示词

- 最多发送 80 条唯一记录，user prompt 最多 16000 字符。
- 超限时接口返回 409，不截断、不静默丢弃；界面必须让用户缩小范围或取消勾选。
- 记录按事件时间升序；每条格式稳定：

```text
[capture:cap-...] 念头｜创建于 2026-11-08 10:00
正文：……
[attempt:att-...] 尝试｜开始于 2026-11-08 11:00｜当前状态：已结束｜结果记录于 2026-11-08 12:00｜评价：失败
步骤：……
结果：……
所属念头：……
[reference:ref-...] 引用｜创建于 2026-11-08 13:00
从「……」（att-A）引用「……」（att-B）
说明：……
```

User prompt 开头写明确范围与程序统计。提示词不得包含未勾选的记录。`selectedChars` 与实际 prompt 字符数一致。

## 6. 删除与清洗

新增 helper：

```ts
invalidateStageReviewSourcesForDeletedAttempts(attemptIds: string[]): number
invalidateStageReviewSourcesForDeletedCapture(captureId: string): number
```

- 删除尝试前调用：清洗 `sources_json` 中 `type='attempt' && sourceId∈ids`，以及 `type='reference' && (attemptId∈ids || relatedAttemptId∈ids)` 的来源；只保留 `{key,type,sourceId,deleted:true}`。
- 删除念头前先取该念头所有尝试 ID 调上面的 helper，再清洗 `type='capture' && sourceId=captureId`。
- 任一清洗发生：`content_invalidated_at=now`、`content_invalid_reason='来源记录已删除'`、`updated_at=now`。
- 保留模型回顾正文（与现有 AI 建议策略一致），但界面必须提示来源已删除，且不得从接口读出已删除来源正文。
- `GET /api/reviews/:id` 的 `sources` 对已删除来源只返回 `deleted:true`。

## 7. 导出与备份

- `GET /api/export` 当前为 `schemaVersion: 3`，`data` 包含 `stageReviews`（只导出已保存回顾），字段为结构化 JSON：`id, status, rangeFrom, rangeTo, timezone, preset, stats, coverage, content, sources, configName, modelId, savedAt, createdAt`。v3 同时保留 `scheduleBlocks`，并在 `attempts` 中增加下一步行动来源字段。
- 既有 `captures/attempts/attemptReferences` 字段保持不变；旧版 `schemaVersion: 1` 文件仍可被识别（无 `stageReviews`/`scheduleBlocks` 时视为空数组，attempt 新字段按 manual/null 读取）。
- 备份/恢复继续备份整个 SQLite 文件；迁移 `0005` 对旧库自动建表。旧备份（无 `stage_reviews`）恢复后启动仍可用，新表由迁移创建。
- 测试需覆盖：保存回顾 → 导出包含完整内容与来源 → 备份 → 恢复到新库 → 登录读取到同一条回顾与来源；旧库（0000–0004）启动后保留原数据并自动升级。

## 8. 前端

### 8.1 入口与页面

- 顶部导航增加「回顾」→ `/review`；保存详情 `/review/:id`。
- 页面标题「阶段回顾」。范围切换：最近 7 天 / 最近 30 天 / 自定义日期范围。
- 默认直接展示实际记录，不要求先生成 AI 回顾。
- 统计卡：记录的念头 / 开始尝试 / 写下结果 / 新建引用；下方「统计口径」可展开，逐条显示服务端 `statDefinitions`。
- 记录筛选：全部 / 念头 / 尝试 / 结果 / 引用 / 修改；显示数量；记录卡可打开原念头或尝试。
- 时间标签必须区分「创建于」「结果记录于」「最后修改于」；对当前已结束的尝试使用「当前状态：已结束（结束时间未保存）」类文案，不能写「期间结束」。
- 空状态：「这段时间还没有记录」；AI 卡片仍显示未配置/不可用状态。

### 8.2 AI 回顾

- 「帮我回顾」按钮：已配置时显示目标配置名 + modelId + 范围 + 记录数；未配置时显示「先配置 AI 模型」+ 去设置。
- 点击后展示确认区/面板：
  - 目标模型、明确时间范围、统计摘要；
  - 将发送的记录列表，逐条复选框，默认全选，可排除；
  - 「将发送 X 条，共约 Y 字；未选 Z 条」；超出 80 条/16000 字时提示缩小范围或取消勾选，生成按钮禁用；
  - 生成/取消按钮。
- 生成中：进度卡显示模型、范围、记录数、「取消」；轮询 `GET /api/reviews/:id`，刷新后可用 URL 中 `review` 参数恢复。
- 失败：`AI_ERROR_LABEL` 分类文案 + 脱敏说明；「重试」；实际记录与统计仍在。
- 成功：展示 `overview` 与四个区块：做过的尝试 / 记录的观察 / 关联与矛盾 / 下次可参考。每条 item：
  - `basis='observation'` 显示「记录中的观察」徽标；`inference` 显示「模型推断」；
  - `sourceIds` 转为可点击来源 chip，打开原尝试或念头；
  - `uncertainties` 与 `dataNotes` 单独列出；
  - 覆盖范围 footer：「本次覆盖 X 条记录（另有 Y 条未选）」。
- 「保存回顾」：成功、失败重试、重复保存均要正确；保存后显示「已保存」与详情链接。重复点击不产生重复记录。
- 已保存回顾列表：范围、保存时间、概览、来源变更/删除徽标；点击进详情。
- 详情页：显示保存时范围、统计、内容、来源；来源变更显示「来源有更新」，删除显示「来源已删除（正文已按删除策略清除）」；`contentInvalidated` 横幅。模型不可用不影响详情查看。

### 8.3 从回顾进入「参考旧经验，再试一步」

- 成功回顾或已保存回顾中的 `experiences` item，若关联至少一条仍存在的 `attempt` 来源，显示「参考这条经验，再试一步」。
- 点击后让用户选择一条当前念头（未归档），再跳转 `/capture/:captureId?experience=<attemptId>&from=review`。
- 念头详情读取 `experience` 参数后，自动打开现有「参考旧经验」面板并调用现有 `preview` 接口带入该来源；用户仍需确认预览，才会生成；不自动创建尝试。
- 无可用念头时提示先记下一个新念头并链接首页。

### 8.4 响应式与状态

- 1280px 与 390px 宽度均可操作，无横向溢出；确认区/来源列表在手机宽度改为纵向。
- 加载、空、未配置、生成中、取消、失败、重试、来源过期、已删除均有明确文案。
- 复用现有 `--accent`、`--line`、`--card`、按钮/输入/徽标样式；不新增营销文案。

## 9. 测试约定

### 9.1 `scripts/test_review.py`

加入 `run_tests.py`，使用独立测试库/3100 端口。覆盖：

1. 未登录 401；非法范围/时区/preset 400；空数据。
2. 时区边界：按 `Asia/Shanghai` 计算日界，`from-1/from/to-1/to` 精确包含/排除；跨日、跨月。
3. 修改旧记录：旧尝试改结果/状态后 `attemptsStarted` 不变、`attemptsModified` 增加、结果数按 `observedAt` 不重复增加。
4. 部分缺少结果时间：`resultsRecorded` 不包含、`resultsMissingObservedAt` 单独计数。
5. 大量记录：>80 条时预览 `withinLimit=false`、生成 409 `review_too_large`；>500 条时 `truncated=true`。
6. 预览排除内容：`includeKeys` 未包含的记录不出现在返回与发送 prompt；`selectedChars` 合理。
7. 模型编造来源 ID → `failed/invalid_response`，可重试；合法来源 → `succeeded`，每条 item 的 `sourceIds` 都属于发送集合。
8. 未配置模型：range/preview 仍可用，生成 409；配置后成功。
9. 取消：pending 取消后不复活；刷新 `GET` 状态一致。
10. 保存：成功保存、重复保存同一 `savedAt`、未成功保存 409；列表与详情；来源修改 → `changed`；来源删除 → 正文清洗、`deleted=true`、`contentInvalidated=true`。
11. 删除念头/尝试后不残留可读正文；回顾详情仍可打开。
12. 导出：`schemaVersion=3`、`stageReviews` 包含内容与来源；旧 `schemaVersion=1/2` 语义兼容（缺失字段视为空数组/manual/null）。
13. 密钥不出现在回顾响应、导出、日志。

### 9.2 假模型

`scripts/fake_model_server.py` 增加：

- `fake-review`：按 prompt 中的 `[type:id]` 生成合法四区块，所有 sourceIds 均来自请求；
- `fake-review-insufficient`：返回 `insufficientData=true`、空 sections、说明不足；
- `fake-review-bad-source`：返回一个不在本次发送集合的 `sourceIds`；
- `fake-review-invalid-json`：非 JSON 文本；
- `fake-review-timeout`：延迟 5s。

`/__last` 可用于断言 prompt 只含选中记录、包含“一次练习”边界说明。

### 9.3 浏览器 E2E

`scripts/e2e_review.mjs`，1280×900 与 390×844：

范围选择 → 实际记录 → 排除一条 → 预览/生成 → 打开来源 → 保存 → 重复保存 → 刷新详情 → 从经验项「参考这条经验，再试一步」→ 选念头 → 预览 → 生成 → 采用 → 新尝试引用来源。

### 9.4 导出/备份回归

- `test_export.py` 增加回顾数据与 `schemaVersion=3` 断言，并保留旧版兼容断言。
- `test_backup_restore.py` 增加保存回顾 → 备份 → 恢复 → 详情与来源仍可读；旧库升级不丢数据。

## 10. 交付文档

更新 `README.md`、新增 `docs/review-notes.md`：启动地址、体验步骤、测试结果、真实模型联调状态（无真实配置时明确写“假模型验证通过，真实联调待完成”）、未验证事项、已知限制。
