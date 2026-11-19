# 拾念 SHINIAN · 本轮 AI 功能内部接口契约

日期：2026-11-12。此文件是本轮多 agent 并行实施的唯一接口契约。实现如确需偏离，先更新本文件并在交付说明中注明。

实施状态（2026-11-13）：设置/测试/直接生成已完成并通过假模型验收；参考旧经验的扩展接口见 [experience-api-contract.md](./experience-api-contract.md)，实施偏差与真实模型联调状态见 [ai-notes.md](./ai-notes.md)。

## 0. 范围与边界

- 只做一条 AI 辅助流程：设置 → AI 模型 → 测试连接 → 念头详情「帮我试一步」→ 确认发送 → 建议卡 → 编辑并采用 → 已有尝试详情 → 记录结果。
- 本机单人部署；不做远程托管、多用户、多配置。数据库里只有一条配置，固定 `id = 'default'`。
- 模型调用在数据库事务之外执行；采用建议时在事务内校验并创建 Attempt。
- 密钥只存在服务端加密字段；任何 API 响应、导出、日志、构建产物都不得包含明文密钥。
- 现有手动流程、搜索、引用、导出、备份恢复不得回归。

## 1. 新增文件与归属

| 文件 | 归属 | 说明 |
| --- | --- | --- |
| `src/server/aiSettings.ts` | server-ai | 主密钥、AES-256-GCM、URL 策略、设置读写、连接测试、错误分类 |
| `src/server/aiProvider.ts` | server-ai | AI SDK OpenAI Compatible 适配器、固定测试请求、生成请求、严格 JSON 校验 |
| `src/server/aiRoutes.ts` | server-ai | 设置/测试/生成/采用/取消/放下路由；`registerAiRoutes(fastify)`；`markInterruptedGenerations()` |
| `src/db/schema.ts`、`drizzle/migrations/0003_ai.sql` | server-ai | 新表 |
| `src/server/index.ts` | server-ai | 只做最小集成：注册路由、启动时中断恢复、删除预览/删除计数 |
| `src/client/**`、`src/client/styles.css` | client-ai | 设置页、AI 交互、界面打磨 |
| `scripts/fake_model_server.py`、`scripts/test_ai.py`、`scripts/ai_scenarios.json`、`scripts/run_tests.py` | test-ai | 假模型与自动化测试 |
| `README.md`、`docs/ai-notes.md`、`scripts/e2e_ai.mjs`、截图 | lead | 交付、E2E、文档 |

`package.json` 已由 lead 锁定：`ai@7.0.170`、`@ai-sdk/openai-compatible@3.0.90`（均为精确版本，无 `^`）。

## 2. 数据库

### 2.1 `ai_settings`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | 固定 `default` |
| `name` | text not null | 配置名称，1–40 字符 |
| `base_url` | text not null | 规范化后的 Base URL |
| `model_id` | text not null | 1–120 字符 |
| `api_key_ciphertext` | text not null | `v1.<ivB64>.<tagB64>.<cipherB64>`，AES-256-GCM |
| `api_key_fingerprint` | text not null | SHA-256（明文 key）前 16 hex，仅用于测试过期判断与排查，不返回前端 |
| `enabled` | integer not null default 1 | 0/1 |
| `allow_local` | integer not null default 0 | 是否允许本机/内网地址 |
| `config_version` | integer not null default 1 | 每次实际变更 +1；生成记录保存它 |
| `created_at` / `updated_at` | integer not null | ms |
| `test_status` | text | `success` / `failure` / null |
| `tested_at` | integer | ms |
| `test_model_id` | text | 测试时模型 |
| `test_base_url` | text | 测试时规范化地址 |
| `test_duration_ms` | integer | 实际耗时 |
| `test_error_code` | text | 失败分类 |
| `test_error_detail` | text | 已脱敏，≤500 字符 |
| `test_fingerprint` | text | 测试时的设置指纹；与当前指纹不一致即 `stale` |

测试指纹 = SHA-256(`baseUrl + "\n" + modelId + "\n" + apiKeyFingerprint + "\n" + allowLocal`)。地址、模型或密钥变化后旧测试结果自动 `stale: true`。保存新设置时不必清空旧测试字段，但 `stale` 必须由当前指纹实时计算。

