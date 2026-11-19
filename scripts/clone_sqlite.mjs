// 复制 SQLite 测试库（会包含 WAL 中已提交的数据）。
// 用法：node scripts/clone_sqlite.mjs <源库> <目标库>
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('用法：node scripts/clone_sqlite.mjs <源库> <目标库>');
  process.exit(1);
}
const target = path.resolve(dest);
if (fs.existsSync(target)) {
  console.error('目标已存在，请先确认并移走：' + target);
  process.exit(1);
}
const db = new Database(path.resolve(src), { readonly: true });
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();
console.log('cloned', target);
