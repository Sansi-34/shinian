# 经验笔记实现记录（第一版）

本轮目标：把「问我的记录 → 选一条观点 → 记成经验 → 在搜索 / 链接 / 反链 / 局部图中找到 → 参考它试一步 → 记录结果 → 回来修订」做成一条真正可走通的闭环。

结论：这条路径现在可以在隔离数据库中完整走通；主库 `db/shinian.sqlite` 的 3 条用户念头保持不变，且已具备经验三表与 `captures.kind`。

## 1. 上一轮「问我的记录」核实结果

| 检查项 | 实际结果 |
| --- | --- |
| 页面与路由 | `/ask`、`/ask/:queryId` 已接通；问题、候选选择、发送预览、回答、历史都能读写 |
| 来源链接 | 回答观点的来源条目可打开 `/attempt/:id` 或 `/capture/:id`；`sourceIds` 使用原始记录的稳定 ID |
| 局部图入口 | 统一使用 `/graph?focus=<type>:<id>`，经验沿用同一参数 |
| 手动链接 | 进入现有 `capture_links`，出现在链接面板、反链和图谱 `related` 关系里 |
| 返回问答保留 | 问答记录保存在 `record_queries`，重新打开问题、选择和回答仍在 |
| 来源更新/删除 | 来源修改显示「有更新」；删除后清空快照并标记 `answerInvalidated`，不展示被删正文 |
| 直接阻断问题 | `GraphPage.tsx` 缺少 `hideOrphans`、`changeLocalDepth`、`isEmpty/isFilteredEmpty`，会造成页面运行期崩溃或局部图深度按钮无效；已补齐 |
| 验收 | `python scripts/test_ask.py` 独立运行 **228 passed / 0 failed** |

以上属于前置修复，本轮没有借机重构问答模块。

## 2. 关键设计决策

**为什么复用 `captures` 而不是另建知识库**

经验需要一个稳定实体承接现有的手动链接、图谱、归档、删除级联、搜索和导出。把经验放成 `captures` 的一行（`kind='experience'`，正文 `raw_text` 存「我的理解」）后，这些链路全部自然复用；只在小型扩展表里放经验特有字段。没有引入第二套知识库、图数据库或向量库。

- `experience_notes`：标题、出处、模型依据、条件、限制、待修订状态。
- `experience_sources`：每条依据的稳定 key、类型、采用时版本与正文/结果快照。
- `experience_attempts`：引用经验的后续尝试、采用时版本/标题/正文、勾选的依据 key。`experience_capture_id` 故意不设 FK：删除经验后仍保留「当时的采用上下文」，但正文会清空。

`capture_id` 稳定，所以修改经验标题不会破坏任何链接、反链或局部图 URL。

## 3. 实际改动

### 数据与迁移

- 新增 `drizzle/migrations/0011_experience_notes.sql`
  - `captures.kind TEXT NOT NULL DEFAULT 'thought'`，旧记录自动回填为念头；
  - 索引 `captures_kind_created_idx`；
  - 三张经验表及索引；`experience_sources(experience_id, source_key)` 唯一；
  - 不重建、不清空任何已有表。
- `src/db/schema.ts`：新增 `kind`、三张表、类型导出和 `ALL_TABLES`。
- 迁移执行器沿用 `src/db/db.ts`：按文件名顺序执行、`--> statement-breakpoint` 分段、记录到 `_migrations`。

### 服务端

- `src/server/experienceTypes.ts`：公开类型与长度限制（标题 120 / 理解 4000 / 条件 2000 / 限制 2000 / 最多 8 条来源）。
- `src/server/experienceService.ts`：列表、详情、两个草稿、创建、修订、来源补选、参考经验创建尝试、删除预览、来源失效清洗、搜索、导出辅助。
- `src/server/experienceRoutes.ts`：注册经验读写、两个草稿和搜索路由。
- `src/server/index.ts`：
  - captures 默认只返回 `kind='thought'`，支持 `kind=all|experience`；
  - capture 删除预览/删除加入 `affectedExperiences` 与经验来源清洗；
  - attempt 详情加入 `experienceRef`；
  - attempt 删除清洗经验来源；
  - 总搜索返回 `experiences`；
  - 导出升级 `schemaVersion: 6`。
- `src/server/askData.ts`：经验不进入问答事实证据，避免「经验摘要 + 原始来源」被算成两份独立证据。
- `src/server/graphRoutes.ts`：`experience` 节点、`evidence/used/context` 关系、统计与搜索字段。
- `src/server/linkRoutes.ts`：节点 `kind/title/href`，反链支持经验标题与 `otherKind/otherTitle`。

