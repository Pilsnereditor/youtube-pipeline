import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== Channels ===');
const channels = db.prepare('SELECT id, name, upload_mode FROM channels').all();
console.log(channels);

for (const ch of channels) {
  console.log(`\n=== Channel: ${ch.name} (ID: ${ch.id}) ===`);
  const totalVideos = db.prepare('SELECT COUNT(*) as count FROM videos WHERE channel_id = ?').get(ch.id).count;
  const unscheduledVideos = db.prepare(`
    SELECT COUNT(*) as count FROM videos v 
    WHERE v.channel_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_posts sp 
        WHERE sp.video_id = v.id AND sp.status IN ('pending', 'processing', 'complete')
      )
  `).get(ch.id).count;

  const scheduledPending = db.prepare("SELECT COUNT(*) as count FROM scheduled_posts WHERE channel_id = ? AND status = 'pending'").get(ch.id).count;
  const scheduledComplete = db.prepare("SELECT COUNT(*) as count FROM scheduled_posts WHERE channel_id = ? AND status = 'complete'").get(ch.id).count;

  console.log(`- Total videos in library: ${totalVideos}`);
  console.log(`- Unscheduled video stock (unused): ${unscheduledVideos}`);
  console.log(`- Pending scheduled posts: ${scheduledPending}`);
  console.log(`- Completed scheduled posts: ${scheduledComplete}`);
}

db.close();
