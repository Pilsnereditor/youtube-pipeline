import cron from 'node-cron';
import { queryAll, queryOne, run, insert } from '../db/database.js';
import { uploadVideo, setThumbnail, addComment, syncChannelWithYouTube } from './youtube.js';
import { uploadVideoBrowser, rescheduleVideoBrowser, postCommentBrowser, syncChannelWithYouTubeBrowser, withChannelLock } from './puppet.js';
import { runWeeklyCleanup } from './videoCleanup.js';

let broadcastFn = null;
let cronTask = null;
let cleanupTask = null;
let syncTask = null;

let isCheckingDuePosts = false;
let isCheckingPendingComments = false;

/**
 * Initialise the scheduler. Starts a cron job that runs every minute, checking
 * for scheduled posts that are due.
 * @param {Function} broadcast  WebSocket broadcast function.
 */
export function init(broadcast) {
  broadcastFn = broadcast;

  // Run every minute
  cronTask = cron.schedule('* * * * *', async () => {
    try {
      if (!isCheckingDuePosts) {
        isCheckingDuePosts = true;
        try {
          await checkDuePosts();
        } finally {
          isCheckingDuePosts = false;
        }
      }
      if (!isCheckingPendingComments) {
        isCheckingPendingComments = true;
        try {
          await checkPendingComments();
        } finally {
          isCheckingPendingComments = false;
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking due posts:', err);
    }
  });

  // Weekly cleanup on Thursdays at 3:00 AM
  cleanupTask = cron.schedule('0 3 * * 4', async () => {
    try {
      console.log('[Scheduler] Running Thursday weekly video cleanup...');
      const deletedCount = await runWeeklyCleanup();
      console.log(`[Scheduler] Thursday weekly video cleanup finished. Deleted ${deletedCount} files.`);
    } catch (err) {
      console.error('[Scheduler] Error running weekly cleanup:', err);
    }
  });

  // Automatic Channel Sync every 6 hours
  syncTask = cron.schedule('0 */6 * * *', async () => {
    try {
      console.log('[Scheduler] Running automatic 6-hour channel state synchronization...');
      const channels = queryAll('SELECT id, upload_mode, name FROM channels');
      for (const ch of channels) {
        const activePost = queryOne(
          `SELECT id FROM scheduled_posts WHERE channel_id = @id AND status = 'processing' LIMIT 1`,
          { id: ch.id }
        );
        if (activePost) {
          console.log(`[Scheduler] Skipping auto-sync for channel "${ch.name}" (${ch.id}) because an upload is currently processing.`);
          continue;
        }

        try {
          console.log(`[Scheduler] Auto-syncing channel "${ch.name}" (${ch.id}) in mode: ${ch.upload_mode}`);
          if (ch.upload_mode === 'browser') {
            await syncChannelWithYouTubeBrowser(ch.id);
          } else {
            await syncChannelWithYouTube(ch.id);
          }
        } catch (syncErr) {
          console.error(`[Scheduler] Auto-sync failed for channel "${ch.name}" (${ch.id}):`, syncErr.message);
        }
      }
      console.log('[Scheduler] Automatic channel state synchronization finished.');
    } catch (err) {
      console.error('[Scheduler] Error running automatic channel synchronization:', err);
    }
  });

  console.log('[Scheduler] Started — checking every minute for due posts/comments, weekly on Thursdays for cleanup, and every 6 hours for channel sync.');
}

/**
 * Check for posts that are due (scheduled_at <= now and still pending).
 */
async function checkDuePosts() {
  const localDate = new Date();
  const tzOffset = localDate.getTimezoneOffset() * 60000;
  const now = new Date(localDate.getTime() - tzOffset).toISOString().slice(0, 19);

  const duePosts = queryAll(
    `SELECT * FROM scheduled_posts 
     WHERE (status = 'pending' AND scheduled_at <= @now)
        OR (status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= @now)
        OR (status = 'error' AND retry_count < 3 AND next_retry_at <= @now)
     ORDER BY scheduled_at ASC`,
    { now },
  );

  for (const post of duePosts) {
    await processPost(post);
  }
}

/**
 * Check for completed scheduled posts with pending comments that are now due (public).
 */
export async function checkPendingComments() {
  const localDate = new Date();
  const tzOffset = localDate.getTimezoneOffset() * 60000;
  const now = new Date(localDate.getTime() - tzOffset).toISOString().slice(0, 19);

  const pendingPosts = queryAll(
    `SELECT sp.*, c.comment_template, c.upload_mode 
     FROM scheduled_posts sp
     LEFT JOIN channels c ON c.id = sp.channel_id
     WHERE sp.status = 'complete' 
       AND sp.comment_status = 'pending' 
       AND sp.scheduled_at <= @now
       -- NOTE: premieres are NOT special-cased here. A premiere only becomes
       -- commentable once it airs at scheduled_at; trying earlier used to burn the
       -- retry budget on the pre-air countdown page and the comment never landed.
       AND sp.youtube_video_id IS NOT NULL
       AND (sp.comment_next_retry_at IS NULL OR sp.comment_next_retry_at <= @now)`,
    { now }
  );

  for (const post of pendingPosts) {
    const rawCommentTemplate = post.custom_comment || post.comment_template || '';
    if (!rawCommentTemplate.trim()) {
      run(`UPDATE scheduled_posts SET comment_status = 'none' WHERE id = @id`, { id: post.id });
      continue;
    }

    const commentText = rawCommentTemplate
      .replace(/\{title\}/gi, post.title)
      .replace(/\{videoId\}/gi, post.youtube_video_id);

    try {
      console.log(`[Scheduler] Video ${post.youtube_video_id} is public or a Premiere. Posting comment...`);
      
      if (post.upload_mode === 'browser') {
        await postCommentBrowser(post.channel_id, post.youtube_video_id, commentText);
      } else {
        await addComment(post.channel_id, post.youtube_video_id, commentText);
      }

      run(`UPDATE scheduled_posts SET comment_status = 'posted', comment_retry_count = 0, comment_next_retry_at = NULL WHERE id = @id`, { id: post.id });
      console.log(`[Scheduler] Successfully posted pending comment on video ${post.youtube_video_id}`);
      if (broadcastFn) broadcastFn({ type: 'comment:updated', postId: post.id, videoId: post.youtube_video_id, ok: true, message: 'Pinned comment posted on YouTube.' }, post.user_id);
    } catch (err) {
      console.error(`[Scheduler] Failed to post pending comment on video ${post.youtube_video_id}:`, err.message);
      
      const nextAttempt = (post.comment_retry_count || 0) + 1;
      const commentsDisabled = err.message.includes('COMMENTS_DISABLED');

      if (commentsDisabled) {
        // Stop retrying if comments are turned off on YouTube
        run(`UPDATE scheduled_posts SET comment_status = 'disabled', comment_retry_count = @nextAttempt, comment_next_retry_at = NULL WHERE id = @id`, { nextAttempt, id: post.id });
        console.warn(`[Scheduler] Commenting disabled on video ${post.youtube_video_id}. Marked as disabled.`);
        if (broadcastFn) broadcastFn({ type: 'comment:updated', postId: post.id, videoId: post.youtube_video_id, ok: false, message: 'Comments are turned off on this video, so the pinned comment could not be posted.' }, post.user_id);
      } else if (nextAttempt <= 3) {
        // Exponential backoff: 5 mins, 30 mins, 2 hours
        let backoffMinutes = 5;
        if (nextAttempt === 2) backoffMinutes = 30;
        else if (nextAttempt === 3) backoffMinutes = 120;

        const nextRetryDate = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000) + backoffMinutes * 60000);
        const commentNextRetryAt = nextRetryDate.toISOString().slice(0, 19);

        run(
          `UPDATE scheduled_posts 
           SET comment_retry_count = @nextAttempt, comment_next_retry_at = @commentNextRetryAt 
           WHERE id = @id`,
          { nextAttempt, commentNextRetryAt, id: post.id }
        );
        console.log(`[Scheduler] Comment failed. Scheduled retry #${nextAttempt} at ${commentNextRetryAt}.`);
      } else {
        // Max retries reached, stop retrying and mark error
        run(
          `UPDATE scheduled_posts 
           SET comment_status = 'error', comment_next_retry_at = NULL 
           WHERE id = @id`,
          { id: post.id }
        );
        console.error(`[Scheduler] Max retries reached for comment on video ${post.youtube_video_id}.`);
        if (broadcastFn) broadcastFn({ type: 'comment:updated', postId: post.id, videoId: post.youtube_video_id, ok: false, message: 'Could not post the pinned comment on YouTube after several attempts.' }, post.user_id);
      }
    }
  }
}

