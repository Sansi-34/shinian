# 拾念 SHINIAN · 「研究一下」实现记录（第一版）

日期：2026-11-14
范围：GitHub 公开仓库调研（关键词/指定地址）→ 元数据/README/许可证/Release → 模型带来源对比 → 小实验采用为现有 Attempt。本轮只读仓库资料；通用 MCP 与任意网页抓取不在本版。
契约：[`research-api-contract.md`](./research-api-contract.md)。

## 1. 交付行为

| 能力 | 实现 |
| --- | --- |
| 入口 | 念头详情第四张卡片「研究一下」；`/?research=1` 或 `/capture/:id?research=1` 自动展开；`/research` 查看已保存研究 |
| 研究问题 | 默认念头原文，可编辑（≤1000 字）；可选目标、环境、语言、时间、硬性条件（各 ≤200 字） |
| 检索方式 | 关键词走 GitHub `/search/repositories`；指定地址只接受 `owner/repo`、`https://github.com/owner/repo`、`git@github.com:owner/repo`，解析后拼固定 `/repos/...` 路径 |
| 发起前确认 | 显示提交给 GitHub 的检索词/仓库地址、研究问题与限制、候选/深入/README/prompt/并发/超时限制、当前模型与 GitHub 凭据状态 |
| 候选 | 最多 10 个；展示仓库名、描述、链接、主要语言、归档/Fork、Star（背景）、`pushed_at`、`updated_at`（标注非代码提交时间）、许可证检测 |
| 深入读取 | 用户最多选 3 个；读取元数据、README（≤4000 字符）、许可证文件/检测结果、最近 3 条 Release（正文 ≤1000 字符） |
| 缺失与失败 | 逐项标 `ok/missing/failed`；单份资料失败不整体失败；保留已取得资料；可只重试问题仓库 |
| 来源证据 | 每份资料保存 URL、获取时间、仓库、文件路径、分支、commit/文件 sha、实际发送给模型的摘录 |
| 证据分层 | 界面区分「仓库作者的声明（README）」「本次实际查到的元数据/文件」「模型推断」「待实际测试」 |
| 许可证 | 分开展示 GitHub 检测结果、许可证文件链接、未知状态；提示仓库许可/依赖许可/具体使用方式需分别确认 |
| 模型对比 | 复用「设置 → AI 模型」的配置、启用状态、密钥加密和超时；模型只收到选中仓库的资料 |
| 引用校验 | 每条 `sourceId` 必须属于本次实际发送且属于对应仓库；编造/跨仓库引用 → `ai_failed`，保留资料 |
| 资料不足 | 允许 `insufficient=true`，显示「暂时无法判断」；硬件兼容/运行效果/实现难度无依据时进 `unknowns/limitations` |
| 小实验 | 每个建议可「编辑并试一步」，修改标题/说明/耗时后采用 |
| 采用 | `expectedRevision` + 事务 + `operationId` 幂等；唯一键 `(research_id, experiment_index)`；重复采用返回同一 Attempt |
| 关联 | Attempt 保存来源研究、实验序号、采用时建议、引用资料 ID；尝试详情显示来源研究，研究详情显示已采用尝试 |
| 后续 | 进入现有尝试详情，安排时间、记录结果；回顾按真实 Attempt/结果统计 |
| 状态 | `searching → candidates → fetching → generating → succeeded/failed/cancelled/interrupted` |
| 取消 | 取消后停止后续请求；条件更新保证迟到响应不复活；刷新后仍可看到取消状态和已取得资料 |
| 重启 | 启动时 `generating/fetching/searching → interrupted`，用户可重新检索/重试 |
| 删除 | 删除研究只删任务与资料，已创建 Attempt 保留并显示「来源研究已删除」；删除念头级联删研究，删除预览含 `researchCount` |
| 成本展示 | 实际候选数、深入数、资料数、失败仓库、GitHub 请求次数（含候选搜索）、发送字符、模型 token 用量、耗时 |

