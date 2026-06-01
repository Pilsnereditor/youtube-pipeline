import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

const BASE_URL = 'http://localhost:3000/api';

async function cleanup(channelId, postIds = []) {
  console.log('\nCleaning up database...');
  for (const id of postIds) {
    db.prepare('DELETE FROM scheduled_posts WHERE id = ?').run(id);
  }
  if (channelId) {
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  }
  console.log('Cleanup complete.');
}

async function runTests() {
  let testChannelId = null;
  let testPostIds = [];
  
  try {
    // 1. Check or insert a Short video in DB
    console.log('Ensuring we have a Short video (duration <= 60s) and a normal video (>60s)...');
    let shortVideo = db.prepare("SELECT * FROM videos WHERE duration <= 60 LIMIT 1").get();
    if (!shortVideo) {
      const info = db.prepare("INSERT INTO videos (original_filename, filepath, duration) VALUES (?, ?, ?)")
                     .run('short_test.mp4', 'uploads/short_test.mp4', 30);
      shortVideo = { id: info.lastInsertRowid, filepath: 'uploads/short_test.mp4' };
    }
    console.log(`Short video: ID=${shortVideo.id}, duration=30s`);

    let longVideo = db.prepare("SELECT * FROM videos WHERE duration > 60 OR duration IS NULL LIMIT 1").get();
    if (!longVideo) {
      const info = db.prepare("INSERT INTO videos (original_filename, filepath, duration) VALUES (?, ?, ?)")
                     .run('long_test.mp4', 'uploads/long_test.mp4', 120);
      longVideo = { id: info.lastInsertRowid, filepath: 'uploads/long_test.mp4' };
    }
    console.log(`Normal video: ID=${longVideo.id}, duration=${longVideo.duration || 'unknown'}`);

    // 2. Create channel via POST /api/channels
    console.log('\n--- Test 1: Creating channel with schedule_as_premiere = true ---');
    const channelPayload = {
      name: 'API Premiere Test Channel',
      niche: 'Education',
      description: 'API Premiere Test Channel Desc',
      upload_privacy: 'private',
      category: '27',
      comment_template: 'Nice video!',
      upload_mode: 'browser',
      schedule_as_premiere: true
    };
    
    let res = await fetch(`${BASE_URL}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(channelPayload)
    });
    
    if (!res.ok) throw new Error(`Failed to create channel: ${await res.text()}`);
    const channel = await res.json();
    testChannelId = channel.id;
    console.log(`Created channel ID: ${testChannelId}, schedule_as_premiere: ${channel.schedule_as_premiere}`);
    if (channel.schedule_as_premiere !== 1) throw new Error('schedule_as_premiere !== 1');

    // 3. Create scheduled post for Normal Video with isPremiere = true
    console.log('\n--- Test 2: Scheduling normal video with isPremiere = true ---');
    res = await fetch(`${BASE_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: testChannelId,
        title: 'Normal Video Premiere Post',
        videoId: longVideo.id,
        scheduledAt: '2026-06-15T10:00:00',
        isPremiere: true
      })
    });
    
    if (!res.ok) throw new Error(`Failed to schedule normal post: ${await res.text()}`);
    const longPost = await res.json();
    testPostIds.push(longPost.id);
    console.log(`Created post ID: ${longPost.id}, title: "${longPost.title}", is_premiere: ${longPost.is_premiere}`);
    if (longPost.is_premiere !== 1) throw new Error('is_premiere should be 1 for normal videos');
    console.log('✅ Normal video premiere flag preserved.');

    // 4. Create scheduled post for Short Video with isPremiere = true (should force is_premiere = 0)
    console.log('\n--- Test 3: Scheduling Short video with isPremiere = true (should force false) ---');
    res = await fetch(`${BASE_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: testChannelId,
        title: 'Short Video Premiere Post',
        videoId: shortVideo.id,
        scheduledAt: '2026-06-15T11:00:00',
        isPremiere: true
      })
    });

    if (!res.ok) throw new Error(`Failed to schedule short post: ${await res.text()}`);
    const shortPost = await res.json();
    testPostIds.push(shortPost.id);
    console.log(`Created post ID: ${shortPost.id}, title: "${shortPost.title}", is_premiere: ${shortPost.is_premiere}`);
    if (shortPost.is_premiere !== 0) throw new Error('is_premiere should be 0 for Shorts (<= 60s)');
    console.log('✅ Short video premiere flag successfully forced to 0.');

    // 5. Test updating scheduled post from isPremiere = true to false (using database query first to bypass active processing block)
    console.log('\n--- Test 4: Testing PUT updates by resetting status to pending ---');
    db.prepare("UPDATE scheduled_posts SET status = 'pending' WHERE id = ?").run(longPost.id);
    
    res = await fetch(`${BASE_URL}/schedule/${longPost.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated Normal Video Post',
        scheduledAt: '2026-06-15T12:00:00',
        isPremiere: false
      })
    });

    if (!res.ok) throw new Error(`Failed to update post: ${await res.text()}`);
    
    // Check in database directly to confirm update
    const updatedPost = db.prepare("SELECT * FROM scheduled_posts WHERE id = ?").get(longPost.id);
    console.log(`Updated post title: "${updatedPost.title}", is_premiere: ${updatedPost.is_premiere}`);
    if (updatedPost.is_premiere !== 0) throw new Error('is_premiere was not updated to 0');
    console.log('✅ PUT isPremiere update successful.');

    console.log('\n🎉 ALL INTEGRATION TESTS PASSED!');
  } catch (err) {
    console.error('\n❌ Test failed with error:', err.message);
  } finally {
    await cleanup(testChannelId, testPostIds);
    db.close();
  }
}

runTests();
