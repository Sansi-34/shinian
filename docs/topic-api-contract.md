# 拾念 SHINIAN ·「主题」接口契约（第一版）

日期：2026-11-15；2026-11-16 增补主题问答候选的检索词扩展 `expanded`（见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)）。本契约冻结前端适配层使用的路由、字段名、分页参数与错误码。服务端实现以 `src/server/topicTypes.ts`、`src/server/topicService.ts`、`src/server/topicRoutes.ts`、`drizzle/migrations/0012_topics.sql` 为准；如与本文偏离，以 `docs/topic-notes.md` 记录为准。

## 0. 边界与通用约定

- 所有接口要求本机会话登录；未登录 `401 { "error": "unauthenticated" }`。
- 写接口沿用现有 Host / Origin 校验：Host 不在本机白名单 `403 { "error": "host rejected" }`；跨站写请求 `403 { "error": "origin rejected" }`。错误一律 JSON。
- 主题只是「一组稳定 ID 的集合 + 用户写下的探索问题/继续说明 + 可选固定下一步」。
  - `topics` 不复制念头/经验正文；`topic_members` 只存 `topic_id + capture_id + member_kind`。
  - 删除主题只删主题与成员关系，**不删除** capture / attempt / experience / schedule / reference。
  - 删除 capture 会级联删除它的成员关系，但不会删除主题；这是唯一会因外部删除而减少成员的路径。
- 所有时间字段都是毫秒时间戳（integer）。
- `archived` 是布尔值；数据库存 `archived_at`。返回同时给 `archivedAt`（number|null）与 `archived`（boolean）。
- 成员 `kind`：`thought`（普通念头）或 `experience`（经验笔记，`captures.kind='experience'`）。加入时按 `captures.kind` 固化到 `topic_members.member_kind`。
- 稳定 ID：主题 `id` 形如 `topic-<毫秒>-<随机>`。成员行 `id` 形如 `tmem-<毫秒>-<随机>`，但前端只用 `captureId` 做成员操作。

## 1. 数据模型（迁移 `0012_topics.sql`）

### 1.1 `topics`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `topic-<毫秒>-<6 位随机>` |
| `title` | TEXT NOT NULL | 1–120 字符（trim 后） |
| `exploring_question` | TEXT NULL | 探索问题，≤1000；`''` 归一为 null |
| `continue_note` | TEXT NULL | 继续说明，≤1000；`''` 归一为 null |
| `next_attempt_id` | TEXT NULL REFERENCES attempts(id) ON DELETE SET NULL | 固定的下一步尝试；删除 attempt 时数据库置 null |
| `next_attempt_cleared_reason` | TEXT NULL | 固定的下一步失效原因；`attempt_deleted`/`attempt_cancelled`/`member_removed`，设置新固定时清空 |
| `revision` | INTEGER NOT NULL DEFAULT 1 | 每次标题/说明/成员/固定下一步/归档变化 +1 |
| `archived_at` | INTEGER NULL | 归档时间；归档不级联成员 |
| `created_at` / `updated_at` | INTEGER NOT NULL | 毫秒 |

索引：`topics_archived_updated_idx(archived_at, updated_at DESC)`、`topics_updated_idx(updated_at DESC)`。

### 1.2 `topic_members`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `tmem-<毫秒>-<6 位随机>` |
| `topic_id` | TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE | |
| `capture_id` | TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE | 稳定 ID，不复制正文 |
| `member_kind` | TEXT NOT NULL | `thought` / `experience`，加入时按 capture.kind 固化 |
| `created_at` | INTEGER NOT NULL | 加入时间 |

- `UNIQUE(topic_id, capture_id)`：同一主题内同一条记录只出现一次。
- 索引：`topic_members_topic_created_idx(topic_id, created_at)`、`topic_members_capture_idx(capture_id)`。
- 同一条经验可以加入多个主题（唯一约束只在单个主题内生效）。
- 成员候选与聚合查询只使用稳定 ID 回表读取当前正文/标题/状态；正文修改会反映在主题详情中，不产生副本。

## 2. 共享响应对象

### 2.1 `TopicSummary`

列表、详情、PATCH、归档、固定下一步、`captures/:id/topics` 共用：

```json
{
  "id": "topic-1763200000000-ab12cd",
  "title": "PWM 调光实验",
  "exploringQuestion": "不同频率下 LED 是否可见闪烁？",
  "continueNote": "先记录 500 Hz 与 2 kHz 的对照。",
  "archived": false,
  "archivedAt": null,
  "revision": 3,
  "createdAt": 1763200000000,
  "updatedAt": 1763200100000,
  "memberCount": 3,
  "thoughtCount": 2,
  "experienceCount": 1,
  "nextAttemptId": "att-1763200000000-abc123",
  "nextAttempt": { "…TopicNextAttempt…": "见 2.2；无固定时为 null" },
  "latestAttemptAt": 1763200050000,
  "nextAttemptClearedReason": null
}
```

