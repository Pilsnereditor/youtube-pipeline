import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== Videos user_id analysis ===');
const rows = db.prepare('SELECT id, channel_id, filepath, user_id FROM videos').all();
console.log(rows);

console.log('\n=== Channels user_id analysis ===');
const channels = db.prepare('SELECT id, name, user_id FROM channels').all();
console.log(channels);

db.close();
