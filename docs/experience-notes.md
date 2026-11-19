# 拾念 SHINIAN · 「参考旧经验，再试一步」实施与验证记录

日期：2026-11-13
范围：念头详情的历史经验检索、1–3 条来源选择、服务端预览、带来源的 AI 建议、来源 Schema 校验、采用时的 AttemptReference、上下文快照、来源删除清洗、界面与测试。

## 1. 用户流程

1. 打开一条念头，在「开始一步」中点击「参考旧经验」。
2. 服务端用当前念头提取建议查询词；用户可修改关键词，检索有实际观察文本的历史尝试。失败/未判定结果同样可选；结果评价不参与排序。
3. 选择 1–3 条，查看已选数量并随时移除；超过 3 条时前端禁止继续选择，服务端再次校验。
4. 点击「结合这些经验，帮我试一步」后，服务端根据来源 ID 重新读取真实内容，返回预览：目标配置/模型、当前念头、补充限制、每条来源的标题/观察/评价/时间/来源。
5. 确认后发送 `sourceAttemptIds + contextToken`；服务端重算上下文指纹，发现预览后变化则返回 `context_changed`，要求刷新并重新确认。
6. 生成建议卡展示「参考的旧经验」：用户记录（观察、评价、时间）与模型说明分层；模型返回实际引用的来源 ID。
7. 编辑并采用后，在同一事务中创建新 Attempt，并为模型实际引用的来源创建 `attempt_references`；引用保存生成时的结果快照。
8. 新尝试的引用区可打开来源；旧尝试显示反向引用。原「帮我试一步」与手动创建路径保留。

## 2. 服务端实现

- `src/server/aiExperience.ts`
  - 候选检索：LIKE 关键词 OR，匹配尝试标题、结果、所属念头；只返回结果文本非空的尝试；结果命中 > 标题 > 所属念头，明确 `attempt_references` 关系加权，同权重按时间较新优先；返回 `matchReasons`、`suggestedQuery`，不返回相似度百分比。
  - 来源读取、`contextToken`、`context_json` 快照、公开来源详情、来源版本变化检测。
  - 删除来源时清洗 `context_json`：保留 `{attemptId, deleted:true}`，移除正文，置 `context_invalidated_at/reason`；`publicExperienceOf` 对缺失来源不返回快照正文。
- `src/server/aiProvider.ts`
  - `suggestionSchema` 增加 `sources[{attemptId, note}]`。
  - 提示词只包含当前念头、限制和选中来源；来源以稳定 `[attemptId]` 标注。
  - 语义校验：未知/重复/越界来源 → `invalid_response`；有来源时 executable 至少引用 1 条；无来源必须 `sources:[]`；defer/clarify 可 0..n。
- `src/server/aiRoutes.ts`
  - `GET /api/captures/:id/experience-candidates?q=&limit=`
  - `POST /api/captures/:id/experience/preview`
  - `POST /api/captures/:id/suggestions` 支持 `sourceAttemptIds/contextToken`，保存上下文快照。
  - `GET /api/generations/:id` / latest 返回 `sources/sourcesChanged/contextInvalidated/contextInvalidReason`。
  - accept 在事务内复核来源 attempt/capture revision，创建 Attempt 和批量 `attempt_references`；失败整批回滚；重复采用同一 Attempt 且不重复引用。
- `src/server/index.ts`：删除 attempt/capture 时调用来源清洗 helper。
- `src/db/schema.ts`、`drizzle/migrations/0004_experience.sql`：`context_json/context_token/context_invalidated_at/context_invalid_reason`，旧记录可为 null。

## 3. 前端实现

