# 拾念 SHINIAN · 「回顾后的下一步行动」接口与实现约定

日期：2026-11-13。范围：阶段回顾「下次可参考」经验 → 编辑下一步行动 → 可选加入日程 → 执行并记录结果。保留现有 review/schedule/activity/export/backup 能力。

## 1. 核心决定：复用 attempts

不新增 action 表。下一步行动就是一个 Attempt：

- `attempts.state='todo'` 表示可编辑的行动草稿；开始后由现有状态流转改为 `in_progress`。
- `attempts.step` = 用户确认后的行动标题。
- 新增可选列：`origin`、`action_description`、`estimated_minutes`、`source_review_id`、`source_experience_index`、`source_attempt_id`、`source_attempt_revision`。
- 来源关系继续写 `attempt_references`（新 Attempt → 原经验 Attempt），引用保存 `snapshot_revision` 与结果快照。
- 日程继续写 `schedule_blocks`，不重复建表。
- 删除来源 Attempt 时 `attempt_references` 按现有级联删除；`source_attempt_id` 保留为不可读 ID，页面显示「来源已删除」，不返回已删除正文。
- AI 回顾文本仍是建议，不是事实；用户保存后的 `step/action_description` 才是用户确认的行动；实际结果只来自现有 `result_text/outcome/observed_at`。

### 1.1 迁移 `0007_next_actions.sql`

```sql
ALTER TABLE attempts ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE attempts ADD COLUMN action_description TEXT;
ALTER TABLE attempts ADD COLUMN estimated_minutes INTEGER;
ALTER TABLE attempts ADD COLUMN source_review_id TEXT;
ALTER TABLE attempts ADD COLUMN source_experience_index INTEGER;
ALTER TABLE attempts ADD COLUMN source_attempt_id TEXT;
ALTER TABLE attempts ADD COLUMN source_attempt_revision INTEGER;
CREATE INDEX attempts_origin_created_idx ON attempts(origin, created_at DESC);
CREATE INDEX attempts_source_review_idx ON attempts(source_review_id);
```

既有 Attempt 自动为 `origin='manual'`。`origin` 取值：`manual` | `ai_suggestion`（后续可标记） | `review_next_action`。本轮创建下一步固定 `review_next_action`。

## 2. 公共对象

```ts
type NextAction = {
  id: string;                    // = attemptId
  captureId: string;
  title: string;                 // attempts.step
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
  capture: { id; rawText; revision; archivedAt } | null;
  sourceReview: { id; savedAt; range; contentInvalidated; sourcesChanged } | null;
  experience: { text; basis; sourceIds } | null; // 模型建议，编辑前展示
  sources: Array<{
    key; type; sourceId; attemptId; captureId; title;
    state; revision; currentRevision; changed; deleted;
  }>;
  schedules: ScheduleBlock[];
  canEdit: boolean;
};
```

`sourceReview` 只返回 `savedAt`、范围、失效标记，不复制整篇回顾。`sources` 中 `deleted=true` 时正文/结果均为 null，禁止显示已删除正文。`experience.text` 是模型正文，保留但必须标「模型推断/建议」。

## 3. API

所有写接口要求登录 session、`operationId`；更新还需要 `revision`。统一错误：
`{error, message, field?, ...}`，前端显示中文。

### 3.1 预览

`GET /api/reviews/:id/next-action-preview?experienceIndex=0`

- 回顾必须存在、`savedAt != null`、`content.experiences[index]` 存在，否则：
  - 404 `review_not_found`
  - 409 `review_not_saved`
  - 400 `invalid_experience_index`
- 从 `sources_json` 解析该 experience 的 `sourceIds`，只接受 type=`attempt` 的来源。
- 没有任何可用 attempt 来源：409 `source_unavailable`。
- 返回：
```json
{
  "review": {"id":"rev-...","savedAt":123,"range":{...},"contentInvalidated":false,"sourcesChanged":false},
  "experienceIndex": 0,
  "experience": {"text":"...","basis":"inference","sourceIds":["attempt:att-..."]},
  "sourceAttempts": [{
    "attemptId":"att-...","captureId":"cap-...","step":"...","state":"done",
    "resultText":"...","outcome":"failure","revision":2,"captureRevision":1,
    "captureText":"...","exists":true,"changed":false,"deleted":false
  }],
  "captures": [{"id":"cap-...","rawText":"...","revision":1,"archivedAt":null}],
  "defaults": {
    "captureId":"cap-...","title":"建议行动标题","description":"...",
    "estimatedMinutes":30,"suggestedDate":"2026-11-14","timezone":"Asia/Shanghai"
  },
  "contextToken":"sha256-hex"
}
```
- `defaults.title` 为 experience.text 的首句/前 60 字草稿；`description` 为剩余说明或空。服务端只提供草稿，不把建议当事实。
- `contextToken` 绑定：reviewId、savedAt、experienceIndex、captureId、captureRevision、当前存在的尝试来源 `[attemptId, revision]` 排序。客户端不能传任意 sourceIds。

### 3.2 创建

`POST /api/reviews/:id/next-actions`

```json
{
  "captureId":"cap-...",
  "captureRevision":1,
  "experienceIndex":0,
  "title":"只在 2 kHz 下复测闪烁",
  "description":"固定其他条件，只改变频率。",
  "estimatedMinutes":30,
  "contextToken":"sha256",
  "operationId":"uuid",
  "schedule": {
    "date":"2026-11-14","endDate":"2026-11-14",
    "startTime":"10:00","endTime":"10:30",
    "timezone":"Asia/Shanghai","note":"先复测一次",
    "startDisambiguation":"earlier","endDisambiguation":"earlier",
    "confirmOverlap":false,"conflictToken":null,"expectedConflictIds":[]
  }
}
```

