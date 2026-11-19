# 拾念 SHINIAN · AI「帮我试一步」实施与验证记录

日期：2026-11-13
范围：设置 → AI 模型、连接测试、念头详情 AI 建议、编辑采用、取消/刷新/中断恢复、与现有 Attempt/搜索/引用流程集成；本轮参考旧经验扩展见 [experience-notes.md](./experience-notes.md)。
状态：**工程验收通过（假模型）**；真实厂商模型联调待完成（本机无可用真实 API Key）。

## 1. 交付行为

| 能力 | 实现 |
| --- | --- |
| 设置入口 | 顶部导航「设置」→ `/settings/ai`；单配置 `default` |
| 字段 | 配置名称、OpenAI 兼容 Base URL、Model ID、API Key、启用、允许本机/内网地址 |
| 操作 | 保存、测试连接、替换密钥、清除配置；独立确认弹层 |
| 状态 | 未配置 / 已停用 / 待测试 / 连接成功 / 连接失败 / 测试已过期 |
| URL 处理 | 仅 http/https；拒绝内嵌凭据/query/fragment/重定向；末尾斜杠与 `/v1` 自动规范化；本机地址需显式允许 |
| 连接测试 | 固定 system/user 短请求，不读用户念头；成功显示模型/时间/耗时；失败分类；不自动重试 |
| 生成前确认 | 显示配置名 + modelId、当前念头原文、可选限制（≤200 字）；确认后才发送 |
| 生成状态 | 立即 202 + 后台调用；前端 1s 轮询；刷新 `latest` 恢复；可取消；服务重启后 pending → interrupted |
| 建议类型 | executable（可编辑采用）、defer（先记着）、clarify（一个关键问题 + 补充后重生成） |
| 采用 | 事务内复核 status/kind/capture revision；创建现有 Attempt；重复采用同一 Attempt；原文变化 → 过期禁止采用 |
| 手动流程 | 自己写一步、记录结果、搜索、引用、导出、归档、删除、备份恢复均保留 |

## 2. 代码位置

- `src/server/aiSettings.ts`：主密钥、AES-256-GCM、设置读写、`config_version`、测试指纹/stale、URL 校验/规范化、DNS 私网检查、guarded fetch、错误分类与脱敏。
- `src/server/aiProvider.ts`：`createOpenAICompatible` + `generateText`；固定测试请求；建议生成；JSON 提取、Zod 与 kind 语义校验；usage 映射。
- `src/server/aiRoutes.ts`：设置、测试、生成、轮询、latest、取消、放下、采用路由；后台任务与 AbortController；启动中断恢复；删除计数。
- `src/server/index.ts`：注册 AI 路由、日志脱敏、启动中断恢复、删除预览/删除关联计数。
- `src/db/schema.ts`、`drizzle/migrations/0003_ai.sql`：`ai_settings`、`ai_generations`。
- `src/client/pages/SettingsAiPage.tsx`、`CaptureDetailPage.tsx`、`AttemptDetailPage.tsx`、`HomePage.tsx`、`api.ts`、`types.ts`、`styles.css`。
- `scripts/fake_model_server.py`、`scripts/ai_scenarios.json`、`scripts/test_ai.py`、`scripts/run_tests.py`、`scripts/e2e_ai.mjs`。

## 3. 数据与事务

`ai_generations` 保存：念头 ID、输入 `capture_revision`、原文与限制快照、配置 ID/`config_version`/名称、模型、状态、合法建议 JSON、采用 Attempt ID、实际用量、耗时、脱敏错误、创建/结束/采用/放下时间。

- 模型调用发生在数据库事务之外；创建生成记录与采用建议在事务内。
- 状态更新使用 `WHERE status = 'pending'` 条件更新，取消后的迟到响应不能恢复为可采用状态。
- 采用使用 `mutation_receipts`（`target_type='ai_accept'`）与 `adopted_attempt_id` 双重幂等；同一建议重复采用返回同一个 Attempt。
- 删除念头时事务内删除 `ai_generations`；`attempts` 外键 `ON DELETE SET NULL` 处理 adopted 引用。
- 启动时 `markInterruptedGenerations()` 将所有 pending 改为 interrupted，并写入明确的错误文案。

## 4. 主密钥与密钥安全

- 默认路径 `db/master.key`；环境变量 `SHINIAN_MASTER_KEY_FILE` 可覆盖。
- 首次加密时生成 32 字节随机密钥，写为 64 位 hex；POSIX 下 `chmod 600`。Windows 依赖 NTFS ACL。
- AES-256-GCM，AAD `shinian:ai-settings:v1`，密文 `v1.<ivB64>.<tagB64>.<cipherB64>`。
- 数据库只存密文与密钥指纹；接口只返回 `hasApiKey`，不返回密文/指纹/明文。
- 测试指纹 = SHA-256(baseUrl + modelId + keyFingerprint + allowLocal)，地址、模型或密钥改动后旧测试结果自动 `stale`。
- 普通日志不记录请求体、提示词、念头正文或密钥；Fastify logger 对 `authorization`、`cookie`、`set-cookie` 脱敏。
- 已验证：接口响应、JSON 导出、`db/test-server.log`、E2E 日志、`dist/client` 均不含测试密钥；浏览器 localStorage/sessionStorage 不含密钥。
- 恢复要求：数据库备份必须与对应 `master.key` 一起保存；丢失主密钥后已存 API Key 无法解密，只能清除配置后重新填写。

