# 拾念 SHINIAN · 「研究一下」API 契约（v1）

日期：2026-11-14
所有路由要求本机登录 Cookie；错误响应统一为 `{ error, message?, detail?, ... }`，不包含密钥。

## 0. 公共对象

### ResearchPublic

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 研究 ID |
| `captureId` / `captureRevision` / `captureText` | string/number/string | 来源念头与创建时版本 |
| `question` | string | 研究问题 |
| `constraints` | `{goal,environment,language,timeBudget,requirements}` | 每项 string 或 null |
| `search` | `{mode,query,repos,display}` | `keyword` 或 `repositories` |
| `status` | enum | `searching/candidates/fetching/generating/succeeded/failed/cancelled/interrupted` |
| `revision` | number | 研究版本，采用时校验 |
| `savedAt` / `createdAt` / `updatedAt` / `finishedAt` | number/null | 毫秒时间戳 |
| `limits` | object | 候选/深入/输入/README/prompt/并发/GitHub/模型限制 |
| `candidates` | Candidate[] | 候选仓库 |
| `candidateFailures` | Failure[] | 候选阶段失败项 |
| `candidatesFetchedAt` / `candidatesTotal` / `candidatesRate` | number/null/object | 候选获取信息与 GitHub 额度 |
| `selectedCandidateIds` | string[] | 已选择深入仓库 |
| `sources` | Source[] | 已获取资料 |
| `result` | ResearchResult/null | 模型对比 |
| `config` | `{id,name,modelId,version}` | 发起时模型快照，未配置为 null |
| `usage` | `{inputTokens,outputTokens,totalTokens}`/null | 模型用量 |
| `durationMs` | number/null | 模型耗时 |
| `stats` | object/null | GitHub 请求、候选、资料、失败、prompt 字符 |
| `errorCode` / `errorMessage` / `errorDetail` | string/null | 可读错误 |
| `failed` | Failure[] | 资料失败项 |
| `attempts` | `{attemptId,experimentIndex,title,state,createdAt}[]` | 已采用尝试 |
| `sentSourceIds` | string[] | 实际发送给模型的来源 |
| `canCancel/canSave/canSelect/canRetrySearch/canRetryFetch/canRetryGenerate` | boolean | 当前可用操作 |
| `saved` | boolean | 是否已保存 |

### Candidate

`id, fullName, owner, name, description, htmlUrl, language, archived, fork, defaultBranch, stars, openIssues, pushedAt, updatedAt, createdAt, license{spdxId,name,url}, fetchedAt, via(search|direct), apiUrl`。

### Source

`sourceKey, repoFullName, repoId, kind(repo_meta|readme|license|releases), url, filePath, refName, commitSha, excerpt, fetchedAt, status(ok|missing|failed), errorCode, errorDetail`。

### ResearchResult

```json
{
  "summary": "string",
  "projects": [{
    "repo": "owner/repo",
    "summary": "string",
    "matches": [{"text": "string", "sourceIds": ["src-1"]}],
    "gaps": [{"text": "string", "sourceIds": ["src-2"]}],
    "unknowns": ["string"],
    "licenseNote": "string"
  }],
  "experiments": [{
    "title": "string",
    "description": "string",
    "estimatedMinutes": 1,
    "repo": "owner/repo",
    "sourceIds": ["src-2"],
    "verifies": "string"
  }],
  "insufficient": false,
  "limitations": ["string"]
}
```

服务端校验：`repo` 必须属于本次选中仓库；每个 `sourceIds` 必须属于本次实际发送且属于该仓库；`insufficient=false` 时 `projects` 不能为空。

## 1. GitHub 设置

### `GET /api/settings/github`
返回 `{ hasToken, apiBase, tokenUpdatedAt?, limits?, token? }`（不返回明文 Token）。`apiBase` 生产固定 `https://api.github.com`。

### `PUT /api/settings/github`
请求 `{ token: string }`；Token 使用 AES-256-GCM 加密，AAD `shinian:github-token:v1`，只发送给 GitHub API。返回同 GET。

### `DELETE /api/settings/github`
清除 Token。

### `POST /api/settings/github/test`
使用已保存 Token 调 `GET /user` 与 `GET /rate_limit`；返回 `login`、`rate` 或错误码。

## 2. 预览

### `POST /api/captures/:id/research/preview`

```json
{
  "captureRevision": 1,
  "question": "在 ESP32-S3 上实现离线唤醒词，有哪些开源项目？",
  "constraints": {"goal":"...","environment":"...","language":"...","timeBudget":"...","requirements":"..."},
  "search": {"mode":"keyword","query":"offline wake word","repos":[]}
}
```

指定仓库时：

```json
{"search":{"mode":"repositories","query":null,"repos":["owner/repo","https://github.com/owner/repo"]}}
```

返回 `capture, question, constraints, search, searchDisplay, limits, estimatedGithubRequests, maxDetailRequests, modelCalls, ai{configured,enabled,config}, github{hasToken,apiBase}, modelInput{question,constraints,note}, contextToken`。

