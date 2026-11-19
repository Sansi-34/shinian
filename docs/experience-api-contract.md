# 拾念 SHINIAN · 「参考旧经验，再试一步」接口契约

日期：2026-11-13。本轮在现有 AI 生成/采用流程上增加 1–3 条历史经验来源；复用现有配置、adapter、生成状态、版本校验和 Attempt 创建。实现如偏离本契约，以 `docs/experience-notes.md` 记录并说明。

实施状态（2026-11-13）：已实现；假模型自动化 376 passed / 0 failed，浏览器 E2E 45 passed / 0 failed；真实模型联调因无配置待完成（见 experience-notes.md）。

## 0. 范围

- 用户在当前念头详情中检索过去尝试（必须有实际观察文本），选 1–3 条，预览服务端返回的真实内容，确认后让 AI 结合当前念头 + 补充限制 + 旧经验生成建议。
- 模型返回实际使用的来源 ID 和简短说明；服务端校验来源属于本次选择，并在采用时用现有 `attempt_references` 建立引用。
- 用户可继续使用原有「帮我试一步」（无来源）和「自己写一步」。
- 本机单人；不新增用户/权限体系。密钥、日志、导出、构建产物不得泄露密钥。

## 1. 数据模型

### 1.1 迁移 `0004_experience.sql`

在 `ai_generations` 增加：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `context_json` | text | 本次生成上下文快照；旧记录为 null |
| `context_token` | text | 预览时的上下文指纹；无来源直接生成时为 null |
| `context_invalidated_at` | integer | 来源被删除后置为当前时间 |
| `context_invalid_reason` | text | 例如「来源记录已删除」 |

### 1.2 `context_json` 结构

```json
{
  "capture": { "id": "cap-...", "revision": 3, "text": "当前念头原文" },
  "constraint": "只有十分钟",
  "config": { "id": "default", "version": 4, "name": "本机模型", "modelId": "fake-success" },
  "sources": [
    {
      "attemptId": "att-...",
      "attemptRevision": 2,
      "captureId": "cap-...",
      "captureRevision": 1,
      "step": "比较两种 PWM 频率",
      "resultText": "500 Hz 时仍有可见闪烁",
      "outcome": "failure",
      "observedAt": 1760000000000,
      "sourceUrl": null,
      "captureText": "PWM 低占空比时 LED 会闪",
      "captureArchived": false
    }
  ]
}
```

只保存一份快照，不按来源拆多张表。`suggestion_json` 保存模型实际引用：

```json
{
  "kind": "executable",
  "step": "先只改频率到 2 kHz，观察是否还闪。",
  "why": "旧记录显示 500 Hz 有闪烁，2 kHz 可能改善；这是一次小验证。",
  "estimatedMinutes": 5,
  "question": null,
  "sources": [
    { "attemptId": "att-...", "note": "这次失败说明 500 Hz 下仍有可见闪烁。" }
  ]
}
```

旧记录没有 `sources` 字段时，前端按无来源生成处理，必须仍能正常显示和采用。

## 2. 历史经验候选

### `GET /api/captures/:id/experience-candidates?q=<query>&limit=12`

- 登录必需；当前念头不存在 404。
- 未传 `q` 或为空时使用服务端建议查询词；`suggestedQuery` 始终返回。
- 只返回 `attempts.result_text` 非空且 `trim` 后非空的尝试；失败/未判定不排除。
- 匹配范围复用现有 LIKE 关键词检索：尝试标题、结果文本、所属念头原文。
- 查询词按空白拆分成多个关键词，任一命中即可；英文大小写不敏感。
- 排序（可解释，不返回相似度百分比）：
  1. 结果文本命中次数/权重最高，其次标题，再次所属念头；
  2. 与当前念头的尝试存在明确 `attempt_references` 关系的候选加权；
  3. 同权重按 `observed_at / updated_at / created_at` 较新优先。
- 返回：
```json
{
  "captureId": "cap-...",
  "query": "闪烁 频率",
  "suggestedQuery": "闪烁 频率",
  "limit": 12,
  "total": 2,
  "candidates": [
    {
      "id": "att-...",
      "captureId": "cap-...",
      "captureText": "PWM 低占空比时 LED 会闪",
      "captureArchived": false,
      "captureRevision": 1,
      "step": "比较两种 PWM 频率",
      "resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁",
      "outcome": "failure",
      "observedAt": 1760000000000,
      "sourceUrl": null,
      "revision": 1,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000,
      "matchReasons": ["结果命中", "标题命中", "引用关系"]
    }
  ]
}
```
- `limit` 默认 12，范围 1–30。
- 归档可见性沿用现有搜索（归档记录仍可出现，返回 `captureArchived` 供 UI 标注）。

## 3. 预览

### `POST /api/captures/:id/experience/preview`

