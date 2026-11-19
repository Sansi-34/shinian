# 引用的第三方交互（UI Moments）

来源：[guanmo-ai/ui-moments](https://github.com/guanmo-ai/ui-moments)（观默，MIT 许可）。
本项目只借鉴交互行为与动效节奏，代码按拾念 V2 的 token 体系重写，未整段复制第三方实现。

| 引入的组件 | 位置 | 参考作品 | 许可 |
|---|---|---|---|
| `ui/Spinner.tsx` | 所有 V2 页面的加载态（替换「加载中…」纯文字） | SVG Spinners（Utkarsh Verma）、LDRS（Griffin Johnston） | MIT |
| `ui/HoldConfirm.tsx` | 删除念头 / 删除尝试的确认按钮 | 原创「长按确认」hold-confirm | MIT |
| `ui/Segment.tsx` | 搜索页结果筛选、尝试页状态与评价切换 | 「对齐拨片」alignment-switch、「蠕动分页点」worm-dots | MIT |
| `ui/CopyButton.tsx` | 念头详情「复制正文」、尝试详情「复制结果」 | 原创「复制按钮」copy-morph | MIT |

## 看过但没有引入

| 作品 | 为什么不用 |
|---|---|
| 昼夜开关 day-night-toggle | 全屏 canvas 像素螺旋，塞进 40px 状态栏会失真；我们的主题切换是低频操作，不值得为它引入整块 canvas 与 requestAnimationFrame 循环 |
| 果冻方块 / 涟漪画板 / 磁吸点阵 / 融合水滴 | 纯装饰性指针反馈，与「安静记录」的产品基调冲突 |
| 倾斜卡片 tilt-card | 文字会随倾斜轻微发虚，长文本可读性下降；我们的列表以阅读为主 |
| 扇形卡组 / 纵深卡堆 / 封面流 | 依赖卡片式布局，而 V2 已经全部改成行式列表 |
| 下拉刷新 pull-refresh | 我们是本地单机 SQLite，多数操作用户主动触发，没有下拉语义 |

## 注意

- 上游作品会更新，若后续同步其实现，请同时更新本文件的表格与许可说明。
- 第三方作品保留原始许可；本项目自身代码仍按仓库根 `LICENSE` 处理。
