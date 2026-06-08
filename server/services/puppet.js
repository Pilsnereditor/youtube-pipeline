import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { queryOne } from '../db/database.js';
import { stopVncSession } from './vnc.js';

const execAsync = promisify(exec);

/**
 * Force kill any running Chrome process using the specific profile path
 */
async function killOrphanedChrome(profilePath) {
  if (!profilePath) return;
  const normalizedPath = path.resolve(profilePath).replace(/\\/g, '/');
  
  if (process.platform === 'win32') {
    try {
      // Find and kill Chrome processes on Windows containing the user-data-dir in command line
      const wmicCmd = `wmic process where "name='chrome.exe' and CommandLine like '%${normalizedPath.replace(/\//g, '\\\\')}%'" call terminate`;
      await execAsync(wmicCmd);
      console.log(`[Puppet] Terminated Windows Chrome processes using profile: ${profilePath}`);
    } catch (e) {
      // Ignore if no processes found
    }
  } else {
    try {
      // Find Chrome processes on Linux/macOS containing the profile path in command line
      const { stdout } = await execAsync(`pgrep -f "${normalizedPath}"`);
      const pids = stdout.trim().split(/\s+/).filter(Boolean);
      if (pids.length > 0) {
        console.log(`[Puppet] Found running Chrome processes using profile ${profilePath}: ${pids.join(', ')}. Killing them...`);
        await execAsync(`kill -9 ${pids.join(' ')}`);
      }
    } catch (e) {
      // Ignore if no processes found
    }
  }
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Map to track active login browser instances: channelId -> browser
export const activeSetupSessions = new Map();

// Location mapping for NordVPN SOCKS5 server endpoints
const NORDVPN_SERVERS = {
  'us-atlanta': 'atlanta.us.socks.nordhold.net',
  'us-chicago': 'chicago.us.socks.nordhold.net',
  'us-dallas': 'dallas.us.socks.nordhold.net',
  'us-los-angeles': 'los-angeles.us.socks.nordhold.net',
  'us-new-york': 'new-york.us.socks.nordhold.net',
  'nl-amsterdam': 'nl.socks.nordhold.net',
  'se-stockholm': 'se.socks.nordhold.net'
};

/**
 * Resolve proxy parameters for a channel dynamically from database.
 * Returns { proxyUrl, username, password } or null if no proxy configured.
 */
export function resolveChannelProxy(channel) {
  // NEW: Check centralized proxy pool first (takes priority)
  if (channel.proxy_pool_id) {
    const proxy = queryOne('SELECT * FROM proxy_pool WHERE id = @id', { id: channel.proxy_pool_id });
    if (!proxy) {
      throw new Error(`PROXY_SAFETY_BLOCK: Proxy pool entry #${channel.proxy_pool_id} not found for channel "${channel.name}". Upload blocked to protect channel safety.`);
    }
    if (!proxy.is_healthy) {
      throw new Error(`PROXY_SAFETY_BLOCK: Proxy ${proxy.host}:${proxy.port} is unhealthy for channel "${channel.name}". Upload blocked to protect channel safety.`);
    }
    
    // Bypass VPS-only proxies when running locally on Windows
    if (process.platform === 'win32') {
      console.log(`[Proxy] Local Windows environment detected. Bypassing proxy pool "${proxy.host}" for channel "${channel.name}" to use direct connection.`);
      return null;
    }
    
    console.log(`[Proxy] Using pool proxy ${proxy.host}:${proxy.port} (${proxy.city || proxy.country_code}) for channel "${channel.name}"`);
    const protocol = proxy.protocol === 'socks5' ? 'socks5h' : (proxy.protocol || 'http');
    return {
      proxyUrl: `${protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username || '',
      password: proxy.password || ''
    };
  }

  // LEGACY: Fall back to per-channel proxy fields
  if (!channel || !channel.proxy_type || channel.proxy_type === 'none') {
    return null;
  }

  // Bypass VPS-only proxies when running locally on Windows to allow successful local testing
  if (process.platform === 'win32') {
    console.log(`[Proxy] Local Windows environment detected. Bypassing proxy "${channel.proxy_type}" for channel "${channel.name}" to use direct connection.`);
    return null;
  }

  let host = channel.proxy_host;
  let port = channel.proxy_port || 1080;
  let username = channel.proxy_username || '';
  let password = channel.proxy_password || '';
  let type = channel.proxy_type;

  if (channel.proxy_type === 'nordvpn' || (channel.proxy_type === 'socks5' && NORDVPN_SERVERS[channel.proxy_host])) {
    type = 'socks5';
    host = NORDVPN_SERVERS[channel.proxy_host] || 'atlanta.us.socks.nordhold.net';
    port = 1080;
    const userId = channel.user_id;
    let credUser = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = 'nordvpn_username'", { userId });
    if (!credUser || !credUser.value) {
      credUser = queryOne("SELECT value FROM settings WHERE key = 'nordvpn_username'");
    }
    
    let credPass = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = 'nordvpn_password'", { userId });
    if (!credPass || !credPass.value) {
      credPass = queryOne("SELECT value FROM settings WHERE key = 'nordvpn_password'");
    }
    
    username = credUser ? credUser.value : '';
    password = credPass ? credPass.value : '';
  }

  if (!host) return null;

  const resolvedType = type === 'socks5' ? 'socks5h' : type;
  return {
    proxyUrl: `${resolvedType}://${host}:${port}`,
    username,
    password
  };
}

/**
 * Get the platform-appropriate User Agent to match the VNC / native browser
 */
function getUserAgent() {
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  } else if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  } else {
    // Linux VPS
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
}

/**
 * Find the system's Google Chrome executable path
 */
function getChromePath() {
  const paths = {
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    win64: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome'
  };

  if (process.platform === 'win32') {
    if (fs.existsSync(paths.win32)) return paths.win32;
    if (fs.existsSync(paths.win64)) return paths.win64;
  } else if (process.platform === 'darwin') {
    if (fs.existsSync(paths.darwin)) return paths.darwin;
  } else if (process.platform === 'linux') {
    if (fs.existsSync(paths.linux)) return paths.linux;
  }

  return process.env.CHROME_PATH || paths.win32;
}

export function getProfilePath(channelId) {
  // Look up profile_name from the database (new profile-based system)
  const channel = queryOne('SELECT profile_name FROM channels WHERE id = @id', { id: channelId });
  if (channel && channel.profile_name) {
    return path.join(PROFILES_DIR, channel.profile_name);
  }
  // Fallback: old-style channel_{id} profile
  return path.join(PROFILES_DIR, `channel_${channelId}`);
}

/**
 * Launch Chrome with retry support if the profile is locked
 */
async function launchBrowserWithRetry(chromePath, profilePath, headless = false, retries = 3, delayMs = 3000, proxyUrl = null) {
  for (let i = 0; i < retries; i++) {
    try {
      const args = [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US',
        '--password-store=basic',
        '--use-mock-keychain',
        // WebRTC leak prevention — blocks real VPS IP from leaking alongside proxy
        '--enforce-webrtc-ip-permission-check',
        '--disable-webrtc-hw-decoding',
        '--disable-webrtc-hw-encoding',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp'
      ];
      if (proxyUrl) {
        args.push(`--proxy-server=${proxyUrl}`);
      }

      const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless,
        userDataDir: profilePath,
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        args
      });
      return browser;
    } catch (err) {
      const isLocked = err.message.toLowerCase().includes('already running') || 
                       err.message.toLowerCase().includes('userdatadir') ||
                       err.message.toLowerCase().includes('lock');
      if (isLocked && i < retries - 1) {
        console.warn(`[Puppet] Profile directory locked, retrying browser launch in ${delayMs/1000}s... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Launch a headless Chrome window and start WebSocket screencasting (VNC)
 */
export async function setupBrowserSession(channelId, userId, broadcastFn) {
  await closeBrowserSession(channelId);

  // Auto-close VNC session if running — they share the same profile
  try { await stopVncSession(); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up browser lock files to prevent lock-on-launch crashes
  try {
    const lockPath = path.join(profilePath, 'SingletonLock');
    const socketPath = path.join(profilePath, 'SingletonSocket');
    const cookiePath = path.join(profilePath, 'SingletonCookie');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
  } catch (e) {
    console.warn(`[Puppet] Failed to pre-clean lock files: ${e.message}`);
  }

  // Load and resolve channel proxy details
  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  if (proxyUrl) {
    console.log(`[Puppet] Routing setup session for channel ${channelId} via proxy: ${proxyUrl}`);
  }

  console.log(`[Puppet] Launching headless browser setup for channel ${channelId}`);

  let browser;
  try {
    browser = await launchBrowserWithRetry(chromePath, profilePath, true, 3, 3000, proxyUrl);
  } catch (err) {
    console.error(`[Puppet] Browser launch failed for channel ${channelId}:`, err);
    // Notify frontend that launch failed
    if (broadcastFn) {
      broadcastFn({ type: 'puppet:session_error', channelId, error: err.message }, userId);
    }
    throw err;
  }

  const [page] = await browser.pages();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setUserAgent(getUserAgent());
  await page.setViewport({ width: 1024, height: 700 });

  if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
    await page.authenticate({
      username: proxyConfig.username || '',
      password: proxyConfig.password || ''
    });
  }

  // Override webdriver and plugins to bypass Google bot block
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Chromium PDF Viewer' },
        { name: 'Microsoft Edge PDF Viewer' },
        { name: 'WebKit built-in PDF' }
      ]
    });
  });

  // Connect CDP session for screencasting BEFORE navigation
  // This lets us start sending frames immediately as the page loads
  const client = await page.target().createCDPSession();
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1024, maxHeight: 700 });

  client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    try {
      if (broadcastFn) {
        broadcastFn({
          type: 'puppet:screencast',
          channelId: Number(channelId),
          frame: data,
          width: metadata.deviceWidth,
          height: metadata.deviceHeight
        }, userId);
      }
    } catch (err) {
      console.error('[Puppet] Screencast broadcast error:', err);
    } finally {
      try {
        await client.send('Page.ackScreencastFrame', { sessionId });
      } catch (e) { /* ignore */ }
    }
  });

  // *** KEY FIX: Register session BEFORE page.goto ***
  // This means browser-login-status immediately returns active:true
  // and the frontend shows the screen while the page is still loading
  activeSetupSessions.set(channelId, { browser, page, client });

  browser.on('disconnected', () => {
    activeSetupSessions.delete(channelId);
    if (broadcastFn) {
      broadcastFn({ type: 'puppet:session_closed', channelId: Number(channelId) }, userId);
    }
  });

  // Notify frontend that session is ready — screen will appear immediately
  if (broadcastFn) {
    broadcastFn({ type: 'puppet:session_ready', channelId: Number(channelId) }, userId);
  }

  // Navigate to YouTube Studio in background (use domcontentloaded, not networkidle2)
  // networkidle2 hangs through SOCKS5 proxy — domcontentloaded is fast and reliable
  console.log(`[Puppet] Navigating to YouTube Studio for channel ${channelId}...`);
  page.goto('https://studio.youtube.com?hl=en&persist_hl=1', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  }).catch(err => {
    console.warn(`[Puppet] Navigation warning for channel ${channelId}: ${err.message}`);
    // Don't kill the session — user can still interact
  });

  return browser;
}

/**
 * Check if the browser login session is active
 */
export async function checkBrowserSessionActive(channelId) {
  return activeSetupSessions.has(channelId);
}

/**
 * Force close a login browser session and clean up any lingering processes
 */
export async function closeBrowserSession(channelId) {
  const session = activeSetupSessions.get(channelId);
  if (session) {
    try {
      await session.browser.close();
    } catch (e) {
      console.warn(`[Puppet] Error closing browser for channel ${channelId}: ${e.message}`);
    }
    activeSetupSessions.delete(channelId);
  }

  // Also stop any VNC sessions running Chrome
  try {
    await stopVncSession();
  } catch (e) {}

  const profilePath = getProfilePath(channelId);

  // Force termination of any orphaned Chrome processes using this profile
  try {
    await killOrphanedChrome(profilePath);
  } catch (e) {
    console.warn(`[Puppet] Failed to kill orphaned Chrome processes: ${e.message}`);
  }

  // Also clean up lock files regardless of whether we had a tracked session
  // This handles cases where the server crashed and left Chrome running
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const f of lockFiles) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Puppet] Removed lock file: ${f} for channel ${channelId}`);
      }
    }
  } catch (e) {
    console.warn(`[Puppet] Could not clean lock files for channel ${channelId}: ${e.message}`);
  }

  // Give OS a moment to release file handles
  await new Promise(r => setTimeout(r, 500));
}

