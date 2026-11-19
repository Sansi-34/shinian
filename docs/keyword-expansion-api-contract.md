# 拾念 SHINIAN · 「换个说法找记录」接口契约（第一版）

日期：2026-11-16。本契约冻结「检索词扩展」的端点、字段、上限与错误码：模型只根据用户问题与当前检索词提出最多 5 个可编辑的替代表达，用户确认后这些词作为**字面子串**追加到现有候选检索。服务端实现以 `src/server/askKeywordSuggestions.ts`、`src/server/askAi.ts`、`src/server/askData.ts`、`src/server/topicRoutes.ts`、`src/server/topicService.ts` 为准；如与本文偏离，以 `docs/keyword-expansion-implementation.md` 记录为准。

## 0. 目标与边界

- 解决「我记得这件事，但当时用的词和现在想的不一样」：模型把问题改写成几个短检索词，用户挑选后交给现有 `searchAskCandidates` 做子串匹配。
- **这是检索词扩展，不是语义搜索**：
  - 不做 embedding、向量检索、同义词库、分词、stemming、翻译、拼音或相似度打分；
  - 扩展词必须在记录文本中**字面出现**才算命中；模型建议「调光」不代表记录里一定有「调光」；
  - 模型不回答原问题、不判断记录相关性、不生成事实结论、不引用来源。
- 模型只接收问题与当前检索词，**不接收任何记录正文、来源 ID、主题标题、主题成员或统计**。
- 建议默认不自动应用：用户逐项选择后才作为 `expanded` 参数进入候选检索；不自动发送、不自动生成回答。
- 不新增业务表、不写 `record_queries`、不进入 JSON 导出/整库备份内容；只在进程内保留 10 分钟幂等缓存（见 §4）。
- 本功能不改变 `/api/ask/preview`、`/api/ask/queries`、主题问答范围与来源删除规则；这些仍以 `docs/ask-api-contract.md` 与 `docs/topic-api-contract.md` 为准。

## 1. 常量与上限

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `ASK_MAX_QUESTION_CHARS` | 500 | 问题字符上限（trim 后） |
| `ASK_MAX_KEYWORDS_CHARS` | 200 | 当前检索词拼接后的字符上限 |
| `ASK_MAX_SUGGESTION_TERMS` | 5 | 模型返回/前端采用的扩展词最大项数 |
| `ASK_MAX_SUGGESTION_TERM_CHARS` | 40 | 单个扩展词最大字符数（按 Unicode 码点计） |
| `ASK_MAX_SUGGESTION_TOTAL_CHARS` | 120 | 全部扩展词合计字符上限 |
| `ASK_MAX_CANDIDATES` / `ASK_DEFAULT_CANDIDATES` | 50 / 20 | 候选检索沿用值 |
| 模型输出 | `maxOutputTokens=220`，`temperature=0.2` | 只够输出短词表 |
| 模型超时 | 默认 60000ms（`SHINIAN_AI_TIMEOUT_MS`） | 与现有 AI 配置共用 |

`expanded` 查询参数与模型返回的 `terms` 使用同一组 5/40/120 上限。

## 2. 共享端点：`POST /api/ask/keyword-suggestions`

全库问答与主题问答共用同一个端点；主题上下文通过可选 `topicId` 表达，不存在单独的 `/api/topics/:id/keyword-suggestions`。

### 2.1 请求

