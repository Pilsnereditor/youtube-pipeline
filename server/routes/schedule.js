import { Router } from 'express';
import { queryAll, queryOne, run, getDb } from '../db/database.js';
import { schedulePost, cancelPost, getUpcoming, processPost, reclaimPostAssets } from '../services/scheduler.js';
import { syncChannelWithYouTube, updateVideoSchedule, updateOrAddComment, setThumbnail, updateVideoMetadataAPI } from '../services/youtube.js';
import { rescheduleVideoBrowser, postCommentBrowser, updateThumbnailBrowser } from '../services/puppet.js';

const router = Router();

// Helper to verify channel ownership
function verifyChannel(channelId, userId) {
  const channel = queryOne('SELECT id FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
  return !!channel;
}

/**
 * GET /api/schedule — all scheduled posts for current user
 */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    let sql = `
      SELECT sp.*, c.name AS channel_name, c.upload_mode AS channel_upload_mode,
             v.original_filename AS video_filename,
             t.filename AS thumbnail_filename
      FROM scheduled_posts sp
      LEFT JOIN channels c ON c.id = sp.channel_id
      LEFT JOIN videos v ON v.id = sp.video_id
      LEFT JOIN thumbnails t ON t.id = sp.thumbnail_id
      WHERE sp.user_id = @userId AND sp.status != 'cancelled'
    `;
    const params = { userId };

    // Optional filter by status
    if (req.query.status) {
      sql += ` AND sp.status = @status`;
      params.status = req.query.status;
    }

    sql += ` ORDER BY sp.scheduled_at ASC`;

    const posts = queryAll(sql, params);
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/schedule/upcoming — pending posts only for current user
 */
router.get('/upcoming', (req, res) => {
  const userId = req.session.userId;
  try {
    const posts = getUpcoming(userId);
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/schedule/calendar — calendar data for a given month
 * Query params: year, month (1-12)
 */
router.get('/calendar', (req, res) => {
  const userId = req.session.userId;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;

  // Build date range for the requested month
  const startDate = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00`;

  try {
    const posts = queryAll(
      `SELECT sp.*, c.name AS channel_name, c.upload_mode AS channel_upload_mode
       FROM scheduled_posts sp
       LEFT JOIN channels c ON c.id = sp.channel_id
       WHERE sp.scheduled_at >= @startDate AND sp.scheduled_at < @endDate AND sp.user_id = @userId AND sp.status != 'cancelled'
       ORDER BY sp.scheduled_at ASC`,
      { startDate, endDate, userId },
    );

    // Group by date
    const calendar = {};
    for (const post of posts) {
      const day = post.scheduled_at.split('T')[0];
      if (!calendar[day]) calendar[day] = [];
      calendar[day].push(post);
    }

    res.json({ year, month, calendar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/schedule — create a scheduled post
 * Body: { channelId, title, description?, tags?, thumbnailId?, videoId?, videoPath?, scheduledAt }
 */
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { channelId, title, description, tags, thumbnailId, videoId, videoPath, scheduledAt, customComment, isPremiere, privacy } = req.body;

  if (!channelId || !title || !scheduledAt) {
    return res.status(400).json({ error: 'channelId, title, and scheduledAt are required.' });
  }

  // Validate that the channel exists and belongs to the user
  if (!verifyChannel(channelId, userId)) {
    return res.status(404).json({ error: 'Channel not found or does not belong to you.' });
  }

  // Resolve video path and check duration from videoId
  let resolvedVideoPath = videoPath || '';
  let resolvedIsPremiere = isPremiere ? 1 : 0;
  let resolvedThumbnailId = thumbnailId || null;
  if (videoId) {
    const video = queryOne('SELECT filepath, duration, thumbnail_id FROM videos WHERE id = @id AND user_id = @userId', { id: videoId, userId });
    if (video) {
      resolvedVideoPath = video.filepath;
      if (video.duration && video.duration <= 60) {
        resolvedIsPremiere = 0;
      }
      if (!resolvedThumbnailId && video.thumbnail_id) {
        resolvedThumbnailId = video.thumbnail_id;
      }
    } else {
      return res.status(404).json({ error: 'Video file not found.' });
    }
  }

  // Validate thumbnail ownership if provided
  if (resolvedThumbnailId) {
    const thumbnail = queryOne('SELECT id FROM thumbnails WHERE id = @id AND user_id = @userId', { id: resolvedThumbnailId, userId });
    if (!thumbnail) {
      return res.status(404).json({ error: 'Thumbnail not found.' });
    }
  }

  try {
    const id = schedulePost({
      userId,
      channelId,
      title,
      description,
      tags,
      thumbnailId: resolvedThumbnailId,
      videoId,
      videoPath: resolvedVideoPath,
      scheduledAt,
      customComment,
      isPremiere: resolvedIsPremiere,
      privacy
    });
    const post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
    
    // Trigger immediate background upload to YouTube Studio (with schedule if in the future)
    if (post) {
      processPost(post).catch(err => {
        console.error('[Scheduler] Immediate process error:', err);
      });
    }
    
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/schedule/:id — update a scheduled post
 */
router.put('/:id', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const existing = queryOne('SELECT * FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
  if (!existing) return res.status(404).json({ error: 'Scheduled post not found.' });

  if (!['pending', 'error', 'complete'].includes(existing.status)) {
    return res.status(400).json({ error: 'Only pending, failed, or completed posts can be updated.' });
  }

  const { title, description, tags, thumbnailId, videoId, videoPath, scheduledAt, customComment, isPremiere, privacy } = req.body;

  try {
    const tagsStr = tags != null ? (Array.isArray(tags) ? JSON.stringify(tags) : tags) : existing.tags;

    // Resolve video path and check duration from videoId if provided
    let resolvedVideoPath = videoPath ?? existing.video_path;
    let videoDuration = null;
    const finalVideoId = videoId ?? existing.video_id;
    if (finalVideoId) {
      const video = queryOne('SELECT filepath, duration FROM videos WHERE id = @id AND user_id = @userId', { id: finalVideoId, userId });
      if (video) {
        if (videoId && !videoPath) {
          resolvedVideoPath = video.filepath;
        }
        videoDuration = video.duration;
      } else if (videoId) {
        return res.status(404).json({ error: 'Video file not found.' });
      }
    }

    // Validate thumbnail ownership if provided
    if (thumbnailId) {
      const thumbnail = queryOne('SELECT id FROM thumbnails WHERE id = @id AND user_id = @userId', { id: thumbnailId, userId });
      if (!thumbnail) {
        return res.status(404).json({ error: 'Thumbnail not found.' });
      }
    }

    let resolvedIsPremiere = isPremiere !== undefined ? (isPremiere ? 1 : 0) : existing.is_premiere;
    if (videoDuration && videoDuration <= 60) {
      resolvedIsPremiere = 0;
    }

    // If it's a complete post with a youtube_video_id, and the schedule or title has changed, update YouTube details
    const hasTitleChanged = title !== undefined && title !== existing.title;
    const hasScheduleChanged = (scheduledAt && scheduledAt !== existing.scheduled_at) || (resolvedIsPremiere !== existing.is_premiere);
    
    if (existing.status === 'complete' && existing.youtube_video_id && (hasScheduleChanged || hasTitleChanged)) {
      const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: existing.channel_id });
      const hasToken = queryOne('SELECT id FROM oauth_tokens WHERE channel_id = @id', { id: existing.channel_id });
      
      if (hasToken) {
        // Use API to update details (fast & reliable)
        try {
          const updateOpts = {};
          if (hasTitleChanged) updateOpts.title = title;
          if (hasScheduleChanged) {
            updateOpts.scheduledAt = scheduledAt || existing.scheduled_at;
            updateOpts.privacy = 'private'; // Scheduled videos must be private on YouTube
          }
          await updateVideoMetadataAPI(existing.channel_id, existing.youtube_video_id, updateOpts);
        } catch (err) {
          console.error('[Scheduler] Failed to update video details on YouTube via API:', err);
          return res.status(500).json({ error: 'Failed to update video details on YouTube: ' + err.message });
        }
      } else if (channel) {
        // Use Puppeteer to update details (browser automation). Reschedule is user-triggered
        // and synchronous, so it has no scheduler retry safety net. Transient browser errors
        // (a detached frame from YouTube re-rendering, a closed target, a navigation race) are
        // retried here with a fresh browser. Genuine failures (e.g. our date/time verification
        // aborts, or "not logged in") are NOT transient and fail immediately without retrying.
        const isTransientBrowserErr = (m) => /detached frame|execution context was destroyed|target closed|target\.createcdpsession|navigation|frame (got|was) detached|session closed|protocol error|connection closed/i.test(m || '');
        let rescheduleErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await rescheduleVideoBrowser(
              existing.channel_id,
              existing.youtube_video_id,
              hasScheduleChanged ? (scheduledAt || existing.scheduled_at) : null,
              resolvedIsPremiere,
              hasTitleChanged ? title : null
            );
            rescheduleErr = null;
            break;
          } catch (err) {
            rescheduleErr = err;
            if (attempt < 3 && isTransientBrowserErr(err.message)) {
              console.warn(`[Scheduler] Reschedule attempt ${attempt} hit a transient browser error, retrying with a fresh browser: ${err.message}`);
              await new Promise(r => setTimeout(r, 2500));
              continue;
            }
            break;
          }
        }
        if (rescheduleErr) {
          console.error('[Scheduler] Failed to update video details on YouTube via Browser:', rescheduleErr);
          return res.status(500).json({ error: 'Failed to update video details on YouTube via Browser: ' + rescheduleErr.message });
        }
      }
    }

    // If it's a complete post with a youtube_video_id, and the thumbnail has changed, update it on YouTube
    const hasThumbnailChanged = thumbnailId !== undefined && thumbnailId !== existing.thumbnail_id;
    if (existing.status === 'complete' && existing.youtube_video_id && hasThumbnailChanged && thumbnailId) {
      const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: existing.channel_id });
      const hasToken = queryOne('SELECT id FROM oauth_tokens WHERE channel_id = @id', { id: existing.channel_id });
      const thumbnail = queryOne('SELECT filepath FROM thumbnails WHERE id = @id AND user_id = @userId', { id: thumbnailId, userId });

      if (thumbnail) {
        if (hasToken) {
          try {
            await setThumbnail(existing.channel_id, existing.youtube_video_id, thumbnail.filepath);
          } catch (err) {
            console.error('[Scheduler] Failed to update thumbnail on YouTube via API:', err);
            return res.status(500).json({ error: 'Failed to update thumbnail on YouTube: ' + err.message });
          }
        } else if (channel && channel.upload_mode === 'browser') {
          (async () => {
            try {
              await updateThumbnailBrowser(existing.channel_id, existing.youtube_video_id, thumbnail.filepath);
            } catch (err) {
              console.error('[Scheduler] Background browser thumbnail update failed:', err);
            }
          })();
        }
      }
    }

    let commentStatus = existing.comment_status || 'none';
    const normalizeComment = (str) => {
      if (str === null || str === undefined) return '';
      return str.toString().replace(/\r\n/g, '\n').trim();
    };
    const hasCommentChanged = customComment !== undefined && normalizeComment(customComment) !== normalizeComment(existing.custom_comment);
    
    if (existing.status === 'complete' && existing.youtube_video_id && hasCommentChanged) {
      const targetComment = customComment || '';
      const channel = queryOne('SELECT upload_mode FROM channels WHERE id = @id', { id: existing.channel_id });
      
      if (channel && channel.upload_mode === 'browser') {
        commentStatus = targetComment.trim() ? 'pending' : 'none';
        
        // Run browser commenting asynchronously to prevent Express route blocking
        (async () => {
          try {
            await postCommentBrowser(existing.channel_id, existing.youtube_video_id, targetComment);
            const finalStatus = targetComment.trim() ? 'posted' : 'none';
            run(`UPDATE scheduled_posts SET comment_status = @finalStatus WHERE id = @id`, { finalStatus, id });
          } catch (err) {
            console.error(`[Scheduler] Background browser comment update failed for video ${existing.youtube_video_id}:`, err);
            if (targetComment.trim()) {
              run(`UPDATE scheduled_posts SET comment_status = 'pending' WHERE id = @id`, { id });
            }
          }
        })();
      } else {
        // API mode can run synchronously
        if (targetComment.trim()) {
          commentStatus = 'pending';
          try {
            await updateOrAddComment(existing.channel_id, existing.youtube_video_id, targetComment);
            commentStatus = 'posted';
          } catch (err) {
            console.warn(`[Scheduler] Could not update comment on YouTube immediately (will retry once public):`, err.message);
          }
        } else {
          // Comment was cleared/deleted
          try {
            await updateOrAddComment(existing.channel_id, existing.youtube_video_id, '');
            commentStatus = 'none';
          } catch (err) {
            console.warn(`[Scheduler] Could not delete comment from YouTube immediately:`, err.message);
            commentStatus = 'pending'; // Retry deleting/syncing comment later
          }
        }
      }
    } else if (hasCommentChanged) {
      // If the post hasn't been uploaded yet, just update comment_status for when it gets uploaded
      commentStatus = (customComment && customComment.trim()) ? 'pending' : 'none';
    }

    let newStatus = existing.status;
    if (existing.status === 'error') {
      newStatus = 'pending';
    }

    run(
      `UPDATE scheduled_posts SET
         title = @title,
         description = @description,
         tags = @tags,
         thumbnail_id = @thumbnailId,
         video_id = @videoId,
         video_path = @videoPath,
         scheduled_at = @scheduledAt,
         custom_comment = @customComment,
         is_premiere = @isPremiere,
         privacy = @privacy,
         comment_status = @commentStatus,
         status = @status,
         retry_count = 0,
         next_retry_at = NULL,
         error_message = NULL
       WHERE id = @id AND user_id = @userId`,
      {
        title: title ?? existing.title,
        description: description ?? existing.description,
        tags: tagsStr,
        thumbnailId: thumbnailId ?? existing.thumbnail_id,
        videoId: videoId ?? existing.video_id,
        videoPath: resolvedVideoPath,
        scheduledAt: scheduledAt ?? existing.scheduled_at,
        customComment: customComment ?? existing.custom_comment,
        isPremiere: resolvedIsPremiere,
        privacy: privacy ?? existing.privacy,
        commentStatus,
        status: newStatus,
        id,
        userId,
      },
    );

    const updated = queryOne('SELECT * FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/schedule/:id — cancel / delete a scheduled post
 */
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const existing = queryOne('SELECT * FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
  if (!existing) return res.status(404).json({ error: 'Scheduled post not found.' });

  try {
    reclaimPostAssets(existing);
    if (existing.status === 'pending') {
      cancelPost(Number(id));
    }
    run('DELETE FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
    res.json({ message: 'Scheduled post deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/schedule/:id/retry — Retry a failed scheduled post
 */
router.post('/:id/retry', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const existing = queryOne('SELECT * FROM scheduled_posts WHERE id = @id AND user_id = @userId', { id, userId });
  if (!existing) return res.status(404).json({ error: 'Scheduled post not found.' });

  try {
    // Reset status to pending and clear retry counters
    run("UPDATE scheduled_posts SET status = 'pending', retry_count = 0, next_retry_at = NULL, error_message = NULL WHERE id = @id", { id });
    
    const updated = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id });
    
    // Trigger immediate background upload
    processPost(updated).catch(err => {
      console.error('[Scheduler] Retry process error:', err);
    });

    res.json({ success: true, post: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/schedule/clean-all — delete all failed and pending scheduled posts from the queue
 */
router.post('/clean-all', (req, res) => {
  const userId = req.session.userId;
  try {
    const posts = queryAll("SELECT * FROM scheduled_posts WHERE user_id = @userId AND status IN ('pending', 'error')", { userId });
    for (const post of posts) {
      reclaimPostAssets(post);
      if (post.status === 'pending') {
        cancelPost(post.id);
      }
      run('DELETE FROM scheduled_posts WHERE id = @id', { id: post.id });
    }
    res.json({ success: true, message: `Cleaned ${posts.length} queue items.`, cleanedCount: posts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper functions for bulk scheduling
const DAYS_MAP = {
  'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6,
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6
};

function parseDays(daysStr) {
  if (!daysStr) return [];
  const normalized = daysStr.toLowerCase().trim();
  if (normalized === 'everyday') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  return normalized.split(',')
    .map(d => {
      const clean = d.trim().replace(/^every\s+/i, '');
      return DAYS_MAP[clean];
    })
    .filter(d => d !== undefined);
}

function getLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * POST /api/schedule/bulk — Bulk auto-schedule videos for multiple channels
 */
router.post('/bulk', async (req, res) => {
  const userId = req.session.userId;
  const { channelIds, count, isDays, presetId, commentId, videoType, videoKeyword, videoOrder, isPremiere, publishNow, videoIds } = req.body;

  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.status(400).json({ error: 'channelIds must be a non-empty array.' });
  }

  const numCount = parseInt(count, 10);
  if (isNaN(numCount) || numCount <= 0) {
    return res.status(400).json({ error: 'count must be a positive integer.' });
  }

  try {
    // Sync channel states with YouTube Studio first (before starting db transaction)
    for (const channelId of channelIds) {
      await syncChannelWithYouTube(channelId).catch(err => {
        console.error(`[Bulk Sync] Failed to sync channel ${channelId}:`, err);
      });
    }

    const dbInstance = getDb();

    let bulkCustomComment = '';
    if (commentId) {
      const savedCommentObj = queryOne(
        'SELECT text FROM saved_comments WHERE id = @id AND user_id = @userId',
        { id: commentId, userId }
      );
      if (savedCommentObj) {
        bulkCustomComment = savedCommentObj.text;
      }
    }
    
    // Execute bulk scheduling in a transaction
    const executeBulkSchedule = dbInstance.transaction(() => {
      let totalScheduled = 0;
      const results = [];
      const insertedPostIds = [];

      for (const channelId of channelIds) {
        // 1. Verify channel ownership
        const channel = queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
        if (!channel) {
          throw new Error(`Channel ${channelId} not found or does not belong to you.`);
        }

        let channelVideoIds = [];
        if (videoOrder === 'none') {
          if (!Array.isArray(videoIds) || videoIds.length === 0) {
            throw new Error(`No manually selected videos provided.`);
          }

          const placeholders = videoIds.map((_, i) => `@id${i}`).join(',');
          const queryParams = { channelId, userId };
          videoIds.forEach((id, i) => {
            queryParams[`id${i}`] = id;
          });

          const matchingVideos = queryAll(
            `SELECT id FROM videos 
             WHERE id IN (${placeholders}) 
               AND channel_id = @channelId 
               AND user_id = @userId
               AND NOT EXISTS (
                 SELECT 1 FROM scheduled_posts sp 
                 WHERE sp.video_id = videos.id AND sp.status IN ('pending', 'processing', 'complete')
               )`,
            queryParams
          );

          const matchingSet = new Set(matchingVideos.map(v => v.id));
          channelVideoIds = videoIds.filter(id => matchingSet.has(id));
        }

        const requiredCount = videoOrder === 'none' ? channelVideoIds.length : numCount;
        if (requiredCount === 0) {
          results.push({
            channelId,
            channelName: channel.name,
            scheduledCount: 0
          });
          continue;
        }

        // 2. Resolve schedule days and time
        let scheduleDays = channel.schedule_days;
        let scheduleTime = channel.schedule_time;

        if (presetId) {
          const preset = queryOne('SELECT * FROM schedule_presets WHERE id = @id AND user_id = @userId', { id: presetId, userId });
          if (preset) {
            scheduleDays = preset.days;
            scheduleTime = preset.time;
          }
        }

        const targetDays = parseDays(scheduleDays);
        if (targetDays.length === 0) {
          throw new Error(`Channel "${channel.name}" has no valid schedule days.`);
        }

        const timeParts = (scheduleTime || '10:00').split(':');
        const hours = parseInt(timeParts[0], 10) || 0;
        const minutes = parseInt(timeParts[1], 10) || 0;

        // 3. Get existing scheduled dates to avoid double-booking
        const existingPosts = queryAll(
          `SELECT scheduled_at FROM scheduled_posts 
           WHERE channel_id = @channelId AND status IN ('pending', 'processing', 'complete')`,
          { channelId }
        );
        const takenDates = new Set(
          existingPosts.map(p => p.scheduled_at.split('T')[0])
        );

        // 4. Calculate candidate dates
        const candidateDates = [];
        let now = new Date();
        
        if (publishNow) {
          for (let i = 0; i < requiredCount; i++) {
            candidateDates.push('now');
          }
        } else if (isDays) {
          // Check next 'requiredCount' calendar days starting tomorrow
          for (let i = 1; i <= requiredCount; i++) {
            const checkDate = new Date();
            checkDate.setDate(now.getDate() + i);
            if (targetDays.includes(checkDate.getDay())) {
              const dateStr = getLocalDateString(checkDate);
              if (!takenDates.has(dateStr)) {
                candidateDates.push(dateStr);
              }
            }
          }
        } else {
          // Find next 'requiredCount' open schedule slots
          let daysSearched = 0;
          let checkDate = new Date();
          checkDate.setDate(now.getDate() + 1); // Start tomorrow

          while (candidateDates.length < requiredCount && daysSearched < 365) {
            if (targetDays.includes(checkDate.getDay())) {
              const dateStr = getLocalDateString(checkDate);
              if (!takenDates.has(dateStr)) {
                candidateDates.push(dateStr);
              }
            }
            checkDate.setDate(checkDate.getDate() + 1);
            daysSearched++;
          }
        }

        // 5. Schedule videos for candidate dates
        let scheduledForChannel = 0;
        for (let idx = 0; idx < candidateDates.length; idx++) {
          const dateStr = candidateDates[idx];
          // Fetch next unscheduled video
          let video;
          if (videoOrder === 'none') {
            const videoId = channelVideoIds[idx];
            if (!videoId) break;
            video = queryOne(
              `SELECT * FROM videos WHERE id = @id AND channel_id = @channelId AND user_id = @userId`,
              { id: videoId, channelId, userId }
            );
          } else {
            let sql = `
              SELECT v.* FROM videos v 
               WHERE v.channel_id = @channelId AND v.user_id = @userId
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduled_posts sp 
                   WHERE sp.video_id = v.id AND sp.status IN ('pending', 'processing', 'complete')
                 )
            `;
            const queryParams = { channelId, userId };

            if (videoType === 'shorts') {
              sql += ` AND v.duration <= 60`;
            } else if (videoType === 'longform') {
              sql += ` AND (v.duration > 60 OR v.duration IS NULL)`;
            }

            if (videoKeyword && videoKeyword.trim()) {
              sql += ` AND (v.original_filename LIKE @keyword OR v.title LIKE @keyword)`;
              queryParams.keyword = `%${videoKeyword.trim()}%`;
            }

            if (videoOrder === 'desc') {
              sql += ` ORDER BY v.id DESC`;
            } else if (videoOrder === 'random') {
              sql += ` ORDER BY RANDOM()`;
            } else if (videoOrder === 'title_asc') {
              sql += ` ORDER BY v.title ASC`;
            } else if (videoOrder === 'filename_asc') {
              sql += ` ORDER BY v.original_filename ASC`;
            } else {
              sql += ` ORDER BY v.id ASC`;
            }

            sql += ` LIMIT 1`;

            video = queryOne(sql, queryParams);
          }

          if (!video) {
            break; // Out of video stock
          }

          // Resolve metadata (prioritizing video-specific AI generated metadata)
          let postTitle = '';
          if (video.title) {
            postTitle = video.title;
          } else {
            // Fallback to titles list or cleaned filename
            const titleRow = queryOne(
              `SELECT * FROM titles WHERE channel_id = @channelId AND used = 0 
               ORDER BY id ASC LIMIT 1`,
              { channelId }
            );
            if (titleRow) {
              postTitle = titleRow.text;
              run('UPDATE titles SET used = 1 WHERE id = @id', { id: titleRow.id });
            } else {
              postTitle = video.original_filename.replace(/\.[^/.]+$/, "");
            }
          }

          let postDesc = video.description || channel.description || '';
          let postTags = video.tags || channel.niche || '';

          // Use video's auto-generated thumbnail if available
          let thumbnailId = video.thumbnail_id || null;
          if (thumbnailId) {
            run('UPDATE thumbnails SET used = 1 WHERE id = @id', { id: thumbnailId });
          }

          let postIsPremiere = 0;
          const isNormalVideo = (video.duration === null || video.duration > 60);
          if (isNormalVideo) {
            if (isPremiere !== undefined) {
              postIsPremiere = isPremiere ? 1 : 0;
            } else {
              postIsPremiere = channel.schedule_as_premiere ? 1 : 0;
            }
          }

          let scheduledAt;
          if (publishNow) {
            const nowTime = new Date();
            // Add a few seconds offset to keep them sequentially ordered
            nowTime.setSeconds(nowTime.getSeconds() + totalScheduled * 5);
            const yyyy = nowTime.getFullYear();
            const mm = String(nowTime.getMonth() + 1).padStart(2, '0');
            const dd = String(nowTime.getDate()).padStart(2, '0');
            const hh = String(nowTime.getHours()).padStart(2, '0');
            const min = String(nowTime.getMinutes()).padStart(2, '0');
            const ss = String(nowTime.getSeconds()).padStart(2, '0');
            scheduledAt = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
          } else {
            scheduledAt = `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
          }

          const finalCustomComment = commentId ? bulkCustomComment : (channel.comment_template || '');
          const commentStatus = finalCustomComment.trim() ? 'pending' : 'none';

          // Insert scheduled post
          const info = run(
            `INSERT INTO scheduled_posts (user_id, channel_id, title, description, tags, thumbnail_id, video_id, video_path, scheduled_at, custom_comment, is_premiere, status, privacy, comment_status)
             VALUES (@userId, @channelId, @title, @description, @tags, @thumbnailId, @videoId, @videoPath, @scheduledAt, @customComment, @isPremiere, 'pending', @privacy, @commentStatus)`,
            {
              userId,
              channelId,
              title: postTitle,
              description: postDesc,
              tags: postTags,
              thumbnailId,
              videoId: video.id,
              videoPath: video.filepath,
              scheduledAt,
              customComment: finalCustomComment,
              isPremiere: postIsPremiere,
              privacy: publishNow ? 'public' : (channel.upload_privacy || 'public'),
              commentStatus
            }
          );

          insertedPostIds.push(Number(info.lastInsertRowid));

          scheduledForChannel++;
          totalScheduled++;
        }

        results.push({
          channelId,
          channelName: channel.name,
          scheduledCount: scheduledForChannel
        });
      }

      return { totalScheduled, results, insertedPostIds };
    });

    const summary = executeBulkSchedule();

    // Trigger immediate background uploads sequentially to avoid concurrent browser session locks
    if (summary.insertedPostIds && summary.insertedPostIds.length > 0) {
      (async () => {
        for (const postId of summary.insertedPostIds) {
          const post = queryOne('SELECT * FROM scheduled_posts WHERE id = @id', { id: postId });
          if (post) {
            try {
              await processPost(post);
            } catch (err) {
              console.error(`[Scheduler] Bulk immediate process error for post ${postId}:`, err);
            }
          }
        }
      })();
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
