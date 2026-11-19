# 拾念 SHINIAN v0.2 · 日程安排接口与实现约定

本文件是本轮「假设定 / 今日与周视图」的唯一实现契约。前端、服务端与测试均以此为准；如实现需要调整，先改本文件并同步。

## 1. 目标闭环

已有尝试 → 安排时间 → 首页今日安排 / 日程页今日与周视图 → 打开尝试 → 记录实际结果。安排只是「打算什么时候做」，不自动改变 Attempt.state。

## 2. 数据表 `schedule_blocks`

| 字段 | SQLite 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `sch-<时间戳>-<随机>` |
| `attempt_id` | TEXT NOT NULL | FK → `attempts.id`，ON DELETE CASCADE |
| `starts_at` | INTEGER NOT NULL | UTC 毫秒 |
| `ends_at` | INTEGER NOT NULL | UTC 毫秒，必须 > starts_at |
| `timezone` | TEXT NOT NULL | 安排时采用的 IANA 时区，例如 `Asia/Shanghai` |
| `note` | TEXT | 可选备注，trim 后 ≤ 300 字 |
| `status` | TEXT NOT NULL DEFAULT `active` | `active` \| `cancelled` |
| `revision` | INTEGER NOT NULL DEFAULT 1 | 并发控制 |
| `created_at` | INTEGER NOT NULL | UTC 毫秒 |
| `updated_at` | INTEGER NOT NULL | UTC 毫秒 |
| `cancelled_at` | INTEGER | 取消时间 |

索引：`(status, starts_at, ends_at)`、`(attempt_id, starts_at)`、`(starts_at)`。
迁移文件：`drizzle/migrations/0006_schedules.sql`；同时更新 `src/db/schema.ts` 和 `meta/_journal.json`。

`schedule_blocks` 不保存账号 ID（本机单人），不做软删除以外的物理删除；删除 Attempt/Capture 时在事务中物理删除关联行。

## 3. 时间规则

- 所有 `startsAt` / `endsAt` 持久化为 UTC epoch ms。
- 表单传输「本地日期 + 本地时间 + IANA 时区」，由服务端解析为 UTC；页面按当前显示时区格式化。
- 默认显示时区 `Asia/Shanghai`。显示时区只能从固定 IANA 列表选择，保存在浏览器 `localStorage` 的 `shinian.displayTimezone`；每个安排保留创建时的 `timezone`，不因切换显示时区而改变。
- 相邻边界允许：`10:00–11:00` 与 `11:00–12:00` 不重叠。
- 重叠判定仅针对 `status='active'`：`existing.starts_at < new.ends_at AND existing.ends_at > new.starts_at`。
- 跨日：请求可带 `endDate`（YYYY-MM-DD，默认等于 `date`）；结束 UTC 必须晚于开始 UTC，最长 7 天。跨午夜块在它覆盖的每个本地日期都展示，并标记「跨日」。
- 无效日期/时间、结束不晚于开始：400 `invalid_schedule_time`。
- 非 IANA 时区：400 `invalid_timezone`。
- 夏令时不存在时间：400 `nonexistent_local_time`，附 `zone`、`local`、`message`。
- 夏令时重复时间：若未提供 `startDisambiguation` / `endDisambiguation`（`earlier` | `later`），400 `ambiguous_local_time`，附 `zone`、`local`、`choices`；提供后按选择解析。默认 UI 先显示两个选项，不静默猜测。
- 查询按指定时区计算日界：`from` / `to` 为 YYYY-MM-DD，左闭右开；返回 `starts_at < toAt AND ends_at > fromAt` 的有效安排。单次最多 62 天。

## 4. 公共返回对象

```ts
type ScheduleBlock = {
  id: string;
  attemptId: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  note: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt: number | null;
  attempt: { id: string; step: string; state: AttemptState; captureId: string } | null;
  capture: { id: string; rawText: string } | null;
};
```