- `CaptureDetailPage.tsx` 新增第三张入口卡「参考旧经验」。
- 完整状态：搜索中、无结果、选择 0/1/3 条、上限提示、移除、预览、预览后 409、生成中、取消、失败重试、来源变化/删除、采用。
- 预览显示真实服务端来源内容；不把客户端文本作为来源事实。
- 建议卡分层显示用户记录和模型说明；来源链接由服务端记录的 attemptId 生成。
- 尝试详情复用现有引用区，显示 AI 来源引用和旧尝试的反向引用。
- 手机 390px 纵向排列，桌面 1280px 三入口与详情面板。

## 4. 数据与一致性

- 一次生成只保存一份 `context_json`：当前念头 ID/版本、限制、配置版本、选中来源的 attempt/capture 版本和发送时正文。
- `suggestion_json.sources` 只保存模型实际引用的来源和说明；采用时为这些来源创建引用。
- 采用事务检查：generation 状态、当前念头 revision、每个来源 attemptRevision/captureRevision、是否已采用；任一变化返回 `sources_changed`。
- 来源删除后 AI 详情不再返回已删除正文；引用按现有外键/删除规则处理。
- 取消/超时/服务重启/迟到响应沿用原有 `pending/cancelled/failed/interrupted` 条件更新机制。

## 5. 测试结果（本机实际）

命令：

```powershell
$env:PYTHONIOENCODING='utf-8'; python scripts/run_tests.py
$env:SHINIAN_BASE='http://127.0.0.1:3200'; node scripts/e2e_ai.mjs
```

| 测试 | 结果 |
| --- | --- |
| `test_api.py` | 43 passed, 0 failed |
| `test_search.py` | 31 passed, 0 failed |
| `test_consistency.py` | 23 passed, 0 failed |
| `test_ai.py` | 138 passed, 0 failed |
| `test_experience.py` | 114 passed, 0 failed |
| `test_activity.py` | 27 passed, 0 failed |
| 合计 | **376 passed, 0 failed** |
| 完整集成（含并行阶段回顾/日程套件） | **710 passed, 0 failed** |
| JSON 导出（schemaVersion 2） | 80 passed, 0 failed |
| 备份/恢复（全库迁移兼容） | 150 passed, 0 failed |
| 重启持久化 | 83 条念头、引用、pending→interrupted 均通过 |
| 浏览器 E2E（含参考旧经验完整路径） | **45 passed, 0 failed** |

`test_experience.py` 覆盖：中英文关键词、失败/未判定结果、空观察排除、建议查询词、0/1/3/4 来源、预览真实内容、预览后版本变化、模型编造来源、矛盾/不足场景、采用引用快照、重复采用、来源删除清洗、旧记录兼容、导出与手动闭环回归、密钥不泄露。

浏览器完整路径：保存旧念头 → 旧尝试/结果 → 新念头 → 参考旧经验 → 搜索 → 选择 → 预览 → 生成 → 编辑采用 → 新尝试引用 → 来源尝试反向引用。

截图：

## 6. 真实模型联调状态

截至 2026-11-13 18:00，本机 `GET /api/settings/ai` 返回 `configured:false`，没有已启用、带 API Key 的真实模型配置；本机也没有可用的 OpenAI/DeepSeek/Ollama 凭据。因此：

- 未执行真实厂商模型联调；
- 未记录真实端点、模型 ID、请求成功率、耗时和用量；
- 未对任何厂商声明兼容；
- 未进行真实模型建议质量人工评分（避免用假模型结果冒充）。

有配置后的联调入口：打开 `/settings/ai`，保存并「测试连接」，然后用少量明确标注为合成数据的念头/旧尝试走「参考旧经验」流程；建议至少覆盖 1 条、3 条、失败经验、矛盾经验、条件变化、信息不足六类。不得在聊天中粘贴 API Key。

## 7. 未完成/限制

- 真实模型联调与质量评估待完成（原因见上）。
- 建议查询词是启发式关键词，少数长句可能初始候选为 0；界面允许修改搜索词或切回普通 AI 建议。
- 未测试 Firefox/Safari/真实手机；仅 Chrome 无头 1280×900 / 390×844。
- 构建保留既有 chunk >500 kB 警告。
