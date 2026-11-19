# 经验笔记 API 契约（第一版）

本文描述「沉淀一条经验」新增的 HTTP 接口、数据形状与一致性规则。所有接口都要求本机会话登录；未登录返回 `401 { "error": "unauthenticated" }`。写入接口沿用项目现有的 Host / Origin 校验。

## 1. 实体与来源标识

经验复用 `captures` 行保存正文，因此经验本身有稳定的 `id`（形如 `exp-…`），可以继续使用现有的手动链接、图谱、归档、删除和导出链路。

- `kind = 'experience'` 的 capture 正文即「我的理解」。
- `experience_notes` 保存标题、适用条件、限制、整理出处和待修订状态。
- `experience_sources` 保存依据记录的快照与来源状态。
- `experience_attempts` 保存引用这条经验的后续尝试，以及采用时的版本和正文。

来源 key 只有两种：

| key | 指向 |
| --- | --- |
| `attempt:<attemptId>` | 一次带有实际结果的尝试 |
| `capture:<captureId>` | 一条普通念头（`kind='thought'`） |

同一经验内 `(experience_id, source_key)` 唯一。补选候选**不会**返回经验摘要作为新的事实来源。

## 2. 两个入口的预填

### `GET /api/ask/queries/:id/experience-draft?pointIndex=<n>`

- `pointIndex` 是回答 JSON 中 `points` 的**原始数组索引**，不是界面分组后的索引。
- 只返回该观点的 `text`、`basis`、`condition` 与它实际使用的 `sourceIds`；不返回整份回答，也不带检索候选。
- 观点不存在：`404 { "error": "point_not_found" }`。
- 观点索引非法：`400 { "error": "invalid_request", "field": "pointIndex" }`。

响应：

```json
{
  "draft": {
    "originKind": "ask",
    "title": "睡前把手机放远",
    "understanding": "把手机放到书桌上，比放在枕边更容易停止刷手机。",
    "conditions": "",
    "limitations": "",
    "by": "model",
    "modelBasis": "observation",
    "originQueryId": "q-…",
    "originPointIndex": 0,
    "originAttemptId": null,
    "contextCaptureId": "cap-…",
    "sources": [
      {
        "sourceKey": "attempt:att-…",
        "type": "attempt",
        "id": "att-…",
        "captureId": "cap-…",
        "title": "睡前把手机放在书桌上",
        "text": "睡前把手机放在书桌上",
        "resultText": "十分钟内睡着了",
        "outcome": "success",
        "state": "done",
        "observedAt": 1794670000000,
        "kind": "attempt",
        "openHref": "/attempt/att-…",
        "exists": true,
        "changed": false
      }
    ],
    "hint": "由模型推断整理；保存只表示愿意保留，不代表已被证实。"
  }
}
```

### `GET /api/attempts/:id/experience-draft`

- 只对具有非空 `resultText` 的尝试返回草稿；没有实际结果的尝试返回 `409 { "error": "attempt_result_required" }`。
- 草稿标题取尝试标题，**不预填「我的理解」**，由用户自己写。
- 来源只包含这次尝试本身。
- 尝试不存在：`404 { "error": "attempt_not_found" }`。

## 3. 创建与修订

### `POST /api/experiences`

```json
{
  "title": "睡前把手机放到书桌上",
  "understanding": "把手机放远一点，比放在枕边更容易停止刷手机。",
  "conditions": "普通工作日晚上",
  "limitations": "临时工作消息会打断。",
  "by": "user",
  "modelBasis": null,
  "originKind": "attempt",
  "originAttemptId": "att-…",
  "contextCaptureId": "cap-…",
  "sourceKeys": ["attempt:att-…"],
  "operationId": "client-uuid"
}
```

- 必填：`title`（≤120）、`understanding`（≤4000）、`sourceKeys`（1–8 条）、`operationId`。
- `conditions` / `limitations` 各 ≤2000，可为空。
- `by='model'` 时必须给 `modelBasis='observation'|'inference'`；否则 `400`。
- `originKind='ask'` 时必须给 `originQueryId`、`originPointIndex`，且 `by='model'`。
- 无来源：`422 { "error": "source_required", "field": "sourceKeys" }`。
- 任何来源不可访问：`409 { "error": "source_unavailable", "sourceKeys": [...] }`。
- 成功：`201 { "experience": ExperiencePublic, "replayed": false }`。
- 同一 `operationId` 重放：`200 { ..., "replayed": true }`，不会重复创建。