请求：
```json
{
  "captureRevision": 3,
  "constraint": "只有十分钟",
  "sourceAttemptIds": ["att-a", "att-b"]
}
```

- 1–3 个来源，必须非空、去重；否则 400 `invalid_sources`。
- 当前念头版本不一致 → 409 `version_conflict`（附 `currentRevision/currentRawText`）。
- 未配置/停用 → 409 `ai_not_configured` / `ai_disabled`。
- 来源不存在、无观察文本、所属念头不存在 → 409 `{error:'source_unavailable', sourceIds:[...]}`。
- 服务端读取真实来源内容，客户端不提交来源正文。
- 返回：
```json
{
  "capture": { "id": "cap-...", "rawText": "...", "revision": 3 },
  "constraint": "只有十分钟",
  "config": { "id": "default", "name": "本机模型", "modelId": "fake-success", "configVersion": 4 },
  "sources": [
    {
      "attemptId": "att-a",
      "captureId": "cap-...",
      "captureText": "PWM ...",
      "captureRevision": 1,
      "attemptRevision": 1,
      "step": "比较两种 PWM 频率",
      "resultText": "500 Hz ...",
      "outcome": "failure",
      "observedAt": 1760000000000,
      "sourceUrl": null,
      "captureArchived": false
    }
  ],
  "contextToken": "hex-sha256"
}
```

`contextToken` = SHA-256(JSON of `{captureId, captureRevision, constraint, configVersion, sources:[{attemptId, attemptRevision}] sorted by attemptId}`)。预览与发送之间任一处变化，token 必须不同。

## 4. 生成

### `POST /api/captures/:id/suggestions`

在旧请求基础上增加可选字段：
```json
{
  "captureRevision": 3,
  "constraint": "只有十分钟",
  "sourceAttemptIds": ["att-a", "att-b"],
  "contextToken": "hex-sha256",
  "operationId": "..."
}
```

- 没有 `sourceAttemptIds`（或空数组）：保持旧行为，不要求 token，`context_json=null`。
- 有来源：必须 1–3 个、去重、带 `contextToken`；服务端从数据库重读来源并重算 token：
  - 不匹配 → 409 `{error:'context_changed', message:'预览后记录或配置有变化，请刷新内容并重新确认。'}`；
  - 来源不可用 → 409 `source_unavailable`；
  - 念头版本不一致 → 409 `version_conflict`。
- 生成记录保存 `context_json`、`context_token`、`config_version`、`capture_revision` 等。
- 模型提示词把来源以稳定 ID 列出，例如 `[att-...]`，要求只使用列表内的 ID；模型返回的 `sources[].attemptId` 必须能对应本次选中来源。
- 生成状态/取消/超时/重启/迟到响应沿旧机制。

### Schema 扩展

在 `suggestionSchema` 增加：
```ts
sources: z.array(z.object({
  attemptId: z.string().min(1).max(120),
  note: z.string().trim().min(1).max(200),
})).max(3)
```

语义校验：
- 每个 `attemptId` 必须在本次选中列表内且不重复；
- 选中来源非空时，`kind === 'executable'` 至少返回 1 个来源；
- 选中来源为空时，`sources` 必须为 `[]`；
- defer/clarify 可以返回 0 到选中数量的来源；
- 未知 ID、重复 ID、结构不合法 → `failed / invalid_response`，可重试；
- 旧模型输出没有 `sources` 字段时只用于兼容旧数据库记录，不进入新请求的 schema。

## 5. 查询生成结果

`GET /api/generations/:id` 与 `latest` 的 generation 公开对象增加：

```json
{
  "sources": [
    {
      "attemptId": "att-a",
      "note": "模型说明",
      "attemptRevision": 1,
      "captureId": "cap-...",
      "step": "比较两种 PWM 频率",
      "resultText": "500 Hz ...",
      "outcome": "failure",
      "observedAt": 1760000000000,
      "sourceUrl": null,
      "captureText": "PWM ...",
      "currentExists": true,
      "currentRevision": 1,
      "changed": false,
      "deleted": false
    }
  ],
  "sourcesChanged": false,
  "contextInvalidated": false,
  "contextInvalidReason": null
}
```

- `sources` 由 `context_json` + `suggestion_json.sources` 合并；`note` 取模型说明；不存在的来源返回 `deleted:true`，不返回已删除来源正文。
- `sourcesChanged`：任一来源不存在、attemptRevision 变化、来源念头 revision 变化。
- `contextInvalidated`：来源删除后由服务端清洗，置 `true`。
- 旧生成记录无 context：`sources:[]`、`sourcesChanged:false`、`contextInvalidated:false`。

## 6. 采用

`POST /api/generations/:id/accept` 增加（请求体不变，`step + operationId`）：

- 事务内复核：
  1. generation 状态/kind；
  2. 当前念头 revision 与 `capture_revision`；
  3. `context_json` 中每个来源当前存在且 `attemptRevision`、`captureRevision` 未变；
  4. 任一变化 → 409 `{error:'sources_changed', message:'建议依据已变化，请重新生成。', sources:[当前公开来源]}`；不创建 Attempt、不更新 adopted；
