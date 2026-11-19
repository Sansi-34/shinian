# 拾念 SHINIAN v0.1 — JSON 导出实现与测试记录

日期：2026-11-12
范围：`GET /api/export` 全量 JSON 导出、首页导出按钮、自动化测试。未修改 `README.md`、`package.json`、备份/恢复脚本。

## 一、修改的文件

| 文件 | 修改内容 |
| --- | --- |
| `src/server/index.ts` | 新增 `GET /api/export`（沿用 `requireAuth`）与文件名辅助函数 `exportFileName()`。在单个 better-sqlite3 读事务中读取 `captures`、`attempts`、`attempt_references`，按 camelCase 字段输出；设置 UTF-8 JSON 下载响应头；异常时记录服务端日志并返回通用 JSON 错误。未改动任何既有路由。 |
| `src/client/api.ts` | 新增 `api.exportData()`：`fetch('/api/export')`，校验响应状态，读取 `Content-Disposition` 中的文件名，返回 `{ blob, filename }`。 |
| `src/client/pages/HomePage.tsx` | 首页搜索栏右侧新增「导出数据」按钮；使用 `fetch + blob + a[download]` 触发下载；导出中禁用按钮并显示「导出中…」；失败显示「导出失败，请重试」。 |
| `src/client/styles.css` | 新增 `.home-toolbar` / `.export-btn` 布局；≤420px 时搜索栏与导出按钮分两行、按钮占满宽度，390px 手机视口可正常使用。 |
| `scripts/test_export.py` | 新增自包含导出测试：独立临时库、独立端口、自行启动/停止服务，复用 `common.py` 的 `Client` / `Checker`。 |
| `docs/export-notes.md` | 本记录。 |

构建产物 `dist/client/` 已由 `vite build` 重新生成（非手写源码）。

## 二、接口行为

请求：

```http
GET /api/export
Cookie: shinian_sid=<accountId>
```

未登录：`401`，`{"error":"unauthenticated"}`。

成功响应头：

```http
Content-Type: application/json; charset=utf-8
Content-Disposition: attachment; filename="shinian-export-YYYYMMDD-HHmmss.json"
Cache-Control: no-store
```

响应体结构：

```json
{
  "schemaVersion": 1,
  "appVersion": "0.1.0",
  "exportedAt": "2026-11-12T15:25:17.123Z",
  "data": {
    "captures": [
      {
        "id": "cap-...",
        "rawText": "...",
        "revision": 1,
        "createdAt": 1762900000000,
        "updatedAt": 1762900000000,
        "archivedAt": null
      }
    ],
    "attempts": [
      {
        "id": "att-...",
        "captureId": "cap-...",
        "step": "...",
        "state": "done",
        "resultText": "...",
        "outcome": "success",
        "sourceUrl": null,
        "observedAt": 1762900000000,
        "revision": 2,
        "createdAt": 1762900000000,
        "updatedAt": 1762900000000
      }
    ],
    "attemptReferences": [
      {
        "id": "ref-...",
        "fromAttemptId": "att-A",
        "toAttemptId": "att-B",
        "revision": 1,
        "note": "...",
        "snapshotResultText": "...",
        "snapshotRevision": 1,
        "createdAt": 1762900000000
      }
    ]
  }
}
```

实现要点：

- 三张业务表在同一个 `sqlite.transaction(() => { ... })()` 读事务内依次 `SELECT`，在 WAL 模式下获得一致快照，避免跨表读取期间被写入打断。
- 只导出上述三张表；`accounts`、`mutation_receipts`、`source_links`、`_migrations` 不进入导出对象。
- 稳定 ID 原样导出；时间戳沿用数据库中的 Unix 毫秒数（`exportedAt` 除外，为 ISO 8601）。
- 导出异常统一返回 `{"error":"导出失败，请稍后重试"}`（500），不向前端暴露 SQLite/堆栈细节；详细错误只写服务端日志。

## 三、测试命令与结果

### 1. 导出功能自动化测试（新增）

```powershell
cd <repo>
python scripts/test_export.py

# 可选：自定义 base（脚本会从 base 推导端口并继续自行启动/停止该端口的服务）
$env:SHINIAN_BASE="http://127.0.0.1:3500"; python scripts/test_export.py
```

实际结果：**55 passed, 0 failed**，退出码 `0`（默认 3400 与自定义 3500 各跑过一次，均为 55/0）。

测试脚本行为：

