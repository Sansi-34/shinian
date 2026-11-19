# 拾念 SHINIAN ·「主题导出 Markdown」接口契约（v1）

日期：2026-11-16。范围：单个主题的**单向 Markdown ZIP 导出**。本文冻结前端与后端之间的路由、请求/响应字段、错误码、`scopeHash` 语义、限制、ZIP 结构与前端流程。实现文件为 `src/server/topicExportService.ts`、`src/server/topicExportRoutes.ts`、`src/server/zip.ts` 与 `src/server/index.ts` 的注册代码；如实现与本文偏离，以本文修订记录为准，并同步更新 `docs/topic-export-notes.md` 与 `README.md`。

本轮**不**调用模型、不访问外部网络、不写入 Obsidian 目录、不提供导入/同步/增量更新，也不修改数据库 schema。

## 0. 术语

| 术语 | 含义 |
| --- | --- |
| 主题（topic） | `topics` 中的一行，包含标题、探索问题、继续说明、固定下一步与 `revision`。 |
| 主题成员（member） | `topic_members` 中的一行，指向一个 capture；`member_kind` 为 `thought` 或 `experience`。 |
| 记录（record） | 导出中的一个念头、经验或尝试实体。念头/经验是 capture，尝试是 attempt。 |
| 主题内记录 | 通过 `topic_members` 直接属于该主题的 capture，以及这些 **thought** capture 下的真实 attempts。 |
| 一跳依据（basis） | 主题内经验成员通过 `experience_sources` 直接引用的主题外记录；用户可在预览中勾选追加。 |
| 导出范围（scope） | 「主题字段 + 选项 + 全部将写入 ZIP 的记录、关系、计数、文件清单」的只读快照。 |
| 快照 | 在一次只读数据库事务中读取到的当前值；不是历史版本库。 |
| 历史快照 | 引用/依据/采用关系在建立时保存的旧正文或旧结果，和当前记录正文分开标注。 |

## 1. 通用约定

- 两个接口都要求本机会话登录。未登录返回 `401 { "error": "unauthenticated" }`。
- 沿用现有 Host / Origin 校验：Host 不在本机白名单返回 `403 { "error": "host rejected" }`；跨站写请求返回 `403 { "error": "origin rejected" }`。
- 请求与响应均为 JSON（导出成功除外，成功响应是 ZIP 二进制）。错误一律 JSON，UTF-8。
- 所有时间字段都是 Unix 毫秒整数（`*At` 字段）；`manifest.json` 的 `generatedAt` 是 ISO 8601 字符串。
- 两个接口都**只读**：不修改主题、成员、尝试、经验、引用、归档状态或 `revision`，不写 `mutation_receipts`，不产生后台任务。
- 主题 ID 使用完整稳定 ID（含 `topic-` 前缀）。文件名/目录名中的 `<topicId>` 均指完整 ID；因此会出现 `shinian-topic-topic-...`，这是预期结果，不额外剥离前缀。
- 字段名区分大小写。客户端应忽略响应中未声明的额外字段；服务端不得依赖客户端传来的未知字段。
- 本文中的「当前」均指导出事务读取到的数据库当前值；「历史快照」只出现在关系元数据中，见 §6.4。

## 2. 共享对象

### 2.1 `TopicExportTopic`

