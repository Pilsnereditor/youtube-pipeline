import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== All Schedule Presets ===');
const presets = db.prepare('SELECT * FROM schedule_presets').all();
console.log(presets);

console.log('\n=== Channel Details ===');
const channels = db.prepare('SELECT id, name, schedule_days, schedule_time, upload_mode FROM channels').all();
console.log(channels);

db.close();
