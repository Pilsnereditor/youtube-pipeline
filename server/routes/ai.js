import { Router } from 'express';
import { generateTitles, generateDescription, generateTags, cloneChannelStrategy } from '../services/gemini.js';
import { queryOne, insert } from '../db/database.js';

const router = Router();

/**
 * POST /api/ai/generate-titles
 * Body: { channelId, count?, customPrompt? }
 */
router.post('/generate-titles', async (req, res) => {
  const userId = req.session.userId;
  const { channelId, count, customPrompt, videoContext } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: 'channelId is required.' });
  }

  // Scope to current user
  const channel = queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  const resolvedNiche = channel.niche || channel.description || channel.name || 'General';

  try {
    const titles = await generateTitles(resolvedNiche, count || 10, customPrompt || '', userId, videoContext || '');

    // Persist generated titles to the titles table
    const saved = [];
    for (const text of titles) {
      const id = Number(
        insert('INSERT INTO titles (channel_id, text) VALUES (@channelId, @text)', {
          channelId: channel.id,
          text,
        }),
      );
      saved.push({ id, text });
    }

    res.json({ titles: saved });
  } catch (err) {
    console.error('[AI] generate-titles error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/generate-description
 * Body: { title, niche }
 */
router.post('/generate-description', async (req, res) => {
  const userId = req.session.userId;
  const { title, niche } = req.body;

  if (!title || !niche) {
    return res.status(400).json({ error: 'title and niche are required.' });
  }

  try {
    const description = await generateDescription(title, niche, userId);
    res.json({ description });
  } catch (err) {
    console.error('[AI] generate-description error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/generate-tags
 * Body: { title, niche }
 */
router.post('/generate-tags', async (req, res) => {
  const userId = req.session.userId;
  const { title, niche } = req.body;

  if (!title || !niche) {
    return res.status(400).json({ error: 'title and niche are required.' });
  }

  try {
    const tags = await generateTags(title, niche, userId);
    res.json({ tags });
  } catch (err) {
    console.error('[AI] generate-tags error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/clone-strategy
 * Body: { youtubeUrl, titleCount?, promptCount? }
 */
router.post('/clone-strategy', async (req, res) => {
  const userId = req.session.userId;
  const { youtubeUrl, titleCount, promptCount } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'youtubeUrl is required.' });
  }

  try {
    const strategy = await cloneChannelStrategy(youtubeUrl, titleCount || 10, promptCount || 5, userId);
    res.json(strategy);
  } catch (err) {
    console.error('[AI] clone-strategy error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