### 2.2 `ai_generations`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | `gen-...` |
| `capture_id` | text not null FK captures ON DELETE CASCADE | |
| `capture_revision` | integer not null | 输入版本 |
| `capture_text` | text not null | 发送时的念头原文快照 |
| `constraint_text` | text | 可选补充限制，≤200 |
| `config_id` | text not null | `default` |
| `config_version` | integer not null | 稳定配置版本 |
| `config_name` | text not null | 快照 |
| `base_url` | text not null | 快照（不是密钥） |
| `model_id` | text not null | 快照 |
| `status` | text not null | `pending` / `succeeded` / `failed` / `cancelled` / `interrupted` |
| `kind` | text | `executable` / `defer` / `clarify`，仅成功 |
| `suggestion_json` | text | 校验后的合法建议 JSON，仅成功 |
| `error_code` | text | 见 §6 |
| `error_detail` | text | 已脱敏，≤500 |
| `usage_json` | text | `{"inputTokens":n,"outputTokens":n,"totalTokens":n}`，可为 null |
| `duration_ms` | integer | 实际耗时 |
| `adopted_attempt_id` | text FK attempts ON DELETE SET NULL | |
| `adopted_at` | integer | |
| `dismissed_at` | integer | 「暂时放下」 |
| `operation_id` | text unique | 创建请求幂等键 |
| `operation_fingerprint` | text | 幂等请求指纹 |
| `created_at` / `updated_at` | integer not null | ms |
| `finished_at` | integer | |

索引：`(capture_id, created_at desc)`、`(status)`。

服务启动时执行：所有 `status='pending'` → `status='interrupted'`、`error_code='interrupted'`、`error_detail='服务重启，本次生成已中断，可重新生成。'`、`finished_at=now`、`updated_at=now`。

## 3. 主密钥与加密

- 默认路径：项目 `db/master.key`；可用 `SHINIAN_MASTER_KEY_FILE` 覆盖。
- 首次需要加密时自动生成 32 字节随机值，以 64 位小写 hex 写入；POSIX 下 `chmod 600`。Windows 依赖 NTFS ACL，文档提示限制访问。
- 算法：AES-256-GCM，12 字节随机 IV，16 字节 auth tag，AAD 固定 `shinian:ai-settings:v1`。
- 数据库里只存密文。丢失主密钥后无法解密已保存 API Key，只能重新填写；恢复数据库时必须同时保留 `master.key`。
- 生成记录、日志、错误详情不得包含明文密钥。错误详情统一经 `redactSecrets()`：移除明文 key、`Authorization`、`Bearer ...`，截断 500 字符。
- 任何接口都不返回 `api_key_ciphertext`、`api_key_fingerprint`、明文 key；只返回 `hasApiKey: boolean`。

## 4. URL 策略（保存、测试、真实请求共用）

实现放在 `aiSettings.ts`，所有调用点必须复用，不得各写一套。

1. 只支持 `http:` / `https:`；其他协议 400。
2. 禁止 URL 内嵌用户名/密码、query、fragment。
3. `localhost` / `*.localhost` / `127.0.0.0/8` / `::1` / `10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` / `169.254.0.0/16` / `0.0.0.0` / `*.local` 视为本机/内网地址。`allowLocal=false` 时拒绝；用户必须在设置页明确勾选「允许本机/内网地址」。
4. 规范化：
   - trim；
   - 去掉末尾所有 `/`；
   - 若路径以 `/chat/completions` 结尾，先去掉它；
   - 若路径不是以 `/v1` 结尾，追加 `/v1`；
   - 路径中的重复斜杠折叠；
   - 返回 `origin + pathname`。
   - 例：`https://api.openai.com/` → `https://api.openai.com/v1`；`https://api.deepseek.com/v1/` → `https://api.deepseek.com/v1`；`http://127.0.0.1:11434/v1` → 原样。
