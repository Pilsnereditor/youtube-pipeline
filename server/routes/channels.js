import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { queryAll, queryOne, run, insert } from '../db/database.js';
import { syncChannelWithYouTube } from '../services/youtube.js';
import { setupBrowserSession, checkBrowserSessionActive, closeBrowserSession } from '../services/puppet.js';
import { launchVncSession, isVncActive, getVncPort, getVncProfileName, getVncProfilePath, verifyVncChannels, stopVncSession } from '../services/vnc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export let broadcast = () => {};
export function setBroadcast(broadcastFn) {
  broadcast = broadcastFn;
}

const router = Router();

// ---------------------------------------------------------------------------
// Multer setup for thumbnail uploads
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'thumbnails');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .jpg, .jpeg, .png, and .webp files are allowed.'));
    }
  },
});

// Helper to verify channel ownership
function verifyChannel(channelId, userId) {
  return queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
}

// ---------------------------------------------------------------------------
// Channels CRUD
// ---------------------------------------------------------------------------

/** GET /api/channels — list all channels for the current user */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    const channels = queryAll(`
      SELECT c.*, 
             (SELECT COUNT(*) FROM oauth_tokens ot WHERE ot.channel_id = c.id) AS has_token,
             (SELECT COUNT(*) FROM titles t WHERE t.channel_id = c.id AND t.used = 0) AS unused_titles,
             (SELECT COUNT(*) FROM thumbnails th WHERE th.channel_id = c.id AND th.used = 0) AS unused_thumbnails,
             (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.video_id = v.id AND sp.status IN ('pending', 'processing', 'complete'))) AS unused_videos
      FROM channels c
      WHERE c.user_id = @userId
      ORDER BY c.created_at DESC
    `, { userId });

    const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');
    for (const ch of channels) {
      const profilePath = path.join(PROFILES_DIR, `channel_${ch.id}`);
      ch.has_profile = fs.existsSync(profilePath) ? 1 : 0;
    }

    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/channels — create a new channel for the current user */
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const id = Number(
      insert(
        `INSERT INTO channels (user_id, name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password)
         VALUES (@userId, @name, @niche, @description, @scheduleTime, @scheduleDays, @uploadPrivacy, @category, @commentTemplate, @uploadMode, @scheduleAsPremiere, @proxyType, @proxyHost, @proxyPort, @proxyUsername, @proxyPassword)`,
        {
          userId,
          name,
          niche: niche || '',
          description: description || '',
          scheduleTime: schedule_time || '10:00',
          scheduleDays: schedule_days || 'mon,wed,fri',
          uploadPrivacy: upload_privacy || 'private',
          category: category || '22',
          commentTemplate: comment_template || '',
          uploadMode: upload_mode || 'api',
          scheduleAsPremiere: schedule_as_premiere ? 1 : 0,
          proxyType: proxy_type || 'none',
          proxyHost: proxy_host || '',
          proxyPort: Number(proxy_port) || 0,
          proxyUsername: proxy_username || '',
          proxyPassword: proxy_password || ''
        },
      ),
    );
    const channel = queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id, userId });
    res.status(201).json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// YouTube Setup Wizard (Settings page — VNC-based remote browser)
// These routes MUST be defined before /:id routes to avoid Express param matching
// ---------------------------------------------------------------------------

/**
 * POST /api/channels/yt-setup/launch — Launch VNC session with Chrome for YouTube login
 * Body: { profileName?: string } — defaults to 'yt_setup_new' for fresh login
 */
