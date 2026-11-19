# 拾念 SHINIAN · 「问我的记录」实现记录

日期：2026-11-14；2026-11-16 增补「换个说法找记录」检索词扩展。
范围：本地候选检索、发送前预览、后台异步问答、问答历史/取消、来源删除清洗、迁移 `0009_ask.sql`；2026-11-16 增加 `keyword-suggestions` 与 candidates `expanded`。
契约：[`ask-api-contract.md`](./ask-api-contract.md)。
版本说明（2026-11-16）：新增「换个说法找记录」检索词扩展（`POST /api/ask/keyword-suggestions` 与 candidates 的 `expanded`）。契约见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)，实现与评测见 [`keyword-expansion-implementation.md`](./keyword-expansion-implementation.md)；API **46 passed / 0 failed**、浏览器 E2E **34 passed / 0 failed**、全量 `run_tests.py` **1287 passed / 0 failed（13 套件）**，真实模型 已配置的 OpenAI 兼容模型 **24/24** 次建议调用成功。扩展词仍是字面子串检索，不是语义搜索；已知 `distractor-01` 把「失败」当检索词。
状态说明（2026-11-15 问我的记录交付）：服务端代码、前端 `/ask` 页面、浏览器验收与真实模型样例均已完成。`scripts/test_ask.py` 在隔离 SQLite + `fake_model_server.py` 上 **228 passed / 0 failed**；`scripts/run_ask_e2e_acceptance.ps1` 在隔离库与真实 Chrome 1280×900 / 390×844 上 **65 passed / 0 failed**（连续两次一致）；使用主库复制的 已配置的 OpenAI 兼容模型 配置完成 3 组真实模型人工核对。本文中「已验证」只用于本轮实际运行过的检查；其余边界集中在 §7、§8。

## 1. 当前状态

| 部分 | 状态 |
| --- | --- |
| `src/server/askTypes.ts` | 已实现：常量、`AskCandidate`、`AskRecord`、`AskAnswer`、`AskPublic` 等类型 |
| `src/server/askData.ts` | 已审计并修复：关键词提取、范围解析、候选检索（`attempt_references` + `capture_links` 一跳）、`matchKind`、`normalizeExpandedTerms`、`expandedTerms` 打分、记录读取、快照、公开来源、删除清洗、启动中断 |
| `src/server/askAi.ts` | 已审计：system/user prompt、Zod + 语义校验、问答 6 个 HTTP 路由、`POST /api/ask/keyword-suggestions`、后台生成与取消 |
| `src/server/askKeywordSuggestions.ts` | 已实现：检索词改写 prompt、`parseKeywordSuggestions`、10 分钟内存幂等缓存、配置读取与错误分类 |
| `drizzle/migrations/0009_ask.sql` + `src/db/schema.ts` | 已实现：`record_queries` 与两个索引 |
| `src/server/index.ts` | 已实现：注册路由、启动 `markInterruptedAskQueries()`、删除尝试/念头时调用清洗（本轮只核对，未改） |
| `src/client` | 已实现：`/ask` 问答页、`/ask/:id` 详情、direct/expanded/relation 分组、候选原文预览、勾选/移除、发送核对、二次确认、轮询/取消、失败来源、历史、sessionStorage 现场恢复、390px 移动端；`AskAnswer` 来源卡提供打开原记录、局部图和「用这条经验试一步」；`KeywordExpansionPanel` 提供「换些关键词找找」 |
| `scripts/test_ask.py` + `fake_model_server.py` 的 `fake-ask*` | **已落地并运行**：228 passed / 0 failed（隔离库 + 假模型）；默认自启动隔离服务，也支持 `SHINIAN_BASE` 复用 run_tests 的 3100 |
| `scripts/test_keyword_expansion.py` + `fake_model_server.py` 的 `fake-suggest-keywords*` | **已落地并运行**：46 passed / 0 failed；已接入 `run_tests.py` |
| `scripts/eval_keyword_expansion.py` + `keyword_expansion_eval_cases.json` | **已运行 24 例**；报告见 （原始输出未随仓库提供），真实模型建议效果见 §10.5 |
| `scripts/e2e_keyword_expansion.mjs` | **已落地并运行**：34 passed / 0 failed（Chrome 1280×900 / 390×844，含键盘、返回恢复、来源删除） |
| `scripts/e2e_ask_acceptance.mjs` + runner | **已落地并运行**：65 passed / 0 failed（Chrome 1280×900 / 390×844；A/A1、B1 反链、D capture_links、E/E1 排除、F 无关、负面场景） |
| 真实模型联调 | **已完成 3 组合成样例人工核对**：已配置的 OpenAI 兼容模型，观察/推断、条件、结果差异与证据不足说明、来源 ID 均通过；未触发结构化 `contradictions` 数组，见 §10 |

## 2. 设计取舍

### 2.1 复用现有搜索的子串匹配 + `attempt_references` / `capture_links`，不做向量检索

