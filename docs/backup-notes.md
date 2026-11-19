# 备份与恢复说明（拾念 SHINIAN v0.1）

本轮补齐本地单机版的一致备份与恢复闭环：在线备份、备份校验、恢复到新库、演练与失败用例测试。
实现不引入新依赖，Node 侧复用项目已有的 `better-sqlite3`（SQLite 3.54.1，WAL 模式）。

> 2026-11-13 当前版本补充：数据库迁移已到 `0007_next_actions.sql`（attempts 增加下一步行动来源字段）。备份/恢复仍以 `captures`、`attempts`、`attempt_references`、`accounts`、`mutation_receipts` 为必需核心表；`stage_reviews`、`schedule_blocks` 存在时一并校验计数与 `foreign_key_check`，旧备份缺这两张表时恢复脚本不判损坏，启动后由迁移补建。恢复后下一步行动的 attempts 字段、来源引用与日程均随整库恢复。

## 1. 新增文件

| 文件 | 作用 |
| --- | --- |
| `scripts/backup.mjs` | 一致性备份命令。使用 SQLite Online Backup API（`better-sqlite3` 的 `db.backup()` / `sqlite3_backup_*`），服务运行中、WAL 有未 checkpoint 页时也可用。 |
| `scripts/restore.mjs` | 恢复命令。先校验备份（可打开、`integrity_check=ok`、核心表、`_migrations` 迁移记录），再通过 SQLite 备份 API 复制到**全新路径**，绝不覆盖已有文件。 |
| `scripts/test_backup_restore.py` | 完整演练脚本（复用 `scripts/common.py` 的 `Client` / `Checker`）。使用独立演练库与 3401/3402 端口，不接触主库与 3000/3100/3200/3400 端口。 |
| `.gitignore` | 新增 `backups/`，备份输出不进入版本库（保留原有内容）。 |

## 2. 命令

### 2.1 备份

```powershell
# 默认：db\shinian.sqlite → backups\shinian-backup-YYYYMMDD-HHmmss.sqlite
node scripts/backup.mjs

# 指定源库与输出目录
node scripts/backup.mjs --db "<repo>\db\shinian.sqlite" --out "<repo>\backups"
```

- 默认 `--db`：`<repo>\db\shinian.sqlite`
- 默认 `--out`：`<repo>\backups`
- 文件名：`shinian-backup-YYYYMMDD-HHmmss.sqlite`（本地时间）。同一秒内重复执行会生成 `-1`、`-2` 后缀；文件名以 `O_EXCL` 原子预留，**不会覆盖**已有文件。
- 成功时 **stdout 只有一行**：备份文件的绝对路径；过程信息写入 stderr。脚本用法：
  ```powershell
  $backup = node scripts/backup.mjs
  ```
- 失败（参数错误、源库不存在/不可打开、写入失败、校验失败）时：删除本次生成的备份及其 `-wal/-shm/-journal` 附属文件，向 stderr 输出明确错误，`exitCode=1`。
- 备份完成后自动做两步校验：只读打开备份 → `PRAGMA integrity_check` 必须为 `ok`；`sqlite_master` 中必须存在 `captures`、`attempts`、`attempt_references`、`accounts`、`mutation_receipts` 五张核心表。任一步失败即删除文件并退出非零。

实现要点：WAL 模式下先对源库开启只读事务并读取一页，固定住一致快照，再调用 `db.backup()`。否则持续写入会让 `sqlite3_backup` 反复重启；实测 44 MB 库在持续写入下从 31 秒降到约 0.5 秒。备份写入完成后 checkpoint 并切到 DELETE 日志模式，交付单文件快照（不携带 `-wal/-shm`），下次由应用启动时自动切回 WAL。

### 2.2 恢复

```powershell
# 恢复到默认新路径：db\restored-YYYYMMDD-HHmmss.sqlite
node scripts/restore.mjs --backup "<repo>\backups\shinian-backup-20260101-120000.sqlite"

# 恢复到指定新路径
node scripts/restore.mjs --backup "<repo>\backups\shinian-backup-20260101-120000.sqlite" --target "<repo>\db\restored-20260101.sqlite"
```

恢复前校验（任一失败即退出非零）：

