# 拾念 SHINIAN

单机单人使用的记录工具：把「试过什么、结果如何、条件是什么」留下来，下次遇到同类问题时能找回来并核对。

记下念头 → 试一步 → 记录真实结果 → 沉淀一条可复用的经验 → 下次找回并复用。

## 功能与限制

| 功能 | 入口 | 关键限制 |
|---|---|---|
| 念头 | `/`、`/capture/:captureId` | 正文 ≤4000 字，纯文本，无分类与标签 |
| 尝试与结果 | `/attempt/:attemptId` | 状态 `todo / in_progress / done / cancelled`；结果需手动填写，无结果不因时间经过显示成失败 |
| 手动关联与反链 | 念头、尝试详情 | 只记录真实关系，不做相似度推断 |
| 知识网络 | `/graph` | 全局图默认 240 节点（可调 600），局部图按稳定 ID 读全量；无向量检索、无布局保存 |
| 主题 | `/topics`、`/topics/:topicId` | 成员为稳定 ID 集合，不复制正文、不移动原记录；`next_attempt_id` 只固定已有未完成尝试 |
| 主题导出 Markdown | 主题详情 | 一次性独立 ZIP 副本，≤2000 文件 / ≤2000 尝试 / ≤20 MiB，不导入、不同步 |
| 经验笔记 | `/experiences`、`/experience/:id` | 至少 1 条、最多 8 条仍可访问的来源；修订走 `revision` CAS |
| 问我的记录 | `/ask` | 问题 ≤500 字；一次最多 8 条来源 / 12000 字符；只读，不创建任何记录 |
| 检索词扩展 | `/ask` 关键词区 | 最多 5 项、单项 ≤40 字、合计 ≤120 字；落地仍为子串匹配 |
| 阶段回顾 | `/review` | 单次范围 ≤366 天、读取 ≤500 条、发送 ≤80 条 / 16000 字符 |
| 下一步行动 | `/next-action/:nextActionId` | 复用 `attempts`（`origin='review_next_action'`），可选同时建日程 |
| 日程 | `/schedule` | 仅手动创建；单次范围查询 ≤62 天，跨日安排 ≤7 天；无重复日程与外部日历同步 |
| 研究（GitHub） | `/research`、念头详情 | 官方 REST 只读；候选 ≤10、深入 ≤3；Token 可选 |
| 操作动态 | `/activity` | 从业务表派生的最近事件，不保留完整变更历史 |
| AI 设置 | `/settings/ai` | OpenAI 兼容 Chat Completions，非流式、不支持工具调用 |
| 导出与备份 | 设置页、`scripts/` | JSON 导出 `schemaVersion: 7`；恢复靠整库 SQLite 备份 |

## AI 的边界

六个 AI 功能，全部只读 + 用户确认后写入：帮我试一步、参考旧经验、阶段回顾、问我的记录、检索词扩展、GitHub 仓库调研。

- 只发送用户勾选的记录：一次 1–8 条、≤12000 字符（回顾 ≤16000 字符）
- 服务端在预览与生成时各自重新计算范围；越界来源返回 400 `source_out_of_scope`，预览后范围变化返回 409 `context_changed`（主题导出为 409 `export_scope_changed`）
- 模型返回的 `sourceId` 必须属于本次发送集合；编造、改写、跨记录引用按 `invalid_response` 失败
- 模型输出中的任何 URL、链接、来源文本都不采信；来源 chip 与站内链接由服务端按真实 ID 生成
- 回答区分 `observation`（记录中的观察，可带条件）与 `inference`（模型推断），推断明确标注不是事实
- API Key 用本地 `db/master.key` 加密保存，不进 JSON 导出、不进仓库
- 不创建尝试、不改状态、不写引用、不自动排日程；「记成经验」「把这条变成下一步」是用户点按钮触发的独立动作

## 检索

参数化 `LIKE` 子串匹配，覆盖念头原文、尝试标题与结果，并做一跳真实关系扩展（`attempt_references`、`capture_links`）。
没有向量检索、embedding、拼音或跨语言扩展，不使用结果评价或相似度百分比排序。
「换些关键词找找」是模型生成的字面替代表达，落地仍是子串匹配。

## 数据模型

21 张表，14 个迁移文件（`drizzle/migrations/0000`–`0012`），服务启动时自动应用。

| 表 | 内容 |
|---|---|
| `captures` | 念头与经验（`kind` 为 `thought` / `experience`） |
| `attempts` | 尝试：状态、预计耗时、结果文本、`observed_at` |
| `capture_links` / `attempt_references` | 记录间手动关联、尝试对记录的引用 |
| `experience_notes` / `experience_sources` / `experience_attempts` | 经验的条件、限制、依据快照、后续采用版本 |
| `topics` / `topic_members` | 主题与成员关系 |
| `schedule_blocks` | 日程块（时区按 `Intl` 本地实现） |
| `stage_reviews` | 已保存的阶段回顾 |
| `research_runs` / `research_sources` / `github_settings` | 研究任务、取回的资料来源、GitHub 设置 |
| `record_queries` | 问答过程记录（不进 JSON 导出） |
| `ai_settings` / `ai_generations` | 模型配置与生成记录（不含明文密钥） |
| `accounts` / `sessions` / `mutation_receipts` | 本地登录、会话、幂等回执 |

## 目录结构

```
src/client/     React 19 页面与组件（20 个路由，约 3.8 万行）
src/server/     Fastify 5 路由与服务（约 120 个接口，约 2.2 万行）
src/db/         Drizzle schema 与连接
drizzle/        迁移 SQL 与 drizzle-kit 元数据
scripts/        验收脚本：API、状态一致性、备份恢复、浏览器 E2E
docs/           接口契约与实现记录
```

## 运行

```bash
cp .env.example .env.local     # NODE_ENV / DATABASE_URL / PORT / HOST
npm install
npm run build && npm run serve # http://127.0.0.1:3000
```

开发模式：`npm run dev`（Vite）与 `npm run serve`（API）分别启动。

## 验收

```bash
npm run typecheck        # tsc --noEmit
npm run test:api         # 其余 test:* 同理：search / consistency / ai / experience / activity
npm run test:review      # review / links / ask / topics / export / backup
npm run test:e2e         # 浏览器 E2E（需本机 Chrome，puppeteer-core）
npm run test:all         # 顺序跑完所有 python 用例
npm run verify           # 主库启动核对
npm run backup           # 整库备份到 backups/
```

浏览器验证仅在本机 Chrome 无头模式 1280×900 与 390×844 两个视口完成；未在真实手机、Firefox、Safari 上验证。

## 已知边界

- 单机单人：有本地登录但只有一个账号，无多用户隔离、无多端同步、无限流与密码哈希之外的生产级账号能力
- 无 JSON 导入；恢复依靠整库 SQLite 备份 + 启动迁移
- 无流式输出、工具调用、MCP、多模型中心、自动记忆
- 检索为 `LIKE` 子串，未启用 FTS5，未在上万条记录量级压测
- 日程无重复规则、无外部日历同步、无系统推送；DST 只对 `America/New_York` 边界做过自动化验证
- 导出为 `schemaVersion: 7`，包含念头/尝试/引用、关联、日程、回顾、研究、经验、主题；`record_queries`、`ai_settings`、`ai_generations` 不导出
- 真实模型质量只做过有限人工核对，其余 AI 流程用固定响应的假模型验证协议、结构与失败分类，不代表回答质量