5. 实际请求使用自定义 `fetch`：`redirect: 'manual'`；任何 3xx 直接失败 `redirect_blocked`，凭据不会被转发到重定向目标。对公网域名在请求前做 DNS 解析，若解析到私网地址且 `allowLocal=false`，拒绝（防 DNS rebinding）；解析失败归类 `unreachable`。
6. 支持的 URL 示例写入设置页提示：`https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`http://127.0.0.1:11434/v1`（需勾选允许本机）。

## 5. HTTP API

所有接口要求现有 `shinian_sid` 会话；未登录 401。错误统一 `{error: string, message?: string, ...}`，`message` 为中文可读文案。

### 5.1 `GET /api/settings/ai`

```json
{
  "configured": true,
  "config": {
    "id": "default",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "modelId": "deepseek-chat",
    "enabled": true,
    "allowLocal": false,
    "hasApiKey": true,
    "configVersion": 3,
    "createdAt": 1760000000000,
    "updatedAt": 1760000000000,
    "test": {
      "status": "success",
      "testedAt": 1760000000000,
      "modelId": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1",
      "durationMs": 812,
      "errorCode": null,
      "errorDetail": null,
      "stale": false
    }
  },
  "masterKey": { "path": "D:\\联动日程表\\db\\master.key", "exists": true },
  "limits": { "maxCaptureChars": 4000, "maxConstraintChars": 200, "timeoutMs": 60000 }
}
```

未配置时 `configured:false, config:null`，仍返回 `masterKey` 与 `limits`。`test` 从未测试时为 `null`。

### 5.2 `PUT /api/settings/ai`

请求：`{ name, baseUrl, modelId, apiKey?, enabled?, allowLocal? }`

- 首次保存 `apiKey` 必填；已有配置时 `apiKey` 省略/空字符串表示保留原密钥。
- 保存即规范化 URL；`enabled` 默认 true，`allowLocal` 默认 false。
- 字段错误 400：`{error:'invalid_settings', field:'baseUrl', message:'…'}`。
- 返回同 `GET`。
- 实际有变化才 `config_version + 1`。

### 5.3 `DELETE /api/settings/ai`

清除整条配置（含密钥）。返回 `{ok:true}`。生成历史保留（`ai_generations` 不删除）。

### 5.4 `POST /api/settings/ai/test`

- 无 body 或 `{}`。
- 使用已保存配置；未配置 409 `ai_not_configured`；`enabled=false` 409 `ai_disabled`；无密钥 409 `ai_not_configured`。
- 同一时间只允许一个测试；重复 409 `test_in_progress`。
- 固定请求：system `你是连接测试助手。`，user `请只回复：连接正常`，`maxOutputTokens: 16`，`temperature: 0`，`maxRetries: 0`，超时默认 20s（`SHINIAN_AI_TEST_TIMEOUT_MS` 可覆盖）。
- 不读取任何用户念头、不写生成记录。
- 只有收到 HTTP 成功且 assistant 文本非空，才记为 success。
- 响应 HTTP 200：
```json
{
  "test": { "status": "success", "testedAt": 1760000000000, "modelId": "deepseek-chat",
            "baseUrl": "https://api.deepseek.com/v1", "durationMs": 812,
            "errorCode": null, "errorDetail": null, "stale": false },
  "config": { "...": "同 GET config" }
}
```
失败同样 200，`test.status='failure'`，`errorCode` 见 §6。测试结果写入 `ai_settings`，前端刷新可见。

### 5.5 `POST /api/captures/:id/suggestions`

请求：`{ captureRevision: number, constraint?: string, operationId: string }`

- `captureRevision` 必填；与当前 `captures.revision` 不一致 → 409 `{error:'version_conflict', currentRevision, currentRawText}`。
- 未配置 → 409 `ai_not_configured`；停用 → 409 `ai_disabled`。
- 原文 > 4000 字符 → 400 `capture_too_long`；限制 > 200 字符 → 400 `constraint_too_long`。
- 同一念头已有 pending → 409 `{error:'generation_in_progress', generationId}`。
- 全局 pending ≥ 2 → 429 `{error:'too_many_generations'}`。
- `operationId` 幂等：同 ID 同指纹返回已有记录（`replayed:true`）；同 ID 不同请求 → 409 `operation_key_conflict`。
- **立即返回 202**：`{ "generation": {…}, "replayed": false }`。模型调用在后台进行，前端每 1s 轮询。
- 生成超时默认 60s（`SHINIAN_AI_TIMEOUT_MS` 可覆盖），`maxRetries: 0`。