所有列表按 `startsAt ASC, id ASC` 排序。取消后的安排仍在 Attempt 的完整日程列表中返回；范围查询只返回 active。

## 5. 接口

### 5.1 范围查询

`GET /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=Asia/Shanghai`

- `from` 必填，`to` 必填（exclusive），`to > from`，跨度 ≤ 62 天。
- 返回：
```json
{
  "range": { "from": "2026-11-09", "to": "2026-11-16", "timezone": "Asia/Shanghai",
             "fromAt": 0, "toAt": 0, "fromIso": "...", "toIso": "..." },
  "schedules": [ScheduleBlock],
  "generatedAt": 0
}
```
- 错误：400 `invalid_range` / `range_too_large` / `invalid_timezone`。

### 5.2 某个尝试的全部日程

`GET /api/attempts/:attemptId/schedules`

返回 `{ schedules: ScheduleBlock[], serverNow: number }`，含 active 与 cancelled，历史保留。

### 5.3 创建安排

`POST /api/attempts/:attemptId/schedules`

```json
{
  "date": "2026-11-14",
  "endDate": "2026-11-14",
  "startTime": "10:00",
  "endTime": "11:00",
  "timezone": "Asia/Shanghai",
  "note": "先跑一次实验",
  "startDisambiguation": "earlier",
  "endDisambiguation": "earlier",
  "operationId": "uuid",
  "confirmOverlap": false,
  "conflictToken": null,
  "expectedConflictIds": []
}
```

- `operationId` 必填；重复提交相同 operationId + 相同规范化参数 → 返回 `{ schedule, replayed: true }`，不新增行。
- 同一 operationId 不同参数 → 409 `operation_key_conflict`。
- 首次发现重叠 → 409：
```json
{
  "error": "schedule_conflict",
  "message": "与现有安排重叠",
  "conflicts": [{ "...ScheduleBlock" }],
  "conflictToken": "sha256-hex",
  "requiresConfirmation": true
}
```
- 用户明确继续时，带 `confirmOverlap: true`、上次的 `conflictToken`、`expectedConflictIds`。服务端按本次参数重新核对：
  - 冲突集合、冲突对象的 revision/updatedAt 与 token 不一致 → 409 `schedule_conflict_changed`，返回最新 `conflicts` / `conflictToken`，要求再次确认；
  - 一致 → 事务插入并写 `mutation_receipts`（targetType `schedule`）。
- 无冲突时忽略确认字段直接创建。
- 201 返回 `{ schedule, replayed?: false }`；replay 返回 200/201 均可，前端按 body 处理。

### 5.4 修改安排

`PATCH /api/schedules/:id`

Body 同创建（去掉 operationId），必须带 `revision`；可改日期、时间、时区、备注。仅 active 可改。
- revision 不匹配 → 409 `revision_conflict`，body 含 `current: ScheduleBlock`；前端保留草稿。
- 重叠流程同创建（`confirmOverlap` / `conflictToken` / `expectedConflictIds`）。
- 成功 revision+1，返回 `{ schedule }`。

### 5.5 取消安排

`POST /api/schedules/:id/cancel` body `{ revision }`

- 仅取消本次安排：`status='cancelled'`、`revision+1`、`cancelled_at=now`，不修改 Attempt。
- revision 不匹配 → 409 `revision_conflict`，含 `current`。
- 重复取消同一已经取消的安排 → 409 `already_cancelled`（或 revision_conflict），不得重复写。

### 5.6 Attempt 结束/放弃时的未来安排

扩展 `PATCH /api/attempts/:id`：
- 当 `state` 变为 `done` 或 `cancelled`，且存在 `status='active' AND starts_at > now` 的未来安排：
  - 未带 `futureScheduleAction` → 409：
```json
{
  "error": "future_schedules",
  "message": "这个尝试还有未来安排",
  "futureSchedules": [ScheduleBlock],
  "currentRevision": 3
}
```
  - 带 `futureScheduleAction: "keep"` → 保留全部，正常保存状态；
  - 带 `futureScheduleAction: "cancel"` → 在同一事务中取消全部未来安排并保存状态；
  - 返回 `{ attempt, cancelledScheduleCount }`。