- 数据都在本机 SQLite，单人使用、记录量小；沿用现有搜索「关键词命中」的口径即可，无需 embedding 服务、无需索引重建，离线可用、无额外服务成本。实现上候选检索在 JS 内完成（一次性读出后在内存过滤），语义与 SQL `LIKE '%kw%'` 等价，只是不逐条查询。
- 命中原因可以逐条解释（结果命中 / 标题命中 / 所属念头命中 / 念头命中 / 被这次尝试引用 / 引用了这次尝试 / 通过链接找到），用户能判断「为什么这条被带出来」，也可以自己修改关键词重搜。
- 引用关系来自真实的 `attempt_references`，念头关联来自真实的 `capture_links`，不是模型猜的关联；这让「这条经验后来在哪次尝试里用过」「这条念头和哪条记录有关」有事实依据。
- 2026-11-16 新增的检索词扩展（`expanded`）仍走同一子串匹配：模型只建议字面检索词，用户勾选后追加；它不改变语义、不读取记录正文，不能把同义改写说成「语义搜索」。详见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)。
- 代价明确：同义词、改写、跨语言（中文问、英文记录）会漏；关键词提取只是去停用词与轻量切分，不保证语义正确。这一层不做「相似度百分比」，避免把字符串匹配包装成语义理解。

### 2.2 首版只回答四类问题

1. **事实回忆**：我什么时候做过 X、当时记了什么结果。
2. **对比**：两次/多种做法有什么不同。
3. **条件**：什么条件下成功或失败，记录里写没写条件。
4. **矛盾**：不同记录对同一件事的结论是否不一致。

这四类与回答结构一一对应：`points`（事实/推断）、`contradictions`（矛盾两边）、`missing`（缺什么）。超出这四类的问题（预测、建议、心理分析）不在首版承诺内，prompt 明确禁止编造经历与空泛建议。

### 2.3 候选扩展：`attempt_references` + `capture_links` 一跳

- 直接命中：尝试按 `result_text` / `step` / 所属念头原文打分；念头按自身正文打分。直接命中候选一律 `matchKind='direct'`。
- 尝试扩展：命中尝试沿 `attempt_references` 取直接引用伙伴（双向），未命中且日期在范围内则加入；锚点引用伙伴时 reason 为 `被这次尝试引用`，伙伴引用锚点时 reason 为 `引用了这次尝试`，并附 `引用关系`。
- 念头扩展：命中念头沿 `capture_links` 取正链与反链的直接关联伙伴，未命中且日期在范围内则加入，reason 为 `通过链接找到`。本轮审计修复了此前只扩展 `attempt_references`、完全漏掉 `capture_links` 的缺陷。
- 所有扩展候选 `matchKind='relation'`，固定 `score=10`；只扩展一跳，不递归，避免候选爆炸和「顺着链接跑题」。排序时直接命中整体优先于关系扩展，再按 score/date/sourceKey。
- 关键词为空时是「浏览模式」（范围内全部记录按时间倒序），此时不扩展：没有命中锚点，扩展全部关联等于把整库拉出来。

### 2.4 只读

- 问答不写 `captures`、`attempts`、`attempt_references`，不建引用、不改状态、不归档。
- 唯一写入是 `record_queries`；删除问答不影响业务记录，删除业务记录只清洗快照。
- 这样「问」不会污染「记录」，用户不会因为提问而多出一条尝试或引用。

### 2.5 预览即确认（contextToken）

- 预览返回服务端真实记录与将发送的完整 prompt 字符数，用户看到的就是实际会发的内容；客户端提交的正文一律忽略。
- `contextToken` 绑定问题、关键词、范围、配置版本、每条来源的 `revision`/`captureRevision`；预览后任何一项变化都会在生成时 409 `context_changed`，不会出现「确认的是 A、发出去的是 B」。
- 未配置模型也能预览：先让用户看清范围与内容，再决定去配置模型，而不是在检索阶段就拦死。

### 2.6 后台生成与状态机

- 模型调用可能持续到 60 秒（`SHINIAN_AI_TIMEOUT_MS` 默认 60000），HTTP 不等模型：创建即 202，`setImmediate` 后台跑。
- 完成态更新统一带 `WHERE status='pending'`，取消与超时/失败竞争时不会把已取消的任务改回成功；重启时 `pending → interrupted`，用户可重新提问。
- 并发上限 2 是「本机同时最多两个问答」，防止误点多次把模型额度打满；超限是 429 而不是排队的 202。

## 3. 与现有流程衔接

### 3.1 来源打开

- `openHref` 由服务端生成：尝试 `/attempt/<id>`、念头 `/capture/<id>`；前端直接跳转即可，不需要自己拼。
- 详情接口的 `range.fromLocal/toLocal` 为 null，界面显示日期范围时要用 `from/to` 自行格式化（候选与预览接口会返回 `YYYY-MM-DD`）。

### 3.2 图谱