Generation 公开对象：

```json
{
  "id": "gen-…",
  "captureId": "cap-…",
  "captureRevision": 1,
  "inputText": "念头原文快照",
  "constraint": null,
  "configId": "default",
  "configVersion": 3,
  "configName": "DeepSeek",
  "modelId": "deepseek-chat",
  "status": "succeeded",
  "kind": "executable",
  "suggestion": {
    "kind": "executable",
    "step": "把 PWM 频率从 500 Hz 改到 2 kHz，观察同一颗 LED 是否还闪。",
    "why": "只改一个参数，能直接验证你记下的闪烁条件。",
    "estimatedMinutes": 5,
    "question": null
  },
  "errorCode": null,
  "errorMessage": null,
  "usage": { "inputTokens": 120, "outputTokens": 80, "totalTokens": 200 },
  "durationMs": 2100,
  "adoptedAttemptId": null,
  "adoptedAt": null,
  "dismissedAt": null,
  "isExpired": false,
  "createdAt": 1760000000000,
  "finishedAt": 1760000002100
}
```

`isExpired`：`status==='succeeded'` 且当前 capture 不存在或 `capture.revision !== captureRevision`。

### 5.6 `GET /api/generations/:id`

返回 `{generation}`。用于刷新后恢复状态和轮询。

### 5.7 `GET /api/captures/:id/suggestions/latest`

返回 `{generation: object|null}`。取最近一条 `dismissed_at IS NULL` 的记录。用于刷新页面恢复。

### 5.8 `POST /api/generations/:id/cancel`

仅 `pending` 可取消：立即置为 `cancelled`、`error_code='cancelled'`、`error_message='已取消本次生成。'`，并 abort 后台请求。迟到的模型响应不得把状态改回 `succeeded`。返回 `{generation}`；非 pending → 409 `not_pending`。

### 5.9 `POST /api/generations/:id/dismiss`

「暂时放下」：设置 `dismissed_at`。返回 `{generation}`。pending 必须先取消，否则 409 `not_pending`。

### 5.10 `POST /api/generations/:id/accept`

请求：`{ step: string, operationId: string }`

- 仅 `status==='succeeded' && kind==='executable'`；否则 409 `not_adoptable`。
- `step` = 用户编辑后的最终文本，trim 后 1–500 字符。
- 再次校验 `capture_revision`；不一致 → 409 `{error:'suggestion_expired', currentRevision, currentRawText}`。
- 已 `adopted_attempt_id`：直接返回 `{attempt, generation, replayed:true}`（同一建议永远同一个 Attempt，即使 operationId 不同）。
- `operationId` 幂等；同 ID 不同指纹 → 409 `operation_key_conflict`。
- 事务内：复核状态/版本 → 用现有 Attempt 创建逻辑插入 `attempts`（state `todo`）→ 更新 generation 的 adopted 字段 → 写 `mutation_receipts`（target_type `ai_accept`）。返回 `{attempt, generation}`。

### 5.11 删除念头

- `GET /api/captures/:id/delete-preview` 增加 `generationCount`。
- `DELETE /api/captures/:id` 增加 `deletedGenerations`，事务内删除 `ai_generations`（外键 cascade 也可，但显式计数）。
- 相关尝试被删除时 generation 的 `adopted_attempt_id` 置 NULL，随后 generation 随念头删除。

## 6. 错误分类

`errorCode` 与设置页/生成卡中文文案：