## 5. URL 与出站安全

- 只接受 `http:` / `https:`；拒绝 URL 内嵌用户名/密码、query、fragment。
- 规范化：去除末尾斜杠、重复斜杠与 `/chat/completions`，路径不以 `/v1` 结尾时补 `/v1`。
- 默认拒绝 localhost、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、链路本地、`*.local` 等；用户必须在设置页显式勾选「允许本机/内网地址」。
- 请求使用自定义 fetch：`redirect: 'manual'`，任何 3xx 直接失败 `redirect_blocked`；公网域名在请求前做 DNS 解析，解析到私网且未允许时拒绝。
- 未启用工具调用；模型只接收当前念头和用户明确填写的限制。

## 6. 测试记录（本机实际运行）

命令：

```powershell
cd <repo>
npm run typecheck
npm run build
$env:PYTHONIOENCODING='utf-8'; python scripts/run_tests.py
python scripts/test_export.py
python scripts/test_backup_restore.py
$env:SHINIAN_BASE='http://127.0.0.1:3200'; node scripts/e2e_ai.mjs
$env:SHINIAN_BASE='http://127.0.0.1:3200'; node scripts/e2e_browser.mjs
```

结果：

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（仅既有 chunk 体积警告） |
| `test_api.py` | 43 passed, 0 failed |
| `test_search.py` | 31 passed, 0 failed |
| `test_consistency.py` | 23 passed, 0 failed |
| `test_ai.py` | 138 passed, 0 failed |
| `test_experience.py` | 114 passed, 0 failed |
| `test_activity.py` | 27 passed, 0 failed |
| 本轮相关套件合计 | 376 passed, 0 failed |
| 重启持久化 | 83 条念头、引用、pending→interrupted 均通过 |
| `test_export.py`（当前 schemaVersion 2） | 80 passed, 0 failed |
| `test_backup_restore.py`（全库迁移兼容） | 150 passed, 0 failed |
| `e2e_ai.mjs`（含参考旧经验/动态页） | 45 passed, 0 failed |
| `e2e_browser.mjs` | 21 passed, 0 failed |

`test_ai.py` 覆盖：

- 未配置模型时的手动闭环；
- 配置保存/替换密钥/清除、主密钥文件、密文非明文、测试过期；
- Base URL 末尾斜杠/缺 `/v1`/重复斜杠、非法协议、带凭据、本机地址开关、重定向拒绝；
- 连接成功、认证失败、超时、模型不可用、格式不支持；
- executable/defer/clarify、无效 JSON、无效结构、认证失败、超时；
- 采用、编辑后采用、重复采用同一 Attempt、过期采用、defer/clarify 不可采用；
- 同念头并发 409、同 operationId 幂等、取消后迟到响应不复活；
- latest 刷新、dismiss、删除念头关联计数、重启中断恢复；
- 接口/导出/日志密钥泄露扫描；
- 24 条场景样例逐条验证 kind。

`e2e_ai.mjs` 实际浏览器路径：配置模型 → 连接成功 → 保存念头 → 确认发送 → 建议卡 → 编辑采用 → 记录结果 → 保存第二条念头 → 手动创建尝试 → 搜索并引用旧结果 → 手机宽度复查。

## 7. 场景样例

`scripts/ai_scenarios.json` 共 24 条，技术项目 / 摄影 / 阅读 / 生活兴趣各 6 条；每类包含 2 条 executable、2 条 defer（时间不足、暂时不想行动）和 2 条 clarify（信息不够）。样例用于 `fake-scenario` 假模型按念头原文返回确定类型，从而验证三类界面状态与 Schema 校验。

## 8. 支持与验证范围

- **已验证接口**：OpenAI 兼容 Chat Completions，非流式 `POST {normalizedBaseURL}/chat/completions`；请求字段 `model`、`messages`、`max_tokens`、`temperature`；响应 `choices[0].message.content` 与可选 `usage`；建议内容为 JSON 文本，服务端严格校验。
- **已验证对象**：仅本机假模型 `scripts/fake_model_server.py`。
- **未验证对象**：OpenAI、DeepSeek、Ollama、LM Studio、任何第三方中转或代理。本机无真实 API Key，真实模型联调待完成；设置页提供的厂商地址仅为格式示例，不构成兼容声明。
- 真实联调建议：先在设置页保存真实地址/模型/Key → 测试连接 → 用一条真实念头生成 → 检查建议质量、耗时、错误分类；记录厂商、模型、Base URL 与日期。

## 9. 已知限制

- 单配置、单用户、本机访问；无每日预算/调用配额，只有长度、超时与全局 2 个并发限制。
- 无流式输出、工具调用、MCP、多模型中心。
- JSON 导出保持原有三张业务表，不包含 `ai_settings`/`ai_generations`。
- 未在 Firefox/Safari/真实手机验证；仅 Chrome 无头 1280×900 与 390×844。
- 构建保留既有 react-router "use client" 与 chunk >500 kB 警告。