- `graphHref = /graph?node=<encodeURIComponent(sourceKey)>`，例如 `/graph?node=attempt%3Aatt-...`；图谱节点 ID 本身就是 `attempt:<id>` / `capture:<id>`，`GraphPage` 读取 `node` 参数，`GET /api/graph/focus?node=attempt:<id>` 可直接聚焦。本轮已把服务端 `graphHref` 从旧的 `?focus=` 统一为 `?node=`，与 GraphPage 路由参数对齐；不再依赖前端兼容 `focus`。

### 3.3 「用这条经验试一步」

- `sources[].canReuse === true`（尝试且有结果文本）时，界面可给入口：跳 `/capture/<captureId>?experience=<attemptId>`。
- 该路径复用既有「参考旧经验」预览：`CaptureDetailPage` 读取 `experience` 参数后自动打开面板并调用既有 `preview` 接口，用户仍需确认才生成；问答侧不直接创建尝试、不写引用。
- 既有预览一次接受 1–3 条来源；从问答带入时只带当前这一条最稳妥（多带需要额外的选择界面，首版不做）。

### 3.4 未配置模型

- 候选检索、预览都可用；预览返回 `ai.configured=false`，界面提示「先配置 AI 模型」并给设置入口，但不禁用检索与勾选。
- 生成返回 409 `ai_not_configured`；配置存在但停用返回 409 `ai_disabled`。已成功的问答在模型停用后仍可查看。

### 3.5 与「阶段回顾」「研究一下」的分工

- 回顾按时间范围汇总统计，研究面向外部仓库资料，问答是自由提问 + 自选记录。
- 三者共用 `aiSettings`（配置、加密、超时）、`aiProvider`（调用与错误分类）、后台任务/取消/中断的模式，但表与 prompt 独立，互不影响。

## 4. 回答质量边界

### 4.1 observation 与 inference

- `basis` 是结构字段，服务端能校验枚举值，但**不能校验语义**：模型完全可能把推断写成 `observation`。
- 因此界面必须把两类分徽标展示（「记录中的观察」/「模型推断」），并在回答区固定提示「模型可能把推断写成观察，请对照来源核对」。
- prompt 已要求推断不得添加记录中没有的时间、数量、结果或因果；这只降低概率，不保证。

### 4.2 condition

- prompt 要求写最具体的条件（频率、时长、环境、做法、占空比等）；记录没写条件时 `condition=null`，且正文要说明「记录没有写下条件」。
- 校验只限制长度（≤200），不强制非空——`condition=null` 既可能是「记录确实没写」，也可能是模型偷懒，二者在数据上不可区分。
- 因此「有 condition」不等于「条件完整」；「没有 condition」也不等于「无条件」。界面应显示原文条件并链接来源。

### 4.3 contradiction 两边条件

- 每条 `contradictions` 至少 2 个 sides（最多 4），每个 side 必须写非空 `condition`；同一 contradiction 内来源不得重复。
- 目的：逼模型分别交代两边的条件，而不是笼统说「结论不同」。但模型仍可能只写一边的具体条件、另一边写「记录未写条件」，或把本不矛盾的两条硬凑成矛盾——需要人工判断。
- prompt 明确不替用户判定哪条正确；界面也不应加「正确/错误」标记。

### 4.4 missing 与 insufficientEvidence

- `insufficientEvidence=true` 时 `missing` 必须非空（至少 1 条），否则 `invalid_response`；`points` 与 `contradictions` 同时为空时也必须是 `insufficientEvidence=true`。
- `missing` 的内容仍是模型生成的，只能保证「说了缺什么」，不能保证「缺的正是关键项」。

### 4.5 已知会出错的形态

- 把两次条件不同的记录合并成一条结论，丢掉「占空比/环境/时长」差异。
- 把「一次成功」推广为「这个方法有效」。
- 对没有结果的尝试，把「做了」说成「有效果」。
- 长记录进入 prompt 时被截断：单条记录正文 1800 字符、所属念头 500 字符、引用说明 200 字符，超出以「…」结尾；关键条件如果写在被截断部分，模型看不到。

## 5. 代码与数据位置

| 文件 | 内容 |
| --- | --- |
| `src/server/askTypes.ts` | 全部类型与上限常量（500/200/5/40/120/8/12000/50/20/3660） |
| `src/server/askData.ts` | `suggestKeywordsForQuestion`、`normalizeKeywords`、`normalizeExpandedTerms`、`parseAskRange`、`searchAskCandidates`（含 `expandedTerms` 打分）、`normalizeSourceKeys`、`readAskRecords`、`askContextToken`、`sourcesSnapshotOf`、`publicAskSourcesOf`、`publicAskOf`、`askListItemOf`、`markInterruptedAskQueries`、两个删除清洗 helper |
| `src/server/askAi.ts` | `ASK_SYSTEM_PROMPT`、`parseAskAnswer`、`buildAskUserPrompt`、`generateAskAnswer`、`registerAskRoutes`、`POST /api/ask/keyword-suggestions`、后台 `runAsk`、`queryFingerprint` |
| `src/server/askKeywordSuggestions.ts` | 检索词改写 prompt、`parseKeywordSuggestions`、`generateKeywordSuggestions`、内存幂等、配置读取与错误分类 |
| `src/client/components/KeywordExpansionPanel.tsx` / `AskPage.tsx` | 「换些关键词找找」面板、`expandedKeywords` 状态、候选 direct/expanded/relation 分组 |
| `scripts/test_keyword_expansion.py` / `scripts/eval_keyword_expansion.py` | API 验收 46/0；固定评测集 24 例与报告输出 |
| `src/db/schema.ts` | `recordQueries` 表定义与索引 |
| `drizzle/migrations/0009_ask.sql` | 建表 + `created_at DESC` / `status` 索引 |
| `src/server/index.ts` | `registerAskRoutes(fastify)`、启动中断标记、删除尝试/念头事务内的清洗调用 |

