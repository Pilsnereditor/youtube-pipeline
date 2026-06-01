import { Router } from 'express';
import crypto from 'crypto';
import { queryAll, queryOne, run, insert } from '../db/database.js';

const router = Router();

// Helper to hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Middleware to check if user is admin
export function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.userRole !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
}

/**
 * POST /api/client/login
 * Authenticate a user via Email, Password, and License Key
 */
router.post('/login', (req, res) => {
  const { email, password, license_key } = req.body;

  if (!email || !password || !license_key) {
    return res.status(400).json({ error: 'Email, password, and license key are required.' });
  }

  try {
    const user = queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER(@email)', { email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email, password, or license key.' });
    }

    const inputHash = hashPassword(password);
    if (user.password_hash !== inputHash || user.license_key !== license_key) {
      return res.status(401).json({ error: 'Invalid email, password, or license key.' });
    }

    // Set session
    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.email = user.email;

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[Client Auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

/**
 * POST /api/client/logout
 * Destroy the current user session
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[Client Auth] Logout error:', err);
      return res.status(500).json({ error: 'Failed to log out.' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/**
 * GET /api/client/me
 * Get currently authenticated user details
 */
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false });
  }

  try {
    const user = queryOne('SELECT id, email, role, license_key FROM users WHERE id = @id', { id: req.session.userId });
    if (!user) {
      req.session.destroy();
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        license_key: user.license_key
      }
    });
  } catch (err) {
    console.error('[Client Auth] Fetch me error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/client/users
 * Admin only: List all users
 */
router.get('/users', requireAdmin, (req, res) => {
  try {
    const users = queryAll('SELECT id, email, license_key, role, created_at FROM users ORDER BY id ASC');
    res.json({ users });
  } catch (err) {
    console.error('[Client Auth] List users error:', err);
    res.status(500).json({ error: 'Failed to list users.' });
  }
});

/**
 * POST /api/client/users
 * Admin only: Create a new user
 */
router.post('/users', requireAdmin, (req, res) => {
  const { email, password, license_key, role } = req.body;

  if (!email || !password || !license_key) {
    return res.status(400).json({ error: 'Email, password, and license key are required.' });
  }

  const userRole = role === 'admin' ? 'admin' : 'user';

  try {
    const existing = queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER(@email)', { email });
    if (existing) {
      return res.status(400).json({ error: 'A user with this email already exists.' });
    }

    const password_hash = hashPassword(password);
    const userId = insert(
      'INSERT INTO users (email, password_hash, license_key, role) VALUES (@email, @password_hash, @license_key, @role)',
      { email, password_hash, license_key, role: userRole }
    );

    res.json({
      success: true,
      user: {
        id: userId,
        email,
        license_key,
        role: userRole
      }
    });
  } catch (err) {
    console.error('[Client Auth] Create user error:', err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

/**
 * DELETE /api/client/users/:id
 * Admin only: Delete a user profile
 */
router.delete('/users/:id', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);

  if (targetId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own admin account.' });
  }

  try {
    const result = run('DELETE FROM users WHERE id = @id', { id: targetId });
    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Client Auth] Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;