/**
 * Process (upload) a single scheduled post.
 *
 * Workflow:
 *  1. Look up the video file (via video_id or video_path)
 *  2. Upload to YouTube with title, description, tags
 *  3. Set the custom thumbnail if one is linked
 *  4. Post auto-comment from the channel's comment_template
 *  5. Record the upload and mark post as complete
 */
export async function processPost(post) {
  const notify = (msg) => {
    console.log(`[Scheduler] ${msg}`);
    if (broadcastFn) {
      broadcastFn({ type: 'schedule:status', postId: post.id, message: msg }, post.user_id);
    }
  };

  try {
    // Atomically claim this post for processing: flip it to 'processing' ONLY if no other
    // post for the same channel is already processing. Doing the check and the update in a
    // single conditional statement closes the race where the bulk loop and the per-minute
    // cron could both pass a separate check and launch two browsers on the same channel
    // profile at once — which corrupts the session and causes "detached Frame" failures.
    const claim = run(
      `UPDATE scheduled_posts SET status = 'processing'
       WHERE id = @id
         AND status != 'processing'
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_posts
           WHERE channel_id = @channelId AND status = 'processing' AND id != @id
         )`,
      { id: post.id, channelId: post.channel_id }
    );
    if (!claim.changes) {
      // Channel is busy with another upload. This is NOT a failure — re-queue this post to try
      // again shortly WITHOUT marking it failed or consuming a retry attempt, so a busy channel
      // can never cause a permanent failure. It stays 'pending'; the per-minute scheduler picks
      // it up again (via the next_retry_at clause) once the channel is free.
      const tzOff = new Date().getTimezoneOffset() * 60000;
      const retryAt = new Date(Date.now() + 60 * 1000 - tzOff).toISOString().slice(0, 19);
      run(
        `UPDATE scheduled_posts
            SET status = 'pending', next_retry_at = @retryAt,
                error_message = 'Waiting for the channel to finish another upload — continuing automatically.'
          WHERE id = @id`,
        { id: post.id, retryAt }
      );
      notify(`Post ${post.id} deferred: channel busy. Re-queued to continue automatically (no retry consumed).`);
      if (broadcastFn) {
        broadcastFn({ type: 'schedule:status', postId: post.id, message: 'Waiting for the channel to be free…' }, post.user_id);
      }
      return { deferred: true };
    }
    notify(`Processing scheduled post ${post.id}: "${post.title}"`);

    // --- Resolve video path ---
    let videoPath = post.video_path || null;
    if (!videoPath && post.video_id) {
      const video = queryOne('SELECT filepath FROM videos WHERE id = @id', { id: post.video_id });
      if (video) videoPath = video.filepath;
    }
    if (!videoPath) {
      throw new Error('No video file associated with this scheduled post.');
    }

    // --- Resolve thumbnail path ---
    let thumbnailPath = null;
    let finalThumbnailId = post.thumbnail_id;
    if (!finalThumbnailId && post.video_id) {
      const video = queryOne('SELECT thumbnail_id FROM videos WHERE id = @id', { id: post.video_id });
      if (video) finalThumbnailId = video.thumbnail_id;
    }
    if (finalThumbnailId) {
      const thumb = queryOne('SELECT filepath FROM thumbnails WHERE id = @id', { id: finalThumbnailId });
      if (thumb) thumbnailPath = thumb.filepath;
    }

    // --- Parse tags ---
    let tags = [];
    try {
      tags = post.tags ? JSON.parse(post.tags) : [];
    } catch {
      tags = post.tags ? post.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    }

    // --- Get channel info ---
    const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: post.channel_id });
    if (!channel) throw new Error(`Channel ${post.channel_id} not found.`);

    // --- Upload video to YouTube ---
    notify(`Uploading "${post.title}" to channel "${channel.name}"...`);
    if (broadcastFn) {
      broadcastFn({ type: 'schedule:uploading', postId: post.id, channel: channel.name, title: post.title }, post.user_id);
    }

    let videoId = '';
    if (channel.upload_mode === 'browser') {
      const wantsSchedule = post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now() + 60 * 1000;

      if (post.youtube_video_id) {
        // A previous attempt already uploaded this video. Do NOT upload it again (that would
        // create a duplicate on YouTube). Just (re)apply the schedule on the edit page.
        videoId = post.youtube_video_id;
        if (wantsSchedule) {
          notify(`Video ${videoId} was already uploaded — applying the schedule on the edit page...`);
          await withChannelLock(post.channel_id, () => rescheduleVideoBrowser(post.channel_id, videoId, post.scheduled_at, post.is_premiere || 0));
        }
      } else {
        const result = await withChannelLock(post.channel_id, () => uploadVideoBrowser(post.channel_id, {
          videoPath,
          title: post.title,
          description: post.description || '',
          tags,
          privacy: post.privacy || channel.upload_privacy || 'private',
          category: channel.category,
          scheduledAt: post.scheduled_at,
          thumbnailPath: thumbnailPath || null,
          isPremiere: post.is_premiere || 0,
        }, (msg) => notify(msg)));
        videoId = result.videoId;

        // Persist the video ID immediately, so if anything below fails and this post is retried,
        // it takes the "already uploaded" branch above instead of re-uploading a duplicate.
        if (videoId) {
          run(`UPDATE scheduled_posts SET youtube_video_id = @vid WHERE id = @id`, { vid: videoId, id: post.id });
        }

        // If the in-dialog scheduling didn't take (YouTube saved the video as a private draft —
        // this can happen when YouTube shows "Processing delayed"), enforce the schedule on the
        // edit page so the video still publishes at the intended time once processing finishes.
        if (videoId && wantsSchedule && result.scheduled === false) {
          notify(`Upload saved without a schedule — enforcing the schedule on the edit page...`);
          await withChannelLock(post.channel_id, () => rescheduleVideoBrowser(post.channel_id, videoId, post.scheduled_at, post.is_premiere || 0));
        }
      }
    } else {
      const result = await uploadVideo(post.channel_id, {
        videoPath,
        title: post.title,
        description: post.description || '',
        tags,
        privacy: post.privacy || channel.upload_privacy || 'private',
        category: channel.category,
        scheduledAt: post.scheduled_at,
      });
      videoId = result.videoId;
    }

    notify(`Uploaded: YouTube video ID ${videoId}`);

    // --- Set thumbnail ---
    if (thumbnailPath) {
      if (channel.upload_mode !== 'browser') {
        try {
          await setThumbnail(post.channel_id, videoId, thumbnailPath);
          notify(`Thumbnail set for video ${videoId}`);
        } catch (err) {
          notify(`Thumbnail error for ${videoId}: ${err.message}`);
        }
      } else {
        notify(`Thumbnail was uploaded during browser upload flow for video ${videoId}`);
      }
      // Mark thumbnail as used
      if (post.thumbnail_id) {
        run(`UPDATE thumbnails SET used = 1 WHERE id = @id`, { id: post.thumbnail_id });
      }
    }

    // --- Pinned Comment ---
    const rawCommentTemplate = post.custom_comment || channel.comment_template || '';
    let commentStatus = 'none';
    if (rawCommentTemplate && rawCommentTemplate.trim()) {
      commentStatus = 'pending';
      try {
        const commentText = rawCommentTemplate
          .replace(/\{title\}/gi, post.title)
          .replace(/\{videoId\}/gi, videoId);
        if (channel.upload_mode === 'browser') {
          await postCommentBrowser(post.channel_id, videoId, commentText);
        } else {
          await addComment(post.channel_id, videoId, commentText);
        }
        commentStatus = 'posted';
        notify(`Comment posted on video ${videoId}`);
      } catch (err) {
        notify(`Comment error on ${videoId} (will retry when video goes public): ${err.message}`);
      }
    }

    // --- Record upload in uploads table ---
    insert(
      `INSERT INTO uploads (channel_id, youtube_video_id, title, description, thumbnail_path, status, uploaded_at)
       VALUES (@channelId, @videoId, @title, @desc, @thumb, 'complete', datetime('now'))`,
      {
        channelId: post.channel_id,
        videoId,
        title: post.title,
        desc: post.description || '',
        thumb: thumbnailPath,
      },
    );

    // --- Mark scheduled post as complete and record YouTube Video ID & Comment Status ---
    run(`UPDATE scheduled_posts SET status = 'complete', youtube_video_id = @videoId, comment_status = @commentStatus, error_message = NULL WHERE id = @id`, {
      videoId,
      commentStatus,
      id: post.id
    });
    notify(`Scheduled post ${post.id} completed successfully.`);

    if (broadcastFn) {
      broadcastFn({ type: 'schedule:complete', postId: post.id, videoId }, post.user_id);
    }
  } catch (err) {
    notify(`Error processing post ${post.id}: ${err.message}`);

    // If the video is already uploaded but its edit page / visibility editor isn't ready yet
    // (YouTube is still processing it), this is a TRANSIENT condition — not a real failure.
    // Keep the post pending and keep retrying WITHOUT consuming the retry budget, so the schedule
    // gets applied automatically once processing finishes. Because the video ID is saved, the
    // retry takes the "already uploaded" branch and never re-uploads a duplicate.
    const _vidRow = queryOne('SELECT youtube_video_id FROM scheduled_posts WHERE id = @id', { id: post.id });
    const _transient = /visibility editor|still processing|processing delayed|will retry automatically|detached frame|execution context was destroyed|target closed/i.test(err.message || '');
    if (_transient && _vidRow && _vidRow.youtube_video_id) {
      const tzOff = new Date().getTimezoneOffset() * 60000;
      const retryAt = new Date(Date.now() + 3 * 60 * 1000 - tzOff).toISOString().slice(0, 19);
      run(
        `UPDATE scheduled_posts SET status = 'pending', next_retry_at = @retryAt,
                error_message = 'Video uploaded — waiting for YouTube to finish processing so the schedule can be applied. Retrying automatically.'
          WHERE id = @id`,
        { id: post.id, retryAt }
      );
      notify(`Post ${post.id} deferred: video still processing on YouTube — will keep retrying to apply the schedule (no retry consumed).`);
      if (broadcastFn) {
        // schedule:deferred tells the dashboard the file finished uploading and we're now
        // waiting on YouTube processing, so the "Uploading…" bar is cleared instead of
        // hanging forever. (schedule:status only appends a log line.)
        broadcastFn({ type: 'schedule:deferred', postId: post.id, title: post.title, message: 'Video uploaded — waiting for YouTube processing to apply the schedule…' }, post.user_id);
      }
      return;
    }

    // Record the error in uploads table too
    insert(
      `INSERT INTO uploads (channel_id, title, status, error_message, uploaded_at)
       VALUES (@channelId, @title, 'error', @err, datetime('now'))`,
      { channelId: post.channel_id, title: post.title, err: err.message },
    );

    // Call backoff retry handler
    handlePostFailure(post, err.message);

    if (broadcastFn) {
      broadcastFn({ type: 'schedule:error', postId: post.id, error: err.message }, post.user_id);
    }
  }
}