关键实现细节：

- 候选检索在 JS 内完成：先全量读 `attempts`/`captures`/`attempt_references`/`capture_links`，再按范围、关键词、扩展词、引用扩展打分排序；没有 SQL 层的 LIKE，也没有分页下推。
- 检索词扩展（2026-11-16）：`normalizeExpandedTerms` 做 5/40/120 校验；扩展词与原始词同权计入分数，仅扩展词命中的候选标 `matchKind='expanded'`，只有 `direct` 候选触发一跳关系扩展。
- 记录读取按 `sourceKey` 字典序返回，因此 prompt 中先尝试后念头，不是时间顺序。
- `preview.coverage.selectedChars` 用与 `buildAskUserPrompt` 相同的函数计算，保证「预览字数 = 实际发送字数」。
- `publicAskOf` 每次读取都会按当前数据库状态重算 `exists/changed/deleted`，并据此过滤 `answer.points/contradictions`、累加 `hiddenPointCount`。
- 后台失败入库前 `classifyError(error, [apiKey])` 脱敏，`error_detail` 截断 500 字符；日志只有 `queryId` 与 `errorCode`。

## 6. 测试计划

### 6.1 隔离环境

`scripts/test_ask.py` 默认自启动隔离服务与假模型，不需要手工起服务；也可复用 run_tests 的 3100：

```powershell
# 默认：自启动（db/test-ask.sqlite + 自动空闲端口 + fake_model_server.py 3501）
python scripts/test_ask.py

# 外部模式：复用 run_tests / 已有隔离服务
$env:SHINIAN_BASE="http://127.0.0.1:3100"
$env:SHINIAN_TEST_DB="<repo>\db\test.sqlite"
python scripts/test_ask.py
```

- 测试库必须是明确的测试库（文件名含 `test`）；脚本拒绝自动删除非测试库，不会写入 `db/shinian.sqlite`。
- 假模型按 `fake-ask*` 场景切换；测试前每个场景通过 `PUT /api/settings/ai` 重新配置。
- `SHINIAN_AI_TIMEOUT_MS` 在自启动模式默认 1200ms，足以触发 `fake-ask-timeout` 的 5 秒延迟。

### 6.2 用例清单（历史计划；实际执行结果见 §9）