| code | 文案 | 触发 |
| --- | --- | --- |
| `unreachable` | 地址不可达 | DNS、ECONNREFUSED、连接失败、5xx |
| `auth` | 认证失败 | 401 / 403 |
| `model_unavailable` | 模型不可用 | 404、模型不存在、400 中明确 model 相关 |
| `timeout` | 请求超时 | Abort/超时 |
| `invalid_response` | 响应格式不支持 | 非 JSON、缺 choices、空文本、建议 JSON 校验失败 |
| `rate_limited` | 请求过于频繁 | 429 |
| `redirect_blocked` | 地址重定向被拒绝 | 3xx |
| `invalid_url` | 地址格式不支持 | 保存/请求前校验 |
| `local_not_allowed` | 本机地址未获允许 | 私网地址且 allowLocal=false |
| `cancelled` | 已取消 | 用户取消 |
| `interrupted` | 服务重启中断 | 启动恢复 |
| `ai_not_configured` / `ai_disabled` | 未配置 / 已停用 | 调用前检查 |
| `generation_in_progress` | 正在生成 | 同念头并发 |
| `too_many_generations` | 生成任务过多 | 全局并发 |
| `suggestion_expired` | 建议已过期 | 原文版本变化 |
| `not_adoptable` | 该建议不能直接采用 | defer/clarify/非成功 |

服务端不得把上游响应全文塞进 `error_detail`；只保留脱敏后的简短原因（≤500 字符）。UI 展示 `errorMessage`（已脱敏），不展示上游堆栈。

## 7. 模型输出 Schema

