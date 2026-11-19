# 拾念 SHINIAN ·「主题导出 Markdown」实现与文件格式（v1）

日期：2026-11-16。接口字段、错误码与前端流程见 [`topic-export-api-contract.md`](./topic-export-api-contract.md)；实现规格来源见 [`topic-export-spec.md`](./topic-export-spec.md)。本文记录实现结构、Markdown/资源格式、frontmatter、文件名、关系映射、快照语义、范围/限制与安全边界。

## 1. 定位与非目标

主题导出把**一个主题当前可见的记录与真实关系**渲染成一组人类可读的 Markdown 文件，打包为 ZIP，供用户自己归档、阅读或放进 Obsidian 等 Markdown 工具。它是**一次性单向副本**，不是同步、不是备份、不是导入格式。

明确不做：

- 不调用模型、不访问外部网络、不读取网页、不抓取来源链接。
- 不写入 Obsidian 目录、不修改用户文件系统、不安装插件、不建立双向链接。
- 不提供导入、同步、增量更新、冲突合并、删除传播。
- 不修改数据库 schema、不新增迁移、不改写既有业务表。
- 不导出主题外记录（用户显式勾选的一跳依据除外），不递归关系。
- 不导出模型配置、API Key、会话、内部回执、问答历史、AI 生成记录、日程、研究、回顾、动态等非主题数据。
- 不把「未填写结果」推断成失败，不把历史快照冒充当前内容。

## 2. 实现文件与调用链

| 文件 | 职责 |
| --- | --- |
| `src/server/topicExportService.ts` | `buildExportSnapshot`：在只读事务中读取主题、成员、记录、尝试、关系、经验依据与候选，计算 counts/files/omittedRelations/estimatedBytes/scopeHash；`renderExportFiles`：只根据快照渲染 Markdown/JSON 文件，不再读库；`exportTopicZip`：校验 scopeHash、限制，生成 ZIP。 |
| `src/server/topicExportRoutes.ts` | `POST /api/topics/:id/export/preview` 与 `POST /api/topics/:id/export`；鉴权、请求校验、错误映射、响应头（`application/zip`、`Content-Disposition`、`no-store`）。 |
| `src/server/zip.ts` | 最小 ZIP writer：Node `zlib` deflate、CRC32、UTF-8 文件名、路径安全校验、拒绝符号链接/重复路径/Windows 保留名。 |
| `src/server/index.ts` | 只增加 import 与路由注册；不放业务逻辑。 |
| `src/client/components/TopicExportPanel.tsx` | 预览面板、归档开关、文件清单、一跳依据复选、错误提示、下载。 |
| `src/client/api.ts` / `types.ts` | 两个接口的请求/响应类型与 fetch 封装。 |
| `src/client/pages/TopicPage.tsx` | 主题详情「导出 Markdown」入口。 |
| `src/client/styles.css` | 面板、列表、移动端布局。 |
| `scripts/test_topic_export.py` / `scripts/e2e_topic_export.mjs` | API 与浏览器验收（由测试工作流新增）。 |

调用链：

```text
preview:
  route 鉴权/校验
    -> buildExportSnapshot(topicId, options)   // 只读事务，唯一快照
    -> 返回 topic + scope + scopeHash + canExport

export:
  route 鉴权/校验 expectedScopeHash 格式
    -> buildExportSnapshot(topicId, options)   // 重新完整读取，不复用分页/预览缓存
    -> 校验 includeBasisKeys 仍可选、scopeHash 一致
    -> 检查 limits
    -> renderExportFiles(snapshot)             // 纯函数，不再读库
    -> createZip(files)                        // 实际 ZIP 字节数复查
    -> 200 application/zip
```

关键点：

- 预览和导出**各自**在只读事务中读取全部数据；导出不依赖预览时留在内存里的正文，避免预览后数据变化仍导出旧正文。
- `renderExportFiles` 不再查询数据库；快照里缺的字段不会在渲染阶段补读。
- 导出不写 `mutation_receipts`、不 bump `topics.revision`、不改 `updated_at`；失败整体不产生副作用。
- 本功能没有数据库迁移；`schemaVersion` 仍为 7。

## 3. 快照、scopeHash 与并发

### 3.1 两层「快照」

1. **导出时当前快照**：`buildExportSnapshot` 在一个 SQLite 只读事务里读取当前主题、成员、capture、attempt、关系、经验笔记与依据。它代表「点击导出这一刻」的数据库状态。
2. **关系里的历史快照**：`attempt_references.snapshot_result_text`、`experience_sources.source_*`、`experience_attempts.adopted_*` 是关系建立时保存的旧值。它们必须和当前正文分开标注（见 §9）。

两者不能混为一谈：导出的正文是当前快照；引用卡片里的旧结果是历史快照；下载后的 ZIP 又是导出时快照的静态副本，之后不会更新。

### 3.2 scopeHash 的稳定序列化

实现使用「递归按对象 key 字典序排序后 `JSON.stringify`」的稳定序列化，再 SHA-256。数组在构建时显式排序（成员按 `topic_members.created_at, id`；尝试按所属成员顺序再按 `created_at, id`；关系/候选/文件按稳定键）。输入覆盖：

