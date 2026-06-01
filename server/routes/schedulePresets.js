import { Router } from 'express';
import { queryAll, queryOne, run, insert } from '../db/database.js';

const router = Router();

/**
 * GET /api/schedule-presets — List all schedule presets for the current user
 */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    const presets = queryAll('SELECT * FROM schedule_presets WHERE user_id = @userId ORDER BY created_at DESC', { userId });
    res.json(presets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/schedule-presets — Save a new schedule preset
 * Body: { name, time, days }
 */
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { name, time, days } = req.body;
  if (!name || !time) {
    return res.status(400).json({ error: 'name and time are required.' });
  }

  try {
    const id = Number(
      insert('INSERT INTO schedule_presets (user_id, name, time, days) VALUES (@userId, @name, @time, @days)', {
        userId,
        name: name.trim(),
        time: time.trim(),
        days: days ? days.trim() : 'everyday',
      })
    );
    const preset = queryOne('SELECT * FROM schedule_presets WHERE id = @id AND user_id = @userId', { id, userId });
    res.status(201).json(preset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/schedule-presets/:id — Delete a schedule preset
 */
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const result = run('DELETE FROM schedule_presets WHERE id = @id AND user_id = @userId', { id, userId });
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Schedule preset not found.' });
    }
    res.json({ message: 'Schedule preset deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