所有模型输出必须能解析为以下 JSON（允许 ```json 围栏，解析时剥离），并经过 Zod 严格校验：

```ts
const suggestionSchema = z.object({
  kind: z.enum(['executable', 'defer', 'clarify']),
  step: z.string().trim().max(200).nullable(),
  why: z.string().trim().min(1).max(300),
  estimatedMinutes: z.number().int().min(1).max(120).nullable(),
  question: z.string().trim().min(1).max(200).nullable(),
});
```

语义校验：

- `executable`：`step` 非空；`estimatedMinutes` 可为 null；`question` 必须为 null。
- `defer`：`step` 必须为 null；`question` 必须为 null；`why` 说明尊重暂缓。
- `clarify`：`step` 必须为 null；`question` 非空；`estimatedMinutes` 必须为 null。
- 其他组合 → `invalid_response`。

System prompt 要点（可微调，但必须包含）：只输出 JSON；围绕当前意愿给一个具体、低负担、能开始的小尝试；用户表达忙碌/犹豫/暂时搁置时返回 `defer`；信息不足时返回 `clarify` 且只问一个关键问题；不编造经历、成果、截止日期或已掌握的能力；不调用工具；简短。User prompt 只包含念头原文与补充限制。

## 8. 前端页面与文案

### 8.1 导航与设置页

- 顶部导航新增「设置」→ `/settings/ai`；页面标题「AI 模型」。手机宽度下可换行。
- 状态徽标：`未配置` / `已停用` / `待测试` / `连接成功` / `连接失败` / `测试已过期`（成功或失败后改动地址/模型/密钥）。
- 表单字段：配置名称、Base URL、Model ID、API Key（password）、启用状态、允许本机/内网地址。
- Base URL 下方提示：「填写 OpenAI 兼容服务根地址，例如 https://api.openai.com/v1。末尾斜杠会自动处理；未写 /v1 时会自动补上。」
- API Key：未配置显示 password 输入；已配置显示「已配置」+「替换密钥」按钮；替换时出现 password 输入，留空保存则保留原密钥。独立「清除配置…」危险入口 + 确认弹层。
- 测试按钮前固定提示：「将发送一次固定短请求，可能产生少量模型费用。」
- 保存后若设置变更，旧测试结果显示「已过期」；测试按钮在存在未保存修改时提示先保存。
- 成功显示：实际模型、测试时间、耗时。失败显示：分类文案 + 脱敏详情。
- 主密钥说明：「API Key 使用 AES-256-GCM 加密后保存在本机数据库；主密钥位于 db/master.key，不存于数据库。备份或迁移时需同时保留该文件；丢失后只能重新填写 API Key。」

### 8.2 念头详情两种开始方式

- 在「开始一步」区域并列展示两张入口卡：「自己写一步」与「帮我试一步（AI）」。
- 自己写一步：展开/聚焦现有手动表单，原有创建尝试逻辑不变。
- 帮我试一步：未配置时显示引导「先配置 AI 模型」+ 去设置按钮。
- 已配置时展开确认区，显示：
  - 目标配置与模型（配置名 · modelId）
  - 将发送：念头原文（只读块）
  - 补充限制（选填，≤200，占位「例如：只有十分钟 / 暂时没有器材」）
  - 说明「只发送当前念头和这句限制，不会发送历史记录。」
  - 按钮「确认并生成」「取消」
- 生成中：状态卡「正在生成建议…」+「取消等待」；禁止重复点击；轮询。
- 刷新：调用 `latest` 恢复 pending / succeeded / failed / cancelled / interrupted。
- 建议卡：
  - executabe：标题「可以试这一步」，正文 step，理由 why，`预计投入：约 N 分钟（估计）`；主按钮「编辑并采用」，次按钮「重新生成」「暂时放下」。
  - 编辑并采用：展开 textarea（预填 step），按钮「采用并创建尝试」；成功后 `navigate('/attempt/:id?from=ai')`。
  - defer：标题「先记着」，展示 why；不显示采用；按钮「重新生成」「暂时放下」。
  - clarify：标题「还差一点信息」，展示 question；提供输入框「补充这一点」+「补充并重新生成」；按钮「暂时放下」。
- 失败：显示分类文案与脱敏详情；保留原文与补充限制；按钮「手动重试」「继续自己写一步」。重试前提示「前一次请求可能已经产生费用」。
- 过期：显示「念头已修改，这条建议已过期」+「按新原文重新生成」；采用按钮禁用。
- 「暂时放下」调用 dismiss，卡片收起；刷新后不再出现。

### 8.3 尝试详情

- 顶部增加「记录实际结果」入口（锚点到结果表单）；从 AI 采用跳转时显示提示「已采用 AI 建议，记得记录实际结果」。
- 结果表单保持现有字段与保存逻辑；聚焦到结果区。

### 8.4 界面打磨

- 统一字体层级（页面标题 24/20、区块标题 16、正文 15/16、辅助 13）；间距 8 的倍数；按钮最小高度 40；输入框统一 10–12px padding、圆角 8；分隔线一致；所有交互有 hover / focus-visible / disabled / loading 状态。
- 桌面与 390px 手机宽度均可操作；主要操作靠近对应内容；不自造营销文案。
- 支持键盘：所有按钮可 Tab 到；弹层内焦点可见；生成中禁用重复提交。

## 9. 测试环境约定

- 测试服务：`SHINIAN_BASE=http://127.0.0.1:3100`，独立库 `db/test.sqlite`，独立主密钥 `db/test-master.key`（`SHINIAN_MASTER_KEY_FILE`）。
- 假模型服务：Python 标准库 `http.server`，监听 `127.0.0.1:3501`，实现 `POST /v1/chat/completions`，按 `model` 字段返回不同场景；记录最后请求供断言。
- 假模型模型名：
  - `fake-success` → executable
  - `fake-defer` → defer
  - `fake-clarify` → clarify
  - `fake-invalid-json` → 200 但内容不是合法 JSON
  - `fake-invalid-shape` → 合法 JSON 但语义不合法
  - `fake-auth` → 401 `{"error":{"message":"invalid api key"}}`
  - `fake-timeout` → 延迟 5s 后返回（配合 `SHINIAN_AI_TEST_TIMEOUT_MS=800` / `SHINIAN_AI_TIMEOUT_MS=1200`）
  - `fake-model-missing` → 404 `{"error":{"message":"model not found"}}`
  - `fake-redirect` → 302 到 `http://127.0.0.1:3502/v1/chat/completions`（测试不得跟随）
  - `fake-scenario` → 读取 `scripts/ai_scenarios.json`，按 user 消息中的原文匹配返回 `expectedKind`
- 配置 `allowLocal=true`、`baseUrl=http://127.0.0.1:3501/v1`、`apiKey=test-secret-key`。
- 至少覆盖：未配置手动闭环、保存/替换/清除密钥、测试过期、测试成功/认证失败/超时/格式不支持、三类建议、无效输出、过期采用、重复点击/重复采用/取消迟到响应、刷新与重启状态、删除关联、密钥不出现在响应/导出/日志/构建产物、20 条场景样例。