- `formatVersion`、`topic` 全字段；
- `includeArchived`、去重排序后的 `includeBasisKeys`；
- 全部 `topic_members`（含归档成员）及其 capture 正文/标题、`revision`、`archivedAt`、`updatedAt`、`kind`；
- 所有 thought 成员下全部 attempts 的 `step/state/resultText/outcome/sourceUrl/observedAt/revision/createdAt/updatedAt/actionDescription`；
- 与包含实体相邻的 `capture_links`、`attempt_references`（含 note、revision、snapshotResultText、snapshotRevision）；
- 主题内经验的 `experience_notes` 全字段、`experience_sources`（含 deleted、source 快照、updatedAt）；
- 相关 `experience_attempts`（含 adoptedVersion/adoptedTitle/adoptedUnderstanding/deleted）；
- 全部 `basisCandidates` 描述（sourceKey/title/summary/referencedBy/deleted/selectable）；
- 最终 included 集合、counts、omittedRelations、files 元数据。

不包含 `generatedAt`、ZIP 文件名时间戳、`estimatedBytes`、随机数。因此同一范围在数据未变时，预览与导出得到同一个 hash。

### 3.3 并发与 409

- 预览返回 `scopeHash`；导出必须带 `expectedScopeHash`。
- 导出重新构建快照后比对：不一致返回 409 `export_scope_changed`，并给 `currentScopeHash`。
- 预览后成员增删、正文/标题修改、尝试结果/状态/观察时间变化、引用/依据/采用关系变化、归档状态变化、选项变化，都会使 hash 变化。
- 来源在预览后被删除/移出：该 `includeBasisKeys` 已不可选。实现按契约 §4.4 返回 409（推荐）或 400 + `field:"includeBasisKeys"`；前端统一按「重新预览」处理。
- 预览/导出都不缓存。预览 GET 语义但使用 POST，因为请求带选项数组，且避免把选择写进 URL/日志。

### 3.4 为什么不用主题 `revision` 单独做校验

`topics.revision` 只覆盖主题自身字段与成员/固定下一步/归档变化，不覆盖成员 capture 的正文、attempt 的结果、引用 note、经验依据变化。因此必须用覆盖整个导出快照的 `scopeHash`；只比 `revision` 会漏掉「正文改了但导出仍是旧内容」的情况。

## 4. ZIP 结构

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

- `<topicId>` 是完整 ID（含 `topic-`），所以根目录实际形如 `shinian-topic-topic-1763200000000-ab12cd/`；这是规格明确的预期结果，不剥离前缀。
- 文件名：`shinian-topic-<topicId>-<YYYYMMDD-HHmmss>.zip`；时间是服务器本地时间，秒级。
- 元数据文件固定三个：`主题索引.md`、`README.md`、`manifest.json`。记录文件按类型放在 `records/` 下。
- 空分类目录可省略；`files[]` 不列目录项。
- ZIP 条目只包含普通文件，不含符号链接；文件名 UTF-8 标志位 bit 11；deflate 压缩。
- 条目顺序固定为：索引 → README → manifest → 主题内 thoughts → 主题内 experiences → 主题内 attempts → basis thoughts → basis experiences → basis attempts；组内顺序见契约 §3.5。
- 根目录不是显式目录条目，而是所有条目路径的共同前缀；解压工具会创建同名文件夹。

## 5. Markdown 文件格式

### 5.1 通用规则

