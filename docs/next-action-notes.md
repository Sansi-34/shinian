# 拾念 SHINIAN · 「回顾后的下一步行动」实现记录

日期：2026-11-13
范围：阶段回顾「下次可参考」经验 → 编辑下一步行动 → 可选加入日程 → 打开尝试执行 → 记录真实结果。保留既有回顾、日程、动态、导出与备份能力。

## 1. 产品流程

1. 打开已保存的阶段回顾详情 `/review/:id`。
2. 在「下次可参考」的一条经验上点「把这条经验变成下一步」。
3. 服务端根据回顾内容与 `sources_json` 重新读取来源，返回预览：来源经验（模型建议）、当前可用念头、来源尝试的当前状态/版本、默认标题/说明/预计耗时/计划日期。
4. 用户在面板中修改标题、说明、预计耗时；选择念头；选择是否加入日程及日期/开始/结束时间。
5. 点「保存下一步」：
   - 事务内创建一个 `attempts` 行（`origin='review_next_action'`, `state='todo'`），即可执行行动草稿；
   - 为仍存在的来源尝试创建 `attempt_references`（保存 `snapshot_revision` 与结果快照）；
   - 如加入日程，同时创建 `schedule_blocks` 行；
   - 写 `mutation_receipts`，`operationId` 重复提交回放同一结果。
6. 成功后提供「查看下一步」`/next-action/:id` 与「进入尝试」`/attempt/:id`。
7. 在尝试详情按现有流程开始、完成并填写实际观察/评价/发生时间；结果只来自用户输入。
8. 下一次阶段回顾按现有统计口径把该 Attempt、结果和引用计入真实记录。

入口：
- 回顾详情经验项「把这条经验变成下一步」；
- 念头详情「下一步行动」列表；
- 日程页/安排详情的「来自回顾」与「下一步行动」；
- 尝试详情的下一步上下文。

## 2. 数据设计：复用 attempts，不新增 action 表

现有 `attempts` 已能表达「可执行的一步、状态、真实结果」，因此不新建重复的 action 表。只增加最小来源/说明字段（迁移 `0007_next_actions.sql`）：

| 字段 | 含义 |
| --- | --- |
| `origin` | `manual` / `ai_suggestion` / `review_next_action`；既有行默认 `manual` |
| `action_description` | 用户确认的行动说明（≤2000 字） |
| `estimated_minutes` | 预计耗时（1–1440 分钟，可空） |
| `source_review_id` | 来源阶段回顾 ID |
| `source_experience_index` | 来源经验在 `content.experiences` 中的索引 |
| `source_attempt_id` | 主要来源尝试 ID（多来源时取排序首个仍存在来源） |
| `source_attempt_revision` | 创建时主要来源尝试 revision |

索引：`(origin, created_at DESC)`、`(source_review_id)`。

关系：
- `attempt_references`：新行动 → 每条仍存在的来源尝试；保留 `snapshot_result_text` 和 `snapshot_revision`。
- `schedule_blocks`：可选的计划时间；一个行动可有多段安排，沿用现有取消/历史/冲突规则。
- `stage_reviews`：只读来源；不把 AI 回顾正文复制进行动。行动详情通过 `source_review_id` 读取当时的经验条目和来源状态。

### 区分四类信息

| 信息 | 存储/展示 |
| --- | --- |
| AI 建议 | 回顾 `content.experiences`，界面标「模型推断/建议」 |
| 用户确认后的行动 | `attempts.step` + `action_description` + `estimated_minutes`，由用户编辑保存 |
| 实际开始的尝试 | `attempts.state` 从 `todo` → `in_progress`（现有状态按钮） |
| 真实结果 | `attempts.result_text` / `outcome` / `observed_at`，只由用户结果表单写入 |

## 3. 状态流转

```text
AI 回顾经验（只读建议，不是事实）
  └─ 用户编辑并保存 → Attempt(todo, origin=review_next_action)  ← 下一步行动
       ├─ 可选 schedule_block(active)（可取消，不改变行动状态）
       ├─ 用户开始 → in_progress
       ├─ 用户结束 → done（可填写 resultText/outcome/observedAt）
       └─ 用户放弃 → cancelled（现有未来安排保留/取消确认）
```

