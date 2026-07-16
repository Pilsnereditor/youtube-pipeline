import { Router } from 'express';
import { queryOne, run } from '../db/database.js';
import { listStudioDraftsBrowser, scheduleStudioDraftBrowser, rescheduleVideoBrowser, withChannelLock } from '../services/puppet.js';

const router = Router();

function ownsChannel(channelId, userId) {
  return !!queryOne('SELECT id FROM channels WHERE id = @channelId AND user_id = @userId', { channelId, userId });
}

/**
 * GET /api/studio/:channelId/drafts
 * List videos already on the channel's YouTube Studio that still need scheduling.
 */
router.get('/:channelId/drafts', async (req, res) => {
  const userId = req.session.userId;
  const channelId = Number(req.params.channelId);
  if (!ownsChannel(channelId, userId)) {
    return res.status(404).json({ error: 'Channel not found or does not belong to you.' });
  }
  const channel = queryOne('SELECT upload_mode FROM channels WHERE id = @id', { id: channelId });
  if (channel && channel.upload_mode !== 'browser') {
    return res.status(400).json({ error: 'Studio drafts are only available for browser-mode (puppet) channels.' });
  }
  try {
    const drafts = await withChannelLock(channelId, () => listStudioDraftsBrowser(channelId));
    res.json(Array.isArray(drafts) ? drafts : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/studio/:channelId/schedule
 * Schedule an existing Studio video (by id) via the edit-page path, and record it so the
 * auto-comment posts through the normal pending-comment flow. Does NOT re-upload the file.
 * Body: { videoId, title, scheduledAt, isPremiere, comment }
 */
router.post('/:channelId/schedule', async (req, res) => {
  const userId = req.session.userId;
  const channelId = Number(req.params.channelId);
  const { videoId, title, scheduledAt, isPremiere, comment, status } = req.body;

  if (!ownsChannel(channelId, userId)) {
    return res.status(404).json({ error: 'Channel not found or does not belong to you.' });
  }
  if (!videoId || !scheduledAt) {
    return res.status(400).json({ error: 'videoId and scheduledAt are required.' });
  }

  const prem = isPremiere ? 1 : 0;

  // 1) Apply the schedule on YouTube (no re-upload). A DRAFT has no Visibility control on its edit
  //    page, so it must go through the "Edit draft" wizard; other videos use the edit-page path. If
  //    the edit-page path fails because the Visibility control isn't present, fall back to the wizard.
  try {
    if (status === 'draft') {
      await withChannelLock(channelId, () => scheduleStudioDraftBrowser(channelId, videoId, scheduledAt, prem, console.log));
    } else {
      try {
        await withChannelLock(channelId, () => rescheduleVideoBrowser(channelId, videoId, scheduledAt, prem, null));
      } catch (editErr) {
        if (/visibility trigger|visibility editor|not editable/i.test(editErr.message || '')) {
          console.warn('[Studio] Edit-page schedule failed (likely a draft); trying the Edit-draft wizard:', editErr.message);
          await withChannelLock(channelId, () => scheduleStudioDraftBrowser(channelId, videoId, scheduledAt, prem, console.log));
        } else {
          throw editErr;
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to schedule on YouTube: ' + err.message });
  }

  // 2) Record/refresh a scheduled_posts row so the auto-comment posts via the normal flow and the
  //    video shows up in the Schedule tab. status='complete' so the uploader never re-processes it.
  try {
    const commentText = (comment || '').trim();
    const commentStatus = commentText ? 'pending' : 'none';
    const existing = queryOne(
      'SELECT id FROM scheduled_posts WHERE channel_id = @channelId AND youtube_video_id = @videoId',
      { channelId, videoId }
    );
    if (existing) {
      run(
        `UPDATE scheduled_posts
         SET scheduled_at = @scheduledAt, is_premiere = @prem, custom_comment = @comment,
             comment_status = @commentStatus, status = 'complete', error_message = NULL
         WHERE id = @id`,
        { id: existing.id, scheduledAt, prem, comment: commentText, commentStatus }
      );
    } else {
      run(
        `INSERT INTO scheduled_posts
           (user_id, channel_id, youtube_video_id, title, scheduled_at, custom_comment, is_premiere, status, comment_status)
         VALUES (@userId, @channelId, @videoId, @title, @scheduledAt, @comment, @prem, 'complete', @commentStatus)`,
        { userId, channelId, videoId, title: (title || 'Scheduled from Studio'), scheduledAt, comment: commentText, prem, commentStatus }
      );
    }
  } catch (err) {
    return res.json({ ok: true, warning: 'Scheduled on YouTube, but failed to record the comment/tracking: ' + err.message });
  }

  res.json({ ok: true });
});

export default router;