### `PATCH /api/experiences/:id`

```json
{
  "title": "…",
  "understanding": "…",
  "conditions": "…",
  "limitations": "…",
  "sourceKeys": ["attempt:att-…", "capture:cap-…"],
  "revision": 3,
  "operationId": "client-uuid"
}
```

- `revision` 必填，缺失返回 `428 { "error": "revision_required" }`。
- 与当前 capture revision 不一致：`409 { "error": "revision_conflict", "current": { "revision", "title", "understanding", "updatedAt" } }`。客户端保留用户正在编辑的文字，只提示载入最新版本。
- 传 `sourceKeys` 时不能为空，也不能把自己 `capture:<id>` 当依据。
- 不传 `sourceKeys` 时沿用现有来源，不会静默删除。
- 修改过「我的理解」后，正文出处自动变为 `user_edited`；模型草稿未被用户改写时仍保留 `model_draft` 出处。
- 成功：`200 { "experience": ExperiencePublic, "replayed": false }`；经验 revision 与 capture revision 同步 +1。

## 4. 列表、详情与搜索

### `GET /api/experiences?archived=exclude|include|only&limit=<n>&q=<text>`

返回 `{ "experiences": ExperienceListItem[] }`。默认排除归档；`q` 只用于管理页轻量筛选，不改搜索命中原因口径。

### `GET /api/experiences/:id`

返回 `{ "experience": ExperiencePublic }`；不存在 `404 { "error": "experience_not_found" }`。

`ExperiencePublic` 关键字段：

| 字段 | 含义 |
| --- | --- |
| `title` / `understanding` / `conditions` / `limitations` | 用户整理后的内容 |
| `derivation.by` | `user` 或 `model` |
| `derivation.modelBasis` | 模型是 `observation` 还是 `inference` |
| `derivation.originKind` / `originQueryId` / `originPointIndex` / `originAttemptId` / `contextCaptureId` | 整理出处，问答 ID 只作出处，不代替底层记录 |
| `derivation.confirmNote` | 明确「用户确认保存 ≠ 已证实」 |
| `needsRevision` / `revisionReason` | 来源删除或需核对时的待修订标记 |
| `sources[]` | 每条依据的 `deleted`、`exists`、`changed`、`kind`、`resultText`、`observedAt`、`openHref`、`graphHref` |
| `sourceCount` / `changedSourceCount` / `deletedSourceCount` | 来源数量与状态计数 |
| `hasPracticeResult` | 是否至少有一条带实际结果的依据；`false` 时界面显示「尚无实践结果支持」 |
| `attempts[]` | 后续尝试、结果、`adoptedVersion` / `adoptedTitle` / `adoptedUnderstanding` |
| `linkCount` | 手动链接数量 |
| `canEdit` | 当前是否可编辑 |

`ExperienceListItem` 额外含 `summary`、`attemptCount`、`derivationBy`，不含完整正文与来源。

### `GET /api/experiences/search?q=<text>`

返回 `{ "hits": ExperienceSearchHit[] }`，每项含 `matchReason`（如「标题命中」「我的理解命中」）与 `snippet`。只搜索未归档经验；已删除来源的正文不会因搜索泄露。

### `GET /api/experiences/source-candidates?q=<text>&excludeExperienceId=<id>`

返回 `{ "candidates": [...] }`，仅包含带实际结果的尝试和普通念头，并排除当前经验自身；尝试与念头各最多 8 条，合计最多 16 条。

## 5. 参考它，试一步

### `POST /api/experiences/:id/attempts`

```json
{
  "captureId": "cap-…",
  "title": "参考经验再试一次",
  "description": "睡前把手机放到书桌上，明早记录。",
  "basisSourceKeys": ["attempt:att-…"],
  "experienceRevision": 2,
  "operationId": "client-uuid"
}
```

