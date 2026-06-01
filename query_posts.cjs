const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'pipeline.db');
const db = new Database(dbPath);

console.log('--- Table: scheduled_posts ---');
const info = db.prepare('PRAGMA table_info(scheduled_posts)').all();
info.forEach(col => {
  console.log(`${col.cid}: ${col.name} (${col.type})`);
});

console.log('\n--- Recent scheduled posts ---');
const posts = db.prepare('SELECT * FROM scheduled_posts ORDER BY id DESC LIMIT 5').all();
console.log(posts);
