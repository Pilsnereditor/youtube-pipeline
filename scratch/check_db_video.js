import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');

console.log('Opening database:', dbPath);
const db = new Database(dbPath);

const targetId = '41L6vOfkBBk';

console.log('\n--- Checking uploads table ---');
const uploads = db.prepare('SELECT * FROM uploads WHERE youtube_video_id = ?').all(targetId);
console.log(JSON.stringify(uploads, null, 2));

console.log('\n--- Checking scheduled_posts table ---');
const posts = db.prepare('SELECT * FROM scheduled_posts WHERE youtube_video_id = ? OR custom_comment LIKE ?').all(targetId, `%${targetId}%`);
console.log(JSON.stringify(posts, null, 2));

console.log('\n--- Checking all recent scheduled_posts ---');
const recentPosts = db.prepare('SELECT id, video_id, status, comment_status, custom_comment, youtube_video_id, comment_retry_count, comment_next_retry_at, error_message FROM scheduled_posts ORDER BY id DESC LIMIT 5').all();
console.log(JSON.stringify(recentPosts, null, 2));

db.close();
console.log('\nDone.');