### 前端

- `src/client/components/ExperienceEditor.tsx`：标题、我的理解、条件、限制、来源增删/补选、来源状态、模型出处、无实践结果提示、`operationId` 幂等、409 冲突载入最新版本、Esc 取消。
- `src/client/components/CaptureLinksPanel.tsx`：正链/反链/搜索候选/关联/解除，标注经验类型。
- `src/client/pages/ExperiencesPage.tsx`：使用中/已归档、筛选、空状态、两个入口说明、卡片统计。
- `src/client/pages/ExperienceDetailPage.tsx`：先理解、再条件/限制、依据与局部图、后续尝试与采用版本、「参考它，试一步」、关联念头、归档、删除预览、修订入口。
- `src/client/pages/AskAnswer.tsx`：单条观点「记成经验」，使用 `answer.points` 原始索引。
- `src/client/pages/AttemptDetailPage.tsx`：「整理成经验」、经验上下文、删除影响、结果表单测试标记。
- `src/client/pages/CaptureDetailPage.tsx`：经验访问重定向到 `/experience/:id`，删除预览展示受影响经验。
- `src/client/pages/SearchPage.tsx`：经验分组与「全部/念头/尝试/经验」筛选。
- `src/client/pages/GraphPage.tsx`：经验节点/关系/统计/图例；修复局部图深度按钮与空状态。
- `src/client/pages/HomePage.tsx`：「我整理的经验」区（最多 5 条），不新增顶级导航。
- `src/client/App.tsx` / `main.tsx` / `experience-notes.css`：两条路由、样式与手机布局。

## 4. 行为规则

### 两个入口

1. **问答单条观点**：只预填该观点的文字、observation/inference 类型、条件与它实际使用的来源；不复制整份回答，不把所有检索候选关联进来。
2. **有结果的尝试**：只展示实际结果并预填标题；「我的理解」留空，用户自己写；未配置模型也能用。

### 保存与出处

- 取消不创建；只有点击保存才写业务记录。
- 至少一条仍可访问的来源，否则 `422 source_required`。
- 模型推断即使被用户保存，仍保留 `by='model'`、`modelBasis='inference'` 和「只表示愿意保存，不代表已证实」。
- 依据只有念头、没有实际结果：`hasPracticeResult=false`，界面显示「尚无实践结果支持」。
- 不生成可信度百分比、成功次数评分或「已证实」标签。

### 引用与版本

- 后续尝试复用现有 Attempt；创建时保存 `adoptedVersion`、`adoptedTitle`、`adoptedUnderstanding`。
- 只有用户勾选的原始尝试进入 `attempt_references`；不是所有来源自动变成引用。
- 修订后，既有尝试仍能看到当时采用的版本与正文。
- 新结果与旧理解不一致时，两者分别保存，界面并列展示，不自动裁决。

### 来源更新与删除

- 更新：快照保留、`changed=true`，提示「来源有更新，建议重新核对」；保存修订时刷新快照。
- 删除：来源快照清空并标 `deleted=1`，接口、搜索、详情、导出都不再返回被删正文。
- 模型整理正文：保守清空并 `needsRevision=true`。
- 用户整理正文：保留，只提示核对。
- 后续尝试：保留尝试与结果，清空其经验采用正文并标 `deleted=1`。
- 删除经验：不删除来源，不删除后续尝试结果。

## 5. 迁移与兼容

### 从旧库升级

1. 备份：`node scripts/backup.mjs --db <库> --out <目录>`（在线一致性快照，`integrity_check=ok`）。
2. 启动服务：`src/db/db.ts` 自动执行 `0011_experience_notes.sql`。
3. 旧 `captures` 全部回填 `kind='thought'`；旧页面默认只看到念头，行为不变。
4. 旧 JSON 导出（v1–v5）没有 `experienceNotes` 等字段；v6 读取器按空数组处理。项目当前**没有 JSON 导入**功能，恢复仍是整库 SQLite 备份。
5. 主密钥 `db/master.key` 不在数据库内；恢复数据库时必须同时保留同一个主密钥，否则已保存的 API Key 无法解密。

### 本轮实测

- 用主库在线备份制作了一份「缺少 0011」的旧库副本：删除三张经验表、删除 `_migrations` 记录、移除 `captures.kind`。
- 启动服务后自动应用 0011：3 条原始念头仍在，`kind` 全部为 `thought`，三张表和索引重新出现，`_migrations` 有 `0011_experience_notes.sql`。
- 主库现状（只读检查）：3 条用户念头仍在（`我想睡觉`、`调光时想避免肉眼可见闪烁，需要选频率`、`PWM 低占空比时 LED 会闪`），`kind='thought'`，0011 已应用。

