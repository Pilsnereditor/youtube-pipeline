import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== Target Scheduled Posts ===');
const posts = db.prepare('SELECT id, channel_id, title, scheduled_at, youtube_video_id, status FROM scheduled_posts WHERE id BETWEEN 65 AND 69').all();
console.log(posts);

db.close();
