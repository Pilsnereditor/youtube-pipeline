import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { queryAll, queryOne, run, insert } from '../db/database.js';
import { syncChannelWithYouTube, updateChannelBrandingAPI } from '../services/youtube.js';
import { setupBrowserSession, checkBrowserSessionActive, closeBrowserSession, updateChannelBrandingBrowser, syncChannelWithYouTubeBrowser } from '../services/puppet.js';
import { launchVncSession, isVncActive, getVncPort, getVncProfileName, getVncProfilePath, verifyVncChannels, stopVncSession, isLocalChrome } from '../services/vnc.js';

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

// ---------------------------------------------------------------------------
// Multer setup for branding uploads (logo / banner)
// ---------------------------------------------------------------------------
const BRANDING_DIR = path.join(__dirname, '..', '..', 'data', 'branding');
if (!fs.existsSync(BRANDING_DIR)) {
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
}

const brandingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BRANDING_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${unique}${ext}`);
  },
});

const uploadBranding = multer({
  storage: brandingStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .jpg, .jpeg, and .png files are allowed for branding.'));
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
      // Use profile_name (new system) with fallback to channel_{id} (legacy)
      const profileFolder = ch.profile_name || `channel_${ch.id}`;
      const profilePath = path.join(PROFILES_DIR, profileFolder);
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
  const { name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy_pool_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const id = Number(
      insert(
        `INSERT INTO channels (user_id, name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy_pool_id)
         VALUES (@userId, @name, @niche, @description, @scheduleTime, @scheduleDays, @uploadPrivacy, @category, @commentTemplate, @uploadMode, @scheduleAsPremiere, @proxyType, @proxyHost, @proxyPort, @proxyUsername, @proxyPassword, @proxyPoolId)`,
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
          proxyPassword: proxy_password || '',
          proxyPoolId: proxy_pool_id ? Number(proxy_pool_id) : null
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
// Chrome Profile Management
// ---------------------------------------------------------------------------

/**
 * GET /api/channels/profiles — List all Chrome profiles with login status
 */
router.get('/profiles', (req, res) => {
  const userId = req.session.userId;
  try {
    const profilesDir = path.join(__dirname, '..', '..', 'data', 'profiles');
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

    const dirs = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('profile_'))
      .map(d => {
        const profilePath = path.join(profilesDir, d.name);
        const hasCookies = fs.existsSync(path.join(profilePath, 'Default', 'Cookies'))
          || fs.existsSync(path.join(profilePath, 'Cookies'));
        const hasData = fs.readdirSync(profilePath).length > 0;
        // Extract label from folder name: profile_<userId>_MyName -> MyName
        const label = d.name.replace(new RegExp('^profile_' + userId + '_'), '').replace(/^profile_/, '');
        // Find linked channel
        const channel = queryOne(
          'SELECT id, name, youtube_channel_id FROM channels WHERE profile_name = @pname AND user_id = @userId',
          { pname: d.name, userId }
        );
        return {
          name: d.name,
          label,
          has_cookies: hasCookies,
          has_data: hasData,
          channel: channel || null
        };
      })
      // Only show this user's own profiles: per-user-prefixed dirs, or legacy dirs
      // linked to a channel this user owns. Never reveal other users' profiles.
      .filter(p => p.name.startsWith('profile_' + userId + '_') || p.channel);

    res.json({ profiles: dirs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/channels/profiles/create — Create a new named Chrome profile
 */
router.post('/profiles/create', (req, res) => {
  const userId = req.session.userId;
  const { name, proxy_pool_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

  const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  // Namespace profiles per user so two users picking the same name never collide
  // or end up pointed at each other's logged-in Chrome profile.
  const fullName = `profile_${userId}_${safeName}`;
  const profileDir = path.join(__dirname, '..', '..', 'data', 'profiles', fullName);

  if (fs.existsSync(profileDir)) {
    return res.status(409).json({ error: `Profile "${safeName}" already exists` });
  }

  fs.mkdirSync(profileDir, { recursive: true });

  // Save proxy pool ID setting for this profile
  if (proxy_pool_id) {
    try {
      run(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (@key, @value)",
        { key: `proxy_for_profile_${fullName}`, value: String(proxy_pool_id) }
      );
    } catch (err) {
      console.error('[DB] Error saving proxy setting for profile:', err);
    }
  }

  res.json({ success: true, name: fullName });
});

/**
 * POST /api/channels/profiles/delete — Delete a Chrome profile
 */
router.post('/profiles/delete', (req, res) => {
  const { name } = req.body;
  const userId = req.session.userId;
  if (!name) return res.status(400).json({ error: 'Profile name is required' });

  const profileDir = path.join(__dirname, '..', '..', 'data', 'profiles', name);
  if (!fs.existsSync(profileDir)) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
    // Unlink any channels using this profile
    run('UPDATE channels SET profile_name = NULL WHERE profile_name = @pname AND user_id = @userId',
      { pname: name, userId });
    
    // Delete proxy setting for this profile
    try {
      run("DELETE FROM settings WHERE key = @key", { key: `proxy_for_profile_${name}` });
    } catch (err) {
      console.error('[DB] Error deleting proxy setting for profile:', err);
    }

    res.json({ success: true });
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
    const userId = req.session.userId;
    const profileName = req.body.profileName || `yt_setup_${userId}`;
    const result = await launchVncSession(profileName, userId);
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
  const userId = req.session.userId;
  res.json({ 
    active: isVncActive(userId), 
    ws_port: getVncPort(userId),
    is_local_chrome: isLocalChrome(userId)
  });
});

/**
 * POST /api/channels/yt-setup/verify — Connect to Chrome via CDP and verify channels
 */
router.post('/yt-setup/verify', async (req, res) => {
  const userId = req.session.userId;
  const profileName = req.body && req.body.profileName ? req.body.profileName : getVncProfileName(userId);
  
  try {
    const result = await verifyVncChannels(userId);
    
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
      
      // Retrieve the proxy pool ID associated with this profile
      let vncProxyPoolId = null;
      try {
        const setting = queryOne("SELECT value FROM settings WHERE key = @key", { key: `proxy_for_profile_${profileName}` });
        if (setting && setting.value) {
          vncProxyPoolId = Number(setting.value);
        }
      } catch (err) {
        console.error('[DB] Error reading proxy setting for profile:', err);
      }

      let channelId;
      if (existing) {
        run(
          'UPDATE channels SET upload_mode = @mode, youtube_channel_id = @ytId, name = @name, profile_name = @profile, proxy_pool_id = COALESCE(proxy_pool_id, @proxyPoolId) WHERE id = @id',
          { mode: 'browser', ytId: ch.ytChannelId || null, name: ch.name, profile: profileName, proxyPoolId: vncProxyPoolId, id: existing.id }
        );
        channelId = existing.id;
        channelsCreated.push({ id: existing.id, name: ch.name, action: 'updated' });
      } else {
        const result2 = run(
          `INSERT INTO channels (name, youtube_channel_id, user_id, upload_mode, upload_privacy, category, profile_name, proxy_pool_id) 
           VALUES (@name, @ytId, @userId, 'browser', 'private', '22', @profile, @proxyPoolId)`,
          { name: ch.name, ytId: ch.ytChannelId || null, userId, profile: profileName, proxyPoolId: vncProxyPoolId }
        );
        channelId = result2.lastInsertRowid;
        channelsCreated.push({ id: channelId, name: ch.name, action: 'created' });
      }

      // Remove Chrome lock files from the profile directory 
      const profileDir = path.join(__dirname, '..', '..', 'data', 'profiles', profileName);
      if (fs.existsSync(profileDir)) {
        for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
          const lf = path.join(profileDir, lockFile);
          try { if (fs.existsSync(lf)) fs.unlinkSync(lf); } catch (e) {}
        }
      }
      console.log(`[YT Setup] Channel "${ch.name}" linked to profile "${profileName}"`);
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
    const userId = req.session.userId;
    await stopVncSession(userId);
    res.json({ success: true, message: 'Browser session saved and closed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/channels/:id — update a channel */
router.put('/:id', uploadBranding.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const existing = verifyChannel(id, userId);
  if (!existing) return res.status(404).json({ error: 'Channel not found.' });

  const { name, niche, description, schedule_time, schedule_days, upload_privacy, category, comment_template, upload_mode, schedule_as_premiere, proxy_type, proxy_host, proxy_port, proxy_username, proxy_password, proxy_pool_id } = req.body;

  const clearLogo = req.body.clear_logo === 'true' || req.body.clear_logo === true;
  const clearBanner = req.body.clear_banner === 'true' || req.body.clear_banner === true;

  const logoFile = req.files && req.files['logo'] ? req.files['logo'][0] : null;
  const bannerFile = req.files && req.files['banner'] ? req.files['banner'][0] : null;

  const logoPath = clearLogo ? null : (logoFile ? logoFile.path : existing.custom_logo_path);
  const bannerPath = clearBanner ? null : (bannerFile ? bannerFile.path : existing.custom_banner_path);

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
         proxy_password = @proxyPassword,
         proxy_pool_id = @proxyPoolId,
         custom_logo_path = @customLogoPath,
         custom_banner_path = @customBannerPath
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
        proxyPoolId: proxy_pool_id !== undefined ? (proxy_pool_id ? Number(proxy_pool_id) : null) : existing.proxy_pool_id,
        customLogoPath: logoPath,
        customBannerPath: bannerPath,
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

  const activePost = queryOne(
    `SELECT id FROM scheduled_posts WHERE channel_id = @id AND status = 'processing' LIMIT 1`,
    { id }
  );
  if (activePost) {
    return res.status(409).json({ error: 'Cannot perform sync operation while a video is currently uploading for this channel.' });
  }

  const channel = queryOne('SELECT upload_mode FROM channels WHERE id = @id', { id });

  try {
    let result;
    if (channel && channel.upload_mode === 'browser') {
      result = await syncChannelWithYouTubeBrowser(Number(id));
    } else {
      result = await syncChannelWithYouTube(Number(id));
    }
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
 * POST /api/channels/:id/sync-branding — Synchronize channel branding (logo, banner, description) with YouTube
 */
router.post('/:id/sync-branding', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  
  const channel = verifyChannel(id, userId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found or does not belong to you.' });
  }

  const activePost = queryOne(
    `SELECT id FROM scheduled_posts WHERE channel_id = @id AND status = 'processing' LIMIT 1`,
    { id }
  );
  if (activePost) {
    return res.status(409).json({ error: 'Cannot perform branding sync while a video is currently uploading for this channel.' });
  }

  try {
    let warning = null;

    if (channel.upload_mode === 'browser') {
      // Sync everything using Puppeteer browser automation
      await updateChannelBrandingBrowser(Number(id), {
        logoPath: channel.custom_logo_path,
        bannerPath: channel.custom_banner_path,
        description: channel.description
      });
    } else {
      // API Mode
      // Update description and banner via YouTube Data API
      await updateChannelBrandingAPI(Number(id), {
        description: channel.description,
        bannerPath: channel.custom_banner_path
      });

      // If a custom logo is uploaded
      if (channel.custom_logo_path) {
        // If a browser profile is linked, sync logo via Puppeteer
        if (channel.profile_name) {
          await updateChannelBrandingBrowser(Number(id), {
            logoPath: channel.custom_logo_path
          });
        } else {
          warning = 'YouTube Data API does not support updating profile logos. To sync the profile logo, please link a browser profile in settings.';
        }
      }
    }

    res.json({
      success: true,
      warning
    });
  } catch (err) {
    console.error(`[Branding Sync] Error syncing branding for channel ${id}:`, err);
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

  const activePost = queryOne(
    `SELECT id FROM scheduled_posts WHERE channel_id = @id AND status = 'processing' LIMIT 1`,
    { id }
  );
  if (activePost) {
    return res.status(409).json({ error: 'Cannot start setup browser session while a video is currently uploading for this channel.' });
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

router.get('/debug-db', (req, res) => {
  try {
    const channels = queryAll('SELECT id, name, youtube_channel_id, profile_name, upload_mode FROM channels');
    const scheduled = queryAll('SELECT id, channel_id, status, title, error_message, scheduled_at FROM scheduled_posts ORDER BY scheduled_at DESC LIMIT 20');
    const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');
    
    const channelStatus = channels.map(ch => {
      const profileFolder = ch.profile_name || `channel_${ch.id}`;
      const profilePath = path.join(PROFILES_DIR, profileFolder);
      const exists = fs.existsSync(profilePath);
      const hasCookies = exists && (
        fs.existsSync(path.join(profilePath, 'Default', 'Cookies')) || 
        fs.existsSync(path.join(profilePath, 'Cookies'))
      );
      return {
        ...ch,
        profile_folder: profileFolder,
        folder_exists: exists ? 1 : 0,
        has_cookies: hasCookies ? 1 : 0
      };
    });

    res.json({
      success: true,
      channels: channelStatus,
      recent_scheduled_posts: scheduled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/:id/logo-file — Serve the channel logo file
 */
router.get('/:id/logo-file', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const channel = verifyChannel(id, userId);
    if (!channel || !channel.custom_logo_path || !fs.existsSync(channel.custom_logo_path)) {
      return res.status(404).send('Logo file not found.');
    }
    res.sendFile(channel.custom_logo_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/:id/banner-file — Serve the channel banner file
 */
router.get('/:id/banner-file', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const channel = verifyChannel(id, userId);
    if (!channel || !channel.custom_banner_path || !fs.existsSync(channel.custom_banner_path)) {
      return res.status(404).send('Banner file not found.');
    }
    res.sendFile(channel.custom_banner_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
