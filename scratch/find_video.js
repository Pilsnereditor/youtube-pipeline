import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('Searching all tables for rVZQ1lFqE3Q...');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (const table of tables) {
  const pragma = db.prepare(`PRAGMA table_info(${table.name})`).all();
  for (const col of pragma) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table.name} WHERE CAST(${col.name} AS TEXT) LIKE '%rVZQ1lFqE3Q%'`).all();
      if (rows.length > 0) {
        console.log(`Found in table ${table.name}, column ${col.name}:`, rows);
      }
    } catch (e) {
      // ignore check constraint or other issues
    }
  }
}
