import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import { insert, run, queryOne } from '../db/database.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const THUMB_DIR = path.join(__dirname, '..', '..', 'data', 'thumbnails');

if (!fs.existsSync(THUMB_DIR)) {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// ─────────────────────────────────────────────
// Filename Parser: "Game Name - Video Title"
// ─────────────────────────────────────────────

/**
 * Parses a video filename into gameName and videoTitle.
 * Expects format: "Game Name - Video Title.mp4"
 * Falls back gracefully if no " - " separator found.
 */
export function parseGameAndTitle(filename) {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '').trim();
  const dashIndex = nameWithoutExt.indexOf(' - ');

  if (dashIndex > 0) {
    return {
      gameName: nameWithoutExt.substring(0, dashIndex).trim(),
      videoTitle: nameWithoutExt.substring(dashIndex + 3).trim(),
    };
  }

  return { gameName: null, videoTitle: nameWithoutExt };
}

// ─────────────────────────────────────────────
// Title line splitter for the AI prompt
// ─────────────────────────────────────────────

function splitTitle(title) {
  const words = title.trim().toUpperCase().split(/\s+/);

  if (words.length <= 2) {
    return words.length === 1 ? [words[0]] : [words[0], words[1]];
  }
  if (words.length <= 4) {
    const half = Math.ceil(words.length / 2);
    return [words.slice(0, half).join(' '), words.slice(half).join(' ')];
  }
  const third = Math.ceil(words.length / 3);
  return [
    words.slice(0, third).join(' '),
    words.slice(third, third * 2).join(' '),
    words.slice(third * 2).join(' '),
  ];
}

// ─────────────────────────────────────────────
// FFmpeg Image Resize (1536x1024 → 1280x720)
// ─────────────────────────────────────────────