| # | 场景 | 断言要点 |
| --- | --- | --- |
| 1 | 有答案 | 造 3 条相关记录 → 候选 `total>0`、`matchReasons` 合理；预览 `records` 等于勾选、`withinLimit=true`；生成 `succeeded`，`summary` 非空，每个 `points[].sourceIds ⊆` 发送集合 |
| 2 | 无证据 | `fake-ask-insufficient` → `insufficientEvidence=true`、`points/contradictions` 为空、`missing` 非空 |
| 3 | 矛盾 | 两条同主题相反结论 + `fake-ask-contradict` → `contradictions≥1`、`sides≥2`、每个 side `condition` 非空 |
| 4 | 来源删除 | 生成成功后删除来源尝试 → 详情 `deleted=true`、`title='来源已删除'`、`text/resultText/openHref/graphHref=null`、`answerInvalidated=true`、`hiddenPointCount` 增加；直接查 `sources_json` 确认无正文 |
| 5 | 无效引用 | `fake-ask-bad-source` 返回未发送 ID → `failed`、`errorCode='invalid_response'`、`answer=null`；可用新 `operationId` 重试 |
| 6 | 超时 | `fake-ask-timeout` + 3 秒超时 → `failed`、`errorCode='timeout'`、`durationMs` 有值 |
| 7 | 未配置模型 | 候选/预览 200 且 `ai.configured=false`；生成 409 `ai_not_configured`；保存 Key 但停用 → 409 `ai_disabled`；重新启用后成功 |
| 8 | 日期边界 | 造 `from-1 / from / to-1 / to` 四条记录 → 只命中中间两条；分别覆盖 `dateKind='observed'` 与 `'created'` |
| 9 | 关键词 | 缺省时自动提取并回填 `suggestedKeywords`；显式关键词覆盖；空关键词为浏览模式（`total` 为范围内全部）；命中原因顺序稳定 |
| 10 | 引用扩展 | A 命中、B 未命中但 A↔B 有引用 → B 出现且 `matchReasons=['引用关系']`；关键词为空时 B 不以伙伴身份出现；二跳 C 不出现 |
| 11 | 幂等 | 同 `operationId` 同 body → 200 `replayed=true` 且 `id` 相同；改 `question` → 409 `operation_key_conflict`；并发两次同键 → 一个 202、一个 200 或 409（按指纹） |
| 12 | 并发上限 | 两个慢任务 `pending` 时第三次 → 429 `too_many_queries` |
| 13 | 取消 | `pending` 取消 → 200 `cancelled`、`canCancel=false`；重复取消 409 `not_cancellable`；模型迟到返回后仍为 `cancelled`、`answer=null` |
| 14 | 重启中断 | 制造 `pending` 后重启服务 → `interrupted`、`errorCode='interrupted'`、`errorMessage` 含「服务重启」 |
| 15 | 参数校验 | 空问题/501 字、关键词 201 字、`sourceKeys` 空/9 条/重复/坏格式、`operationId` 缺失/201 字、`contextToken` 缺失、`to<=from` → 对应 400 错误码 |
| 16 | 上下文变化 | 预览后编辑来源步骤 → 生成 409 `context_changed`；改 AI 配置版本 → 同样 409；重新预览后成功 |
| 17 | 来源不可用 | 预览后删除来源 → 预览与生成均 409 `sources_unavailable`，带 `sourceKeys` |
| 18 | 隐私 | 假模型 `/__last` 断言 prompt 只含勾选记录、不含未选记录正文、不含密钥；响应与日志不出现 API Key |
| 19 | 列表与详情 | 默认 20 条、`created_at DESC`；`limit=0` 按 20；不存在 404 `query_not_found`；未登录 401 |
| 20 | 回答结构校验 | 11 条 points / point 无 sourceIds / 单 side 矛盾 / `insufficientEvidence=true` 但 `missing=[]` / 重复来源 → 均 `failed/invalid_response` |

### 6.3 假模型场景

在 `scripts/fake_model_server.py` 的模型白名单与 `/v1/chat/completions` 分支中增加（命名与现有 `fake-review-*` 一致）：

| 模型 | 行为 |
| --- | --- |
| `fake-ask` | 从 prompt 解析所有 `[attempt:…]`/`[capture:…]`，生成 1–2 个 `points`，`sourceIds` 全部取自请求 |
| `fake-ask-insufficient` | `points=[]`、`contradictions=[]`、`insufficientEvidence=true`、`missing` 写 2 条 |
| `fake-ask-contradict` | 返回 1 条 `contradictions`，`sides` 取前两条来源，各带 `condition` |
| `fake-ask-bad-source` | `points[0].sourceIds` 写入 `attempt:not-sent` |
| `fake-ask-invalid-json` | 返回纯文本，不是 JSON |
| `fake-ask-timeout` | 延迟 5 秒后返回合法 JSON（配合 `SHINIAN_AI_TIMEOUT_MS=3000` 触发 timeout） |

假模型验证流程：

1. 隔离服务启动后，通过 `PUT /api/settings/ai` 保存 `baseUrl=http://127.0.0.1:3501/v1`、`modelId=fake-ask`、任意非空 `apiKey`、`allowLocal=true`、`enabled=true`（本机地址必须允许，否则被 URL 校验拒绝）；
2. 用 API 造念头/尝试/结果/引用（每条都带明确的 `observed_at`，避免只靠 `created_at`）；
3. 调 `GET /api/ask/candidates` 拿 `sourceKey`，再走 preview → queries → 轮询详情；
4. 每个场景切换 `modelId` 后重复第 3 步；断言前先 `GET /__last` 确认本次 prompt 只含勾选的记录，避免上一轮请求串味。

注意：ask 的 prompt 中记录行格式是 `[attempt:<id>] 尝试｜结果时间：…`（无结果时间时为 `记录时间：…`）与 `[capture:<id>] 念头｜创建于：…`，与 review 的 `[attempt:<id>] 尝试｜开始于…` 不同，假模型解析要按 `^\[(attempt|capture):` 取前缀，不要复用 review 的正则。

### 6.4 真实模型

- 只在 `GET /api/settings/ai` 返回 `enabled=true` 且 `hasApiKey=true` 时人工进行；不在 CI 中跑。
- 记录厂商、模型 ID、Base URL、日期、问题与选中记录；逐条核对：
  - 每个 point 的来源是否真的支持这句话；
  - observation 里有没有掺入推断；
  - 条件是否照抄记录，还是没有条件却编了条件；
  - 矛盾两边是否都有条件、是否真的矛盾；
  - `missing` 是否是真正的缺口。
- 真实模型质量不进入「已验证」，只写「人工核对记录」。

### 6.5 验收清单（后端已执行项见 §9）