- `memberCount = thoughtCount + experienceCount`，包含归档成员；成员归档不自动移出主题，`member.archived` 单独标注。
- `latestAttemptAt`：该主题**普通念头成员**下所有真实 attempts 的 `MAX(COALESCE(observed_at, created_at))`；没有 attempts 时为 null。经验成员自身的依据 attempts 不计入。
- `nextAttempt` 的摘要规则见 2.2。读取时如果固定 attempt 已删除/已取消/已不在 thought 成员下，服务端会清空 `next_attempt_id`、`revision+1`，并在 `nextAttemptClearedReason` 返回 `attempt_deleted` / `attempt_cancelled` / `member_removed`；列表接口只返回 null 与原因、不主动清理，详情/写接口会清理。**不因时间经过推断完成**。

### 2.2 `TopicNextAttempt`

```json
{
  "id": "att-1763200000000-abc123",
  "attemptId": "att-1763200000000-abc123",
  "captureId": "cap-1763199990000-def456",
  "captureTitle": "500 Hz 下 LED 会闪",
  "step": "把 PWM 频率从 500 Hz 改到 2 kHz 再观察",
  "href": "/attempt/att-1763200000000-abc123",
  "state": "todo",
  "resultText": null,
  "outcome": null,
  "observedAt": null,
  "revision": 1,
  "isCompleted": false
}
```

- `id` 与 `attemptId` 相同，保留 `attemptId` 便于前端按语义取用。
- `isCompleted = (state === 'done')`，仅此一义；`state='cancelled'` 的 attempt 不能成为固定下一步，读取时会被清空。
- `captureTitle`：所属念头正文首行（≤100 字符）。

### 2.3 `TopicMember`

```json
{
  "id": "tmem-1763200000000-ef7890",
  "captureId": "cap-1763199990000-def456",
  "kind": "thought",
  "title": "500 Hz 下 LED 会闪",
  "summary": "PWM 低占空比时 LED 会闪，500 Hz 时肉眼可见。",
  "revision": 2,
  "archived": false,
  "createdAt": 1763199990000,
  "updatedAt": 1763200000000,
  "href": "/capture/cap-1763199990000-def456"
}
```

经验成员额外带：

```json
{
  "kind": "experience",
  "title": "先降低占空比再比较频率",
  "summary": "把占空比固定后，只改频率做对照更容易看清差异。",
  "href": "/experience/cap-1763199980000-exp001",
  "sourceCount": 2,
  "derivationBy": "user",
  "needsRevision": false,
  "hasPracticeResult": true
}
```

- `title`：念头取正文首行（≤80）；经验取 `experience_notes.title`。
- `summary`：念头/经验正文首行（≤160）。
- `revision`/`createdAt`/`updatedAt` 是 **capture** 的值，不是成员行时间；`memberCreatedAt` 只在 `captures/:id/topics` 中返回。
- 经验四项额外字段只对 `kind='experience'` 出现；`sourceCount` 只计 `deleted=0` 的依据，`hasPracticeResult` 表示至少一条有效依据带非空 `resultText`。
- `archived` 是 capture 的归档状态，不是成员状态。

## 3. 主题 CRUD

### 3.1 `GET /api/topics`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `archived` | `0` | `0` 未归档；`1` 已归档；`all` 全部。其他值 400 `invalid_archived` |
| `limit` | 20 | 1–50；越界按边界截断 |
| `offset` | 0 | ≥0；负数按 0 |
| `q` | 空 | 对 `title`、`exploring_question`、`continue_note` 做子串匹配（ASCII 大小写不敏感，`%`/`_` 转义） |

排序：`updated_at DESC, created_at DESC, id DESC`。

响应：

```json
{
  "topics": ["…TopicSummary…"],
  "total": 12,
  "limit": 20,
  "offset": 0,
  "hasMore": false
}
```

`total` 是过滤后、分页前的数量；`hasMore = offset + topics.length < total`。

### 3.2 `POST /api/topics`

```json
{
  "title": "PWM 调光实验",
  "exploringQuestion": "不同频率下 LED 是否可见闪烁？",
  "continueNote": "先记录 500 Hz 与 2 kHz 的对照。",
  "captureIds": ["cap-thought-a", "cap-experience-b"],
  "nextAttemptId": "att-…",
  "operationId": "client-uuid"
}
```

