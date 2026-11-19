# 拾念 SHINIAN · 「阶段回顾」实现记录

日期：2026-11-13
范围：`/review` 回顾页与 `/review/:id` 回顾详情、范围与统计接口、按需 AI 回顾、保存/来源状态/删除清洗、导出与备份兼容、浏览器端到端验收。
契约：[`review-api-contract.md`](./review-api-contract.md)。状态：**工程验收通过（假模型）**；真实厂商模型联调待完成（本机无可用真实 API Key）。

## 1. 交付行为

| 能力 | 实现 |
| --- | --- |
| 入口 | 顶部导航「回顾」→ `/review`；已保存回顾详情 `/review/:id` |
| 范围 | 最近 7 天 / 最近 30 天 / 自定义日期范围；本地日界 `[起始日 00:00, 结束日次日 00:00)` |
| 时间边界 | 前端提交 `from/to` 毫秒 + IANA 时区；服务端按 `from` 含、`to` 不含解释，返回 `fromIso/toIso/fromLocal/toLocal/endExclusive` |
| 实际记录 | 默认直接展示，不依赖 AI：念头、尝试、结果、引用、修改五类；可筛选、可打开原始记录 |
| 统计 | 程序按现有字段计算 9 项，`statDefinitions` 逐条给出口径；明确区分创建时间 / 结果记录时间 / 最后修改时间 |
| 历史状态 | `attempts` 只保存当前状态与最后修改时间，没有状态历史；`attemptsCurrentlyEnded` 只表示「当前状态 + 最后修改时间」，不表示实际结束时间 |
| AI 回顾 | 「帮我回顾」→ 确认区显示目标模型、范围、将发送记录，可排除；受 80 条 / 16000 字上限约束 |
| 回顾内容 | `overview` + 做过的尝试 / 记录的观察 / 关联与矛盾 / 下次可参考；每条带 `basis`（记录中的观察 / 模型推断）与真实 `sourceIds` |
| 来源 | 模型来源 ID 必须属于本次发送记录，否则 `invalid_response`；点击来源可打开原记录 |
| 保存 | 保存时间范围、统计快照、内容与来源快照；重复保存返回同一 `savedAt` |
| 来源变化 | 来源被修改 → `changed`；被删除 → 正文清洗 + `contentInvalidated`，模型正文保留 |
| 继续探索 | 经验项「参考这条经验，再试一步」→ 选当前念头 → 念头详情自动带入旧经验预览，用户确认后才生成 |
| 异常 | 空数据、未配置模型、生成中、取消、失败、重试、来源过期；模型不可用时记录与统计仍可用 |

## 2. 代码位置

- `src/db/schema.ts` + `drizzle/migrations/0005_review.sql`：`stage_reviews` 表与索引。
- `src/server/reviewTypes.ts`：服务端/前端共享的类型与上限常量。
- `src/server/reviewData.ts`：范围解析、记录/统计采集、来源实时状态、公开回顾、导出、删除清洗、启动恢复，以及 `GET /api/review/range`、`GET /api/reviews`、`GET /api/reviews/:id`、`POST /api/reviews/:id/save`。
- `src/server/reviewRoutes.ts`：稳定注册入口（re-export `registerReviewRoutes`）。
- `src/server/reviewAi.ts`：回顾 system/user prompt、Zod + 语义校验、后台生成/取消、`POST /api/review/preview`、`POST /api/reviews`、`POST /api/reviews/:id/cancel`。
- `src/server/index.ts`：注册回顾路由、启动 `markInterruptedReviews()`、删除念头/尝试时清洗回顾来源、导出 `schemaVersion=3` 增加 `stageReviews`（并保留日程与下一步行动字段）。
- `src/client/pages/ReviewPage.tsx`、`ReviewDetailPage.tsx`、`App.tsx`、`types.ts`、`api.ts`、`styles.css`。
- `src/client/pages/CaptureDetailPage.tsx`：支持 `?experience=<attemptId>&from=review`，自动打开现有「参考旧经验」预览。
- `scripts/test_review.py`、`scripts/e2e_review.mjs`、`scripts/fake_model_server.py`（review 场景）。