```json
{
  "id": "topic-1763200000000-ab12cd",
  "title": "PWM 调光实验",
  "revision": 3,
  "archived": false,
  "archivedAt": null,
  "createdAt": 1763200000000,
  "updatedAt": 1763200100000
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主题稳定 ID。 |
| `title` | string | 当前标题，1–120 字符。 |
| `revision` | integer | 主题 `revision`；标题/说明/成员/固定下一步/归档变化都会 +1。 |
| `archived` | boolean | 是否已归档。 |
| `archivedAt` | number \| null | 归档时间；未归档为 `null`。 |
| `createdAt` | number | 创建时间。 |
| `updatedAt` | number | 最后更新时间。 |

### 2.2 `ExportFileEntry`

预览文件清单与 `manifest.json` 的 `files[]` 共用该形状：

```json
{
  "path": "records/thoughts/thought-cap-1763199990000-def456.md",
  "entityType": "thought",
  "entityId": "cap-1763199990000-def456",
  "title": "500 Hz 下 LED 会闪",
  "archived": false,
  "basis": false,
  "revision": 2
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 相对 ZIP 根目录的 POSIX 路径，不带前导 `/`；只允许 §8.4 的固定白名单形状。 |
| `entityType` | string | `index` \| `readme` \| `manifest` \| `thought` \| `experience` \| `attempt`。 |
| `entityId` | string \| null | 记录稳定 ID；三个元数据文件为 `null`。 |
| `title` | string | 展示标题：index 为主题标题；readme 为 `README`；manifest 为 `manifest.json`；记录为当前标题/行动首行。不含换行。 |
| `archived` | boolean | 记录/所属 capture 的归档状态；index/readme 取主题归档状态；manifest 固定 `false`。 |
| `basis` | boolean | 是否因为用户勾选「一跳依据」而加入；主题成员与三个元数据文件为 `false`。 |
| `revision` | integer \| null | index 为主题 `revision`；thought/experience 为 capture `revision`；attempt 为 attempt `revision`；readme/manifest 为 `null`。 |

`manifest.json` 的 `files[]` 额外有：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bytes` | integer \| null | 该条目未压缩 UTF-8 字节数；`manifest.json` 自身为 `null`（避免自引用）。 |
| `sha256` | string \| null | 该条目内容的小写十六进制 SHA-256；`manifest.json` 自身为 `null`。 |

### 2.3 `BasisCandidate`

```json
{
  "sourceKey": "attempt:att-1763199980000-abc123",
  "entityType": "attempt",
  "entityId": "att-1763199980000-abc123",
  "title": "一条主题外尝试",
  "summary": "用于区分同名记录的一小段摘要",
  "sourceExperienceId": "cap-1763199970000-exp001",
  "sourceExperienceTitle": "引用它的经验",
  "referencedBy": ["引用它的经验"],
  "deleted": false,
  "selectable": true,
  "reason": "经验依据"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sourceKey` | string | `attempt:<attemptId>` 或 `capture:<captureId>`；与经验依据的 `source_key` 一致。 |
| `entityType` | string | `thought` 或 `attempt`；经验成员的直接依据不会是另一份经验（`kind='experience'` 被排除）。 |
| `entityId` | string | 对应的 attempt ID 或 capture ID。 |
| `title` | string | 当前展示标题；已删除/缺失来源固定为 `来源已删除`。 |
| `summary` | string | 用于区分同名记录的一小段摘要；已删除来源为空字符串。 |
| `sourceExperienceId` | string | 引用该来源的主题内经验 capture ID（多个时取主题成员顺序中的第一个）。 |
| `sourceExperienceTitle` | string | 该经验的当前标题。 |
| `referencedBy` | string[] | 引用同一 `sourceKey` 的全部主题内经验标题，去重，按主题成员顺序。 |
| `deleted` | boolean | 来源行 `deleted=1` 或底层 attempt/capture 已不存在时为 `true`。 |
| `selectable` | boolean | 仅 `deleted=false` 时为 `true`；已删除来源不能在导出时追加。 |
| `reason` | string | 人类可读原因，例如 `经验依据`、`来源已删除`；不是稳定机器枚举。 |

规则：

- 只列出主题内**已包含的经验成员**的直接 `experience_sources`，不递归经验的经验或关系。
- 同一 `sourceKey` 被多个经验引用时只出现一次，`referencedBy` 汇总。
- 已经是主题成员的记录不再作为候选。
- 已删除来源只在候选列表中给占位信息，**不返回也不允许读取正文/结果快照**。
- 候选不因 `includeArchived=false` 而显示归档状态字段；归档状态不参与候选是否可选（显式勾选即可追加，见 §6.3）。

### 2.4 `OmittedRelations`

```json
{
  "total": 2,
  "byType": {
    "manualLink": 1,
    "attemptReference": 1,
    "experienceSource": 0,
    "experienceAdoption": 0
  }
}
```

- 只统计「与已包含实体相邻、但另一端未包含或已删除」的真实关系；不返回关系 ID、标题或正文。
- `total = manualLink + attemptReference + experienceSource + experienceAdoption`。
- 主题成员关系（`topic_members`）不计入；它决定文件是否存在，不是导出中的关系行。

### 2.5 `ExportLimits`

```json
{
  "maxFiles": 2000,
  "maxAttempts": 2000,
  "maxBytes": 20971520,
  "maxBasisKeys": 200,
  "exceeded": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxFiles` | integer | ZIP 条目上限（含 `主题索引.md`、`README.md`、`manifest.json`；不含目录项）。 |
| `maxAttempts` | integer | 导出中的 attempt 文件上限。 |
| `maxBytes` | integer | 20 MiB = `20 * 1024 * 1024 = 20971520`，指最终 ZIP 字节数。 |
| `maxBasisKeys` | integer | `includeBasisKeys` 去重后的数量上限；超过在请求校验阶段返回 400，不进入预览。 |
| `exceeded` | string[] | 预览中已超限的维度，取值 `files` \| `attempts` \| `bytes`；无超限为 `[]`。`basisKeys` 不会出现在这里（请求校验先返回 400）。 |

## 3. 预览接口

### 3.1 路由

```http
POST /api/topics/:id/export/preview
Cookie: shinian_sid=<session>
Content-Type: application/json
```

需要登录。`id` 是完整主题 ID（`topic-...`）。

### 3.2 请求

```json
{
  "includeArchived": true,
  "includeBasisKeys": ["attempt:att-1763199980000-abc123"]
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `includeArchived` | boolean | 否 | `true` | 是否包含主题内已归档的普通念头/经验成员及其尝试。只接受布尔值；`null`/字符串/数字返回 400。 |
| `includeBasisKeys` | string[] | 否 | `[]` | 要追加的一跳依据 `sourceKey` 列表。每项必须是 `attempt:<id>` 或 `capture:<id>`；服务端去重后按字典序排序。去重后最多 200 个；超过返回 400。 |

规范化规则：

1. `includeBasisKeys` 先去重（同一字符串只保留一次），再按 UTF-8 字典序排序；响应 `scope.includeBasisKeys` 回显规范化后的数组。
2. 每个 key 必须属于**本次请求选项下**当前预览候选的 `sourceKey`；不存在、格式错误、或指向已删除/不可选来源返回 400 `invalid_request`。
3. `includeArchived=false` 时，已归档经验成员不进入范围，其依据候选也不存在；引用这些候选的 key 视为无效。
4. 请求体省略或为 `{}` 等价于 `{ "includeArchived": true, "includeBasisKeys": [] }`。请求体不是对象返回 400。

### 3.3 成功响应 `200`

```json
{
  "topic": {
    "id": "topic-1763200000000-ab12cd",
    "title": "PWM 调光实验",
    "revision": 3,
    "archived": false,
    "archivedAt": null,
    "createdAt": 1763200000000,
    "updatedAt": 1763200100000
  },
  "scope": {
    "includeArchived": true,
    "includeBasisKeys": ["attempt:att-1763199980000-abc123"],
    "counts": {
      "thoughts": 2,
      "experiences": 1,
      "attempts": 4,
      "basisThoughts": 0,
      "basisExperiences": 0,
      "basisAttempts": 1,
      "files": 9,
      "manualLinks": 2,
      "attemptReferences": 3,
      "experienceSources": 4,
      "experienceAdoptions": 1
    },
    "archived": { "members": 1, "thoughts": 1, "experiences": 0 },
    "files": [
      {
        "path": "主题索引.md",
        "entityType": "index",
        "entityId": null,
        "title": "PWM 调光实验",
        "archived": false,
        "basis": false,
        "revision": 3
      },
      {
        "path": "README.md",
        "entityType": "readme",
        "entityId": null,
        "title": "README",
        "archived": false,
        "basis": false,
        "revision": null
      },
      {
        "path": "manifest.json",
        "entityType": "manifest",
        "entityId": null,
        "title": "manifest.json",
        "archived": false,
        "basis": false,
        "revision": null
      }
    ],
    "basisCandidates": [
      {
        "sourceKey": "attempt:att-1763199980000-abc123",
        "entityType": "attempt",
        "entityId": "att-1763199980000-abc123",
        "title": "一条主题外尝试",
        "summary": "用于区分同名记录的一小段摘要",
        "sourceExperienceId": "cap-1763199970000-exp001",
        "sourceExperienceTitle": "引用它的经验",
        "referencedBy": ["引用它的经验"],
        "deleted": false,
        "selectable": true,
        "reason": "经验依据"
      }
    ],
    "omittedRelations": {
      "total": 2,
      "byType": {
        "manualLink": 1,
        "attemptReference": 1,
        "experienceSource": 0,
        "experienceAdoption": 0
      }
    },
    "estimatedBytes": 12345,
    "limits": {
      "maxFiles": 2000,
      "maxAttempts": 2000,
      "maxBytes": 20971520,
      "maxBasisKeys": 200,
      "exceeded": []
    },
    "warnings": []
  },
  "scopeHash": "8f2c...64位小写十六进制...",
  "canExport": true
}
```

顶层字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `topic` | `TopicExportTopic` | 预览时的主题当前值。 |
| `scope` | object | 本次预览的完整范围与文件清单，见下。 |
| `scopeHash` | string | 64 位小写十六进制 SHA-256，语义见 §5。 |
| `canExport` | boolean | `scope.limits.exceeded.length === 0` 时为 `true`；否则 `false`。 |

`scope` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `includeArchived` | boolean | 回显规范化后的选项。 |
| `includeBasisKeys` | string[] | 回显去重排序后的选择。 |
| `counts` | object | 见 §3.4。 |
| `archived` | object | 主题当前成员的归档统计，**不受** `includeArchived` 影响：`members` = 归档成员总数，`thoughts` / `experiences` 按成员类型分列。 |
| `files` | `ExportFileEntry[]` | 本次将写入 ZIP 的全部条目（含三个元数据文件）；顺序见 §3.5。 |
| `basisCandidates` | `BasisCandidate[]` | 可追加的一跳依据候选；含已删除占位，不含正文。 |
| `omittedRelations` | `OmittedRelations` | 未包含关系统计。 |
| `estimatedBytes` | integer | 按渲染后 UTF-8 字节数估算的 ZIP 内容大小（含元数据，不含 ZIP 压缩开销）；仅用于预览，不保证等于最终 ZIP 字节数。 |
| `limits` | `ExportLimits` | 本轮限制与超限维度。 |
| `warnings` | string[] | 人类可读提示；`limits.exceeded` 非空时至少为每个超限维度给一条原因。可为空数组。 |

### 3.4 `scope.counts`

| 字段 | 说明 |
| --- | --- |
| `thoughts` | 本次包含的主题内普通念头 capture 数（按 `includeArchived` 过滤后）。 |
| `experiences` | 本次包含的主题内经验 capture 数（按 `includeArchived` 过滤后）。 |
| `attempts` | 本次包含的 attempt 数：所有包含的 thought 成员下的**全部**真实 attempts（服务端完整读取，不按页面分页）+ 勾选的 basis attempt。 |
| `basisThoughts` | 勾选的一跳依据中，`entityType='thought'` 的数量。 |
| `basisExperiences` | 勾选的一跳依据中，`entityType='experience'` 的数量；v1 经验依据排除 `kind='experience'`，正常为 `0`。 |
| `basisAttempts` | 勾选的一跳依据中，`entityType='attempt'` 的数量。 |
| `files` | ZIP 条目总数（含三个元数据文件；不含目录项）。 |
| `manualLinks` | 本次包含的 `capture_links` 关系数（两端都在包内）。 |
| `attemptReferences` | 本次包含的 `attempt_references` 关系数（两端都在包内）。 |
| `experienceSources` | 本次包含的 `experience_sources` 关系数（经验与来源都在包内且未删除）。 |
| `experienceAdoptions` | 本次包含的 `experience_attempts` 采用关系数（尝试与经验都在包内且未删除）。 |

计数规则：

- 计数是**去重后的实体/关系数**，不是行数重复累加；同一 attempt 即使同时是 thought 成员下的尝试和经验依据，也只生成一个 attempt 文件，`counts.attempts` 只计一次。
- `files = 3 + thoughts + experiences + attempts + basisThoughts + basisExperiences + basisAttempts`（前提是没有被排除的重复实体；服务端以最终 `files[]` 长度为准）。
- 超限时不截断：`counts` 与 `files` 仍返回完整结果，让用户知道真实规模；只在 `limits.exceeded` 标注。

### 3.5 `files` 顺序

固定顺序（也是 ZIP 条目顺序）：

1. `主题索引.md`（`entityType=index`）
2. `README.md`（`entityType=readme`）
3. `manifest.json`（`entityType=manifest`）
4. 主题内 thoughts：按 `topic_members.created_at ASC, id ASC`
5. 主题内 experiences：按 `topic_members.created_at ASC, id ASC`
6. 主题内 attempts：先按所属 thought 成员的成员顺序，再按 `attempts.created_at ASC, id ASC`
7. basis thoughts：按 `sourceKey` 字典序
8. basis experiences：按 `sourceKey` 字典序（v1 通常为空）
9. basis attempts：按 `sourceKey` 字典序

同一记录只出现一次；若某记录同时满足多个分组，以主题成员优先（`basis=false`）。目录项不进入 `files`。

### 3.6 预览行为

- 预览始终重新读取数据库，不缓存、不使用 ETag；相同请求在数据未变时得到相同 `scopeHash`。
- 预览只读：不清理失效的固定下一步，不修改任何行，不写回执。
- 预览可以在未配置 AI 模型时使用；不触发模型/网络。
- 主题不存在返回 404 `topic_not_found`；主题存在但已归档仍可预览/导出，`topic.archived=true`。

## 4. 导出接口

### 4.1 路由

```http
POST /api/topics/:id/export
Cookie: shinian_sid=<session>
Content-Type: application/json
```

### 4.2 请求

在预览请求字段上增加 `expectedScopeHash`：

```json
{
  "includeArchived": true,
  "includeBasisKeys": ["attempt:att-1763199980000-abc123"],
  "expectedScopeHash": "8f2c...预览返回的64位小写十六进制..."
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `expectedScopeHash` | string | 是 | 必须等于预览返回的 `scopeHash`；缺失、非字符串、不是 64 位小写十六进制返回 400。 |

- 其余字段与预览完全相同，使用同一套规范化规则。
- 导出不是幂等接口：没有 `operationId`；每次成功调用都会重新生成 ZIP，文件名时间戳可能不同。相同快照重复调用不会修改业务数据。
- `expectedScopeHash` 只用于乐观并发校验，不是权限令牌；不能替代登录。

### 4.3 成功响应 `200`

```http
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="shinian-topic-topic-1763200000000-ab12cd-20261116-180500.zip"
Content-Length: 34567
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

- Body 是完整 ZIP 二进制；不得返回 JSON 包裹或 base64。
- `Content-Disposition` 的 `filename` 必须使用 ASCII 安全字符，形如：
  `shinian-topic-<topicId>-<YYYYMMDD-HHmmss>.zip`
  - `<topicId>` 是完整主题 ID（含 `topic-`）。
  - `<YYYYMMDD-HHmmss>` 是服务器本地时间，24 小时制，秒级；例如 `20261116-180500`。
  - 不添加 RFC 5987 `filename*` 以外的额外文件名；若实现添加 `filename*`，必须与 `filename` 指向同一名字。
- `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff` 为推荐响应头；`Content-Length` 若框架可计算应返回。
- ZIP 根目录为 `shinian-topic-<topicId>/`（同样含完整 ID），见 §8。

### 4.4 校验顺序

服务端按以下顺序处理（前面的错误优先返回）：

1. 会话校验：未登录 → 401。
2. Host / Origin 校验：失败 → 403。
3. 请求体结构：非对象、`includeArchived` 非布尔、`includeBasisKeys` 非字符串数组、格式错误、去重后 >200 → 400 `invalid_request`。
4. `expectedScopeHash` 缺失/格式错误 → 400 `invalid_request`。
5. 主题存在性：不存在 → 404 `topic_not_found`。
6. 读取只读快照，构建当前范围与 `scopeHash`；此时 `includeBasisKeys` 在当前候选中不可选（已删除/已移出范围）→ 409 `export_scope_changed`，并返回 `currentScopeHash` 与 `invalidKeys`。
7. `expectedScopeHash` 与当前 `scopeHash` 不一致 → 409 `export_scope_changed`。
8. 超过限制 → 413 `export_limit_exceeded`。
9. 渲染 Markdown、生成 ZIP、写响应；生成失败返回通用 500，不泄露堆栈/文件系统路径。

说明：实际实现先解析请求体、再读取主题，因此「请求体格式错误」优先于「主题不存在」；这与业务无关，但客户端应按上述顺序理解错误优先级。步骤 6 与 7 都属于「预览后范围变了」；步骤 6 额外给 `invalidKeys`，便于前端清理选择。

### 4.5 错误响应

#### 400 `invalid_request`

```json
{
  "error": "invalid_request",
  "message": "includeBasisKeys 最多只能选择 200 个一跳依据。",
  "field": "includeBasisKeys"
}
```

常见触发：

| 触发 | `field` | 说明 |
| --- | --- | --- |
| 请求体不是对象 | — | `message` 说明需要 JSON 对象。 |
| `includeArchived` 非布尔 | `includeArchived` | `null`、字符串、数字均拒绝。 |
| `includeBasisKeys` 非数组/含非字符串 | `includeBasisKeys` | 每项必须是 `attempt:`/`capture:` 前缀的稳定 ID。 |
| 去重后超过 200 | `includeBasisKeys` | 明确提示「最多 200 个一跳依据」。 |
| key 不在当前候选/已删除（**预览**接口） | `includeBasisKeys` | 返回 400，并附 `invalidKeys: string[]`；前端据此清理选择并重新预览。 |
| `expectedScopeHash` 缺失/格式错误 | `expectedScopeHash` | 必须为预览返回的 64 位小写十六进制。 |

#### 404 `topic_not_found`

```json
{ "error": "topic_not_found", "message": "主题已不存在。" }
```

主题在预览后被删除，或 ID 本身不存在。

#### 409 `export_scope_changed`

```json
{
  "error": "export_scope_changed",
  "message": "导出范围已变化，请重新预览后再试。",
  "currentScopeHash": "c41d...当前快照的64位小写十六进制...",
  "invalidKeys": ["attempt:att-..."]
}
```

- `currentScopeHash` 是按**同一请求选项**对当前快照重新计算的值；客户端可用它更新本地预览，但推荐重新调用 preview 获取完整计数与文件清单。
- `invalidKeys` 只在「`includeBasisKeys` 中有 key 已不可选（来源删除/移出范围）」时出现；此时导出未生成 ZIP。客户端应清理这些 key 后重新预览。
- 任何成员、标题/正文、尝试结果/状态/观察时间、引用、经验依据、归档状态、`includeArchived`、`includeBasisKeys` 变化都可能导致该错误。
- 客户端不得自动用旧 `scopeHash` 重试；必须先重新预览并让用户确认。

#### 413 `export_limit_exceeded`

```json
{
  "error": "export_limit_exceeded",
  "message": "导出内容超过上限，请缩小范围后重试。",
  "details": {
    "limits": {
      "maxFiles": 2000,
      "maxAttempts": 2000,
      "maxBytes": 20971520,
      "maxBasisKeys": 200,
      "exceeded": ["files", "attempts", "bytes"]
    },
    "actual": {
      "files": 2001,
      "attempts": 2310,
      "basisKeys": 1,
      "bytes": 24567890
    },
    "exceeded": ["files", "attempts", "bytes"]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `details.limits` | 与预览 `limits` 相同的四个上限，另含 `exceeded`（string[]）。 |
| `details.actual.files` | 本次拟生成的 ZIP 条目数（含元数据）。 |
| `details.actual.attempts` | 本次拟生成的 attempt 文件数。 |
| `details.actual.basisKeys` | 本次请求生效的一跳依据数（诊断用；该维度在请求校验阶段已限制，不会单独触发 413）。 |
| `details.actual.bytes` | 触发本次 413 的字节数：预检时为渲染后估算字节数，最终 ZIP 复检时为实际 ZIP 字节数。 |
| `details.exceeded` | `files` \| `attempts` \| `bytes` 的子集；空数组不应出现在 413 中。 |

- 预览的 `estimatedBytes` 超过 `maxBytes` 时，预览返回 `limits.exceeded:["bytes"]`、`canExport:false`；实际导出仍以最终 ZIP 字节数复查。
- 超限必须给明确维度，不静默截断、不生成部分 ZIP。

#### 其他

- `401 { "error": "unauthenticated" }`
- `403 { "error": "host rejected" }` / `403 { "error": "origin rejected" }`
- `500 { "error": "export_failed", "message": "导出失败，请稍后重试。" }`（不泄露内部细节；仅作为未预期错误的兜底，不属于正常业务分支）

## 5. `scopeHash` 语义

### 5.1 定义

- 类型：64 位小写十六进制字符串（SHA-256）。
- 由服务端计算，客户端只作为不透明校验值回传；**不得**在客户端自行计算、拼接或修改。
- 预览与导出使用同一套规范化构建逻辑；导出在只读事务中重新构建快照后计算。
- `scopeHash` 不直接包含 `generatedAt`、文件名时间戳、`estimatedBytes` 或随机数，因此同一范围在数据未变时预览与导出得到相同值。实现可能把由大小派生的 `warnings`/`limits` 一并纳入签名；只要同一快照稳定即可。

### 5.2 必须绑定的内容

`scopeHash` 的输入至少覆盖：

1. `formatVersion`（当前为 `1`）。
2. 主题全字段：`id`、`title`、`exploringQuestion`、`continueNote`、`nextAttemptId`、`nextAttemptClearedReason`、`revision`、`archivedAt`、`createdAt`、`updatedAt`。
3. 选项：`includeArchived` 与去重排序后的 `includeBasisKeys`。
4. 全部主题成员（含被 `includeArchived=false` 排除的归档成员）及其 capture 的正文/标题、`revision`、`archivedAt`、`updatedAt`、`kind`、`memberKind`、成员加入时间。
5. 所有 thought 成员下全部 attempts 的 `step`、`state`、`resultText`、`outcome`、`sourceUrl`、`observedAt`、`revision`、`createdAt`、`updatedAt`、`actionDescription` 等导出字段。
6. 相关 capture（含成员与一跳依据的所属念头）与 `experience_notes` 全字段。
7. 与包含实体相邻的 `capture_links`、`attempt_references`（含 `note`、`revision`、`snapshotResultText`、`snapshotRevision`）。
8. 主题内经验的 `experience_sources`（含 `deleted`、`source_*` 快照、`updatedAt`）；包内来源的完整快照。
9. 相关 `experience_attempts` 采用关系（含 `adopted_version`、`adopted_title`、`adopted_understanding`、`deleted`）。
10. 全部 `basisCandidates` 的描述（`sourceKey`、标题、摘要、`referencedBy`、`deleted`、`selectable`）。
11. 最终 included 集合（`includedCaptureKeys`、`includedAttemptKeys`）、`counts`、`omittedRelations`、`archived`、`files` 元数据（路径、实体、标题、归档、basis、revision）、`relations`、`warnings` 与 `limits`（含 `exceeded`）。

实现采用「递归按对象 key 字典序排序后再 `JSON.stringify`」的稳定序列化；数组必须显式排序（成员、尝试、关系、候选、文件均按稳定键）。同一实现内必须可重复。

### 5.3 变化敏感性

以下任一变化**必须**使 `scopeHash` 变化（概率上）：

| 变化 | 例子 |
| --- | --- |
| 主题字段 | 标题、探索问题、继续说明、固定下一步、归档/恢复、`revision`。 |
| 成员增删 | 加入/移出主题；删除 capture 导致成员级联。 |
| 记录正文/标题 | 念头原文、经验标题/理解/条件/限制、尝试 `step`。 |
| 尝试结果/状态 | `resultText`、`outcome`、`state`、`observedAt`、`revision`。 |
| 引用/关联 | 创建/删除/修改 `capture_links`、`attempt_references` 的 note/快照。 |
| 经验依据 | 新增/删除依据、`deleted` 翻转、来源快照变化。 |
| 采用关系 | `experience_attempts` 新增/删除、采用版本/快照变化。 |
| 归档状态 | 主题归档、成员 capture 归档/恢复。 |
| 选项 | `includeArchived` 切换、`includeBasisKeys` 增删/排序变化。 |

反向不要求：不影响导出内容的内部字段变化（例如与主题无关的记录、`mutation_receipts`、`record_queries`、`ai_settings`）不得使 hash 变化；但实现若因无关字段变化而使 hash 变化，属于可接受的保守行为，只要不导致同一快照的预览/导出不一致。

### 5.4 客户端规则

- 预览成功后保存 `scopeHash` 与请求选项；导出时原样回传。
- 任何选项变化（`includeArchived`、勾选依据）都必须重新调用 preview，不能复用旧 hash。
- 收到 409 后丢弃旧 hash，重新预览；不要自动循环重试。
- `scopeHash` 不是内容校验和，不用于验证下载文件完整性；`manifest.json` 的 `files[].sha256` 才是单文件校验和。

## 6. 范围与内容规则

### 6.1 默认包含

- 主题标题、探索问题、继续说明、固定下一步（若有效）。
- 主题中未归档的普通念头与经验（`includeArchived=false` 时排除归档成员；默认 `true` 时包含并标注）。
- 普通念头成员下的**全部**真实 attempts：服务端完整读取，不按页面分页、不受主题尝试列表 `limit` 影响。
- 有效的「下次继续」尝试；失效的固定引用不凭空创建记录，只在索引中说明「固定下一步已失效/未固定」。
- 主题内已包含记录之间的真实关系：手动关联、尝试引用旧尝试、经验依据原记录、后续尝试采用经验；保留方向，反向视图不重复计数。

### 6.2 默认不包含

- 主题外记录（除用户显式勾选的一跳依据）。
- 主题外记录的标题/正文/快照；未包含关系只写「来源未包含在本次导出」，不写标题。
- `deleted=1` 的经验来源或缺失来源：只写「来源已删除」，不读取/写出快照正文。
- 主题外记录的其它尝试、它自己的引用、后续实践、所属主题。
- 模型配置、API Key、会话、内部回执、未保存生成、问答历史、事件动态、账号、设置。
- 日程块、研究任务、阶段回顾、AI 生成记录、通知等本轮不在导出范围的数据。

### 6.3 一跳依据（basis）规则

- 候选只来自**主题内经验成员**的直接 `experience_sources`；不递归经验的经验/关系。
- 用户勾选后，只加入**该条记录本身**：
  - `attempt:<id>` → 一个 attempt 文件；
  - `capture:<id>` → 一个 thought 文件（经验来源不会是另一份经验）。
- 不加入它的所属念头（若它是 attempt）、不加入它的其他尝试、不加入它的引用/被引用、不加入它的主题、不加入它的后续实践。
- 已删除/缺失来源 `selectable=false`，不能勾选；预览仍列出占位，便于用户理解「这里原本有一条依据」。
- `includeBasisKeys` 只能选当前预览候选；导出时若来源已被删除/移出，按 §4.4 的 409 处理（或 400 + `field`，见 §4.4 说明），前端重新预览。
- 显式勾选的一跳依据即使自身 capture 已归档也允许追加，文件中用 `shinian_archived` 标注；`includeArchived` 只控制主题成员。

### 6.4 当前内容与历史快照

必须在 Markdown 中分开标注：

| 内容 | 来源 | 标注要求 |
| --- | --- | --- |
| 记录当前正文/标题、attempt 当前 `step`/`resultText`/`outcome`/`observedAt` | 导出事务读取的当前表 | 标「导出时当前内容」与 `revision`。 |
| `attempt_references.snapshot_result_text` / `snapshot_revision` | 引用建立时保存 | 标「引用时快照（revision N）」；不得冒充当前结果。 |
| `experience_sources.source_*` | 依据建立时保存 | 标「依据建立时快照（source revision N）」；当前来源正文另起一节（若来源在包内）。 |
| `experience_attempts.adopted_*` | 采用时保存 | 标「采用时经验版本 vN」；当前经验正文另起一节（若经验在包内）。 |

规则：

- 当前结果与历史快照都必须出现时，先当前、后历史，并明确「以下为历史快照，不代表当前内容」。
- `attempt_references.snapshot_revision < 当前 attempt.revision` 或快照文本与当前 `resultText` 不同时，标注「来源结果已更新」；不得把快照当成最新结果。
- `experience_attempts.adopted_version < 当前 capture.revision` 时，标注「经验已更新（采用时 vN，当前 vM）」；采用快照仍保留。
- 未填写结果时固定显示「尚未填写实际结果（不能据此判断成败）」；不得默认失败、不得根据时间推断完成。
- `state` 映射：`todo`=待开始、`in_progress`=进行中、`done`=已完成、`cancelled`=已取消。
- `state='cancelled'` 显示「已取消」；`state='done'` 但结果为空显示「已标记完成但未填写实际结果（不能据此判断成败）」。
- `outcome` 映射：`success`=成功、`failure`=失败、`undetermined`=未判定；空值显示「未填写（用户观察评价，不是系统结论）」。
- 观察时间以 ISO 8601（UTC，`Z`）字符串输出；未填写显示「未填写」。`outcome` 只是用户观察评价，不是系统结论。

### 6.5 删除/归档/缺失来源

- 删除 capture：其 `topic_members` 级联删除；主题保留。下次预览不再包含该成员；已下载 ZIP 不受影响。
- 删除 attempt：其引用级联删除；作为依据的来源变为缺失，候选标「来源已删除」。
- 删除经验：`experience_sources` 级联删除；曾采用它的尝试保留 `experience_attempts` 行但 `deleted=1`，导出只写「来源经验已删除」，不写采用快照正文。
- 归档主题：仍可导出，`topic.archived=true`；成员不自动移出。
- 归档成员：`includeArchived=true` 时包含并标注；`false` 时排除，相关关系计入 `omittedRelations`。
- 任何情况下都不得从删除行/快照中恢复并写出正文；只允许写占位文字。

## 7. 限制与超限

| 限制 | 值 | 预览行为 | 导出行为 |
| --- | --- | --- | --- |
| `maxFiles` | 2000 | 超过 → `limits.exceeded=["files"]`、`canExport=false`、`warnings` 说明；`files` 仍完整返回。 | 413，`details.exceeded` 含 `files`。 |
| `maxAttempts` | 2000 | 超过 → `exceeded=["attempts"]`；不截断。 | 413。 |
| `maxBytes` | 20 MiB（20971520） | `estimatedBytes` 超过 → `exceeded=["bytes"]`；不截断。 | 以最终 ZIP 字节数复查；413。 |
| `maxBasisKeys` | 200 | 去重后 >200 → 直接 400 `invalid_request`，不返回预览。 | 同左。 |

- 超限不静默截断、不生成部分文件、不降低内容质量。
- 前端必须在预览中显示超限原因；`canExport=false` 时禁用导出按钮。
- `warnings` 至少覆盖每个 `exceeded` 维度；可以额外提示「预计大小接近上限」「存在已删除来源」等，但不得把警告当成错误码。

## 8. ZIP 结构、文件命名与 Markdown 格式

### 8.1 目录树

```text
shinian-topic-<topicId>/
  主题索引.md
  README.md
  manifest.json
  records/
    thoughts/thought-<captureId>.md
    experiences/experience-<captureId>.md
    attempts/attempt-<attemptId>.md
```

- 空分类目录可以省略；`files` 与 `manifest.files` 不列目录项。
- 不允许根目录外的任何路径。
- 所有记录文件都在 `records/<类型>/` 下，不使用标题或日期作为路径。

### 8.2 文件命名

| 文件 | 命名 | 说明 |
| --- | --- | --- |
| 主题索引 | `主题索引.md` | 固定中文名。 |
| 说明 | `README.md` | 固定 ASCII 名。 |
| 清单 | `manifest.json` | 固定 ASCII 名。 |
| 念头 | `records/thoughts/thought-<captureId>.md` | `captureId` 形如 `cap-...`。 |
| 经验 | `records/experiences/experience-<captureId>.md` | 同上。 |
| 尝试 | `records/attempts/attempt-<attemptId>.md` | `attemptId` 形如 `att-...`。 |

- 标题只放在正文与链接文字中，**不改路径**；改名后同一记录的路径不变。
- 稳定 ID 已全局唯一；同名记录不会冲突。不要用标题 slug 或序号生成文件名。
- 生成前校验 ID 只含 `[A-Za-z0-9_-]`；不合法时拒绝生成，不把用户输入拼进路径。

### 8.3 路径安全

ZIP 条目路径必须满足：

- 相对路径，POSIX `/` 分隔，不以 `/` 开头；
- 不含盘符（`C:`）、反斜杠 `\`、`..` 段、空段、`.` 段、NUL/控制字符；
- 不包含符号链接；不写入目录外；
- 只匹配以下白名单：
  - `主题索引.md`
  - `README.md`
  - `manifest.json`
  - `records/thoughts/thought-[A-Za-z0-9_-]+\.md`
  - `records/experiences/experience-[A-Za-z0-9_-]+\.md`
  - `records/attempts/attempt-[A-Za-z0-9_-]+\.md`

Markdown 内部的相对链接可以使用 `../` 在**包内**导航，但规范化后必须仍落在上述白名单内；不允许 `../../..` 逃出根目录。

### 8.4 编码与换行

- 所有 `.md` 与 `manifest.json` 使用 UTF-8（建议无 BOM）。
- 换行统一为 LF（`\n`）；不写 CRLF。
- ZIP 文件名使用 UTF-8，设置 ZIP 通用标志位 bit 11（UTF-8 filename）；Windows 资源管理器/7-Zip/macOS 解压不得出现乱码。
- 压缩方法不限（deflate/store 均可）；读取方不得依赖压缩方法或条目顺序。
- 文件内容中用户文本一律放在 fenced text 代码块中，围栏长度大于正文中最长连续反引号串（至少 3 个），防止用户正文中的代码块/换行破坏结构。

### 8.5 `manifest.json`

```json
{
  "formatVersion": 1,
  "app": "拾念 SHINIAN",
  "generatedAt": "2026-11-16T18:05:00.000+08:00",
  "zipRoot": "shinian-topic-topic-1763200000000-ab12cd/",
  "topic": {
    "id": "topic-1763200000000-ab12cd",
    "title": "PWM 调光实验",
    "revision": 3,
    "archived": false,
    "archivedAt": null,
    "createdAt": 1763200000000,
    "updatedAt": 1763200100000
  },
  "scopeHash": "8f2c...",
  "scope": {
    "includeArchived": true,
    "includeBasisKeys": ["attempt:att-1763199980000-abc123"],
    "counts": { "thoughts": 2, "experiences": 1, "attempts": 4, "basisThoughts": 0, "basisExperiences": 0, "basisAttempts": 1, "files": 9, "manualLinks": 2, "attemptReferences": 3, "experienceSources": 4, "experienceAdoptions": 1 },
    "archived": { "members": 1, "thoughts": 1, "experiences": 0 },
    "omittedRelations": { "total": 2, "byType": { "manualLink": 1, "attemptReference": 1, "experienceSource": 0, "experienceAdoption": 0 } },
    "limits": { "maxFiles": 2000, "maxAttempts": 2000, "maxBytes": 20971520, "maxBasisKeys": 200, "exceeded": [] },
    "warnings": []
  },
  "files": [
    {
      "path": "主题索引.md",
      "entityType": "index",
      "entityId": null,
      "title": "PWM 调光实验",
      "archived": false,
      "basis": false,
      "revision": 3,
      "bytes": 1234,
      "sha256": "..."
    },
    {
      "path": "manifest.json",
      "entityType": "manifest",
      "entityId": null,
      "title": "manifest.json",
      "archived": false,
      "basis": false,
      "revision": null,
      "bytes": null,
      "sha256": null
    }
  ],
  "notes": ["这是拾念 SHINIAN 的一次性导出副本；之后在拾念中的修改或删除不会自动更新本文件。"]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | integer | 当前固定 `1`；破坏性格式变化时递增。 |
| `app` | string | 固定 `拾念 SHINIAN`。 |
| `generatedAt` | string | ISO 8601 带时区偏移或 `Z`。 |
| `zipRoot` | string | ZIP 根目录名，`shinian-topic-<topicId>/`。 |
| `topic` | object | `TopicExportTopic` 全字段。 |
| `scopeHash` | string | 本次生成使用的 scopeHash。 |
| `scope` | object | 预览 `scope` 的 `includeArchived/includeBasisKeys/counts/archived/omittedRelations/limits/warnings` 子集（不含 `files`/`basisCandidates`/`estimatedBytes`）。 |
| `files` | array | 全部 ZIP 条目（含 `manifest.json` 自身；自身 `bytes/sha256` 为 `null`），顺序同 §3.5。 |
| `notes` | string[] | 人类可读说明；可含「独立副本」「不导入」「关系图例」等。 |

`manifest.json` 是机器可读摘要，不是导入格式；读取方不得据此还原业务数据。`files[].sha256` 是该条目内容的 SHA-256（小写十六进制），用于校验文件完整性；`bytes` 是未压缩字节数。

### 8.6 Markdown frontmatter

所有 `.md`（含 `README.md`）以 YAML frontmatter 开头：

```markdown
---
shinian_entity: thought
shinian_id: cap-1763199990000-def456
shinian_capture_id: cap-1763199990000-def456
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763199990000
shinian_updated_at: 1763200000000
shinian_revision: 2
shinian_archived: false
---
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `shinian_entity` | string | `index` \| `readme` \| `thought` \| `experience` \| `attempt`。`manifest.json` 无 frontmatter。 |
| `shinian_id` | string | index/readme = 主题 ID；thought/experience = capture ID；attempt = attempt ID。 |
| `shinian_capture_id` | string | thought/experience = 自身 capture ID；attempt = 所属 capture ID（即使该念头只是主题外一跳依据、没有生成念头文件，也写稳定 ID，不写标题/正文）；index/readme 不写该字段。 |
| `shinian_topic_id` | string | 主题稳定 ID。 |
| `shinian_created_at` | integer | 实体创建时间（毫秒）；index/readme 取主题创建时间。 |
| `shinian_updated_at` | integer | 实体更新时间（毫秒）；index/readme 取主题更新时间。 |
| `shinian_revision` | integer \| null | index = 主题 revision；thought/experience = capture revision；attempt = attempt revision；readme = `null`。 |
| `shinian_archived` | boolean | index/readme = 主题归档状态；记录 = 自身或所属 capture 的归档状态。 |

规则：

- frontmatter 只使用固定键和服务端生成/规整的值；**用户文本不进入 frontmatter**，避免 YAML 注入。
- 字符串值按 YAML/JSON 安全标量输出（ID 不用引号也可，但实现应统一；含特殊字符时必须加引号）。
- `---` 必须是文件第一行；frontmatter 结束后空一行再写正文。
- 读取方不得依赖 frontmatter 键的顺序。

### 8.7 相对链接编码

- 链接目标使用 POSIX `/`；不使用绝对路径、`file://`、盘符或反斜杠。
- 逐段做 UTF-8 百分号编码：保留 `/`，空格编码为 `%20`，中文文件名编码为 `%E4...`；`..` 保持原样用于包内上行导航。
- 示例（从 `records/thoughts/thought-cap-a.md` 出发）：
  - 到尝试：`../attempts/attempt-att-b.md`
  - 到经验：`../experiences/experience-cap-c.md`
  - 到索引：`../../%E4%B8%BB%E9%A2%98%E7%B4%A2%E5%BC%95.md`（`主题索引.md`）
- 链接文字必须做 Markdown 转义（至少转义 `\`、`[`、`]`），把换行折叠为空格；完整正文放在代码块中，不依赖链接文字承载。
- 每个链接目标必须是同一 ZIP 中的条目；不得链接未包含/已删除的记录，此类情况写纯文本占位（如「来源未包含在本次导出」「来源已删除」）。
- 读取方（Obsidian/编辑器）可能对百分号编码做解码显示；只要解码后路径存在即可。

## 9. 前端流程

### 9.1 入口

主题详情操作区增加「导出 Markdown」按钮（与编辑/归档/删除同一操作区，危险度低于删除）。点击打开预览面板，不直接下载。

### 9.2 预览面板

面板至少显示：

- 主题标题与当前归档状态。
- 计数：念头 `thoughts`、经验 `experiences`、尝试 `attempts`、文件 `files`、预计大小 `estimatedBytes`（人类可读，如 `12.3 KB`）。
- 「包含归档记录」开关，默认开；切换后重新请求 preview。
- 可展开的文件清单：按 `files` 顺序显示路径、类型、归档/依据标记、revision；长列表内部滚动。
- 「可追加的一跳直接依据」复选列表：类型、标题、摘要、来源经验；`deleted=true` 置灰不可选并显示「来源已删除」。
- 「未包含的关联」：总数与 `byType` 分类（手动关联/尝试引用/经验依据/经验采用）。
- `limits.exceeded` 与 `warnings`：超限原因、预计大小提示。
- 主按钮「下载 ZIP」；`canExport=false` 时禁用并说明原因。
- 独立副本提示：「下载后是独立副本，之后在拾念中的修改或删除不会自动更新已下载文件。」

### 9.3 交互状态

1. 打开面板：以 `{ includeArchived: true, includeBasisKeys: [] }` 请求 preview；显示加载态；失败显示错误与重试。
2. 切换 `includeArchived`：以当前选择重新 preview；若返回 400（某些 key 不再有效），清除无效 key 后再 preview 一次，并提示「部分依据已不在范围内，已取消选择」。
3. 勾选/取消依据：更新本地选择并重新 preview；只有最新 preview 的 `scopeHash` 可用于导出。
4. 点击下载：`POST /api/topics/:id/export`，带当前选项与 `expectedScopeHash`；按钮进入「生成中…」并禁用，防重复点击。
5. 成功：从 `Content-Disposition` 解析文件名（解析失败用 `shinian-topic-<topicId>-<本地时间>.zip` 兜底）；用 `Blob` + `a[download]` 触发下载；显示成功与独立副本提示。
6. 409：显示「导出范围已变化，请重新预览后再试。」；自动重新 preview；保留仍有效的勾选；不自动下载旧快照。
7. 413：显示超限维度（文件数/尝试数/大小）与建议（取消勾选归档、减少依据、缩小主题）；保留面板。
8. 404：显示「主题已不存在。」；返回主题列表或关闭面板。
9. 400：显示服务端 `message`；若是 `includeBasisKeys`，清理选择并重新 preview。
10. 其他错误：显示通用「导出失败，请重试」；不泄露服务端堆栈。

### 9.4 移动端与可达性

- 390px 宽度可完成「打开面板 → 查看计数/文件 → 勾选依据 → 下载」全流程；无横向溢出。
- 面板使用可滚动容器；底部主按钮可达；触控目标不小于 44×44。
- 使用真正的按钮/复选框与 `label` 关联；Esc 关闭面板（导出中除外）；焦点在打开时进入面板、关闭后回到触发按钮。
- 下载中显示进度/忙碌状态；屏幕阅读器可读到成功/失败提示（`role="status"` / `role="alert"`）。
- 不调用模型、不访问外部网络、不写 Obsidian 目录；所有数据只来自本机接口。

## 10. 版本与兼容

- `manifest.json` 的 `formatVersion` 当前为 `1`。新增可选字段不递增；删除/重命名字段、改变 frontmatter 语义、改变路径规则等破坏性变更必须递增。
- 读取方应忽略未知字段；不得因未知字段拒绝整个 ZIP。
- 本导出是**单向**的：不提供导入、同步、增量更新、Obsidian 插件写入或双向链接回写。
- 现有 `GET /api/export`（JSON，`schemaVersion: 7`）与整库 SQLite 备份不受本功能影响；本功能不新增表、不新增迁移。
- 旧 ZIP 不会因应用升级而自动更新；用户需要重新导出。

## 11. 验收清单（不代表已运行）

以下为接口/格式验收项，实际结果以测试脚本输出为准，本文不预填数字：

1. 单实体单文件：一个主题只有一个念头时，ZIP 含索引/README/manifest + 一个 thought 文件。
2. 所有包内链接目标存在，且没有指向包外的链接。
3. 修改标题后重新导出，文件名/路径不变，正文与索引文字更新。
4. 默认不包含另一主题的记录；勾选一跳依据只追加该条记录本身。
5. 不递归：不出现依据记录的所属主题、其他尝试、它自己的引用或后续实践。
6. 删除/清理来源后，ZIP 不出现其标题/正文/结果快照，只出现「来源已删除」占位。
7. 当前结果与引用/采用历史快照分别标注，快照不被当成当前值。
8. 超过一页的尝试完整导出（不受 `limit` 分页影响）。
9. 特殊标题（换行、反引号、`[`/`]`、`..`、`C:\`、超长）不破坏路径、frontmatter 或 Markdown 结构。
10. 导出失败（400/409/413/404）不修改任何业务数据；重复预览/导出不产生回执。
11. 390px 手机宽度可完成预览与下载；无横向溢出。
12. 导出过程无模型调用、无外部网络请求。
13. 原有 JSON 导出 `schemaVersion: 7` 与整库 SQLite 备份/恢复回归通过。
14. `scopeHash` 在数据变化后变化，在相同快照下预览/导出一致；409 后重新预览可成功。

## 12. 错误码速查

| HTTP | `error` | 触发 | 附加字段 |
| --- | --- | --- | --- |
| 400 | `invalid_request` | 请求体非对象、`includeArchived` 非布尔、`includeBasisKeys` 非字符串数组/格式错误/去重后 >200、key 不在候选、`expectedScopeHash` 缺失或格式错误 | `field`, `message`；可选 `invalidKeys` |
| 401 | `unauthenticated` | 无会话 | — |
| 403 | `host rejected` / `origin rejected` | Host/Origin 校验失败 | — |
| 404 | `topic_not_found` | 主题不存在/预览后被删除 | `message` |
| 409 | `export_scope_changed` | 预览后范围/内容变化，或 `expectedScopeHash` 不匹配，或依据 key 已不可选 | `currentScopeHash`, `message` |
| 413 | `export_limit_exceeded` | 文件数/尝试数/最终 ZIP 字节数超限 | `details.limits`, `details.actual`, `details.exceeded`, `message` |
| 500 | `export_failed` | 未预期渲染/ZIP 失败 | `message`；不泄露内部细节 |

## 13. 修订记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-11-16 | v1 | 首版：预览/导出、scopeHash、限制、ZIP 结构、文件命名、frontmatter、前端流程与错误码。 |
