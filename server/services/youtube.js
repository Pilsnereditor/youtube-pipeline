import { google } from 'googleapis';
import { getDb, queryOne, run, queryAll } from '../db/database.js';
import fs from 'fs';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/**
 * Create a fresh OAuth2 client from database settings or environment variables.
 * @param {number} [channelId] Optional local channel database ID to resolve user-specific credentials.
 */
export function createOAuth2Client(channelId = null) {
  let resolvedUserId = null;
  if (channelId) {
    const channel = queryOne("SELECT user_id FROM channels WHERE id = @channelId", { channelId });
    if (channel) {
      resolvedUserId = channel.user_id;
    }
  }

  let clientId = null;
  let clientSecret = null;

  if (resolvedUserId) {
    const userClientIdRow = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = 'google_client_id'", { userId: resolvedUserId });
    const userClientSecretRow = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = 'google_client_secret'", { userId: resolvedUserId });
    clientId = userClientIdRow?.value;
    clientSecret = userClientSecretRow?.value;
  }

  if (!clientId) {
    const clientIdRow = queryOne("SELECT value FROM settings WHERE key = 'google_client_id'");
    clientId = clientIdRow?.value || process.env.GOOGLE_CLIENT_ID;
  }
  if (!clientSecret) {
    const clientSecretRow = queryOne("SELECT value FROM settings WHERE key = 'google_client_secret'");
    clientSecret = clientSecretRow?.value || process.env.GOOGLE_CLIENT_SECRET;
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/callback';

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );
}

/**
 * Generate the Google consent-screen URL.
 * @param {number} channelDbId  The local DB id for the channel (passed as state).
 */
export function getAuthUrl(channelDbId) {
  const client = createOAuth2Client(channelDbId);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: SCOPES,
    state: String(channelDbId),
  });
}

/**
 * Exchange an authorization code for tokens and persist them.
 * @param {string} code  The code from the OAuth callback.
 * @param {number} channelId  The local DB channel id.
 * @returns {object} The token payload.
 */
export async function handleCallback(code, channelId) {
  const client = createOAuth2Client(channelId);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Try to fetch the YouTube channel ID so we can store it
  let youtubeChannelId = null;
  try {
    const yt = google.youtube({ version: 'v3', auth: client });
    const res = await yt.channels.list({ part: 'snippet', mine: true });
    if (res.data.items && res.data.items.length > 0) {
      youtubeChannelId = res.data.items[0].id;
      const channelTitle = res.data.items[0].snippet.title;
      // Update channel record with the real YouTube channel id / name
      run(
        `UPDATE channels SET youtube_channel_id = @ytId, name = CASE WHEN name = '' OR name = 'New Channel' THEN @title ELSE name END WHERE id = @id`,
        { ytId: youtubeChannelId, title: channelTitle, id: channelId },
      );
    }
  } catch {
    // Non-critical — we still save the tokens
  }

  // Upsert the token row
  const existing = queryOne('SELECT id FROM oauth_tokens WHERE channel_id = @channelId', { channelId });
  if (existing) {
    run(
      `UPDATE oauth_tokens SET access_token = @accessToken, refresh_token = COALESCE(@refreshToken, refresh_token), expiry_date = @expiryDate, scope = @scope WHERE channel_id = @channelId`,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiryDate: tokens.expiry_date || null,
        scope: tokens.scope || SCOPES.join(' '),
        channelId,
      },
    );
  } else {
    run(
      `INSERT INTO oauth_tokens (channel_id, access_token, refresh_token, expiry_date, scope) VALUES (@channelId, @accessToken, @refreshToken, @expiryDate, @scope)`,
      {
        channelId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiryDate: tokens.expiry_date || null,
        scope: tokens.scope || SCOPES.join(' '),
      },
    );
  }

  return tokens;
}

/**
 * Return an authenticated OAuth2 client for a channel, refreshing the token
 * if it has expired.
 */
export async function getAuthenticatedClient(channelId) {
  const tokenRow = queryOne('SELECT * FROM oauth_tokens WHERE channel_id = @channelId', { channelId });
  if (!tokenRow) {
    throw new Error(`No OAuth tokens found for channel ${channelId}. Please authenticate first.`);
  }

  const client = createOAuth2Client(channelId);
  client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.expiry_date,
  });

  // Refresh if expired
  if (tokenRow.expiry_date && Date.now() >= tokenRow.expiry_date - 60_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      run(
        `UPDATE oauth_tokens SET access_token = @accessToken, expiry_date = @expiryDate WHERE channel_id = @channelId`,
        {
          accessToken: credentials.access_token,
          expiryDate: credentials.expiry_date,
          channelId,
        },
      );
    } catch (err) {
      throw new Error(`Failed to refresh token for channel ${channelId}: ${err.message}`);
    }
  }

  return client;
}

/**
 * Refresh the token for a channel if it is near expiry.
 */
export async function refreshTokenIfNeeded(channelId) {
  await getAuthenticatedClient(channelId); // side-effect: refreshes and persists
}

/**
 * Upload a video to YouTube.
 * @param {number} channelId  DB channel id
 * @param {object} opts  { videoPath, title, description, tags, privacy, category, scheduledAt }
 * @returns {{ videoId: string }} The YouTube video id.
 */
