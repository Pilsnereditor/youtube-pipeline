import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('=== All Scheduled Posts ===');
const posts = db.prepare(`
  SELECT sp.id, sp.channel_id, c.name AS channel_name, sp.title, sp.scheduled_at, sp.status 
  FROM scheduled_posts sp
  JOIN channels c ON c.id = sp.channel_id
  ORDER BY sp.scheduled_at ASC
`).all();

posts.forEach(p => {
  console.log(`- Post ID: ${p.id} | Channel: ${p.channel_name} (${p.channel_id}) | Date: ${p.scheduled_at} | Status: ${p.status}`);
});

db.close();