/**
 * User inputs remote commands
 */
export async function sendPuppetClick(channelId, userId, x, y) {
  const session = activeSetupSessions.get(channelId);
  if (session && session.page) {
    try {
      await session.page.mouse.click(Number(x), Number(y));
    } catch (e) {
      console.error(`[Puppet] Click error for channel ${channelId}:`, e);
    }
  }
}

export async function sendPuppetType(channelId, userId, text) {
  const session = activeSetupSessions.get(channelId);
  if (session && session.page) {
    try {
      // For single characters (real-time typing from keyboard), use keyboard.type directly.
      // This simulates natural keypress events which Google Sign-In listens to.
      await session.page.keyboard.type(text, { delay: 0 });
    } catch (e) {
      console.error(`[Puppet] Type error for channel ${channelId}:`, e);
    }
  }
}

export async function sendPuppetKey(channelId, userId, key, modifiers = {}) {
  const session = activeSetupSessions.get(channelId);
  if (session && session.page) {
    try {
      // Handle modifier key combinations (e.g. Ctrl+A, Ctrl+V)
      if (modifiers.ctrl) {
        await session.page.keyboard.down('Control');
      }
      if (modifiers.shift) {
        await session.page.keyboard.down('Shift');
      }
      if (modifiers.alt) {
        await session.page.keyboard.down('Alt');
      }

      await session.page.keyboard.press(key);

      if (modifiers.ctrl) {
        await session.page.keyboard.up('Control');
      }
      if (modifiers.shift) {
        await session.page.keyboard.up('Shift');
      }
      if (modifiers.alt) {
        await session.page.keyboard.up('Alt');
      }
    } catch (e) {
      console.error(`[Puppet] Keypress error for channel ${channelId}:`, e);
    }
  }
}