- `title` 必填，trim 后 1–120。
- `exploringQuestion` / `continueNote` 可选，≤1000；`null`/`''` 存 null。
- `captureIds` 可选，≤50 个字符串；重复 ID 去重；不存在 → 400 `capture_not_found`（附 `captureIds`）。按 `captures.kind` 写 `member_kind`，普通念头不能写成经验。
- `nextAttemptId` 可选：必须属于本次 `captureIds` 中某个 **thought** capture，且 `state ∈ todo|in_progress`；否则 400 `invalid_next_attempt`，`reason ∈ attempt_not_found|not_thought_member|attempt_completed|attempt_cancelled|invalid_state`。
- `operationId` 必填，1–200。事务内创建主题 + 成员 + 固定下一步 + 回执。
- 同一 `operationId` 同请求：200 `{ topic, members, replayed: true }`；同键不同 payload：409 `operation_key_conflict`。
- 成功：201 `{ topic: TopicSummary, members: { thoughts: TopicMember[], experiences: TopicMember[] }, replayed: false }`。

### 3.3 `GET /api/topics/:id`

```json
{
  "topic": "…TopicSummary…",
  "members": {
    "thoughts": ["…TopicMember…"],
    "experiences": ["…TopicMember…"]
  }
}
```

- 成员顺序：`topic_members.created_at ASC, id ASC`。
- 不存在：404 `topic_not_found`。
- 若固定 attempt 失效，本次读取会清空并在 `topic.nextAttemptClearedReason` 给出原因（见 2.1）。

### 3.4 `PATCH /api/topics/:id`

```json
{
  "title": "PWM 频率对照",
  "exploringQuestion": null,
  "continueNote": "先只改频率。",
  "expectedRevision": 3,
  "operationId": "client-uuid"
}
```

- 只更新出现的字段；`exploringQuestion` / `continueNote` 传 `null` 或 `''` 表示清空。
- `expectedRevision` 必填；缺失 428 `revision_required`。
- `operationId` 必填，1–200。
- 版本不一致：409

```json
{
  "error": "revision_conflict",
  "message": "主题已在别处修改，请刷新后重试。",
  "currentRevision": 4,
  "currentTopic": { "…TopicSummary…": "" }
}
```

- 成功：200 `{ topic: TopicSummary, replayed: false }`；成功更新 `revision+1`、`updated_at`。
- 同 `operationId` 同请求回放 200 `{ topic, replayed: true }`；不同请求 409 `operation_key_conflict`。

### 3.5 `POST /api/topics/:id/archive` / `POST /api/topics/:id/restore`

```json
{ "expectedRevision": 4, "operationId": "client-uuid" }
```

- `expectedRevision` 推荐传；省略时服务端按当前 revision 处理（仍会 CAS，若读取与更新之间被并发修改则 409）。`operationId` 可选（给了才参与幂等/回放）。
- 归档只写 `archived_at` 并 `revision+1`，**不改成员、不删成员、不取消固定下一步**；恢复写 null。
- 返回 200 `{ topic: TopicSummary, replayed: false|true }`。
- 404 `topic_not_found`；409 `revision_conflict`（带 `currentRevision`、`currentTopic`）。

### 3.6 `GET /api/topics/:id/delete-preview`

不删除任何业务数据，只读统计：

```json
{
  "topic": "…TopicSummary…",
  "memberCount": 3,
  "thoughtCount": 2,
  "experienceCount": 1,
  "fixedAttemptId": "att-…",
  "preserved": {
    "captures": 3,
    "attempts": 5,
    "schedules": 2,
    "experienceSources": 4
  },
  "willDelete": { "topic": 1, "topicMembers": 3 },
  "note": "删除主题只会移除主题与成员关系，不会删除念头、经验、尝试、日程或依据记录。"
}
```

- `preserved.captures`：成员记录数（全部保留）。
- `preserved.attempts`：thought 成员 capture 下的真实 attempts 数（全部保留）。
- `preserved.schedules`：上述 attempts 的日程块数（全部保留）。
- `preserved.experienceSources`：experience 成员的有效 `experience_sources` 行数（全部保留）。

### 3.7 `DELETE /api/topics/:id`

- 事务只删 `topics` 行；`topic_members` 由外键级联删除。
- 不删 capture / attempt / experience / schedule / reference。
- 返回 200 `{ "ok": true, "deletedTopicId": "topic-…", "deletedMembers": 3 }`；不存在 404 `topic_not_found`。

## 4. 成员候选与成员操作

### 4.1 `GET /api/topics/:id/member-candidates?q=&limit=`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` | 空 | 子串匹配：thought 匹配 `captures.raw_text`；experience 匹配 `experience_notes.title` 或 `captures.raw_text` |
| `limit` | 20 | 1–30；越界按边界截断 |

- 只返回**尚未加入本主题**且 `captures.kind ∈ thought|experience` 的记录；**不返回 attempt**。
- 排序：`captures.updated_at DESC, captures.created_at DESC, captures.id DESC`。
- 响应：

