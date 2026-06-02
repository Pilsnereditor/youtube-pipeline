import { setupBrowserSession, activeSetupSessions, closeBrowserSession } from '../server/services/puppet.js';
import { initDb } from '../server/db/database.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log('[Test] Initializing DB...');
  initDb();

  const channelId = 1002;
  const userId = 1;

  // Dummy broadcast function
  const broadcast = (data, uid) => {
    if (data.type === 'puppet:screencast') {
      return;
    }
    console.log('[Broadcast WS]', data);
  };

  try {
    console.log('[Test] Starting browser session...');
    await setupBrowserSession(channelId, userId, broadcast);

    // Wait for page to initialize and load
    console.log('[Test] Waiting for page load...');
    await new Promise(r => setTimeout(r, 8000));

    const session = activeSetupSessions.get(channelId);
    if (!session) {
      throw new Error('Session not found in activeSetupSessions!');
    }

    const page = session.page;
    console.log('[Test] Current URL:', page.url());

    // Extract page text
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('[Test] Visible Page Text:\n', pageText);

    // Take screenshot
    const screenshotPath = path.join(__dirname, 'screenshot.png');
    await page.screenshot({ path: screenshotPath });
    console.log('[Test] Saved diagnostic screenshot to:', screenshotPath);

  } catch (err) {
    console.error('[Test] Error:', err);
  } finally {
    console.log('[Test] Closing browser session...');
    await closeBrowserSession(channelId);
  }
  process.exit(0);
}

run().catch(console.error);
