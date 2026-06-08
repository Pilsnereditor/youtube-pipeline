import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../server/db/database.js';
import { postCommentBrowser } from '../server/services/puppet.js';

// Load .env configuration
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB
initDb();

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node scratch/test_browser_comment.js <channelId> <youtubeVideoId> "<comment text>"');
  console.log('Example: node scratch/test_browser_comment.js 1 rVZQ1lFqE3Q "Hello World from Puppeteer!"');
  process.exit(1);
}

const channelId = Number(args[0]);
const videoId = args[1];
const commentText = args[2];

// Force headed/visual mode for training/testing
process.env.PUPPET_HEADLESS = 'false';

console.log(`[Test] Launching postCommentBrowser in headed mode...`);
console.log(`[Test] Channel ID: ${channelId}`);
console.log(`[Test] Video ID: ${videoId}`);
console.log(`[Test] Comment Text: "${commentText}"`);

try {
  await postCommentBrowser(channelId, videoId, commentText);
  console.log('[Test] Successfully completed postCommentBrowser execution!');
  process.exit(0);
} catch (err) {
  console.error('[Test] Error executing postCommentBrowser:', err);
  process.exit(1);
}
