import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== Videos and their scheduled post references ===');
const rows = db.prepare(`
  SELECT v.id AS video_id, v.channel_id, sp.id AS post_id, sp.status AS post_status
  FROM videos v
  LEFT JOIN scheduled_posts sp ON sp.video_id = v.id
  WHERE v.channel_id = 2
`).all();
console.log(rows);

db.close();
