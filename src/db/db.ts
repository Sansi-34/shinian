import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据库默认落地：项目 db/shinian.sqlite（可用 DATABASE_URL 覆盖）
const dbPath =
  process.env.DATABASE_URL ?? path.resolve(__dirname, '../../db/shinian.sqlite');
const sqlite = new Database(dbPath);

// 外键与 WAL
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('journal_mode = WAL');

// ---- 简单迁移执行器：按文件顺序执行，已执行的记录在 _migrations 表 ----
// 迁移文件位于项目 drizzle/migrations/*.sql，可重复执行（已应用则跳过）
const migrationsDir = path.resolve(__dirname, '../../drizzle/migrations');

function runMigrations() {
  if (!fs.existsSync(migrationsDir)) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name as string)
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    const tx = sqlite.transaction(() => {
      for (const stmt of statements) sqlite.exec(stmt);
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
    });
    tx();
    console.log(`[migration] applied ${file}`);
  }
}

runMigrations();

export const db = drizzle(sqlite);
export { sqlite };