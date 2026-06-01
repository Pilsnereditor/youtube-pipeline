import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('--- Cleaning up any leftover test data ---');

const deletePosts = db.prepare("DELETE FROM scheduled_posts WHERE title LIKE 'API Test%' OR title LIKE 'Test Premiere%'");
const pRes = deletePosts.run();
console.log(`Deleted ${pRes.changes} test scheduled posts.`);

const deleteChannels = db.prepare("DELETE FROM channels WHERE name LIKE 'API Premiere%' OR name LIKE 'Premiere Test%'");
const cRes = deleteChannels.run();
console.log(`Deleted ${cRes.changes} test channels.`);

db.close();
console.log('Cleanup complete!');