- 行动草稿可以未排程；之后可在 `/next-action/:id` 或尝试详情用现有 schedule API 添加安排。
- 「已过安排时间」只是时间派生提示，不改变 Attempt 状态。
- 删除行动（尝试）或所属念头沿用现有删除预览与事务；来源引用按外键级联删除。

## 4. 幂等策略

创建 `POST /api/reviews/:id/next-actions`：

- 必填 `operationId`；服务端把 operationId + 完整规范化参数（review、experienceIndex、captureId/captureRevision、title/description/estimatedMinutes、schedule 参数与确认字段）做 SHA-256 指纹。
- 同 operationId + 同指纹 → 返回原行动 `replayed:true`，不新增 Attempt / reference / schedule。
- 同 operationId + 不同参数 → 409 `operation_key_conflict`。
- 回执、Attempt、全部 References、可选 Schedule 在同一个 better-sqlite3 事务中写入；任何一步失败整体回滚。
- 更新 `PATCH /api/next-actions/:id` 同样使用 `revision` CAS + `operationId` 回执（`target_type='next_action_update'`）。

## 5. 来源失效策略

- 预览/保存都只从服务端 `stage_reviews.sources_json` 的 `experience.sourceIds` 解析来源；客户端不能提交任意来源 ID。
- `contextToken` 绑定 reviewId、savedAt、experienceIndex、captureId/captureRevision、当前存在来源的 `[attemptId, revision]`。
- 预览后来源被修改或删除 → 409 `sources_changed`，返回最新 `sourceAttempts` 与 `contextToken`，前端保留草稿并要求再次确认。
- 来源全部删除 → 409 `source_deleted` / `source_unavailable`，不创建行动。
- 行动创建后来源被删除：
  - `attempt_references` 按现有外键级联删除；
  - `source_attempt_id` 仅作为不可读 ID 保留；
  - `GET /api/next-actions/:id` 的 `sources[].deleted=true`，`title/state/resultText` 不返回；
  - 页面显示「来源已删除」，不显示已删除来源正文；模型回顾正文按既有阶段回顾策略保留并标记失效。
- 来源被修改：`sources[].changed=true`，显示当前版本；不偷偷改写已有行动的历史来源关系。
- 删除念头/尝试时，回顾来源清洗逻辑继续执行；下一步详情仍可读取，但来源正文不返回。

## 6. 日程冲突策略

创建行动时若带 schedule：

- 使用现有 `parseScheduleInput`：IANA 时区、结束>开始、跨日、最多 7 天、DST 不存在/重复时间消歧。
- 与所有 active `schedule_blocks` 做交集检查；相邻端点不算重叠。
- 冲突返回 409 `schedule_conflict`，包含冲突对象、`conflictToken`、`options`：
  - `changeTime`：修改时间后重试；
  - `saveUnscheduled`：不创建日程，只保存行动（`schedule=null`）；
  - `viewConflicts`：打开日程页查看冲突对象。
- 用户明确「仍然保存」时带 `confirmOverlap=true` + `conflictToken` + `expectedConflictIds`；服务端按本次参数和冲突对象 revision/updatedAt 重新计算 token。冲突集合变化 → 409 `schedule_conflict_changed`，要求再次确认。
- 行动、引用、日程在同一个事务中创建；冲突确认失败不会留下半个行动。

## 7. 接口与代码位置

- 契约：[`next-action-api-contract.md`](./next-action-api-contract.md)
- 服务端：
  - `src/server/nextActionService.ts`：预览、contextToken、事务创建、读取、更新、来源状态。
  - `src/server/nextActionRoutes.ts`：6 个路由。
  - `src/db/schema.ts`、`drizzle/migrations/0007_next_actions.sql`。
  - `src/server/index.ts`：路由注册、Attempt 新字段、导出 v3。
  - `src/server/activity.ts`：下一步创建/加入日程/完成结果三类派生事件。
- 前端：
  - `src/client/components/NextActionEditor.tsx`、`src/client/pages/NextActionPage.tsx`。
  - `ReviewPage.tsx`/`ReviewDetailPage.tsx`：经验按钮与已创建列表。
  - `CaptureDetailPage.tsx`、`AttemptDetailPage.tsx`、`SchedulePage.tsx`、`ScheduleDetailModal.tsx`。
  - `types.ts`、`api.ts`、`styles.css`、`App.tsx`。

主要接口：

