# 拾念 SHINIAN · 「问我的记录」接口契约

日期：2026-11-14；2026-11-16 增补「检索词扩展」（`expanded` 候选参数与 `POST /api/ask/keyword-suggestions`）。本轮新增「问我的记录」只读问答：本地检索候选 → 用户勾选 1–8 条并预览实际发送内容 → 后台调用已配置模型 → 返回带真实来源的回答。服务端契约以 `src/server/askTypes.ts`、`src/server/askAi.ts`、`src/server/askData.ts` 与迁移 `drizzle/migrations/0009_ask.sql` 为准；检索词扩展另见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md) 与 [`keyword-expansion-implementation.md`](./keyword-expansion-implementation.md)，实现来源新增 `src/server/askKeywordSuggestions.ts`。实现如偏离本契约，必须在 `docs/ask-notes.md` 记录并说明。

## 0. 目标与只读边界

- 问答只读取现有 `captures`、`attempts`、`attempt_references`、`capture_links`；任何接口都不创建、修改、归档、删除念头/尝试/引用/关联，也不建立引用或关联关系。
- 问答的唯一写入是 `record_queries`：一行 = 一次问答任务，保存问题、关键词、日期范围、实际发送记录快照、回答、用量与错误。检索词扩展端点（`keyword-suggestions`）不写任何业务表，只在内存保留 10 分钟幂等缓存，见新契约。
- 生成记录与业务记录分离：删除一次问答不影响念头/尝试；删除念头/尝试也不删除问答，只清洗来源快照（见 §9）。
- 检索与预览**不要求**已配置模型；只有生成要求模型可用（未配置 409 `ai_not_configured`）。
- 模型只收到用户确认的 1–8 条记录，以及问题、关键词、日期范围；不发送未勾选记录、范围统计或账号信息。
- 本机单人；沿用 `shinian_sid` 会话，未登录 401 `{error:'unauthenticated'}`。无角色/权限分层。
- 导出 `GET /api/export`（当前 `schemaVersion: 7`）不包含 `record_queries`；整库 SQLite 文件备份包含该表。

## 1. 上限与常量

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `ASK_MAX_QUESTION_CHARS` | 500 | 问题字符上限（trim 后） |
| `ASK_MAX_KEYWORDS_CHARS` | 200 | 关键词以空格拼接后的字符上限 |
| `ASK_MAX_SUGGESTION_TERMS` | 5 | 扩展检索词最大项数 |
| `ASK_MAX_SUGGESTION_TERM_CHARS` | 40 | 单个扩展检索词最大字符数（按 Unicode 码点） |
| `ASK_MAX_SUGGESTION_TOTAL_CHARS` | 120 | 全部扩展检索词合计字符上限 |
| `ASK_MAX_RECORDS` | 8 | 单次发送记录数上限 |
| `ASK_MAX_CHARS` | 12000 | 实际 user prompt 字符上限 |
| `ASK_MAX_CANDIDATES` | 50 | 候选 `limit` 上限 |
| `ASK_DEFAULT_CANDIDATES` | 20 | 候选 `limit` 默认值 |
| `ASK_MAX_RANGE_DAYS` | 3660 | 日期范围最大跨度（约 10 年） |

## 2. 数据模型

### 2.1 迁移 `0009_ask.sql`

新增 `record_queries`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | `ask-<毫秒时间戳>-<6 位随机>` |
| `question` | text not null | 用户问题（trim 后） |
| `keywords` | text not null default `''` | 本次实际检索词，空格拼接；读取时按空白拆分 |
| `range_from` | integer | 起始毫秒，包含；null 表示不限 |
| `range_to` | integer | 结束毫秒，不包含；null 表示不限 |
| `status` | text not null | `pending` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `answer_json` | text | 校验通过的 `AskAnswer`；失败/取消为 null |
| `sources_json` | text | 发送记录快照数组（`AskSourceSnapshot[]`，含正文与版本） |
| `config_id` / `config_version` / `config_name` / `model_id` | | 生成时的模型配置快照 |
| `usage_json` | text | `{inputTokens,outputTokens,totalTokens}` |
| `duration_ms` | integer | 模型调用耗时 |
| `error_code` | text | `AiErrorCode`，或 `cancelled` / `interrupted` |
| `error_detail` | text | 脱敏后的失败说明，写入前截断 500 字符 |
| `operation_id` | text unique | 创建幂等键（≤200 字符） |
| `operation_fingerprint` | text | 请求指纹，用于判断同键是否同请求 |
| `context_token` | text | 预览上下文指纹（见 §4） |
| `created_at` / `updated_at` | integer not null | 毫秒 |
| `finished_at` | integer | 进入完成态时写入 |

