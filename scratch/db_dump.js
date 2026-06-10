import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('--- ALL VIDEOS IN DATABASE ---');
console.log(db.prepare('SELECT id, channel_id, original_filename, title FROM videos').all());

console.log('--- ALL CHANNELS IN DATABASE ---');
console.log(db.prepare('SELECT id, name, youtube_channel_id FROM channels').all());