- 默认 `PORT=3400`、`DATABASE_URL=<repo>\db\export-test.sqlite`，启动前删除旧测试库；测试成功结束后清理测试库与日志，失败时保留以便排查。
- 自行用 `node node_modules/tsx/dist/cli.mjs src/server/index.ts` 启动/停止服务；Windows 下按进程树结束，确保端口与 SQLite 句柄释放。
- 拒绝使用 `3000 / 3100 / 3200`，不会触碰主服务或既有测试服务。
- 支持 `SHINIAN_BASE`（端口从 base 推导，仅本机 http）与 `SHINIAN_EXPORT_TEST_DB` 覆盖。
- 覆盖并通过：
  - 未登录导出 `401`，错误 JSON 可理解、不含内部细节；
  - 空库导出：三个数组为空，`schemaVersion=1`、`appVersion=0.1.0`、`exportedAt` 为带时区 ISO 字符串；
  - 中文、换行、双/单引号、反斜杠、制表、emoji、`<script>` 完整往返；
  - 归档记录 `archivedAt` 为非空整数，未归档为 `null`；
  - 跨念头尝试引用：`fromAttemptId` / `toAttemptId` / `note` / `snapshotResultText` / `snapshotRevision` 正确；来源编辑后导出中的旧快照不变、最新结果已更新；
  - 导出 JSON 字符串不含账号用户名、创建尝试/引用的操作 ID、会话 Cookie 值/名称、回执字段与内部表名；
  - `Content-Type` 含 `application/json` 与 `charset=utf-8`，`Content-Disposition` 含 `attachment` 且文件名符合 `shinian-export-YYYYMMDD-HHmmss.json`；
  - 导出后原库仍可读、可写，新增记录可再次导出读到；
  - 导出视图自洽：每个 `attempt.captureId`、每条引用的两端 ID 都能在导出数组中找到。

### 2. 前端与类型检查

```powershell
cd <repo>
node_modules\.bin\tsc.cmd --noEmit
node_modules\.bin\vite.cmd build
```

实际结果：`tsc --noEmit` 通过（无输出）；`vite build` 成功（48 modules，输出 `dist/client`）。仅有既有的 react-router `"use client"` 指令提示与 chunk >500 kB 提示，均为构建工具警告，不是失败。

额外用真实 Chrome 无头模式在 390×844 视口做了人工脚本核对（未作为仓库测试保留）：

- 「导出数据」按钮可见，尺寸约 366×40，位于搜索栏下方独立一行；
- 点击后实际下载 `shinian-export-20261112-232517.json`，解析后 `schemaVersion=1`、`appVersion=0.1.0`、包含新增的测试记录；
- 模拟 `/api/export` 返回 500 时，页面显示「导出失败，请重试」。

### 3. 既有回归测试

```powershell
$env:PYTHONIOENCODING='utf-8'; python scripts/run_tests.py
```

实际结果：**99 passed, 0 failed**（主流程 43 + 搜索 31 + 一致性 23 + 重启持久化 2），退出码 `0`。

补充：不设置 `PYTHONIOENCODING` 时，该既有测试编排在最后打印 `✓` 会因 Windows GBK 控制台编码抛 `UnicodeEncodeError`（所有断言本身均已通过，这是原有的输出编码问题，与本次导出改动无关）。

## 四、已知限制

- 导出为一次性内存快照：所有数据先读入内存再 `JSON.stringify`。本应用是本机单人小数据量，当前足够；数据量很大时内存占用会线性增长，未做流式/分页导出。
- 导出的时间戳是 Unix 毫秒整数（与库内一致），不是 ISO 字符串；除 `exportedAt` 外，使用方需自行转换。这是为了保持原值、避免时区与精度损失。
- 导出文件是明文 UTF-8，包含全部念头/尝试/结果文本与来源 URL；没有加密、口令保护或完整性签名，用户需自行妥善保存。
- 仅导出三张业务表，账号、操作回执、迁移记录、预留的 `source_links` 按设计排除；因此导出文件不能直接还原登录账号（本轮也没有导入/恢复功能）。
- 导出接口是只读 GET，未新增 CSRF 防护；仍依赖会话 Cookie 的 `SameSite=Lax` 与 `httpOnly`。跨站顶层导航理论上可触发浏览器下载，但不会泄露给第三方脚本。
- 前端下载使用 `fetch + blob + a[download]`，依赖现代浏览器；未在 Firefox/Safari 实机验证，也未在真实手机设备上验证（仅 Chrome 无头 390×844）。
- “一致数据视图”由读事务保证，测试覆盖了导出结果的自洽性，但未专门构造“导出进行中同时写入”的高并发压力测试；better-sqlite3 同步 API 在单进程内本身串行执行。
- `scripts/test_export.py` 会删除并重建 `db/export-test.sqlite`；不要把它指向需要保留的数据库。日志在失败时保留为 `db/export-test-server.log` 以便排查，成功时清理。
- 本次未实现导入、备份/恢复、导出格式版本迁移；`schemaVersion` 目前固定为 `1`，后续字段变化时需要迁移策略。

## 五、遗留问题

- 无阻塞性遗留问题；导出功能与针对 3400 独立服务的测试均通过。
- 按要求未重启 3000 端口的主服务：当前 3000 进程仍是改动前的后端代码，`/api/export` 需在允许的重启窗口重启一次 `npm run serve` 后才会生效（前端 `dist/client` 已重新构建）。
- 后续可考虑：导出时提供“仅未归档/包含已归档”选项、增加导入与校验、对大库改为流式写出、为导出文件增加校验和。