索引：`record_queries_created_idx(created_at DESC)`、`record_queries_status_idx(status)`。`operation_id` 唯一；SQLite 允许多个 NULL，历史行不受影响。

### 2.2 `sources_json` 快照

发送前写入，排序为 `sourceKey` 字典序（`attempt:` 在 `capture:` 之前，因此不是时间序）：

```json
{
  "sourceKey": "attempt:att-...",
  "type": "attempt",
  "id": "att-...",
  "captureId": "cap-...",
  "title": "比较两种 PWM 频率",
  "text": "比较两种 PWM 频率",
  "resultText": "500 Hz 时仍有可见闪烁",
  "outcome": "failure",
  "state": "done",
  "observedAt": 1763000000000,
  "createdAt": 1762990000000,
  "revision": 2,
  "captureRevision": 1,
  "captureText": "PWM 低占空比时 LED 会闪",
  "archived": false
}
```

- `text` 对尝试等于 `step`，对念头等于原文；`title` 同源。
- 快照的目的：回答中的来源链接、正文与版本在生成后仍可复现，且不因后续编辑而改写历史回答。
- 删除清洗后追加 `"deleted": true` 并清空正文，见 §9。

### 2.3 状态机

```text
pending ──成功──▶ succeeded
        ├─失败────▶ failed（error_code = 模型/校验错误码）
        ├─用户取消─▶ cancelled（error_code='cancelled'）
        └─服务重启─▶ interrupted（error_code='interrupted'）
```

- 创建即返回 202，模型调用在 `setImmediate` 后台执行。
- 所有完成态更新均带 `WHERE status='pending'`；取消或已结束后迟到的模型响应不会把状态改回成功。
- 启动时 `markInterruptedAskQueries()` 把全部 `pending` 置 `interrupted`，`error_detail='服务重启，本次问答已中断，可重新提问。'`，并写 `finished_at/updated_at`。
- 全局 `pending` 任务上限 2（本机单人即用户级并发）；达到上限时新任务返回 **429 `too_many_queries`**，不是 409。前端需要单独处理 429。

## 3. 候选检索

### 3.1 `GET /api/ask/candidates`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `question` | 是 | trim 后 1–500 字符，否则 400 `invalid_question` |
| `keywords` | 否 | 空格分隔；拼接后 ≤200 字符，否则 400 `invalid_keywords`；显式传空字符串表示不用关键词（浏览模式） |
| `expanded` | 否 | 可重复 0–5 次，每次一个扩展检索词；单项 1–40 字符、合计 ≤120 字符；与当前关键词重复/等价的项被忽略；失败 400 `invalid_expanded_keywords`（详见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md) §6） |
| `from` | 否 | 整数毫秒；空字符串等同不传 |
| `to` | 否 | 整数毫秒；结束边界不包含 |
| `limit` | 否 | 1–50，默认 20；非数字按 20，负数按 1 |

- 只在不传 `keywords`（undefined/null）时，服务端才用 `suggestKeywordsForQuestion` 从问题提取检索词：按标点/空白分句，去掉「帮我/之前/什么/尝试/结果」等口语停用词，最多 6 个词。显式传空字符串或空数组时关键词为空，直接进入浏览模式，不会自动提取。
- `suggestedKeywords` 返回**本次实际使用的关键词**（去重、trim 后按空格拼接），不是另一套建议。
- `expanded` 只是检索词扩展：服务端按重复 query 参数接收，用于追加字面子串匹配；不传或全部被忽略时 `expandedKeywords` 为 `[]`，候选行为与旧版一致。它不是语义检索，也不进入问答生成 prompt；详见检索词扩展契约。
- 响应：

