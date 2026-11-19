# 拾念 SHINIAN · 事件展示栏实现记录

日期：2026-11-13
范围：`/activity` 动态展示页、`GET /api/activity` 聚合接口、筛选/统计/时间线与桌面/手机适配。

## 1. 行为

- 顶部导航新增「动态」→ `/activity`。
- 从现有业务表读取并聚合事件，**不新增事件表**：
  - 念头：创建、更新、归档；
  - 尝试：创建、放弃；
  - 结果：尝试的观察文本/评价；
  - 引用：新尝试引用旧结果；
  - AI：建议生成、采用、失败、取消、中断；
  - 下一步行动：从回顾创建下一步、下一步加入日程（active 日程派生）、下一步完成并记录结果。
- 事件字段：类型、动作、时间、标题、正文摘要、所属念头/尝试、结果评价、AI 建议类型。
- 页面顶部显示全部动态、最近 7 天、尝试/结果、AI 采用统计；筛选：全部 / 念头 / 尝试 / 结果 / 引用 / AI。
- 时间线按本地日期分组（今天/昨天/日期），事件按时间倒序；每条可打开所属尝试或念头。
- 交互动效：统计数字滚动、时间线卡片错峰入场、筛选切换重放、卡片悬浮抬升、十分钟内事件「刚刚」脉冲、顶部滚动进度、刷新图标旋转、回到顶部按钮；`prefers-reduced-motion: reduce` 时关闭位移与长动画。
- 默认最多读取最近 200 条；更早记录仍在原业务页面中。
- `GET /api/activity?type=all|capture|attempt|result|reference|ai&limit=1..200`；未登录 401，非法 type 400。

## 2. 实现位置

- `src/server/activity.ts`：`registerActivityRoutes()`，从 `captures`、`attempts`、`attempt_references`、`ai_generations` 聚合，并从 `schedule_blocks` 派生下一步加入日程事件。
- `src/server/index.ts`：注册动态路由。
- `src/client/pages/ActivityPage.tsx`：统计卡、筛选、按日时间线、空状态、加载/错误状态。
- `src/client/App.tsx`：导航「动态」与路由。
- `src/client/types.ts`、`api.ts`：`ActivityEvent` / `ActivityResponse` 与 `api.listActivity()`。
- `src/client/styles.css`：展示栏样式与 390px/640px 响应式规则。

## 3. 边界

- 事件是读取时从当前记录派生，不记录每次编辑或状态变化历史；所以同一尝试可能同时出现「开始尝试」和「记录结果」，但不会还原所有中间状态。
- 删除念头/尝试后，相关动态从结果中消失；符合现有删除语义。
- 动态响应不包含 API Key、主密钥或密文；只返回用户自己的念头/尝试文本与公开元数据。
- 当前没有分页游标；以 `limit` 限制最多 200 条，适合本机单人小数据量。

## 4. 测试

- `scripts/test_activity.py`：27 个断言，覆盖未登录、响应结构、事件聚合、回源 ID、倒序、筛选、limit、非法类型、统计、密钥不出现在响应。
- 已加入 `scripts/run_tests.py`，与现有主流程/AI 测试一起运行。
- 浏览器 E2E 在 `scripts/e2e_ai.mjs` 中增加动态页检查、按尝试筛选、时间线入场、滚动进度、回到顶部和手机宽度无横向溢出，并生成截图：

实际结果：本轮相关套件 `run_tests.py` 376 passed / 0 failed；`e2e_ai.mjs` 45 passed / 0 failed（2026-11-13）。