```json
{
  "candidates": [
    {
      "captureId": "cap-…",
      "kind": "experience",
      "title": "先降低占空比再比较频率",
      "summary": "把占空比固定后，只改频率做对照更容易看清差异。",
      "archived": false,
      "createdAt": 1763199980000,
      "updatedAt": 1763199990000,
      "sourceCount": 2
    }
  ],
  "total": 8,
  "limit": 20
}
```

- `sourceCount` 只对 experience 出现，计 `deleted=0` 的依据。
- 主题不存在 404 `topic_not_found`；`q` 超过 120 字符 400 `query_too_long`。

### 4.2 `POST /api/topics/:id/members`

```json
{ "captureIds": ["cap-a", "cap-b"], "operationId": "client-uuid" }
```

- `captureIds` 必填、1–50 个字符串、重复去重；不存在 → 400 `capture_not_found`（附缺失 IDs）。
- 只接受已存在的 captures；`member_kind` 按 capture.kind 写入；同一主题重复成员不报错，计入 `existing`。
- 事务内插入新成员 + `topics.revision+1`、`updated_at` + 回执。
- 返回 200：

```json
{
  "members": ["…TopicMember…（操作后该主题全部成员）"],
  "added": 2,
  "existing": 1,
  "addedCaptureIds": ["cap-a", "cap-b"],
  "existingCaptureIds": ["cap-c"],
  "replayed": false
}
```

- `members` 是扁平数组（不是分组对象）；需要分组用 `GET /api/topics/:id`。
- 同 `operationId` 同请求回放 200 `replayed:true`；不同请求 409 `operation_key_conflict`。
- 主题不存在 404 `topic_not_found`。

### 4.3 `DELETE /api/topics/:id/members/:captureId`

- 删除一条成员关系，不删除 capture/attempt/experience。
- 若 `topics.next_attempt_id` 指向的 attempt 属于该 capture，同时清空并 `revision+1`。
- 返回 200：

```json
{
  "removed": true,
  "captureId": "cap-…",
  "clearedNext": true,
  "topic": "…TopicSummary…"
}
```

- 主题不存在 404 `topic_not_found`；成员不存在 404 `member_not_found`。
- 重复删除（成员已不在）返回 404 `member_not_found`，不是幂等成功。

## 5. 主题尝试聚合

### 5.1 `GET /api/topics/:id/attempts?limit=&offset=&state=`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `limit` | 20 | 1–50；越界按边界截断 |
| `offset` | 0 | ≥0 |
| `state` | `all` | `all` / `recorded` / `pending` / `cancelled` |

- 只聚合 `topic_members.member_kind='thought'` 的成员 capture 下的**真实 attempts**；经验成员自身的依据 attempts 不进入该列表。
- 同一 attempt 只出现一次（按 `attempts.id` 去重）。
- 排序：`COALESCE(observed_at, created_at) DESC, created_at DESC, id DESC`。
- 过滤口径：
  - `recorded`：`state <> 'cancelled'` 且 `result_text` 非空（trim 后）。
  - `pending`：`state <> 'cancelled'` 且 `result_text` 为空（含 `todo` / `in_progress`，也含没有结果的 `done`）。
  - `cancelled`：`state='cancelled'`。
- 返回：

```json
{
  "attempts": [
    {
      "id": "att-…",
      "captureId": "cap-…",
      "captureTitle": "500 Hz 下 LED 会闪",
      "step": "把 PWM 频率从 500 Hz 改到 2 kHz 再观察",
      "state": "done",
      "resultText": "2 kHz 时肉眼未见闪烁",
      "outcome": "success",
      "observedAt": 1763200050000,
      "createdAt": 1763199990000,
      "updatedAt": 1763200050000,
      "revision": 2,
      "href": "/attempt/att-…",
      "resultState": "recorded"
    }
  ],
  "total": 3,
  "limit": 20,
  "offset": 0,
  "hasMore": false
}
```

- `resultState` 三态：
  - `recorded`：`result_text` 非空且 `state <> 'cancelled'`；
  - `pending_no_result`：`result_text` 为空且 `state <> 'cancelled'`（**绝不按时间推断已完成**）；
  - `cancelled`：`state='cancelled'`。
- 主题不存在 404 `topic_not_found`；`state` 非法 400 `invalid_attempt_state`。

## 6. 固定下一步

### 6.1 `PUT /api/topics/:id/next-attempt`

```json
{ "attemptId": "att-…", "expectedRevision": 4, "operationId": "client-uuid" }
```

- `attemptId` 可以是 `null`（清空）或字符串。
- 只允许本主题 **thought 成员** capture 下的 attempt，且 `state ∈ todo|in_progress`；否则 400 `invalid_next_attempt`：

```json
{
  "error": "invalid_next_attempt",
  "reason": "not_thought_member",
  "message": "只能固定本主题普通念头下的未结束尝试。"
}
```

