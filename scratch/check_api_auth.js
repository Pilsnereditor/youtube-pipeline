import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('\n=== Table: oauth_tokens ===');
const rows = db.prepare(`SELECT channel_id FROM oauth_tokens`).all();
console.log(rows);

db.close();