- `captureId` 必须是仍可用的普通念头（`kind='thought'`）；经验自身或已删除念头返回 `409 { "error": "capture_unavailable" }`。
- 经验已归档：`409 { "error": "experience_archived" }`。
- `experienceRevision` 可选；若给出且与当前不一致：`409 { "error": "experience_version_conflict", "currentRevision": n }`。
- `basisSourceKeys` 只能选这条经验下**未删除的原始尝试**；否则 `422 { "error": "basis_source_unavailable" }`。只有实际勾选的尝试进入既有 `attempt_references`。
- 创建的是现有 Attempt（`state='todo'`、`origin='manual'` 的普通行动，不自动建日程、不自动填结果），并在 `experience_attempts` 保存 `adopted_version`、`adopted_title`、`adopted_understanding`。之后仍用现有结果表单。
- 幂等：同一 `operationId` 返回同一 `attempt`，`200 ... "replayed": true`；重复提交不会多建尝试或引用。
- 成功：`201 { "attempt": {...}, "experienceId": "exp-…", "replayed": false }`。

## 6. 归档、删除与来源失效

- 归档/恢复沿用 `POST /api/captures/:id/archive|unarchive`。
- `GET /api/experiences/:id/delete-preview` 返回 `experienceId`、`title`、`sourceCount`（总来源数，包含已删除）、`attemptCount`、`linkCount`、`sources[]`、`attempts[]`。删除经验**不会**删除来源记录或后续尝试结果。
- 删除念头或尝试前，原删除预览增加 `affectedExperiences`：

```json
{
  "affectedExperiences": [
    {
      "id": "exp-…",
      "title": "…",
      "deletedSourceCount": 1,
      "willClearUnderstanding": true
    }
  ]
}
```

- 来源永久删除后：
  - `experience_sources` 清空标题/正文/结果/状态/时间快照并标 `deleted=1`；
  - 模型整理正文（`understanding_origin='model_draft'`）保守清空「我的理解」，`needsRevision=true`，`revisionReason='依据记录已删除，模型整理的正文已清空，请重新整理。'`；
  - 用户自己整理的正文保留，只标记待核对，`revisionReason='依据记录已删除；正文保留，请核对后修订。'`；
  - 引用该经验的后续尝试：`experience_attempts.deleted=1`，`adopted_title='来源经验已删除'`、`adopted_understanding=''`，**保留尝试本身及其结果**。
- 来源被修改：来源行保留旧快照并标 `changed=true`，详情显示「来源有更新，建议重新核对」；保存修订时刷新快照，不静默覆盖用户文字。

## 7. 问答、搜索、图谱与导出

- 问答事实证据只使用原始记录；`askData` 明确排除经验摘要，避免经验与其原始来源重复计为两份证据。
- `GET /api/search?q=…` 增加 `experiences[]`，不改原有 `results[]` 语义。
- `GET /api/graph` 与 `/api/graph/focus` 增加 `type='experience'` 节点，以及 `evidence`（依据这条记录）、`used`（参考这条经验再试）、`context`（所属念头）关系；节点仍为小圆点、低饱和、细线。手动链接仍是 `related`，界面不把它说成证据。
- `GET /api/capture/:id/links`（现有链接接口）返回的节点增加 `kind`、`title`、`href`，反链可正确显示经验。
- JSON 导出升级为 `schemaVersion: 6`：
  - `data.captures[]` 增加 `kind`；
  - 新增 `data.experienceNotes`、`data.experienceSources`、`data.experienceAttempts`；
  - 其余既有表保持原名。
- 项目当前没有 JSON 导入功能；恢复仍是整库 SQLite 备份替换后启动迁移。

## 8. 错误速查

| HTTP | error | 触发 |
| --- | --- | --- |
| 401 | `unauthenticated` | 未登录或会话失效 |
| 404 | `experience_not_found` | 经验不存在/已删除 |
| 404 | `point_not_found` | 问答观点索引不存在 |
| 409 | `source_unavailable` | 来源在保存前被改到不可访问 |
| 409 | `revision_conflict` | 经验正文版本已变化 |
| 409 | `experience_version_conflict` | 创建尝试时经验版本已变化 |
| 409 | `experience_archived` | 参考已归档经验 |
| 409 | `capture_unavailable` | 尝试归属念头不可用 |
| 422 | `source_required` | 没有仍可访问的来源 |
| 422 | `basis_source_unavailable` | 勾选的依据尝试已删除 |
| 409 | `attempt_result_required` | 尝试没有实际结果，不能作为整理入口 |
| 404 | `attempt_not_found` | 尝试不存在 |
| 428 | `revision_required` | 修订缺少版本号 |
