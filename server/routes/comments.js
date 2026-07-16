import { Router } from 'express';
import { queryAll, queryOne, run, insert } from '../db/database.js';

const router = Router();

/**
 * GET /api/comments — List all saved comments for the current user
 */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    const comments = queryAll('SELECT * FROM saved_comments WHERE user_id = @userId ORDER BY created_at DESC', { userId });
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/comments — Save a new comment template
 * Body: { title, text }
 */
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { title, text } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: 'title and text are required.' });
  }

  try {
    const id = Number(
      insert('INSERT INTO saved_comments (user_id, title, text) VALUES (@userId, @title, @text)', {
        userId,
        title: title.trim(),
        text: text.trim(),
      })
    );
    const comment = queryOne('SELECT * FROM saved_comments WHERE id = @id AND user_id = @userId', { id, userId });
    res.status(201).json(comment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/comments/:id — Delete a saved comment template
 */
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const result = run('DELETE FROM saved_comments WHERE id = @id AND user_id = @userId', { id, userId });
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Comment template not found.' });
    }
    res.json({ message: 'Comment template deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/comments/:id — Update an existing comment template
 * Body: { title, text }
 */
router.put('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { title, text } = req.body;
  if (!title || !text) {
    return res.status(400).json({ error: 'title and text are required.' });
  }
  try {
    const result = run(
      'UPDATE saved_comments SET title = @title, text = @text WHERE id = @id AND user_id = @userId',
      { id, userId, title: title.trim(), text: text.trim() }
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Comment template not found.' });
    }
    const comment = queryOne('SELECT * FROM saved_comments WHERE id = @id AND user_id = @userId', { id, userId });
    res.json(comment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
