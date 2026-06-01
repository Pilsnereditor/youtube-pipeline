import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, queryAll, queryOne, run, insert } from '../server/db/database.js';
import { runWeeklyCleanup } from '../server/services/videoCleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB
initDb();

const USER_ID = 1;
const CHANNEL_ID = 999; // Mock channel

async function main() {
  console.log('--- TEST WEEKLY VIDEO CLEANUP ROUTINE ---');

  // 1. Setup mock channel
  run(`INSERT OR IGNORE INTO channels (id, user_id, name, niche, schedule_days, schedule_time) 
       VALUES (${CHANNEL_ID}, ${USER_ID}, 'Test Cleanup Channel', 'Test Niche', 'everyday', '10:00')`);

  // 2. Enable weekly cleanup setting for user
  run(`INSERT INTO user_settings (user_id, key, value) VALUES (${USER_ID}, 'weekly_cleanup_published', 'true')
       ON CONFLICT(user_id, key) DO UPDATE SET value = 'true'`);

  // Create temporary directory for test videos if not exists
  const testVideoDir = path.join(__dirname, '..', 'data', 'test_videos');
  if (!fs.existsSync(testVideoDir)) {
    fs.mkdirSync(testVideoDir, { recursive: true });
  }

  // 3. Create 7 mock videos with physical files and database entries
  const mockVideos = [];
  const mockPosts = [];

  for (let i = 1; i <= 7; i++) {
    const filename = `test_video_${i}.mp4`;
    const filepath = path.join(testVideoDir, filename);
    
    // Write fake content to mock file
    fs.writeFileSync(filepath, `fake video content ${i}`);
    
    // Insert into videos table
    const videoId = insert(
      `INSERT INTO videos (user_id, channel_id, original_filename, filepath, filesize, mimetype) 
       VALUES (@userId, @channelId, @filename, @filepath, 100, 'video/mp4')`,
      { userId: USER_ID, channelId: CHANNEL_ID, filename, filepath }
    );
    
    mockVideos.push({ id: Number(videoId), filepath });

    // Insert completed scheduled posts with sequential dates (oldest to newest)
    const scheduledAt = `2026-05-${20 + i} 10:00:00`;
    const postId = insert(
      `INSERT INTO scheduled_posts (user_id, channel_id, video_id, title, status, scheduled_at) 
       VALUES (@userId, @channelId, @videoId, @title, 'complete', @scheduledAt)`,
      { userId: USER_ID, channelId: CHANNEL_ID, videoId, title: `Test Post ${i}`, scheduledAt }
    );
    
    mockPosts.push({ id: Number(postId), videoId: Number(videoId), title: `Test Post ${i}`, scheduledAt });
  }

  console.log(`Successfully created ${mockVideos.length} mock videos and completed scheduled posts.`);
  
  // Verify starting state
  console.log('\nInitial physical files existence:');
  mockVideos.forEach(v => {
    console.log(`Video ID ${v.id} File exists: ${fs.existsSync(v.filepath)}`);
  });

  // 4. Run the cleanup utility
  console.log('\nRunning weekly cleanup routine...');
  const deleted = await runWeeklyCleanup(USER_ID);
  console.log(`Cleanup finished. Deleted count returned: ${deleted}`);

  // 5. Verify results
  console.log('\nVerifying database rows and disk files after cleanup:');
  let failures = 0;
  
  // We expect Math.floor(7 / 2) = 3 oldest videos to be deleted (Videos 1, 2, 3)
  // And 4 newest videos to remain (Videos 4, 5, 6, 7)
  for (let i = 0; i < mockVideos.length; i++) {
    const mockVid = mockVideos[i];
    const mockPost = mockPosts[i];
    const videoInDb = queryOne('SELECT * FROM videos WHERE id = @id', { id: mockVid.id });
    const fileExists = fs.existsSync(mockVid.filepath);
    const postInDb = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: mockPost.id });

    // Expect deletion for the first 3
    const shouldBeDeleted = i < 3;
    
    if (shouldBeDeleted) {
      if (videoInDb) {
        console.error(`❌ Error: Video ID ${mockVid.id} (${mockPost.title}) was NOT deleted from DB.`);
        failures++;
      } else if (fileExists) {
        console.error(`❌ Error: Video ID ${mockVid.id} (${mockPost.title}) file still exists on disk.`);
        failures++;
      } else {
        console.log(`✅ Success: Video ID ${mockVid.id} (${mockPost.title}, scheduled at: ${mockPost.scheduledAt}) successfully deleted from disk and DB.`);
      }
      
      // The post should still exist but video_id should be null due to foreign key constraint
      if (!postInDb) {
        console.error(`❌ Error: Scheduled post ID ${mockPost.id} was deleted entirely (should just have video_id null).`);
        failures++;
      } else if (postInDb.video_id !== null) {
        console.error(`❌ Error: Scheduled post ID ${mockPost.id} video_id is not null: ${postInDb.video_id}`);
        failures++;
      }
    } else {
      // Should NOT be deleted (newest 4)
      if (!videoInDb) {
        console.error(`❌ Error: Video ID ${mockVid.id} (${mockPost.title}) was incorrectly deleted from DB.`);
        failures++;
      } else if (!fileExists) {
        console.error(`❌ Error: Video ID ${mockVid.id} (${mockPost.title}) file was incorrectly deleted from disk.`);
        failures++;
      } else {
        console.log(`✅ Success: Video ID ${mockVid.id} (${mockPost.title}, scheduled at: ${mockPost.scheduledAt}) remains untouched.`);
      }
    }
  }

  // 6. Cleanup mock entries and temp files
  console.log('\nCleaning up mock files and DB entries...');
  mockVideos.forEach(v => {
    if (fs.existsSync(v.filepath)) {
      fs.unlinkSync(v.filepath);
    }
  });

  try {
    fs.rmdirSync(testVideoDir);
  } catch (e) {
    // ignore
  }

  run(`DELETE FROM scheduled_posts WHERE channel_id = ${CHANNEL_ID}`);
  run(`DELETE FROM videos WHERE channel_id = ${CHANNEL_ID}`);
  run(`DELETE FROM channels WHERE id = ${CHANNEL_ID}`);

  if (failures === 0) {
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error(`\n❌ TEST FAILED: ${failures} verification errors.`);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
});