- [x] `npm run typecheck` 通过（2026-11-14 23:5x，全工作树）。
- [x] `npm run build` 通过（2026-11-15 13:5x，生成 dist/client；仅有既有 react-router "use client" 与 chunk >500 kB 警告）。
- [x] 未登录 401；参数错误码与 §11 一致。
- [x] 有答案 / 无证据 / 矛盾三类回答结构正确，来源全部属于发送集合。
- [x] 预览字数与实际 prompt 一致（假模型 `/__last` 对比）。
- [x] 幂等、并发 429、取消不复活；重启中断逻辑已核对，测试脚本未做重启（见 §7）。
- [x] 删除尝试/念头后：详情无已删正文、`answerInvalidated=true`、`hiddenPointCount` 正确、数据库快照已清洗（attempt 与 capture 两条路径）。
- [ ] 导出不含 `record_queries`；整库备份恢复后问答历史仍可读（未在本轮跑）。
- [x] 密钥不出现在 prompt / 响应（测试断言）；日志未逐字节扫描。
- [x] 1280px 与 390px 浏览器交互由 `scripts/run_ask_e2e_acceptance.ps1` 验证：65/65，通过候选分组、逐项预览、发送核对、生成、来源打开、局部图、旧经验复用、手机证据选择与负面场景。

## 7. 未验证事项清单

| 事项 | 现状 | 需要怎么验 |
| --- | --- | --- |
| 真实模型回答质量 | 已做 3 组合成样例人工核对（见 §10）；样本不足以覆盖同义改写、跨语言、长记录与模型随机性 | 若要提升结论强度，用真实 Key 再跑 10+ 问题并覆盖更多矛盾类型；同题重跑比较措辞稳定性 |
| 语义检索能力 | 未实现；只有子串匹配 | 用同义改写问题测试召回率，确认漏检范围；若要提升需另立方案（embedding/索引），不在本版 |
| 长记录截断 | 未验证影响；单条 1800 字、所属念头 500 字、引用说明 200 字 | 造一条 >2000 字的结果文本，确认关键条件是否被截掉，并检查 `selectedChars` 是否触发 12000 上限 |
| 多用户/权限 | 不支持；`record_queries` 无用户维度，查询与列表不按账号过滤 | 若未来多用户，需要加 `account_id` 并在所有查询加过滤，属于结构性改动 |
| 前端页面与 E2E | **已完成**：`run_ask_e2e_acceptance.ps1` 65/65，覆盖 1280×900 / 390×844、候选分组与预览、发送核对、生成、打开原文、`/graph?node=`、sessionStorage 恢复、旧经验预览、无匹配、矛盾、来源更新/删除、编造来源、模型失败 | 修改 UI 后重跑该脚本；外部 `scripts/e2e_ask.mjs` 的 37 项仅作为早期主流程回归 |
| 假模型自动化 | **已落地并运行**：`scripts/test_ask.py` 228 passed / 0 failed | 后续如改 ask 检索/prompt，重跑该脚本 |
| 候选检索性能 | 未测；全表读入 + JS 过滤（新增 capture_links 读取后仍是全表） | 造 1 万/5 万条记录测 `GET /api/ask/candidates` 响应时间；若超 200ms 再考虑 SQL 下推或缓存 |
| 模型输出上限 | 未验证；`maxOutputTokens=1000` 与 `points≤10`/`contradictions≤5` 是否匹配 | 真实模型下观察是否频繁被截断成非法 JSON |
| 并发上限 2 的体验 | 逻辑已由 429 测试覆盖；前端提示未验证 | 前端请求层需要把 429 `too_many_queries` 映射为「当前问答任务过多，请稍后再试」 |
| 删除与生成的竞态 | 逻辑上有保护（快照先落库、删除清洗在事务内），本轮未做「生成中删除」实测 | 生成请求发出后立刻删除来源，确认完成态与 `deleted` 标记一致，不出现可读正文 |
| 重启中断 | 逻辑已核对（`markInterruptedAskQueries`），本轮测试未重启服务 | 制造 pending 后重启，确认 `interrupted` + `finishedAt` |
| `graphHref` 参数 | **已修复**：服务端统一 `/graph?node=<encodeURIComponent(sourceKey)>`，测试断言通过 | 前端点击图谱链接后应聚焦到对应节点 |
| `matchKind` 前端类型 | **已修复**：`AskCandidate` 已声明 `matchKind?: 'direct' / 'expanded' / 'relation'`，`AskPage` 按此分组并兼容旧响应的 `matchReasons` | 修改检索排序后重跑 `test_ask.py` 与浏览器验收 |

## 8. 已知限制