## 2. 上限

| 项 | 值 |
| --- | --- |
| 候选仓库 | 10 |
| 深入仓库 | 3 |
| 指定仓库输入 | 10 |
| 研究问题 | 1000 字符 |
| 单项限制 | 200 字符 |
| README 摘录 | 4000 字符 |
| Release 正文 | 1000 字符，最多 3 条 |
| 模型 prompt | 40000 字符 |
| GitHub 并发 | 2 |
| GitHub 超时/重试 | 默认 15000ms / 1 次（`SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS` 可调） |
| 模型超时 | 默认 60000ms（`SHINIAN_RESEARCH_MODEL_TIMEOUT_MS` 可调） |
| 模型输出 | 1600 tokens |
| 并行研究 | 2 |

## 3. 代码位置

- `drizzle/migrations/0008_research.sql`、`src/db/schema.ts`：研究表、索引、Attempt 研究字段。
- `src/server/githubSettings.ts`：GitHub Token 设置；复用 `aiSettings.ts` 的 AES-256-GCM `encryptSecret/decryptSecret`，AAD `shinian:github-token:v1`。
- `src/server/githubClient.ts`：固定路径、拒绝 3xx、超时/1 次重试、错误分类、资料降级。
- `src/server/researchPrompt.ts`：system/user prompt、Zod schema、引用归属校验。
- `src/server/researchService.ts`：候选/深入/生成/取消/重试/保存/删除/采用、启动中断标记。
- `src/server/researchRoutes.ts`、`src/server/index.ts`：研究 API、删除预览、导出 v4、启动恢复。
- `src/client/components/ResearchStarter.tsx`、`src/client/pages/ResearchPage.tsx`、`ResearchIndexPage.tsx`：入口、四阶段详情、列表。
- `src/client/pages/SettingsAiPage.tsx`、`AttemptDetailPage.tsx`、`App.tsx`、`types.ts`、`api.ts`、`styles.css`。
- `scripts/fake_github_server.py`、`scripts/fake_model_server.py`、`scripts/test_research.py`、`scripts/e2e_research.mjs`、`scripts/live_github_check.ts`、`scripts/live_research_check.py`。

## 4. 数据与事务

`research_runs` 一行 = 一次研究；`research_sources` 一行 = 一份证据。JSON 字段保存候选、结果、统计、配置快照、错误等，避免频繁迁移。

- 创建时写入 `context_token`、问题/限制/检索方式、候选与配置快照；后台 `setImmediate` 执行，任何阶段完成都用条件更新校验 `status/revision`。
- `status='cancelled'` 后，迟到响应无法把状态改回 `succeeded/failed`。
- 采用在事务内检查 `research.revision`、实验是否存在、是否已采用；写 `mutation_receipts` 的 `research_accept`，再插入 Attempt 与引用。
- 研究删除不级联删除 Attempt；念头删除会级联研究，Attempt 仍保留采用内容。
- 导出 `schemaVersion=4`，新增 `researchRuns`、`researchSources`，Attempt 增加研究关联字段；备份仍为整库 SQLite 文件。

## 5. 已知限制

- 本轮仅 GitHub 公开仓库；私有仓库、GitLab、通用 MCP、任意网页抓取未实现。
- 关键词搜索使用 GitHub 默认相关度，未做二次排序/分页；候选上限 10。
- README 只读取默认分支的受限摘录；未解析全部文件树/依赖清单。
- 许可证只展示 GitHub 检测与仓库 LICENSE 文件，不扫描依赖许可证。
- 真实模型可能返回不符合 JSON schema 的内容；服务端会判 `ai_failed`，保留资料并允许重试，未做多模型自动降级。
- 未实现价格/预算换算，界面只显示 token 用量；未实现每日配额。
- 真实 GitHub 匿名额度较低（搜索 10 次/分钟量级）；配置 Token 后可提高额度。