| 方法 | 路径 |
| --- | --- |
| GET | `/api/reviews/:id/next-action-preview?experienceIndex=` |
| POST | `/api/reviews/:id/next-actions` |
| GET | `/api/reviews/:id/next-actions` |
| GET | `/api/captures/:id/next-actions` |
| GET | `/api/next-actions/:id` |
| PATCH | `/api/next-actions/:id` |

## 8. 活动栏

不新增事件表，派生展示：
- `next_action_created`：从回顾创建下一步；
- `next_action_scheduled`：下一步加入日程（active schedule 派生，取消后事件消失）；
- `next_action_result`：下一步完成并记录结果。

仍复用现有 `ActivityEvent.type='attempt'` / `'result'`，下一次阶段回顾按真实 Attempt/结果/引用统计。

## 9. 导出与备份

- 导出 `schemaVersion: 3`，`data.attempts` 增加 7 个来源/说明字段；`scheduleBlocks`、`stageReviews` 保持 v2 形态。
- 兼容：v2 读取器忽略新增 attempt 字段；v3 读取器对缺失字段默认 `origin='manual'`、其余 null。
- 备份/恢复仍为整库 SQLite；`0007` 对旧库自动加列，旧 Attempt 默认 manual。备份脚本会校验 `schedule_blocks` / `stage_reviews` 是否存在并计数；恢复后 next action、引用、日程继续可读。

## 10. 测试结果（本机实际运行，2026-11-13）

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（无输出） |
| `npm run build` | 通过（仅既有 chunk >500 kB 与 react-router "use client" 警告） |
| `python scripts/run_tests.py` | **840 passed, 0 failed**（重启持久化含下一步/引用/日程） |
| 其中 `test_next_action.py` | **130 passed, 0 failed** |
| `python scripts/test_export.py` | **89 passed, 0 failed**（schemaVersion 3） |
| `python scripts/test_backup_restore.py` | **169 passed, 0 failed**（0007 迁移兼容） |
| `node scripts/e2e_next_action.mjs` | **31 passed, 0 failed**（Chrome 1280×900 / 390×844） |
| 阶段回顾浏览器 E2E | **31 passed, 0 failed**（回归） |

`test_next_action.py` 覆盖：未登录 401、预览/保存状态/非法 experienceIndex、正常创建（排程/未排程）、operationId 幂等与改参 409、更新 revision CAS、预览后来源修改/删除、capture revision 冲突、非法标题/说明/耗时/时间/时区/DST、跨午夜、日程冲突 token 与确认变化、事务回滚无残留、完成行动后结果、下一次回顾统计包含 attempt/result/reference、导出 v3、来源删除清洗。

浏览器 E2E 路径：已保存回顾详情 → 经验「变成下一步」→ 修改标题/说明/耗时/日期/时间 → 加入日程 → 保存 → 日程页找到 → 打开行动 → 进入尝试 → 保存实际结果 → 回顾详情确认行动/尝试/结果/引用 → 手机 390 无横向溢出。

- `next-action-01-review-detail-desktop.png` … `next-action-08-review-records-desktop.png`（桌面）
- `next-action-09-review-detail-mobile.png` … `next-action-12-schedule-mobile.png`（390px）

**真实模型**：本机无可用真实厂商 API Key，未执行真实模型联调；AI 回顾和「下次可参考」内容均来自 `scripts/fake_model_server.py` 的假模型，只验证流程、来源约束和界面，不代表真实模型建议质量。真实联调需在 `/settings/ai` 配置真实模型后按上述路径人工核对。

## 11. 已知限制

- 下一步行动只从**已保存**的阶段回顾创建；未保存回顾需先保存。
- AI 回顾文本只作为建议，不自动创建行动；真实结果必须由用户填写。
- 已删除来源不保留正文快照，详情显示来源已删除；这是有意行为。
- 多来源经验只把首个仍存在来源写入 `source_attempt_id` 摘要字段，完整来源列表仍通过 `sources` 返回。
- 行动创建面板暂不提供表单内跨日开关；跨日安排可在创建后于 `/schedule` 或安排详情修改。服务端接口支持跨日。
- 活动栏的「下一步加入日程」随 active 日程派生，取消安排后该事件不再显示（历史状态不在本应用保存）。
- 未实现 AI 自动排程、重复下一步、提醒/推送；真实厂商模型未联调（本机无真实 API Key）。
- 未在真实手机、Firefox、Safari 上验证；浏览器验收为本机 Chrome 无头 1280×900 / 390×844。