router.post('/yt-setup/launch', async (req, res) => {
  try {
    const profileName = req.body.profileName || 'yt_setup_new';
    const result = await launchVncSession(profileName);
    res.json({ ...result, profileName });
  } catch (err) {
    console.error('[YT Setup] VNC launch error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/yt-setup/status — Check if VNC session is active
 */
router.get('/yt-setup/status', (req, res) => {
  res.json({ active: isVncActive(), ws_port: getVncPort() });
});

/**
 * POST /api/channels/yt-setup/verify — Connect to Chrome via CDP and verify channels
 */
router.post('/yt-setup/verify', async (req, res) => {
  const userId = req.session.userId;
  try {
    const result = await verifyVncChannels();
    const vncProfilePath = getVncProfilePath();
    const vncProfileName = getVncProfileName();
    
    // Create or update channels in the database
    const channelsCreated = [];
    
    for (const ch of result.channels) {
      if (!ch.name) continue;
      
      // Check for existing channel by youtube_channel_id first, then by name
      let existing = null;
      if (ch.ytChannelId) {
        existing = queryOne(
          'SELECT id FROM channels WHERE youtube_channel_id = @ytId AND user_id = @userId',
          { ytId: ch.ytChannelId, userId }
        );
      }
      if (!existing) {
        existing = queryOne(
          'SELECT id FROM channels WHERE name = @name AND user_id = @userId',
          { name: ch.name, userId }
        );
      }
      
      let channelId;
      if (existing) {
        run(
          'UPDATE channels SET upload_mode = @mode, youtube_channel_id = @ytId, name = @name WHERE id = @id',
          { mode: 'browser', ytId: ch.ytChannelId || null, name: ch.name, id: existing.id }
        );
        channelId = existing.id;
        channelsCreated.push({ id: existing.id, name: ch.name, action: 'updated' });
      } else {
        const result2 = run(
          `INSERT INTO channels (name, youtube_channel_id, user_id, upload_mode, upload_privacy, category) 
           VALUES (@name, @ytId, @userId, 'browser', 'private', '22')`,
          { name: ch.name, ytId: ch.ytChannelId || null, userId }
        );
        channelId = result2.lastInsertRowid;
        channelsCreated.push({ id: channelId, name: ch.name, action: 'created' });
      }

      // Copy the VNC Chrome profile to this channel's own profile directory
      // So each channel has independent login cookies for uploads
      const channelProfileDir = path.join(__dirname, '..', '..', 'data', 'profiles', `channel_${channelId}`);
      if (vncProfilePath && fs.existsSync(vncProfilePath)) {
        try {
          // If the VNC profile IS already the channel profile (re-login), skip copy
          if (vncProfileName !== `channel_${channelId}`) {
            if (fs.existsSync(channelProfileDir)) {
              fs.rmSync(channelProfileDir, { recursive: true, force: true });
            }
            fs.cpSync(vncProfilePath, channelProfileDir, { recursive: true });
          }
          // Remove Chrome lock files from the channel profile
          for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            const lf = path.join(channelProfileDir, lockFile);
            try { if (fs.existsSync(lf)) fs.unlinkSync(lf); } catch (e) {}
          }
          console.log(`[YT Setup] Profile saved for channel_${channelId} (${ch.name})`);
        } catch (copyErr) {
          console.warn(`[YT Setup] Profile copy failed for channel_${channelId}:`, copyErr.message);
        }
      }
    }
    
    res.json({ success: true, channels: channelsCreated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/yt-setup/close — Stop VNC session
 */
router.post('/yt-setup/close', async (req, res) => {
  try {
    await stopVncSession();
    res.json({ success: true, message: 'Browser session saved and closed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/channels/:id — update a channel */
router.put('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const existing = verifyChannel(id, userId);
  if (!existing) return res.status(404).json({ error: 'Channel not found.' });

  const { name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password } = req.body;

  try {
    run(
      `UPDATE channels SET
         name = @name,
         niche = @niche,
         description = @description,
         schedule_time = @scheduleTime,
         schedule_days = @scheduleDays,
         upload_privacy = @uploadPrivacy,
         category = @category,
         comment_template = @commentTemplate,
         upload_mode = @uploadMode,
         schedule_as_premiere = @scheduleAsPremiere,
         proxy_type = @proxyType,
         proxy_host = @proxyHost,
         proxy_port = @proxyPort,
         proxy_username = @proxyUsername,
         proxy_password = @proxyPassword
       WHERE id = @id AND user_id = @userId`,
      {
        name: name ?? existing.name,
        niche: niche ?? existing.niche,
        description: description ?? existing.description,
        scheduleTime: schedule_time ?? existing.schedule_time,
        scheduleDays: schedule_days ?? existing.schedule_days,
        uploadPrivacy: upload_privacy ?? existing.upload_privacy,
        category: category ?? existing.category,
        commentTemplate: comment_template ?? existing.comment_template,
        uploadMode: upload_mode ?? existing.upload_mode,
        scheduleAsPremiere: schedule_as_premiere !== undefined ? (schedule_as_premiere ? 1 : 0) : existing.schedule_as_premiere,
        proxyType: proxy_type ?? existing.proxy_type,
        proxyHost: proxy_host ?? existing.proxy_host,
        proxyPort: proxy_port !== undefined ? Number(proxy_port) : existing.proxy_port,
        proxyUsername: proxy_username ?? existing.proxy_username,
        proxyPassword: proxy_password ?? existing.proxy_password,
        id,
        userId,
      },
    );
    const updated = queryOne('SELECT * FROM channels WHERE id = @id AND user_id = @userId', { id, userId });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/channels/:id */
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const result = run('DELETE FROM channels WHERE id = @id AND user_id = @userId', { id, userId });
    if (result.changes === 0) return res.status(404).json({ error: 'Channel not found.' });
    res.json({ message: 'Channel deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** GET /api/channels/:id/titles */
router.get('/:id/titles', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const titles = queryAll('SELECT * FROM titles WHERE channel_id = @channelId ORDER BY created_at DESC', {
      channelId: id,
    });
    res.json(titles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/channels/:id/titles — import titles (JSON body with array of strings) */
router.post('/:id/titles', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  const { titles } = req.body; // array of strings
  if (!Array.isArray(titles) || titles.length === 0) {
    return res.status(400).json({ error: 'titles must be a non-empty array of strings.' });
  }

  try {
    const inserted = [];
    for (const text of titles) {
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      const rowId = Number(
        insert('INSERT INTO titles (channel_id, text) VALUES (@channelId, @text)', {
          channelId: id,
          text: text.trim(),
        }),
      );
      inserted.push({ id: rowId, text: text.trim() });
    }
    res.status(201).json({ imported: inserted.length, titles: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/channels/:id/titles — delete all titles for a channel */
router.delete('/:id/titles', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    run('DELETE FROM titles WHERE channel_id = @channelId', { channelId: id });
    res.json({ message: 'All titles deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/channels/:id/titles/:titleId — delete single title */
router.delete('/:id/titles/:titleId', (req, res) => {
  const userId = req.session.userId;
  const { id, titleId } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const result = run('DELETE FROM titles WHERE id = @titleId AND channel_id = @channelId', {
      titleId,
      channelId: id,
    });
    if (result.changes === 0) return res.status(404).json({ error: 'Title not found.' });
    res.json({ message: 'Title deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** POST /api/channels/:id/thumbnails — upload thumbnails (multipart) */
router.post('/:id/thumbnails', upload.array('thumbnails', 20), (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  try {
    const inserted = [];
    for (const file of req.files) {
      const rowId = Number(
        insert(
          'INSERT INTO thumbnails (user_id, channel_id, filename, filepath) VALUES (@userId, @channelId, @filename, @filepath)',
          {
            userId,
            channelId: id,
            filename: file.originalname,
            filepath: file.path,
          },
        ),
      );
      inserted.push({ id: rowId, filename: file.originalname, filepath: file.path });
    }
    res.status(201).json({ uploaded: inserted.length, thumbnails: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/channels/:id/thumbnails */
router.get('/:id/thumbnails', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const thumbs = queryAll('SELECT * FROM thumbnails WHERE channel_id = @channelId ORDER BY created_at DESC', {
      channelId: id,
    });
    res.json(thumbs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/channels/:id/thumbnails/:thumbId */
router.delete('/:id/thumbnails/:thumbId', (req, res) => {
  const userId = req.session.userId;
  const { id, thumbId } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const thumb = queryOne('SELECT * FROM thumbnails WHERE id = @thumbId AND channel_id = @channelId AND user_id = @userId', {
      thumbId,
      channelId: id,
      userId,
    });
    if (!thumb) return res.status(404).json({ error: 'Thumbnail not found.' });

    // Remove file from disk
    if (fs.existsSync(thumb.filepath)) {
      fs.unlinkSync(thumb.filepath);
    }

    run('DELETE FROM thumbnails WHERE id = @id AND user_id = @userId', { id: thumb.id, userId });
    res.json({ message: 'Thumbnail deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Upload history
// ---------------------------------------------------------------------------

/** GET /api/channels/:id/uploads */
router.get('/:id/uploads', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const uploads = queryAll('SELECT * FROM uploads WHERE channel_id = @channelId ORDER BY uploaded_at DESC', {
      channelId: id,
    });
    res.json(uploads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/:id/sync — Synchronize channel state with YouTube Studio
 */
router.post('/:id/sync', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found or does not belong to you.' });
  }

  try {
    const result = await syncChannelWithYouTube(Number(id));
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error(`[Sync] Error syncing channel ${id}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/:id/browser-login — Start remote browser login session
 */
router.post('/:id/browser-login', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    // Run browser login in the background with user-scoped WS broadcast function
    setupBrowserSession(Number(id), userId, broadcast).catch(err => {
      console.error(`[Puppet] Error in setupBrowserSession for channel ${id}:`, err);
    });
    res.json({ success: true, message: 'Browser session started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/:id/browser-login-finish — Verify login status and close browser session
 */
router.post('/:id/browser-login-finish', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const { activeSetupSessions } = await import('../services/puppet.js');
    const session = activeSetupSessions.get(Number(id));
    if (!session) {
      return res.status(400).json({ error: 'No active browser setup session found.' });
    }

    const page = session.page;
    const isLoggedIn = await page.evaluate(() => {
      return !!document.querySelector('.ytcpAppHeaderCreateIcon, ytcp-button#create-icon, [aria-label="Create"], [aria-label="Oluştur"]');
    });

    if (!isLoggedIn) {
      return res.status(400).json({ error: 'You are not logged in yet. Please log in to YouTube Studio first.' });
    }

    // Close session to save cookies and files
    await closeBrowserSession(Number(id));
    res.json({ success: true, message: 'Browser session saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/:id/browser-login-status — Check if login session is active
 */
router.get('/:id/browser-login-status', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    const active = await checkBrowserSessionActive(Number(id));
    
    // Check if user profile directory exists to determine setup status
    const profilePath = path.join(__dirname, '..', '..', 'data', 'profiles', `channel_${id}`);
    const setup = fs.existsSync(profilePath);

    res.json({ active, setup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/:id/browser-login-close — Force close login session
 */
router.post('/:id/browser-login-close', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  if (!verifyChannel(id, userId)) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  try {
    await closeBrowserSession(Number(id));
    res.json({ success: true, message: 'Browser session closed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
