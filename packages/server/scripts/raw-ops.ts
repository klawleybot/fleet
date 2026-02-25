import Database from "better-sqlite3";

const dbPath = process.env.SQLITE_PATH!;
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT * FROM operations ORDER BY id DESC LIMIT 5").all();
for (const r of rows) console.log(JSON.stringify(r));
db.close();