1. 备份文件存在且是普通文件；
2. 能作为 SQLite 打开（垃圾文件会报 `file is not a database`）；
3. `PRAGMA integrity_check = ok`；
4. 五张核心业务表齐全；
5. `_migrations` 表存在，且至少有一条可识别迁移记录（匹配 `drizzle/migrations/*.sql` 文件名，或 `NNNN_*.sql` 形式）。

目标路径处理：

- `--target` 缺省时生成 `<repo>\db\restored-YYYYMMDD-HHmmss.sqlite`。
- **若目标已存在（含默认目标），立即报错，不打开、不覆盖、不修改目标**，并提示：
  「请换一个新路径，或先移动/删除已有文件后重试。」
- 目标用 `O_EXCL` 原子占位，避免并发创建时互相覆盖。

恢复过程使用 SQLite 备份 API（不是 `fs.copyFile`），因此不会忽略 WAL 中尚未合并的已提交页。写入后再次对目标执行 `integrity_check`、核心表检查和记录数比对；任何失败都会删除本次创建的半成品目标并退出非零。成功时 stdout 只有目标绝对路径，stderr 打印停机/启动顺序。

### 2.3 正确的停机与切换顺序

```text
1) 先停止所有正在使用目标数据库的服务（同一路径同一时刻只允许一个写入进程）。
2) 运行 restore.mjs 恢复到一个全新的目标路径（不要指向正在使用的库）。
3) 用新路径、新端口启动验证：
     PowerShell:
       $env:DATABASE_URL="<repo>\db\restored-20260101-120000.sqlite"
       $env:PORT="3001"
       npm run serve
     bash:
       DATABASE_URL="D:/联动日程表/db/restored-20260101-120000.sqlite" PORT=3001 npm run serve
4) 在 3001 端口检查记录、引用、归档与写入均正常后，再停旧服务并切换正式路径。
5) 不要用恢复文件直接覆盖旧库，也不要在旧服务仍写入时移动/删除旧库文件。
```

## 3. 完整演练

### 3.1 运行

```powershell
cd <repo>
python scripts/test_backup_restore.py
# 保留演练库与备份供人工检查：
$env:SHINIAN_KEEP_TEST_ARTIFACTS="1"; python scripts/test_backup_restore.py
```

脚本只使用：