```json
{
  "question": "我在哪次尝试里比较过 PWM 频率？",
  "keywords": ["PWM", "频率"],
  "suggestedKeywords": "PWM 频率",
  "expandedKeywords": [],
  "range": { "from": null, "to": null, "fromLocal": null, "toLocal": null },
  "total": 3,
  "limit": 20,
  "candidates": [
    {
      "sourceKey": "attempt:att-...",
      "type": "attempt",
      "id": "att-...",
      "captureId": "cap-...",
      "title": "比较两种 PWM 频率",
      "snippet": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁",
      "date": 1763000000000,
      "dateKind": "observed",
      "state": "done",
      "outcome": "failure",
      "archived": false,
      "matchReasons": ["结果命中", "标题命中", "引用关系 2"],
      "matchKind": "direct",
      "matchedKeywords": ["PWM", "频率"],
      "referenceCount": 2,
      "openHref": "/attempt/att-..."
    }
  ],
  "ai": {
    "configured": true,
    "enabled": true,
    "config": { "id": "default", "name": "本机模型", "modelId": "fake-ask", "configVersion": 3 }
  },
  "generatedAt": 1763049600000
}
```

- `ai.configured` 只看是否存有 API Key；`ai.enabled` 看启用开关。未配置时 `config` 仍可能是已保存的配置快照，`configured=false`。
- `openHref` 由服务端生成：尝试 `/attempt/<id>`，念头 `/capture/<id>`。

### 3.2 日期范围语义

- `from` 含、`to` 不含（左闭右开）；「结束日期」本身不包含，界面应传结束日次日 00:00 的毫秒值。
- 尝试取 `observedAt ?? createdAt`，`dateKind` 分别为 `observed` / `created`；念头取 `createdAt`。
- 任一端为 null 表示该侧不限；两端都 null 表示不限。
- `to <= from`、非正整数、跨度 > 3660 天、超出可表示范围 → 400 `invalid_range`，`field` 指明 `from`/`to`。
- `fromLocal/toLocal` 固定按 `Asia/Shanghai` 格式化为 `YYYY-MM-DD`；接口**不接收** `timezone`，不做用户时区换算。用户在其他时区时，界面上的日期标签与服务端返回可能相差一天，需在界面注明。

### 3.3 命中与排序

| 命中位置 | 权重（每次出现） | `matchReasons` |
| --- | --- | --- |
| 尝试结果文本 `result_text` | 100 | `结果命中` |
| 尝试步骤 `step` | 20 | `标题命中` |
| 所属念头原文 `captures.raw_text` | 5 | `所属念头命中` |
| 念头正文（念头候选） | 5 | `念头命中` |
| `attempt_references` 一跳扩展带出的尝试 | 固定 10 | `被这次尝试引用`（锚点引用伙伴）/ `引用了这次尝试`（伙伴引用锚点），并附 `引用关系` |
| `capture_links` 正链/反链一跳扩展带出的念头 | 固定 10 | `通过链接找到` |
| 扩展检索词（`expanded`）命中（结果/标题/所属念头） | 与原始关键词同权重：100 / 20 / 5（每次出现） | `扩展词命中：<term>` |
| 关键词为空（浏览模式） | 0 | `最近记录` |

