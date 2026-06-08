import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');

const db = new Database(dbPath);

console.log('\n--- Channels ---');
const channels = db.prepare('SELECT id, name, youtube_channel_id, upload_mode, profile_name, proxy_pool_id FROM channels').all();
console.log(JSON.stringify(channels, null, 2));

db.close();