- 创建 Attempt（复用现有字段/逻辑）；
- 对 `suggestion_json.sources` 中每个来源创建 `attempt_references`：
  - `fromAttemptId` = 新 Attempt；
  - `toAttemptId` = 来源；
  - `note` = `AI 建议引用：${note}`（或包含来源说明的简短文本）；
  - `snapshotResultText` / `snapshotRevision` = `context_json` 中生成时的快照；
  - 唯一约束防止重复；任一插入失败整批回滚；
- 同事务更新 generation `adopted_attempt_id`、`adopted_at`，写 `mutation_receipts`（target_type `ai_accept_experience` 或兼容 `ai_accept`）；
- 重复采用直接返回同一个 Attempt，不重复创建引用；
- 引用关系继续使用现有 `GET /api/attempts/:id/references` 双向展示。

## 7. 删除与清洗

- 删除来源 Attempt：清洗所有 `ai_generations` 的 `context_json` 中该来源：
  - 保留 `{attemptId, deleted:true}`，**删除 step/resultText/captureText/sourceUrl 等正文**；
  - 置 `context_invalidated_at`、`context_invalid_reason='来源记录已删除'`；
  - `suggestion_json.sources` 中对应项可移除或保留 ID，但 UI 不得读到已删除正文。
- 删除来源所属念头：同样按上述规则清洗其所有 Attempt 作为来源的生成记录；当前念头被删除时其生成记录随外键 cascade。
- 删除后 `GET generation` 只显示 `deleted:true`，不显示已删除观察文本；不可采用，可重新生成。
- 现有 `DELETE /api/captures/:id`、`DELETE /api/attempts/:id` 的事务需要调用清洗 helper；不能留下可从 AI 详情读取的已删除正文。

## 8. 前端交互

### 入口

- 念头详情「开始一步」三张入口卡：自己写一步 / 帮我试一步 / 参考旧经验。
- 参考旧经验面板：
  - 初始查询由 `experience-candidates` 返回；输入框可编辑；搜索按钮；显示搜索中/无结果。
  - 候选卡展示：尝试标题、结果摘要、成功/失败/未判定、发生时间、来源链接、所属念头、命中原因（结果/标题/所属念头/引用关系），可打开原尝试/所属念头；归档标记。
  - 结果评价不参与排序；失败/未判定可选。
  - 选择 1–3 条；已选区域显示数量、可移除；达到 3 条提示上限。
  - 底部「结合这些经验，帮我试一步」；0 条时禁用；无结果时提供「修改搜索词」与「改用普通 AI 建议」。
- 预览：
  - 显示目标配置与 modelId、当前念头、补充限制、每条来源的标题/观察/评价/时间/来源、已选数量；
  - 服务端真实内容为准，前端不提交来源正文；
  - 预览后来源/念头变化 → 提示刷新并重新确认；确认按钮发送 sourceAttemptIds + contextToken；
  - 返回选择/移除来源。
- 生成/建议：
  - 生成中/取消/失败/重试沿用现有状态；
  - 建议卡增加「参考的旧经验」区块：用户记录（观察/结果/时间）与模型说明分层显示；来源链接指向尝试；
  - `sourcesChanged`/`contextInvalidated` 时显示「依据已变化」，禁用采用，保留编辑文字和重新生成入口；
  - 采用成功后进入现有 Attempt 详情，引用区展示来源；旧尝试页显示被引用。
- 保留原直接「帮我试一步」和手动路径，不要求用户选来源。

### API 客户端类型

新增：
```ts
ExperienceCandidate
ExperienceCandidatesResponse
ExperiencePreview
ExperienceSource
GenerationSource
```
生成请求新增 `sourceAttemptIds?: string[]; contextToken?: string`。

## 9. 测试约定

- `scripts/test_experience.py` 加入 `run_tests.py`，使用独立测试 DB/端口；覆盖候选检索（中英文、失败结果、空结果排除）、0/1/3/4 选择、预览真实内容、预览后版本变化、来源删除/越界、模型编造来源、生成/采用/重复采用/回滚、删除清洗、旧记录兼容。
- 假模型服务增加来源感知场景（例如 `fake-experience`、`fake-experience-3`、`fake-experience-bad-source`、`fake-experience-contradict`、`fake-experience-insufficient`）。
- 浏览器 E2E 走完整路径：旧念头→旧尝试/结果→新念头→参考旧经验→搜索→选择→预览→生成→编辑采用→新尝试引用→旧尝试反向引用。
- 真实模型联调：仅当 `GET /api/settings/ai` 返回已启用且 `hasApiKey=true` 时进行；当前环境无配置则明确记录待完成，不要求用户在聊天中提供密钥。
