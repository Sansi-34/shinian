# 拾念 SHINIAN · Home 设计与开发规范 V2.0（实现记录）

本轮按《拾念 SHINIAN · Home 设计与开发规范 V2.0》重构首页。首页定位为「回到自己思考与成长过程的入口」，而不是管理仪表盘。全部展示内容来自真实数据；没有真实数据时给出明确下一步，不生成静态演示内容或装饰节点。

## 1. 信息优先级（已落地）

首页 DOM 顺序与设计规范一致：

1. **快速捕捉**：常驻 `QuickCapture`（`.capture-box`），输入即存，无需选择分类/项目/标签；Ctrl/⌘+Enter 保存。
2. **继续探索**：`ContinueItem` 列表，最多 3 项。优先读取用户固定的主题下一步（`topics[].nextAttempt`），再补最近 `todo/in_progress` 尝试。每条显示标题、最近上下文、已有真实结果与更新时间，打开后回到主题或尝试详情，不跳转纯列表。
3. **最近念头**：`ThoughtList` 简洁文字列表，显示真实 `captures`，支持查看、继续编辑；无卡片墙。
4. **知识联系**：`KnowledgePreview` 只读 `/api/graph` 的真实 `related/evidence/used/context/contains` 关系，过滤掉不存在或已归档的两端节点，只展示前 5 条；无关系时显示明确空态，不造随机节点。
5. **AI 帮助**：全局快捷入口 + 按需展开的 `ContextPanel`，不占首屏大量空间；AI 不会被自动调用，不自动创建任务。

## 2. 组件与视觉

- 保留轻量顶栏导航（无彩色图标背景），未改全站外壳。
- `CommandSearch`：常驻搜索框 + `Ctrl/⌘+K` 快捷面板 + `/` 聚焦搜索；输入法组字期间不触发快捷，中文标点不会误开面板。
- 使用现有归藏设计 token：直角、语义色、两种主要字重（标题 300 / 控件与标签 500）、充足留白；无欢迎横幅、无装饰背景、无发光机器人、无进度百分比/无意义统计。
- 已有 `prefers-reduced-motion` 支持，焦点可见，文本对比度由主题 token 保证。

## 3. 四种状态

- **首次使用**：无记录时显示「从一条念头开始」与三个明确下一步。
- **日常使用**：显示真实继续探索、最近念头、知识关系、主题、经验与今日安排。
- **内容较多**：继续探索限 3 条（固定优先 + 近期未完成尝试）；最近念头限 8 条并提供「查看全部」；主题限 3 条、经验限 5 条。
- **离线 / AI 不可用**：监听 `online/offline` 事件，显示离线提示且不遮挡记录入口；各数据块独立错误态与重试，加载失败不冒充空数据。

## 4. 兼容与回归

保留既有 data-testid 与关键文案：
- `home-continue-attempts`、`home-continue-item`、`home-continue-card`、`home-continue-open-btn`、固定尝试直达链接。
- `home-topics` / `home-topics-all` / `home-topic-item`、`home-experiences-error`、`home-captures-error`、`today-schedule-item`、`ask-entry`。
- `card-main` 兼容类与「继续已有尝试」「现在没有进行中的尝试」文案，避免既有端到端验收回归。

## 5. 验收结果（实际运行）

- `npm run typecheck`：通过。
- `npm run build`：通过（仅有既存 react-router "use client" 与 chunk size 警告）。
- `node scripts/e2e_home_v2.mjs`：**18 passed, 0 failed**（隔离库 3299；空数据首次使用、五层顺序、真实数据、CommandSearch、按需 AI、知识预览、离线、1280/1440/390 布局、减少动效）。截图在 （截图未随仓库提供）。
- `node scripts/e2e_v06_paths.mjs`：**45 passed, 0 failed**（1280×900 与 390×844，路径 A/B 完整闭环）。
- `node scripts/e2e_schedule.mjs`：**33 passed, 0 failed**。
- `node scripts/e2e_topics.mjs`：**107 passed, 0 failed**。
- `npm run test:all`：全部 Python 回归通过（含 API、搜索、一致性、AI、经验、动态、回顾、链接、问记录、主题、关键词扩展、导出、备份恢复等；输出显示「全部测试通过 (OK)」）。

## 6. 未验证 / 边界

- 离线状态通过浏览器事件与 `navigator.onLine` 模拟验证，未在真实断网环境逐项测试同步行为；当前应用为单机 SQLite，本轮离线提示只承诺「已加载内容可查看、新念头可写入本机」。
- 知识预览只展示图上已有的真实关系，不含未建立关系的推荐；无语义相似度或 AI 生成关联。
- 未在真实手机、Firefox、Safari 上验证，移动端只验证 390×844 无横向溢出、可点按与键盘可达。
- 截图来自隔离验收库的合成数据，不代表用户主库内容。
