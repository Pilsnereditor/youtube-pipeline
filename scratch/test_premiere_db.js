import { initDb, getDb } from '../server/db/database.js';

console.log('--- Initializing database via initDb() to trigger migrations ---');
initDb();

const db = getDb();

console.log('\n--- Testing database columns for Premiere features ---');

// 1. Verify channels columns
const channelCols = db.prepare("PRAGMA table_info(channels)").all();
const hasChPremiere = channelCols.some(col => col.name === 'schedule_as_premiere');
console.log(`Channel has 'schedule_as_premiere' column: ${hasChPremiere}`);

// 2. Verify scheduled_posts columns
const postCols = db.prepare("PRAGMA table_info(scheduled_posts)").all();
const hasPostPremiere = postCols.some(col => col.name === 'is_premiere');
console.log(`Scheduled Post has 'is_premiere' column: ${hasPostPremiere}`);

if (!hasChPremiere || !hasPostPremiere) {
  console.error('❌ Migration failed! Column(s) missing.');
  process.exit(1);
}

// 3. Test insert mock channel
console.log('\n--- Inserting test channel with schedule_as_premiere = 1 ---');
const insertChannel = db.prepare(`
  INSERT INTO channels (name, niche, description, schedule_as_premiere, upload_mode)
  VALUES (?, ?, ?, ?, ?)
`);
const chResult = insertChannel.run('Premiere Test Channel', 'Tech', 'A channel for testing premiere option', 1, 'browser');
const testChannelId = chResult.lastInsertRowid;
console.log(`Inserted channel ID: ${testChannelId}`);

const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(testChannelId);
console.log('Inserted channel details:', channel);

if (channel.schedule_as_premiere !== 1) {
  console.error('❌ Failed: schedule_as_premiere is not 1.');
  process.exit(1);
}

// 4. Check video stock to attach to post
const mockVideo = db.prepare('SELECT * FROM videos LIMIT 1').get();
let testVideoId = null;
let testVideoPath = '';

if (mockVideo) {
  testVideoId = mockVideo.id;
  testVideoPath = mockVideo.filepath;
  console.log(`Using existing video: ID=${testVideoId}, path=${testVideoPath}`);
} else {
  // Insert a mock video
  console.log('\n--- Inserting mock video ---');
  const insertVideo = db.prepare(`
    INSERT INTO videos (original_filename, filepath, duration)
    VALUES (?, ?, ?)
  `);
  const vidResult = insertVideo.run('test_video.mp4', 'uploads/test_video.mp4', 120); // 120s > 60s
  testVideoId = vidResult.lastInsertRowid;
  testVideoPath = 'uploads/test_video.mp4';
  console.log(`Inserted mock video ID: ${testVideoId}`);
}

// 5. Test insert scheduled post
console.log('\n--- Inserting test scheduled post with is_premiere = 1 ---');
const insertPost = db.prepare(`
  INSERT INTO scheduled_posts (channel_id, title, description, video_id, video_path, scheduled_at, is_premiere, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const postResult = insertPost.run(testChannelId, 'Test Premiere Video', 'Testing premiere option', testVideoId, testVideoPath, '2026-06-01T12:00:00', 1, 'pending');
const testPostId = postResult.lastInsertRowid;
console.log(`Inserted scheduled post ID: ${testPostId}`);

const post = db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(testPostId);
console.log('Inserted scheduled post details:', post);

if (post.is_premiere !== 1) {
  console.error('❌ Failed: is_premiere is not 1.');
  process.exit(1);
}

// Clean up test data
console.log('\n--- Cleaning up test data ---');
db.prepare('DELETE FROM scheduled_posts WHERE id = ?').run(testPostId);
db.prepare('DELETE FROM channels WHERE id = ?').run(testChannelId);
console.log('Cleaned up test channel and post.');

console.log('\n✅ All DB tests passed successfully!');
db.close();