- 无未来安排时行为不变。`futureScheduleAction` 仅对 done/cancelled 生效。

### 5.7 删除预览与删除

- `GET /api/captures/:id/delete-preview` 增加 `scheduleCount`（全部关联安排，含 cancelled）。
- `DELETE /api/captures/:id` 事务内先删 `schedule_blocks`（按 attempt ids），响应增加 `deletedSchedules`。
- 新增 `GET /api/attempts/:id/delete-preview`：`{ attemptId, scheduleCount, activeScheduleCount, referencesFromAttempts, referencesToAttempts }`。
- `DELETE /api/attempts/:id` 事务内删除关联日程，响应增加 `deletedSchedules`。

### 5.8 导出

`GET /api/export` 在当前版本为 `schemaVersion: 3`，`data` 包含 `scheduleBlocks`（另有 `stageReviews` 与 `attempts` 的下一步行动来源字段），字段：

```ts
{ id, attemptId, startsAt, endsAt, timezone, note, status, revision,
  createdAt, updatedAt, cancelledAt }
```

兼容：v2 在 v1 上纯增量增加 `scheduleBlocks`/`stageReviews`；v3 在 v2 的 `attempts` 上增加下一步行动来源字段。v1/v2 读取器应忽略未知数组/字段；v3 读取器遇到缺失 `scheduleBlocks`/`stageReviews` 按 `[]`、缺失 attempt 新字段按 `origin='manual'` 与 null 处理。导出仍不含 accounts / mutation_receipts / AI / 密钥。

## 6. 并发与事务

- 所有创建/修改/取消的重叠检查与写入在同一 SQLite 事务中。
- 创建使用 `mutation_receipts` 幂等；receipt 写入与 schedule 插入同事务。
- 修改/取消使用 revision CAS；冲突返回当前对象，不覆盖用户草稿。
- 尝试状态与未来安排取消同事务。
- 删除 Capture/Attempt 与日程、引用清理同事务。

## 7. 前端路由与交互

- 新增 `/schedule`：今日/本周视图，上一周、下一周、回到今天；手机宽度为纵向列表 + 易点按日期切换。
- 首页快速记录下方增加「今天的安排」轻量列表，按 startsAt 排序；每项显示时间范围、尝试名称、状态、打开入口；空状态有「安排一个时间」入口。
- 尝试详情增加「安排时间」入口、未来/全部日程列表，可新增、编辑、取消；显示安排时区与「已过安排时间」。
- 日程详情弹层：时间、时区、备注、所属尝试（链接）、原始念头（链接）、修改、取消安排；明确区分「取消安排」「放弃尝试」「删除记录」。
- 时间表单：日期、开始、结束、可选备注；跨日开关/结束日期；字段级错误；冲突列表 + 「仍然保存」；服务端新冲突时刷新列表，用户需再次确认。
- 状态标签继续用 `STATE_LABEL`；已过安排时间仅由 `endsAt < now` 推导，不改变状态。

## 8. 验收最低集

1. 已有 Attempt 创建 1+ 个安排；重复 operationId 只有一条；同 operationId 改参数 409。
2. 首页今日列表与周视图对同一天返回同一组有效安排，时间一致。
3. 修改、取消、历史保留。
4. 相邻时段成功；重叠 409；确认后成功；确认期间新增冲突会再次 409。
5. 跨午夜在两天都显示；周界（周日/周一）正确；时区切换显示正确；Asia/Shanghai 与 DST 时区解析。
6. 双窗口 revision 冲突 409 且草稿保留。
7. done/cancelled 时未来安排 keep/cancel 结果与选择一致。
8. 删除预览计数、事务删除。
9. 导出 v3、迁移、备份恢复后安排及关联可读可用。
10. 既有手动、AI、经验复用、回顾接口回归。
