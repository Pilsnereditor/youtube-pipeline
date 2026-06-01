import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

const channelId = 2;
const userId = 1;

console.log('Running backend select video query...');
const video = db.prepare(`
  SELECT * FROM videos v 
  WHERE v.channel_id = @channelId AND v.user_id = @userId
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_posts sp 
      WHERE sp.video_id = v.id AND sp.status IN ('pending', 'processing', 'complete')
    )
  ORDER BY v.id ASC LIMIT 1
`).get({ channelId, userId });

console.log('Result video:', video);

db.close();