`reason` 取值：`attempt_not_found` / `not_thought_member` / `attempt_completed`（state=done）/ `attempt_cancelled` / `invalid_state`。
- `expectedRevision` 必填；`operationId` 必填。
- 版本冲突 409 `revision_conflict`（`currentRevision`、`currentTopic`）。
- 成功 200：

```json
{ "topic": "…TopicSummary…", "clearedReason": null, "replayed": false }
```

- `clearedReason` 描述**本次操作前**已有的固定 attempt 因失效被清除的原因：`attempt_deleted` / `attempt_cancelled` / `member_removed` / null。它不影响原 attempt 记录。
- 删除 attempt 时数据库 `ON DELETE SET NULL` 会清空；取消 attempt 时 PATCH 会主动清空并返回 `clearedTopicNext`；移出成员时 DELETE member 会清空并返回 `clearedNext`。固定下一步失效不会回退主题 revision。

## 7. 记录详情中的主题

### 7.1 `GET /api/captures/:id/topics`

返回该记录所属主题（**包含已归档主题**），按主题 `updated_at DESC`：

```json
{
  "captureId": "cap-…",
  "topics": [
    {
      "id": "topic-…",
      "title": "PWM 调光实验",
      "exploringQuestion": "…",
      "continueNote": "…",
      "archived": false,
      "archivedAt": null,
      "revision": 3,
      "createdAt": 1763200000000,
      "updatedAt": 1763200100000,
      "memberCount": 3,
      "thoughtCount": 2,
      "experienceCount": 1,
      "nextAttemptId": null,
      "nextAttempt": null,
      "latestAttemptAt": 1763200050000,
      "nextAttemptClearedReason": null,
      "memberKind": "thought",
      "memberCreatedAt": 1763200000000
    }
  ]
}
```

- capture 不存在 404 `capture_not_found`。

### 7.2 `POST /api/captures/:id/topics`

```json
{ "topicIds": ["topic-a", "topic-b"], "operationId": "client-uuid" }
```

- `topicIds` 必填、1–50 个字符串、重复去重；任一主题不存在 404 `topic_not_found`（附 `topicIds`）。
- 已加入的主题跳过，不重复；新加入按 capture.kind 写 `member_kind`；只对实际新增的主题 `revision+1`、`updated_at`。
- 返回 200：

```json
{
  "topics": [
    { "topicId": "topic-a", "title": "…", "added": true },
    { "topicId": "topic-b", "title": "…", "added": false }
  ],
  "added": 1,
  "existing": 1,
  "replayed": false
}
```

- 同 `operationId` 同请求回放 200；不同请求 409 `operation_key_conflict`。
- “新建主题再放入”由前端先调 `POST /api/topics` 再调本接口，服务端不提供合并入口。

## 8. 主题问答范围（服务端强制）

主题问答不是新的问答实现，而是在现有 `/api/ask` 上增加一个**服务端计算、客户端不可伪造的 allowed source scope**。主题标题、探索问题、继续说明**不会**进入模型 prompt；prompt 仍只有用户问题、关键词、日期范围、用户确认的记录。

### 8.1 范围定义

对主题 `T`：

1. `thoughtCaptureIds`：`topic_members.member_kind='thought'` 的 capture（记录仍存在）。
2. `thoughtAttemptIds`：上述 capture 下的**直接** attempts（不递归、不跨 capture）。
3. 经验成员 `E` 的直接原始依据（`experience_sources`）：
   - `source_type='attempt'` 且 `deleted=0` 且 attempt 仍存在、其所属 capture 不是 experience → 允许 `attempt:<source_id>`；
   - `source_type='capture'` 且 `deleted=0` 且 capture 仍存在且 `kind != 'experience'` → 允许 `capture:<source_id>`；
   - **不递归**经验依据里的经验/关系；经验正文永远不是 allowed source，也不能成为 `AskRecord`。
4. 去重：同一 `sourceKey` 只计一次，不与 thought/attempt 重复计。
5. `allowedSourceCount` = 上述 allowed sourceKey 去重后的数量。
6. `scopeHash = sha256(JSON.stringify({ topicId, topicRevision, thoughtCaptureIds: sorted, thoughtAttemptIds: sorted, experienceIds: sorted, experienceSourceKeys: sorted }))`。
7. `topicRevision` 取当前 `topics.revision`；任何成员增删/主题说明修改/归档都会改变 revision；capture 删除导致的成员级联会改变 allowed 集合（服务端同时会 bump 受影响主题 revision）。

### 8.2 `GET /api/topics/:id/ask-candidates`

参数与 `GET /api/ask/candidates` 相同：`question`（必填，1–500）、`keywords`、`from`、`to`、`limit`（1–50，默认 20），以及可重复的 `expanded`（0–5 项，单项 ≤40 字、合计 ≤120 字）。

