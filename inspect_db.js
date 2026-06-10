import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== CHANNELS ===');
console.log(db.prepare('SELECT * FROM channels').all());

console.log('\n=== VIDEOS ===');
const videos = db.prepare('SELECT id, channel_id, original_filename, created_at FROM videos').all();
console.log(videos);

console.log('\n=== SCHEDULED POSTS ===');
const posts = db.prepare('SELECT id, channel_id, video_id, youtube_video_id, status, scheduled_at, created_at FROM scheduled_posts').all();
console.log(posts);

db.close();
