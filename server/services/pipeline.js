import { queryAll, queryOne, run, insert } from '../db/database.js';
import { uploadVideo, setThumbnail, addComment } from './youtube.js';
import { uploadVideoBrowser, postCommentBrowser } from './puppet.js';
import { handlePostFailure } from './scheduler.js';

// Scope active runs by userId
const activeRuns = {}; // userId -> { id, status }
const cancelFlags = {}; // userId -> boolean

/**
 * Append a log line to the current pipeline run in the DB.
 */
function appendLog(runId, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  run(`UPDATE pipeline_runs SET log = log || @line WHERE id = @id`, { line, id: runId });
  console.log(`[Pipeline ${runId}] ${message}`);
}

/**
 * Launch a multi-channel upload pipeline.
 *
 * @param {object}   opts
 * @param {number}   opts.userId             The user ID launching the pipeline.
 * @param {number[]} opts.channelIds         Which channels to process.
 * @param {number}   opts.videosPerChannel   How many videos to upload per channel.
 * @param {Function} broadcastFn             WebSocket broadcast function.
 * @returns {object} The pipeline run record.
 */
export async function launchPipeline({ userId, channelIds, videosPerChannel = 1 }, broadcastFn) {
  const currentRun = activeRuns[userId];
  if (currentRun && ['preparing', 'uploading', 'commenting'].includes(currentRun.status)) {
    throw new Error('A pipeline is already running. Stop it first.');
  }

  cancelFlags[userId] = false;

  // Create a pipeline_runs row
  const runId = Number(
    insert(
      `INSERT INTO pipeline_runs (user_id, status, started_at, log)
       VALUES (@userId, 'preparing', datetime('now'), '')`,
      { userId },
    ),
  );

  activeRuns[userId] = { id: runId, status: 'preparing' };

  const broadcast = (payload) => {
    if (broadcastFn) broadcastFn({ type: 'pipeline:update', userId, runId, ...payload }, userId);
  };

  // Run asynchronously — don't await at call-site so the HTTP response returns immediately
  (async () => {
    try {
      appendLog(runId, `Pipeline started for channels: ${channelIds.join(', ')} (${videosPerChannel} video(s) each)`);
      broadcast({ status: 'preparing', message: 'Pipeline started' });

      // ----- PREPARING -----
      run(`UPDATE pipeline_runs SET status = 'preparing' WHERE id = @id`, { id: runId });
      activeRuns[userId].status = 'preparing';

      const channelPlans = [];
      for (const chId of channelIds) {
        if (cancelFlags[userId]) throw new Error('Pipeline cancelled by user');

        const channel = queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id: chId, userId });
        if (!channel) {
          appendLog(runId, `Channel ${chId} not found — skipping.`);
          continue;
        }

        // Gather unused titles
        const titles = queryAll(
          `SELECT * FROM titles WHERE channel_id = @chId AND used = 0 ORDER BY created_at ASC LIMIT @limit`,
          { chId, limit: videosPerChannel },
        );

        // Gather unused thumbnails
        const thumbnails = queryAll(
          `SELECT * FROM thumbnails WHERE channel_id = @chId AND used = 0 ORDER BY created_at ASC LIMIT @limit`,
          { chId, limit: videosPerChannel },
        );

        channelPlans.push({ channel, titles, thumbnails });
        appendLog(runId, `Channel "${channel.name}": ${titles.length} title(s), ${thumbnails.length} thumbnail(s) available`);
      }

      // ----- UPLOADING -----
      run(`UPDATE pipeline_runs SET status = 'uploading' WHERE id = @id`, { id: runId });
      activeRuns[userId].status = 'uploading';
      broadcast({ status: 'uploading', message: 'Uploading videos' });

      for (const plan of channelPlans) {
        const { channel, titles, thumbnails } = plan;

        for (let i = 0; i < videosPerChannel; i++) {
          if (cancelFlags[userId]) throw new Error('Pipeline cancelled by user');

          const title = titles[i];
          if (!title) {
            appendLog(runId, `Channel "${channel.name}": no more unused titles — skipping video ${i + 1}`);
            continue;
          }

          // Check if there's a scheduled post with a video_path for this channel
          const scheduledPost = queryOne(
            `SELECT * FROM scheduled_posts 
             WHERE channel_id = @chId AND user_id = @userId AND status = 'pending' 
             ORDER BY scheduled_at ASC LIMIT 1`,
            { chId: channel.id, userId },
          );

          if (!scheduledPost || !scheduledPost.video_path) {
            appendLog(runId, `Channel "${channel.name}": no pending scheduled post with a video file — skipping`);
            continue;
          }

          try {
            appendLog(runId, `Uploading "${title.text}" to channel "${channel.name}"...`);
            broadcast({ status: 'uploading', channel: channel.name, title: title.text });

            let tags = [];
            try {
              tags = scheduledPost.tags ? JSON.parse(scheduledPost.tags) : [];
            } catch {
              tags = scheduledPost.tags ? scheduledPost.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
            }

            let videoId = '';
            const thumb = thumbnails[i];

            if (channel.upload_mode === 'browser') {
              const result = await uploadVideoBrowser(channel.id, {
                videoPath: scheduledPost.video_path,
                title: title.text,
                description: scheduledPost.description || '',
                tags,
                privacy: channel.upload_privacy,
                category: channel.category,
                thumbnailPath: thumb ? thumb.filepath : null,
                isPremiere: scheduledPost.is_premiere || 0,
              }, (msg) => appendLog(runId, msg));
              videoId = result.videoId;
            } else {
              const result = await uploadVideo(channel.id, {
                videoPath: scheduledPost.video_path,
                title: title.text,
                description: scheduledPost.description || '',
                tags,
                privacy: channel.upload_privacy,
                category: channel.category,
              });
              videoId = result.videoId;
            }

            appendLog(runId, `Uploaded: ${videoId}`);

            // Mark title used
            run(`UPDATE titles SET used = 1 WHERE id = @id`, { id: title.id });

            // Set thumbnail if available
            if (thumb) {
              if (channel.upload_mode !== 'browser') {
                try {
                  await setThumbnail(channel.id, videoId, thumb.filepath);
                  appendLog(runId, `Thumbnail set for video ${videoId}`);
                } catch (err) {
                  appendLog(runId, `Thumbnail error for ${videoId}: ${err.message}`);
                }
              }
              run(`UPDATE thumbnails SET used = 1 WHERE id = @id`, { id: thumb.id });
            }

            // Record the upload
            run(
              `INSERT INTO uploads (channel_id, youtube_video_id, title, description, thumbnail_path, status, uploaded_at)
               VALUES (@chId, @videoId, @title, @desc, @thumb, 'complete', datetime('now'))`,
              {
                chId: channel.id,
                videoId,
                title: title.text,
                desc: scheduledPost.description || '',
                thumb: thumb ? thumb.filepath : null,
              },
            );

            // Mark the scheduled post as complete and record YouTube Video ID
            run(`UPDATE scheduled_posts SET status = 'complete', youtube_video_id = @videoId WHERE id = @id`, {
              videoId,
              id: scheduledPost.id
            });

            // ----- COMMENTING -----
            if (channel.comment_template) {
              run(`UPDATE pipeline_runs SET status = 'commenting' WHERE id = @id`, { id: runId });
              activeRuns[userId].status = 'commenting';
              broadcast({ status: 'commenting', channel: channel.name, videoId });

              try {
                const commentText = channel.comment_template
                  .replace(/\{title\}/gi, title.text)
                  .replace(/\{videoId\}/gi, videoId);
                
                if (channel.upload_mode === 'browser') {
                  await postCommentBrowser(channel.id, videoId, commentText);
                } else {
                  await addComment(channel.id, videoId, commentText);
                }
                
                run(`UPDATE scheduled_posts SET comment_status = 'posted' WHERE id = @id`, { id: scheduledPost.id });
                appendLog(runId, `Comment posted on ${videoId}`);
              } catch (err) {
                run(`UPDATE scheduled_posts SET comment_status = 'pending' WHERE id = @id`, { id: scheduledPost.id });
                appendLog(runId, `Comment error on ${videoId} (scheduled for retry when public): ${err.message}`);
              }
            }
          } catch (err) {
            appendLog(runId, `Upload error for "${title.text}": ${err.message}`);
            run(
              `INSERT INTO uploads (channel_id, title, status, error_message, uploaded_at)
               VALUES (@chId, @title, 'error', @err, datetime('now'))`,
              { chId: channel.id, title: title.text, err: err.message },
            );
            handlePostFailure(scheduledPost, err.message);
          }
        }
      }

      // ----- COMPLETE -----
      run(`UPDATE pipeline_runs SET status = 'complete', completed_at = datetime('now') WHERE id = @id`, { id: runId });
      activeRuns[userId].status = 'complete';
      appendLog(runId, 'Pipeline completed successfully.');
      broadcast({ status: 'complete', message: 'Pipeline finished' });
    } catch (err) {
      const finalStatus = cancelFlags[userId] ? 'cancelled' : 'error';
      run(`UPDATE pipeline_runs SET status = @status, completed_at = datetime('now') WHERE id = @id`, {
        status: finalStatus,
        id: runId,
      });
      activeRuns[userId].status = finalStatus;
      appendLog(runId, `Pipeline ${finalStatus}: ${err.message}`);
      broadcast({ status: finalStatus, message: err.message });
    }
  })();

  return { runId, status: 'preparing' };
}

/**
 * Get the current pipeline status for a user.
 */
export function getPipelineStatus(userId) {
  const currentRun = activeRuns[userId];
  if (!currentRun) {
    // Look up the last run from database
    const row = queryOne('SELECT * FROM pipeline_runs WHERE user_id = @userId ORDER BY started_at DESC LIMIT 1', { userId });
    return row || { status: 'idle', runId: null };
  }
  const row = queryOne('SELECT * FROM pipeline_runs WHERE id = @id AND user_id = @userId', { id: currentRun.id, userId });
  return row || { status: 'idle', runId: null };
}

/**
 * Stop / cancel the currently running pipeline for a user.
 */
export function stopPipeline(userId) {
  const currentRun = activeRuns[userId];
  if (!currentRun || !['preparing', 'uploading', 'commenting'].includes(currentRun.status)) {
    return { message: 'No active pipeline to stop.' };
  }
  cancelFlags[userId] = true;
  return { message: 'Pipeline cancel requested.', runId: currentRun.id };
}