### 导出 v6

```json
{
  "schemaVersion": 6,
  "appVersion": "0.1.0",
  "exportedAt": "…",
  "data": {
    "captures": [{ "id": "…", "rawText": "…", "kind": "thought", "…": "…" }],
    "attempts": [],
    "attemptReferences": [],
    "captureLinks": [],
    "scheduleBlocks": [],
    "stageReviews": [],
    "researchRuns": [],
    "researchSources": [],
    "experienceNotes": [],
    "experienceSources": [],
    "experienceAttempts": []
  }
}
```

兼容口径：v6 读取器对缺失的经验三表按空数组处理；旧读取器可忽略新增字段。数据库备份仍为整库文件，新增表随整库一起备份/恢复。

## 6. 验证结果

环境：Windows 本机，隔离库 `db/verify-experience-note.sqlite`，端口 `3110`，系统时间基准 2026-11-16。

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | 退出码 0 |
| 构建 | `npm run build` | 成功（仅 chunk >500 kB 与 react-router `"use client"` 提示） |
| 经验 API | `python scripts/test_experience_note.py` | **69 passed / 0 failed** |
| 经验浏览器 E2E | `node scripts/e2e_experience_note.mjs` | **34 passed / 0 failed** |
| 主流程回归 | `python scripts/test_api.py` | 43 / 43 |
| 搜索回归 | `python scripts/test_search.py` | 31 / 31 |
| 一致性/链接回归 | `python scripts/test_consistency.py` | 23 / 23 |
| 问我的记录回归 | `python scripts/test_ask.py` | 228 / 228 |
| JSON 导出回归 | `python scripts/test_export.py` | 89 / 89（已把旧断言从 v4 更新到 v6+；当前导出为 7） |
| 备份恢复演练 | `python scripts/test_backup_restore.py` | 177 / 177（导出断言更新到 v6+，并检查经验三表存在） |
| 备份恢复 | `node scripts/backup.mjs` + 恢复库启动 | 经验 15 / 来源 15 / 后续尝试 7 全部保留；列表、详情、搜索、局部图均 200 |
| 旧库迁移 | 缺少 0011 的副本启动 | 3 条念头保留、kind 回填、三表与索引建立 |
| 旧浏览器脚本 | `scripts/e2e_browser.mjs` 的导出断言 | 已从 `schemaVersion===1` 更新为 `===6`；**未重跑**该长流程 |

新增测试覆盖（节选）：未登录 401、观点索引越界、无来源 422、重复 operation 幂等、尝试草稿不预填理解、问答观点只预填该观点及其实际来源并保存、手动关联与反链 kind/href、局部图 `evidence/related`、改标题链接仍有效、旧 revision 409、从经验创建尝试幂等且只有勾选依据进引用、结果保存后经验详情可见、修订保留旧采用版本、新旧理解并存、来源 changed/删除、用户正文保留、模型正文清空、搜索不泄露已删正文、删除经验不删来源、尝试结果保留、导出 v6+（当前 7）、归档/恢复、手机编辑保存、手机从经验创建尝试并进入结果表单、手机记录结果后详情可见、键盘 Esc。另由 `scripts/e2e_v06_paths.mjs` 在隔离库实际跑通路径 A/B **45 passed / 0 failed**，`scripts/test_v06_reliability.py` **32 passed / 0 failed**（含重启、幂等、编辑冲突、来源删除、修订版本与备份）。

本轮修复的真实缺陷：

1. `GraphPage` 缺少 `hideOrphans`、`changeLocalDepth`、`isEmpty/isFilteredEmpty`（运行期崩溃/局部图深度按钮失效）。
2. `markExperiencesNeedRevision` 的 SQL 用双引号 `raw_text = ""`，SQLite 报 `no such column: ""`，导致删除尝试 500、事务回滚；改为单引号 `raw_text = ''`。
3. `experienceDeletePreview.sourceCount` 只统计未删除来源，删除预览显示 0；改为总来源数。
4. 来源列表与尝试列表被误设为横向 flex，桌面端来源标题/结果挤在一排；改为纵向列表，编辑器操作区改为 sticky。
5. 移动端编辑器关闭按钮位置错误、保存按钮容易滚出视野；补 `modal-head` 布局与 sticky 操作区。

## 7. 可以照着操作的体验路径

**准备**：本机启动 `npm run serve`，打开 `http://127.0.0.1:3000`，用本机用户名登录。想完整体验示例，可在隔离库中按测试脚本预置数据，不影响主库。