/**
 * Add a new scheduled post to the database.
 */
export function schedulePost({ userId, channelId, title, description, tags, thumbnailId, videoId, videoPath, scheduledAt, customComment, isPremiere, privacy }) {
  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : tags || '';
  
  // Resolve comment status
  const channel = queryOne('SELECT comment_template FROM channels WHERE id = @channelId', { channelId });
  const finalComment = customComment || (channel ? channel.comment_template : '');
  const commentStatus = (finalComment && finalComment.trim()) ? 'pending' : 'none';

  const id = run(
    `INSERT INTO scheduled_posts (user_id, channel_id, title, description, tags, thumbnail_id, video_id, video_path, scheduled_at, custom_comment, is_premiere, privacy, comment_status)
     VALUES (@userId, @channelId, @title, @description, @tags, @thumbnailId, @videoId, @videoPath, @scheduledAt, @customComment, @isPremiere, @privacy, @commentStatus)`,
    {
      userId,
      channelId,
      title,
      description: description || '',
      tags: tagsStr,
      thumbnailId: thumbnailId || null,
      videoId: videoId || null,
      videoPath: videoPath || '',
      scheduledAt,
      customComment: customComment || '',
      isPremiere: isPremiere ? 1 : 0,
      privacy: privacy || null,
      commentStatus
    },
  ).lastInsertRowid;

  if (broadcastFn) {
    broadcastFn({ type: 'schedule:created', postId: Number(id) });
  }
  return Number(id);
}