错误：`400 invalid_question/invalid_search/invalid_request`、`404 capture_not_found`、`409 version_conflict`（带 `currentRevision/currentRawText`）。

## 3. 创建研究

### `POST /api/captures/:id/research`

```json
{
  "captureRevision": 1,
  "question": "...",
  "constraints": {},
  "search": {"mode":"keyword","query":"...","repos":[]},
  "contextToken": "64 位 hex",
  "operationId": "op-..."
}
```

- 首次 `202`，返回 `{research, replayed:false}`；同 `operationId` 回放 `200 replayed:true`，返回同一研究。
- `contextToken` 必须来自同一 `captureRevision/question/constraints/search/configVersion` 的预览。
- 创建时插入 `searching`，`setImmediate` 后台检索；错误：`400 invalid_request`、`409 research_running/too_many_research/version_conflict`、`409 ai_*`（生成阶段）。

### `GET /api/captures/:id/research`
返回该念头的 `{captureId,count,research:[{id,question,status,searchMode,searchQuery,savedAt,createdAt,revision,summary,attemptCount,errorCode}]}`。

### `GET /api/research?saved=1&limit=20&captureId=...`
返回 `{research:[{id,captureId,question,status,savedAt,createdAt,summary,attemptCount}]}`。

### `GET /api/research/:id`
返回 `{research: ResearchPublic, ai:{...}, github:{hasToken,apiBase}}`；不存在 `404 research_not_found`。

## 4. 操作

### `POST /api/research/:id/select`
`{ "candidateIds": ["owner/repo", ...] }`，1–3 个，只能选当前候选；进入 `fetching`，返回 `202 {research}`。错误 `409 not_selectable/no_selection`。

### `POST /api/research/:id/retry`
```json
{"action":"search"}
{"action":"fetch","repoIds":["owner/repo"]}
{"action":"generate"}
```
- `search`：从 `failed/candidates` 重试检索；
- `fetch`：只重试指定失败/缺失仓库，保留已取得资料；
- `generate`：仅 `failed` 时重试生成，由服务端进入 `generating`。
返回 `202 {research}`；错误 `409 not_retryable/ai_not_configured/ai_disabled`。

### `POST /api/research/:id/cancel`
立即置 `cancelled`，停止后续请求；迟到响应不能复活。返回 `{research}`；已结束 `409 not_cancellable`。

### `POST /api/research/:id/save`
`{}`；保存当前结果与来源快照，返回 `{savedAt, research}`；重复保存返回同一 `savedAt`；`409 not_savable`。

### `DELETE /api/research/:id`
删除研究任务与资料，保留已创建 Attempt。返回 `{ok:true}`；不存在 `404 research_not_found`。

### `POST /api/research/:id/experiments/:index/accept`
```json
{
  "title": "编辑后的实验标题",
  "description": "具体怎么做",
  "estimatedMinutes": 30,
  "expectedRevision": 5,
  "operationId": "op-..."
}
```
返回 `201 {attempt, research, replayed:false}`；同 `operationId` 回放返回同一 Attempt。唯一键 `(researchId, experimentIndex)`：同一建议被不同 `operationId` 重复采用也返回同一 Attempt。错误 `409 version_conflict/not_adoptable/experiment_not_found/sources_changed`。

### `GET /api/attempts/:id/research`
返回尝试的来源研究：`{research: ResearchPublic|null, deleted:boolean, suggested: object|null, sourceIds: string[], experimentIndex:number|null}`；研究已删除时 `deleted=true`，不返回已删正文。

## 5. 错误码

`rate_limited, timeout, not_found, auth, forbidden, unreachable, invalid_response, invalid_repo, cancelled, interrupted, no_candidates, all_repos_failed, ai_not_configured, ai_disabled, ai_failed, sources_changed, version_conflict, research_not_found, experiment_not_found, not_adoptable, too_many_research, research_running, not_selectable, not_retryable, no_selection, no_sources, not_savable`。

- `rate_limited` 带 `resetAt` 与 `detail`（GitHub 响应原因）。
- `timeout/not_found/auth/forbidden/unreachable/invalid_response` 保留已取得资料；可重试。
- `ai_failed` 时资料仍可查看，可重试生成；不保存非法模型原文。

## 6. 前置与副作用

- GitHub Token 只进入 `Authorization` 发往 GitHub API；不会进入模型 prompt 或导出。
- README 等外部内容作为不可信资料，不改变模型权限/调用范围/发送范围。
- 删除念头会级联删除研究；删除研究不会删除 Attempt。
- 服务启动时未完成研究标为 `interrupted`。
- 导出 `schemaVersion=4` 新增 `data.researchRuns`、`data.researchSources`；Attempt 新增 `sourceResearchId/sourceResearchExperimentIndex/researchSuggestedJson/researchSourceIdsJson`。
