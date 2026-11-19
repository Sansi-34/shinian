# 拾念 SHINIAN ·「主题」实现记录（第一版）

日期：2026-11-15；2026-11-16 增补主题问答候选的 `expanded` 检索词扩展（见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)）。接口契约见 [`topic-api-contract.md`](./topic-api-contract.md)；本文记录设计取舍、迁移、测试与未验证边界。

## 1. 目标与非目标

主题解决的问题：把「一组相关的念头/经验」放在一起，给它们一个探索问题、一段继续说明，并可选地固定下一步尝试；需要找证据时，问答只能在这个主题范围内检索。

明确不做：

- 不做层级主题、标签、自动归类、相似度聚类；成员只由用户手动加入。
- 不复制念头/经验/尝试正文；`topic_members` 只存稳定 ID，详情读取时回表。
- 不把主题标题、探索问题、继续说明自动发送给模型；它们只是用户自己看的上下文。
- 不因成员加入/移出改写历史问答；`record_queries` 不新增 topic 列。
- 不递归「经验的经验」或经验关系；经验正文永远不是 AskRecord/证据。

## 2. 数据模型与迁移

### 2.1 迁移 `0012_topics.sql`

- `topics`：`id/title/exploring_question/continue_note/next_attempt_id/next_attempt_cleared_reason/revision/archived_at/created_at/updated_at`。`next_attempt_cleared_reason` 持久化一次失效反馈（`attempt_deleted`/`attempt_cancelled`/`member_removed`），设置新固定或显式清除时归零。
- `topic_members`：`id/topic_id/capture_id/member_kind/created_at`，`UNIQUE(topic_id, capture_id)`。
- 索引：`topics_archived_updated_idx(archived_at, updated_at DESC)`、`topics_updated_idx(updated_at DESC)`、`topic_members_topic_created_idx(topic_id, created_at)`、`topic_members_capture_idx(capture_id)`。
- `next_attempt_id REFERENCES attempts(id) ON DELETE SET NULL`；`topic_id`/`capture_id` 删除级联。
- 迁移从 `0011_experience_notes.sql` 之后按文件名顺序执行；不改旧迁移、不复制/回填业务数据。`db.ts` 的迁移执行器按 `--> statement-breakpoint` 拆分，0012 与既有迁移同格式。

### 2.2 为什么只存稳定 ID

念头正文会改、经验标题会改、尝试状态会变。若成员复制正文，主题页会显示过期内容；保存稳定 ID 后：

- 主题详情始终显示当前正文/标题/状态；
- 编辑念头或经验不会断开成员关系；
- 删除 capture 时外键级联删除成员，主题本身保留；
- 导出只导出 ID 关系，不复制正文。

`member_kind` 在加入时按 `captures.kind` 固化（`thought` / `experience`），用于成员分组与问答 scope；之后即使 `captures.kind` 发生变化（当前没有修改接口），成员类型仍保持加入时的语义。普通念头不会被写成经验。

### 2.3 revision 语义

`topics.revision` 是主题自身状态的 CAS 版本，不是成员 capture 的 revision：

- 标题/探索问题/继续说明修改：+1；
- 成员增删：+1（即使重复添加只 skipped，也记录一次操作；见 `addTopicMembers`）；
- 固定下一步改变：+1；
- 归档/恢复：+1；
- 删除 capture 导致成员级联/固定下一步清空：受影响主题 +1；
- 删除 attempt / attempt 改为 cancelled：固定引用清空，主题 +1。

列表/详情显示成员自身的 `revision`，与主题 revision 分开。前端编辑主题说明时用 `expectedRevision`；编辑成员正文仍走各自的 capture/experience 接口。

## 3. API 设计取舍

### 3.1 创建与幂等

- `POST /api/topics` 在一个事务里写 `topics`、`topic_members`、可选 `next_attempt_id`、`mutation_receipts`。
- 幂等键 `operationId` 1–200；回执保存 `topicId`，同键同指纹回放时重新读取当前主题；同键不同请求 409 `operation_key_conflict`。
- 指纹包含规范化后的标题/说明/成员 ID 顺序/固定 attempt；成员 ID 允许重复输入但服务端去重。
- 创建时 `nextAttemptId` 必须在本次 thought 成员下且 `todo/in_progress`；已在别处的 attempt 可以再被另一个主题固定（同一 attempt 可被多个主题引用），删除 attempt 时所有引用主题都会清空（见 §5）。

