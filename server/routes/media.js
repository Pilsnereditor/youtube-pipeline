import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { queryAll, queryOne, run, insert } from '../db/database.js';
import { generateAIThumbnail, parseGameAndTitle } from '../services/thumbnail.js';
import { generateVideoMetadata } from '../services/gemini.js';

export let broadcast = () => {};
export function setBroadcast(broadcastFn) {
  broadcast = broadcastFn;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

/**
 * Decodes a Latin-1 garbled filename from browser multipart form-data to UTF-8.
 */
function decodeFilename(filename) {
  try {
    return Buffer.from(filename, 'latin1').toString('utf8');
  } catch {
    return filename;
  }
}

function sanitizeFilenameTitle(filename, niche, channelName) {
  const base = filename.replace(/\.[^/.]+$/, '').trim();
  if (/^[\d\s._-]+$/.test(base)) {
    return niche || channelName || 'New Video';
  }
  return base;
}


// ---------------------------------------------------------------------------
// Upload directories
// ---------------------------------------------------------------------------
const VIDEO_DIR = path.join(__dirname, '..', '..', 'data', 'videos');
const THUMB_DIR = path.join(__dirname, '..', '..', 'data', 'thumbnails');

for (const dir of [VIDEO_DIR, THUMB_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Multer: video uploads
// ---------------------------------------------------------------------------
const videoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, VIDEO_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    cb(null, `${unique}${ext}`);
  },
});

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'];
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files (.mp4, .mov, .avi, .mkv, .webm, .flv, .wmv) are allowed.'));
    }
  },
});

// ---------------------------------------------------------------------------
// Multer: thumbnail uploads
// ---------------------------------------------------------------------------
const thumbStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, THUMB_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded);
    cb(null, `${unique}${ext}`);
  },
});

const uploadThumbnail = multer({
  storage: thumbStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const decoded = decodeFilename(file.originalname);
    const ext = path.extname(decoded).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (.jpg, .jpeg, .png, .webp) are allowed.'));
    }
  },
});