export async function resetPuppetSessionUrl(channelId) {
  const session = activeSetupSessions.get(channelId);
  if (session && session.page) {
    try {
      await session.page.goto('https://studio.youtube.com?hl=en&persist_hl=1', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
    } catch (e) {
      console.error(`[Puppet] Reset URL error for channel ${channelId}:`, e);
    }
  }
}

/**
 * Formats publish date to YouTube-accepted text: "May 31, 2026"
 */
function formatPublishDate(dateIso) {
  const date = new Date(dateIso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[date.getMonth()];
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm} ${dd}, ${yyyy}`;
}

/**
 * Formats publish time to YouTube-accepted text: "10:00 PM"
 */
function formatPublishTime(dateIso) {
  const date = new Date(dateIso);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Safely clicks an element using page.evaluate to prevent "Node is either not clickable or not an Element" errors.
 * Optionally scrolls the element into view and focuses it.
 * @param {object} page Puppeteer Page object
 * @param {object} elementHandle Puppeteer ElementHandle object
 * @param {object} opts { scroll?: boolean, focus?: boolean }
 */
async function safeClick(page, elementHandle, opts = {}) {
  if (!elementHandle) return;
  await page.evaluate((el, options) => {
    if (options.scroll) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    if (options.focus) {
      el.focus();
    }
    el.click();
  }, elementHandle, opts);
}

/**
 * Automate the video upload using Puppeteer
 * @param {number} channelId 
 * @param {object} opts { videoPath, title, description, tags, privacy, category, scheduledAt, thumbnailPath }
 */
export async function uploadVideoBrowser(channelId, opts, logFn = console.log) {
  // Auto-close any active login window to release profile lock
  await closeBrowserSession(channelId);
  // Auto-close VNC session if running — they share the same profile
  try { await stopVncSession(); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));
  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up browser lock files to prevent lock-on-launch crashes
  try {
    const lockPath = path.join(profilePath, 'SingletonLock');
    const socketPath = path.join(profilePath, 'SingletonSocket');
    const cookiePath = path.join(profilePath, 'SingletonCookie');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
  } catch (e) {
    logFn(`[Puppet] Failed to pre-clean lock files: ${e.message}`);
  }

  if (!fs.existsSync(opts.videoPath)) {
    throw new Error(`Video file does not exist: ${opts.videoPath}`);
  }

  // Load and resolve channel proxy details
  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;
  
  if (proxyUrl) {
    logFn(`[Puppet] Routing upload session for channel ${channelId} via proxy: ${proxyUrl}`);
  }

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet] Starting browser upload for "${opts.title}" (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({
        username: proxyConfig.username || '',
        password: proxyConfig.password || ''
      });
    }
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });

    // Override webdriver and plugins to bypass Google bot block
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer' },
          { name: 'Chrome PDF Viewer' },
          { name: 'Chromium PDF Viewer' },
          { name: 'Microsoft Edge PDF Viewer' },
          { name: 'WebKit built-in PDF' }
        ]
      });
    });

    logFn('[Puppet] Navigating to YouTube Studio...');
    await page.goto('https://studio.youtube.com?hl=en&persist_hl=1', { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if we are redirected to login
    const url = page.url();
    if (url.includes('accounts.google.com')) {
      throw new Error('Not logged in. Please set up your browser session in the channel settings first.');
    }

    logFn('[Puppet] Logged in successfully. Finding Create button...');
    const createBtn = await page.waitForSelector('.ytcpAppHeaderCreateIcon, ytcp-button#create-icon, [aria-label="Create"], [aria-label="Oluştur"]', { timeout: 30000 });
    await createBtn.click();
    await new Promise(r => setTimeout(r, 2000));

    logFn('[Puppet] Selecting Upload videos...');
    // Find item by text using page.evaluate to click it reliably (supports English and Turkish)
    const itemClicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('tp-yt-paper-item, paper-item, ytcp-menu-item-text, ytcp-menu-service-item-renderer, ytd-menu-service-item-renderer'));
      const uploadItem = items.find(el => {
        const txt = el.textContent.toLowerCase();
        return txt.includes('upload') || txt.includes('yükle') || txt.includes('video ekle');
      });
      if (uploadItem) {
        uploadItem.click();
        return true;
      }
      // Fallback: click the first item in the dropdown
      if (items.length > 0) {
        items[0].click();
        return true;
      }
      return false;
    });

    if (!itemClicked) {
      throw new Error('Could not find or click the "Upload videos" option in the Create dropdown.');
    }

    logFn('[Puppet] File picker open. Uploading video file...');
    const fileChooserPromise = page.waitForFileChooser();
    // Click select files button inside the file picker modal
    await page.evaluate(() => {
      const btn = document.querySelector('ytcp-uploads-file-picker input[type="file"], input[type="file"]');
      if (btn) btn.click();
    });

    const fileChooser = await fileChooserPromise;
    await fileChooser.accept([opts.videoPath]);
    logFn('[Puppet] Video file submitted, waiting for upload details to load...');

    // Wait for the title input box to appear (confirms upload dialog loaded)
    const titleInput = await page.waitForSelector('#title-textarea #textbox', { timeout: 30000 });
    
    // Extract the Video ID early from the dialog (since YouTube generates it immediately)
    let youtubeVideoId = '';
    function extractVideoId(url) {
      if (!url) return '';
      // Handle /shorts/VIDEO_ID
      const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]{6,20})/);
      if (shortsMatch) return shortsMatch[1];
      // Handle youtu.be/VIDEO_ID
      const youtubeBeMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,20})/);
      if (youtubeBeMatch) return youtubeBeMatch[1];
      // Handle v=VIDEO_ID
      const vParamMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{6,20})/);
      if (vParamMatch) return vParamMatch[1];
      // Handle /video/VIDEO_ID
      const videoMatch = url.match(/\/video\/([a-zA-Z0-9_-]{6,20})/);
      if (videoMatch) return videoMatch[1];
      return '';
    }
    try {
      const linkElem = await page.waitForSelector('a.style-scope.ytcp-video-info, #share-url, .video-url-fadeable a, span.video-url-text a', { timeout: 15000 });
      const videoLink = await page.evaluate(el => el.href || el.textContent, linkElem);
      logFn(`[Puppet] Generated video link: ${videoLink}`);
      youtubeVideoId = extractVideoId(videoLink);
      logFn(`[Puppet] Extracted YouTube Video ID: ${youtubeVideoId}`);
    } catch (e) {
      logFn(`[Puppet] Warning: could not retrieve video ID early: ${e.message}`);
    }

    logFn('[Puppet] Inputting title...');
    await safeClick(page, titleInput, { scroll: true, focus: true });
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(opts.title);

    logFn('[Puppet] Inputting description...');
    const descInput = await page.waitForSelector('#description-textarea #textbox', { timeout: 5000 });
    await safeClick(page, descInput, { scroll: true, focus: true });
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(opts.description || '');

    // Set "Made for kids" to No
    logFn('[Puppet] Setting audience (Not Made for Kids)...');
    
    // Scroll container down to expose the audience section
    await page.evaluate(() => {
      const scrollable = document.querySelector('#scrollable-content');
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      }
    });
    await new Promise(r => setTimeout(r, 1000));

    // Log the radio buttons to debug
    const radioInfo = await page.evaluate(() => {
      const elList = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, paper-radio-button'));
      return elList.map(el => ({
        name: el.getAttribute('name'),
        id: el.id,
        text: el.innerText ? el.innerText.trim() : ''
      }));
    });
    logFn('[Puppet] Found radio buttons on page: ' + JSON.stringify(radioInfo));

    // Try to click the "Not made for kids" radio button
    const kidsClicked = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, paper-radio-button'));
      const notForKids = radios.find(el => {
        const name = (el.getAttribute('name') || '').toUpperCase();
        const text = (el.innerText || '').toLowerCase();
        return name.includes('not_for_kids') || text.includes('not made for kids') || text.includes('hayır, çocuklara özel değil') || text.includes('no, it\'s not made for kids');
      });
      if (notForKids) {
        notForKids.click();
        return true;
      }
      return false;
    });

    if (!kidsClicked) {
      logFn('[Puppet] Warning: could not find "Not Made for Kids" radio button via evaluate, trying selector...');
      const kidsRadio = await page.waitForSelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_FOR_KIDS"]', { timeout: 5000 });
      await safeClick(page, kidsRadio, { scroll: true });
    }

    // Set Custom Thumbnail if provided
    if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
      logFn('[Puppet] Uploading custom thumbnail...');
      try {
        const thumbInput = await page.waitForSelector('ytcp-thumbnails-compact-editor-uploader input[type="file"], input#file-loader', { timeout: 5000 });
        await thumbInput.uploadFile(opts.thumbnailPath);
        logFn('[Puppet] Thumbnail submitted successfully');
      } catch (err) {
        logFn(`[Puppet] Warning: failed to upload thumbnail: ${err.message}`);
      }
    }

    // Step 1: Details -> Video Elements
    logFn('[Puppet] Transitioning from Details to Video Elements...');
    const nextBtn1 = await page.waitForSelector('#next-button', { timeout: 10000 });
    await safeClick(page, nextBtn1, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Step 2: Video Elements -> Checks
    logFn('[Puppet] Transitioning from Video Elements to Checks...');
    const nextBtn2 = await page.waitForSelector('#next-button', { timeout: 10000 });
    await safeClick(page, nextBtn2, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Step 3: Checks -> Visibility
    logFn('[Puppet] Transitioning from Checks to Visibility...');
    const nextBtn3 = await page.waitForSelector('#next-button', { timeout: 10000 });
    await safeClick(page, nextBtn3, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Handle scheduling vs simple visibility setting
    if (opts.scheduledAt && new Date(opts.scheduledAt).getTime() > Date.now() + 60 * 1000) {
      logFn(`[Puppet] Scheduling video for ${opts.scheduledAt}...`);

      // Click the Schedule accordion header to expand it
      // The header row for Schedule is the #publish-from-private-non-sponsor-selector container header
      logFn('[Puppet] Expanding Schedule accordion...');
      
      // Use page.click on the accordion header — the chevron ▼ is inside ytcp-video-visibility-select
      // We click the header-row div that contains "Schedule" text and the chevron
      const scheduleHeaderClicked = await page.evaluate(() => {
        // The Schedule row is a div with the text "Schedule" and a chevron inside ytcp-video-visibility-select
        const container = document.querySelector('ytcp-video-visibility-select');
        if (!container) return 'no-container';
        
        // Find the header-like div in the shadow or light DOM
        const allDivs = Array.from(container.querySelectorAll('div, ytcp-paper-expandable-section, ytcp-checkbox, .header'));
        const scheduleRow = allDivs.find(el => {
          const t = (el.textContent || '').trim();
          return t.startsWith('Schedule') && el.children.length <= 3;
        });
        if (scheduleRow) {
          scheduleRow.click();
          return 'clicked-row:' + scheduleRow.tagName + ' ' + scheduleRow.className.substring(0, 40);
        }
        
        // Fallback: click the whole container
        container.click();
        return 'clicked-container';
      });
      logFn('[Puppet] Schedule accordion click: ' + scheduleHeaderClicked);
      await new Promise(r => setTimeout(r, 2000));

      // Wait for the datetime picker to appear inside ytcp-visibility-scheduler
      logFn('[Puppet] Waiting for datetime picker to appear...');
      try {
        await page.waitForSelector('ytcp-datetime-picker, #datepicker-trigger, ytcp-visibility-scheduler ytcp-text-input', { timeout: 5000 });
        logFn('[Puppet] Datetime picker appeared.');
      } catch (e) {
        logFn('[Puppet] Datetime picker not found after click, trying direct page.click on Schedule row...');
        // Try page.click on the ytcp-video-visibility-select
        try {
          await page.click('#publish-from-private-non-sponsor-selector');
          logFn('[Puppet] Clicked #publish-from-private-non-sponsor-selector');
        } catch (e2) {
          logFn('[Puppet] Fallback click failed: ' + e2.message);
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Now the datepicker should be visible — fill in date
      logFn('[Puppet] Entering scheduled date...');

      // The date is shown as a dropdown button like "May 30, 2026 ▼"
      // Click the dropdown trigger to open calendar picker, then type the date
      const dateStr = formatPublishDate(opts.scheduledAt);
      const timeStr = formatPublishTime(opts.scheduledAt);

      // Try clicking the date dropdown trigger to open the calendar
      const dateTrigger = await page.waitForSelector(
        '#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]',
        { timeout: 5000 }
      ).catch(() => null);

      if (dateTrigger) {
        await safeClick(page, dateTrigger, { scroll: true });
        await new Promise(r => setTimeout(r, 1000));
        // Type the date into the input that appears
        const calInput = await page.waitForSelector(
          '#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]',
          { timeout: 3000 }
        ).catch(() => null);
        if (calInput) {
          await safeClick(page, calInput, { scroll: true, focus: true });
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await calInput.type(dateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));
          logFn(`[Puppet] Entered date: ${dateStr}`);
        } else {
          logFn('[Puppet] No date text input found after opening trigger, date may already be correct');
        }
      } else {
        // Try direct text input
        const directDateInput = await page.waitForSelector(
          'input[aria-label="Publish date"], input[placeholder*="date" i]',
          { timeout: 3000 }
        ).catch(() => null);
        if (directDateInput) {
          await safeClick(page, directDateInput, { scroll: true, focus: true });
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await directDateInput.type(dateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));
          logFn(`[Puppet] Entered date via direct input: ${dateStr}`);
        } else {
          logFn('[Puppet] Warning: could not find date input, skipping (date may already be set)');
        }
      }
      await new Promise(r => setTimeout(r, 800));

      logFn('[Puppet] Entering scheduled time...');
      // The time input shows "12:00 AM" — it's an <input> inside the scheduler, after the date dropdown
      const timeInput = await page.waitForSelector(
        '#time-of-day-trigger input, ytcp-time-of-day-picker input, input[aria-label*="time" i], input[aria-label="Publish time"], ytcp-visibility-scheduler input[type="text"]:last-of-type, ytcp-datetime-picker input',
        { timeout: 5000 }
      ).catch(() => null);
      if (timeInput) {
        await safeClick(page, timeInput, { scroll: true, focus: true });
        await new Promise(r => setTimeout(r, 200));
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 200));
        await timeInput.type(timeStr, { delay: 50 });
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));
        logFn(`[Puppet] Entered time: ${timeStr}`);
      } else {
        // Fallback: find any input inside the datetime area by evaluating DOM
        const timeSet = await page.evaluate((t) => {
          // Find inputs in datetime picker area
          const dtPicker = document.querySelector('ytcp-datetime-picker, ytcp-visibility-scheduler');
          if (!dtPicker) return false;
          const inputs = Array.from(dtPicker.querySelectorAll('input'));
          // The time input is usually the second one (after date)
          const timeInput = inputs.find(inp => {
            const val = (inp.value || '').toLowerCase();
            return val.includes('am') || val.includes('pm') || /\d+:\d+/.test(val);
          }) || inputs[inputs.length - 1];
          if (timeInput) {
            timeInput.focus();
            timeInput.select();
            document.execCommand('selectAll');
            document.execCommand('insertText', false, t);
            timeInput.dispatchEvent(new Event('input', { bubbles: true }));
            timeInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }, timeStr);
        logFn(`[Puppet] Time set via evaluate: ${timeSet}`);
      }
      await new Promise(r => setTimeout(r, 800));

      if (opts.isPremiere) {
        logFn('[Puppet] Checking "Set as Premiere" option...');
        try {
          const clickedPremiere = await page.evaluate(() => {
            const checkboxes = Array.from(document.querySelectorAll('ytcp-checkbox, tp-yt-paper-checkbox, paper-checkbox, ytcp-checkbox-group ytcp-checkbox, ytcp-checkbox-lit'));
            const premiereCheckbox = checkboxes.find(el => {
              const text = (el.textContent || '').trim().toLowerCase();
              return text.includes('premiere') || text.includes('gösterim') || text.includes('gosterim');
            });
            if (premiereCheckbox) {
              const isChecked = premiereCheckbox.checked || premiereCheckbox.hasAttribute('checked') || premiereCheckbox.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                premiereCheckbox.click();
                return 'clicked';
              }
              return 'already_checked';
            }
            return 'not_found';
          });
          logFn(`[Puppet] Premiere checkbox status: ${clickedPremiere}`);
        } catch (e) {
          logFn(`[Puppet] Warning: failed to check premiere checkbox: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 800));
      }

    } else {
      // Direct visibility selector
      const privacy = opts.privacy || 'private';
      logFn(`[Puppet] Setting visibility to ${privacy}...`);
      
      const visibilityClicked = await page.evaluate((targetPrivacy) => {
        const radios = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, paper-radio-button'));
        const option = radios.find(el => {
          const name = (el.getAttribute('name') || '').toLowerCase();
          const text = (el.innerText || '').toLowerCase();
          return name.includes(targetPrivacy) || text.includes(targetPrivacy);
        });
        if (option) {
          option.click();
          return true;
        }
        return false;
      }, privacy);

      if (!visibilityClicked) {
        logFn(`[Puppet] Warning: could not click visibility option "${privacy}" via evaluate, trying selector...`);
        let privacySelector = '#private-radio-button';
        if (privacy === 'public') privacySelector = '#public-radio-button';
        else if (privacy === 'unlisted') privacySelector = '#unlisted-radio-button';
        
        const privacyRadio = await page.waitForSelector(privacySelector, { timeout: 5000 });
        await safeClick(page, privacyRadio, { scroll: true });
      }
      await new Promise(r => setTimeout(r, 500));
    }

    logFn('[Puppet] Finalizing upload (clicking Schedule/Save button)...');
    // YouTube shows "Schedule" button when scheduling, "Save" or "Done" otherwise
    const doneBtn = await page.waitForSelector(
      '#schedule-button, #done-button, #publish-button, #save-button, ytcp-button[id*="schedule"], ytcp-button[id*="done"], ytcp-button[id*="save"]',
      { timeout: 10000 }
    );
    await safeClick(page, doneBtn, { scroll: true });
    await new Promise(r => setTimeout(r, 3000));

    // Wait for the video to complete uploading so we don't abort it
    logFn('[Puppet] Monitoring upload completion progress (do not close)...');
    let isUploading = true;
    let checksCount = 0;
    while (isUploading && checksCount < 120) {
      const status = await page.evaluate(() => {
        const uploadDialog = document.querySelector('ytcp-uploads-dialog');
        const shareDialog = document.querySelector('ytcp-video-share-dialog');
        
        if (!uploadDialog && !shareDialog) {
          return { done: true, reason: 'dialogs_closed' };
        }
        
        const dialog = uploadDialog || shareDialog;
        const text = (dialog.textContent || '').toLowerCase();
        
        const isDone = 
          text.includes('upload complete') || 
          text.includes('processing') || 
          text.includes('checks') || 
          text.includes('uploaded successfully') || 
          text.includes('scheduled') || 
          text.includes('finished') ||
          text.includes('video published') ||
          text.includes('yükleme tamamlandı') ||
          text.includes('işleniyor') ||
          text.includes('kontroller') ||
          text.includes('başarıyla yüklendi') ||
          text.includes('planlandı') ||
          text.includes('zamanlandı') ||
          text.includes('bitti') ||
          text.includes('yayınlandı') ||
          text.includes('paylaş') ||
          text.includes('share') ||
          text.includes('kapat') ||
          text.includes('close');
          
        return { done: isDone, text: text.slice(0, 100) };
      });

      if (status.done) {
        logFn(`[Puppet] Video upload complete or scheduled successfully: ${status.reason || 'completion text detected'}`);
        isUploading = false;
      } else {
        await new Promise(r => setTimeout(r, 5000));
        checksCount++;
        if (checksCount % 6 === 0) {
          logFn(`[Puppet] Uploading in progress... (${checksCount * 5}s elapsed)`);
        }
      }
    }

    // Try to get video ID again if we couldn't get it earlier
    if (!youtubeVideoId) {
      try {
        const linkElem = await page.waitForSelector('span.video-url-text a, a.style-scope.ytcp-video-info, #share-url, .video-url-fadeable a', { timeout: 10000 });
        const videoLink = await page.evaluate(el => el.href || el.textContent, linkElem);
        youtubeVideoId = extractVideoId(videoLink);
        logFn(`[Puppet] Extracted YouTube Video ID on completion: ${youtubeVideoId}`);
      } catch (e) {
        logFn(`[Puppet] Warning: could not find video ID at completion: ${e.message}`);
      }
    }

    logFn('[Puppet] Upload task complete.');
    await browser.close();
    return { videoId: youtubeVideoId };
  } catch (err) {
    logFn(`[Puppet] Error during automated upload: ${err.message}`);
    try {
      logFn(`[Puppet] Current page URL at failure: ${page.url()}`);
      const screenshotPath = path.join(profilePath, 'puppet_upload_error.png');
      await page.screenshot({ path: screenshotPath });
      logFn(`[Puppet] Saved error screenshot to: ${screenshotPath}`);
    } catch (e) {
      logFn(`[Puppet] Failed to capture error screenshot: ${e.message}`);
    }
    try {
      await browser.close();
    } catch {}
    throw err;
  }
}