## 3. 数据与事务

`stage_reviews` 一行 = 一次回顾任务；`saved_at` 非空表示用户已保存。

- 创建与模型调用分离：事务内插入 `pending`，`setImmediate` 后台调用模型；成功/失败/取消均用 `WHERE status='pending'` 条件更新，迟到响应不会复活。
- `stats_json`、`coverage_json`、`sources_json`、`context_token`、配置快照在创建时写入；`content_json`、`usage_json`、`duration_ms`、`finished_at` 在完成时写入。
- 保存使用 `mutation_receipts`（`target_type='review_save'`）+ `saved_at` 双重幂等；并发下同 `operationId` 同指纹回放。
- 启动时 `pending → interrupted`，与 AI 建议一致。
- 删除尝试/念头时在现有删除事务内调用 `invalidateStageReviewSourcesForDeletedAttempts/Capture`：只保留 `{key,type,sourceId,deleted:true}`，不留下可读正文；置 `content_invalidated_at/reason`。

## 4. 统计口径（界面逐条解释）

| 字段 | 口径 |
| --- | --- |
| `capturesCreated` | `captures.created_at` 落在范围内（含已归档） |
| `capturesModified` | 创建于范围之前、`updated_at` 落在范围内；仅表示修改 |
| `attemptsStarted` | `attempts.created_at` 落在范围内；只表示开始 |
| `attemptsModified` | 创建于范围之前、`updated_at` 落在范围内；不计入新开始 |
| `attemptsCurrentlyEnded` | 当前状态 `done`/`cancelled` 且 `updated_at` 落在范围内；不表示实际结束时间 |
| `resultsRecorded` | `observed_at` 落在范围内且有结果文本/评价 |
| `resultsMissingObservedAt` | 有结果但 `observed_at` 为空，且创建或最后修改在范围内；不计入结果数 |
| `referencesCreated` | `attempt_references.created_at` 落在范围内 |
| `totalRecords` | 范围内唯一记录键数量 |

编辑旧记录不会新增 `attemptsStarted` / `resultsRecorded`（结果时间不会被改写）；只有 `*Modified` 增加。

## 5. 模型接口

- Prompt：只发送用户勾选的记录，按事件时间升序，使用 `[capture:…]` / `[attempt:…]` / `[reference:…]` 稳定 ID。
- 上限：80 条记录、16000 字符；超限返回 409 `review_too_large`，不截断、不静默丢弃。
- 校验：Zod 结构 + 每个 item 至少 1 个来源、来源必须属于本次发送、不得重复、四区块全空必须 `insufficientData=true`。
- System prompt 明确：不把修改旧记录当作新尝试/新完成；不推算历史状态；「用户完成一次练习，只能说明完成了该练习」；数据不足要说明。

## 6. 导出与备份

- 导出当前为 `schemaVersion: 3`：`data` 在原有三张业务表之外包含 `stageReviews`（只含已保存回顾，`stats/coverage/content/sources` 为结构化对象），并保留 `scheduleBlocks` 与 `attempts` 的下一步行动来源字段。
- 旧 `schemaVersion: 1/2` 文件（无 `stageReviews`/`scheduleBlocks` 或旧 attempt 字段）按空数组/manual/null 处理，读取兼容。
- 备份/恢复仍是整库文件级；迁移 `0005` 对旧库自动建表，旧备份恢复后启动自动补表。

## 7. 测试记录（本机实际运行）