// Helper to verify channel ownership
function verifyChannel(channelId, userId) {
  if (!channelId) return true;
  const channel = queryOne('SELECT id FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
  return !!channel;
}

// Fast metadata generation from filename using OpenAI chat (no video upload needed)
async function generateMetadataFromFilename(originalFilename, niche, apiKey) {
  const { gameName, videoTitle } = parseGameAndTitle(originalFilename);
  const titleHint = videoTitle || originalFilename.replace(/\.[^/.]+$/, '');
  const gameHint = gameName || niche || 'casino slot';

  if (!apiKey) {
    // Pure fallback: just use filename parts
    return {
      title: titleHint.slice(0, 99),
      description: `${gameHint} üzerinde heyecanlı bir video izleyin! ${titleHint}`,
      tags: [gameHint, niche, 'slot', 'casino', 'bonus', 'kazanç'].filter(Boolean).join(', '),
    };
  }

  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are a YouTube metadata expert for Turkish casino/slot gaming channels. Always respond with valid JSON only.'
      },
      {
        role: 'user',
        content: `Generate YouTube metadata for a Turkish slot game video.
Game: ${gameHint}
Title hint from filename: ${titleHint}
Channel niche: ${niche || 'casino slots'}

Return ONLY a JSON object with these keys:
- "title": Catchy Turkish YouTube title, max 90 characters, UPPERCASE style
- "description": Engaging Turkish description, 2-3 sentences
- "tags": Comma-separated tags in Turkish and English (10-15 tags)`
      }
    ],
    max_tokens: 400,
    response_format: { type: 'json_object' }
  });

  const https = await import('https');
  const responseData = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    let raw = '';
    const req = https.default.request(options, (res) => {
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Bad JSON from OpenAI chat: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (responseData.error) throw new Error('OpenAI chat error: ' + responseData.error.message);

  const result = JSON.parse(responseData.choices?.[0]?.message?.content || '{}');
  return {
    title: (result.title || titleHint).slice(0, 99),
    description: result.description || `${gameHint} oyununda büyük kazanç! ${titleHint}`,
    tags: result.tags || `${gameHint}, slot, casino, bonus, kazanç`,
  };
}

// Background metadata generator
async function generateMetadataForVideoAsync(videoId, channelId, userId, videoFilePath = null) {
  try {
    let niche = 'General';
    let channelName = '';
    if (channelId) {
      const channel = queryOne('SELECT name, niche, description FROM channels WHERE id = @channelId', { channelId });
      if (channel) {
        niche = channel.niche || channel.description || channel.name || 'General';
        channelName = channel.name || '';
      }
    }

    const video = queryOne('SELECT original_filename, filepath, thumbnail_id FROM videos WHERE id = @videoId', { videoId });
    if (!video) return;

    // Parse game name and title from filename (format: "Game - Title.mp4")
    const { gameName, videoTitle } = parseGameAndTitle(video.original_filename);
    if (gameName) console.log(`[Metadata Gen] Game detected: "${gameName}" | Title hint: "${videoTitle}"`);

    // Use sanitized filename or videoTitle, falling back to niche/channel if purely numeric
    const filenameTitle = sanitizeFilenameTitle(videoTitle || video.original_filename, niche, channelName).slice(0, 99);
    
    // Still generate description and tags via AI
    let metadata = null;
    let description = '';
    let tags = '';
    try {
      metadata = await generateVideoMetadata(video.original_filename, niche, userId, videoFilePath || video.filepath);
      description = metadata.description || '';
      tags = metadata.tags || '';
    } catch (metaErr) {
      console.warn(`[Metadata Gen] AI description/tags failed, using fallback:`, metaErr.message);
      description = `${niche} - ${filenameTitle}`;
      tags = `${niche}, video`;
    }

    run(
      `UPDATE videos SET title = @title, description = @description, tags = @tags WHERE id = @videoId`,
      { videoId, title: filenameTitle, description, tags }
    );

    console.log(`[Metadata Gen] ✅ Metadata saved for video ${videoId}: "${filenameTitle}"`);

    // 🎨 Generate full AI thumbnail with gpt-image-1 directly (no video frame extraction)
    try {
      console.log(`[Thumbnail AI] Starting gpt-image-1 generation for video ${videoId}...`);
      const filename = `ai_thumb_${videoId}_${Date.now()}.png`;
      const outputPath = path.join(THUMB_DIR, filename);

      await generateAIThumbnail(outputPath, (metadata && metadata.title) || filenameTitle, niche, gameName);

      // Register the generated thumbnail in the database
      const thumbnailId = Number(
        insert(
          `INSERT INTO thumbnails (user_id, channel_id, filename, filepath, used)
           VALUES (@userId, @channelId, @filename, @filepath, 0)`,
          { userId, channelId, filename, filepath: outputPath }
        )
      );

      // Link the thumbnail to the video
      run(
        `UPDATE videos SET thumbnail_id = @thumbnailId WHERE id = @videoId`,
        { thumbnailId, videoId }
      );

      console.log(`[Thumbnail AI] ✅ Thumbnail complete and linked to video ${videoId}`);
    } catch (thumbErr) {
      console.error(`[Thumbnail AI] Failed for video ${videoId}:`, thumbErr.message);
    }

    broadcast({ type: 'video_metadata_updated', videoId }, userId);

  } catch (err) {
    console.error(`[Metadata Gen] Failed for video ${videoId}:`, err);
    try {
      const video = queryOne('SELECT original_filename FROM videos WHERE id = @videoId', { videoId });
      if (video) {
        const { gameName: fbGame, videoTitle: fbTitle } = parseGameAndTitle(video.original_filename);
        const fallbackTitle = sanitizeFilenameTitle(fbTitle || video.original_filename, niche, channelName).slice(0, 99);
        run(
          `UPDATE videos SET title = @title, description = @description, tags = @tags WHERE id = @videoId`,
          {
            videoId,
            title: fallbackTitle,
            description: `${fbGame || niche} oyununda heyecanlı anlar!`,
            tags: `${fbGame || niche}, slot, casino, bonus`,
          }
        );
        // Still try to generate thumbnail with fallback title
        try {
          console.log(`[Thumbnail AI] Starting fallback gpt-image-1 generation for video ${videoId}...`);
          const filename = `ai_thumb_${videoId}_${Date.now()}.png`;
          const outputPath = path.join(THUMB_DIR, filename);
          const setting = queryOne("SELECT value FROM settings WHERE key = 'openai_api_key'");
          if (setting?.value) {
            await generateAIThumbnail(outputPath, fallbackTitle, niche, fbGame);
            
            const thumbnailId = Number(
              insert(
                `INSERT INTO thumbnails (user_id, channel_id, filename, filepath, used)
                 VALUES (@userId, @channelId, @filename, @filepath, 0)`,
                { userId, channelId, filename, filepath: outputPath }
              )
            );

            run(
              `UPDATE videos SET thumbnail_id = @thumbnailId WHERE id = @videoId`,
              { thumbnailId, videoId }
            );
            console.log(`[Thumbnail AI] ✅ Fallback thumbnail complete and linked to video ${videoId}`);
          }
        } catch (fbThumbErr) {
          console.error(`[Thumbnail AI] Fallback thumbnail failed for video ${videoId}:`, fbThumbErr.message);
        }
      }
    } catch (e) {
      console.error(`[Metadata Gen] Failed saving fallback for video ${videoId}:`, e);
    }
    broadcast({ type: 'video_metadata_updated', videoId }, userId);
  }
}


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Video endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/media/upload-video
 * Upload one or more video files.
 * Optional body field: channelId — associate the video with a channel.
 */
router.post('/upload-video', uploadVideo.array('videos', 10), (req, res) => {
  const userId = req.session.userId;
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No video files uploaded.' });
  }

  const channelId = req.body.channelId ? Number(req.body.channelId) : null;
  if (channelId && !verifyChannel(channelId, userId)) {
    return res.status(403).json({ error: 'Access denied. You do not own this channel.' });
  }

  try {
    const durations = req.body.durations ? JSON.parse(req.body.durations) : [];
    const inserted = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const duration = durations[i] || null;
      const decodedOriginalname = decodeFilename(file.originalname);
      const id = Number(
        insert(
          `INSERT INTO videos (user_id, channel_id, original_filename, filepath, filesize, mimetype, duration)
           VALUES (@userId, @channelId, @originalFilename, @filepath, @filesize, @mimetype, @duration)`,
          {
            userId,
            channelId,
            originalFilename: decodedOriginalname,
            filepath: file.path,
            filesize: file.size,
            mimetype: file.mimetype,
            duration,
          },
        ),
      );
      inserted.push({
        id,
        original_filename: decodedOriginalname,
        filepath: file.path,
        filesize: file.size,
        mimetype: file.mimetype,
        duration,
      });
    }

    res.status(201).json({ uploaded: inserted.length, videos: inserted });

    // Trigger metadata generation in background
    for (const item of inserted) {
      generateMetadataForVideoAsync(item.id, channelId, userId).catch(err => {
        console.error(`[Metadata Gen] Background trigger error for video ${item.id}:`, err);
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/media/videos
 * List all uploaded video files for the current user. Optional query: ?channelId=
 */
router.get('/videos', (req, res) => {
  const userId = req.session.userId;
  const channelId = req.query.channelId ? Number(req.query.channelId) : null;

  if (channelId && !verifyChannel(channelId, userId)) {
    return res.status(403).json({ error: 'Access denied. You do not own this channel.' });
  }

  try {
    let videos;
    if (channelId) {
      videos = queryAll(
        `SELECT v.*, c.name AS channel_name,
                EXISTS(SELECT 1 FROM scheduled_posts sp WHERE sp.video_id = v.id AND sp.status = 'complete') AS is_published
         FROM videos v
         LEFT JOIN channels c ON c.id = v.channel_id
         WHERE v.user_id = @userId AND v.channel_id = @channelId
         ORDER BY v.created_at DESC`,
        { userId, channelId },
      );
    } else {
      videos = queryAll(
        `SELECT v.*, c.name AS channel_name,
                EXISTS(SELECT 1 FROM scheduled_posts sp WHERE sp.video_id = v.id AND sp.status = 'complete') AS is_published
         FROM videos v
         LEFT JOIN channels c ON c.id = v.channel_id
         WHERE v.user_id = @userId
         ORDER BY v.created_at DESC`,
        { userId },
      );
    }
    res.json(videos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/media/videos/:id
 * Delete a video file from disk and DB.
 */
router.delete('/videos/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const video = queryOne('SELECT * FROM videos WHERE id = @id AND user_id = @userId', { id, userId });
    if (!video) return res.status(404).json({ error: 'Video not found.' });

    // Remove file from disk
    if (fs.existsSync(video.filepath)) {
      fs.unlinkSync(video.filepath);
    }

    run('DELETE FROM videos WHERE id = @id AND user_id = @userId', { id, userId });
    res.json({ message: 'Video deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Thumbnail endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/media/upload-thumbnail
 * Upload one or more thumbnail images.
 * Optional body field: channelId — associate the thumbnail with a channel.
 */
router.post('/upload-thumbnail', uploadThumbnail.array('thumbnails', 20), (req, res) => {
  const userId = req.session.userId;
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No thumbnail files uploaded.' });
  }

  const channelId = req.body.channelId ? Number(req.body.channelId) : null;
  if (channelId && !verifyChannel(channelId, userId)) {
    return res.status(403).json({ error: 'Access denied. You do not own this channel.' });
  }

  try {
    const inserted = [];
    for (const file of req.files) {
      const decodedOriginalname = decodeFilename(file.originalname);
      const id = Number(
        insert(
          `INSERT INTO thumbnails (user_id, channel_id, filename, filepath)
           VALUES (@userId, @channelId, @filename, @filepath)`,
          {
            userId,
            channelId,
            filename: decodedOriginalname,
            filepath: file.path,
          },
        ),
      );
      inserted.push({ id, filename: decodedOriginalname, filepath: file.path });
    }

    res.status(201).json({ uploaded: inserted.length, thumbnails: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/media/thumbnails
 * List all uploaded thumbnails for the current user. Optional query: ?channelId=
 */
router.get('/thumbnails', (req, res) => {
  const userId = req.session.userId;
  const channelId = req.query.channelId ? Number(req.query.channelId) : null;

  if (channelId && !verifyChannel(channelId, userId)) {
    return res.status(403).json({ error: 'Access denied. You do not own this channel.' });
  }

  try {
    let thumbs;
    if (channelId) {
      thumbs = queryAll(
        `SELECT * FROM thumbnails WHERE user_id = @userId AND channel_id = @channelId ORDER BY created_at DESC`,
        { userId, channelId },
      );
    } else {
      thumbs = queryAll('SELECT * FROM thumbnails WHERE user_id = @userId ORDER BY created_at DESC', { userId });
    }
    res.json(thumbs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/media/thumbnails/:id
 * Delete a thumbnail from disk and DB.
 */
router.delete('/thumbnails/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const thumb = queryOne('SELECT * FROM thumbnails WHERE id = @id AND user_id = @userId', { id, userId });
    if (!thumb) return res.status(404).json({ error: 'Thumbnail not found.' });

    if (fs.existsSync(thumb.filepath)) {
      fs.unlinkSync(thumb.filepath);
    }

    run('DELETE FROM thumbnails WHERE id = @id AND user_id = @userId', { id, userId });
    res.json({ message: 'Thumbnail deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/media/video-file/:id
 * Serve the video file by its ID (auth and user check).
 */
router.get('/video-file/:id', (req, res) => {
  const userId = req.session.userId;
  try {
    const video = queryOne('SELECT filepath FROM videos WHERE id = @id AND user_id = @userId', { id: req.params.id, userId });
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).send('Video file not found.');
    }
    res.sendFile(video.filepath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/media/thumbnail-file/:id
 * Serve the thumbnail file by its ID (auth and user check).
 */
router.get('/thumbnail-file/:id', (req, res) => {
  const userId = req.session.userId;
  try {
    const thumb = queryOne('SELECT filepath FROM thumbnails WHERE id = @id AND user_id = @userId', { id: req.params.id, userId });
    if (!thumb || !fs.existsSync(thumb.filepath)) {
      return res.status(404).send('Thumbnail file not found.');
    }
    res.sendFile(thumb.filepath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/media/videos/:id/regenerate
 * Trigger a metadata regeneration for a specific video manually.
 */
router.post('/videos/:id/regenerate', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    const video = queryOne('SELECT * FROM videos WHERE id = @id AND user_id = @userId', { id, userId });
    if (!video) return res.status(404).json({ error: 'Video not found.' });

    await generateMetadataForVideoAsync(video.id, video.channel_id, userId, video.filepath);

    const updatedVideo = queryOne('SELECT * FROM videos WHERE id = @id', { id });
    res.json({ message: 'Metadata regenerated.', video: updatedVideo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/media/videos/:id/duration
 * Dynamically save video duration if not already stored.
 */
router.post('/videos/:id/duration', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { duration } = req.body;
  try {
    run(
      'UPDATE videos SET duration = @duration WHERE id = @id AND user_id = @userId',
      { duration: parseFloat(duration), id: Number(id), userId }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/media/videos/:id/thumbnail
 * Upload a custom thumbnail for a specific video.
 */
router.post('/videos/:id/thumbnail', uploadThumbnail.single('thumbnail'), (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No thumbnail file uploaded.' });
  }

  try {
    // 1. Verify video exists and belongs to the user
    const video = queryOne('SELECT v.*, c.user_id FROM videos v INNER JOIN channels c ON c.id = v.channel_id WHERE v.id = @id AND c.user_id = @userId', { id: Number(id), userId });
    if (!video) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Video not found or access denied.' });
    }

    // 2. Register custom thumbnail in database
    const filename = file.filename;
    
    const thumbnailId = Number(
      insert(
        `INSERT INTO thumbnails (user_id, channel_id, filename, filepath, used, created_at)
         VALUES (@userId, @channelId, @filename, @filepath, 1, datetime('now'))`,
        {
          userId,
          channelId: video.channel_id,
          filename,
          filepath: file.path
        }
      )
    );

    // 3. Update video's thumbnail_id reference
    run('UPDATE videos SET thumbnail_id = @thumbnailId WHERE id = @id', { thumbnailId, id: Number(id) });

    // 4. Update any pending scheduled posts that use this video to use this custom thumbnail too
    run('UPDATE scheduled_posts SET thumbnail_id = @thumbnailId WHERE video_id = @id AND status = \'pending\'', { thumbnailId, id: Number(id) });

    // Notify clients of media list update
    broadcast({ type: 'media:updated', userId });

    res.json({ success: true, thumbnailId, filename });
  } catch (err) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/media/videos/:id — Update video metadata (title, description, tags)
 */
router.put('/videos/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, tags } = req.body;
  const userId = req.session.userId || 1;

  try {
    run(
      'UPDATE videos SET title = @title, description = @description, tags = @tags WHERE id = @id AND user_id = @userId',
      { title: title || '', description: description || '', tags: tags || '', id: Number(id), userId }
    );
    
    // Notify clients of media list update
    broadcast({ type: 'media:updated', userId });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