/**
 * Reclaim the assets (title and thumbnail) used by a scheduled post.
 */
export function reclaimPostAssets(post) {
  if (!post) return;

  // Reclaim thumbnail
  if (post.thumbnail_id) {
    run(`UPDATE thumbnails SET used = 0 WHERE id = @id`, { id: post.thumbnail_id });
  }

  // Reclaim title
  if (post.title) {
    run(`
      UPDATE titles 
      SET used = 0 
      WHERE id = (
        SELECT id FROM titles 
        WHERE channel_id = @channelId AND text = @title AND used = 1 
        ORDER BY id DESC 
        LIMIT 1
      )
    `, { channelId: post.channel_id, title: post.title });
  }
}

/**
 * Cancel a scheduled post.
 */
export function cancelPost(id) {
  const post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id });
  if (post) {
    reclaimPostAssets(post);
    run(`UPDATE scheduled_posts SET status = 'cancelled' WHERE id = @id AND status = 'pending'`, { id });
    if (broadcastFn) {
      broadcastFn({ type: 'schedule:cancelled', postId: id });
    }
  }
}

/**
 * Get upcoming (pending) scheduled posts.
 */
export function getUpcoming(userId) {
  if (userId) {
    return queryAll(
      `SELECT sp.*, c.name AS channel_name, c.upload_mode AS channel_upload_mode
       FROM scheduled_posts sp
       LEFT JOIN channels c ON c.id = sp.channel_id
       WHERE sp.status = 'pending' AND sp.user_id = @userId
       ORDER BY sp.scheduled_at ASC`,
      { userId }
    );
  }
  return queryAll(
    `SELECT sp.*, c.name AS channel_name, c.upload_mode AS channel_upload_mode
     FROM scheduled_posts sp
     LEFT JOIN channels c ON c.id = sp.channel_id
     WHERE sp.status = 'pending'
     ORDER BY sp.scheduled_at ASC`,
  );
}

