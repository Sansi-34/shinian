#!/usr/bin/env node
/**
 * 拾念 SHINIAN v0.1 —— 从一致性备份恢复到新数据库
 *
 * 用法：
 *   node scripts/restore.mjs --backup <备份文件> [--target <目标数据库路径>]
 *
 * 默认目标：<repo>\db\restored-YYYYMMDD-HHmmss.sqlite（精确到秒；绝不覆盖已有文件）
 *
 * 行为：
 * 1. 校验备份：存在、可作为 SQLite 打开、PRAGMA integrity_check=ok、核心业务表齐全、
 *    _migrations 表存在且至少含一条可识别的迁移记录。
 * 2. 目标已存在时直接报错，不覆盖、不修改目标（提示换新路径或先移动/删除）。
 * 3. 用 SQLite 备份 API（better-sqlite3 db.backup）把备份复制到目标，而不是 fs.copyFile，
 *    以免忽略 WAL 一致性；完成后对目标再跑 integrity_check 与核心表检查。
 * 4. 成功时 stdout 只输出目标绝对路径；停机/启动说明写 stderr。
 *
 * 恢复流程（重要）：
 *   先停止所有正在使用目标数据库的服务 → 执行本命令恢复到新路径 →
 *   用 DATABASE_URL=新路径 PORT=新端口 启动服务验证，确认无误后再切换正式库。
 *
 * 退出码：0 成功；1 参数/校验/恢复失败。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET_DIR = path.join(ROOT, 'db');
const MIGRATIONS_DIR = path.join(ROOT, 'drizzle', 'migrations');
const CORE_TABLES = ['captures', 'attempts', 'attempt_references', 'accounts', 'mutation_receipts'];
/**
 * 后续迭代新增的表：备份中存在时校验并纳入恢复前后计数比对；
 * 旧备份缺失时不判损坏，恢复后由启动迁移补建。
 */
const OPTIONAL_TABLES = ['stage_reviews', 'schedule_blocks'];