### 3.2 列表分页：offset + cursor 双兼容

契约主分页是 `limit/offset/total/hasMore`；前端既有适配层使用 cursor。服务端返回 `nextCursor`（base64url 编码 `offset:<n>`），同时支持 `cursor` 入参。内部仍是 offset 分页：主题按 `updated_at DESC` 排序，如果翻页期间有主题被编辑，下一页可能出现重复/跳过；这是无状态 cursor 的已知边界。本机单人、列表 50 条内可接受，后续若需要严格快照可分页可把排序键写进 cursor。

### 3.3 成员操作

- `POST /api/topics/:id/members`：只接受存在的 captures；重复成员不报错，返回 `added/existing`（兼容 `skipped`）；事务内 `topics.revision+1` 并写回执。
- `DELETE /api/topics/:id/members/:captureId`：重复删除返回 404，不是幂等成功；删除成员不删原记录。若固定 attempt 属于该 capture，清空并返回 `clearedNext`。
- `POST /api/captures/:id/topics`：从记录详情加入多个主题，已加入的主题 skipped；只对实际新增的主题 bump revision。新建主题的入口仍由前端调用 `POST /api/topics`，服务端不合并两种操作。

### 3.4 尝试聚合与结果三态

- 只聚合 `member_kind='thought'` 成员下的真实 `attempts`；经验成员自己的依据 attempts 不进入主题尝试列表（但可在主题问答的 allowed scope 中作为经验依据使用）。
- 同一 attempt 只出现一次；即使同一 capture 被重复加入（唯一索引阻止），JOIN 也不会产生重复。
- `resultState`：
  - `recorded`：`result_text` 非空且 `state != 'cancelled'`；
  - `pending_no_result`：`result_text` 为空且 `state != 'cancelled'`（包括没有结果的 `done`，不按时间推断完成）；
  - `cancelled`：`state='cancelled'`。
- `state` 过滤使用同一口径；排序 `COALESCE(observed_at, created_at) DESC, created_at DESC, id DESC`。

### 3.5 固定下一步（next attempt）

- 只允许本主题 thought 成员下的 `todo/in_progress` attempt；`done`、`cancelled`、其他成员/不存在分别返回 400 `invalid_next_attempt` 的 reason。
- 固定是「用户选择」，不会创建 attempt、不会改状态、不会自动安排日程。
- 失效处理：
  - `attempts` 删除：`topics.next_attempt_id` 外键 `ON DELETE SET NULL`；服务端删除 attempt 前显式清空并返回 `unfixedTopicCount`。
  - attempt PATCH 改为 `cancelled`：显式清空引用主题，返回 `clearedTopicNext`。
  - 移出成员：`DELETE member` 检查固定 attempt 是否属于该 capture，清空并返回 `clearedNext`。
  - 详情读取时再次防御：若固定 attempt 已删除/取消/不在 thought 成员下，清空并在 `nextAttemptClearedReason` 给出原因；列表不主动写库，只返回 null 与原因。

## 4. 主题问答范围

### 4.1 allowed scope 的计算

`buildTopicAskScope(topicId)` 每次请求实时计算（不缓存）：

1. thought 成员 capture IDs；
2. 这些 capture 下的直接 attempt IDs；
3. experience 成员的直接 `experience_sources`：
   - `source_type='attempt'`：要求 `deleted=0`、attempt 仍存在、其 capture `kind != 'experience'`；
   - `source_type='capture'`：要求 `deleted=0`、capture 仍存在、`kind != 'experience'`；
   - 不递归经验的经验。
4. `allowedSourceKeys` 去重排序：`capture:<thoughtId>` + `attempt:<attemptId>` + 经验直接依据。
5. `scopeHash = SHA-256(JSON({topicId, topicRevision, thoughtCaptureIds, thoughtAttemptIds, experienceIds, experienceSourceKeys}))`。
6. `scope` 摘要含 `topicTitle/topicName/thoughtCount/attemptCount/experienceCount/allowedSourceCount/recordCount`。

