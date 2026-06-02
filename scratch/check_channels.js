import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('\n=== Table: channels ===');
const channels = db.prepare(`SELECT * FROM channels`).all();
console.log(channels);

console.log('\n=== Table: settings ===');
const settings = db.prepare(`SELECT * FROM settings`).all();
console.log(settings);

db.close();
