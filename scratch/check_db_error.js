import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');

const db = new Database(dbPath);

console.log('\n--- Checking post 99 error message ---');
const post = db.prepare('SELECT id, status, comment_status, youtube_video_id, error_message FROM scheduled_posts WHERE id = 99').get();
console.log(JSON.stringify(post, null, 2));

db.close();
