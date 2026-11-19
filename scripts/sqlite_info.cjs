const Database = require('better-sqlite3');
const db = new Database('db/shinian.sqlite', { readonly: true });
console.log('SQLite', db.prepare('select sqlite_version() as v').get().v);
console.log('journal_mode', db.pragma('journal_mode', { simple: true }));
console.log('foreign_keys', db.pragma('foreign_keys', { simple: true }));
console.log(
  'tables',
  db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name)
);
