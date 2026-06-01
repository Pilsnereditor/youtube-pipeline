import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

const BASE_URL = 'http://localhost:3000/api';

async function runTest() {
  let testChannelId = null;
  let testVideoIds = [];
  let testPostIds = [];

  try {
    console.log('--- Testing Bulk Publish Now Feature ---');

    // 1. Create a test channel
    const insertChannel = db.prepare(`
      INSERT INTO channels (name, niche, description, schedule_days, schedule_time, upload_mode)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const chRes = insertChannel.run('Bulk Publish Now Channel', 'Tech', 'Test channel description', 'everyday', '12:00', 'browser');
    testChannelId = chRes.lastInsertRowid;
    console.log(`Created test channel ID: ${testChannelId}`);

    // Create 2 brand new mock videos assigned to this channel
    console.log('Inserting 2 brand new videos for this channel...');
    const insertVideo = db.prepare(`
      INSERT INTO videos (original_filename, filepath, duration, channel_id, user_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const v1 = insertVideo.run('bulk_now_1.mp4', 'uploads/bulk_now_1.mp4', 120, testChannelId, 1);
    const v2 = insertVideo.run('bulk_now_2.mp4', 'uploads/bulk_now_2.mp4', 120, testChannelId, 1);
    testVideoIds = [v1.lastInsertRowid, v2.lastInsertRowid];
    console.log(`Created video IDs: ${testVideoIds.join(', ')}`);

    // 2. Call bulk schedule endpoint with publishNow = true
    console.log('\nTriggering bulk schedule with publishNow = true...');
    const payload = {
      channelIds: [testChannelId],
      count: 2,
      isDays: false,
      videoType: 'all',
      videoOrder: 'asc',
      publishNow: true
    };

    const res = await fetch(`${BASE_URL}/schedule/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Failed bulk publish now: ${res.status} - ${await res.text()}`);
    }

    const result = await res.json();
    console.log('Bulk response result:', result);

    if (result.totalScheduled !== 2) {
      throw new Error(`Expected 2 scheduled posts, got ${result.totalScheduled}`);
    }

    testPostIds = result.insertedPostIds;
    console.log(`Created post IDs: ${testPostIds.join(', ')}`);

    // Verify scheduled_at times directly in the database
    const posts = db.prepare("SELECT id, scheduled_at, is_premiere FROM scheduled_posts WHERE id IN (?, ?)")
                    .all(testPostIds[0], testPostIds[1]);
    console.log('Created scheduled posts in DB:', posts);

    const now = new Date();
    for (const post of posts) {
      const postDate = new Date(post.scheduled_at);
      // The scheduled date should be within 30 seconds of "now"
      const diffSeconds = Math.abs((now - postDate) / 1000);
      console.log(`Post ID ${post.id} scheduled_at: ${post.scheduled_at} (diff to now: ${diffSeconds.toFixed(1)}s)`);
      if (diffSeconds > 30) {
        throw new Error(`Post ID ${post.id} scheduled_at is too far from now: ${post.scheduled_at}`);
      }
    }

    console.log('\n✅ BULK PUBLISH NOW SUCCESSFUL!');
  } catch (err) {
    console.error('\n❌ Test failed with error:', err.message);
  } finally {
    console.log('\nCleaning up database...');
    if (testPostIds.length > 0) {
      db.prepare(`DELETE FROM scheduled_posts WHERE id IN (${testPostIds.map(() => '?').join(',')})`).run(...testPostIds);
    }
    if (testVideoIds.length > 0) {
      db.prepare(`DELETE FROM videos WHERE id IN (${testVideoIds.map(() => '?').join(',')})`).run(...testVideoIds);
    }
    if (testChannelId) {
      db.prepare("DELETE FROM channels WHERE id = ?").run(testChannelId);
    }
    db.close();
    console.log('Cleanup complete.');
  }
}

runTest();