- 只在 `thoughtCaptureIds` 及其直接 attempts 内检索，复用 `searchAskCandidates` 的命中/排序语义，但：
  - 不加载 `attempt_references` / `capture_links`，不做一跳扩展；
  - 候选的 `matchKind` 只能是 `direct`（原始关键词命中）或 `expanded`（仅扩展词命中），不会是 `relation`；
  - `expanded` 只在主题 allowed scope 内检索，不会带回主题外记录；
  - 不返回经验成员正文作为候选/证据。
- 响应 = `AskSearchResponse` + `topic` + `scope`：

```json
{
  "question": "…",
  "keywords": ["PWM"],
  "suggestedKeywords": "PWM",
  "expandedKeywords": [],
  "range": { "from": null, "to": null, "fromLocal": null, "toLocal": null },
  "total": 2,
  "limit": 20,
  "candidates": ["…AskCandidate…"],
  "ai": { "configured": false, "enabled": false, "config": null },
  "generatedAt": 1763200000000,
  "topic": { "id": "topic-…", "name": "PWM 调光实验" },
  "scope": {
    "topicId": "topic-…",
    "topicTitle": "PWM 调光实验",
    "scopeHash": "hex-sha256",
    "topicRevision": 3,
    "thoughtCount": 2,
    "experienceCount": 1,
    "allowedSourceCount": 8
  }
}
```

- `expandedKeywords` 是本次实际采用的扩展词；每个候选带 `matchedKeywords`（原始词 + 扩展词的实际命中，`[]` 表示无直接/扩展命中）和 `matchKind`（`direct` / `expanded`）。
- 主题不存在 404 `topic_not_found`；问题/关键词/日期范围错误同 `/api/ask/candidates`（400 `invalid_question` / `invalid_keywords` / `invalid_range` / `invalid_expanded_keywords`）。

### 8.3 `GET /api/topics/:id/ask-experiences`

只供“查看依据并选择”，不递归经验的经验/关系：

```json
{
  "topicId": "topic-…",
  "experiences": [
    {
      "id": "cap-experience-…",
      "title": "先降低占空比再比较频率",
      "summary": "把占空比固定后，只改频率做对照更容易看清差异。",
      "sourceCount": 2,
      "derivationBy": "user",
      "needsRevision": false,
      "sources": ["…ExperienceSourcePublic…"],
      "selectableSourceKeys": ["attempt:att-…", "capture:cap-…"]
    }
  ]
}
```

- `sources` 只包含仍存在、`deleted=false`、且 `kind ∈ attempt|thought` 的直接原始依据；`source.kind='experience'` 的条目被排除。
- `selectableSourceKeys` 是这些来源中属于 allowed scope 的 sourceKey（可直接用于 `/api/ask/preview` 的 `sourceKeys`）。
- `derivationBy`：`model` / `user`；`needsRevision` 来自经验笔记。
- 主题不存在 404 `topic_not_found`。

### 8.4 `POST /api/ask/preview` 新增可选 `topicId`

请求在现有字段上增加：

```json
{
  "question": "…",
  "keywords": "PWM",
  "from": null,
  "to": null,
  "sourceKeys": ["attempt:att-…"],
  "topicId": "topic-…"
}
```

- 提供 `topicId` 时：校验主题存在（404 `topic_not_found`）；每个 `sourceKey` 必须属于 8.1 allowed scope，否则 400：

```json
{
  "error": "source_out_of_scope",
  "sourceKeys": ["attempt:att-outside"],
  "message": "所选记录不在这个主题的范围内，请重新选择。"
}
```

- 经验正文（`capture:<experienceId>`）永远不在 allowed scope，返回 `source_out_of_scope`；模型只能收到经验依据里的直接 attempt/capture 原文。
- 响应在现有 `AskPreviewResponse` 上增加 `scope`（同 8.2）；`contextToken` 额外绑定 `topicId + topicRevision + scopeHash`：

```text
SHA-256(JSON.stringify({
  question, keywords: keywords.join(' '), from, to,
  configVersion,
  items: 按 sourceKey 排序的 [{sourceKey, revision, captureRevision}],
  topicId, topicRevision, scopeHash
}))
```

- 不提供 `topicId` 时 token 公式与旧版完全一致（不增加字段），非主题预览不受影响。
- `records` 仍是服务端按 sourceKey 重读的真实记录；主题说明、探索问题、继续说明不进入 prompt。
- 主题成员/来源在预览后变化：若已选 sourceKey 已不在新 scope → 400 `source_out_of_scope`（不可绕过范围校验）；若 scope 仍包含已选来源但来源 revision/主题 scopeHash 变化 → 生成时 409 `context_changed`，message 为「主题成员或来源已变化，请刷新预览并重新确认。」。