- UTF-8（建议无 BOM），LF 换行。
- 每个 `.md` 第一行是 `---`，随后是固定 frontmatter（见 §5.7），再空一行开始正文。
- 正文第一行是 H1 标题：主题索引/念头/经验用当前标题的首行；尝试用 `step` 的首行；README 用「主题导出说明」。
- 用户正文一律放在 fenced text 代码块中：
  - 围栏字符为反引号，长度 = `max(3, 正文中最长连续反引号串长度 + 1)`；
  - 信息串为 `text`；
  - 正文中的 ``` 不会提前关闭围栏；
  - 正文为空时写 `（未填写）`，不写空代码块也可以，但必须有明确占位。
- 标题/链接文字中的换行折叠为空格；Markdown 特殊字符（`\`、`[`、`]`）转义；不生成原始 HTML。
- 所有「当前值」与「历史快照」分区标注，见 §9。
- 没有内容的关系区块可以省略；但如果省略，必须在索引的「未包含的关联」或文件末尾说明计数，不留下悬空链接。

### 5.2 `主题索引.md`

用途：一页看清主题、成员、尝试与关系入口。建议结构（字段顺序可调整，信息不得缺失）：

````markdown
---
shinian_entity: index
shinian_id: topic-1763200000000-ab12cd
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763200000000
shinian_updated_at: 1763200000000
shinian_revision: 3
shinian_archived: false
---

# PWM 调光实验

- 探索问题：不同频率下 LED 是否可见闪烁？
- 继续说明：先记录 500 Hz 与 2 kHz 的对照。
- 固定下一步：[把 PWM 频率从 500 Hz 改到 2 kHz 再观察](records/attempts/attempt-att-1763200000000-abc123.md)（待开始）
- 导出时间：2026-11-16 18:05:00（本地时间）
- 本次范围：包含归档=true；追加一跳依据 1 条；共 2 念头 / 1 经验 / 4 尝试 / 9 文件

## 念头

- [500 Hz 下 LED 会闪](records/thoughts/thought-cap-1763199990000-def456.md)（revision 2）
- [占空比固定后再比较频率](records/thoughts/thought-cap-1763199980000-aaa111.md)（revision 1，已归档）

## 经验

- [先降低占空比再比较频率](records/experiences/experience-cap-1763199970000-exp001.md)（revision 3）

## 尝试

- [把 PWM 频率从 500 Hz 改到 2 kHz 再观察](records/attempts/attempt-att-1763200000000-abc123.md) — 所属念头：[500 Hz 下 LED 会闪](records/thoughts/thought-cap-1763199990000-def456.md)；已记录结果
- [用相机拍摄 500 Hz 闪烁](records/attempts/attempt-att-1763199995000-def789.md) — 所属念头：同上；等待记录结果

## 未包含的关联

- 手动关联 1 条、尝试引用 1 条、经验依据 0 条、经验采用 0 条。另一端未包含在本次导出或来源已删除，因此不显示标题。

## 说明

- 本文件是拾念 SHINIAN 的一次性导出副本；之后在拾念中的修改或删除不会自动更新本文件。
- 关系方向见各记录文件的「关联记录 / 引用 / 依据 / 采用」区块。
````

要求：

- 「固定下一步」只在 `topics.next_attempt_id` 指向的 attempt 仍有效且属于包含的 thought 成员时给链接；否则写「未固定」或「固定下一步已失效」，不创建尝试。
- 尝试列表只列主题内 thought 成员下的真实 attempts；经验成员自己的依据 attempts 不在此列表冒充主题尝试。
- 未包含关联只给计数，不给标题/ID。
- 归档成员在 `includeArchived=true` 时列出并标「已归档」；`false` 时不出现。
- 索引本身不重复粘贴念头/经验正文，只给链接与元信息。

### 5.3 `README.md`

用途：给第一次打开 ZIP 的人解释这是什么、怎么读、边界是什么。建议内容：

````markdown
---
shinian_entity: readme
shinian_id: topic-1763200000000-ab12cd
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763200000000
shinian_updated_at: 1763200100000
shinian_revision: null
shinian_archived: false
---

# 主题导出说明

这是「拾念 SHINIAN」从主题「PWM 调光实验」导出的一次性 Markdown 副本，导出时间 2026-11-16 18:05:00。

- 打开方式：直接把整个 `shinian-topic-topic-1763200000000-ab12cd/` 文件夹放进 Obsidian vault（或任意 Markdown 编辑器）即可；相对链接按文件夹结构工作。
- 文件结构：`主题索引.md` 是入口；`records/thoughts`、`records/experiences`、`records/attempts` 是记录；`manifest.json` 是机器可读清单。
- 关系图例：关联到 / 被关联；引用了 / 被引用；依据 / 被引用为依据；采用经验 / 被尝试采用。方向以记录文件中的箭头文字为准。
- 历史快照：引用时结果、依据建立时正文、采用时经验版本都会明确标注「历史快照」，它们不代表当前内容。
- 未包含：主题外记录、未勾选的一跳依据、已删除来源正文、日程/研究/回顾/AI 生成/问答历史/密钥均不在本副本中。
- 独立副本：下载后在拾念中的修改或删除**不会**自动更新本文件夹；需要最新内容请重新导出。
- 不支持导入/同步：本文件夹不能还原拾念数据库；整库备份请使用 SQLite 备份。
````

`README.md` 的 `shinian_revision` 固定为 `null`；`shinian_created_at`/`shinian_updated_at` 取主题创建/更新时间；`shinian_archived` 取主题归档状态。

### 5.4 念头文件

路径：`records/thoughts/thought-<captureId>.md`。建议结构：

````markdown
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

# 500 Hz 下 LED 会闪

## 原文

```text
PWM 低占空比时 LED 会闪，500 Hz 时肉眼可见。
```

## 相关尝试

- [把 PWM 频率从 500 Hz 改到 2 kHz 再观察](../attempts/attempt-att-1763200000000-abc123.md) — 待开始
- [用相机拍摄 500 Hz 闪烁](../attempts/attempt-att-1763199995000-def789.md) — 等待记录结果

## 关联记录（出向）

- [占空比固定后再比较频率](../thoughts/thought-cap-1763199980000-aaa111.md) — 关联说明：同一条实验线；建立于 2026-11-16。

## 关联记录（入向 / 反向视图）

- [另一条相关念头](../thoughts/thought-cap-1763199970000-bbb222.md) — 对方「关联到」本记录；同一关系不重复计数。

## 引用与依据

- 引用了：[旧尝试](../attempts/attempt-att-1763199900000-old001.md)（引用时快照见该尝试文件）。
- 被经验引用为依据：[先降低占空比再比较频率](../experiences/experience-cap-1763199970000-exp001.md)。
````

要求：

- 「原文」必须是完整用户正文，不截断；标题只用于 H1/链接文字。
- 「相关尝试」列出该念头下全部真实 attempts（按排序），不受主题尝试分页影响。
- 「关联记录」出向/入向分开；同一 `capture_links` 行只在两端各以「关联到」/「被关联」出现一次，不重复计数。
- 关联说明 `note` 为空时写「（无说明）」。
- 该念头若是主题外的一跳依据，`shinian_topic_id` 仍写当前主题 ID，但不生成它自己的主题成员链接；其所属主题不导出。

### 5.5 经验文件

路径：`records/experiences/experience-<captureId>.md`。建议结构：

````markdown
---
shinian_entity: experience
shinian_id: cap-1763199970000-exp001
shinian_capture_id: cap-1763199970000-exp001
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763199970000
shinian_updated_at: 1763200100000
shinian_revision: 3
shinian_archived: false
---

# 先降低占空比再比较频率

## 我的理解

```text
把占空比固定后，只改频率做对照，更容易看清差异。
```

## 适用条件

```text
PWM 调光、占空比可独立设置、肉眼观察。
```

## 限制

```text
没有相机验证；只在一个 LED 样品上试过。
```

## 整理出处

- 整理方式：用户整理（derivation.by = user）
- 模型依据：无（若为 model，标注「观察/推断」并说明「用户确认保存不等于已证实」）
- 来源主题/问答：不导出问答历史；只写可确认的整理出处，未知写「未记录」。

## 依据（当前与历史快照分开）

- [旧尝试：把 PWM 频率从 500 Hz 改到 2 kHz 再观察](../attempts/attempt-att-1763200000000-abc123.md)
  - 依据建立时快照（source revision 1）：`2 kHz 时肉眼未见闪烁`
  - 当前结果（revision 2）：`2 kHz 时肉眼未见闪烁；未用相机验证`
- 来源未包含在本次导出（`attempt:att-...`）
- 来源已删除（原依据的标题/正文/结果均不写出）

## 后续实践（被尝试采用）

- [尝试：用相机拍摄 500 Hz 闪烁](../attempts/attempt-att-1763199995000-def789.md)
  - 采用时经验版本：v2
  - 当前经验版本：v3（已更新；采用快照仍按 v2 保留）
````

要求：

- 经验正文分「我的理解 / 适用条件 / 限制」三段；空段写「（未填写）」。
- `derivation.by=model` 时必须标「模型辅助整理」及 `modelBasis`（观察/推断）；`by=user` 标「用户整理」。
- 依据必须列出所有 `experience_sources`：包内来源给链接；包外/未勾选来源只写「来源未包含在本次导出」；`deleted=1` 或底层不存在只写「来源已删除」。
- 依据的历史快照与当前来源正文分开；`source_revision` 与当前 revision 不同要标「来源已更新」。
- 采用关系列出 `experience_attempts`（未删除且两端在包内）；采用快照与当前经验正文分开。
- 不把「经验正文」当作原始观察；经验是用户确认的整理，不是事实证明。

### 5.6 尝试文件

路径：`records/attempts/attempt-<attemptId>.md`。建议结构：

````markdown
---
shinian_entity: attempt
shinian_id: att-1763200000000-abc123
shinian_capture_id: cap-1763199990000-def456
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763200000000
shinian_updated_at: 1763200050000
shinian_revision: 2
shinian_archived: false
---

# 把 PWM 频率从 500 Hz 改到 2 kHz 再观察

## 行动

```text
把 PWM 频率从 500 Hz 改到 2 kHz，其他条件不变，观察 10 分钟。
```

## 状态与结果（用户观察）

- 状态：已记录结果（done）
- 实际结果：
  ```text
  2 kHz 时肉眼未见闪烁；未用相机验证。
  ```
- 结果评价：未判定（undetermined）
- 观察时间：2026-11-16 18:00:00（本地时间）
- 来源链接（仅文本，不抓取）：https://example.com/notes/pwm

## 引用

- 引用了：[旧尝试：500 Hz 下观察到闪烁](../attempts/attempt-att-1763199900000-old001.md)
  - 引用时快照（snapshot revision 1）：`500 Hz 时肉眼可见闪烁`
  - 当前结果：`500 Hz 时肉眼可见闪烁；已用相机复核`
- 被引用：[后续尝试：换用 2 kHz 电源](../attempts/attempt-att-1763200100000-later01.md)

## 采用经验

- [先降低占空比再比较频率](../experiences/experience-cap-1763199970000-exp001.md)
  - 采用时经验版本：v2
  - 当前经验版本：v3（已更新）
````

要求：

- 状态映射：`todo`=待开始、`in_progress`=进行中、`done`=已标记完成、`cancelled`=已取消；若 `done` 但结果为空，写「已标记完成但未填写实际结果（不能据此判断成败）」。
- 结果为空（任何非取消状态）固定写「尚未填写实际结果（不能据此判断成败）」；**不得**根据创建时间/更新时间推断完成或失败。
- `outcome` 映射：`success`=成功、`failure`=失败、`undetermined`=未判定、空=未填写。
- 来源链接只作为纯文本/代码文本，不自动抓取、不验证可访问性、不转成 HTML。
- 引用/被引用只列与包内 attempt 的关系；另一端未包含写占位，不建链接。
- 采用经验按 `experience_attempts` 列出；`deleted=1` 只写「来源经验已删除」，不写采用快照正文。

### 5.7 frontmatter 规范

所有 `.md`（含 `README.md`）的 frontmatter 固定字段：

```yaml
---
shinian_entity: attempt
shinian_id: att-1763200000000-abc123
shinian_capture_id: cap-1763199990000-def456
shinian_topic_id: topic-1763200000000-ab12cd
shinian_created_at: 1763200000000
shinian_updated_at: 1763200050000
shinian_revision: 2
shinian_archived: false
---
```

| 字段 | 取值 |
| --- | --- |
| `shinian_entity` | `index` \| `readme` \| `thought` \| `experience` \| `attempt`。`manifest.json` 无 frontmatter。 |
| `shinian_id` | index/readme = 主题 ID；thought/experience = capture ID；attempt = attempt ID。 |
| `shinian_capture_id` | thought/experience = 自身 capture ID；attempt = 所属 capture ID；index/readme 不写。 |
| `shinian_topic_id` | 当前主题 ID。 |
| `shinian_created_at` | 实体创建时间（毫秒）；index/readme 用主题创建时间。 |
| `shinian_updated_at` | 实体更新时间（毫秒）；index/readme 用主题更新时间。 |
| `shinian_revision` | index = 主题 revision；thought/experience = capture revision；attempt = attempt revision；readme = `null`。 |
| `shinian_archived` | index/readme = 主题归档；记录 = 自身/所属 capture 归档。 |

- 用户文本**不进入 frontmatter**；只放固定键与服务端生成的 ID/时间/布尔值，避免 YAML 注入。
- 字符串值统一按 YAML 安全标量输出；布尔用小写 `true`/`false`；时间用整数毫秒。
- frontmatter 的 `---` 必须是第一行；结束后空一行。
- 读取方不得依赖键顺序。

## 6. 文件名与稳定 ID

- 文件名只由固定前缀 + 稳定 ID 构成：
  - `thought-<captureId>.md`
  - `experience-<captureId>.md`
  - `attempt-<attemptId>.md`
- 标题只放在 H1、正文和链接文字中；**改名不改路径**。同一记录在任意一次导出中路径稳定，除非 ID 变化（业务上不会）。
- 稳定 ID 全局唯一，因此同名记录不会冲突；不要用标题 slug、序号、日期或哈希生成路径。
- 生成前校验 ID 只含 `[A-Za-z0-9_-]`；若数据异常（包含 `/`、`\`、`..`、控制字符等），拒绝生成，不把用户输入拼进路径。
- ZIP 路径还拒绝：绝对路径、盘符、空段、`.`/`..` 段、反斜杠、控制字符、结尾点/空格、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）、重复路径、超过 255 字节的段、超过 65535 个条目、超过 4 GiB。
- 中文元数据文件名 `主题索引.md` 是固定常量；记录文件名全部 ASCII。

## 7. 相对链接编码

- 所有链接是相对当前文件的 POSIX 路径，不使用绝对路径、盘符、`file://` 或反斜杠。
- 逐段做 UTF-8 百分号编码：`/` 保留，空格 `%20`，中文/特殊字符编码；`..` 保留用于包内上行导航。
- 从 `records/thoughts/` 出发：
  - 同目录尝试：`../attempts/attempt-<id>.md`
  - 同目录经验：`../experiences/experience-<id>.md`
  - 索引：`../../%E4%B8%BB%E9%A2%98%E7%B4%A2%E5%BC%95.md`