1. **形成理解**
   1. 进入「问答」，提出一个关于睡前手机的问题并生成回答。
   2. 在回答中找到「睡前把手机放到书桌上，比放在枕边更容易停止刷手机」这条观点。
   3. 点观点旁的「记成经验」。面板只带入这一条观点和它实际引用的来源；补写「我的理解」，可补「适用条件」「限制」。
   4. 检查来源可打开；点保存。页面给出经验链接。
2. **找到它**
   1. 打开「搜索」，输入「书桌」；把筛选切到「经验」，看到标题、摘要和命中原因。
   2. 点进经验详情：先看「我的理解」，再看依据记录与来源状态。
   3. 点「局部图」，经验作为中心节点出现；详情里的关系写明「依据这条记录 / 参考这条经验再试 / 所属念头」，手动链接显示为「关联」。
   4. 打开依据的原始尝试，核对真实结果；从尝试详情可看到反向引用。
   5. 在经验详情「关联的念头」搜索并关联另一条念头；回列表、改经验标题，链接与反链仍在。
3. **再试一步**
   1. 经验详情点「参考它，试一步」，选择所属念头（默认当前上下文），编辑行动标题/说明，勾选要引用的原始尝试，保存。
   2. 去尝试详情安排时间或直接执行；填写「实际结果」和结果类型并保存。
   3. 回到经验详情：能看到这次实践、结果、采用时版本和「根据这次结果修订经验」。
4. **修订理解**
   1. 点「根据这次结果修订经验」；面板展示这次结果，保留原理解作为参照。
   2. 补充条件、限制或反例后保存。新旧理解并存；旧尝试仍显示当时采用的版本。
5. **维护**
   1. 来源被修改后，详情出现「来源有更新，建议重新核对」；保存修订会刷新快照。
   2. 删除来源前，删除预览列出受影响经验；删除后模型正文清空/用户正文保留，后续尝试结果仍在。
   3. 删除经验不删来源；归档只移出默认列表。

**手机**：在 390×844 宽度可打开经验详情、编辑并保存、查看来源、创建尝试；键盘用户可用 Tab 进入各按钮，Esc 取消编辑。

**无需模型**：第 2 个入口（从有结果的尝试整理）、经验管理、搜索、链接、图谱和创建尝试都不调用模型；只有问答入口需要已有的问答回答。

## 8. 截图

均来自隔离库，不代表主库数据：

- （截图未随仓库提供）：经验详情桌面布局。
- （截图未随仓库提供）：从问答单条观点保存经验后的提示。
- （截图未随仓库提供）：经验局部图与关系说明。
- （截图未随仓库提供）：新尝试结果写入。
- （截图未随仓库提供）：修订后新旧理解并存。
- （截图未随仓库提供）：搜索结果中的经验分组。
- （截图未随仓库提供）：手机编辑面板（固定保存按钮）。
- （截图未随仓库提供）：手机保存后的详情。

## 9. 边界与未验证事项

- 未做 3D 图谱、自动批量总结、自动合并经验、向量检索、MCP、提醒推送、积分或新 Agent。
- 没有完整版本管理系统；只保存「采用时版本 + 标题 + 正文」，不做逐版 diff/回滚。
- 没有 JSON 导入；不能把 JSON 导出直接导入另一个库。
- `scripts/e2e_browser.mjs` 只更新了 schemaVersion 断言，未重跑这条历史长流程；其旧选择器可能仍需维护。v0.6 的 `scripts/e2e_v06_paths.mjs` 已单独覆盖两条当前主路径。
- `python scripts/run_tests.py` 已在 v0.6 全量跑通（**1236 passed / 0 failed**，含 `test_experience_note.py` 与 `test_ask.py`）；上表是分套件结果。研究与日程的单独浏览器脚本未逐一重跑。
- 真实模型没有参与本轮经验保存；符合「本轮无需为保存经验额外调用真实模型」。问答入口用的是已有回答。
- 浏览器验证覆盖 Chrome 1280×900 与 390×844；未覆盖 Safari/Firefox。
- 来源「更新」判断基于快照与当前 revision/正文比较；如果来源只改了不影响快照的字段，不提示。
- 删除经验后，`experience_attempts` 行保留但正文清空；没有单独的「恢复已删经验」能力。

## 10. 一句话结论

用户现在可以完成「找到旧记录 → 形成自己的理解 → 再次实践 → 修订理解」整条路径：两个入口都能创建经验，经验能被搜索、链接、反链和局部图找到，能据此创建尝试并记录结果，再带着结果回来修订；数据在刷新、重启、备份恢复和旧库迁移后都保留。