/**
 * Automate rescheduling a video on YouTube Studio using Puppeteer.
 * @param {number} channelId
 * @param {string} youtubeVideoId
 * @param {string} scheduledAt
 * @param {function} logFn
 */
export async function rescheduleVideoBrowser(channelId, youtubeVideoId, scheduledAt, isPremiere = false, newTitle = null, logFn = console.log) {
  await closeBrowserSession(channelId);

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Load and resolve channel proxy details
  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;
  
  if (proxyUrl) {
    logFn(`[Puppet] Routing reschedule/update session for channel ${channelId} via proxy: ${proxyUrl}`);
  }

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet] Starting browser update for video ${youtubeVideoId} (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({
        username: proxyConfig.username || '',
        password: proxyConfig.password || ''
      });
    }
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });

    // Override webdriver and plugins to bypass Google bot block
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer' },
          { name: 'Chrome PDF Viewer' },
          { name: 'Chromium PDF Viewer' },
          { name: 'Microsoft Edge PDF Viewer' },
          { name: 'WebKit built-in PDF' }
        ]
      });
    });

    logFn('[Puppet] Navigating to YouTube Studio video edit page...');
    await page.goto(`https://studio.youtube.com/video/${youtubeVideoId}/edit?hl=en&persist_hl=1`, { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if we are redirected to login
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in. Please set up your browser session in the channel settings first.');
    }

    // 1. Update Video Title if provided
    if (newTitle) {
      logFn(`[Puppet] Updating video title to: "${newTitle}"`);
      const titleInput = await page.waitForSelector('#title-textarea #textbox', { timeout: 15000 });
      await safeClick(page, titleInput, { scroll: true, focus: true });
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 200));
      await titleInput.type(newTitle);
      await new Promise(r => setTimeout(r, 500));
    }

    // 2. Update Video Schedule if provided
    if (scheduledAt) {
      logFn('[Puppet] Finding Visibility select dropdown...');
      await page.waitForSelector('ytcp-video-metadata-visibility', { timeout: 30000 });
      logFn('[Puppet] Clicking Visibility select dropdown trigger...');
      const visTriggerResult = await page.evaluate(() => {
        function queryAllShadow(selector, root = document) {
          const elements = Array.from(root.querySelectorAll(selector));
          const children = Array.from(root.querySelectorAll('*'));
          for (const child of children) {
            if (child.shadowRoot) {
              elements.push(...queryAllShadow(selector, child.shadowRoot));
            }
          }
          return elements;
        }

        const targets = queryAllShadow('#visibility-select, #visibility-display, #trigger, [aria-label*="visibility" i]');
        const host = document.querySelector('ytcp-video-metadata-visibility');
        const clickable = targets.find(el => el.offsetParent !== null) || host;
        if (clickable) {
          clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
          clickable.click();
          return { status: 'success', tag: clickable.tagName, id: clickable.id };
        }
        return { status: 'error' };
      });

      if (visTriggerResult.status !== 'success') {
        throw new Error('Failed to locate or click Visibility trigger on edit page.');
      }
      logFn(`[Puppet] Clicked visibility trigger: [${visTriggerResult.tag}] id="${visTriggerResult.id}"`);
      logFn('[Puppet] Waiting for visibility popup to render...');
      await page.waitForSelector('ytcp-video-visibility-edit-popup', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 1000));

      // Now the visibility select dialog is open.
      // We will select the Schedule option.
      logFn('[Puppet] Selecting Schedule option...');
      let selectScheduleResult = await page.evaluate(() => {
        function queryAllShadow(selector, root = document) {
          const elements = Array.from(root.querySelectorAll(selector));
          const children = Array.from(root.querySelectorAll('*'));
          for (const child of children) {
            if (child.shadowRoot) {
              elements.push(...queryAllShadow(selector, child.shadowRoot));
            }
          }
          return elements;
        }

        const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
        if (!popup) {
          return { status: 'error', reason: 'no-popup-found' };
        }

        const sections = queryAllShadow('ytcp-paper-expandable-section', popup);
        if (sections.length < 2) {
          return { status: 'error', reason: 'insufficient-sections' };
        }

        // Section 0 is "Save or publish", Section 1 is "Schedule"
        const savePublishSection = sections.find(sec => {
          const text = (sec.textContent || '').trim().toLowerCase();
          return text.includes('save or publish') || text.includes('kaydet veya') || text.includes('yayınla') || text.includes('yayinla');
        }) || sections[0];

        const scheduleSection = sections.find(sec => {
          const text = (sec.textContent || '').trim().toLowerCase();
          return text.includes('schedule') || text.includes('planla');
        }) || sections[1];

        // Check if Schedule is visible and enabled
        const isScheduleAvailable = scheduleSection && scheduleSection.offsetParent !== null;

        if (isScheduleAvailable) {
          const isOpened = scheduleSection.opened || scheduleSection.hasAttribute('opened') || scheduleSection.getAttribute('aria-expanded') === 'true';
          if (!isOpened) {
            const header = scheduleSection.querySelector('#header') || scheduleSection.querySelector('.header') || scheduleSection.querySelector('[role="button"]') || scheduleSection;
            header.click();
            return { status: 'success', action: 'expanded-schedule' };
          }
          return { status: 'success', action: 'schedule-already-expanded' };
        } else {
          return { status: 'needs-private' };
        }
      });

      logFn(`[Puppet] Schedule selection status: ${selectScheduleResult.status} (${selectScheduleResult.action || selectScheduleResult.reason || ''})`);
      await new Promise(r => setTimeout(r, 2000));

      if (selectScheduleResult.status === 'needs-private' || selectScheduleResult.status === 'error') {
        logFn('[Puppet] Schedule option not available. Video might be Public. Changing visibility to Private first...');
        
        const setPrivateResult = await page.evaluate(() => {
          function queryAllShadow(selector, root = document) {
            const elements = Array.from(root.querySelectorAll(selector));
            const children = Array.from(root.querySelectorAll('*'));
            for (const child of children) {
              if (child.shadowRoot) {
                elements.push(...queryAllShadow(selector, child.shadowRoot));
              }
            }
            return elements;
          }

          const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
          if (!popup) return { status: 'error', reason: 'no-popup-found' };

          const sections = queryAllShadow('ytcp-paper-expandable-section', popup);
          const savePublishSection = sections.find(sec => {
            const text = (sec.textContent || '').trim().toLowerCase();
            return text.includes('save or publish') || text.includes('kaydet veya') || text.includes('yayınla') || text.includes('yayinla');
          }) || sections[0];

          if (!savePublishSection) return { status: 'error', reason: 'save-publish-section-not-found' };

          // Expand Save or publish if collapsed
          const isSavePublishOpened = savePublishSection.opened || savePublishSection.hasAttribute('opened') || savePublishSection.getAttribute('aria-expanded') === 'true';
          if (!isSavePublishOpened) {
            const header = savePublishSection.querySelector('#header') || savePublishSection.querySelector('.header') || savePublishSection.querySelector('[role="button"]') || savePublishSection;
            header.click();
          }

          // Find Private radio button
          const radios = queryAllShadow('tp-yt-paper-radio-button, paper-radio-button, ytcp-radio-button, [role="radio"]', savePublishSection);
          if (radios.length === 0) return { status: 'error', reason: 'no-radios-found-in-save-publish' };

          const privateRadio = radios.find(r => {
            const t = (r.textContent || '').trim().toLowerCase();
            const name = (r.getAttribute('name') || '').toLowerCase();
            return t.includes('private') || name.includes('private') || t.includes('özel') || t.includes('ozel') || name.includes('private');
          }) || radios[0]; // fallback to first option (Private)

          if (privateRadio) {
            privateRadio.click();
            return { status: 'success' };
          }
          return { status: 'error', reason: 'private-radio-not-found' };
        });

        if (setPrivateResult.status !== 'success') {
          throw new Error(`Failed to find or select "Private" option in visibility dialog: ${setPrivateResult.reason || 'unknown reason'}`);
        }
        logFn('[Puppet] Selected Private. Clicking Done...');

        const doneBtn = await page.waitForSelector('ytcp-video-visibility-edit-popup #save-button, ytcp-video-visibility-edit-popup ytcp-button[id="save-button"], #done-button, ytcp-button[id*="done"]', { timeout: 10000 });
        await safeClick(page, doneBtn, { scroll: true });
        await new Promise(r => setTimeout(r, 2000));

        logFn('[Puppet] Saving intermediate Private change...');
        const saveBtn = await page.waitForSelector('ytcp-button#save:not([disabled]):not([aria-disabled="true"]), ytcp-button[id="save"]', { timeout: 15000 }).catch(() => null);
        if (saveBtn) {
          await safeClick(page, saveBtn, { scroll: true });
          logFn('[Puppet] Clicked intermediate save button, waiting for save to complete...');
          await page.waitForSelector('ytcp-button#save[disabled], ytcp-button#save[aria-disabled="true"]', { timeout: 25000 }).catch(() => null);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          logFn('[Puppet] Main save button not active or not found. Trying intermediate fallback click...');
          const mainSaveClicked = await page.evaluate(() => {
            const btn = document.querySelector('ytcp-button#save:not([disabled])') || document.querySelector('ytcp-button#save:not([aria-disabled="true"])') || document.querySelector('ytcp-button#save');
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          });
          logFn(`[Puppet] Intermediate fallback save clicked: ${mainSaveClicked}`);
          await new Promise(r => setTimeout(r, 5000));
        }

        // Re-open visibility dropdown
        logFn('[Puppet] Re-opening Visibility select dropdown after saving Private change...');
        await page.waitForSelector('ytcp-video-metadata-visibility', { timeout: 30000 });
        const visTriggerReopenedResult = await page.evaluate(() => {
          function queryAllShadow(selector, root = document) {
            const elements = Array.from(root.querySelectorAll(selector));
            const children = Array.from(root.querySelectorAll('*'));
            for (const child of children) {
              if (child.shadowRoot) {
                elements.push(...queryAllShadow(selector, child.shadowRoot));
              }
            }
            return elements;
          }

          const targets = queryAllShadow('#visibility-select, #visibility-display, #trigger, [aria-label*="visibility" i]');
          const host = document.querySelector('ytcp-video-metadata-visibility');
          const clickable = targets.find(el => el.offsetParent !== null) || host;
          if (clickable) {
            clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
            clickable.click();
            return { status: 'success', tag: clickable.tagName, id: clickable.id };
          }
          return { status: 'error' };
        });

        if (visTriggerReopenedResult.status !== 'success') {
          throw new Error('Failed to locate or click Visibility trigger when re-opening.');
        }
        logFn(`[Puppet] Re-opened visibility trigger: [${visTriggerReopenedResult.tag}] id="${visTriggerReopenedResult.id}"`);
        
        logFn('[Puppet] Waiting for visibility popup to render again...');
        await page.waitForSelector('ytcp-video-visibility-edit-popup', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1500));

        // Retry selecting Schedule
        logFn('[Puppet] Selecting Schedule option again...');
        selectScheduleResult = await page.evaluate(() => {
          function queryAllShadow(selector, root = document) {
            const elements = Array.from(root.querySelectorAll(selector));
            const children = Array.from(root.querySelectorAll('*'));
            for (const child of children) {
              if (child.shadowRoot) {
                elements.push(...queryAllShadow(selector, child.shadowRoot));
              }
            }
            return elements;
          }

          const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
          if (!popup) return { status: 'error', reason: 'no-popup-found' };

          const sections = queryAllShadow('ytcp-paper-expandable-section', popup);
          if (sections.length < 2) return { status: 'error', reason: 'insufficient-sections' };

          const scheduleSection = sections.find(sec => {
            const text = (sec.textContent || '').trim().toLowerCase();
            return text.includes('schedule') || text.includes('planla');
          }) || sections[1];

          if (scheduleSection && scheduleSection.offsetParent !== null) {
            const isOpened = scheduleSection.opened || scheduleSection.hasAttribute('opened') || scheduleSection.getAttribute('aria-expanded') === 'true';
            if (!isOpened) {
              const header = scheduleSection.querySelector('#header') || scheduleSection.querySelector('.header') || scheduleSection.querySelector('[role="button"]') || scheduleSection;
              header.click();
              return { status: 'success', action: 'expanded-schedule' };
            }
            return { status: 'success', action: 'schedule-already-expanded' };
          }
          return { status: 'error', reason: 'schedule-not-available' };
        });

        logFn(`[Puppet] Schedule selection status on retry: ${selectScheduleResult.status} (${selectScheduleResult.action || selectScheduleResult.reason || ''})`);
        await new Promise(r => setTimeout(r, 2000));

        if (selectScheduleResult.status !== 'success') {
          throw new Error(`Failed to locate "Schedule" option even after setting video to Private: ${selectScheduleResult.reason || 'unknown reason'}`);
        }
      }

      // Wait for the datetime picker
      await page.waitForSelector('ytcp-datetime-picker, #datepicker-trigger', { timeout: 10000 });

      const dateStr = formatPublishDate(scheduledAt);
      const timeStr = formatPublishTime(scheduledAt);

      logFn(`[Puppet] Entering scheduled date: ${dateStr}...`);
      const dateTrigger = await page.waitForSelector('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]', { timeout: 5000 }).catch(() => null);
      if (dateTrigger) {
        await safeClick(page, dateTrigger, { scroll: true });
        await new Promise(r => setTimeout(r, 1000));
        const calInput = await page.waitForSelector('#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]', { timeout: 3000 }).catch(() => null);
        if (calInput) {
          await safeClick(page, calInput, { scroll: true, focus: true });
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await calInput.type(dateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));
        }
      }
      await new Promise(r => setTimeout(r, 800));

      logFn(`[Puppet] Entering scheduled time: ${timeStr}...`);
      const timeInputSelector = await page.evaluate(() => {
        const container = document.querySelector('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select');
        if (!container) return null;
        const inputs = Array.from(container.querySelectorAll('input'));
        const timeInput = inputs.find(input => {
          const val = input.value || '';
          return val.includes(':') || /\d+:\d+/.test(val);
        }) || inputs[inputs.length - 1]; // fallback to last input in the container
        
        if (timeInput) {
          timeInput.setAttribute('id', 'temp-time-input-target');
          return '#temp-time-input-target';
        }
        return null;
      });

      if (timeInputSelector) {
        const timeInput = await page.waitForSelector(timeInputSelector, { timeout: 5000 }).catch(() => null);
        if (timeInput) {
          await safeClick(page, timeInput, { scroll: true, focus: true });
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await timeInput.type(timeStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));
        }
      }
      await new Promise(r => setTimeout(r, 800));

      logFn(`[Puppet] Toggling "Set as Premiere" option to ${isPremiere}...`);
      try {
        const clickedPremiere = await page.evaluate((targetState) => {
          const checkboxes = Array.from(document.querySelectorAll('ytcp-checkbox, tp-yt-paper-checkbox, paper-checkbox, ytcp-checkbox-group ytcp-checkbox, ytcp-checkbox-lit'));
          const premiereCheckbox = checkboxes.find(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            return text.includes('premiere') || text.includes('gösterim') || text.includes('gosterim');
          });
          if (premiereCheckbox) {
            const isChecked = premiereCheckbox.checked || premiereCheckbox.hasAttribute('checked') || premiereCheckbox.getAttribute('aria-checked') === 'true';
            if (targetState && !isChecked) {
              premiereCheckbox.click();
              return 'clicked_to_check';
            } else if (!targetState && isChecked) {
              premiereCheckbox.click();
              return 'clicked_to_uncheck';
            }
            return 'already_correct';
          }
          return 'not_found';
        }, isPremiere);
        logFn(`[Puppet] Premiere checkbox status: ${clickedPremiere}`);
      } catch (e) {
        logFn(`[Puppet] Warning: failed to toggle premiere checkbox: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800));

      logFn('[Puppet] Clicking Done in Visibility dialog...');
      const doneBtn = await page.waitForSelector('ytcp-video-visibility-edit-popup #save-button, ytcp-video-visibility-edit-popup ytcp-button[id="save-button"], #done-button, ytcp-button[id*="done"]', { timeout: 10000 });
      await safeClick(page, doneBtn, { scroll: true });
      await new Promise(r => setTimeout(r, 2000));
    }

    logFn('[Puppet] Saving video changes...');
    const saveBtn = await page.waitForSelector('ytcp-button#save:not([disabled]):not([aria-disabled="true"]), ytcp-button[id="save"]', { timeout: 15000 }).catch(() => null);
    if (saveBtn) {
      await safeClick(page, saveBtn, { scroll: true });
      logFn('[Puppet] Clicked main save button, waiting for save to complete...');
      await page.waitForSelector('ytcp-button#save[disabled], ytcp-button#save[aria-disabled="true"]', { timeout: 20000 }).catch(() => null);
    } else {
      logFn('[Puppet] Main save button not active or not found. Trying fallback click...');
      const mainSaveClicked = await page.evaluate(() => {
        const btn = document.querySelector('ytcp-button#save:not([disabled])') || document.querySelector('ytcp-button#save:not([aria-disabled="true"])') || document.querySelector('ytcp-button#save');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      logFn(`[Puppet] Fallback save clicked: ${mainSaveClicked}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    logFn('[Puppet] Video update complete.');
    await browser.close();
  } catch (err) {
    logFn(`[Puppet] Video update error: ${err.message}`);
    try {
      await page.screenshot({ path: path.join(profilePath, 'puppet_reschedule_error.png') });
    } catch {}
    try {
      await browser.close();
    } catch {}
    throw err;
  }
}