- `schedule=null` 或 `schedule.enabled=false` → 保存为未排程行动。
- 服务端校验：
  - 回顾已保存、experience 索引合法；
  - captureId 必须是该回顾来源尝试的 capture 之一，且存在；否则 409 `capture_changed` / 404 `capture_not_found`；
  - `captureRevision` 必须与当前 capture 版本一致，否则 409 `capture_changed` + `currentRevision`；
  - `contextToken` 重算必须一致；来源 revision/存在性变化返回 409 `sources_changed`，附最新 `sourceAttempts` 和 `contextToken`；来源全删返回 409 `source_deleted`；
  - title 1–120 字，description ≤2000 字，estimatedMinutes 1–1440 或 null；
  - 时间使用现有 schedule 校验（IANA、结束>开始、跨日、DST 不存在/重复消歧）。
- 日程冲突且未确认 → 409：
```json
{
  "error":"schedule_conflict",
  "message":"与现有安排重叠",
  "conflicts":[ScheduleBlock],
  "conflictToken":"sha256",
  "requiresConfirmation":true,
  "options":{"changeTime":true,"saveUnscheduled":true,"viewConflicts":true}
}
```
- 带 `confirmOverlap=true` 但参数/冲突集合变化 → 409 `schedule_conflict_changed`，返回最新冲突与 token。
- 成功 201：
```json
{"nextAction": NextAction, "replayed": false}
```
- 同一 `operationId` 相同指纹 → 200 `{nextAction, replayed:true}`，不重复创建 attempt/reference/schedule；不同指纹 → 409 `operation_key_conflict`。
- 事务内依次创建 Attempt、所有来源 `attempt_references`、可选 `schedule_block`、`mutation_receipts target_type='next_action'`；任一步失败整体回滚。

### 3.3 读取

- `GET /api/reviews/:id/next-actions` → `{actions: NextAction[]}`。
- `GET /api/captures/:id/next-actions` → `{actions: NextAction[]}`。
- `GET /api/next-actions/:id` → `{action: NextAction}`；不存在 404 `next_action_not_found`。
- 列表按 `createdAt DESC`。来源已删除的 action 仍可读取；来源正文不返回。

### 3.4 更新

`PATCH /api/next-actions/:id`

```json
{
  "title":"...","description":"...","estimatedMinutes":45,
  "revision":1,"operationId":"uuid"
}
```

- 只有 `origin='review_next_action'` 可更新；revision CAS，冲突 409 `revision_conflict` + `current:NextAction`，前端保留草稿。
- operationId 回执 target_type=`next_action_update`；同 ID 同指纹回放，不同指纹 409。
- 不改变来源、引用、日程；日程使用现有 schedule API 添加/修改/取消。

### 3.5 日程与删除

- 创建下一步时可选加入日程；加入后的后续操作复用现有 `/api/attempts/:id/schedules`、`/api/schedules/:id`、`/api/schedules/:id/cancel`。
- 删除尝试/念头时，现有事务会级联删除日程和引用；`source_review_id` 仍在，但详情通过来源状态显示「来源已删除」。
- 导出：`schemaVersion` 升级为 3，`data.attempts` 增加上述 7 个字段；其余 captures/attemptReferences/scheduleBlocks/stageReviews 保持不变。v2 读取器忽略新增字段；v3 读取器对缺失字段使用 `manual/null`。

## 4. 错误码

`unauthenticated`、`review_not_found`、`review_not_saved`、`invalid_experience_index`、`source_unavailable`、`source_deleted`、`sources_changed`、`capture_not_found`、`capture_changed`、`invalid_title`、`invalid_description`、`invalid_estimated_minutes`、`invalid_schedule_time`、`invalid_timezone`、`nonexistent_local_time`、`ambiguous_local_time`、`schedule_conflict`、`schedule_conflict_changed`、`operation_key_conflict`、`revision_required`、`revision_conflict`、`next_action_not_found`、`not_next_action`。

## 5. 活动栏

复用现有 `ActivityEvent`，不新增事件表：
- 创建下一步：`type='attempt'`, `action='next_action_created'`, title=`从回顾创建下一步`。
- 加入日程：`type='attempt'`, `action='next_action_scheduled'`, title=`下一步加入日程`（active schedule 派生）。
- 完成并记录结果：`type='result'`, `action='next_action_result'`, title=`下一步完成并记录结果`。
- 统计仍按真实 Attempt/结果/引用计数；下一次阶段回顾自然包含。

## 6. 前端入口

- `/review/:id`：每个「下次可参考」经验显示「把这条经验变成下一步」；打开编辑面板。
- `/capture/:id`：显示该念头下的下一步行动列表。
- `/next-action/:id`：行动详情/编辑/来源状态/日程/打开尝试。
- `/schedule` 与安排详情：显示「来自回顾」badge、来源回顾链接、下一步行动链接。
- `/attempt/:id`：下一步行动的说明、预计耗时、来源回顾与来源尝试链接；完成后用现有结果表单。

## 7. 验收测试

`scripts/test_next_action.py` 覆盖：未登录 401、正常创建、operationId 幂等、来源存在/修改/删除、capture/attempt revision 冲突、非法时间/时区、跨午夜、日程冲突+确认+未排程、事务回滚、删除来源详情可读正文清洗、完成后结果、下一次回顾统计。浏览器 E2E 覆盖用户指定 12 步。