- 每个候选带 `matchKind: 'direct' | 'expanded' | 'relation'`：原始关键词直接命中（含浏览模式）为 `direct`；仅由用户采用的扩展检索词命中为 `expanded`；仅由链接/反链/尝试引用扩展带出为 `relation`。候选还带 `matchedKeywords`：实际命中的原始词 + 扩展词（去重；`relation` 为 `[]`）。
- 匹配是子串匹配，ASCII 大小写不敏感；不做分词、同义词、拼音或向量检索。自动关键词只输出 1–6 个短词，不会把整句当作唯一检索词；问题没有主题词时返回空关键词（浏览模式）。`expanded` 也是字面子串，不是语义相似度。
- 同一关键词在同一文本中多次出现按次数累计；不同关键词分别累计；原始词与扩展词同时命中时分别计分并相加。
- 关键词或扩展词非空时，只保留 `score > 0` 的候选（`matchKind` 为 `direct` 或 `expanded`）。
- 一跳扩展：对已命中的 **尝试**，沿 `attempt_references` 取直接引用伙伴（双向）；对已命中的 **念头**，沿 `capture_links` 取直接关联伙伴（正链与反链双向）。伙伴本身未命中且日期在范围内才加入，固定 `score=10`；只扩展一跳，不递归；关键词为空时不扩展；**只有 `matchKind='direct'` 的候选作为扩展锚点，仅扩展词命中的候选不触发关系扩展**。
- 排序：`matchKind` 顺序为 `direct` → `expanded` → `relation`；同组内 `score` 降序 → `date` 降序 → `sourceKey` 字典序升序。直接命中优先于扩展词与关系扩展，避免扩展线索压过真正搜到的内容。
- **结果评价（`outcome`）不参与打分与排序**，成功/失败/未判定一视同仁；`referenceCount` 只作为原因标签 `引用关系 N` 参与展示，不计分。
- `total` 为截断前的候选总数，`candidates` 截到 `limit`。
- 无匹配：HTTP 200，`total=0`、`candidates=[]`，不是错误；界面提示修改关键词或放宽日期。
- 归档记录照常出现，用 `archived` 标注。

## 4. 预览

### 4.1 `POST /api/ask/preview`

请求：

```json
{
  "question": "我在哪次尝试里比较过 PWM 频率？结论有什么不同？",
  "keywords": "PWM 频率",
  "from": 1759248000000,
  "to": 1761926400000,
  "sourceKeys": ["attempt:att-..."]
}
```

- `sourceKeys` 必须为 1–8 个字符串、去重、格式 `attempt:<id>` / `capture:<id>`（id 允许 `[A-Za-z0-9._:-]`）；否则 400 `invalid_sources`。
- `keywords` 可传空格分隔字符串或字符串数组；不传时从问题提取，显式空字符串/空数组表示不用关键词。`from/to` 可传整数或纯数字字符串，空字符串视为不传（该侧不限）。
- 不要求模型已配置；未配置时 `config` 可能非空、`ai.configured=false`，记录照常返回。
- 服务端按 key 从数据库重读真实内容；客户端不提交记录正文，提交了也会被忽略。
- 任一 key 不存在（已删除/不可访问）→ 409 `{error:'sources_unavailable', sourceKeys:[...], message:'有记录已被删除或不可访问，请重新检索。'}`。
- 响应：

```json
{
  "question": "我在哪次尝试里比较过 PWM 频率？结论有什么不同？",
  "keywords": ["PWM", "频率"],
  "range": { "from": 1759248000000, "to": 1761926400000, "fromLocal": "2025-10-01", "toLocal": "2025-11-01" },
  "config": { "id": "default", "name": "本机模型", "modelId": "fake-ask", "configVersion": 3 },
  "ai": { "configured": true, "enabled": true },
  "records": [
    {
      "sourceKey": "attempt:att-...",
      "type": "attempt",
      "id": "att-...",
      "captureId": "cap-...",
      "title": "比较两种 PWM 频率",
      "text": "比较两种 PWM 频率",
      "resultText": "500 Hz 时仍有可见闪烁",
      "outcome": "failure",
      "state": "done",
      "observedAt": 1763000000000,
      "createdAt": 1762990000000,
      "revision": 2,
      "captureRevision": 1,
      "captureText": "PWM 低占空比时 LED 会闪",
      "archived": false
    }
  ],
  "coverage": {
    "selectedRecords": 1,
    "selectedChars": 486,
    "maxRecords": 8,
    "maxChars": 12000,
    "withinLimit": true
  },
  "contextToken": "hex-sha256"
}
```

- `records` 按 `sourceKey` 字典序返回，与发送顺序一致。
- `selectedChars` 是**实际将发送的 user prompt** 的字符数（含问题、关键词、日期范围、记录行、记录之间的引用关系段与结尾指令），不是记录正文字数之和。
- 预览不因超限拒绝：超过 12000 字符时返回 `withinLimit=false`，界面必须提示并禁用生成；生成时由服务端 409 `query_too_large` 兜底。`selectedRecords ≤ 8` 由 `sourceKeys` 校验保证。

### 4.2 `contextToken`