/**
 * Update the custom thumbnail for a YouTube video using Puppeteer browser session.
 */
export async function updateThumbnailBrowser(channelId, youtubeVideoId, thumbnailPath, logFn = console.log) {
  await closeBrowserSession(channelId);

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up browser lock files
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const f of lockFiles) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet] Starting browser thumbnail update for video ${youtubeVideoId} (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({
        username: proxyConfig.username || '',
        password: proxyConfig.password || ''
      });
    }
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });

    // Override webdriver and plugins to bypass Google bot block
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer' },
          { name: 'Chrome PDF Viewer' },
          { name: 'Chromium PDF Viewer' },
          { name: 'Microsoft Edge PDF Viewer' },
          { name: 'WebKit built-in PDF' }
        ]
      });
    });

    logFn('[Puppet] Navigating to YouTube Studio video edit page...');
    await page.goto(`https://studio.youtube.com/video/${youtubeVideoId}/edit?hl=en&persist_hl=1`, { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if we are redirected to login
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in. Please set up your browser session in the channel settings first.');
    }

    logFn('[Puppet] Uploading custom thumbnail...');
    const thumbInput = await page.waitForSelector('ytcp-thumbnails-compact-editor-uploader input[type="file"], input#file-loader', { timeout: 10000 });
    await thumbInput.uploadFile(thumbnailPath);
    await new Promise(r => setTimeout(r, 2000));

    logFn('[Puppet] Saving video changes...');
    const saveBtn = await page.waitForSelector('#save-button, ytcp-button[id="save"]', { timeout: 10000 });
    await safeClick(page, saveBtn, { scroll: true });
    await new Promise(r => setTimeout(r, 5000));

    logFn('[Puppet] Thumbnail update complete.');
    await browser.close();
  } catch (err) {
    logFn(`[Puppet] Thumbnail update error: ${err.message}`);
    try {
      const screenshotPath = path.join(profilePath, 'puppet_thumbnail_error.png');
      await page.screenshot({ path: screenshotPath });
    } catch {}
    try {
      await browser.close();
    } catch {}
    throw err;
  }
}