### 8.5 `POST /api/ask/queries` 新增可选 `topicId`

- 校验顺序：
  1. 现有 question / range / keywords / sourceKeys 校验（400）；
  2. `operationId`、`contextToken` 必填（400）；
  3. 同 `operationId` 回执：同指纹 200 回放，不同指纹 409 `operation_key_conflict`；
  4. 提供 `topicId` 时：主题不存在 404 `topic_not_found`；sourceKeys 越界 400 `source_out_of_scope`；
  5. 模型配置（409 `ai_not_configured` / `ai_disabled`）；
  6. 来源重读（409 `sources_unavailable`）；
  7. 长度上限（409 `query_too_large`）；
  8. token 重算不一致 → 409 `context_changed`（主题 message 见 8.4）；
  9. pending 上限 429；
  10. 写入 pending，202 `{ query, scope, replayed: false }`。
- 指纹额外包含 `topicId`（仅提供时）；回放响应 `scope` 取该主题当前 scope（只作展示，不改变已生成问答）。
- `record_queries` **不新增 topicId 列**；历史问答不记录主题，移出成员不改写已生成问答。
- `scope` 字段形状同 8.2，仅提供 `topicId` 时出现；`POST /api/ask/preview` 同样。

## 9. 删除与一致性

| 操作 | 行为 | 返回值/影响 |
| --- | --- | --- |
| 删除 capture | 删除其 `topic_members`；若 `topics.next_attempt_id` 指向该 capture 下 attempt，清空；主题保留 | 现有删除接口新增 `deletedTopicMembers`、`clearedTopicNext` 计数 |
| 删除 attempt | FK `ON DELETE SET NULL`；服务端显式清空引用它的主题并 `revision+1` | 现有删除接口新增 `unfixedTopicCount` |
| attempt PATCH 改为 `cancelled` | 清空 `topics.next_attempt_id` 并 `revision+1` | 现有 PATCH 响应新增 `clearedTopicNext` |
| 移出成员 | 若固定 attempt 属于该 capture，清空 | `DELETE member` 返回 `clearedNext` |
| 归档主题 | 只写 `archived_at`，不改成员 | 主题仍出现在 `archived=1` 列表 |
| 归档 capture | 不影响主题/成员，成员项 `archived=true` | 不级联 |
| 删除 capture/topic | 不删除经验依据、不删除其他主题 | 原记录保留 |

- 所有多步写入在 SQLite 事务内完成；失败整体回滚。
- `mutation_receipts` 的 `target_type`：`topic` / `topic_update` / `topic_archive` / `topic_restore` / `topic_members` / `topic_next_attempt` / `capture_topics`。内部回执不导出。

## 10. 导出 `GET /api/export`（schemaVersion 7）

在 schema 6 的全部字段上增加：

- `data.topics`：`{ id, title, exploringQuestion, continueNote, nextAttemptId, nextAttemptClearedReason, revision, archivedAt, createdAt, updatedAt }`
- `data.topicMembers`：`{ id, topicId, captureId, memberKind, createdAt }`

按 `created_at ASC, id ASC` 排序；字段 camelCase。不导出 `mutation_receipts`、`_migrations`、会话/密钥等内部数据。原有 schema 6 字段全部保留。

## 11. 备份

整库 SQLite 备份（`scripts/backup.mjs`）自动包含 `topics`、`topic_members`；恢复后启动迁移会确保表存在。无需新增备份代码。`scripts/test_topics.py` 用 SQLite backup API 复制隔离库并验证两表与行完整。

## 12. 错误码速查

| HTTP | error | 触发 | 附加字段 |
| --- | --- | --- | --- |
| 400 | `invalid_request` | 字段类型不支持、缺少 operationId 等通用问题 | `field`, `message` |
| 400 | `invalid_title` | 标题缺失/空/超过 120 | `field:'title'`, `message` |
| 400 | `invalid_exploring_question` | 探索问题 >1000 或非字符串 | `field`, `message` |
| 400 | `invalid_continue_note` | 继续说明 >1000 或非字符串 | `field`, `message` |
| 400 | `invalid_operation_id` | operationId 缺失/空/>200 | `field:'operationId'`, `message` |
| 400 | `capture_not_found` | captureIds 中有不存在的记录 | `captureIds`, `message` |
| 400 | `invalid_next_attempt` | 固定 attempt 不属于主题 thought 成员或状态不允许 | `reason`, `message` |
| 400 | `invalid_archived` | `archived` 不是 `0/1/all` | `message` |
| 400 | `invalid_attempt_state` | `state` 不是 `all/recorded/pending/cancelled` | `message` |
| 400 | `query_too_long` | 成员候选 `q` >120 | `message` |
| 400 | `source_out_of_scope` | 带 topicId 的 sourceKeys 不属于 allowed scope | `sourceKeys`, `message` |
| 400 | `invalid_sources` | sourceKeys 为空/>8/格式错误/重复 | `message` |
| 400 | `invalid_question` / `invalid_keywords` / `invalid_range` / `invalid_expanded_keywords` | 同 `/api/ask`（主题 ask-candidates 的 `expanded` 超限/空值/控制字符） | `field`, `message` |
| 401 | `unauthenticated` | 无会话 | — |
| 404 | `topic_not_found` | 主题不存在 | `message` |
| 404 | `member_not_found` | 主题成员不存在 | `message` |
| 404 | `capture_not_found` | 记录不存在（capture topics / capture 添加） | `message` |
| 409 | `revision_conflict` | expectedRevision 与当前不一致 | `currentRevision`, `currentTopic` |
| 409 | `operation_key_conflict` | 同 operationId 不同请求 | `message` |
| 409 | `context_changed` | 预览后主题/成员/来源版本变化 | `message` |
| 428 | `revision_required` | 缺少 expectedRevision | `message` |