```json
{
  "operationId": "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "question": "上次 LED 闪烁是怎么处理的？",
  "keywords": "LED 闪烁",
  "configVersion": 4,
  "topicId": "topic-1763200000000-ab12cd",
  "scopeHash": "9f2c...64位hex..."
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `operationId` | 是 | trim 后 1–200 字符；同一次用户点击复用同一个值 |
| `question` | 是 | trim 后 1–500 字符；只用于模型改写，不发送记录 |
| `keywords` | 否 | 空格分隔字符串或字符串数组；拼接后 ≤200 字符；不传时由 `suggestKeywordsForQuestion` 从问题提取，显式空字符串/空数组表示当前没有检索词 |
| `configVersion` | 是 | 正整数（数字或纯数字字符串）；取自候选响应 `ai.config.configVersion`，用于确认模型配置未变 |
| `topicId` | 否 | 主题 ID；空字符串/null 视为全库 |
| `scopeHash` | 否 | 主题范围指纹；提供 `topicId` 时建议总是传；`topicId` 不存在时传非空值 → 400 |

### 2.2 校验顺序

实现按以下顺序返回，测试应按此断言（顺序不同会改变「未配置模型 + 坏主题」这类组合的结果）：

1. `question`：空/超长 → 400 `invalid_question`，`field:'question'`。
2. `keywords`：类型不支持/拼接 >200 → 400 `invalid_keywords`，`field:'keywords'`。
3. `topicId`：非字符串 → 400 `invalid_request`，`field:'topicId'`；空字符串 null 化。
4. `operationId`：缺失/空/>200 → 400 `invalid_request`，`field:'operationId'`。
5. `configVersion`：非正整数 → 400 `invalid_request`，`field:'configVersion'`。
6. `scopeHash`：非字符串 → 400 `invalid_request`，`field:'scopeHash'`；无 `topicId` 但传非空 `scopeHash` → 400 `invalid_request`，`field:'scopeHash'`。
7. 模型配置：无配置/无 API Key → 409 `ai_not_configured`；已停用 → 409 `ai_disabled`。
8. `configVersion` 与当前 `ai_settings.config_version` 不一致 → 409 `config_changed`。
9. 主题：`topicId` 不存在 → 404 `topic_not_found`；`scopeHash` 非空且与当前 `buildTopicAskScope(topicId).scopeHash` 不一致 → 409 `topic_scope_changed`。
10. 幂等：同 `operationId` 同指纹复用；不同指纹 → 409 `operation_key_conflict`（见 §4）。
11. 调用模型；失败 → 502 `ai_failed`（见 §8）。

注意第 7–8 步在主题检查之前：未配置模型时即使 `topicId` 不存在也返回 409 `ai_not_configured`，不会先报 404。

### 2.3 成功响应（200）

```json
{
  "question": "上次 LED 闪烁是怎么处理的？",
  "keywords": ["LED", "闪烁"],
  "terms": ["频闪", "LED 闪烁", "调光"],
  "config": { "id": "default", "name": "本机模型", "modelId": "your-model", "configVersion": 4 },
  "usage": { "inputTokens": 42, "outputTokens": 18, "totalTokens": 60 },
  "durationMs": 812,
  "generatedAt": 1763280000000,
  "topic": {
    "topicId": "topic-1763200000000-ab12cd",
    "topicTitle": "PWM 调光实验",
    "topicName": "PWM 调光实验",
    "scopeHash": "9f2c...",
    "topicRevision": 3,
    "thoughtCount": 2,
    "experienceCount": 1,
    "attemptCount": 3,
    "allowedSourceCount": 8,
    "recordCount": 8
  },
  "replayed": false
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `question` / `keywords` | 服务端归一化后的回显；`keywords` 是拆回的数组 |
| `terms` | 0–5 个可编辑扩展词；已去掉与当前 `keywords` 相同或大小写/空白等价的项；**可以为空**，空不是错误 |
| `config` | 本次实际使用的模型配置快照；成功时非 null |
| `usage` | 模型返回的 token 用量；上游未提供时为 null |
| `durationMs` | 模型调用耗时（不是 HTTP 总耗时） |
| `generatedAt` | 首次生成时间；幂等回放保持首次时间 |
| `topic` | 仅请求带 `topicId` 时出现；是服务端当前 `TopicScopeSummary`，不是模型输出 |
| `replayed` | true 表示命中进程内幂等缓存；响应内容与首次一致 |

- 响应不包含 `sourceKeys`、记录正文、`expanded` 或任何检索结果；扩展词的使用是下一步候选检索的事。
- `terms` 只是建议，不代表记录中存在这些词，也不代表语义相近。

## 3. 模型输出结构与校验

System prompt 必须表达（实现可微调措辞，语义保留）：

- 只输出一个 JSON 对象，不要解释、Markdown 或代码围栏。
- 字段只有 `{"terms": string[]}`；不回答原问题，不猜测用户经历，不编造记录/来源/链接。
- 每项 1–40 字符，最多 5 项，合计 ≤120 字符；不重复当前检索词；不写句子、问题、来源 ID、URL 或记录正文。
- 没有合适建议时返回 `{"terms":[]}`；不为凑数返回最近记录、宽泛词或无关词。
- 专业词/缩写只是可选检索建议，不代表已确定原因。

服务端校验（`parseKeywordSuggestions`）：

| 检查 | 失败结果 |
| --- | --- |
| JSON 解析（允许代码围栏作为容错，取第一个 `{` 到最后一个 `}`） | `invalid_response` |
| 严格对象，只允许 `terms` 字段 | `invalid_response` |
| `terms` 为数组、每项 1–40 字符、最多 5 项 | `invalid_response` |
| 空词、控制字符、与当前关键词相同、重复项 | 空词/控制字符 → `invalid_response`；相同/重复项直接过滤，不算失败 |
| 全部有效项合计 >120 字符 | `invalid_response` |

模型调用参数：`maxOutputTokens: 220`、`temperature: 0.2`、`timeoutMs: getAiTimeoutMs()`（默认 60000）。失败统一由路由转成 502 `ai_failed`，`errorCode` 保留 `invalid_response` / `timeout` / `auth` / `unreachable` / `model_unavailable` / `rate_limited` 等分类；`message` 截断 300 字符。

## 4. 幂等与取消

### 4.1 幂等

```text
fingerprint = SHA-256(JSON.stringify({
  op: 'ask-keyword-suggestions',
  question,
  keywords: 归一化后的数组（保持顺序）,
  topicId: string | null,
  scopeHash: string | null,
  configVersion: number
}))
```

- 同 `operationId` 同指纹：返回缓存响应，`replayed:true`；同一进程内并发相同请求会合并为一次模型调用。
- 同 `operationId` 不同指纹：409 `operation_key_conflict`（实现内部 helper 先抛 `generation_in_progress`，路由映射为该错误码）。
- 缓存 TTL 10 分钟，仅内存；服务重启/换进程后丢失，重放会重新调用模型。
- 失败不缓存；用同一 `operationId` 重试会重新调用。
- 缓存不写数据库、不写 `mutation_receipts`、不进入导出或备份；缓存内容只有响应 JSON（含配置快照与主题 scope 摘要），不含任何记录正文。

### 4.2 取消

- 本端点同步返回，没有任务 ID、没有 `POST .../cancel` 路由。
- 客户端取消 = abort 当前 HTTP 请求；路由监听 `req.raw` 的 `close`，abort 上游模型的 `AbortSignal`；不写任何持久化数据。
- 取消后不会收到成功响应；UI 显示「已取消」即可，不自动重试。模型侧是否已产生费用无法撤回。
- 超时（默认 60 秒）与取消不是一回事：超时返回 502 `ai_failed`，`errorCode:'timeout'`；取消通常没有响应。
- 前端应对同一按钮做禁用，避免并发点击产生多个不同 `operationId` 的模型调用；服务端不提供全局排队/配额。

## 5. 主题 scopeHash

### 5.1 计算

`scopeHash` 与 `docs/topic-api-contract.md` §8.1 完全一致：

```text
SHA-256(JSON.stringify({
  topicId,
  topicRevision,
  thoughtCaptureIds: sorted,
  thoughtAttemptIds: sorted,
  experienceIds: sorted,
  experienceSourceKeys: sorted
}))
```

### 5.2 规则

- `topicId` 为空 → 全库上下文；`scopeHash` 必须为空/null，否则 400。
- `topicId` 有值：
  - 主题不存在 → 404 `topic_not_found`（在模型配置检查之后）。
  - `scopeHash` 非空且不匹配当前 scope → 409 `topic_scope_changed`，提示重新展开。
  - `scopeHash` 省略/空字符串 → 不做一致性校验，响应仍返回当前 `topic` 摘要；此时客户端可能拿到与旧界面不同的 scope，建议总是传。
- **模型不接收主题信息**：prompt 里没有主题标题、探索问题、继续说明、成员数量或成员正文；`scopeHash` 只用于服务端校验响应上下文。
- 真正的记录范围限制不在这里：主题候选由 `/api/topics/:id/ask-candidates` 的 `searchTopicAskCandidates(scope)` 强制，预览/生成由 `topicScope.allowedSourceKeys` 强制；本端点不读取也不返回记录。

## 6. 候选检索新增 `expanded`

这是本功能对现有读取接口的唯一改动。`expanded` 是**重复 query 参数**，不是 JSON body、不是逗号分隔字符串。

### 6.1 `GET /api/ask/candidates`

```text
GET /api/ask/candidates?question=上次%20LED%20闪烁&keywords=LED%20闪烁&expanded=频闪&expanded=调光&limit=20
```

| 参数 | 说明 |
| --- | --- |
| `expanded` | 可重复 0–5 次；每次一个字符串，trim 后 1–40 字符，合计 ≤120 字符；不允许空值/控制字符；与当前 `keywords` 等价或重复的项被忽略 |
| 其他参数 | 与 `docs/ask-api-contract.md` §3.1 完全一致 |

- `expanded` 校验失败 → 400 `{error:'invalid_expanded_keywords', field:'expanded', message}`；超过 5 个原始项、单项 >40、合计 >120、空值/控制字符都失败。
- 不传 `expanded` 时与旧版逐字节等价：`expandedKeywords: []`，所有候选行为不变。

响应在旧 `AskSearchResponse` 上增加 `expandedKeywords`，候选增加 `matchedKeywords`：

```json
{
  "question": "上次 LED 闪烁是怎么处理的？",
  "keywords": ["LED", "闪烁"],
  "suggestedKeywords": "LED 闪烁",
  "expandedKeywords": ["频闪", "调光"],
  "range": { "from": null, "to": null, "fromLocal": null, "toLocal": null },
  "total": 4,
  "limit": 20,
  "candidates": [
    {
      "sourceKey": "attempt:att-...",
      "type": "attempt",
      "id": "att-...",
      "captureId": "cap-...",
      "title": "调整 PWM 频率",
      "snippet": "把频率调到 2 kHz 后肉眼未见闪烁",
      "date": 1763000000000,
      "dateKind": "observed",
      "state": "done",
      "outcome": "success",
      "archived": false,
      "matchReasons": ["扩展词命中：频闪"],
      "matchKind": "expanded",
      "matchedKeywords": ["频闪"],
      "referenceCount": 1,
      "openHref": "/attempt/att-..."
    }
  ],
  "ai": { "configured": true, "enabled": true, "config": { "id": "default", "name": "本机模型", "modelId": "your-model", "configVersion": 4 } },
  "generatedAt": 1763280000000
}
```

### 6.2 命中、打分与排序

| 项 | 规则 |
| --- | --- |
| 匹配方式 | 子串、ASCII 大小写不敏感；中文按字面匹配；不做分词/同义词/向量 |
| 原始关键词权重 | 结果文本 100 / 尝试步骤 20 / 所属念头或念头正文 5（每次出现） |
| 扩展词权重 | 与原始关键词相同（结果 100 / 标题 20 / 念头 5）；同一候选同时命中原始词与扩展词时分数相加 |
| `matchKind` | 有任一原始关键词命中 → `direct`；仅扩展词命中 → `expanded`；仅由引用/链接扩展带出 → `relation` |
| `matchedKeywords` | 该候选实际命中的原始词 + 扩展词，去重去空白；`relation` 候选为 `[]` |
| `matchReasons` | 原始命中原因照旧；每个扩展词追加 `扩展词命中：<term>`；浏览模式仍为 `最近记录` |
| 扩展锚点 | 只有 `matchKind='direct'` 的候选会触发 `attempt_references` / `capture_links` 一跳扩展；仅扩展词命中的候选不触发关系扩展 |
| 排序 | `direct` → `expanded` → `relation`；同组内 `score` 降序 → `date` 降序 → `sourceKey` 字典序 |
| `total` | 截断前全部候选数（包含 expanded 与 relation） |
| 无匹配 | 200，`total=0`、`candidates=[]`；扩展词全部无命中也是正常空结果 |

注意：扩展词分数再高也不会排在 `direct` 前面；`relation` 永远最后。`outcome`（成功/失败/未判定）不参与打分与排序。

### 6.3 `GET /api/topics/:id/ask-candidates`

- 参数与全库 candidates 相同，增加重复 `expanded`；校验和错误码相同（400 `invalid_expanded_keywords`）。
- 主题范围请求强制 `directOnly`：不加载 `attempt_references` / `capture_links`，不做关系扩展；`expanded` 只在主题 allowed scope 内检索，不会带回主题外记录。
- 响应仍是 `AskSearchResponse + topic + scope`；新增 `expandedKeywords`，候选仍带 `matchedKeywords`/`matchKind`（主题内可能为 `direct` 或 `expanded`，不会是 `relation`）。
- 主题不存在 404 `topic_not_found`；问题/关键词/日期/扩展词错误与全库一致。

## 7. 隐私与数据边界

- 建议请求只发送：`question`、归一化后的 `keywords`、`configVersion`、可选 `topicId`/`scopeHash`。**不发送**记录正文、结果、来源 ID、`sourceKeys`、主题标题/探索问题/成员列表、账号信息或密钥。
- 模型只输出 `terms` 字符串数组；即使模型输出包含记录内容或来源 ID，也按无效 JSON/字段校验拒绝，不进入检索。
- 候选检索完全在本地 SQLite 内完成；扩展词只作为参数化子串使用，不拼接 SQL、不执行指令。
- 服务端日志只记录 `errorCode`，不记录问题正文、扩展词或模型原始输出。
- 无新表；建议响应只在进程内缓存 10 分钟，不导出、不备份、不进入 `record_queries`，重启即丢失。

## 8. 错误码

| HTTP | `error` | 触发 | 附加字段 |
| --- | --- | --- | --- |
| 400 | `invalid_question` | 问题为空或 >500 字符 | `field:'question'`, `message` |
| 400 | `invalid_keywords` | 关键词类型不支持或拼接 >200 | `field:'keywords'`, `message` |
| 400 | `invalid_request` | `operationId` 缺失/空/>200；`configVersion` 非正整数；`topicId` 非字符串；`scopeHash` 非字符串或无主题却传值 | `field`, `message` |
| 400 | `invalid_expanded_keywords` | candidates 的 `expanded` 超过 5 项、单项 >40、合计 >120、空值/控制字符 | `field:'expanded'`, `message` |
| 401 | `unauthenticated` | 无会话 | — |
| 404 | `topic_not_found` | `topicId` 指向的主题不存在 | `message` |
| 409 | `ai_not_configured` | 未保存 API Key | `message` |
| 409 | `ai_disabled` | 配置存在但停用 | `message` |
| 409 | `config_changed` | `configVersion` 与当前配置不一致 | `message` |
| 409 | `topic_scope_changed` | `scopeHash` 与当前主题 scope 不一致 | `message` |
| 409 | `operation_key_conflict` | 同 `operationId` 不同指纹 | `message` |
| 502 | `ai_failed` | 模型调用或 JSON/字段校验失败 | `errorCode`, `message`（`errorCode` 为 `invalid_response`/`timeout`/`auth`/`unreachable`/`model_unavailable`/`rate_limited` 等） |

`/api/ask/candidates` 与 `/api/topics/:id/ask-candidates` 的其他错误码沿用 `docs/ask-api-contract.md` §11；新增的只有 `invalid_expanded_keywords`。

## 9. 客户端使用约定

- 点击「换些关键词找找」时生成新的 `operationId`；同一轮请求重试复用同一个；取得 `terms` 后不自动勾选、不自动重查。
- 展示 `terms` 为可勾选/可编辑的 chip；用户确认后把选中项作为**重复** `expanded` 参数追加到下一次 candidates 请求，原始 `keywords` 不变。
- 主题上下文把 `topicId` 与当前 `scopeHash` 一起传给建议端点；收到 409 `topic_scope_changed` 时刷新主题 scope 后重新展开，不保留旧 terms。
- 建议失败（`ai_failed`/409/网络错误）只影响扩展词，不清空当前关键词、不清空已有候选；用户可以继续手动改词或直接重查。
- 候选卡片显示 `expandedKeywords`、`matchedKeywords` 和 `matchKind` 徽标（直接命中/换词后找到/沿关系找到），不得把扩展词命中包装成「语义匹配」或「相似度」。

## 10. 本版不提供

- 语义/向量检索、同义词库、跨语言翻译、拼音、自动分词或学习排序。
- 自动应用扩展词、自动生成回答、自动创建尝试或引用。
- 建议历史、收藏、反馈学习、按用户画像个性化。
- 服务端全局并发队列、任务状态机或取消路由；本端点同步且无任务 ID。
- 把主题标题/成员内容作为模型输入；`scopeHash` 只校验上下文。
