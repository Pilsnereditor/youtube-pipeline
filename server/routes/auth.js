import { Router } from 'express';
import { getAuthUrl, handleCallback } from '../services/youtube.js';
import { queryAll, queryOne, run } from '../db/database.js';

const router = Router();

/**
 * GET /api/auth/google
 * Redirect the user to Google's OAuth consent screen.
 * Query params:
 *   channelId — the local DB channel id to associate the tokens with.
 */
router.get('/google', (req, res) => {
  const userId = req.session.userId;
  const channelId = req.query.channelId;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId query parameter is required.' });
  }

  // Verify the channel exists and belongs to user
  const channel = queryOne('SELECT id FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found or access denied.' });
  }

  try {
    const url = getAuthUrl(Number(channelId));
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/callback
 * Handle the Google OAuth callback.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `OAuth error: ${error}` });
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state in callback.' });
  }

  const channelId = Number(state);

  try {
    await handleCallback(code, channelId);
    // Redirect to a success page or back to the dashboard
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Auth Success</title></head>
      <body>
        <h2>✅ YouTube account connected successfully!</h2>
        <p>You can close this window and return to the dashboard.</p>
        <script>
          if (window.opener) { window.opener.postMessage('oauth-success', '*'); window.close(); }
          else { setTimeout(() => { window.location.href = '/'; }, 2000); }
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error('[Auth] Callback error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/status
 * Return which channels have OAuth tokens stored.
 */
router.get('/status', (req, res) => {
  const userId = req.session.userId;
  try {
    const connected = queryAll(
      `SELECT c.id, c.name, c.youtube_channel_id, ot.expiry_date, ot.scope
       FROM channels c
       INNER JOIN oauth_tokens ot ON ot.channel_id = c.id
       WHERE c.user_id = @userId`,
       { userId }
    );
    res.json({ connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/disconnect/:channelId
 * Remove OAuth tokens for a channel (effectively revoking access locally).
 */
router.post('/disconnect/:channelId', (req, res) => {
  const userId = req.session.userId;
  const { channelId } = req.params;
  try {
    const channel = queryOne('SELECT id FROM channels WHERE id = @channelId AND user_id = @userId', { channelId, userId });
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found.' });
    }

    run('DELETE FROM oauth_tokens WHERE channel_id = @channelId', { channelId });
    run('UPDATE channels SET youtube_channel_id = NULL WHERE id = @channelId', { channelId });
    res.json({ message: 'Disconnected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