`ask-candidates` 只在 thought 成员及其直接 attempts 内调用 `searchAskCandidates`，并传入 `scope`：

- 过滤 attempts/captures 到 allowed 集合；
- 不加载 `attempt_references`/`capture_links`，不做一跳扩展；
- 候选 `matchKind` 只能是 `direct` 或 `expanded`（`expanded` 来自用户采用的扩展检索词，仍在主题 allowed scope 内），不会是 `relation`；`referenceCount` 在主题范围下为 0（不加载引用），也不参与排序；
- 经验正文不会成为候选；
- `expanded` 只是字面子串检索，不是语义搜索；模型建议不改变 scope，也不进入 prompt。

### 4.2 preview / generate

- `POST /api/ask/preview`、`POST /api/ask/queries` 新增可选 `topicId`。
- 主题存在性：404 `topic_not_found`；sourceKeys 必须全部属于 `allowedSourceKeys`，否则 400 `source_out_of_scope`。
- 经验正文 `capture:<experienceId>` 不在 allowed scope，天然被拒绝；经验依据的 attempt/capture 可以选用。
- `contextToken` 在原公式上增加 `topicId/topicRevision/scopeHash`；不传 `topicId` 时公式与旧版完全一致。
- 生成时服务端重算 token；已选 source 越界先返回 400 `source_out_of_scope`；来源/主题 scope 变化但仍有效 → 409 `context_changed`，message 明确「主题成员或来源已变化」。
- `record_queries` 不新增 topic 列；历史问答不受后续成员变化影响，重新打开时仍按发送时快照展示来源。
- prompt 仍由 `buildAskUserPrompt` 生成，只含问题、关键词、日期范围、用户确认的 records 和记录间真实引用；**不注入主题标题、探索问题、继续说明**。测试用 fake model 验证这三类文本不出现在 prompt。

### 4.3 经验依据去重

若同一条 attempt 同时属于 thought 成员（直接 attempt）和经验成员依据，`allowedSourceKeys` 用 Set 去重，`allowedSourceCount` 不重复计。测试用例 `allowedSourceCount == 2`（`capture:thought` + `attempt`）验证同一 attempt 只算一次。`ask-experiences` 的 `selectableSourceKeys` 也基于同一 scope 过滤，只返回可直接用于预览的 key。

## 5. 删除与一致性

| 操作 | 事务内行为 | 返回值 |
| --- | --- | --- |
| 删除 capture | 删除 `topic_members`；清空 `next_attempt_id` 指向其 attempts 的主题；bump 受影响主题 revision；主题保留 | `deletedTopicMembers`、`clearedTopicNext` |
| 删除 attempt | 清空引用主题并 bump revision；再删 attempt（FK 兜底） | `unfixedTopicCount` |
| attempt PATCH → cancelled | 清空引用主题并 bump revision | `clearedTopicNext` |
| 移出成员 | 删成员；如固定 attempt 属于该 capture，清空 | `clearedNext` |
| 归档主题 | 只写 `archived_at`，bump revision；成员不变 | `topic` |
| 归档 capture | 无主题操作；成员项 `archived=true` | 原 capture 接口 |
| 删除主题 | 只删 `topics`，成员级联；不删 capture/attempt/experience/schedule/reference | `deletedMembers` |

所有删除清理都放在既有删除接口的事务内，失败整体回滚。`delete-preview` 只读统计，不修改任何数据。

## 6. 导出与备份

- `GET /api/export` 升级为 `schemaVersion: 7`，在 schema 6 全部字段上增加：
  - `data.topics[]`：`id/title/exploringQuestion/continueNote/nextAttemptId/nextAttemptClearedReason/revision/archivedAt/createdAt/updatedAt`；
  - `data.topicMembers[]`：`id/topicId/captureId/memberKind/createdAt`。
- 不导出 `mutation_receipts`、`_migrations`、会话/密钥/内部指纹。
- 整库 SQLite 备份（`scripts/backup.mjs`）不需要新增代码：`topics` 与 `topic_members` 随数据库文件一起复制/恢复。测试用 SQLite backup API 复制隔离库，验证两表存在且行数与导出 `data.topics/topicMembers` 一致。
- 项目仍没有 JSON 导入；恢复流程仍是整库 SQLite 替换 + 启动自动迁移。

