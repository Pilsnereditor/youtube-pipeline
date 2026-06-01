import fs from 'fs';
import { queryAll, queryOne, run } from '../db/database.js';

/**
 * Helper to retrieve user settings or global settings.
 */
function getSetting(userId, key, defaultValue = '') {
  let row = null;
  if (userId) {
    row = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = @key", { userId, key });
  }
  if (!row || !row.value) {
    row = queryOne("SELECT value FROM settings WHERE key = @key", { key });
  }
  return row ? row.value : defaultValue;
}

/**
 * Runs the cleanup process.
 * If userId is provided, runs only for that user (e.g. from UI trigger).
 * If userId is null, runs for all users in the system (e.g. from background cron).
 *
 * @param {number|null} targetUserId
 * @returns {Promise<number>} Number of deleted video files.
 */
export async function runWeeklyCleanup(targetUserId = null) {
  let deletedCount = 0;
  try {
    let users = [];
    if (targetUserId) {
      users = [{ id: targetUserId }];
    } else {
      users = queryAll('SELECT id FROM users');
    }

    for (const user of users) {
      const userId = user.id;
      const isEnabled = getSetting(userId, 'weekly_cleanup_published', 'false') === 'true';
      if (!isEnabled) {
        console.log(`[Video Cleanup] Weekly cleanup disabled for user ${userId}. Skipping.`);
        continue;
      }

      console.log(`[Video Cleanup] Starting weekly video cleanup for user ${userId}...`);

      const channels = queryAll('SELECT id, name FROM channels WHERE user_id = @userId', { userId });
      for (const channel of channels) {
        // Find completed posts that still have a linked video record
        const completedPosts = queryAll(
          `SELECT sp.id, sp.video_id, sp.title, sp.scheduled_at 
           FROM scheduled_posts sp
           WHERE sp.channel_id = @channelId 
             AND sp.status = 'complete' 
             AND sp.video_id IS NOT NULL
           ORDER BY sp.scheduled_at ASC`,
          { channelId: channel.id }
        );

        if (completedPosts.length === 0) {
          console.log(`[Video Cleanup] Channel "${channel.name}" has no completed posts with local videos. Skipping.`);
          continue;
        }

        // Delete the oldest 50%
        const deleteCount = Math.floor(completedPosts.length / 2);
        console.log(`[Video Cleanup] Channel "${channel.name}": Found ${completedPosts.length} completed post(s). Deleting oldest ${deleteCount}.`);

        for (let i = 0; i < deleteCount; i++) {
          const post = completedPosts[i];
          const video = queryOne('SELECT filepath, original_filename FROM videos WHERE id = @id', { id: post.video_id });
          if (video) {
            console.log(`[Video Cleanup] Channel "${channel.name}": Deleting video file for "${post.title}" (ID: ${post.video_id}): ${video.filepath}`);
            if (fs.existsSync(video.filepath)) {
              try {
                fs.unlinkSync(video.filepath);
                console.log(`[Video Cleanup] Deleted physical file: ${video.filepath}`);
              } catch (err) {
                console.error(`[Video Cleanup] Failed to delete physical file: ${video.filepath}`, err);
              }
            } else {
              console.log(`[Video Cleanup] Physical file not found at: ${video.filepath}`);
            }
            // Delete from videos table (setting scheduled_posts.video_id to NULL due to ON DELETE SET NULL constraint)
            run('DELETE FROM videos WHERE id = @id', { id: post.video_id });
            deletedCount++;
          }
        }
      }
    }
  } catch (err) {
    console.error('[Video Cleanup] Error running weekly cleanup:', err);
  }
  return deletedCount;
}
