import { Router } from 'express';
import { queryAll, queryOne, run } from '../db/database.js';
import { runWeeklyCleanup } from '../services/videoCleanup.js';

const router = Router();

/**
 * GET /api/settings — get all settings as a key-value object (user scoped)
 */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    // Start with global defaults
    const rows = queryAll('SELECT key, value FROM settings');
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    // Override with user-specific settings
    const userRows = queryAll('SELECT key, value FROM user_settings WHERE user_id = @userId', { userId });
    for (const row of userRows) {
      settings[row.key] = row.value;
    }

    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/settings — update user settings
 * Body: { key: value, key2: value2, ... }
 *
 * Uses UPSERT semantics inside user_settings.
 */
router.put('/', (req, res) => {
  const userId = req.session.userId;
  const updates = req.body;

  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Body must be a JSON object of key-value pairs.' });
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      run(
        `INSERT INTO user_settings (user_id, key, value) VALUES (@userId, @key, @value)
         ON CONFLICT(user_id, key) DO UPDATE SET value = @value`,
        { userId, key, value: String(value) },
      );
    }

    // Return combined settings
    const rows = queryAll('SELECT key, value FROM settings');
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    const userRows = queryAll('SELECT key, value FROM user_settings WHERE user_id = @userId', { userId });
    for (const row of userRows) {
      settings[row.key] = row.value;
    }

    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings/status — user dashboard stats check
 */
router.get('/status', (req, res) => {
  const userId = req.session.userId;
  try {
    const channelCount = queryOne('SELECT COUNT(*) AS count FROM channels WHERE user_id = @userId', { userId })?.count || 0;
    const connectedCount =
      queryOne(
        `SELECT COUNT(DISTINCT c.id) AS count
         FROM channels c
         INNER JOIN oauth_tokens ot ON ot.channel_id = c.id
         WHERE c.user_id = @userId`,
        { userId },
      )?.count || 0;
    const pendingPosts = queryOne("SELECT COUNT(*) AS count FROM scheduled_posts WHERE status = 'pending' AND user_id = @userId", { userId })?.count || 0;
    
    // Count uploads associated with channels belonging to this user
    const totalUploads = queryOne(
      `SELECT COUNT(*) AS count 
       FROM uploads up 
       INNER JOIN channels c ON c.id = up.channel_id 
       WHERE c.user_id = @userId`,
      { userId }
    )?.count || 0;

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      channels: channelCount,
      connectedChannels: connectedCount,
      pendingScheduledPosts: pendingPosts,
      totalUploads,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/settings/cleanup — manually trigger video cleanup
 */
router.post('/cleanup', async (req, res) => {
  const userId = req.session.userId;
  try {
    const deletedCount = await runWeeklyCleanup(userId);
    res.json({ success: true, deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