```text
SHA-256(JSON.stringify({
  question,
  keywords: keywords.join(' '),
  from, to,
  configVersion: 配置版本或 null,
  items: records 按 sourceKey 排序后的 [{sourceKey, revision, captureRevision}]
}))
```

- 正文变化必然改动 `revision`（尝试或所属念头），因此 token 不含正文本身。
- 预览与生成之间任一项变化（问题、关键词、范围、来源版本、配置版本），token 必然不同。

## 5. 生成

### 5.1 `POST /api/ask/queries`

请求：

```json
{
  "question": "我在哪次尝试里比较过 PWM 频率？",
  "keywords": "PWM 频率",
  "from": 1759248000000,
  "to": 1761926400000,
  "sourceKeys": ["attempt:att-..."],
  "contextToken": "hex-sha256",
  "operationId": "8f1c2d3e-..."
}
```

校验顺序与对应错误（顺序会影响测试断言）：

1. `question`、`from/to`、`keywords`、`sourceKeys` → 400 `invalid_question` / `invalid_range` / `invalid_keywords` / `invalid_sources`。
2. `operationId` 缺失或 >200 字符 → 400 `invalid_request`（`field='operationId'`）。
3. `contextToken` 缺失 → 400 `invalid_request`（`field='contextToken'`）。
4. 已存在同 `operationId`：
   - 指纹相同 → **200** `{query, replayed:true}`，不重新调用模型；
   - 指纹不同 → 409 `operation_key_conflict`。
5. 无配置/无 Key → 409 `ai_not_configured`；`enabled !== 1` → 409 `ai_disabled`。
6. 来源不存在 → 409 `sources_unavailable`（附 `sourceKeys`）。
7. prompt 超过 12000 字符 → 409 `query_too_large`（附 `recordCount/maxRecords/charCount/maxChars`）；记录数 > 8 已在第 1 步被 `invalid_sources` 拦下，不会走到这里。
8. token 与服务端重算不一致 → 409 `context_changed`。
9. 事务内 `pending` 计数 ≥ 2 → 429 `too_many_queries`。
10. 写入 `pending`，返回 **202** `{query, replayed:false}`。

- 指纹：`SHA-256(JSON({op:'ask-query', question, keywords, from, to, sourceKeys 排序后, contextToken}))`。同 `operationId` 但 token 变化也视为不同请求，返回 409 而非回放。
- 回放返回的是该行**当前状态**（可能已 succeeded/failed/cancelled），不会重试模型。
- 创建失败时若并发插入撞唯一键，服务端会按同 `operationId` 再查一次：指纹相同回放 200，否则 409。
- `202` 响应中的 `query` 为 `AskPublic`：`status='pending'`、`answer=null`、`sources` 为快照的实时公开视图。

## 6. 查询、列表与取消

### 6.1 `GET /api/ask/queries/:id`

返回 `{query: AskPublic}`；不存在 404 `{error:'query_not_found'}`。用于轮询与刷新恢复。

`AskPublic` 字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 任务 ID |
| `question` / `keywords` | 问题与拆回数组的关键词 |
| `range` | `{from,to,fromLocal,toLocal}`；**详情接口的 `fromLocal/toLocal` 恒为 null**，前端需用 `from/to` 自行格式化（服务端日期口径见 §3.2） |
| `status` | 状态机当前值 |
| `answer` | `AskAnswer` 或 null；来源删除后可能已过滤部分条目 |
| `sources` | `AskSourcePublic[]`，发送时快照 + 当前存在/变化状态 |
| `config` | 生成时配置快照，缺字段时为 null |
| `usage` | `{inputTokens,outputTokens,totalTokens}` 或 null |
| `durationMs` | 模型耗时或 null |
| `errorCode` / `errorMessage` | 失败码与脱敏中文说明；无错误为 null |
| `createdAt` / `updatedAt` / `finishedAt` | 毫秒 |
| `answerInvalidated` | 是否有来源已删除（只由删除触发，编辑不触发） |
| `answerInvalidReason` | 固定文案「部分来源记录已删除，相关来源正文不再展示。」或 null |
| `hiddenPointCount` | 因来源删除而被隐藏的 points + contradictions 条数 |
| `canCancel` | `status==='pending'` |