/**
 * Handles backoff and retry scheduling when a scheduled post fails.
 *
 * @param {object} post
 * @param {string} errorMessage
 */
export function handlePostFailure(post, errorMessage) {
  const nextAttempt = (post.retry_count || 0) + 1;
  
  if (nextAttempt <= 3) {
    // 1st retry: 5 mins, 2nd: 30 mins, 3rd: 120 mins (2 hours)
    let backoffMinutes = 5;
    if (nextAttempt === 2) backoffMinutes = 30;
    else if (nextAttempt === 3) backoffMinutes = 120;

    const localDate = new Date();
    const tzOffset = localDate.getTimezoneOffset() * 60000;
    const nowLocal = new Date(localDate.getTime() - tzOffset);
    const nextRetryDate = new Date(nowLocal.getTime() + backoffMinutes * 60000);
    const nextRetryAt = nextRetryDate.toISOString().slice(0, 19);

    run(
      `UPDATE scheduled_posts 
       SET status = 'error', retry_count = @retryCount, next_retry_at = @nextRetryAt, error_message = @errorMessage
       WHERE id = @id`,
      { retryCount: nextAttempt, nextRetryAt, errorMessage, id: post.id }
    );
    console.log(`[Scheduler] Post ${post.id} failed: "${errorMessage}". Scheduled retry #${nextAttempt} at ${nextRetryAt}.`);
  } else {
    // Max retries exceeded, stop retrying
    run(
      `UPDATE scheduled_posts 
       SET status = 'error', next_retry_at = NULL, error_message = @errorMessage
       WHERE id = @id`,
      { errorMessage, id: post.id }
    );
    console.log(`[Scheduler] Post ${post.id} failed: "${errorMessage}". Max retries reached.`);
  }
}

/**
 * Stop the cron task (used during shutdown).
 */
export function stop() {
  if (cronTask) {
    cronTask.stop();
  }
  if (cleanupTask) {
    cleanupTask.stop();
  }
  if (syncTask) {
    syncTask.stop();
  }
  console.log('[Scheduler] Stopped.');
}