## 7. 前端兼容字段

前端适配层早期使用 `name`、cursor、扁平成员列表等字段。服务端在不改变主契约的前提下增加别名：

- 所有主题对象同时返回 `title` 与 `name`；创建/修改同时接受 `name`。
- `latestAttemptAt` 同时给 `lastAttemptAt`；`nextAttempt` 同时给 `captureText/createdAt/updatedAt/resultRecorded`。
- 列表/候选/尝试同时支持 `offset` 与 `cursor`，响应给 `nextCursor`。
- 详情 `members` 保持 `{thoughts,experiences}`，另给扁平 `memberList`；成员同时给 `kind/type`、`href/openHref`。
- 成员添加响应同时给 `added/existing` 与 `skipped/addedIds/skippedIds`；删除成员给 `ok/clearedNextAttempt`。
- 主题 ask-candidates 顶层展开 `AskSearchResponse`，另给 `topic:{id,name}` 与扩展 scope 字段；ask-experiences 给 `topic:{id,name}` 与 `hasPracticeResult`。

## 8. 测试

`python scripts/test_topics.py`（隔离库 `db/test-topics.sqlite`、默认端口 3220、fake model 3501；设置 `SHINIAN_BASE` 可复用已有服务）：

- 覆盖：未登录 401；CRUD；标题/说明长度；`expectedRevision` CAS 与 `revision_conflict`；`operationId` 回放/冲突；成员唯一与 `added/existing`；经验加入两个主题；候选搜索/type/cursor；尝试聚合去重/排序/结果三态/state 过滤；next-attempt 校验与取消/删除/移出清理（含持久化 clearedReason）；删除 capture 清理主题成员与固定；归档不级联；delete-preview 不删原数据；删除主题不删原记录；导出 schema 7；两个主题问答范围隔离；经验依据去重；伪造 sourceId 400；预览后成员变化被 400 `source_out_of_scope` 或 409 `context_changed` 拒绝；无模型时手动流程/预览可用；整库备份包含新表。
- 实际结果：**197 passed, 0 failed**。
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_e2e_topics.ps1`：**117 passed, 0 failed**（107 主流程 + 10 重启持久性），`scripts/test_topics_export.py` **41 passed, 0 failed**；桌面 1280×900 / 手机 390×844，含成员、尝试三态、固定下一步、重启、返回主题、局部图、主题问答、删除失效反馈、键盘与横向溢出。
- `npm run typecheck` 与 `npm run build` 通过；本轮截图见 （截图未随仓库提供）。
- 测试不会写主库；默认自启动隔离服务并清理 `db/test-topics.sqlite`，只删除明确带 `test` 的数据库。

## 9. 未验证与已知边界

- 浏览器 E2E 与重启持久性由 `scripts/e2e_topics.mjs` + `scripts/run_e2e_topics.ps1` 覆盖；截图来自隔离库合成样例。
- 真实模型未参与主题问答；使用 `fake-ask` 验证范围、prompt 与来源约束。真实模型对主题范围外的问题可能给出「证据不足」，属于预期。
- 主题问答只扩展了现有 `/api/ask`；`record_queries` 没有 topic 列，因此历史问答列表无法按主题筛选，这是一项产品边界而非遗漏。
- cursor 是 offset 编码，列表按 `updated_at` 排序；翻页期间编辑主题可能导致重复/跳过（见 §3.2）。
- 当前允许把 capture 加入已归档主题；归档主题仍出现在记录详情的主题列表（`archived=true`），是否允许加入由前端交互决定，服务端未额外拒绝。
- 主题成员上限 50、候选 limit 上限 30、尝试 limit 上限 50；没有主题搜索分页的全文索引，`q` 是参数化 `LIKE` 子串匹配。
- 并发写由 SQLite 事务与 `revision` CAS 保证；本机单人，没有多用户/权限分层。
- 未做 JSON 导入；旧备份恢复后启动自动执行 0012。