### 6.2 `GET /api/ask/queries?limit=1..50`

`limit` 默认 20。按 `created_at DESC` 返回 `{queries: AskListItem[]}`，**没有 `total`、没有 offset/分页**：

```json
{
  "queries": [
    {
      "id": "ask-...",
      "question": "……",
      "status": "succeeded",
      "createdAt": 1763049600000,
      "finishedAt": 1763049612000,
      "summary": "……",
      "sourceCount": 3,
      "deletedSourceCount": 1,
      "insufficientEvidence": false
    }
  ]
}
```

`sourceCount` 为快照条数（含已删除）；`deletedSourceCount` 为其中已删除条数。

### 6.3 `POST /api/ask/queries/:id/cancel`

- 仅 `pending` 可取消；否则 409 `not_cancellable`；不存在 404 `query_not_found`。
- 立即置 `cancelled`、`error_code='cancelled'`、`error_detail='已取消本次提问。'`，写 `finished_at/updated_at`，并 abort 后台请求。
- 返回 `{query}`。迟到响应不会把状态改回成功；后台在启动前发现状态已非 `pending` 会直接跳过。

## 7. 回答 Schema 与校验

### 7.1 结构

```ts
type AskAnswer = {
  summary: string;                 // 1–600 字符
  points: Array<{
    text: string;                  // 1–400
    basis: 'observation' | 'inference';
    condition: string | null;      // 必须出现，可 null；≤200
    sourceIds: string[];           // 1–4 个，属于本次发送记录
  }>;                              // ≤10 条
  contradictions: Array<{
    text: string;                  // 1–400
    sides: Array<{                 // 2–4 个
      sourceId: string;
      condition: string;           // 必须非空；≤200
    }>;
  }>;                              // ≤5 条
  missing: string[];               // ≤6 条，每条 1–200
  insufficientEvidence: boolean;
};
```

`points[].condition` 允许 `null` 表示「记录没有写条件」；`contradictions[].sides[].condition` 不允许为空，没有条件时必须写「记录未写条件」。

### 7.2 校验规则

1. JSON 解析：允许 Markdown 的 json 代码围栏包裹，取第一个 `{` 到最后一个 `}`；解析失败 → `invalid_response`。
2. Zod 结构：字段类型、长度、数组上限不符 → `invalid_response`。
3. 每个 `points[].sourceIds` 必须属于本次发送的 `sourceKey` 集合，且同一 point 内不得重复，否则 `invalid_response`。
4. 每个 `contradictions[].sides[].sourceId` 同样必须属于发送集合，同一 contradiction 内不得重复。
5. `points` 与 `contradictions` 同时为空时，`insufficientEvidence` 必须为 `true`。
6. `insufficientEvidence=true` 时，`missing` 必须至少 1 条。
7. 任一条校验失败 → 任务 `failed`、`error_code='invalid_response'`、`errorMessage` 为具体原因（例如「point 包含未发送的来源：attempt:xxx」），`answer_json` 不写入。

注意：`basis` 与 `condition` 只是结构约束。服务端无法验证「这句话到底是观察还是推断」「条件是否写全」，这两点只能靠 prompt 约束与人工核对（见 `ask-notes.md`）。

成功回答示例：

```json
{
  "summary": "你记录过一次 PWM 频率对比：500 Hz 时仍可见闪烁，2 kHz 时肉眼未见；两次的条件记录不完整，不能据此判断长期效果。",
  "points": [
    {
      "text": "500 Hz 时仍有可见闪烁。",
      "basis": "observation",
      "condition": "占空比未记录，频率 500 Hz",
      "sourceIds": ["attempt:att-a"]
    },
    {
      "text": "2 kHz 时肉眼未见闪烁，但记录没有写下环境亮度。",
      "basis": "observation",
      "condition": "频率 2 kHz",
      "sourceIds": ["attempt:att-b"]
    }
  ],
  "contradictions": [
    {
      "text": "两次对「是否可见闪烁」的结论不同。",
      "sides": [
        { "sourceId": "attempt:att-a", "condition": "500 Hz；其余条件未记录" },
        { "sourceId": "attempt:att-b", "condition": "2 kHz；其余条件未记录" }
      ]
    }
  ],
  "missing": ["两次都没有记录占空比与环境亮度", "没有后续复测记录"],
  "insufficientEvidence": false
}
```