function resizeImage(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-vf', 'scale=1280:720', '-frames:v', '1'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ─────────────────────────────────────────────
// gpt-image-1: Full Thumbnail (text + background)
// ─────────────────────────────────────────────

/**
 * Uses gpt-image-1 to generate a complete YouTube thumbnail —
 * background scene AND text overlay — in one single API call.
 * Resizes the result from 1536x1024 to 1280x720 using ffmpeg.
 *
 * @param {string} outputPath  - Where to save the final PNG.
 * @param {string} title       - Video title (will appear as text on thumbnail).
 * @param {string} niche       - Channel niche for background context.
 * @param {string|null} gameName - Game name parsed from filename for themed background.
 */
export async function generateAIThumbnail(outputPath, title, niche = 'General', gameName = null) {
  const setting = queryOne("SELECT value FROM settings WHERE key = 'openai_api_key'");
  const apiKey = setting?.value || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured in Settings.');

  // Split title into display lines for the prompt
  const lines = splitTitle(title);
  const lineCount = lines.length;

  // Default color palette: yellow / white / yellow
  let lineColors = ['bright yellow (#FFE500)', 'pure white (#FFFFFF)', 'bright yellow (#FFE500)'];
  let outlineColor = 'VERY thick dark red (#8B0000) outline of at least 8-10px';
  let shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (dark red/maroon), giving extreme depth like a comic book';
  
  // Default background: casino theme with purple gradient and flying gold coins/chips/dice
  let backgroundStyle = `- Deep dark purple gradient background (#0a0015 → #2a0050)
- Bright purple/magenta radial light burst emanating from behind the text
- Golden sparkles, star particles, light rays
- Multiple shiny 3D red dice with white dots, tumbling at various angles, some large in foreground (slightly blurred), some smaller in background
- Gold coins and casino chips flying everywhere at different depths
- Dramatic volumetric god-rays lighting from center
- Rich depth of field blur effect on foreground elements
- Ultra vivid, oversaturated casino colors`;

  if (gameName) {
    const lowerGame = gameName.toLowerCase();
    
    // Dynamic game themes mapping
    if (lowerGame.includes('bass') || lowerGame.includes('fish')) {
      lineColors = ['bright neon green (#39FF14)', 'pure white (#FFFFFF)', 'bright neon green (#39FF14)'];
      outlineColor = 'VERY thick dark blue (#000080) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (dark blue/navy)';
      backgroundStyle = `- Underwater ocean background theme, with deep blue and aqua-green water gradients
- Floating bubbles, colorful coral reefs, and silhouette of cartoon fish in the background
- Volumetric underwater god-rays piercing through the water surface
- Bright light glow emanating from behind the text
- Golden coins and bubbles floating at different depths (with foreground depth of field blur)
- Rich, highly saturated maritime gaming atmosphere`;
    } else if (lowerGame.includes('sweet') || lowerGame.includes('candy') || lowerGame.includes('bonanza')) {
      lineColors = ['bright hot pink (#FF69B4)', 'pure white (#FFFFFF)', 'bright cyan (#00FFFF)'];
      outlineColor = 'VERY thick dark purple (#4B0082) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (deep purple)';
      backgroundStyle = `- Vibrant candy land background theme with giant lollipops, colorful gummy bears, and candy mountains
- Fluffy pink and pastel cotton candy clouds
- Bright radial light burst and star sparkles behind the text
- Rainbow candies, chocolate stars, and gold coins tumbling at different depths (with foreground depth of field blur)
- Playful, ultra-colorful, sugary gaming atmosphere`;
    } else if (lowerGame.includes('olympus') || lowerGame.includes('zeus') || lowerGame.includes('gates')) {
      lineColors = ['metallic gold (#FFD700)', 'pure white (#FFFFFF)', 'metallic gold (#FFD700)'];
      outlineColor = 'VERY thick dark blue (#0b1d3a) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (dark navy/indigo)';
      backgroundStyle = `- Epic ancient Greek temple background theme with marble pillars and dramatic clouds
- Crackling blue and gold lightning bolts strike from the sky
- Majestic warm gold radial light burst behind the text
- Golden sparkles, energy particles, and gold coins flying at different depths (with foreground depth of field blur)
- Powerful, divine, high-stakes casino atmosphere`;
    } else if (lowerGame.includes('cleopatra') || lowerGame.includes('egypt') || lowerGame.includes('book of') || lowerGame.includes('ra')) {
      lineColors = ['bright gold (#FFD700)', 'pure white (#FFFFFF)', 'bright amber (#FFBF00)'];
      outlineColor = 'VERY thick deep obsidian cyan (#005f73) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (dark obsidian)';
      backgroundStyle = `- Ancient Egyptian tomb or temple background theme with gold hieroglyphs on sandstone walls
- Glowing blue/cyan magical energy lines
- Volumetric sand dust particles, golden scarabs, and gold coins flying at different depths
- Warm golden radial sunburst behind the text
- Rich, mysterious, treasure-filled gaming atmosphere`;
    } else if (lowerGame.includes('wild') || lowerGame.includes('west') || lowerGame.includes('dead') || lowerGame.includes('wanted')) {
      lineColors = ['bright yellow (#FFE500)', 'pure white (#FFFFFF)', 'bright orange-yellow (#FFB700)'];
      outlineColor = 'VERY thick dark brown (#3d2612) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (dark brown)';
      backgroundStyle = `- Wild West saloon background theme with wooden barrels, saloon doors, and wanted posters
- Dusty sunset horizon, glowing warm light burst behind the text
- Sparks, bullet shells, and gold coins flying at different depths (with foreground depth of field blur)
- Rugged, high-energy, action-filled gaming atmosphere`;
    } else if (lowerGame.includes('egt') || lowerGame.includes('flaming') || lowerGame.includes('hot') || lowerGame.includes('fire') || lowerGame.includes('burning')) {
      lineColors = ['bright orange (#FF4500)', 'bright yellow (#FFE500)', 'bright orange (#FF4500)'];
      outlineColor = 'VERY thick burning dark maroon (#4a0000) outline of at least 8-10px';
      shadowStyle = 'dramatic 3D block extrusion shadow going diagonally down-right (maroon/black)';
      backgroundStyle = `- High-energy burning fire background theme with blazing flames and exploding embers
- Glowing red heatwaves and hot ash particles floating
- Intense orange/red radial light burst behind the text
- Gold coins and burning card suit symbols (spades, hearts, diamonds, clubs) flying at different depths
- Ultra vivid, intense, hot gaming atmosphere`;
    }
  }

  const textSpec = lines.map((line, i) =>
    `Line ${i + 1}: "${line}" — ${lineColors[i % lineColors.length]}, massive bold text`
  ).join('\n');

  // Build a game-specific background context
  const gameContext = gameName
    ? `The slot game is "${gameName}". Match the visual theme, symbols and atmosphere of this specific game.`
    : niche && niche.toLowerCase() !== 'general'
      ? `Casino/slot theme matching the channel niche: ${niche}.`
      : `Generic high-energy casino slot machine theme.`;

  const prompt = `Create a complete, professional, ready-to-publish YouTube thumbnail image.

${gameContext}

═══ TEXT TO RENDER (exact, centered, fills the image) ═══
${textSpec}

Text styling rules (CRITICAL — must follow exactly):
- Font: Cartoon pop-art bubble style similar to "Luckiest Guy", extremely bold and chunky
- Size: Very large — text must fill 55-70% of the total image height
- Each letter has a ${outlineColor}
- Each line has a ${shadowStyle}
- All text perfectly centered horizontally
- Lines stacked vertically with small gaps, centered on the canvas
- Text must be crystal clear and 100% readable at small sizes (mobile)

Background scene (must NOT contain any extra text):
${backgroundStyle}

Final rules:
- Image size: 1536x1024 pixels (landscape)
- NO brand logos, NO real persons, NO fake money amounts shown
- NO additional text besides the lines specified above
- Optimized for YouTube CTR and mobile viewing
- Ultra HD photorealistic 3D render quality`;

  const body = JSON.stringify({
    model: 'gpt-image-1',
    prompt,
    n: 1,
    size: '1536x1024',
    quality: 'high',
  });

  console.log(`[Thumbnail AI] Calling gpt-image-1 | game="${gameName || 'generic'}" | title="${title}"`);

  const responseData = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    let raw = '';
    const req = https.request(options, (res) => {
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON from OpenAI: ' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (responseData.error) {
    throw new Error(`OpenAI API error: ${responseData.error.message}`);
  }

  const b64 = responseData?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data in OpenAI response');

  // Save the raw 1536x1024 gpt-image-1 output to a temp file
  const tempPath = outputPath.replace(/\.png$/, '_raw.png');
  fs.writeFileSync(tempPath, Buffer.from(b64, 'base64'));
  console.log(`[Thumbnail AI] Raw image saved (${Math.round(fs.statSync(tempPath).size / 1024)}KB), resizing to 1280x720...`);

  try {
    // Resize to standard YouTube thumbnail resolution using ffmpeg
    await resizeImage(tempPath, outputPath);
    console.log(`[Thumbnail AI] ✅ Final thumbnail: ${path.basename(outputPath)}`);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// ─────────────────────────────────────────────
// Raw Frame Extractor (immediate on upload)
// ─────────────────────────────────────────────

/**
 * Extracts a 1280x720 PNG frame at 1s from the video file, registers it in the
 * thumbnails table, and links it to the video row.
 * This is the placeholder shown before the AI thumbnail is ready.
 */
export function generateVideoThumbnail(videoPath, videoId, userId, channelId = null) {
  return new Promise((resolve, reject) => {
    const filename = `thumb_${videoId}_${Date.now()}.png`;
    const outputPath = path.join(THUMB_DIR, filename);

    console.log(`[Thumbnail] Extracting placeholder frame for video ${videoId}...`);

    const runExtraction = (seekTime) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .size('1280x720')
        .output(outputPath)
        .on('end', () => {
          try {
            if (!fs.existsSync(outputPath)) {
              throw new Error(`Frame file not found: ${outputPath}`);
            }

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

            console.log(`[Thumbnail] Placeholder ID ${thumbnailId} linked to video ${videoId}`);
            resolve(thumbnailId);
          } catch (dbErr) {
            reject(dbErr);
          }
        })
        .on('error', (err) => {
          if (seekTime === 1.0) {
            console.warn(`[Thumbnail] Retry at 0.0s for video ${videoId}`);
            runExtraction(0.0);
          } else {
            reject(err);
          }
        })
        .run();
    };

    runExtraction(1.0);
  });
}