/**
 * Post a comment on a YouTube video using Puppeteer browser session.
 * Also deletes any previous owner comment if found, and pins the new comment.
 */
export async function postCommentBrowser(channelId, videoId, text) {
  // 1. Force close active session and clean lock files to prevent locking crashes
  try {
    await closeBrowserSession(channelId);
  } catch (e) {}
  try {
    await stopVncSession();
  } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up browser lock files
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const f of lockFiles) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Puppet Comment] Removed lock file: ${f} for channel ${channelId}`);
      }
    }
  } catch (e) {
    console.warn(`[Puppet Comment] Failed to clean lock files: ${e.message}`);
  }

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  if (!channel) throw new Error(`Channel ${channelId} not found.`);

  const proxy = resolveChannelProxy(channel);
  const proxyUrl = proxy ? proxy.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);
  try {
    const page = await browser.newPage();
    if (proxy && proxy.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    // Set User Agent and Accept-Language (Anti-bot fingerprinting)
    await page.setUserAgent(getUserAgent());
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });

    // Inject Webdriver evasion
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer' },
          { name: 'Chrome PDF Viewer' },
          { name: 'Chromium PDF Viewer' }
        ]
      });
    });

    console.log(`[Puppet Comment] Navigating to: https://www.youtube.com/watch?v=${videoId}`);
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'networkidle2', timeout: 60000 });

    // Explicitly check for expired session or login page redirects
    const isLoginPage = page.url().includes('accounts.google.com') || 
                       await page.$('ytd-button-renderer a[href*="signin"]').catch(() => null);
    if (isLoginPage) {
      throw new Error('Not logged in or session expired. Please set up your browser session in the channel settings first.');
    }

    // Scroll down to load comments robustly
    console.log('[Puppet Comment] Scrolling to trigger comment section...');
    await page.evaluate(() => {
      const el = document.querySelector('#comments') || document.querySelector('ytd-comments');
      if (el) {
        el.scrollIntoView({ block: 'center' });
      } else {
        window.scrollBy(0, 800);
      }
    });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(() => window.scrollBy(0, 100));
    await new Promise(r => setTimeout(r, 2000));

    // Check if comments are disabled on video
    const commentsDisabled = await page.evaluate(() => {
      const container = document.querySelector('#comments');
      if (container) {
        const textContent = container.textContent.toLowerCase();
        return textContent.includes('comments are turned off') || textContent.includes('yorumlar kapalı');
      }
      return false;
    });
    if (commentsDisabled) {
      throw new Error('COMMENTS_DISABLED: Comments are turned off on this video.');
    }

    // 1. Check for existing owner comment to delete
    console.log('[Puppet Comment] Checking for existing comment from owner...');
    const hasOwnerComment = await page.evaluate(() => {
      const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
      return threads.some(thread => thread.querySelector('ytd-author-comment-badge-renderer, #author-comment-badge'));
    });

    if (hasOwnerComment) {
      console.log('[Puppet Comment] Found owner comment, attempting to delete...');
      try {
        const menuBtn = await page.evaluateHandle(() => {
          const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
          const ownerThread = threads.find(t => t.querySelector('ytd-author-comment-badge-renderer, #author-comment-badge'));
          return ownerThread ? ownerThread.querySelector('#action-menu button, #action-menu yt-icon-button') : null;
        });

        if (menuBtn && menuBtn.asElement()) {
          await safeClick(page, menuBtn.asElement(), { scroll: true });
          await new Promise(r => setTimeout(r, 1000));

          const deleted = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('tp-yt-paper-item, paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer'));
            const deleteItem = items.find(item => {
              const txt = (item.textContent || '').toLowerCase();
              return txt.includes('delete') || txt.includes('sil');
            });
            if (deleteItem) {
              deleteItem.click();
              return true;
            }
            return false;
          });

          if (deleted) {
            await new Promise(r => setTimeout(r, 1500));
            await page.evaluate(() => {
              const dialog = document.querySelector('yt-confirm-dialog-renderer, paper-dialog');
              if (dialog) {
                const buttons = Array.from(dialog.querySelectorAll('button, ytd-button-renderer'));
                const confirmBtn = buttons.find(b => {
                  const txt = (b.textContent || '').toLowerCase();
                  return txt.includes('delete') || txt.includes('sil');
                });
                if (confirmBtn) confirmBtn.click();
              }
            });
            console.log('[Puppet Comment] Old comment deleted.');
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      } catch (err) {
        console.warn(`[Puppet Comment] Failed to delete old comment: ${err.message}`);
      }
    }

    // 2. Insert new comment if provided
    if (text && text.trim()) {
      console.log('[Puppet Comment] Locating comment box placeholder...');
      const placeholder = await page.waitForSelector('#simplebox-placeholder, #placeholder-area', { timeout: 15000 }).catch(() => null);
      if (!placeholder) {
        // Fallback to container if specific placeholders not found
        const container = await page.waitForSelector('ytd-comment-simplebox-renderer', { timeout: 5000 }).catch(() => null);
        if (!container) {
          throw new Error('Comment box placeholder not found. Logging out or commenting disabled?');
        }
        console.log('[Puppet Comment] Specific placeholder not found, clicking container...');
        await page.evaluate(el => el.click(), container);
        await container.click().catch(() => null);
      } else {
        console.log('[Puppet Comment] Clicking placeholder...');
        await page.evaluate(el => el.click(), placeholder);
        await placeholder.click().catch(() => null);
      }
      await new Promise(r => setTimeout(r, 1500));

      const editor = await page.waitForSelector('#contenteditable-root', { timeout: 8000 });
      await page.evaluate(el => el.click(), editor);
      await editor.click().catch(() => null);
      await new Promise(r => setTimeout(r, 500));

      console.log('[Puppet Comment] Typing new comment...');
      await page.keyboard.type(text, { delay: 20 });
      await new Promise(r => setTimeout(r, 1000));

      console.log('[Puppet Comment] Submitting new comment...');
      const clickedSubmit = await page.evaluate(() => {
        const box = document.querySelector('ytd-commentbox, ytd-comment-simplebox-renderer');
        if (!box) return false;
        const buttons = Array.from(box.querySelectorAll('button, ytd-button-renderer'));
        const btn = buttons.find(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          return txt.includes('comment') || txt.includes('yorum');
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clickedSubmit) {
        const submitBtn = await page.waitForSelector('#submit-button', { timeout: 5000 });
        await safeClick(page, submitBtn, { scroll: true });
      }

      console.log('[Puppet Comment] Comment submitted.');
      await new Promise(r => setTimeout(r, 4000));

      // 3. Try to pin the new comment (FIXED: Target the owner comment specifically!)
      console.log('[Puppet Comment] Attempting to pin the comment...');
      try {
        const menuBtn = await page.evaluateHandle(() => {
          const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
          // Locate the owner's comment thread specifically
          const ownerThread = threads.find(t => t.querySelector('ytd-author-comment-badge-renderer, #author-comment-badge'));
          return ownerThread ? ownerThread.querySelector('#action-menu button, #action-menu yt-icon-button') : null;
        });

        if (menuBtn && menuBtn.asElement()) {
          await safeClick(page, menuBtn.asElement(), { scroll: true });
          await new Promise(r => setTimeout(r, 1000));

          const pinClicked = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('tp-yt-paper-item, paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer'));
            const pinItem = items.find(item => {
              const txt = (item.textContent || '').toLowerCase();
              return txt.includes('pin') || txt.includes('sabitle');
            });
            if (pinItem) {
              pinItem.click();
              return true;
            }
            return false;
          });

          if (pinClicked) {
            await new Promise(r => setTimeout(r, 1500));
            await page.evaluate(() => {
              const dialog = document.querySelector('yt-confirm-dialog-renderer, paper-dialog');
              if (dialog) {
                const buttons = Array.from(dialog.querySelectorAll('button, ytd-button-renderer'));
                const confirmBtn = buttons.find(b => {
                  const txt = (b.textContent || '').toLowerCase();
                  return txt.includes('pin') || txt.includes('sabitle');
                });
                if (confirmBtn) confirmBtn.click();
              }
            });
            console.log('[Puppet Comment] Comment pinned successfully.');
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      } catch (pinErr) {
        console.warn(`[Puppet Comment] Warning: failed to pin comment: ${pinErr.message}`);
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