## 8. 来源公开规则

`AskSourcePublic` 由 `sources_json` 快照 + 当前数据库状态生成：

| 字段 | 规则 |
| --- | --- |
| `sourceKey` / `type` / `id` / `captureId` | 固定来自快照 |
| `title` / `text` / `resultText` / `outcome` / `state` / `observedAt` / `createdAt` / `archived` | 发送时快照值（`archived` 不取当前值） |
| `exists` | 当前是否仍可读到该记录 |
| `changed` | 版本变化：尝试比 `attempts.revision` 与所属 `captures.revision`；念头只比自身 `revision`。删除时恒为 `true` |
| `deleted` | 当前查不到该记录时为 true；删除清洗会同时把快照标记 `deleted:true` |
| `openHref` | 应用生成：尝试 `/attempt/<id>`，念头 `/capture/<id>` |
| `graphHref` | 应用生成：`/graph?node=<encodeURIComponent(sourceKey)>`，例如 `/graph?node=attempt%3Aatt-...`；`GraphPage` 读取 `node` 参数 |
| `canReuse` | 仅尝试且 `resultText.trim()` 非空时为 true，用于「用这条经验试一步」 |

已删除来源只返回：

```json
{
  "sourceKey": "attempt:att-...",
  "type": "attempt",
  "id": "att-...",
  "captureId": "cap-...",
  "title": "来源已删除",
  "text": null,
  "resultText": null,
  "outcome": null,
  "state": null,
  "observedAt": null,
  "createdAt": null,
  "archived": false,
  "exists": false,
  "changed": true,
  "deleted": true,
  "openHref": null,
  "graphHref": null,
  "canReuse": false
}
```

- 绝不回显已删除来源的标题、正文、结果或所属念头正文。
- `answerInvalidated`：存在任一 `deleted=true` 来源时为 true；仅编辑来源（`changed=true`）不置 true。
- `hiddenPointCount`：读取时统计被过滤掉的条目。规则是「任一条 `sourceIds`/`sides` 来源仍存在则保留该条」；一条都不可用时整条隐藏并计数。因此一个 point 可能同时引用现存与已删除来源，界面需要为已删除来源显示占位。
- 列表接口的 `deletedSourceCount` 同样按此计算；`summary` 即使来源被删也原样返回（模型正文不删）。

## 9. 删除清洗

删除尝试或念头时，在现有删除事务内调用：

```ts
invalidateAskSourcesForDeletedAttempts(attemptIds: string[]): number
invalidateAskSourcesForDeletedCapture(captureId: string): number
```

- 删除尝试：匹配 `snapshot.type='attempt' && snapshot.id ∈ attemptIds`。
- 删除念头：匹配 `snapshot.captureId === captureId`，或 `snapshot.type='capture' && snapshot.id === captureId`。念头删除前会先查出其全部尝试 ID 调用尝试清洗，因此该念头下所有尝试来源也会被清洗。
- 清洗后的快照保留 `sourceKey/type/id/captureId/revision/captureRevision`，其余置空：

```json
{
  "sourceKey": "attempt:att-...",
  "type": "attempt",
  "id": "att-...",
  "captureId": "cap-...",
  "title": "来源已删除",
  "text": "",
  "resultText": null,
  "outcome": null,
  "state": null,
  "observedAt": null,
  "createdAt": null,
  "revision": 2,
  "captureRevision": 1,
  "captureText": "",
  "archived": false,
  "deleted": true
}
```

- 同时更新该行 `updated_at`；不删除 `answer_json`（回答正文保留，读取时过滤并计入 `hiddenPointCount`）。
- 清洗直接改写数据库中的 `sources_json`，不是仅展示层屏蔽；已删除正文不会留在问答表里。
- 删除接口本身不因问答存在而失败；清洗在事务内，任一步失败整体回滚。

## 10. 隐私与发送范围

发送给模型的 `user prompt` 只包含：