- 源库：`db\backup-src.sqlite`
- 恢复库：`db\backup-restored.sqlite`
- 空库：`db\backup-empty-src.sqlite` / `db\backup-empty-restored.sqlite`
- 失败用例：`db\backup-target-exists.sqlite`、`db\backup-bad.sqlite`、`db\backup-schema-less.sqlite`
- 备份输出：`backups\_test_backup_restore_<时间戳>\`
- 端口：3401（源服务）、3402（恢复库/空库服务）

启动前会确认 3401/3402 未被占用；不会打开或写入 `db\shinian.sqlite`，也不会占用 3000/3100/3200/3400。

### 3.2 实际结果（2026-11-12）

```text
备份/恢复演练: 169 passed, 0 failed
```

覆盖与核对结果：

| 项目 | 结果 |
| --- | --- |
| 演练源库业务数据 | captures=2、attempts=2、attempt_references=1、accounts=1、mutation_receipts=3 |
| 在线备份（3401 服务运行、WAL 未 checkpoint） | 成功；`integrity_check=ok`；核心表与 3 条迁移记录齐全；69,632 字节 |
| 同秒重复备份 | 生成 `...-1.sqlite`，预置占位文件内容未被覆盖 |
| 恢复 | 成功恢复到 `db\backup-restored.sqlite`；与备份的五张业务表 + `_migrations` 逐行一致；69,632 字节 |
| 恢复库（3402） | 可登录、可读、可写、可搜索；原文、状态、结果、`observedAt=1700000000123`、归档状态均保持 |
| 引用 | 方向 B1→A1 正确；`snapshotResultText` 保持旧快照 v1；`snapshotRevision=2`；`updatedSinceSnapshot=true`；来源当前 `revision=3` |
| 恢复库继续使用 | 新建念头/尝试、引用旧结果、写结果、搜索均成功 |
| 缺失备份 / 缺少 `--backup` | 非零退出、明确报错、不创建目标 |
| 损坏备份（垃圾内容） | 非零退出、报「无法作为 SQLite 打开/校验失败」、不留下目标 |
| 目标已存在 | 非零退出、提示「请换一个新路径，或先移动/删除已有文件后重试」、原文件哈希不变、无 `-wal/-shm` |
| 空数据库备份 | 备份成功、无业务记录、可恢复；恢复后 API 返回空列表且可继续写入 |
| 失败后原库 | 仍可新建念头/尝试并读回 |
| 备份期间并发写入 | 1500 条批量数据 + 写入线程 17 次完整迭代；备份 37,031,936 字节、0.76s；`integrity_check=ok`、`foreign_key_check` 无错误、引用 from/to 全部存在；快照计数 captures=13/attempts=1521/references=10，位于备份前（10/1515/7）与备份后（21/1537/18）之间 |

> 快照是某一时刻的一致视图，因此备份记录数不一定等于备份结束后的实时记录数；上表同时验证了计数落在备份前/后区间内、外键与引用均无悬空。

### 3.3 失败情况清单

- 缺失备份文件：`--backup` 指向不存在的路径 → 退出 1。
- 损坏备份：写入 8 KB 非 SQLite 内容 → 退出 1。
- 目标已存在：目标内容保持不变，不产生附属文件 → 退出 1。
- 缺少核心表的合法 SQLite 文件 → 退出 1（额外覆盖）。
- 空数据库（仅迁移建表、无业务记录）→ 备份/恢复均成功，记录数为 0。

## 4. 已知限制

1. **只备份 SQLite 数据库**：v0.1 没有上传文件、图片或外部对象存储；若将来引入附件，需要另行纳入备份清单。
2. **不做自动轮转/保留策略**：每次生成独立文件，磁盘占用随次数增长；需要人工清理旧备份（`backups/` 已在 `.gitignore` 中）。
3. **备份需要约等于数据库大小的临时磁盘空间**：备份文件先写成完整快照，校验通过后才算成功；失败会清理本次文件。
4. **长读事务会推迟 WAL checkpoint**：备份期间源库 WAL 可能增长；备份完成后自动释放读事务。超大库建议在低写入时段执行，脚本不会阻塞正常读写。
5. **恢复是“恢复到新路径”而非原地替换**：为避免误覆盖，目标必须不存在；切换正式库需要停旧服务、改 `DATABASE_URL`/`PORT` 启动验证后再人工切换。
6. **默认恢复文件名精确到秒**：同一秒内生成同名默认目标会按“目标已存在”报错，需换路径或稍后重试；这是有意的防覆盖行为。
7. **迁移识别较严格**：`_migrations` 至少一条记录需匹配项目迁移文件名或 `NNNN_*.sql` 形式；手工改过迁移名的库可能被拒绝。备份校验本身只要求核心表，不要求 `_migrations`。
8. **完整性校验的边界**：`PRAGMA integrity_check` 能发现页级/索引结构错误，但不能证明业务语义完全正确；恢复演练（本文件第 3 节）才是最终验收手段。
9. **WAL 一致性依赖 SQLite 在线备份 API**：不要用 `copy`/`fs.copyFile` 只复制 `.sqlite` 主文件来替代本命令；服务运行且 WAL 未 checkpoint 时会丢已提交数据。
10. **平台**：脚本在 Windows + Node 24 + 项目自带 `better-sqlite3` 下实测；演练脚本用 `taskkill /T` 清理 tsx 派生的服务子进程，Linux/macOS 走 `terminate/kill` 分支但未在本机实测。
11. **未覆盖远程/多实例场景**：本机单人、单写入进程；若将来多进程写同一库，需要额外的协调与备份调度。

## 5. 退出码与输出约定

| 命令 | 成功 | 失败 |
| --- | --- | --- |
| `backup.mjs` | 0；stdout 一行绝对路径 | 1；stderr 明确错误；删除本次备份 |
| `restore.mjs` | 0；stdout 一行目标绝对路径 | 1；stderr 明确错误；删除本次创建的半成品目标 |
| `test_backup_restore.py` | 0（全部 PASS） | 1（存在 FAIL 或异常） |

备份/恢复命令都可直接用于脚本：

```powershell
$backup = node scripts/backup.mjs
if ($LASTEXITCODE -ne 0) { throw "备份失败" }
$restored = node scripts/restore.mjs --backup $backup --target "<repo>\db\restored-check.sqlite"
if ($LASTEXITCODE -ne 0) { throw "恢复失败" }
```
