import { Router } from 'express';
import { launchPipeline, getPipelineStatus, stopPipeline } from '../services/pipeline.js';
import { queryAll, queryOne } from '../db/database.js';

const router = Router();

// The broadcastFn is injected from server/index.js via the factory
let _broadcastFn = null;

/**
 * Factory to create the router with the broadcast function injected.
 */
export function createPipelineRouter(broadcastFn) {
  _broadcastFn = broadcastFn;
  return router;
}

/**
 * POST /api/pipeline/launch
 * Body: { channelIds: number[], videosPerChannel?: number }
 */
router.post('/launch', async (req, res) => {
  const userId = req.session.userId;
  const { channelIds, videosPerChannel } = req.body;

  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return res.status(400).json({ error: 'channelIds must be a non-empty array.' });
  }

  // Verify ownership of all requested channels
  for (const cid of channelIds) {
    const channel = queryOne('SELECT id FROM channels WHERE id = @id AND user_id = @userId', { id: cid, userId });
    if (!channel) {
      return res.status(403).json({ error: `Access denied. Channel ID ${cid} not found or does not belong to you.` });
    }
  }

  try {
    const result = await launchPipeline({ userId, channelIds, videosPerChannel: videosPerChannel || 1 }, _broadcastFn);
    res.json(result);
  } catch (err) {
    console.error('[Pipeline] Launch error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pipeline/status
 */
router.get('/status', (req, res) => {
  const userId = req.session.userId;
  try {
    const status = getPipelineStatus(userId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/pipeline/stop
 */
router.post('/stop', (req, res) => {
  const userId = req.session.userId;
  try {
    const result = stopPipeline(userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pipeline/history
 */
router.get('/history', (req, res) => {
  const userId = req.session.userId;
  try {
    const runs = queryAll('SELECT * FROM pipeline_runs WHERE user_id = @userId ORDER BY started_at DESC LIMIT 50', { userId });
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
