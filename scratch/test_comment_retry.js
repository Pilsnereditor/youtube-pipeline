import { initDb, queryOne, run, insert } from '../server/db/database.js';
import { checkPendingComments } from '../server/services/scheduler.js';

// Initialize DB
initDb();

const USER_ID = 1;
const CHANNEL_ID = 999; // Mock channel

async function main() {
  console.log('--- TEST SCHEDULER COMMENT RETRY ROUTINE ---');

  // 1. Setup mock channel in browser mode
  run(`INSERT OR IGNORE INTO channels (id, user_id, name, niche, schedule_days, schedule_time, upload_mode, comment_template) 
       VALUES (${CHANNEL_ID}, ${USER_ID}, 'Test Comment Retry Channel', 'Test Niche', 'everyday', '10:00', 'browser', 'Test comment for {title}')`);

  // 2. Insert a mock completed scheduled post with a pending comment
  const postId = insert(
    `INSERT INTO scheduled_posts (user_id, channel_id, title, status, comment_status, scheduled_at, youtube_video_id) 
     VALUES (@userId, @channelId, 'Test Video', 'complete', 'pending', datetime('now', '-5 minutes'), 'rVZQ1lFqE3Q')`,
    { userId: USER_ID, channelId: CHANNEL_ID }
  );

  console.log(`Created mock completed scheduled post ID ${postId} with pending comment status.`);

  let failures = 0;

  // --- ATTEMPT 1 ---
  console.log('\n--- Running Attempt 1 ---');
  await checkPendingComments();

  let post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.comment_status !== 'pending') {
    console.error(`❌ Attempt 1 Error: comment_status is not 'pending' (got '${post.comment_status}')`);
    failures++;
  } else if (post.comment_retry_count !== 1) {
    console.error(`❌ Attempt 1 Error: comment_retry_count is not 1 (got ${post.comment_retry_count})`);
    failures++;
  } else if (!post.comment_next_retry_at) {
    console.error('❌ Attempt 1 Error: comment_next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 1 Passed: comment_retry_count=1, comment_next_retry_at=${post.comment_next_retry_at}`);
  }

  // --- ATTEMPT 2 ---
  console.log('\n--- Running Attempt 2 ---');
  // Mock comment_next_retry_at to past so it triggers again
  run(`UPDATE scheduled_posts SET comment_next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  await checkPendingComments();

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.comment_status !== 'pending') {
    console.error(`❌ Attempt 2 Error: comment_status is not 'pending' (got '${post.comment_status}')`);
    failures++;
  } else if (post.comment_retry_count !== 2) {
    console.error(`❌ Attempt 2 Error: comment_retry_count is not 2 (got ${post.comment_retry_count})`);
    failures++;
  } else if (!post.comment_next_retry_at) {
    console.error('❌ Attempt 2 Error: comment_next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 2 Passed: comment_retry_count=2, comment_next_retry_at=${post.comment_next_retry_at}`);
  }

  // --- ATTEMPT 3 ---
  console.log('\n--- Running Attempt 3 ---');
  // Mock comment_next_retry_at to past
  run(`UPDATE scheduled_posts SET comment_next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  await checkPendingComments();

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.comment_status !== 'pending') {
    console.error(`❌ Attempt 3 Error: comment_status is not 'pending' (got '${post.comment_status}')`);
    failures++;
  } else if (post.comment_retry_count !== 3) {
    console.error(`❌ Attempt 3 Error: comment_retry_count is not 3 (got ${post.comment_retry_count})`);
    failures++;
  } else if (!post.comment_next_retry_at) {
    console.error('❌ Attempt 3 Error: comment_next_retry_at is null');
    failures++;
  } else {
    console.log(`✅ Attempt 3 Passed: comment_retry_count=3, comment_next_retry_at=${post.comment_next_retry_at}`);
  }

  // --- ATTEMPT 4 (Max Retries Reached) ---
  console.log('\n--- Running Attempt 4 (Exceeding Max Retries) ---');
  // Mock comment_next_retry_at to past
  run(`UPDATE scheduled_posts SET comment_next_retry_at = datetime('now', '-1 minute') WHERE id = @id`, { id: postId });
  await checkPendingComments();

  post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
  if (post.comment_status !== 'error') {
    console.error(`❌ Attempt 4 Error: comment_status is not 'error' (got '${post.comment_status}')`);
    failures++;
  } else if (post.comment_next_retry_at !== null) {
    console.error(`❌ Attempt 4 Error: comment_next_retry_at is not null (got ${post.comment_next_retry_at})`);
    failures++;
  } else {
    console.log(`✅ Attempt 4 Passed: comment_retry_count remains 3, comment_status='error', comment_next_retry_at=null (halted)`);
  }

  // 3. Clean up DB
  console.log('\nCleaning up mock entries...');
  run(`DELETE FROM scheduled_posts WHERE channel_id = ${CHANNEL_ID}`);
  run(`DELETE FROM channels WHERE id = ${CHANNEL_ID}`);

  if (failures === 0) {
    console.log('\n🎉 ALL SCHEDULER COMMENT RETRY TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error(`\n❌ SCHEDULER COMMENT RETRY TEST FAILED: ${failures} verification errors.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