- 单次最多 8 条记录、12000 字符；超过 8 条在选择阶段就是 400 `invalid_sources`，字符超过 12000 在生成时 409 `query_too_large`；不截断、不静默丢弃。
- 候选最多 50 条、默认 20；没有分页，翻不到更早的候选，只能改关键词或日期。
- 检索词扩展（`expanded`）由模型生成，可能为空、过于宽泛或包含错词（已知 `distractor-01` 把「失败」当检索词）；它只做字面子串匹配，不保证同义/跨语言命中；建议不落库、不自动应用，用户必须逐项勾选。
- 问答历史列表最多 50 条，按创建时间倒序，不能按关键词搜索。
- 日期标签固定 `Asia/Shanghai`，不随用户时区变化；跨时区使用时日期可能差一天。
- 删除来源后模型正文保留（与现有 AI 建议/回顾策略一致），只清除来源正文并标记失效；回答里可能出现指向已删除来源的文字，界面必须显示占位与「来源已删除」。
- 没有流式输出；生成中只能轮询。
- 没有自动重试与多模型降级；失败后由用户重新发起（新 `operationId`）。

## 9. 本轮后端审计与实测（2026-11-14）

### 9.1 修复的真实缺陷

1. **候选扩展不完整**：原实现只沿 `attempt_references` 扩展，完全没读 `capture_links`。现在直接命中的念头会沿 `capture_links` 取正链/反链一跳伙伴，直接命中的尝试继续沿 `attempt_references` 双向扩展；所有扩展只做一跳，不递归。
2. **候选无法区分直接/扩展**：`AskCandidate` 新增 `matchKind: 'direct' | 'relation'`；`matchReasons` 增加可解释原因：`被这次尝试引用`、`引用了这次尝试`、`通过链接找到`。直接命中整体排在关系扩展之前。
3. **graphHref 参数错误**：原为 `/graph?focus=<sourceKey>`，而 `GraphPage` 读 `?node=`。`publicAskSourcesOf` 已统一为 `/graph?node=<encodeURIComponent(sourceKey)>`，契约 §8 同步更新。
4. **关键词整句化**：原 `suggestKeywordsForQuestion` 会把长中文残句当唯一关键词（如「闪烁是处理的」「哪种没用」）。现在按标点/空白分句，去掉多字口语停用词，中英文混写拆分，残留助词只作为边界处理；单个长中文词兜底拆成双字片段。Lead 给出的 4 个反例现在分别得到 `LED 闪烁`、`调光实验`、空、空（空 = 浏览模式）。
5. **删除快照边界**：已带 `deleted:true` 的快照强制按删除占位返回，即使理论上出现同 ID 新记录也不回显旧正文。

### 9.2 已核对且未改动的部分

- 范围校验：`from` 含、`to` 不含；`to<=from`、非正整数、跨度 >3660 天、超出可表示范围均 400 `invalid_range`。
- `sourceKeys`：1–8 条、去重、格式 `attempt:<id>` / `capture:<id>`；不存在/已删除 409 `sources_unavailable`。
- 版本与删除：`contextToken` 绑定问题/关键词/范围/配置版本/每条 `revision`+`captureRevision`；编辑只 `changed=true`，删除才 `answerInvalidated=true`；`hiddenPointCount` 只统计完全失去有效来源的 point/contradiction。
- 幂等/冲突：同 `operationId` 同指纹回放 200 `replayed=true`，不同指纹 409 `operation_key_conflict`；插入撞唯一键后按指纹二次判定。
- 并发/取消/错误码：pending 上限 2 → 429 `too_many_queries`；取消立即 200 `cancelled`，完成态更新均带 `WHERE status='pending'`，迟到响应不复活；模型错误码 `auth`/`timeout`/`invalid_response` 与 `ai_not_configured`/`ai_disabled` 均符合契约。

### 9.3 实际运行

```powershell
npm run typecheck
# tsc --noEmit：通过（全工作树，0 错误）

python scripts/test_ask.py
# 自启动隔离服务：db/test-ask.sqlite + 自动空闲端口
# fake model: scripts/fake_model_server.py（3501）
# 228 passed, 0 failed
```

覆盖场景：认证/参数校验、关键词 6 例（含 Lead 4 个反例）、无匹配、直接命中、attempt_references 正反一跳、capture_links 正反一跳、二跳不递归、matchKind、日期范围精确左闭右开、删除候选过滤、预览/coverage/contextToken、未配置/停用、成功生成、来源 subset、openHref/graphHref、canReuse、来源编辑、context_changed、编造 sourceId、模型 auth/invalid JSON/insufficient、幂等回放/冲突、并发 429、取消不复活、attempt 与 capture 来源删除清洗（API + `sources_json` 直查）。

### 9.4 发现但未在本轮修复/未验证

- `docs/ask-api-contract.md` 已同步 `matchKind`、`capture_links`、`node=`；2026-11-16 又补 `expanded`、`expandedKeywords`、`matchedKeywords` 与检索词扩展契约链接。
- `src/client/types.ts` 的 `AskCandidate` 已由前端补上 `matchKind?: 'direct' | 'expanded' | 'relation'`，问题闭环。
- 重启中断、生成过程中删除来源、导出/备份恢复未在本轮自动化中覆盖；逻辑已核对，见 §7。
- 真实模型质量已完成 3 组合成样例人工核对，见 §10；候选检索全表读入的 1 万/5 万条性能仍未测。