function usage() {
  console.error(
    [
      '用法: node scripts/restore.mjs --backup <备份文件> [--target <目标数据库路径>]',
      `  --backup  必填，例如 ${path.join(ROOT, 'backups', 'shinian-backup-20260101-120000.sqlite')}`,
      `  --target  可选，默认 ${path.join(DEFAULT_TARGET_DIR, 'restored-YYYYMMDD-HHmmss.sqlite')}`,
      '',
      '恢复前请先停止使用目标数据库的服务；恢复到新路径后，用',
      '  DATABASE_URL=<新路径> PORT=<新端口> npm run serve',
      '启动验证，不要直接覆盖正在使用的数据库文件。',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (!['--backup', '--target'].includes(key)) throw new Error(`未知参数: ${key}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${key} 缺少值`);
      i += 1;
    }
    if (!value) throw new Error(`${key} 不能为空`);
    opts[key.slice(2)] = value;
  }
  return opts;
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 项目内已知迁移文件名；用于判断 _migrations 记录是否“可识别” */
function knownMigrationNames() {
  try {
    return new Set(
      fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    );
  } catch {
    return new Set();
  }
}

/**
 * 备份库是 WAL 快照，复制到目标后 journal_mode 仍为 WAL；恢复出的新库若立即被只读检查，
 * 会留下 -wal/-shm。这里 checkpoint 后切到 DELETE，交付单文件新库（应用启动时会再切回 WAL）。
 */
function normalizeToSingleFile(filePath) {
  let db;
  try {
    db = new Database(filePath);
    db.pragma('journal_mode = DELETE', { simple: true });
  } finally {
    if (db) db.close();
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(filePath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 只读检查数据库。返回：
 * { ok, reason, tables, migrationNames, counts }
 * requireMigrations：备份侧必须校验；目标侧复用同样规则。
 */
function inspectDatabase(filePath, requireMigrations) {
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, reason: `PRAGMA integrity_check 返回 ${JSON.stringify(integrity)}` };
    }

    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = CORE_TABLES.filter((name) => !tables.has(name));
    if (missing.length > 0) {
      return { ok: false, reason: `缺少核心业务表: ${missing.join(', ')}` };
    }

    let migrationNames = [];
    if (requireMigrations) {
      if (!tables.has('_migrations')) {
        return { ok: false, reason: '缺少 _migrations 表（无法确认迁移版本）' };
      }
      migrationNames = db
        .prepare('SELECT name FROM _migrations ORDER BY name')
        .all()
        .map((r) => String(r.name));
      if (migrationNames.length === 0) {
        return { ok: false, reason: '_migrations 表没有迁移记录' };
      }
      const known = knownMigrationNames();
      const recognized = migrationNames.filter(
        (name) => known.has(name) || /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)
      );
      if (recognized.length === 0) {
        return {
          ok: false,
          reason: `_migrations 中没有可识别的迁移记录: ${migrationNames.join(', ')}`,
        };
      }
    }

    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
    const counts = {
      captures: count('captures'),
      attempts: count('attempts'),
      attempt_references: count('attempt_references'),
      accounts: count('accounts'),
      mutation_receipts: count('mutation_receipts'),
      migrations: tables.has('_migrations')
        ? Number(db.prepare('SELECT COUNT(*) AS c FROM _migrations').get().c)
        : 0,
    };
    for (const name of OPTIONAL_TABLES) {
      counts[name] = tables.has(name) ? count(name) : null;
    }

    return { ok: true, tables, migrationNames, counts };
  } catch (err) {
    return {
      ok: false,
      reason: `无法作为 SQLite 打开或读取失败: ${err && err.message ? err.message : String(err)}`,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.backup) {
    usage();
    throw new Error('--backup 必填');
  }

  const backupPath = path.resolve(opts.backup);
  const targetPath = opts.target
    ? path.resolve(opts.target)
    : path.join(DEFAULT_TARGET_DIR, `restored-${timestamp()}.sqlite`);

  let backupStat;
  try {
    backupStat = fs.statSync(backupPath);
  } catch {
    throw new Error(`备份文件不存在: ${backupPath}`);
  }
  if (!backupStat.isFile()) throw new Error(`备份路径不是文件: ${backupPath}`);

  // 目标已存在：明确拒绝，不覆盖、不修改。先于任何写入检查。
  if (fs.existsSync(targetPath)) {
    throw new Error(
      `目标文件已存在，拒绝覆盖: ${targetPath}\n` +
        '请换一个新路径，或先移动/删除已有文件后重试。'
    );
  }
  if (path.resolve(targetPath) === backupPath) {
    throw new Error('目标路径不能与备份文件相同，请换一个新路径');
  }

  const check = inspectDatabase(backupPath, true);
  if (!check.ok) throw new Error(`备份文件校验失败: ${check.reason}`);
  console.error(
    `[restore] 备份校验通过: integrity_check=ok，核心表齐全，迁移 ${check.counts.migrations} 条` +
      `（captures=${check.counts.captures}, attempts=${check.counts.attempts}, ` +
      `references=${check.counts.attempt_references}` +
      `, schedules=${check.counts.schedule_blocks ?? '旧备份无此表'}` +
      `, reviews=${check.counts.stage_reviews ?? '旧备份无此表'}）`
  );

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // 用 O_EXCL 原子占位，确保即使并发也不会覆盖他人刚创建的文件。
  let fd;
  try {
    fd = fs.openSync(targetPath, 'wx');
    fs.closeSync(fd);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error(
        `目标文件已存在，拒绝覆盖: ${targetPath}\n` +
          '请换一个新路径，或先移动/删除已有文件后重试。'
      );
    }
    throw new Error(`无法创建目标文件: ${targetPath} (${err.message})`);
  }

  let source;
  try {
    source = new Database(backupPath, { readonly: true, fileMustExist: true });
    // SQLite 在线备份 API：从只读备份库复制到目标（0 字节占位文件会被写入完整快照）
    const result = await source.backup(targetPath);
    console.error(`[restore] 已通过 sqlite3_backup 写入 ${result.totalPages} 页到目标`);

    normalizeToSingleFile(targetPath);

    const targetCheck = inspectDatabase(targetPath, true);
    if (!targetCheck.ok) throw new Error(`目标数据库复核失败: ${targetCheck.reason}`);
    if (targetCheck.counts.migrations !== check.counts.migrations) {
      throw new Error(
        `目标迁移记录数不一致: 备份 ${check.counts.migrations}，目标 ${targetCheck.counts.migrations}`
      );
    }
    if (
      targetCheck.counts.captures !== check.counts.captures ||
      targetCheck.counts.attempts !== check.counts.attempts ||
      targetCheck.counts.attempt_references !== check.counts.attempt_references
    ) {
      throw new Error('目标记录数与备份不一致，恢复结果不可信');
    }
    for (const name of OPTIONAL_TABLES) {
      if (check.counts[name] !== null && targetCheck.counts[name] !== check.counts[name]) {
        throw new Error(`目标 ${name} 记录数与备份不一致: 备份 ${check.counts[name]}，目标 ${targetCheck.counts[name]}`);
      }
    }
    console.error(
      `[restore] 目标复核通过: integrity_check=ok，核心表齐全，` +
        `captures=${targetCheck.counts.captures}, attempts=${targetCheck.counts.attempts}, ` +
        `references=${targetCheck.counts.attempt_references}` +
        `, schedules=${targetCheck.counts.schedule_blocks ?? '旧备份无此表（启动后迁移建表）'}` +
        `, reviews=${targetCheck.counts.stage_reviews ?? '旧备份无此表（启动后迁移建表）'}`
    );

    process.stdout.write(`${targetPath}\n`);

    console.error(
      [
        '',
        '[restore] 使用说明（停机顺序）：',
        '  1) 恢复前已确认目标路径原本不存在；现在目标是一个独立的新库，原库未被修改。',
        `  2) 若要把目标作为正式库：先停止正在使用该路径的所有服务（本项目同一时刻只应有一个写入进程）。`,
        `  3) 用新路径、新端口启动验证：`,
        `       PowerShell: $env:DATABASE_URL="${targetPath}"; $env:PORT="3001"; npm run serve`,
        `       bash:       DATABASE_URL="${targetPath}" PORT=3001 npm run serve`,
        '  4) 验证数据无误后再停旧服务并切换；不要在旧服务仍写入时覆盖原库文件。',
      ].join('\n')
    );
  } catch (err) {
    // 目标由本次创建（此前不存在），失败时清理半成品，避免被误当成可用库。
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(targetPath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    if (source) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error(`[restore] 错误: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
