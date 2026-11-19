#!/usr/bin/env node
/**
 * 拾念 SHINIAN v0.1 —— 一致性备份命令
 *
 * 用法：
 *   node scripts/backup.mjs [--db <数据库路径>] [--out <输出目录>]
 *
 * 默认：
 *   --db  <repo>\db\shinian.sqlite
 *   --out <repo>\backups
 *
 * 特性：
 * - 使用 better-sqlite3 的在线备份 API（SQLite Online Backup，内部为 sqlite3_backup_*），
 *   服务运行中、WAL 有未 checkpoint 页时也能得到一致快照；不复制 -wal/-shm 文件。
 * - 文件名 shinian-backup-YYYYMMDD-HHmmss.sqlite（本地时间），同秒冲突追加 -1/-2；
 *   以 O_EXCL 预留文件名，绝不覆盖已有文件。
 * - 备份完成后只读打开、PRAGMA integrity_check 必须为 ok，并检查核心表；
 *   任一步失败都会删除本次生成的备份文件并以非零状态退出。
 * - 成功时 stdout 只输出备份文件绝对路径；过程信息写 stderr。
 *
 * 退出码：0 成功；1 参数/备份/校验失败。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(ROOT, 'db', 'shinian.sqlite');
const DEFAULT_OUT = path.join(ROOT, 'backups');
const CORE_TABLES = ['captures', 'attempts', 'attempt_references', 'accounts', 'mutation_receipts'];
/**
 * 后续迭代新增的表：存在时校验并统计行数，缺失时只提示不判损坏。
 * 这样从旧版本（0000–0005）数据库直接做的备份不会被误判为损坏；
 * 恢复后由启动迁移补建新表（stage_reviews / schedule_blocks）。
 */
const OPTIONAL_TABLES = [
  'stage_reviews',
  'schedule_blocks',
  'research_runs',
  'research_sources',
  'record_queries',
  'experience_notes',
  'experience_sources',
  'experience_attempts',
  'topics',
  'topic_members',
];

function fail(message) {
  console.error(`[backup] 错误: ${message}`);
  process.exitCode = 1;
}

function usage() {
  console.error(
    [
      '用法: node scripts/backup.mjs [--db <数据库路径>] [--out <输出目录>]',
      `  --db   默认 ${DEFAULT_DB}`,
      `  --out  默认 ${DEFAULT_OUT}`,
    ].join('\n')
  );
}

/** 解析 --key value / --key=value，拒绝未知参数与缺失值 */
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
    if (!['--db', '--out'].includes(key)) throw new Error(`未知参数: ${key}`);
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

/** 本地时间 YYYYMMDD-HHmmss */
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 以 O_EXCL 原子预留一个不存在的文件名；返回 { path, fd }。
 * 同秒冲突时依次尝试 -1、-2 ……，绝不覆盖已有文件。
 */
function reserveDestination(outDir) {
  const base = `shinian-backup-${timestamp()}`;
  for (let i = 0; i <= 9999; i += 1) {
    const candidate = path.join(outDir, i === 0 ? `${base}.sqlite` : `${base}-${i}.sqlite`);
    try {
      const fd = fs.openSync(candidate, 'wx');
      return { path: candidate, fd };
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('同一秒内备份文件过多，无法生成唯一文件名');
}

/**
 * 备份目标会继承源库的 journal_mode（WAL），直接只读打开会留下 -wal/-shm 附属文件。
 * 备份是一次性快照，这里 checkpoint 后切到 DELETE 模式，交付单文件、可直接拷贝的备份。
 * 切换只改文件头日志模式，不改任何业务页；随后仍会重新做 integrity_check。
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

/** 只读检查：integrity_check + 核心表 + 可选的后续迭代表 */
function verifyDatabase(filePath) {
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, reason: `integrity_check 返回 ${JSON.stringify(integrity)}` };
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = CORE_TABLES.filter((name) => !tables.has(name));
    if (missing.length > 0) {
      return { ok: false, reason: `缺少核心表: ${missing.join(', ')}` };
    }
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length > 0) {
      return { ok: false, reason: `foreign_key_check 发现 ${fkErrors.length} 条外键错误` };
    }
    const counts = {};
    const missingOptional = [];
    for (const name of OPTIONAL_TABLES) {
      if (tables.has(name)) {
        counts[name] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c);
      } else {
        missingOptional.push(name);
      }
    }
    return { ok: true, counts, missingOptional };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
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

  const dbPath = path.resolve(opts.db ?? DEFAULT_DB);
  const outDir = path.resolve(opts.out ?? DEFAULT_OUT);

  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    throw new Error(`数据库文件不存在: ${dbPath}`);
  }
  if (!stat.isFile()) throw new Error(`数据库路径不是文件: ${dbPath}`);

  fs.mkdirSync(outDir, { recursive: true });

  // 先确认源文件是 SQLite（只读打开，不写源库）
  let source;
  let snapshotOpen = false;
  try {
    source = new Database(dbPath, { readonly: true, fileMustExist: true });
    source.pragma('schema_version', { simple: true }); // 触发文件头校验
  } catch (err) {
    if (source) source.close();
    throw new Error(`无法作为 SQLite 打开源数据库: ${dbPath} (${err.message})`);
  }

  const reserved = reserveDestination(outDir);
  const destPath = reserved.path;
  fs.closeSync(reserved.fd); // SQLite 会以读写方式打开这个 0 字节文件并写入快照

  try {
    // 关键：在 WAL 模式下显式开启一个只读事务并先读一页，固定住快照。
    // 否则 sqlite3_backup 会把“其它连接写入”视为源库变化并反复重启，
    // 持续写入时备份可能长时间无法收敛（实测 44MB 库从 31s 降到 0.5s）。
    source.exec('BEGIN');
    snapshotOpen = true;
    source.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    console.error('[backup] 已固定只读快照（WAL read transaction），开始在线备份');

    const result = await source.backup(destPath);
    source.exec('COMMIT');
    snapshotOpen = false;
    console.error(
      `[backup] 快照写入完成: ${destPath}（${result.totalPages} 页，` +
        `${fs.statSync(destPath).size} 字节）：sqlite3_backup 一致性快照`
    );

    normalizeToSingleFile(destPath);

    const check = verifyDatabase(destPath);
    if (!check.ok) throw new Error(`备份校验失败: ${check.reason}`);
    const countText = Object.entries(check.counts ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    console.error(
      `[backup] 校验通过: integrity_check=ok，核心表齐全，foreign_key_check 无错误` +
        (countText ? `（${countText}）` : '')
    );
    if (check.missingOptional && check.missingOptional.length > 0) {
      console.error(
        `[backup] 提示: 备份来自旧版本，未包含 ${check.missingOptional.join('、')}；` +
          '这不视为损坏，恢复后启动服务时会按迁移自动建表。'
      );
    }
    const masterKeyPath = process.env.SHINIAN_MASTER_KEY_FILE
      ? path.resolve(process.env.SHINIAN_MASTER_KEY_FILE)
      : path.join(ROOT, 'db', 'master.key');
    if (fs.existsSync(masterKeyPath)) {
      console.error(
        `[backup] 注意：AI 配置的主密钥不在数据库内，请同时单独备份 ${masterKeyPath}；` +
          '恢复数据库时需使用同一个主密钥，否则已保存的 API Key 无法解密。'
      );
    }

    // stdout 仅输出绝对路径，便于脚本直接消费
    process.stdout.write(`${destPath}\n`);
  } catch (err) {
    // 本次创建的文件必须清理，避免留下不可用备份被误用
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(destPath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    if (source) {
      if (snapshotOpen) {
        try {
          source.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