## 10. 最终交付验收（2026-11-15）

### 10.1 自动化结果

```powershell
npm run typecheck                 # 通过（0 错误）
npm run build                     # 通过（仅既有 chunk / react-router 提示）

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_ask_e2e_acceptance.ps1
# RESULT 65 passed, 0 failed
# 隔离服务 3212 / db/ask-e2e.sqlite / fake model 3501
```

固定场景：

- A「LED 调光实验」+ A1「2 kHz、20% 占空比、5V USB，闪烁明显减轻」为直接命中。
- B「后续对照实验记录」不含检索词；B1 通过 `attempt_references` 引用 A1，进入「沿关系找到」。
- D「电源噪声与调光稳定性」不含检索词；通过 A→D `capture_links` 进入关系组。
- E/E1 名称含 LED 但与闪烁无关，可在发送前排除；F/F1 完全无关，不进入候选。
- 验证了逐候选展开、sessionStorage 返回恢复、`/graph?node=` 局部图中心为 A1、从 A1 进入 `/capture/A?experience=A1` 的旧经验预览且不自动建尝试、390px 手机选择/预览无横向溢出。
- 负面场景：无匹配不调用模型；来源修改显示「来源有更新」；来源删除后正文/链接不显示；伪造 `sourceId` 400 `invalid_sources`；不存在的合法 ID 409 `sources_unavailable`；`fake-ask-invalid-json` 失败态仍可浏览来源；浏览器 DOM/存储不含测试密钥。

### 10.2 真实模型人工核对

模型：已配置的 OpenAI 兼容模型，配置从主库复制到隔离库，主密钥沿用本机 `db/master.key`；未向模型发送主库真实记录。

| # | 问题 | 人工核对结论 | 结果文件 |
| --- | --- | --- | --- |
| 1 | 我以前试过哪些 PWM 调光办法？哪次失败了，当时条件是什么？两次结论有什么不同？ | 保留 500 Hz / 20% / 25°C 与 2 kHz / 20% / 10 分钟条件；区分观察与推断；未把「频率」写成唯一原因 | （原始输出未随仓库提供） |
| 2 | 两次调光实验的结果为什么不同？请把各自条件写清楚。 | 并列 2 kHz+USB 与 2 kHz+3.7V 电池、同时移动桌面；明确说明无法归因，`insufficientEvidence=true`，`missing` 指出缺少单变量对照 | （原始输出未随仓库提供） |
| 3 | 这条经验后来在哪次尝试中用过？ | 正确引用原观察和后续台灯调光尝试；说明台灯尝试沿用了 2 kHz/20% 参数；所有 sourceIds 属于发送集合 | （原始输出未随仓库提供） |

人工检查口径：逐条对照原文，确认 observation 不夹带推断、condition 不凭空补全、结果差异是否交代各自条件、`missing` 是否真正的缺口。3/3 通过，但这只是小样本，不是统计意义上的模型质量结论。三例真实回答都没有填 `contradictions` 数组；结构化矛盾形态只由 `fake-ask-contradiction` 自动化覆盖，真实模型能否稳定输出仍需更多样本。

### 10.3 截图

- （截图未随仓库提供）：直接命中 / 沿关系找到两组与排除操作。
- （截图未随仓库提供）：发送前核对，问题、目标模型和逐条证据。
- （截图未随仓库提供）：带来源回答、观察/推断来源卡。
- （截图未随仓库提供）：来源为中心的局部图。
- （截图未随仓库提供）：390px 候选与勾选。
- （截图未随仓库提供）：390px 回答与来源。

### 10.4 仍未验证

- 真实手机、Firefox、Safari；此前仅有本机 Chrome 无头 1280×900 / 390×844。
- 万级以上记录检索性能；目前 JS 全表过滤。
- 跨语言/同义改写召回；当前只做子串匹配与启发式关键词。
- 真实模型多样本稳定性、长记录截断、生成中删除来源的竞态；逻辑有保护，但未做自动化压力验证。

### 10.5 检索词扩展验收（2026-11-16）

- API：`python scripts/test_keyword_expansion.py` **46 passed / 0 failed**；已接入 `scripts/run_tests.py`。
- 浏览器 E2E：`scripts/e2e_keyword_expansion.mjs` **34 passed / 0 failed**（Chrome 1280×900 / 390×844，含键盘、返回恢复、来源删除）。
- 全量回归：`python scripts/run_tests.py` **1287 passed / 0 failed（13 套件）**。
- 真实模型：已配置的 OpenAI 兼容模型 固定集 24/24 次建议调用成功；只发送问题与当前检索词。
- 固定评测：（原始输出未随仓库提供） / `.md`；Oracle 与真实模型建议效果见 [`keyword-expansion-implementation.md`](./keyword-expansion-implementation.md) §6.3。
- 已知失败：`distractor-01` 的问题问「成功还是失败」，模型把「失败」也作为建议词；界面只把它当候选替代词，不自动应用。
