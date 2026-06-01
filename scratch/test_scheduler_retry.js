import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, queryAll, queryOne, run, insert } from '../server/db/database.js';
import { processPost } from '../server/services/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB
initDb();

const USER_ID = 1;
const CHANNEL_ID = 888; // Mock channel

async function main() {
  console.log('--- TEST SCHEDULER AUTO-RETRY ROUTINE ---');

  // 1. Setup mock channel
  run(`INSERT OR IGNORE INTO channels (id, user_id, name, niche, schedule_days, schedule_time, upload_mode) 
       VALUES (${CHANNEL_ID}, ${USER_ID}, 'Test Retry Channel', 'Test Niche', 'everyday', '10:00', 'api')`);

  // 2. Insert a mock scheduled post with a deliberate missing video file to trigger a failure
  const postId = insert(
    `INSERT INTO scheduled_posts (user_id, channel_id, title, status, scheduled_at, video_path) 
     VALUES (@userId, @channelId, 'Test Failure Video', 'pending', datetime('now'), 'non_existent_file.mp4')`,
    { userId: USER_ID, channelId: CHANNEL_ID }
  );

  console.log(`Created mock scheduled post ID ${postId} referencing non_existent_file.mp4.`);

  let failures = 0;

  // --- ATTEMPT 1 ---
  console.log('\n--- Running Attempt 1 ---');
  let post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  await processPost(post);

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.status !== 'error') {
    console.error(`❌ Attempt 1 Error: Status is not 'error' (got '${post.status}')`);
    failures++;
  } else if (post.retry_count !== 1) {
    console.error(`❌ Attempt 1 Error: retry_count is not 1 (got ${post.retry_count})`);
    failures++;
  } else if (!post.next_retry_at) {
    console.error('❌ Attempt 1 Error: next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 1 Passed: retry_count=1, next_retry_at=${post.next_retry_at}`);
  }

  // --- ATTEMPT 2 ---
  console.log('\n--- Running Attempt 2 ---');
  // Mock next_retry_at to past so it triggers again
  run(`UPDATE scheduled_posts SET next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  await processPost(post);

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.status !== 'error') {
    console.error(`❌ Attempt 2 Error: Status is not 'error' (got '${post.status}')`);
    failures++;
  } else if (post.retry_count !== 2) {
    console.error(`❌ Attempt 2 Error: retry_count is not 2 (got ${post.retry_count})`);
    failures++;
  } else if (!post.next_retry_at) {
    console.error('❌ Attempt 2 Error: next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 2 Passed: retry_count=2, next_retry_at=${post.next_retry_at}`);
  }

  // --- ATTEMPT 3 ---
  console.log('\n--- Running Attempt 3 ---');
  // Mock next_retry_at to past
  run(`UPDATE scheduled_posts SET next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  await processPost(post);

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.status !== 'error') {
    console.error(`❌ Attempt 3 Error: Status is not 'error' (got '${post.status}')`);
    failures++;
  } else if (post.retry_count !== 3) {
    console.error(`❌ Attempt 3 Error: retry_count is not 3 (got ${post.retry_count})`);
    failures++;
  } else if (!post.next_retry_at) {
    console.error('❌ Attempt 3 Error: next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 3 Passed: retry_count=3, next_retry_at=${post.next_retry_at}`);
  }

  // --- ATTEMPT 4 (Max Retries Reached) ---
  console.log('\n--- Running Attempt 4 (Exceeding Max Retries) ---');
  // Mock next_retry_at to past
  run(`UPDATE scheduled_posts SET next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  await processPost(post);

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.status !== 'error') {
    console.error(`❌ Attempt 4 Error: Status is not 'error' (got '${post.status}')`);
    failures++;
  } else if (post.next_retry_at !== null) {
    console.error(`❌ Attempt 4 Error: next_retry_at is not null (got ${post.next_retry_at})`);
    failures++;
  } else {
    console.log(`✅ Attempt 4 Passed: retry_count remains 3, next_retry_at=null (halted)`);
  }

  // 3. Clean up DB
  console.log('\nCleaning up mock entries...');
  run(`DELETE FROM scheduled_posts WHERE channel_id = ${CHANNEL_ID}`);
  run(`DELETE FROM channels WHERE id = ${CHANNEL_ID}`);

  if (failures === 0) {
    console.log('\n🎉 ALL SCHEDULER RETRY TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error(`\n❌ SCHEDULER RETRY TEST FAILED: ${failures} verification errors.`);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
});