- 从 `主题索引.md` 出发：
  - `records/thoughts/thought-<id>.md`
  - `records/experiences/experience-<id>.md`
  - `records/attempts/attempt-<id>.md`
- 链接文字做 Markdown 转义：至少 `\`、`[`、`]`；换行折叠成空格；不以链接文字承载完整正文。
- 所有链接目标必须存在于同一 ZIP；不链接未包含/已删除记录。对未包含来源写纯文本「来源未包含在本次导出」，对删除来源写「来源已删除」。
- 链接的百分号编码在 Obsidian/编辑器里可能显示为解码后的中文；只要解码后的目标路径存在即可。

## 8. 关系类型、方向与计数

### 8.1 映射表

| 导出关系 | 数据库来源 | 方向 | 起点文件写法 | 终点文件写法 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 手动关联 `manualLink` | `capture_links` | `from_capture_id` → `to_capture_id` | 「关联到 → [目标]」 | 「被关联 ← [来源]（反向视图）」 | 同一行只在两端各出现一次；不是双向两条。 |
| 尝试引用 `attemptReference` | `attempt_references` | `from_attempt_id`（引用方）→ `to_attempt_id`（被引用方） | 「引用了 → [旧尝试]」 | 「被引用 ← [新尝试]」 | 带 `note`、`snapshot_result_text`、`snapshot_revision`。 |
| 经验依据 `experienceSource` | `experience_sources` | `experience_id` → `source_key` | 「依据 → [来源]」 | 「被经验 [E] 引用为依据」 | 只列直接依据；`deleted=1` 只写「来源已删除」。 |
| 经验采用 `experienceAdoption` | `experience_attempts` | `attempt_id`（后续尝试）→ `experience_capture_id` | 「采用经验 → [E]（采用时 vN）」 | 「被尝试 [T] 采用（vN）」 | 带采用时标题/理解快照；当前经验正文另起。 |
| 主题成员 | `topic_members` | topic → capture | 索引的「念头/经验」列表 | 无反向记录 | 不是普通关系，不计入 `omittedRelations`。 |
| 固定下一步 | `topics.next_attempt_id` | topic → attempt | 索引「固定下一步」 | 尝试文件无需反向 | 仅有效 `todo/in_progress` attempt；不改状态。 |

### 8.2 方向示例

- 用户创建「A 关联到 B」：A 文件写「关联到 B」；B 文件写「被 A 关联（反向视图）」。若用户创建的是「B 关联到 A」，方向相反。
- 新尝试 R 引用旧尝试 O：R 文件写「引用了 O」；O 文件写「被 R 引用」。
- 经验 E 的依据是尝试 B：E 文件写「依据 B」；B 文件写「被经验 E 引用为依据」。
- 尝试 T 采用经验 E：T 文件写「采用经验 E（采用时 v2）」；E 文件写「被尝试 T 采用（v2）」。

### 8.3 计数

- `manualLinks`、`attemptReferences`、`experienceSources`、`experienceAdoptions` 只计**两端都在包内且来源未删除**的真实关系行。
- 反向视图不是第二条关系；不重复计数。
- `omittedRelations.byType` 只计「一端在包内、另一端未包含/已删除」的关系，不给标题/ID。
- 同一关系即使出现在多个文件的区块中，也只计一次。

## 9. 当前内容与历史快照

### 9.1 分层

| 层 | 数据 | 在文件中的呈现 |
| --- | --- | --- |
| 记录当前值 | 导出事务读取的 `captures.raw_text`、`experience_notes`、`attempts.step/result_text/outcome/observed_at` 等 | 正文、H1、状态/结果区；标「导出时当前内容」与 revision。 |
| 引用时快照 | `attempt_references.snapshot_result_text` / `snapshot_revision` | 引用区块的「引用时快照」；不得写成当前结果。 |
| 依据建立时快照 | `experience_sources.source_title/source_text/source_result_text/source_revision` | 经验「依据」区的「依据建立时快照」；当前来源正文另起。 |
| 采用时快照 | `experience_attempts.adopted_title/adopted_understanding/adopted_version` | 「采用时经验版本 vN」；当前经验正文另起。 |
| 导出时快照 | `buildExportSnapshot` 的整个结果 | 整个 ZIP；`manifest.generatedAt` 与 README 说明「一次性副本」。 |

### 9.2 标注规则

- 先当前、后历史；历史区块开头写「以下为历史快照，不代表当前内容」。
- `snapshot_revision < 当前 revision` 或快照文本与当前 `resultText` 不同：标「来源结果已更新」。
- `adopted_version < 当前 capture.revision`：标「经验已更新（采用时 vN，当前 vM）」；采用快照仍保留。
- 不把历史快照用于判断当前成败；不把「当时结果」写成「当前结果」。
- 未填写结果固定写「尚未填写实际结果（不能据此判断成败）」；`done` 但结果为空也不得显示成功。
- `cancelled` 显示「已取消」；不因时间经过自动变为完成/失败。

## 10. 未包含与已删除来源规则

| 情况 | ZIP 中的处理 | 预览中的处理 |
| --- | --- | --- |
| 主题外记录未勾选 | 不生成文件；不写标题/正文 | 不计入 `files`；若与包含实体相邻，计入 `omittedRelations`。 |
| 主题外记录被勾选（一跳依据） | 只生成该条记录文件（thought 或 attempt）；不加它的所属念头/其他尝试/引用/主题 | 出现在 `files`，`basis=true`；计入 `basisThoughts`/`basisAttempts`。 |
| 经验依据为包外记录、未勾选 | 经验文件写「来源未包含在本次导出」；不写标题/正文/结果 | 出现在 `basisCandidates`，`selectable=true`。 |
| 经验来源 `deleted=1` | 经验文件只写「来源已删除」；**不写** `source_title/source_text/source_result_text` 快照 | `basisCandidates` 中 `deleted=true`、`selectable=false`、`title="来源已删除"`。 |
| 经验来源底层 attempt/capture 已不存在 | 同上「来源已删除」；不读取快照 | 同上。 |
| 引用两端另一端未包含 | 引用区块写「来源未包含在本次导出」；不建链接 | 计入 `omittedRelations.attemptReference`。 |
| 手动关联另一端未包含 | 关联区块写「对方未包含在本次导出」；不建链接 | 计入 `omittedRelations.manualLink`。 |
| 采用关系的经验已删除 | 尝试文件只写「来源经验已删除」；不写 adopted 正文 | 不计入 `experienceAdoptions`（关系已失效）。 |
| 归档成员且 `includeArchived=false` | 不生成文件；相关关系计入 `omittedRelations` | 不出现在 `files`；`archived` 统计仍给主题成员归档数。 |
| 归档成员且 `includeArchived=true` | 生成文件，`shinian_archived: true`；索引标「已归档」 | 出现在 `files`；`archived` 统计给数量。 |
| 主题已归档 | 仍可导出；`shinian_archived: true` | `topic.archived=true`，可预览/导出。 |
| 尝试被删除 | 不生成文件；其引用级联删除；相关关系消失 | 不出现；相关候选变「来源已删除」。 |
| 日程/研究/回顾/AI 生成/问答历史 | 不导出 | 不计入 counts。 |

固定占位文字（不得改写为用户可见的标题/正文）：

- `来源未包含在本次导出`
- `来源已删除`
- `来源经验已删除`
- `尚未填写实际结果（不能据此判断成败）`
- `已标记完成但未填写实际结果（不能据此判断成败）`

## 11. 不递归规则

导出只做「主题成员 + 一跳依据」的闭包，不做图遍历：

- 主题成员只来自 `topic_members`；不因记录属于其他主题而加入。
- thought 成员下的 attempts 是直接子记录，全部导出；不继续读 attempt 的引用目标（除非该目标本身也在包内，作为关系展示）。
- 经验依据只读 `experience_sources` 的直接来源；不读来源记录自己的主题、其他 attempts、引用、后续实践。
- 勾选的一跳依据只加入该条记录；不加入它的所属念头（若为 attempt）、不加入它的其他尝试、不加入它的引用/被引用、不加入它的主题成员关系。
- `capture_links`/`attempt_references`/`experience_attempts` 只展示两端都在包内的直接关系；不沿关系链扩展。
- 不把「同一主题」当作边；不因为两条记录同属一个主题就增加关系。

## 12. 安全边界

### 12.1 访问与运行

- 默认只绑定 `127.0.0.1`；两个接口都要求登录会话。
- 写请求沿用 Host / Origin 校验，跨站请求 403；Cookie 为 `httpOnly`、`SameSite=Lax`。
- 导出是只读操作，但使用 POST（请求带选项数组，避免 URL 编码/日志泄露；沿用跨站写保护）。
- 不调用模型、不发起外部 HTTP、不读取来源 URL、不访问 Obsidian API、不写用户目录。

### 12.2 数据与日志

- 不写数据库、不写 `mutation_receipts`、不 bump revision/updated_at；导出失败不会留下半成品业务数据。
- 不导出模型配置、API Key、会话、账号、内部回执、问答历史、AI 生成、事件动态、日程、研究、回顾。
- 普通日志不记录请求体、Markdown 正文、念头/经验原文、来源 URL 全文；错误只记录必要的内部原因。
- ZIP 在内存中生成，响应结束后释放；不落地临时文件（除非实现明确使用临时文件并安全清理，当前为内存 Buffer）。

### 12.3 路径与 Markdown 注入

- 所有 ZIP 条目通过 `assertSafeZipPath`：拒绝绝对路径、盘符、`..`、反斜杠、控制字符、空段、`.` 段、结尾点/空格、Windows 保留名、重复路径、超长段、符号链接模式。
- 文件路径只由固定前缀 + 稳定 ID 组成；用户标题不进入路径。
- frontmatter 只含固定键与服务端值；用户文本只放正文代码块，不能注入 YAML。
- 用户正文用比最长反引号串更长的 fenced text 代码块包裹，不能提前闭合或插入新标题。
- 链接文字做 Markdown 转义、换行折叠；不生成原始 HTML；来源 URL 只作为文本，不自动变成可点击 HTML。
- 所有包内链接目标必须是白名单条目；不允许链接到包外或未包含记录。
- ZIP 文件名 UTF-8，bit 11 标志；解压后不产生路径穿越。

## 13. 与 JSON 导出、SQLite 备份的关系

| 能力 | 主题 Markdown ZIP | `GET /api/export` JSON | 整库 SQLite 备份 |
| --- | --- | --- | --- |
| 范围 | 单个主题 + 勾选的一跳依据 | 全库业务数据 | 整个数据库文件 |
| 格式 | Markdown + `manifest.json` | JSON `schemaVersion: 7` | SQLite 二进制 |
| 主要用途 | 阅读、归档、放进 Obsidian | 程序读取/外部处理 | 灾难恢复/迁移 |
| 可导入 | 否（单向） | 否（当前无导入） | 是（替换数据库 + 启动迁移） |
| 是否含主题 | 是（索引 + 记录） | 是（`data.topics`、`data.topicMembers`） | 是（所有表） |
| 是否含问答/密钥 | 否 | 否（`record_queries`、`ai_settings` 不导出） | 数据库内加密配置随库；主密钥单独文件 |
| 快照时点 | 导出时 | 导出时 | 备份时 |
| 版本 | `manifest.formatVersion=1` | `schemaVersion=7` | 迁移版本随库 |
| 删除传播 | 不传播；下载副本保留 | 不传播 | 恢复后以备份为准 |

- 本功能**不改变** JSON 导出：`schemaVersion` 仍为 7，`data.topics`/`data.topicMembers` 字段不变，不新增 Markdown 字段。
- 本功能**不改变** SQLite 备份/恢复：无新表、无新迁移；备份仍自动包含 `topics`/`topic_members`。
- Markdown ZIP 是派生视图，不是权威数据源；JSON/SQLite 才是完整数据。不要用 Markdown ZIP 还原数据库。
- 三者可以并存：用户可以用 JSON 做机器处理、SQLite 做恢复、Markdown 做阅读/外部笔记。

## 14. 限制与性能

| 限制 | 值 | 说明 |
| --- | --- | --- |
| `maxFiles` | 2000 | 含三个元数据文件；不含目录项。 |
| `maxAttempts` | 2000 | 含主题 attempts 与勾选 basis attempts。 |
| `maxBytes` | 20 MiB（20971520） | 最终 ZIP 字节数；预览 `estimatedBytes` 为未压缩估算。 |
| `maxBasisKeys` | 200 | 去重后请求上限；超过 400。 |

- 预览不截断：超限时仍返回完整 counts/files，让用户看到真实规模；`canExport=false`。
- 导出在内存中构建全部文件与 ZIP；数据量上限由 `maxBytes`/`maxFiles` 约束，未实现流式写出。
- `estimatedBytes` 是渲染后 UTF-8 字节数估算（含元数据，不含 ZIP 头/压缩开销），可能高于或低于最终 ZIP；最终 413 以实际字节数为准。
- 不压缩图片/附件（本功能不导出附件）；没有图片、PDF、录音等二进制资源。
- 没有全文索引/数据库分页；attempt 全量读取由主题成员范围限制。
- 本机单人、小数据量场景；未在上万条记录/超大主题上压测。

## 15. 实现注意点

- 快照只读事务：`buildExportSnapshot` 内的所有 SELECT 必须在同一事务中完成；渲染阶段不再读库。
- 稳定排序：成员、尝试、关系、候选、文件都要显式排序，避免 SQLite 行序变化导致 `scopeHash` 抖动。
- `scopeHash` 输入不包含 `generatedAt`/`estimatedBytes`/文件名时间戳；预览与导出必须使用同一构建函数。
- `manifest.json` 的 `files[]` 包含自身，但自身 `bytes`/`sha256` 为 `null`；其他条目计算真实 SHA-256。
- `Content-Disposition` 文件名使用完整 topicId 与本地时间；不要用标题做文件名。
- 错误映射：400/404/409/413 按契约；500 只给通用消息，不泄露堆栈/路径。
- 不产生 `operationId` 回执；导出没有幂等键，重复调用是允许的只读操作。
- 前端每次选项变化都重新 preview；只使用最新 `scopeHash` 导出；409 后重新预览。
- 测试脚本不得写主库；使用隔离数据库/端口，结束后清理（以实际脚本为准）。

## 16. 测试与未验证状态

- **API 验收**：`scripts/test_topic_export.py` 在隔离库自启动服务，**49 passed, 0 failed**。覆盖预览计数/文件清单/`scopeHash`/409/413/404/400；单实体单文件；所有生成链接目标存在；标题改名路径稳定；默认不含另一主题；一跳依据只追加本身；不递归；删除来源占位；当前结果/历史快照标注；60 条 attempts 完整导出；特殊标题路径安全；导出失败不改业务数据；原有 JSON 导出仍可用；未配置模型仍可导出。
- **浏览器验收**：`scripts/e2e_topic_export.mjs` **12 passed, 0 failed**（Chrome 1280×900 / 390×844，预览、文件清单、勾选依据、桌面与手机下载、无外部请求）；前端组件隔离检查 **29/29**（含 400 invalidKeys 清理、409 自动重预览、413 提示、Esc 焦点恢复）。
- **Obsidian 隔离仓库实测**：本机 Obsidian 1.12.7，独立 `--user-data-dir` 与 （原始输出未随仓库提供），未打开用户已有仓库。通过 CDP 确认 `主题索引.md` 打开；标准 Markdown 相对链接经 `openLinkText` 跳到记录文件；`backlink:open` 打开反向链接面板（记录文件显示 65 条反向链接）；`graph:open-local` 打开局部关系图并显示筛选/颜色组/外观/力度。截图见 （截图未随仓库提供）。
- **仍未验证**：Obsidian Mobile；阅读视图中直接点击链接 DOM（本次用 `openLinkText` 验证链接解析）；真实手机、Firefox、Safari；接近 2000 文件 / 20 MiB 上限的内存与耗时；并发导出压力测试；第三方 Markdown 工具（Typora、VS Code、Logseq 等）。

## 17. 已知边界与后续

- 导出是静态副本：之后在拾念中的修改/删除不会更新已下载文件；需要最新内容必须重新导出。
- 不提供导入/同步/增量更新/Obsidian 插件；不写 vault、不建立双向链接。
- 不导出日程、研究、回顾、AI 生成、问答历史、附件/图片、设置/密钥。
- 不递归关系；不把同主题当作边；不自动补全主题外记录。
- 已删除来源只保留占位，不恢复正文；这是有意的隐私/一致性边界。
- `scopeHash` 是乐观并发校验，不是内容签名/权限令牌；`manifest.files[].sha256` 才是文件级校验。
- 若后续要支持导入/同步，需要单独设计版本、冲突、ID 映射与删除语义，不能复用本 ZIP 直接回写。
