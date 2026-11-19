# 拾念 SHINIAN · 「换个说法找记录」实现记录（第一版）

日期：2026-11-16
范围：把用户问题与当前检索词交给模型生成 0–5 个替代表达，用户确认后作为 `expanded` 子串检索词交给现有候选检索；不改写记录、不改变问答生成与来源规则。
契约：[`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)。
状态：**已验证**。服务端端点、候选检索扩展、主题候选扩展和前端面板已落地；API **46 passed / 0 failed**、浏览器 E2E **34 passed / 0 failed**、全量 `run_tests.py` **1287 passed / 0 failed（13 套件）**；真实模型 已配置的 OpenAI 兼容模型 **24/24** 次建议调用成功；固定评测报告见 §6.3。已知失败案例 `distractor-01` 把「失败」当检索词（见 §6.3/§9）。

## 1. 当前状态

| 部分 | 状态 |
| --- | --- |
| `src/server/askKeywordSuggestions.ts` | 已实现：system/user prompt、`parseKeywordSuggestions`、`generateKeywordSuggestions`、10 分钟内存幂等缓存（`runKeywordSuggestionOnce`）、配置读取与错误分类 |
| `src/server/askAi.ts` | 已实现 `POST /api/ask/keyword-suggestions`（同步 200；502 `ai_failed`；409 配置/范围/幂等错误） |
| `src/server/askData.ts` | 已实现 `normalizeExpandedTerms`（5/40/120 限制）与 `searchAskCandidates({ expandedTerms })`；候选新增 `matchedKeywords` 和 `matchKind='expanded'` |
| `src/server/topicRoutes.ts` / `topicService.ts` | `GET /api/topics/:id/ask-candidates` 已接受重复 `expanded`，`searchTopicAskCandidates` 透传 `expandedTerms`，主题范围仍 `directOnly` |
| `src/client/components/KeywordExpansionPanel.tsx` + `AskPage.tsx` | 已实现面板：生成/取消/勾选/编辑/移除/应用/清除；`AskPage` 把 `expandedKeywords` 加入候选请求并写入 sessionStorage |
| `src/client/api.ts` / `types.ts` | 已实现 `suggestAskKeywords`、重复 `expanded` 参数、响应类型与错误文案 |
| `scripts/fake_model_server.py` | 已有 `fake-suggest-keywords*` 场景（普通、空数组、5 项、6 项、空词、单项超长、合计超长、非法 JSON、非法结构、timeout） |
| `scripts/eval_keyword_expansion.py` + `keyword_expansion_eval_cases.json` | 已运行 24 例；Oracle 引擎评测与真实模型建议效果见 §6.3 |
| `scripts/test_keyword_expansion.py` | 已运行 **46 passed / 0 failed**，并已接入 `run_tests.py` |
| `scripts/run_tests.py` | 全量回归 **1287 passed / 0 failed（13 套件）** |
| 浏览器 E2E | `scripts/e2e_keyword_expansion.mjs`：**34 passed / 0 failed**（桌面 + 390、键盘、来源删除/返回恢复） |
| 真实模型联调 | 已配置的 OpenAI 兼容模型，24/24 次建议调用成功；固定集效果与失败案例见 §6.3 |

截至本轮验收：服务端、前端面板/分组、假模型场景、API 验收脚本、固定评测脚本、浏览器 E2E 均已运行。页面分组顺序与后端排序的差异见 §5.2。

## 2. 设计边界

### 2.1 只改写检索词，不做语义搜索

- 模型只做「把当前问法和检索词换成几个更可能出现在旧记录里的短词」这一件事；不接触记录，不判断哪条相关，不生成答案。
- 扩展词是普通字符串，最终仍走 `searchAskCandidates` 的子串匹配（ASCII 大小写不敏感，中文按字面）；**同义词只有恰好字面出现在记录里才有用**，不做 embedding、向量、分词、stemming、翻译或相似度。
- 模型建议「频闪」不代表记录里有「频闪」；候选为空是正常结果，界面必须允许回到原关键词，不得包装成「没有相关记录」的结论。

### 2.2 不发送记录正文

- 请求只有 `question`、`keywords`、`configVersion`、可选 `topicId/scopeHash`；prompt 只拼问题与当前检索词（见 §4）。
- 不发送来源 ID、sourceKeys、记录标题/结果、主题标题/探索问题/成员列表或统计。
- 主题 `scopeHash` 只用于服务端校验和返回当前 scope 摘要；模型不知道主题存在。

### 2.3 不落库

- 没有新迁移、没有新表、不写 `record_queries`、不写 `mutation_receipts`。
- `runKeywordSuggestionOnce` 只在进程内 `Map` 缓存 10 分钟，用于同一 `operationId` 的重复点击/网络重试；重启丢失，换进程不共享。
- 响应不进入 JSON 导出或整库备份；只有 `terms` 与配置/scope 快照在内存里短暂存在。

### 2.4 用户确认后才应用

- 模型返回的 `terms` 默认全部不勾选；用户可以编辑、移除、勾选 1–5 个，再点「用这些词查找」。
- 原问题与原检索词不被替换；扩展词是追加条件，清除后恢复原检索。
- 不自动发送问答、不自动勾选候选、不自动生成回答。

## 3. 与现有 search / ask / topic 的复用关系

| 层 | 复用/新增 |
| --- | --- |
| 关键词归一化 | 复用 `normalizeKeywords`、`suggestKeywordsForQuestion`；新增 `normalizeExpandedTerms`（只做 trim、长度、去重、过滤原词） |
| 候选检索 | 复用 `searchAskCandidates`：原有打分、日期范围、`attempt_references` / `capture_links` 一跳、`matchKind` 排序全部保留；只增加 `expandedTerms` 入参与 `expanded` 命中分支 |
| 主题候选 | 复用 `searchTopicAskCandidates` / `buildTopicAskScope`；主题范围仍 `directOnly`，不加载引用/链接，不做关系扩展 |
| 模型配置 | 复用 `getSettingsRow`、`decryptApiKey`、`callModel`、`classifyError`、`getAiTimeoutMs`；不新增配置项 |
| 问答生成 | `/api/ask/preview`、`/api/ask/queries`、`contextToken`、`record_queries`、来源删除清洗全部不变；扩展词不是问答上下文 |
| 全局搜索 | `/api/search` 不变；本功能只影响 ask 候选，不改变统一搜索的 `LIKE` 行为 |
| 前端 | 复用 `AskPage` 的候选选择/预览/生成；新增 `KeywordExpansionPanel` 和 `expandedKeywords` 现场字段 |

设计取舍：

- **为什么复用候选检索而不是 `/api/search`**：ask 候选已有日期范围、主题 scope、`attempt_references` / `capture_links` 一跳与直接/关系分组；复用它保证「扩展后」和「原检索」只有关键词集合不同，排序口径可解释。`/api/search` 是全局统一搜索，不参与问答的 scope 与来源选择。
- **为什么不让模型看记录**：一旦发送正文，模型可能把「没找到」归因于记录内容，或编造相关性；本功能只需要词表，发正文既增加隐私面也增加费用。也避免模型输出被误当「语义相关度」。
- **为什么用内存幂等而不是回执表**：建议没有业务副作用，10 分钟足够覆盖双击/重试；写 `mutation_receipts` 会制造一份可导出的请求痕迹，和「数据不落库」冲突。
- **为什么主题也要 scopeHash**：主题成员变化会让同一问题在不同 scope 下得到不同候选；建议响应带当前 `topic` 摘要，UI 可发现范围漂移。模型本身不使用 scope。

## 4. 数据流

1. 用户在 `/ask`（或主题 `/ask?topicId=...`）填写问题、检索词，点「换些关键词找找」。
2. `KeywordExpansionPanel` 读取 AI 设置，展示将发送的问题、当前检索词、目标模型和「不发送记录正文」提示。
3. 用户点「生成替代词」：前端生成新的 `operationId`，提交 `question/keywords/configVersion/topicId/scopeHash`；同一次点击内重试复用同一 `operationId`。
4. 服务端按契约校验配置与 scope，向模型发送只有两行内容的 prompt；模型返回 `{"terms":[...]}`；服务端过滤原词/重复/超限，返回 `terms`。
5. 面板展示候选词（默认不勾选）；用户勾选/编辑后点「用这些词查找」，前端以**重复** `expanded` 参数重新请求 candidates。
6. 服务端只在本机 SQLite 做子串检索：原始关键词与扩展词都计入 `matchedKeywords`；仅扩展词命中的候选标 `matchKind='expanded'`。
7. 用户像原来一样勾选 1–8 条记录 → `/api/ask/preview` → `/api/ask/queries`。扩展词不进入预览/生成的 `contextToken`，也不自动进入 prompt；问答仍只发送用户确认的记录。

## 5. 前端交互

### 5.1 面板

- 入口按钮：`换些关键词找找`（`data-testid="ask-expand-trigger"`），放在检索词输入框旁；展开后 `aria-expanded`。
- 面板头部展示「将发送的问题」「当前检索词」「目标模型」；明确写「只发送问题与检索词，不发送历史记录正文」「可能产生费用」。
- 未配置/停用时显示「去设置 AI」链接；仍可手动改检索词并正常查找。
- 生成按钮 `生成替代词`；生成中变为 `取消生成`；取消后保留原问题与检索词，提示「已取消」。
- 结果每项可勾选、可编辑（≤40 字）、可移除；最多 5 项；生成后默认全部不勾选。
- `用这些词查找` 应用选中的词；`清除扩展` 清空扩展词并按原检索重新查找。
- 空结果（`terms:[]`）显示「这次没有生成可用的替代词」，不报错。

### 5.2 候选展示

- 当前页面分组顺序：`直接命中` → `沿关系找到` → `换词后找到`（`换词后找到` 对应 `matchKind='expanded'`，只在有扩展词或扩展候选时出现）。后端候选数组本身排序是 `direct → expanded → relation`；页面按分组块展示，所以关系组会先于扩展组出现。若产品要求与后端顺序一致，只需调整 `AskPage` 中两个 `renderGroup` 的先后。
- 每张候选卡显示 `matchedKeywords` 命中词与 `matchReasons`；扩展词命中显示「扩展词命中：<term>」，不显示「相似度」「语义匹配」。
- 扩展词命中不改变 `outcome`（成功/失败/未判定）排序；结果评价仍不参与排序。
- 勾选/预览/发送沿用现有 AskPage 流程；应用扩展词后保留仍在结果中的已选来源，被移除的给出提示。

### 5.3 状态与错误

| 状态 | 前端行为 |
| --- | --- |
| `ai_not_configured` / `ai_disabled` | 面板禁用生成，给 `/settings/ai` 链接；原检索仍可用 |
| `config_changed` | 提示重新读取配置；不自动重试 |
| `topic_scope_changed` | 提示主题范围变化，刷新主题/重新检索后再展开 |
| `operation_key_conflict` | 提示本次操作已被另一请求使用；换新操作或等待 |
| 502 `ai_failed` | 显示 `errorCode` 对应文案；保留当前候选和关键词，可重试 |
| 取消 | 本地显示「已取消」，不保留半成品 terms |

- 问题/检索词/主题 scope 变化时自动取消旧请求并清空面板结果，迟到响应丢弃（`seq` + request key 双校验）。
- 390px 宽度下按钮与词条换行，不横向溢出；面板可用键盘操作。

## 6. 固定评测方法与结果

### 6.1 评测集与运行

`scripts/eval_keyword_expansion.py` 读取 `scripts/keyword_expansion_eval_cases.json`：

- 24 条固定 case：`direct` / `paraphrase` / `no_relevant` / `distractor` 各 6 条；
- 每条包含问题、原始关键词、人工固定的 `oracleExpandedTerms`、`expectedRelevantIds`（localId）与测试记录；
- 每个 case 用独立隔离库写入记录、跑原始关键词 top5 与 oracle 扩展词 top5、再调用 `POST /api/ask/keyword-suggestions` 记录耗时/usage，最后删除记录；
- 输出 （原始输出未随仓库提供） 与 `.md`；`expectedRelevantIds` 是人工固定值，**排名分数不作为正确率**。

### 6.2 脚本参数（已按契约修正）

1. `search_top5` 现在把 `expanded` 作为列表传入，并用 `urlencode(..., doseq=True)` 生成重复参数；这与契约的 `expanded=<term>&expanded=<term>` 一致。
2. `suggestion_call` 先从 `GET /api/settings/ai` 读取 `configVersion` 再提交；主题 case 仍需自行补 `topicId/scopeHash`（当前固定集是全库 case）。

这两处已不是阻塞项；若后续脚本再改成逗号拼接或省略 `configVersion`，评测结果会失真，必须回退修正。

### 6.3 实跑结果（2026-11-16）

报告：（原始输出未随仓库提供） / `.md`；`unverified=false`。
真实模型：已配置的 OpenAI 兼容模型；24/24 次建议调用成功；每次只发送 question + current keywords。

**Oracle 引擎评测**（人工替代表达，用于确认检索引擎能把新词真的用起来）：

| 分组 | 案例 | Oracle 改善 | 原相关命中 | Oracle 扩展后相关命中 | Oracle 新增无关 |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct | 6 | 3 | 7 | 10 | 0 |
| paraphrase | 6 | 6 | 0 | 6 | 0 |
| no_relevant | 6 | 0 | 0 | 0 | 0 |
| distractor | 6 | 2 | 5 | 7 | 0 |

**真实模型建议效果**（模型返回的 terms 重新检索）：

| 分组 | 模型建议改善案例 | 模型建议相关命中 | 模型新增无关 | 模型改变原意 |
| --- | ---: | ---: | ---: | --- |
| direct | 0 | 7 | 0 | 无 |
| paraphrase | 2 | 2 | 0 | 无 |
| no_relevant | 0 | 0 | 0 | 无 |
| distractor | 1 | 6 | 0 | `失败` |

- 单次建议耗时：3,945–18,181 ms，平均约 7,961 ms。
- token 用量：输入 7,280 / 输出 2,440 / 合计 9,720（24 次）。
- 已知失败案例：`distractor-01` 的问题问「成功还是失败」，模型把「成功/失败」也作为建议词；其中「失败」命中了干扰记录，被报告为改变原意的词。这个例子说明结果词不能可靠地当检索词，界面只作为“候选替代词”展示，用户仍需手动勾选。
- 模型建议没有在 no_relevant 组凭空产生命中；除 distractor-01 外没有新增无关结果。

结果口径：
- `paraphrase` 组 Oracle 全部 6 例从 0 命中变为命中；真实模型建议只能找回 2/6，说明近义改写仍依赖记录里是否真的有这些字面词。
- `direct` 组 Oracle 可以找回更多同记录的相关视图；真实模型建议没有增加 top5 相关命中数，因为原词已经命中。
- 排名分数不作为正确率；`newIrrelevantCount` 只统计新进入 top5 的无关记录。

### 6.4 假模型与人工核对

- 假模型场景：`fake-suggest-keywords`（默认返回 `闪烁/LED/频闪`）、`fake-suggest-keywords-empty`（空数组）、`fake-suggest-keywords-five`（5 项）、`fake-suggest-keywords-six`（6 项 → invalid_response）、`fake-suggest-keywords-empty-term`（空词）、`fake-suggest-keywords-overlong`（41 字）、`fake-suggest-keywords-total-overlong`（>120 字）、`fake-suggest-keywords-invalid-json`、`fake-suggest-keywords-invalid-shape`、`fake-suggest-keywords-timeout`。
- 真实模型已经用固定集另跑一次：已配置的 OpenAI 兼容模型，只发送隔离评测问题与当前词；24/24 次返回 200，`distractor-01` 的「成功/失败」被列为改变原意的候选。结果只作为检索线索人工核对，不进入 CI。

## 7. 测试与验收结果

### 7.1 后端用例

1. 未登录 401；`operationId`/`configVersion`/`topicId`/`scopeHash` 类型错误 → 400 `invalid_request`。
2. 空问题/501 字、关键词 201 字 → 400 `invalid_question` / `invalid_keywords`。
3. 未配置/停用 → 409 `ai_not_configured` / `ai_disabled`；`configVersion` 不匹配 → 409 `config_changed`。
4. 主题不存在 → 404 `topic_not_found`；scopeHash 不匹配 → 409 `topic_scope_changed`；全库带 scopeHash → 400。
5. 成功：`terms` 0–5、每项 ≤40、合计 ≤120；`replayed:false`；`usage/durationMs/generatedAt` 有值。
6. 同 `operationId` 同 body → 200 `replayed:true` 且 terms 相同；同键改 question → 409 `operation_key_conflict`；并发同键只调一次模型。
7. 空 terms → 200 空数组；6 项/41 字/合计 121 字/非 JSON/字段多余 → 502 `ai_failed` + `errorCode='invalid_response'`。
8. timeout → 502 `ai_failed` + `errorCode='timeout'`；客户端 abort 不应留下缓存。
9. `/__last` 断言 prompt 只有「用户问题」「当前检索词」，不含任何记录正文/来源 ID/主题标题。
10. candidates：无 `expanded` 与旧响应一致；重复 `expanded` 最多 5；空值/>5/>40/>120 → 400 `invalid_expanded_keywords`；`expandedKeywords` 回显。
11. candidates：仅扩展词命中的候选 `matchKind='expanded'`、`matchedKeywords` 正确；同时命中原始词仍 `direct`；`expanded` 不触发关系扩展；排序 direct→expanded→relation。
12. topic candidates：`expanded` 只在 scope 内命中；不出现 relation；404/400 与全库一致。
13. 数据不落库：调用前后 `record_queries` 行数不变、无新表/迁移、导出不含 suggestions、重启后同 operationId 重新调用。

实际结果：`python scripts/test_keyword_expansion.py` **46 passed / 0 failed**；已接入 `scripts/run_tests.py`。

### 7.2 浏览器 E2E

`scripts/e2e_keyword_expansion.mjs` 覆盖：

- 打开面板 → 生成 → 勾选/编辑/移除 → 应用 → `expanded` 请求 → `换词后找到` 分组与 `matchedKeywords` → 清除扩展 → 原结果恢复。
- 打开原记录再返回保留问题/扩展词/分组；来源删除后扩展结果消失。
- 改问题、切主题后扩展状态重置；键盘可勾选；建议请求总次数与两次主动生成一致。
- 1280×900 与 390×844 无横向溢出，浏览器存储/DOM 不含 fake key。

实际结果：**34 passed / 0 failed**；截图：（截图未随仓库提供）。

### 7.3 全量回归

`python scripts/run_tests.py`：**1287 passed / 0 failed（13 套件）**，包含 `test_keyword_expansion.py`。本功能不改变既有问答/搜索/主题 API 的契约行为（只新增可选 `expanded` 字段与端点）。

## 8. 既有文档回填记录（已完成，2026-11-16）

已按原计划修改以下文档（只改 `docs/**`，未改 README）：

- `docs/ask-api-contract.md`：第 3 行日期/契约来源与链接；§1 三个扩展词常量；§3.1 重复 `expanded` 参数、`expandedKeywords` 与候选 `matchedKeywords`；§3.3 扩展词权重、`matchKind='expanded'`、排序 direct→expanded→relation；§11 `invalid_expanded_keywords`；§12 语义检索说明；导出 `schemaVersion` 更正为当前 7。
- `docs/ask-notes.md`：第 3–7 行版本说明与两个新契约链接；§1 状态表（`askKeywordSuggestions.ts`、`KeywordExpansionPanel.tsx`、`test_keyword_expansion.py`、评测脚本）；§2.1 字面扩展说明；§5 代码位置；§8 已知限制；§10.5 验收结果（API 46/0、E2E 34/0、全量 1287/0、真实模型 24/24、报告路径、`distractor-01`）。
- `docs/topic-api-contract.md`：第 3 行版本/链接；§8.2 重复 `expanded`、`expandedKeywords`、`matchedKeywords`、`matchKind`（direct/expanded）与 `invalid_expanded_keywords`。
- `docs/topic-notes.md`：第 3 行版本/链接；§4.1 主题 scope 内的 `expanded` 与 `matchKind` 说明。

## 9. 已验证结果与剩余边界

| 事项 | 现状 | 说明 |
| --- | --- | --- |
| 真实模型检索词质量 | **已验证调用**：已配置的 OpenAI 兼容模型 24/24 次返回 200 | 质量不是统计结论；`distractor-01` 把「失败」当检索词，说明建议不能当事实 |
| 扩展词是否真的帮助找回 | **已验证固定集**：Oracle `paraphrase` 6/6 改善（0→6 命中）；真实模型建议改善 2/6 | 报告 （原始输出未随仓库提供）；分数不作为正确率 |
| 语义不一致 | 已知边界：模型可能给近义但记录中不存在的词；字面匹配会 0 命中 | 固定集 `no_relevant` 6/6 均无命中；界面「没有命中」不代表没有记录 |
| 长词/中文分词 | 未单独压测；只做 40 字上限与字面子串 | 短词可能过宽；继续观察 `newIrrelevantCount` 与人工接受率 |
| 建议被误当事实 | UI 只写「候选替代词」，禁止「相似度/已确认」文案 | 真实模型 `distractor-01` 的「失败」案例已记录；用户仍需手动勾选 |
| 前端分组顺序 | 后端候选排序 direct→expanded→relation，页面按块展示 direct→relation→expanded（`换词后找到`） | E2E 34/0；顺序是否调整由产品决定，不影响接口 |
| 数据不落库 | **已验证**：代码核对无新表、无 `record_queries`/`mutation_receipts` 写入；建议只驻留 10 分钟内存 | 自动化未单独断言调用前后行数；导出/备份不含建议 |
| 并发/重复点击 | 同 `operationId` 同指纹已验证回放/合并；不同 `operationId` 不排队 | API 46/0 含幂等与冲突断言；慢网双击仍建议前端禁用按钮 |
| 成本 | 24 次真实建议：输入 7,280 / 输出 2,440 / 合计 9,720 tokens；单次 3,945–18,181 ms | 无预算控制；界面已提示可能产生费用 |
| 多用户/配额 | 不支持；内存缓存是单进程 | 保持本机单人边界，不做跨用户共享 |

## 10. 代码位置

| 文件 | 内容 |
| --- | --- |
| `src/server/askKeywordSuggestions.ts` | prompt、解析/校验、生成、内存幂等、配置读取、错误分类 |
| `src/server/askAi.ts` | `POST /api/ask/keyword-suggestions`；`GET /api/ask/candidates` 的 `expanded` 解析与响应 |
| `src/server/askData.ts` | `normalizeExpandedTerms`、`searchAskCandidates({expandedTerms})`、`matchKind='expanded'`、`matchedKeywords` |
| `src/server/topicRoutes.ts` / `topicService.ts` | 主题候选的 `expanded` 透传与 scope 校验 |
| `src/server/askTypes.ts` | 新增常量、`AskKeywordSuggestionsResponse`、`expandedKeywords`、`matchedKeywords`、`matchKind='expanded'` |
| `src/client/components/KeywordExpansionPanel.tsx` | 展开面板、生成/取消、词条编辑/选择/应用/清除 |
| `src/client/pages/AskPage.tsx` / `api.ts` / `types.ts` | `expandedKeywords` 状态、candidates 请求、sessionStorage、分组与 API 类型 |
| `scripts/fake_model_server.py` | `fake-suggest-keywords*` 场景与 `/__last` 记录 |
| `scripts/test_keyword_expansion.py` | API/边界验收：**46 passed / 0 failed**，已接入 `run_tests.py` |
| `scripts/e2e_keyword_expansion.mjs` | 浏览器 E2E：**34 passed / 0 failed**（Chrome 1280×900 / 390×844） |
| `scripts/eval_keyword_expansion.py` + `keyword_expansion_eval_cases.json` | 固定评测集 24 例与报告生成；已运行，报告 （原始输出未随仓库提供） |