1. 用户问题（≤500 字符）；
2. 本次关键词（若有）；
3. 日期范围（仅当至少一端有边界；文案注明「结束日期不包含」）；
4. 用户确认的 1–8 条记录，每条含：来源 ID、类型、结果时间或创建时间、当前状态、评价（若有）、步骤/正文、结果文本或「（没有记录结果）」、所属念头原文（尝试）；
5. 这些记录之间的真实引用关系行（仅当双方都在本次发送集合内），含引用说明；
6. 固定的输出格式指令。

不发送：未勾选记录、其他记录的统计、账号/会话信息、API Key、模型配置密钥、导出数据。服务端只把记录以稳定 ID（`attempt:…` / `capture:…`）写入 prompt，来源链接由应用生成，模型不产出链接。

本地留存与脱敏：

- `sources_json` 保存所选记录的完整正文，用于历史回答复现；属于本机敏感数据，随整库备份一起存在。
- 错误详情经 `classifyError` 脱敏（移除密钥）后截断 500 字符再入库。
- 日志只记录 `queryId` 与 `errorCode`，不记录问题正文、记录正文或密钥。
- API 响应不返回 `operation_fingerprint`、`context_token` 等内部字段，也不返回密钥。

## 11. 错误码

| HTTP | `error` | 触发 | 附加字段 |
| --- | --- | --- | --- |
| 400 | `invalid_question` | 问题为空或 >500 字符 | `field:'question'`, `message` |
| 400 | `invalid_range` | 非整数毫秒、≤0、`to<=from`、跨度 >3660 天、超范围 | `field:'from'/'to'`, `message` |
| 400 | `invalid_keywords` | 关键词拼接 >200 字符或类型不支持 | `field:'keywords'`, `message` |
| 400 | `invalid_expanded_keywords` | `expanded` 超过 5 项、单项 >40 字符、合计 >120 字符、空值/控制字符 | `field:'expanded'`, `message`；详见检索词扩展契约 §8 |
| 400 | `invalid_sources` | `sourceKeys` 为空、>8、格式错误、重复、含非字符串 | `message` |
| 400 | `invalid_request` | `operationId` 缺失/>200，或 `contextToken` 缺失 | `field`, `message` |
| 401 | `unauthenticated` | 无会话 | — |
| 404 | `query_not_found` | 任务不存在 | `message` |
| 409 | `sources_unavailable` | 预览/生成时来源已删除或不可访问 | `sourceKeys`, `message` |
| 409 | `operation_key_conflict` | 同 `operationId` 但指纹不同 | `message` |
| 409 | `ai_not_configured` | 未保存 API Key | `message` |
| 409 | `ai_disabled` | 配置存在但被停用 | `message` |
| 409 | `query_too_large` | prompt >12000 字符（记录数 >8 在参数阶段是 400 `invalid_sources`） | `recordCount`, `maxRecords`, `charCount`, `maxChars` |
| 409 | `context_changed` | 预览后问题/关键词/范围/来源版本/配置版本变化 | `message` |
| 409 | `not_cancellable` | 取消非 `pending` 任务 | `message` |
| 429 | `too_many_queries` | 全局 `pending` ≥ 2 | `message` |

任务内的模型错误码（写入 `query.errorCode`，HTTP 仍为 200/202）：`unreachable`、`auth`、`model_unavailable`、`timeout`、`invalid_response`、`rate_limited`、`redirect_blocked`、`invalid_url`、`local_not_allowed`、`cancelled`、`interrupted`。`errorMessage` 优先取脱敏后的 `error_detail`，否则取内置中文文案。

## 12. 本版不提供

- 向量/语义检索、跨语言检索；候选只靠子串匹配与一跳引用扩展。检索词扩展是模型建议的字面检索词（`expanded`），不保证同义、改写或跨语言命中，详见 [`keyword-expansion-api-contract.md`](./keyword-expansion-api-contract.md)。
- 问答历史的分页、搜索、导出、删除入口；列表上限 50。
- 多用户、共享、权限分层；`record_queries` 没有用户维度。
- 流式输出、自动重试、多模型降级、成本预算。
- 从问答直接创建尝试或引用；「用这条经验试一步」仍走既有 `/capture/:captureId?experience=:attemptId` 预览流程，由用户确认。