export async function uploadVideo(channelId, { videoPath, title, description, tags, privacy, category, scheduledAt }) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });

  const requestBody = {
    snippet: {
      title,
      description: description || '',
      tags: tags || [],
      categoryId: category || channel?.category || '22',
    },
    status: {
      privacyStatus: privacy || channel?.upload_privacy || 'private',
    },
  };

  // If scheduledAt is provided and is in the future, set it as a scheduled publish time
  if (scheduledAt && new Date(scheduledAt).getTime() > Date.now() + 60 * 1000) {
    requestBody.status.privacyStatus = 'private';
    requestBody.status.publishAt = new Date(scheduledAt).toISOString();
  }

  const media = {
    body: fs.createReadStream(videoPath),
  };

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody,
    media,
  });

  return { videoId: res.data.id };
}

/**
 * Set a custom thumbnail for a video.
 */
export async function setThumbnail(channelId, videoId, thumbnailPath) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  await yt.thumbnails.set({
    videoId,
    media: {
      body: fs.createReadStream(thumbnailPath),
    },
  });
}

/**
 * Post a top-level comment on a video.
 */
export async function addComment(channelId, videoId, text) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  await yt.commentThreads.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: {
            textOriginal: text,
          },
        },
      },
    },
  });
}

/**
 * Fetch basic channel info from YouTube.
 */
export async function getChannelInfo(channelId) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  const res = await yt.channels.list({ part: ['snippet', 'statistics'], mine: true });
  if (!res.data.items || res.data.items.length === 0) {
    throw new Error('No channel found for this authenticated account.');
  }
  return res.data.items[0];
}

/**
 * Synchronize completed scheduled posts with YouTube Studio by checking if the videos still exist.
 * Any deleted videos are marked as 'cancelled' and their assets are reclaimed.
 * @param {number} channelId
 * @returns {Promise<{ synced: number, cancelled: number }>}
 */
export async function syncChannelWithYouTube(channelId) {
  // 1. Get authenticated YouTube client
  let auth;
  try {
    auth = await getAuthenticatedClient(channelId);
  } catch (err) {
    // If not authenticated, return 0 synced
    return { synced: 0, cancelled: 0 };
  }

  const yt = google.youtube({ version: 'v3', auth });

  // 2. Fetch completed scheduled posts for this channel that have a youtube_video_id
  const completedPosts = queryAll(
    `SELECT * FROM scheduled_posts 
     WHERE channel_id = @channelId AND status = 'complete' AND youtube_video_id IS NOT NULL`,
    { channelId }
  );

  if (completedPosts.length === 0) {
    return { synced: 0, cancelled: 0 };
  }

  // 3. Batch YouTube videos.list calls (max 50 per batch)
  const postMap = new Map();
  for (const post of completedPosts) {
    postMap.set(post.youtube_video_id, post);
  }

  const videoIds = Array.from(postMap.keys());
  const existingVideoIds = new Set();

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const response = await yt.videos.list({
      part: ['id'],
      id: batch,
    });

    if (response.data.items) {
      for (const item of response.data.items) {
        existingVideoIds.add(item.id);
      }
    }
  }

  // 4. Identify deleted videos, cancel them, and reclaim assets
  let cancelledCount = 0;
  for (const videoId of videoIds) {
    if (!existingVideoIds.has(videoId)) {
      const post = postMap.get(videoId);
      if (post) {
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
        // Mark post as cancelled
        run(`UPDATE scheduled_posts SET status = 'cancelled' WHERE id = @id`, { id: post.id });
        cancelledCount++;
      }
    }
  }

  return { synced: completedPosts.length, cancelled: cancelledCount };
}

/**
 * Update the scheduled publish time for a video.
 * @param {number} channelId
 * @param {string} videoId
 * @param {string} scheduledAt
 */
export async function updateVideoSchedule(channelId, videoId, scheduledAt) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  await yt.videos.update({
    part: ['status'],
    requestBody: {
      id: videoId,
      status: {
        privacyStatus: 'private',
        publishAt: new Date(scheduledAt).toISOString(),
      },
    },
  });
}

/**
 * Update or add a top-level comment on a video, deleting any old comments from the owner first.
 */
export async function updateOrAddComment(channelId, videoId, text) {
  const auth = await getAuthenticatedClient(channelId);
  const yt = google.youtube({ version: 'v3', auth });

  const channel = queryOne('SELECT youtube_channel_id FROM channels WHERE id = @channelId', { channelId });
  const ownerChannelId = channel ? channel.youtube_channel_id : null;

  let existingCommentId = null;

  try {
    const listRes = await yt.commentThreads.list({
      part: ['snippet'],
      videoId,
      maxResults: 100,
    });

    if (listRes.data.items) {
      for (const thread of listRes.data.items) {
        const topComment = thread.snippet.topLevelComment;
        const authorId = topComment.snippet.authorChannelId?.value;
        if (authorId && authorId === ownerChannelId) {
          existingCommentId = topComment.id;
          break;
        }
      }
    }
  } catch (err) {
    console.warn(`[YouTube API] Could not list comments for video ${videoId} (likely private/scheduled): ${err.message}`);
    throw err;
  }

  // Delete existing comment if found
  if (existingCommentId) {
    try {
      await yt.comments.delete({ id: existingCommentId });
      console.log(`[YouTube API] Deleted existing comment ${existingCommentId} on video ${videoId}`);
    } catch (err) {
      console.error(`[YouTube API] Failed to delete comment ${existingCommentId}:`, err.message);
      throw err;
    }
  }

  // Insert new comment if text is provided
  if (text && text.trim()) {
    try {
      await yt.commentThreads.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            videoId,
            topLevelComment: {
              snippet: {
                textOriginal: text,
              },
            },
          },
        },
      });
      console.log(`[YouTube API] Posted new comment on video ${videoId}`);
    } catch (err) {
      console.error(`[YouTube API] Failed to insert new comment on video ${videoId}:`, err.message);
      throw err;
    }
  }
}