## 13. 前端适配备注

- 所有 `nextAttempt` 字段用 `id` 或 `attemptId` 均可，二者相同；`isCompleted` 只看 `state==='done'`，**不要用时间判断**。
- `GET /api/topics` 返回分页对象，不是裸数组；`GET /api/captures/:id/topics` 返回 `{captureId, topics}`。
- 成员增删、固定下一步、归档/恢复都要求 `expectedRevision`（成员增删除外，成员接口以 topic 当前版本为准并在事务内 bump）；发生 409 时用 `currentTopic` 覆盖本地展示，但保留用户正在编辑的文本。
- 主题问答的 `scope` 只用于展示范围和调试，客户端不能自行构造或修改；`sourceKeys` 必须来自 `ask-candidates` 或 `ask-experiences.selectableSourceKeys`。
- `schemaVersion 7` 的字段名固定为 `data.topics` 与 `data.topicMembers`，成员字段为 `memberKind`（camelCase），数据库列名 `member_kind` 不出现在 API/导出中。

## 14. 前端兼容字段（不改变主契约）

为兼容前端既有适配层，以下别名与主字段同时返回（值相同），服务端输入也接受别名：

| 主字段 | 兼容字段/输入 | 说明 |
| --- | --- | --- |
| `title` | `name` | 所有主题对象同时返回；`POST /api/topics` 与 `PATCH` 同时接受 `name` |
| `latestAttemptAt` | `lastAttemptAt` | 列表/详情同时返回 |
| `nextAttempt.captureTitle` | `nextAttempt.captureText` | 同时返回 |
| `nextAttempt.isCompleted` | `nextAttempt.resultRecorded` | 同时返回，均由 `state='done'` 决定 |
| `nextAttempt.createdAt/updatedAt` | — | 同时返回 attempt 的时间 |
| 分页 `offset` | `cursor` + `nextCursor` | 列表/候选/尝试均支持；`cursor` 是服务端生成的 base64url 字符串，内部编码 offset；响应同时给 `offset` 与 `nextCursor` |
| `GET /api/topics/:id` 的 `members` 分组 | `memberList` 扁平数组 | `members` 保持 `{thoughts,experiences}`；`memberList` 为同一批成员的扁平数组 |
| 成员 `kind` | `type` | 同时返回 |
| 成员 `href` | `openHref` | 同时返回 |
| 成员 `addedAt` | `memberCreatedAt`（仅 capture topics） | 加入时间 |
| `POST /api/topics/:id/members` 的 `existing` | `skipped`、`skippedIds` | `added`/`existing` 是数字；`addedIds`/`skippedIds` 是 ID 数组；`members` 为操作后扁平数组 |
| `DELETE member` 的 `clearedNext` | `ok`、`clearedNextAttempt` | `removed` 仍是 true |
| `GET /api/topics/:id/ask-candidates` 的 `scope` | `topic:{id,name}`、`scope.topicName`、`scope.attemptCount`、`scope.recordCount` | `scope` 同时保留 `topicTitle/scopeHash/topicRevision/allowedSourceCount` |
| 主题 ask-candidates 的 `expanded` | `expandedKeywords`、候选 `matchedKeywords` | 与全库 candidates 相同；候选 `matchKind` 只能是 `direct` / `expanded`，不会出现 `relation` |
| `GET /api/topics/:id/ask-experiences` | `topic:{id,name}`、`hasPracticeResult` | experiences 数组不变 |
| `POST /api/ask/preview` / `queries` 的 `topicId` | — | `topicId` 必填仅在“主题问答”场景；普通问答不传。preview 返回 `scope`，生成响应也返回 `scope` |

命名说明：主题在数据库使用 `title` 列，API 主字段为 `title`；`name` 只是别名。前端若只读 `name` 也能正常工作。