```powershell
cd <repo>
npm run typecheck
npm run build
$env:PYTHONIOENCODING='utf-8'; python scripts/run_tests.py
python scripts/test_export.py
python scripts/test_backup_restore.py
# 终端 1：隔离 E2E 服务
$env:PORT="3200"; $env:DATABASE_URL="<repo>\db\e2e-review.sqlite"; `
$env:SHINIAN_MASTER_KEY_FILE="<repo>\db\e2e-review-master.key"; npm run serve
# 终端 2：假模型
python scripts/fake_model_server.py
# 终端 3：
$env:SHINIAN_BASE="http://127.0.0.1:3200"; node scripts/e2e_review.mjs
```

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（既有 chunk >500 kB 与 react-router 提示） |
| 主流程 API | 43 passed, 0 failed |
| 搜索样例 | 31 passed, 0 failed |
| 一致性 | 23 passed, 0 failed |
| AI 功能 | 138 passed, 0 failed |
| 参考旧经验 | 114 passed, 0 failed |
| **阶段回顾** | **171 passed, 0 failed** |
| 事件展示栏 | 27 passed, 0 failed |
| `run_tests.py` 合计 | 全通过（含重启持久化） |
| JSON 导出回归 | 89 passed, 0 failed |
| 备份/恢复演练 | 136 passed, 0 failed |
| 阶段回顾浏览器 E2E（1280 + 390） | **31 passed, 0 failed** |

`scripts/run_e2e_review.ps1` 会自动拉起隔离服务（3200 + `db/e2e-review.sqlite`）与假模型（3501），跑完清理，避免手工管理后台进程：

```powershell
powershell -NoProfile -File scripts\run_e2e_review.ps1
```

`test_review.py` 覆盖：时区日界（`from-1/from/to-1/to`、跨日、跨月）、修改旧记录不虚增尝试、空数据、部分缺少结果时间、81 条 `review_too_large` 与 501 条截断、预览排除与真实 prompt 校验、未配置模型、模型编造来源、取消不复活、保存/重复保存、来源修改与删除清洗、导出 `schemaVersion=2` 与旧版兼容、未知 ID、密钥不出现在响应与日志。

`e2e_review.mjs` 路径：配置模型 → 建立念头/尝试/结果/引用 → 进入回顾页看范围与统计 → 排除一条记录 → 生成回顾 → 打开来源 → 保存（含重复保存）→ 从经验项「参考这条经验，再试一步」→ 选念头 → 预览 → 确认生成 → 编辑采用 → 新尝试带来源引用 → 手机宽度复查。

## 8. 截图

- 回顾页范围与统计（桌面）（截图未随仓库提供）
- 生成的回顾内容（桌面）（截图未随仓库提供）
- 回顾详情（桌面）（截图未随仓库提供）
- 从经验进入预览（桌面）（截图未随仓库提供）
- 采用后的新尝试（桌面）（截图未随仓库提供）
- 回顾页（手机 390）（截图未随仓库提供）
- 回顾详情（手机 390）（截图未随仓库提供）
- 主库真实数据、未配置模型状态（桌面）（截图未随仓库提供）

## 9. 支持与验证范围

- **已验证对象**：仅本机 `scripts/fake_model_server.py`（`fake-review`、`fake-review-insufficient`、`fake-review-bad-source`、`fake-review-invalid-json`、`fake-review-timeout`）。
- **未验证对象**：OpenAI、DeepSeek、Ollama、任何第三方中转；本机无真实 API Key，**真实模型联调待完成**。设置页厂商地址仅为格式示例。
- 真实联调步骤：设置 → AI 模型保存真实地址/模型/Key → 测试连接 → 回顾页「帮我回顾」→ 检查回顾质量、耗时、来源可核对性；记录厂商、模型、Base URL 与日期。

## 10. 已知限制

- 范围上限 366 天、单次最多读取 500 条记录（超出只返回最近 500 条并标记 `truncated`）、单次最多发送 80 条 / 16000 字。
- 没有状态变化历史：不能回答「什么时候结束/放弃了某次尝试」，只能按当前状态 + 最后修改时间说明。
- 结果时间依赖 `observed_at`：历史上通过界面保存但未填「发生时间」的结果没有结果时间，会被列入「结果时间未知」，不计入结果数。
- 已删除来源的模型正文不会从回顾中移除（与现有 AI 建议策略一致），只清除来源正文快照并标记失效。
- 未实现回顾编辑/删除入口、回顾分页（列表上限 50 条）、按关键词检索已保存回顾。
- 单配置、单用户、本机访问；无配额/预算限制；无流式输出。
