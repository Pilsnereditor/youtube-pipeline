import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { queryOne, queryAll, run } from '../db/database.js';
import { stopVncSession, stopVncSessionForProfile } from './vnc.js';

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
      const escaped = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const { stdout } = await execAsync(`pgrep -f "chrome.*${escaped}"`);
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

// ── Per-channel operation lock ──────────────────────────────────────────────
// Serializes browser operations (reschedule / upload / etc.) for the SAME channel, so two
// never run against the same Chrome profile at the same time (which causes "detached Frame"
// crashes). Callers on the same channel queue and run one after another; different channels
// stay fully independent and run in parallel.
const channelOpQueues = new Map();
// Kill this channel's Chrome + clean its profile so any hung awaited page op inside a
// runaway fn() throws ("Target closed") and unwinds, and the NEXT queued op can launch
// clean instead of colliding on the same locked userDataDir.
async function abortChannelBrowser(channelId, reason) {
  console.warn(`[Puppet] Watchdog aborting channel ${channelId} browser: ${reason}`);
  try { await killOrphanedChrome(getProfilePath(channelId)); } catch (e) {}
  try { await closeBrowserSession(channelId); } catch (e) {}
}

// Runs one channel operation with a liveness watchdog. fn receives { heartbeat }:
//   • idleMs  (opt-in): if heartbeat() isn't called within idleMs, ABORT.  Reset on every beat.
//   • hardCapMs (always on): absolute ceiling regardless of progress.
// On either trip we kill the channel's Chrome, THEN settle (reject) — so the queue tail only
// advances after the zombie browser is gone.
function guardedChannelRun(channelId, fn, idleMs, hardCapMs) {
  return new Promise((resolve, reject) => {
    let settled = false, aborting = false, idleTimer = null, hardTimer = null;
    const clearAll = () => { if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
    const settle = (op) => { if (settled) return; settled = true; clearAll(); op(); };
    const trip = (reason, msg) => {
      if (settled || aborting) return;
      aborting = true;
      abortChannelBrowser(channelId, reason).finally(() => settle(() => reject(new Error(msg))));
    };
    const armIdle = () => {
      if (idleMs == null || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => trip(
        `no progress for ${Math.round(idleMs / 1000)}s`,
        `CHANNEL_OP_STALLED: no upload progress for ${Math.round(idleMs / 60000)} min — browser aborted; will retry.`
      ), idleMs);
    };
    hardTimer = setTimeout(() => trip(
      `hard cap ${Math.round(hardCapMs / 60000)} min exceeded`,
      `CHANNEL_OP_TIMEOUT: operation exceeded ${Math.round(hardCapMs / 60000)} min — browser aborted; will retry.`
    ), hardCapMs);
    const heartbeat = () => armIdle();
    armIdle();
    Promise.resolve()
      .then(() => fn({ heartbeat }))
      .then(
        (v) => settle(() => resolve(v)),
        (e) => { if (aborting) return; settle(() => reject(e)); }
      );
  });
}

export function withChannelLock(channelId, fn, opts = {}) {
  const key = String(channelId);
  const idleMs = opts.idleMs ?? null;                    // opt-in liveness timeout
  const hardCapMs = opts.hardCapMs ?? 30 * 60 * 1000;    // absolute backstop for every caller
  const prev = channelOpQueues.get(key) || Promise.resolve();
  const start = () => guardedChannelRun(channelId, fn, idleMs, hardCapMs);
  const run = prev.then(start, start);
  channelOpQueues.set(key, run.then(() => {}, () => {}));
  return run;
}

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
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
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
    await stopVncSessionForProfile(getProfilePath(channelId));
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
 * Detects the language of YouTube Studio: 'en' or 'tr'
 * @param {object} page Puppeteer Page object
 */
async function detectPageLanguage(page) {
  try {
    return await page.evaluate(() => {
      // 1. Check HTML lang attribute first (most reliable)
      const langAttr = (document.documentElement.lang || '').toLowerCase();
      if (langAttr.startsWith('tr')) return 'tr';
      if (langAttr.startsWith('en')) return 'en';

      // 2. Recursive text search in shadow roots
      function findTextInShadow(textList, root = document) {
        const elements = Array.from(root.querySelectorAll('*'));
        for (const el of elements) {
          const t = (el.textContent || '').trim();
          if (textList.some(txt => t.includes(txt))) {
            return true;
          }
          if (el.shadowRoot) {
            if (findTextInShadow(textList, el.shadowRoot)) {
              return true;
            }
          }
        }
        return false;
      }

      if (findTextInShadow(['Görünürlük', 'Kaydet', 'İptal', 'Planlayın', 'Planla'])) {
        return 'tr';
      }
      return 'en';
    });
  } catch (e) {
    return 'en';
  }
}

/**
 * Formats publish date adaptively based on the initial value's format and language
 */
export function formatPublishDateSelfAdaptive(dateIso, initialValue, lang = 'en') {
  const date = new Date(dateIso);
  const dd = String(date.getDate());
  const ddpadded = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  if (initialValue && initialValue !== 'not_found' && initialValue.trim() !== '') {
    const val = initialValue.trim();
    
    // Check for dot-separated format (e.g. "10.06.2026")
    if (val.includes('.')) {
      const parts = val.split('.');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return `${yyyy}.${mm}.${ddpadded}`;
        } else {
          return `${ddpadded}.${mm}.${yyyy}`;
        }
      }
    }
    
    // Check for slash-separated format (e.g. "10/06/2026" or "06/10/2026")
    if (val.includes('/')) {
      const parts = val.split('/');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return `${yyyy}/${mm}/${ddpadded}`;
        } else {
          if (lang === 'tr') {
            return `${ddpadded}/${mm}/${yyyy}`;
          } else {
            return `${mm}/${ddpadded}/${yyyy}`;
          }
        }
      }
    }

    // Check for dash-separated format (e.g. "2026-06-10")
    if (val.includes('-')) {
      const parts = val.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return `${yyyy}-${mm}-${ddpadded}`;
        } else {
          return `${ddpadded}-${mm}-${yyyy}`;
        }
      }
    }

    // Check if it's space-separated with a month name (e.g., "12 Haz 2026" or "Jun 12, 2026")
    if (val.includes(' ')) {
      const trMonths = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
      const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      
      const hasTrMonth = trMonths.some(m => val.toLowerCase().includes(m.toLowerCase()));
      const hasEnMonth = enMonths.some(m => val.toLowerCase().includes(m.toLowerCase()));

      if (hasTrMonth || lang === 'tr') {
        const monthName = trMonths[date.getMonth()];
        return `${dd} ${monthName} ${yyyy}`;
      } else if (hasEnMonth || lang === 'en') {
        const monthName = enMonths[date.getMonth()];
        return `${monthName} ${dd}, ${yyyy}`;
      }
    }
  }

  // Fallback based on language
  if (lang === 'tr') {
    const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    const mmName = months[date.getMonth()];
    return `${dd} ${mmName} ${yyyy}`;
  } else {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mmName = months[date.getMonth()];
    return `${mmName} ${dd}, ${yyyy}`;
  }
}

/**
 * Formats publish time adaptively based on the initial value's format and language
 */
export function formatPublishTimeSelfAdaptive(dateIso, initialValue, lang = 'en') {
  const date = new Date(dateIso);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  if (initialValue && initialValue !== 'not_found' && initialValue.trim() !== '') {
    const val = initialValue.trim().toLowerCase();
    const hasAmPm = val.includes('am') || val.includes('pm') || val.includes('a.m.') || val.includes('p.m.');
    if (!hasAmPm) {
      const hh = String(hours).padStart(2, '0');
      return `${hh}:${minutes}`;
    } else {
      let h = hours % 12;
      h = h ? h : 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${h}:${minutes} ${ampm}`;
    }
  }

  if (lang === 'tr') {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${minutes}`;
  } else {
    let h = hours % 12;
    h = h ? h : 12;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${h}:${minutes} ${ampm}`;
  }
}

/**
 * Formats publish date to YouTube-accepted text based on locale: "May 31, 2026" or "31 May 2026"
 */
export function formatPublishDate(dateIso, lang = 'en') {
  return formatPublishDateSelfAdaptive(dateIso, null, lang);
}

/**
 * Formats publish time to YouTube-accepted text based on locale: "7:00 PM" or "19:00"
 */
export function formatPublishTime(dateIso, lang = 'en') {
  return formatPublishTimeSelfAdaptive(dateIso, null, lang);
}

/**
 * Formats a target date matching the locale/format pattern detected from the input's initial value.
 */
export function formatDateLikeInitial(initialValue, targetDateIso) {
  try {
    const date = new Date(targetDateIso);
    if (isNaN(date.getTime())) return initialValue;
    const day = date.getDate();
    const month = date.getMonth(); // 0-11
    const year = date.getFullYear();

    // English month names
    const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // Turkish month names
    const trMonths = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

    const initialClean = (initialValue || '').trim();
    if (!initialClean) {
      return `${enMonths[month]} ${day}, ${year}`;
    }

    // 1. Detect if it's like "Jun 12, 2026" (Month Day, Year)
    if (/[a-zA-Z]{3,9}\s+\d{1,2},\s+\d{4}/.test(initialClean)) {
      const mm = enMonths[month];
      return `${mm} ${day}, ${year}`;
    }

    // 2. Detect if it's like "12 Haz 2026" or "12 June 2026"
    if (/\d{1,2}\s+[a-zA-ZğüşıöçĞÜŞİÖÇ]{3,9}\s+\d{4}/.test(initialClean)) {
      const isTurkish = /[a-zA-ZğüşıöçĞÜŞİÖÇ]/.test(initialClean) && 
                        (initialClean.includes('Oca') || initialClean.includes('Şub') || initialClean.includes('Mar') ||
                         initialClean.includes('Nis') || initialClean.includes('May') || initialClean.includes('Haz') ||
                         initialClean.includes('Tem') || initialClean.includes('Ağu') || initialClean.includes('Eyl') ||
                         initialClean.includes('Eki') || initialClean.includes('Kas') || initialClean.includes('Ara'));
      const months = isTurkish ? trMonths : enMonths;
      const mm = months[month];
      return `${day} ${mm} ${year}`;
    }

    // 3. Detect numeric formats (e.g. 12.06.2026, 12/06/2026, 2026-06-12)
    let separator = null;
    if (initialClean.includes('.')) separator = '.';
    else if (initialClean.includes('/')) separator = '/';
    else if (initialClean.includes('-')) separator = '-';

    if (separator) {
      const parts = initialClean.split(separator);
      if (parts.length === 3) {
        const yearIdx = parts.findIndex(p => p.trim().length === 4);
        if (yearIdx === 0) {
          const mm = String(month + 1).padStart(2, '0');
          const dd = String(day).padStart(2, '0');
          return `${year}${separator}${mm}${separator}${dd}`;
        } else if (yearIdx === 2) {
          const p0 = parseInt(parts[0], 10);
          const p1 = parseInt(parts[1], 10);
          
          let dayFirst = true; // Default to Day first (Turkish / European)
          
          // Calibrate based on current date
          const today = new Date();
          const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
          const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
          
          const matchDate = (d) => {
            const ddStr = String(d.getDate()).padStart(2, '0');
            const mmStr = String(d.getMonth() + 1).padStart(2, '0');
            const dStr = String(d.getDate());
            const mStr = String(d.getMonth() + 1);
            
            if ((parts[0] === ddStr || parts[0] === dStr) && (parts[1] === mmStr || parts[1] === mStr)) {
              dayFirst = true;
              return true;
            }
            if ((parts[1] === ddStr || parts[1] === dStr) && (parts[0] === mmStr || parts[0] === mStr)) {
              dayFirst = false;
              return true;
            }
            return false;
          };

          const matched = matchDate(today) || matchDate(tomorrow) || matchDate(dayAfter);
          
          const dd = String(day).padStart(2, '0');
          const mm = String(month + 1).padStart(2, '0');
          
          if (matched) {
            return dayFirst ? `${dd}${separator}${mm}${separator}${year}` : `${mm}${separator}${dd}${separator}${year}`;
          } else {
            // Default to Turkish DD.MM.YYYY
            return `${dd}${separator}${mm}${separator}${year}`;
          }
        }
      }
    }
    
    // Fallback to standard English
    return `${enMonths[month]} ${day}, ${year}`;
  } catch (err) {
    return initialValue;
  }
}

/**
 * Formats a target time matching the locale/format pattern detected from the input's initial value.
 */
export function formatTimeLikeInitial(initialValue, targetDateIso) {
  try {
    const date = new Date(targetDateIso);
    if (isNaN(date.getTime())) return initialValue;
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    const initialClean = (initialValue || '').trim().toUpperCase();
    if (!initialClean) {
      // Fallback: format to standard English 12h
      let h = hours % 12;
      h = h ? h : 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${h}:${minutes} ${ampm}`;
    }
    
    const is12Hour = initialClean.includes('AM') || initialClean.includes('PM');
    
    if (is12Hour) {
      let h = hours % 12;
      h = h ? h : 12; // Hour 0 becomes 12
      const ampm = hours >= 12 ? 'PM' : 'AM';
      // Check if initial value has leading zero for hours (e.g. "07:30 PM")
      const hourPart = initialClean.match(/^\d+/);
      const hasLeadingZero = hourPart && hourPart[0].startsWith('0') && hourPart[0].length === 2;
      const hStr = hasLeadingZero ? String(h).padStart(2, '0') : String(h);
      return `${hStr}:${minutes} ${ampm}`;
    } else {
      // 24-hour format
      const hh = String(hours).padStart(2, '0');
      return `${hh}:${minutes}`;
    }
  } catch (err) {
    return initialValue;
  }
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
// Reliably set a YouTube Studio contenteditable field (title/description). Uses
// document.execCommand('insertText'), which inserts emoji (💥) and unicode (Turkish İ/ı) in ONE
// shot and fires the input events Polymer listens to. page.keyboard.type() types key-by-key, drops
// emoji, and can stop early — which truncated titles like "…KASA KAT". Falls back to keyboard
// typing only if insertText fails, so worst case is no worse than before.
async function setEditableText(page, elementHandle, text, logFn = console.log) {
  try {
    await safeClick(page, elementHandle, { scroll: true, focus: true });
    await new Promise(r => setTimeout(r, 120));
    const ok = await page.evaluate((el, value) => {
      if (!el) return false;
      el.focus();
      try { document.execCommand('selectAll', false, null); } catch (e) {}
      return document.execCommand('insertText', false, value);
    }, elementHandle, text || '');
    if (ok) { await new Promise(r => setTimeout(r, 300)); return; }
  } catch (e) {
    logFn(`[Puppet] setEditableText insertText failed (${e.message}); falling back to keyboard typing.`);
  }
  // Fallback: clear + keyboard type
  await safeClick(page, elementHandle, { scroll: true, focus: true });
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text || '');
  await new Promise(r => setTimeout(r, 300));
}

// ── Premiere / schedule helpers (trusted clicks + verify/re-apply) ───────────
// The premiere checkbox must be clicked with a REAL (trusted) mouse event; an untrusted
// el.click() inside page.evaluate() left YouTube's premiere half-set and flipped the primary
// button to "Done" (root cause of scheduled=false on premieres).
async function findPremiereCheckboxHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const nodes = Array.from(document.querySelectorAll(
      'ytcp-checkbox, tp-yt-paper-checkbox, paper-checkbox, ytcp-checkbox-group ytcp-checkbox, ytcp-checkbox-lit'
    ));
    return nodes.find(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t.includes('premiere') || t.includes('gösterim') || t.includes('gosterim');
    }) || null;
  });
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}

async function isPremiereChecked(page, handle) {
  if (!handle) return false;
  return await page.evaluate(
    cb => !!(cb && (cb.checked || cb.hasAttribute('checked') || cb.getAttribute('aria-checked') === 'true')),
    handle
  );
}

async function togglePremiere(page, desired, logFn = console.log) {
  const handle = await findPremiereCheckboxHandle(page);
  if (!handle) { logFn('[Puppet] Premiere checkbox not found.'); return 'not_found'; }
  try {
    if (await isPremiereChecked(page, handle) === desired) {
      return 'already_' + (desired ? 'checked' : 'unchecked');
    }
    try {
      await handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await new Promise(r => setTimeout(r, 150));
      await handle.click();                                   // TRUSTED CDP mouse click
    } catch (e) {
      logFn(`[Puppet] Trusted premiere click failed (${e.message}); trying inner target.`);
    }
    await new Promise(r => setTimeout(r, 900));
    if (await isPremiereChecked(page, handle) !== desired) {  // retry via inner clickable node
      try {
        const inner = await handle.evaluateHandle(el =>
          (el.shadowRoot && el.shadowRoot.querySelector('#checkbox, [role="checkbox"], .checkbox-container'))
          || el.querySelector('#checkbox, [role="checkbox"]') || el);
        const innerEl = inner.asElement();
        if (innerEl) { await innerEl.click().catch(() => {}); }
        await inner.dispose();
      } catch (e) {}
      await new Promise(r => setTimeout(r, 700));
    }
    if (await isPremiereChecked(page, handle) !== desired) {  // last resort: untrusted toggle
      await handle.evaluate(el => el.click()).catch(() => {});
      await new Promise(r => setTimeout(r, 700));
    }
    return (await isPremiereChecked(page, handle) === desired)
      ? (desired ? 'checked' : 'unchecked') : 'toggle_failed';
  } finally {
    await handle.dispose();
  }
}

// ── Visible-button resolution + trusted clicks ─────────────────────────────────
// querySelector('#a, #b') / waitForSelector('#a, #b') return the FIRST element in DOM order matching
// ANY selector (not the first selector), with NO visibility filter. A hidden #done-button precedes
// the visible #schedule-button in the uploads dialog, so old code read/CLICKED the wrong (hidden)
// button → YouTube saved a private DRAFT. Always pick the VISIBLE, ENABLED button and click it TRUSTED.
async function getPrimaryButtonHandle(page) {
  const jsHandle = await page.evaluateHandle(() => {
    function deep(sel, root = document, out = []) {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
      return out;
    }
    const cands = deep('#schedule-button, #done-button, #publish-button, #save-button, ' +
      'ytcp-button[id*="schedule"], ytcp-button[id*="done"], ytcp-button[id*="publish"], ytcp-button[id*="save"]');
    const enabled = el => !(el.disabled === true || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
    const visible = cands.filter(el => el && el.offsetParent !== null);
    return visible.find(el => /schedule/i.test(el.id || '') && enabled(el))
        || visible.find(enabled) || visible[0] || null;
  });
  const el = jsHandle.asElement();
  if (!el) { await jsHandle.dispose(); return { handle: null, id: '', label: '' }; }
  const info = await el.evaluate(n => ({
    rawId: n.id || (n.getAttribute && n.getAttribute('id')) || '',
    label: ((n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim())
  }));
  // CRITICAL: the current YouTube uploads dialog keeps the primary button's id="done-button" and only
  // changes its LABEL to "Schedule" when the video is in schedule mode (premieres default to this, and
  // there are no visibility radios anymore). So schedule-ness must be judged by the LABEL, not the id.
  // Report a schedule-aware id ("schedule-button") so every downstream /schedule/i check is correct.
  const scheduled = /schedule/i.test(info.rawId) || /schedule|zamanla|planla/i.test(info.label);
  const id = scheduled ? 'schedule-button' : info.rawId;
  return { handle: el, id, label: info.label };
}

async function trustedClickHandle(page, handle, logFn = console.log) {
  if (!handle) return false;
  try {
    await handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await new Promise(r => setTimeout(r, 150));
    await handle.click();
    return true;
  } catch (e) {
    logFn(`[Puppet] Trusted click failed (${e.message}); trying inner node / untrusted.`);
    try {
      const inner = await handle.evaluateHandle(el =>
        (el.shadowRoot && el.shadowRoot.querySelector('#button, [role="button"], button, #radio, [role="radio"], #checkbox')) || el);
      const innerEl = inner.asElement();
      if (innerEl) { try { await innerEl.click(); } catch (_) { await innerEl.evaluate(n => n.click()).catch(() => {}); } }
      await inner.dispose();
      return true;
    } catch (e2) {
      await handle.evaluate(el => el.click()).catch(() => {});
      return false;
    }
  }
}

// Select the "Schedule" visibility option with a TRUSTED click. SUCCESS = the primary button flips
// to "schedule-button" (picker-visible is NOT sufficient — YouTube shows the schedule card even when
// it is not selected, which made the old check falsely succeed while the button stayed "done-button").
async function activateScheduleMode(page, logFn = console.log) {
  const isArmed = async () => /schedule/i.test(await getPrimaryButtonId(page) || '');
  const pickerVisible = () => page.evaluate(() => {
    function deep(sel, root = document, out = []) {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
      return out;
    }
    return deep('#datepicker-trigger, ytcp-datetime-picker, ytcp-visibility-scheduler ytcp-text-input')
      .some(el => el && el.offsetParent !== null);
  });
  if (await isArmed()) return true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const h = await page.evaluateHandle(() => {
      function deep(sel, root = document, out = []) {
        out.push(...root.querySelectorAll(sel));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
        return out;
      }
      const vis  = el => el && el.offsetParent !== null;
      const norm = s => (s || '').trim().toLowerCase();
      // Prefer the real radio control for Schedule; then a radio whose label is Schedule; then a
      // Schedule row inside the visibility select.
      let t = deep('#schedule-radio-button, tp-yt-paper-radio-button[name="SCHEDULE"], [role="radio"][id*="schedule" i]').find(vis);
      if (!t) t = deep('tp-yt-paper-radio-button, [role="radio"]').find(el => vis(el) && /^(schedule|planla)/.test(norm(el.textContent)));
      if (!t) t = deep('ytcp-video-visibility-select *, #publish-from-private-non-sponsor-selector *').find(el => vis(el) && /^(schedule|planla)/.test(norm(el.textContent)) && el.children.length <= 3);
      return t || null;
    });
    const el = h.asElement();
    if (el) {
      await trustedClickHandle(page, el, logFn);   // trusted click on the radio
      await new Promise(r => setTimeout(r, 400));
      try {
        // Also trusted-click the inner radio node (Polymer sometimes only reacts to the inner control).
        const inner = await el.evaluateHandle(n => (n.shadowRoot && n.shadowRoot.querySelector('#radioContainer, [role="radio"], #radio, input')) || null);
        const innerEl = inner.asElement();
        if (innerEl) { await innerEl.click().catch(() => {}); }
        await inner.dispose();
      } catch (e) {}
      await el.dispose();
    }
    await h.dispose();
    await new Promise(r => setTimeout(r, 1200));
    const armed = await isArmed();
    logFn(`[Puppet] Schedule activation attempt ${attempt}: armed=${armed} picker=${await pickerVisible()} button="${await getPrimaryButtonId(page)}"`);
    if (armed) return true;
  }
  // Could not arm schedule mode — dump the visibility-step controls so a precise selector can be written.
  try {
    const dump = await page.evaluate(() => {
      function deep(sel, root = document, out = []) {
        out.push(...root.querySelectorAll(sel));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
        return out;
      }
      const vis = el => el && el.offsetParent !== null;
      const desc = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
        `${el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : ''}` +
        `${el.getAttribute('aria-checked') ? '[aria-checked=' + el.getAttribute('aria-checked') + ']' : ''}` +
        `${el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : ''}` +
        ` "${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
      const radios = deep('tp-yt-paper-radio-button, [role="radio"]').filter(vis).map(desc).slice(0, 14);
      const buttons = deep('ytcp-button, button').filter(el => vis(el) && el.id).map(desc).slice(0, 14);
      return { radios, buttons };
    });
    logFn(`[Puppet] SCHEDULE-STEP DUMP radios: ${JSON.stringify(dump.radios)}`);
    logFn(`[Puppet] SCHEDULE-STEP DUMP buttons: ${JSON.stringify(dump.buttons)}`);
  } catch (e) { logFn(`[Puppet] schedule-step dump failed: ${e.message}`); }
  return false;
}

async function getPrimaryButtonId(page) {
  const { handle, id } = await getPrimaryButtonHandle(page);
  if (handle) await handle.dispose();
  return id;
}

async function readScheduleValues(page) {
  return await page.evaluate(() => {
    function deep(sel, root = document, out = []) {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
      return out;
    }
    // Date: an OPEN calendar exposes an <input>; when CLOSED the date is only the TEXT of the
    // dropdown-trigger button (e.g. "Jul 17, 2026") — reading only the input made date report "".
    const dateInput = deep('#datepicker-trigger input, ytcp-date-picker input, input[aria-label*="date" i], input[placeholder*="date" i]')[0];
    let date = dateInput ? (dateInput.value || '') : '';
    if (!date) {
      const trig = deep('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker').find(el => el && el.offsetParent !== null);
      if (trig) {
        const txt = (trig.innerText || trig.textContent || '').replace(/\s+/g, ' ').trim();
        const m = txt.match(/[A-Za-zÇĞİÖŞÜçğıöşü]{3,}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[./]\d{1,2}[./]\d{2,4}/);
        date = m ? m[0] : txt;
      }
    }
    const timeInput = deep('input').find(i => /\d{1,2}:\d{2}/.test(i.value || '')) || null;
    return { date, time: timeInput ? timeInput.value : '' };
  });
}

function scheduleIsIntact(vals, opts) {
  const tok = s => ((s || '').toLowerCase().match(/[a-zçğıöşü]+|\d+/g) || []).map(t => t.replace(/^0+(\d)/, '$1'));
  const dWant = tok(formatDateLikeInitial(vals.date, opts.scheduledAt));
  const dGot = new Set(tok(vals.date));
  const tWant = tok(formatTimeLikeInitial(vals.time, opts.scheduledAt));
  const tGot = new Set(tok(vals.time));
  const dateOk = !!vals.date && dWant.length > 0 && dWant.every(t => dGot.has(t));
  const timeOk = !!vals.time && tWant.length > 0 && tWant.every(t => tGot.has(t));
  return { dateOk, timeOk, ok: dateOk && timeOk };
}

async function reapplyDateTime(page, opts, logFn = console.log) {
  const opened = await page.evaluate(() => {
    function deep(sel, root = document, out = []) {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
      return out;
    }
    const trig = deep('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]')[0];
    if (trig) { trig.scrollIntoView({ block: 'center', inline: 'nearest' }); trig.click(); return true; }
    return false;
  });
  if (opened) {
    await new Promise(r => setTimeout(r, 600));
    const dInit = await page.evaluate(() => {
      function deep(sel, root = document, out = []) {
        out.push(...root.querySelectorAll(sel));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
        return out;
      }
      const i = deep('#datepicker-trigger input, ytcp-date-picker input, input[aria-label*="date" i], input[placeholder*="date" i]')[0];
      if (i) { i.click(); i.focus(); return i.value || ''; }
      return '';
    });
    const targetDateStr = formatDateLikeInitial(dInit, opts.scheduledAt);
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 25; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type(targetDateStr, { delay: 50 });
    await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 400));
    await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 400));
    logFn(`[Puppet] Re-applied date: "${targetDateStr}"`);
  }
  const tInit = await page.evaluate(() => {
    function deep(sel, root = document, out = []) {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
      return out;
    }
    const inputs = deep('input');
    const t = inputs.find(i => /\d{1,2}:\d{2}/.test(i.value || '')) || inputs[inputs.length - 1];
    if (t) { t.scrollIntoView({ block: 'center', inline: 'nearest' }); t.click(); t.focus(); return t.value || ''; }
    return null;
  });
  if (tInit !== null) {
    const targetTimeStr = formatTimeLikeInitial(tInit, opts.scheduledAt);
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 25; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type(targetTimeStr, { delay: 50 });
    await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 400));
    await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 400));
    logFn(`[Puppet] Re-applied time: "${targetTimeStr}"`);
  }
}


export async function uploadVideoBrowser(channelId, opts, logFn = console.log) {
  // Auto-close any active login window to release profile lock
  await closeBrowserSession(channelId);
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

  // Optional progress reporter: (percent 0-100, label) -> void
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

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

    // Verify the file exists first — a missing file would leave an empty dialog and a confusing timeout.
    if (!opts.videoPath || !fs.existsSync(opts.videoPath)) {
      throw new Error(`Video file not found on server: ${opts.videoPath || '(empty path)'} - it may have been moved or cleaned up before this scheduled upload ran.`);
    }

    // Click "Upload videos" with a TRUSTED click and CONFIRM the upload dialog actually opens. YouTube's
    // Polymer menu intermittently IGNORES untrusted (page.evaluate) clicks — the same failure mode as the
    // schedule radio — which left the dialog unopened, so the file went to a stray input and the page just
    // sat on the dashboard ("title box did not appear within 90s"). Retry, reopening Create, up to 3x.
    logFn('[Puppet] Selecting "Upload videos" (trusted) and confirming the dialog opens...');
    let uploadDialogOpen = false;
    for (let attempt = 1; attempt <= 3 && !uploadDialogOpen; attempt++) {
      const menu = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('tp-yt-paper-item, paper-item, ytcp-menu-item-text, ytcp-menu-service-item-renderer, ytd-menu-service-item-renderer, [role="menuitem"]'));
        const up = items.find(el => { const t = (el.textContent || '').toLowerCase(); return t.includes('upload') || t.includes('yükle') || t.includes('video ekle'); });
        if (up) { up.setAttribute('data-gag-upload', '1'); return { found: true, count: items.length }; }
        return { found: false, count: items.length };
      });
      logFn(`[Puppet] Create menu: ${menu.count} items, "Upload videos" found: ${menu.found} (attempt ${attempt})`);
      if (menu.found) {
        const h = await page.$('[data-gag-upload="1"]');
        if (h) {
          await h.click().catch(() => {});                                   // TRUSTED click
          await h.evaluate(el => el.removeAttribute('data-gag-upload')).catch(() => {});
          await h.dispose();
        }
      } else {
        // Menu not rendered yet (slow proxy) — reopen the Create menu and wait longer before retrying.
        await createBtn.click().catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
      }
      uploadDialogOpen = await page.waitForSelector('ytcp-uploads-dialog, ytcp-uploads-file-picker, #select-files-button', { timeout: 12000 }).then(() => true).catch(() => false);
      logFn(`[Puppet] Upload dialog open after attempt ${attempt}: ${uploadDialogOpen}`);
    }
    if (!uploadDialogOpen) {
      throw new Error('The upload dialog did not open after selecting "Upload videos" (the menu click was ignored, or the page was too slow to render the dialog).');
    }

    logFn('[Puppet] Upload dialog open. Selecting the video file...');

    // Wait until the picker is fully ready before attaching (avoids attaching to a half-rendered dialog).
    await page.waitForFunction(() => {
      function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
      const vis = el => el && el.offsetParent !== null;
      return deep('#select-files-button').some(vis) || deep('ytcp-uploads-file-picker input[type="file"]').length > 0;
    }, { timeout: 15000 }).catch(() => {});

    // Are we still stuck on the "Select files / drag & drop" screen (i.e. the upload never started)?
    const onSelectScreen = async () => await page.evaluate(() => {
      function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
      const vis = el => el && el.offsetParent !== null;
      return deep('#select-files-button').some(vis) && !deep('#title-textarea #textbox')[0];
    }).catch(() => false);

    // Method A: direct file-set on the input, then EXPLICITLY fire input/change (YouTube sometimes misses
    // the programmatic set — the observed failure: "Attached" logged but dialog stayed on Select files).
    const attachViaInput = async () => {
      const inputHandle = await page.evaluateHandle(() => {
        function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
        return deep('ytcp-uploads-file-picker input[type="file"]')[0] || deep('input[type="file"]')[0] || null;
      });
      const inputEl = inputHandle.asElement();
      if (inputEl) {
        await inputEl.uploadFile(opts.videoPath);
        await inputEl.evaluate(el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {});
      }
      await inputHandle.dispose();
      return !!inputEl;
    };

    // Method B: TRUSTED click on the visible "SELECT FILES" button -> native chooser -> accept (YouTube's
    // real flow; a trusted click is what its Polymer UI reliably honours).
    const attachViaChooser = async () => {
      const fileChooserPromise = page.waitForFileChooser({ timeout: 20000 });
      const tagged = await page.evaluate(() => {
        function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
        const vis = el => el && el.offsetParent !== null;
        const btn = deep('#select-files-button').find(vis) || deep('ytcp-button, button').find(el => vis(el) && /select files|dosya seç/i.test(el.textContent || ''));
        if (btn) { btn.setAttribute('data-gag-selectfiles', '1'); return true; }
        return false;
      });
      if (!tagged) { await fileChooserPromise.catch(() => {}); return false; }
      const h = await page.$('[data-gag-selectfiles="1"]');
      if (h) { await h.click().catch(() => {}); await h.evaluate(el => el.removeAttribute('data-gag-selectfiles')).catch(() => {}); await h.dispose(); }
      const fileChooser = await fileChooserPromise;
      await fileChooser.accept([opts.videoPath]);
      return true;
    };

    // Try up to 3 times, alternating methods, and VERIFY the dialog actually left the select-files screen.
    let _fileStarted = false;
    for (let attempt = 1; attempt <= 3 && !_fileStarted; attempt++) {
      try {
        if (attempt === 1) { await attachViaChooser(); logFn('[Puppet] Selected file via SELECT FILES chooser (attempt 1).'); }
        else { await attachViaInput(); logFn(`[Puppet] Attached file via direct input + events (attempt ${attempt}).`); }
      } catch (e) {
        logFn(`[Puppet] File-select attempt ${attempt} error: ${e.message}`);
      }
      for (let w = 0; w < 6 && !_fileStarted; w++) {
        await new Promise(r => setTimeout(r, 2000));
        _fileStarted = !(await onSelectScreen());
      }
      logFn(`[Puppet] Upload started (left select-files screen) after attempt ${attempt}: ${_fileStarted}`);
    }
    if (!_fileStarted) {
      logFn('[Puppet] WARNING: file did not start uploading (still on select-files screen after 3 attempts).');
    }

    logFn('[Puppet] Video file submitted, waiting for upload details to load...');
    onProgress(10, 'Uploading video…');

    // Wait for the upload details dialog (title box) to appear. On slow proxies / under load this can
    // take much longer than a few seconds, so be patient AND self-diagnosing: if it never appears, log
    // exactly what WAS on the page so we can tell slow-render apart from an upload block (daily limit,
    // verify-it's-you, consent wall, logged out) instead of an opaque "selector failed".
    let titleInput = null;
    const _titleDeadline = Date.now() + 90000;   // up to 90s (was a flat 30s)
    let _lastSnap = '';
    let _pollN = 0;
    while (Date.now() < _titleDeadline) {
      titleInput = await page.$('#title-textarea #textbox');
      if (titleInput) break;
      const _st = await page.evaluate(() => {
        const txt = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
        const low = txt.toLowerCase();
        let block = '';
        if (/reached your daily upload limit|daily upload limit|upload limit/.test(low)) block = 'DAILY_UPLOAD_LIMIT';
        else if (/verify (it'?s|its) you|confirm it'?s you|unusual traffic|verify your account|do\u011frula/.test(low)) block = 'VERIFY_REQUIRED';
        else if (/sign in|oturum a\u00e7/.test(low) || location.href.includes('accounts.google.com')) block = 'LOGGED_OUT';
        else if (/before you continue|accept all|reject all|consent|\u00e7erez/.test(low)) block = 'CONSENT_WALL';
        const hasDialog = !!document.querySelector('ytcp-uploads-dialog, ytcp-video-metadata-editor, ytcp-uploads-details');
        return { snippet: txt.slice(0, 400), block, hasDialog };
      }).catch(() => ({ snippet: '', block: '', hasDialog: false }));
      if (_st.block) {
        throw new Error(`Upload blocked by YouTube (${_st.block}). Page said: "${_st.snippet}"`);
      }
      _lastSnap = _st.snippet;
      if (_pollN++ % 5 === 0) {
        logFn(`[Puppet] Waiting for upload details dialog... ${Math.round((Date.now() - (_titleDeadline - 90000)) / 1000)}s (dialog present: ${_st.hasDialog})`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!titleInput) {
      logFn(`[Puppet] Upload details title box never appeared. URL: ${page.url()}`);
      logFn(`[Puppet] Visible page text at timeout: "${_lastSnap}"`);
      // Pinpoint WHY: is the dialog actually open+visible? still on the "select files" screen (file never
      // attached)? how many file inputs exist? any error toast? This separates file-not-attached from
      // dialog-closed from an upload error.
      try {
        const diag = await page.evaluate(() => {
          function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
          const vis = el => el && el.offsetParent !== null;
          const dlg = deep('ytcp-uploads-dialog')[0];
          const picker = deep('ytcp-uploads-file-picker')[0];
          const errs = deep('[role="alert"], tp-yt-paper-toast, ytcp-uploads-error-dialog, .error-short').filter(vis).map(e => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140)).filter(Boolean);
          return {
            dialogPresent: !!dlg, dialogVisible: vis(dlg),
            pickerPresent: !!picker, pickerVisible: vis(picker),
            selectFilesVisible: deep('#select-files-button').some(vis),
            fileInputCount: deep('input[type="file"]').length,
            dialogText: dlg ? (dlg.innerText || dlg.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220) : '',
            errors: errs
          };
        });
        logFn(`[Puppet] TITLE-TIMEOUT DIAG: ${JSON.stringify(diag)}`);
      } catch (e) { logFn(`[Puppet] title-timeout diag failed: ${e.message}`); }
      throw new Error(`Upload details dialog (title box) did not appear within 90s. Page text: "${_lastSnap.slice(0, 200)}"`);
    }
    
    // Extract the Video ID early from the dialog (since YouTube generates it immediately)
    let youtubeVideoId = '';
    function extractVideoId(url) {
      if (!url) return '';
      // Real YouTube IDs are EXACTLY 11 chars. Require 11 and anchor to a terminator so we never
      // capture a truncated/wrong fragment (a wrong ID points /video/<id>/edit at a nonexistent
      // video, so the visibility editor never loads no matter how many times we reload).
      const patterns = [
        /\/shorts\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/,
        /[?&]v=([a-zA-Z0-9_-]{11})(?=[&#]|$)/,
        /\/video\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/,
      ];
      for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
      }
      return '';
    }
    try {
      await page.waitForSelector('span.video-url-text a, #share-url, .video-url-fadeable a, a.style-scope.ytcp-video-info', { timeout: 15000 }).catch(() => null);
      // Pick the REAL video URL, not the channel-info link. The first matching anchor is often
      // studio.youtube.com/channel/… which yields an empty ID; scan all candidates and take the
      // one whose href/text is an actual video URL (youtu.be / watch?v= / /video/).
      const videoLink = await page.evaluate(() => {
        const sels = ['span.video-url-text a', '#share-url', '.video-url-fadeable a', 'a.style-scope.ytcp-video-info'];
        const rx = /youtu\.be\/[a-zA-Z0-9_-]{11}|[?&]v=[a-zA-Z0-9_-]{11}|\/video\/[a-zA-Z0-9_-]{11}/;
        for (const sel of sels) {
          for (const a of document.querySelectorAll(sel)) {
            const h = a.href || a.textContent || '';
            if (rx.test(h)) return h;
          }
        }
        const el = document.querySelector('span.video-url-text a') || document.querySelector('#share-url');
        return el ? (el.href || el.textContent || '') : '';
      }).catch(() => '');
      logFn(`[Puppet] Generated video link: ${videoLink}`);
      youtubeVideoId = extractVideoId(videoLink);
      logFn(`[Puppet] Extracted YouTube Video ID: ${youtubeVideoId}`);
    } catch (e) {
      logFn(`[Puppet] Warning: could not retrieve video ID early: ${e.message}`);
    }

    logFn('[Puppet] Inputting title...');
    await setEditableText(page, titleInput, opts.title, logFn);

    logFn('[Puppet] Inputting description...');
    // Patient + non-fatal: right after a big upload starts, the description box can lag. Description is
    // optional on YouTube, so if it never shows we log and continue rather than failing the whole upload.
    let descInput = null;
    for (let a = 1; a <= 8 && !descInput; a++) {
      descInput = await page.$('#description-textarea #textbox');
      if (!descInput) await new Promise(r => setTimeout(r, 2500));
    }
    if (descInput) {
      await setEditableText(page, descInput, opts.description || '', logFn);
    } else {
      logFn('[Puppet] WARNING: description box did not appear (~20s); continuing without a description.');
    }

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
      const kidsRadio = await page.waitForSelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_FOR_KIDS"]', { timeout: 10000 });
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
    const nextBtn1 = await page.waitForSelector('#next-button', { timeout: 20000 });
    await safeClick(page, nextBtn1, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Step 2: Video Elements -> Checks
    logFn('[Puppet] Transitioning from Video Elements to Checks...');
    const nextBtn2 = await page.waitForSelector('#next-button', { timeout: 20000 });
    await safeClick(page, nextBtn2, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Step 3: Checks -> Visibility
    logFn('[Puppet] Transitioning from Checks to Visibility...');
    const nextBtn3 = await page.waitForSelector('#next-button', { timeout: 20000 });
    await safeClick(page, nextBtn3, { scroll: true });
    await new Promise(r => setTimeout(r, 1500));

    // Handle scheduling vs simple visibility setting
    if (opts.scheduledAt && new Date(opts.scheduledAt).getTime() > Date.now() + 60 * 1000) {
      logFn(`[Puppet] Scheduling video for ${opts.scheduledAt}...`);

      // Enter "Schedule" mode with a TRUSTED click (YouTube's Polymer ignores untrusted taps, which
      // left the video on "Save/Done" mode → it saved a private DRAFT). Verify the datetime picker opened.
      logFn('[Puppet] Selecting Schedule mode (trusted click + verify)...');
      const scheduleActivated = await activateScheduleMode(page, logFn);
      if (!scheduleActivated) {
        logFn('[Puppet] Warning: datetime picker did not appear after schedule activation; the commit-time guard will re-try.');
      }
      await new Promise(r => setTimeout(r, 800));

      // Now the datepicker should be visible — fill in date
      logFn('[Puppet] Entering scheduled date...');

      // The date is shown as a dropdown button like "May 30, 2026 ▼"
      // Click the dropdown trigger to open calendar picker, then type the date
      const dateTriggerClicked = await page.evaluate(() => {
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
        const dateTrigger = queryAllShadow('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]')[0];
        if (dateTrigger) {
          dateTrigger.scrollIntoView({ block: 'center', inline: 'nearest' });
          dateTrigger.click();
          return true;
        }
        return false;
      });

      if (dateTriggerClicked) {
        await new Promise(r => setTimeout(r, 1000));
        
        // Read initial value of the date input
        const dateInputDetails = await page.evaluate(() => {
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
          const calInput = queryAllShadow('#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]')[0];
          if (calInput) {
            calInput.scrollIntoView({ block: 'center', inline: 'nearest' });
            calInput.click();
            calInput.focus();
            return {
              initialValue: calInput.value || '',
              exists: true
            };
          }
          return { exists: false };
        });

        if (dateInputDetails.exists) {
          const initialValue = dateInputDetails.initialValue;
          const targetDateStr = formatDateLikeInitial(initialValue, opts.scheduledAt);
          logFn(`[Puppet] Date Input - Initial Value: "${initialValue}", Formatted Target: "${targetDateStr}"`);

          // Clear and enter date using native Ctrl+A and Backspace sequence
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 100));

          // Robust fallback clearing loop
          for (let i = 0; i < 25; i++) {
            await page.keyboard.press('Backspace');
          }
          await new Promise(r => setTimeout(r, 100));

          await page.keyboard.type(targetDateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));

          // Read final value for verification/logging
          const finalDateVal = await page.evaluate(() => {
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
            const calInput = queryAllShadow('#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]')[0];
            return calInput ? calInput.value : '';
          });
          logFn(`[Puppet] Date Input - Final Value after typing: "${finalDateVal}"`);

          // Verify the field now shows the REQUESTED date (day, month AND year) — not merely
          // that it changed. YouTube Studio formats dates by the account locale; if the typed
          // format is misread it can silently land on a DIFFERENT (often much later) date.
          // Comparing the tokens of what we typed against what the field shows catches that and
          // aborts, instead of scheduling the video to the wrong date.
          const _dtok = (s) => ((s || '').toLowerCase().match(/[a-zçğıöşü]+|\d+/g) || []).map(t => t.replace(/^0+(\d)/, '$1'));
          const _dwant = _dtok(targetDateStr);
          const _dgot = new Set(_dtok(finalDateVal));
          if (finalDateVal && _dwant.length && !_dwant.every(t => _dgot.has(t))) {
            throw new Error(`Schedule date did not apply correctly: the date field shows "${finalDateVal}" but "${targetDateStr}" was requested. Aborted to avoid scheduling the video to the wrong date.`);
          }
        } else {
          logFn('[Puppet] Warning: could not focus date input field.');
        }
      } else {
        logFn('[Puppet] Warning: could not locate or click date trigger.');
      }

      await new Promise(r => setTimeout(r, 800));

      // 2. Enter Time using robust shadow DOM selector
      logFn('[Puppet] Entering scheduled time...');
      const timeInputDetails = await page.evaluate(() => {
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
        const container = queryAllShadow('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select')[0];
        const containerInputs = container ? Array.from(container.querySelectorAll('input')) : [];
        // Also pierce nested shadow roots: the time field often lives in shadow DOM that the
        // container's own querySelectorAll cannot reach. Missing it caused the time to never
        // apply during reschedule (the date applied but the time stayed unchanged).
        const seen = new Set();
        const inputs = [];
        for (const inp of [...containerInputs, ...queryAllShadow('input')]) {
          if (!seen.has(inp)) { seen.add(inp); inputs.push(inp); }
        }
        // Prefer the input whose value looks like a clock time (e.g. "7:30 PM" / "19:30");
        // fall back to the last container input to preserve the original upload behavior.
        const timeInput = inputs.find(input => /\d{1,2}:\d{2}/.test(input.value || ''))
          || containerInputs[containerInputs.length - 1]
          || inputs[inputs.length - 1];

        if (timeInput) {
          timeInput.scrollIntoView({ block: 'center', inline: 'nearest' });
          timeInput.click();
          timeInput.focus();
          return {
            initialValue: timeInput.value || '',
            exists: true
          };
        }
        return { exists: false };
      });

      if (timeInputDetails.exists) {
        const initialValue = timeInputDetails.initialValue;
        const targetTimeStr = formatTimeLikeInitial(initialValue, opts.scheduledAt);
        logFn(`[Puppet] Time Input - Initial Value: "${initialValue}", Formatted Target: "${targetTimeStr}"`);

        // Clear and enter time using native Ctrl+A and Backspace sequence
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 100));

        // Robust fallback clearing loop
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press('Backspace');
        }
        await new Promise(r => setTimeout(r, 100));

        await page.keyboard.type(targetTimeStr, { delay: 50 });
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        // Save debug screenshot of upload visibility popup
        try {
          const debugScreenshotPath = path.join(profilePath, 'puppet_upload_debug.png');
          await page.screenshot({ path: debugScreenshotPath });
          logFn(`[Puppet] Saved debug screenshot of visibility popup to: ${debugScreenshotPath}`);
        } catch (e) {
          logFn(`[Puppet] Warning: failed to save debug screenshot: ${e.message}`);
        }

        // Read final value for verification/logging
        const finalTimeVal = await page.evaluate(() => {
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
          const container = queryAllShadow('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select')[0];
          const containerInputs = container ? Array.from(container.querySelectorAll('input')) : [];
          const seen = new Set();
          const inputs = [];
          for (const inp of [...containerInputs, ...queryAllShadow('input')]) {
            if (!seen.has(inp)) { seen.add(inp); inputs.push(inp); }
          }
          const timeInput = inputs.find(input => /\d{1,2}:\d{2}/.test(input.value || ''))
            || containerInputs[containerInputs.length - 1]
            || inputs[inputs.length - 1];
          return timeInput ? timeInput.value : '';
        });
        logFn(`[Puppet] Time Input - Final Value after typing: "${finalTimeVal}"`);
      } else {
        logFn('[Puppet] Warning: could not focus time input field.');
      }
      await new Promise(r => setTimeout(r, 800));

      if (opts.isPremiere) {
        logFn('[Puppet] Setting "Set as Premiere" (trusted click)...');
        try {
          const before = await readScheduleValues(page);
          logFn(`[Puppet] Pre-premiere: date="${before.date}" time="${before.time}" button="${await getPrimaryButtonId(page)}"`);

          // TRUSTED tick — replicates the manual click that keeps the button on "Schedule".
          // (An untrusted evaluate().click() flipped the button to "Done" — the root cause.)
          const tick = await togglePremiere(page, true, logFn);
          logFn(`[Puppet] Premiere checkbox status: ${tick}`);
          await new Promise(r => setTimeout(r, 1200));

          // Do NOT click "Set up premiere" / confirm any dialog — verified manually that a plain
          // premiere tick keeps the button on "Schedule"; the extra clicks corrupted state.

          // Ticking premiere can re-render the scheduler and wipe date/time — re-verify + re-apply.
          let vals = await readScheduleValues(page);
          if (!scheduleIsIntact(vals, opts).ok) {
            logFn(`[Puppet] Schedule drifted after premiere tick (date="${vals.date}" time="${vals.time}") — re-applying.`);
            await reapplyDateTime(page, opts, logFn);
            await new Promise(r => setTimeout(r, 800));
            vals = await readScheduleValues(page);
          }
          const chk = scheduleIsIntact(vals, opts);
          logFn(`[Puppet] Post-premiere schedule: date="${vals.date}" time="${vals.time}" (dateOk=${chk.dateOk}, timeOk=${chk.timeOk})`);

          try { await page.screenshot({ path: path.join(profilePath, 'puppet_premiere_debug.png') }); } catch (e) {}

          // Confirm the primary button became "Schedule"; retry re-applying date/time if not.
          let btnId = await getPrimaryButtonId(page);
          for (let attempt = 0; attempt < 2 && !/schedule/i.test(btnId); attempt++) {
            logFn(`[Puppet] Primary button is "${btnId}" (not schedulable) — re-applying schedule (attempt ${attempt + 1}).`);
            await reapplyDateTime(page, opts, logFn);
            await new Promise(r => setTimeout(r, 1000));
            btnId = await getPrimaryButtonId(page);
          }
          logFn(`[Puppet] Primary button after premiere: "${btnId}"`);

          // ── BULLETPROOF FALLBACK ──────────────────────────────────────────────────────────────
          // If premiere STILL won't schedule, untick premiere (trusted) so the video is at least
          // SCHEDULED (non-premiere) and never gets stuck as a private draft.
          if (!/schedule/i.test(btnId)) {
            logFn('[Puppet] Premiere still not schedulable — reverting premiere to preserve the schedule.');
            logFn(`[Puppet] Premiere revert status: ${await togglePremiere(page, false, logFn)}`);
            await new Promise(r => setTimeout(r, 1000));
            if (!scheduleIsIntact(await readScheduleValues(page), opts).ok) {
              await reapplyDateTime(page, opts, logFn);
              await new Promise(r => setTimeout(r, 800));
            }
            btnId = await getPrimaryButtonId(page);
            for (let attempt = 0; attempt < 2 && !/schedule/i.test(btnId); attempt++) {
              await reapplyDateTime(page, opts, logFn);
              await new Promise(r => setTimeout(r, 1000));
              btnId = await getPrimaryButtonId(page);
            }
            logFn(`[Puppet] Primary button after reverting premiere: "${btnId}" (scheduled=${/schedule/i.test(btnId)})`);
          }
        } catch (e) {
          logFn(`[Puppet] Warning: premiere handling error: ${e.message}`);
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

    // ── Commit the schedule MID-UPLOAD, then keep the browser open until bytes finish ────────────
    // We no longer wait for the byte-upload to reach 100% before clicking Schedule. YouTube lets you
    // schedule/publish while the video is still uploading (it then shows as "Pending / Uploading NN%"
    // in Content). We click as soon as the button is enabled (checks passed), which commits the
    // schedule immediately. Right after, we KEEP THE BROWSER OPEN (see the background-upload monitor
    // further below) until the bytes finish — closing the tab mid-upload would abort the transfer.
    logFn('[Puppet] Waiting for a VISIBLE, ENABLED primary button (checks passing)...');
    await page.waitForFunction(() => {
      function deep(sel, root = document, out = []) {
        out.push(...root.querySelectorAll(sel));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
        return out;
      }
      const cands = deep('#schedule-button, #done-button, #publish-button, #save-button, ytcp-button[id*="schedule"], ytcp-button[id*="done"], ytcp-button[id*="publish"], ytcp-button[id*="save"]');
      return cands.some(b => b && b.offsetParent !== null && !(b.disabled === true || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'));
    }, { timeout: 240000 }).catch(() => {
      logFn('[Puppet] Warning: no enabled primary button after waiting; the guard will re-check.');
    });

    const mustSchedule = !!(opts.scheduledAt && new Date(opts.scheduledAt).getTime() > Date.now() + 60 * 1000);
    let { handle: primaryBtn, id: primaryId } = await getPrimaryButtonHandle(page);
    logFn(`[Puppet] Primary button resolved: "${primaryId}" (mustSchedule=${mustSchedule})`);

    // HARD GUARD: for a scheduled video, never commit via a non-schedule button (that saves a DRAFT).
    if (mustSchedule && !/schedule/i.test(primaryId)) {
      logFn(`[Puppet] GUARD: primary is "${primaryId}" but a schedule was requested — re-activating schedule mode + re-applying date/time.`);
      for (let attempt = 1; attempt <= 2 && !/schedule/i.test(primaryId); attempt++) {
        await activateScheduleMode(page, logFn);
        if (!scheduleIsIntact(await readScheduleValues(page), opts).ok) await reapplyDateTime(page, opts, logFn);
        await new Promise(r => setTimeout(r, 1200));
        if (primaryBtn) { await primaryBtn.dispose(); primaryBtn = null; }
        ({ handle: primaryBtn, id: primaryId } = await getPrimaryButtonHandle(page));
        logFn(`[Puppet] GUARD re-check ${attempt}: primary is now "${primaryId}"`);
      }
    }

    let scheduledOk = /schedule/i.test(primaryId);

    if (mustSchedule && !scheduledOk) {
      // Could NOT enter schedule mode in-dialog. Do NOT silently finalize a draft. Commit the upload
      // (keep a stable video ID, don't abandon the transfer) and return scheduled:false so the scheduler
      // enforces the schedule on the EDIT PAGE. Loud, not silent.
      logFn('[Puppet] ERROR: dialog would not enter Schedule mode. Committing upload, returning scheduled=false (edit-page enforce will apply the schedule — NOT a silent draft).');
      if (primaryBtn) { await trustedClickHandle(page, primaryBtn, logFn); await primaryBtn.dispose(); primaryBtn = null; }
      await new Promise(r => setTimeout(r, 4000));
    } else {
      logFn(`[Puppet] Final button: "${primaryId}" (scheduled=${scheduledOk})`);
      onProgress(15, 'Scheduling on YouTube…');
      await trustedClickHandle(page, primaryBtn, logFn);   // TRUSTED click on the VISIBLE button
      if (primaryBtn) { await primaryBtn.dispose(); primaryBtn = null; }
      await new Promise(r => setTimeout(r, 4000));
      logFn('[Puppet] Committed with a trusted click on the visible ' + (scheduledOk ? 'schedule' : 'primary') + ' button.');
    }

    // Try to get video ID again if we couldn't get it earlier
    if (!youtubeVideoId) {
      try {
        await page.waitForSelector('span.video-url-text a, #share-url, .video-url-fadeable a, a.style-scope.ytcp-video-info', { timeout: 10000 }).catch(() => null);
        const videoLink = await page.evaluate(() => {
          const sels = ['span.video-url-text a', '#share-url', '.video-url-fadeable a', 'a.style-scope.ytcp-video-info'];
          const rx = /youtu\.be\/[a-zA-Z0-9_-]{11}|[?&]v=[a-zA-Z0-9_-]{11}|\/video\/[a-zA-Z0-9_-]{11}/;
          for (const sel of sels) {
            for (const a of document.querySelectorAll(sel)) {
              const h = a.href || a.textContent || '';
              if (rx.test(h)) return h;
            }
          }
          const el = document.querySelector('span.video-url-text a') || document.querySelector('#share-url');
          return el ? (el.href || el.textContent || '') : '';
        }).catch(() => '');
        if (videoLink) {
          youtubeVideoId = extractVideoId(videoLink);
          logFn(`[Puppet] Extracted YouTube Video ID on completion: ${youtubeVideoId}`);
        }
      } catch (e) {
        logFn(`[Puppet] Warning: could not find video ID at completion: ${e.message}`);
      }
    }

    // Keep the browser open until the background byte-upload finishes, so we NEVER abort the
    // transfer by closing the tab early. We only conclude "done" when confident; otherwise we keep
    // waiting (up to the cap) — worst case it is just slower, never a killed upload. Note: while the
    // uploads dialog is still open it also shows "Uploading NN%", so this same check safely covers
    // the case where the Schedule click did not take.
    logFn('[Puppet] Monitoring background upload until bytes finish (browser stays open)...');
    {
      let sawUploading = false;
      let goneStreak = 0;
      for (let i = 0; i < 720; i++) {
        const bg = await page.evaluate(() => {
          const t = (document.body.innerText || document.body.textContent || '').toLowerCase();
          const m = t.match(/uploading\s*(\d{1,3})\s*%/) || t.match(/y[u\u00fc]kleniyor[^\d]*(\d{1,3})\s*%/);
          const uploadingVisible = /uploading\s*\d{1,3}\s*%/.test(t) || /y[u\u00fc]kleniyor[^\d]*\d{1,3}\s*%/.test(t);
          return { uploadingVisible, pct: m ? Math.min(100, parseInt(m[1], 10)) : null };
        }).catch(() => ({ uploadingVisible: false, pct: null }));

        if (bg.uploadingVisible) {
          sawUploading = true;
          goneStreak = 0;
          if (bg.pct != null) onProgress(Math.min(78, 15 + Math.round(bg.pct * 0.63)), `Scheduled \u2713 \u2014 uploading ${bg.pct}%`);
        } else {
          goneStreak++;
        }

        // Confident-done: we saw the indicator and it has been gone for 3 consecutive polls (~15s).
        if (sawUploading && goneStreak >= 3) { logFn('[Puppet] Background upload finished.'); break; }
        // Fallback if we NEVER detect an indicator (upload already done, or text not matched): wait a
        // conservative 5 min before assuming done, so we don't close early on a large upload.
        if (!sawUploading && i >= 60) { logFn('[Puppet] No upload indicator seen after 5 min; assuming the upload already finished.'); break; }

        await new Promise(r => setTimeout(r, 5000));
        if (i > 0 && i % 12 === 0) logFn(`[Puppet] Still waiting for background upload... (${i * 5}s elapsed)`);
      }
    }
    onProgress(78, 'Upload finishing…');
    logFn('[Puppet] Upload task complete.');
    await browser.close();
    return { videoId: youtubeVideoId, scheduled: scheduledOk };
  } catch (err) {
    logFn(`[Puppet] Error during automated upload: ${err.message}`);
    try {
      logFn(`[Puppet] Current page URL at failure: ${page.url()}`);
      const _snap = await page.evaluate(() => (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)).catch(() => '');
      if (_snap) logFn(`[Puppet] Visible page text at failure: "${_snap}"`);
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
      await setEditableText(page, titleInput, newTitle, logFn);
      await new Promise(r => setTimeout(r, 400));
    }

    // 2. Update Video Schedule if provided
    if (scheduledAt) {
      logFn('[Puppet] Finding Visibility select dropdown...');
      // A just-uploaded / still-processing video sometimes hasn't rendered the visibility editor
      // yet. Wait for it (piercing shadow DOM); if it doesn't appear, reload the edit page and try
      // again a couple of times before giving up, instead of hard-failing on the first timeout.
      // Slow/proxied channels render this heavy edit page much slower, so the visibility editor can
      // take far longer than 20s to appear — reporting "not ready" even when the video IS schedulable
      // (a fast-proxy channel renders it immediately and succeeds first try). Be patient: 6 tries at
      // 30s each, with reloads and a broader selector, before giving up to the scheduler's retry.
      let visReady = false;
      for (let vAttempt = 1; vAttempt <= 6 && !visReady; vAttempt++) {
        visReady = await page.waitForFunction(() => {
          function q(sel, root = document) {
            const els = Array.from(root.querySelectorAll(sel));
            for (const c of root.querySelectorAll('*')) { if (c.shadowRoot) els.push(...q(sel, c.shadowRoot)); }
            return els;
          }
          return q('ytcp-video-metadata-visibility, ytcp-video-visibility-select, #visibility-select, ytcp-video-metadata-editor-sidepanel, [test-id="VISIBILITY"], [aria-label*="Visibility" i]').some(el => el && el.offsetParent !== null);
        }, { timeout: 30000 }).then(() => true).catch(() => false);
        if (!visReady && vAttempt < 6) {
          logFn(`[Puppet] Visibility editor not ready (attempt ${vAttempt}/6); reloading edit page (slow proxy may need more time)...`);
          await page.goto(`https://studio.youtube.com/video/${youtubeVideoId}/edit?hl=en&persist_hl=1`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      if (!visReady) {
        throw new Error('The video edit page did not load the visibility editor in time (the video may still be processing) — will retry automatically.');
      }
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

        function findHeaderByText(textList, root) {
          const allElements = queryAllShadow('*', root);
          let found = allElements.find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return textList.includes(t) && el.children.length <= 2;
          });
          if (!found) {
            found = allElements.find(el => {
              const t = (el.textContent || '').trim().toLowerCase();
              return textList.some(txt => t.includes(txt)) && el.children.length <= 3;
            });
          }
          return found;
        }

        const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
        if (!popup) {
          return { status: 'error', reason: 'no-popup-found' };
        }

        // Check if datepicker/date trigger is visible (indicates Schedule section is already expanded)
        const dateTrigger = queryAllShadow('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker', popup)[0];
        const isScheduleExpanded = dateTrigger && dateTrigger.offsetParent !== null;

        if (isScheduleExpanded) {
          return { status: 'success', action: 'schedule-already-expanded' };
        }

        // It is not expanded. Let's look for the Schedule header to click and expand it.
        const scheduleHeader = findHeaderByText(['schedule', 'planlayın', 'planla'], popup);
        if (scheduleHeader && scheduleHeader.offsetParent !== null) {
          scheduleHeader.click();
          return { status: 'success', action: 'clicked-schedule-header' };
        }

        // If Schedule header is not found or hidden, we might need to set to Private first
        return { status: 'needs-private' };
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

          function findHeaderByText(textList, root) {
            const allElements = queryAllShadow('*', root);
            let found = allElements.find(el => {
              const t = (el.textContent || '').trim().toLowerCase();
              return textList.includes(t) && el.children.length <= 2;
            });
            if (!found) {
              found = allElements.find(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return textList.some(txt => t.includes(txt)) && el.children.length <= 3;
              });
            }
            return found;
          }

          const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
          if (!popup) return { status: 'error', reason: 'no-popup-found' };

          // Find Private radio button
          const radios = queryAllShadow('tp-yt-paper-radio-button, paper-radio-button, ytcp-radio-button, [role="radio"]', popup);
          const privateRadio = radios.find(r => {
            const t = (r.textContent || '').trim().toLowerCase();
            const name = (r.getAttribute('name') || '').toLowerCase();
            return t.includes('private') || name.includes('private') || t.includes('özel') || t.includes('ozel');
          }) || radios[0];

          const isPrivateVisible = privateRadio && privateRadio.offsetParent !== null;

          if (!isPrivateVisible) {
            // Expand "Save or publish" section
            const savePublishHeader = findHeaderByText(['save or publish', 'kaydet veya yayınlayın', 'kaydet veya yayına al', 'save & publish'], popup);
            if (savePublishHeader) {
              savePublishHeader.click();
            }
          }

          // Re-query radio buttons to get current visibility state
          const updatedRadios = queryAllShadow('tp-yt-paper-radio-button, paper-radio-button, ytcp-radio-button, [role="radio"]', popup);
          const updatedPrivateRadio = updatedRadios.find(r => {
            const t = (r.textContent || '').trim().toLowerCase();
            const name = (r.getAttribute('name') || '').toLowerCase();
            return t.includes('private') || name.includes('private') || t.includes('özel') || t.includes('ozel');
          }) || updatedRadios[0];

          if (updatedPrivateRadio) {
            updatedPrivateRadio.click();
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

        // Clean re-navigation to the edit page to avoid page reload/navigation frame detached errors
        logFn('[Puppet] Re-navigating to clean edit page after intermediate Private save...');
        await page.goto(`https://studio.youtube.com/video/${youtubeVideoId}/edit?hl=en&persist_hl=1`, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

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

          function findHeaderByText(textList, root) {
            const allElements = queryAllShadow('*', root);
            let found = allElements.find(el => {
              const t = (el.textContent || '').trim().toLowerCase();
              return textList.includes(t) && el.children.length <= 2;
            });
            if (!found) {
              found = allElements.find(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return textList.some(txt => t.includes(txt)) && el.children.length <= 3;
              });
            }
            return found;
          }

          const popup = queryAllShadow('ytcp-video-visibility-edit-popup')[0];
          if (!popup) return { status: 'error', reason: 'no-popup-found' };

          // Check if datepicker is visible now
          const dateTrigger = queryAllShadow('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker', popup)[0];
          const isScheduleExpanded = dateTrigger && dateTrigger.offsetParent !== null;

          if (isScheduleExpanded) {
            return { status: 'success', action: 'schedule-already-expanded' };
          }

          const scheduleHeader = findHeaderByText(['schedule', 'planlayın', 'planla'], popup);
          if (scheduleHeader && scheduleHeader.offsetParent !== null) {
            scheduleHeader.click();
            return { status: 'success', action: 'clicked-schedule-header' };
          }
          return { status: 'error', reason: 'schedule-not-available' };
        });

        logFn(`[Puppet] Schedule selection status on retry: ${selectScheduleResult.status} (${selectScheduleResult.action || selectScheduleResult.reason || ''})`);
        await new Promise(r => setTimeout(r, 2000));

        if (selectScheduleResult.status !== 'success') {
          throw new Error(`Failed to locate "Schedule" option even after setting video to Private: ${selectScheduleResult.reason || 'unknown reason'}`);
        }
      }

      // Wait for the datetime picker inside shadow DOM
      logFn('[Puppet] Waiting for datetime picker inside shadow DOM...');
      await page.waitForFunction(() => {
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
        const el = queryAllShadow('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker')[0];
        return el && el.offsetParent !== null;
      }, { timeout: 15000 }).catch(err => {
        logFn('[Puppet] Warning: datetime picker wait timed out: ' + err.message);
      });

      const dateTriggerClicked = await page.evaluate(() => {
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
        const dateTrigger = queryAllShadow('#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]')[0];
        if (dateTrigger) {
          dateTrigger.scrollIntoView({ block: 'center', inline: 'nearest' });
          dateTrigger.click();
          return true;
        }
        return false;
      });

      if (dateTriggerClicked) {
        await new Promise(r => setTimeout(r, 1000));
        
        // Read initial value of the date input
        const dateInputDetails = await page.evaluate(() => {
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
          const calInput = queryAllShadow('#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]')[0];
          if (calInput) {
            calInput.scrollIntoView({ block: 'center', inline: 'nearest' });
            calInput.click();
            calInput.focus();
            return {
              initialValue: calInput.value || '',
              exists: true
            };
          }
          return { exists: false };
        });

        if (dateInputDetails.exists) {
          const initialValue = dateInputDetails.initialValue;
          const targetDateStr = formatDateLikeInitial(initialValue, scheduledAt);
          logFn(`[Puppet] Date Input - Initial Value: "${initialValue}", Formatted Target: "${targetDateStr}"`);

          // Clear and enter date using native Ctrl+A and Backspace sequence
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 100));

          // Robust fallback clearing loop
          for (let i = 0; i < 25; i++) {
            await page.keyboard.press('Backspace');
          }
          await new Promise(r => setTimeout(r, 100));

          await page.keyboard.type(targetDateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));

          // Read final value for verification/logging
          const finalDateVal = await page.evaluate(() => {
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
            const calInput = queryAllShadow('#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]')[0];
            return calInput ? calInput.value : '';
          });
          logFn(`[Puppet] Date Input - Final Value after typing: "${finalDateVal}"`);

          // Verify the field now shows the REQUESTED date (day, month AND year) — not merely
          // that it changed. YouTube Studio formats dates by the account locale; if the typed
          // format is misread it can silently land on a DIFFERENT (often much later) date.
          // Comparing the tokens of what we typed against what the field shows catches that and
          // aborts, instead of scheduling the video to the wrong date.
          const _dtok = (s) => ((s || '').toLowerCase().match(/[a-zçğıöşü]+|\d+/g) || []).map(t => t.replace(/^0+(\d)/, '$1'));
          const _dwant = _dtok(targetDateStr);
          const _dgot = new Set(_dtok(finalDateVal));
          if (finalDateVal && _dwant.length && !_dwant.every(t => _dgot.has(t))) {
            throw new Error(`Schedule date did not apply correctly: the date field shows "${finalDateVal}" but "${targetDateStr}" was requested. Aborted to avoid scheduling the video to the wrong date.`);
          }
        } else {
          logFn('[Puppet] Warning: could not focus date input field.');
        }
      } else {
        logFn('[Puppet] Warning: could not locate or click date trigger.');
      }

      await new Promise(r => setTimeout(r, 800));

      // 2. Enter Time using robust shadow DOM selector
      logFn('[Puppet] Entering scheduled time...');
      const timeInputDetails = await page.evaluate(() => {
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
        const container = queryAllShadow('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select')[0];
        const containerInputs = container ? Array.from(container.querySelectorAll('input')) : [];
        // Also pierce nested shadow roots: the time field often lives in shadow DOM that the
        // container's own querySelectorAll cannot reach. Missing it caused the time to never
        // apply during reschedule (the date applied but the time stayed unchanged).
        const seen = new Set();
        const inputs = [];
        for (const inp of [...containerInputs, ...queryAllShadow('input')]) {
          if (!seen.has(inp)) { seen.add(inp); inputs.push(inp); }
        }
        // Prefer the input whose value looks like a clock time (e.g. "7:30 PM" / "19:30");
        // fall back to the last container input to preserve the original upload behavior.
        const timeInput = inputs.find(input => /\d{1,2}:\d{2}/.test(input.value || ''))
          || containerInputs[containerInputs.length - 1]
          || inputs[inputs.length - 1];

        if (timeInput) {
          timeInput.scrollIntoView({ block: 'center', inline: 'nearest' });
          timeInput.click();
          timeInput.focus();
          return {
            initialValue: timeInput.value || '',
            exists: true
          };
        }
        return { exists: false };
      });

      if (timeInputDetails.exists) {
        const initialValue = timeInputDetails.initialValue;
        const targetTimeStr = formatTimeLikeInitial(initialValue, scheduledAt);
        logFn(`[Puppet] Time Input - Initial Value: "${initialValue}", Formatted Target: "${targetTimeStr}"`);

        // Clear and enter time using native Ctrl+A and Backspace sequence
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 100));

        // Robust fallback clearing loop
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press('Backspace');
        }
        await new Promise(r => setTimeout(r, 100));

        await page.keyboard.type(targetTimeStr, { delay: 50 });
        await new Promise(r => setTimeout(r, 700));

        // The schedule time field is a dropdown/combobox: typing only filters the list, it does
        // not commit the value. Select the matching option from the open dropdown. (Pressing
        // Escape here would revert the field back to its original time, which was the bug.)
        const timeOptionPicked = await page.evaluate((target) => {
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
          const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
          const options = queryAllShadow('tp-yt-paper-item, ytcp-text-menu tp-yt-paper-item, [role="option"], ytcp-time-of-day-picker tp-yt-paper-item');
          const visible = options.filter(o => o.offsetParent !== null);
          let match = visible.find(o => norm(o.textContent) === norm(target));
          if (!match) match = visible.find(o => norm(o.textContent).includes(norm(target)));
          if (match) {
            match.scrollIntoView({ block: 'center', inline: 'nearest' });
            match.click();
            return 'clicked:' + (match.textContent || '').trim();
          }
          return 'no-option';
        }, targetTimeStr);
        logFn(`[Puppet] Time dropdown option selection: ${timeOptionPicked}`);

        if (timeOptionPicked === 'no-option') {
          // Fallback: commit the typed value with Enter (no Escape, which would revert it).
          await page.keyboard.press('Enter');
        }
        await new Promise(r => setTimeout(r, 600));

        // Save debug screenshot of reschedule visibility popup
        try {
          const debugScreenshotPath = path.join(profilePath, 'puppet_reschedule_debug.png');
          await page.screenshot({ path: debugScreenshotPath });
          logFn(`[Puppet] Saved debug screenshot of visibility popup to: ${debugScreenshotPath}`);
        } catch (e) {
          logFn(`[Puppet] Warning: failed to save debug screenshot: ${e.message}`);
        }

        // Read final value for verification/logging
        const finalTimeVal = await page.evaluate(() => {
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
          const container = queryAllShadow('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select')[0];
          const containerInputs = container ? Array.from(container.querySelectorAll('input')) : [];
          const seen = new Set();
          const inputs = [];
          for (const inp of [...containerInputs, ...queryAllShadow('input')]) {
            if (!seen.has(inp)) { seen.add(inp); inputs.push(inp); }
          }
          const timeInput = inputs.find(input => /\d{1,2}:\d{2}/.test(input.value || ''))
            || containerInputs[containerInputs.length - 1]
            || inputs[inputs.length - 1];
          return timeInput ? timeInput.value : '';
        });
        logFn(`[Puppet] Time Input - Final Value after typing: "${finalTimeVal}"`);

        // Verify the time actually changed. If the field still shows the old value while a
        // different time was requested, the entry silently failed — surface it instead of
        // reporting a false success (which would leave YouTube out of sync with the panel).
        const normTime = (s) => (s || '').toString().replace(/\s+/g, '').toLowerCase();
        if (normTime(finalTimeVal) === normTime(initialValue) && normTime(initialValue) !== normTime(targetTimeStr)) {
          throw new Error(`Schedule time did not apply: the time field still shows "${finalTimeVal}" but "${targetTimeStr}" was requested. Reschedule aborted so the panel and YouTube stay consistent.`);
        }
      } else {
        throw new Error('Could not find the schedule time field on the YouTube edit page; reschedule aborted to avoid leaving the time unchanged on YouTube.');
      }
      await new Promise(r => setTimeout(r, 800));

      logFn(`[Puppet] Toggling "Set as Premiere" to ${isPremiere} (trusted click)...`);
      try {
        logFn(`[Puppet] Premiere checkbox status: ${await togglePremiere(page, !!isPremiere, logFn)}`);
      } catch (e) {
        logFn(`[Puppet] Warning: failed to toggle premiere checkbox: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800));

      // Save a debug screenshot of the visibility popup before clicking Done
      try {
        const debugScreenshotPath = path.join(profilePath, 'puppet_reschedule_debug.png');
        await page.screenshot({ path: debugScreenshotPath });
        logFn(`[Puppet] Saved debug visibility screenshot to: ${debugScreenshotPath}`);
      } catch (e) {
        logFn(`[Puppet] Warning: failed to save debug screenshot: ${e.message}`);
      }

      logFn('[Puppet] Clicking Done in Visibility dialog...');
      await page.waitForFunction(() => {
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
        const el = queryAllShadow('#save-button, ytcp-button[id="save-button"], #done-button, ytcp-button[id*="done"]')[0];
        return el && el.offsetParent !== null;
      }, { timeout: 10000 }).catch(() => null);

      const doneBtnClicked = await page.evaluate(() => {
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
        const doneBtn = queryAllShadow('#save-button, ytcp-button[id="save-button"], #done-button, ytcp-button[id*="done"]')[0];
        if (doneBtn) {
          doneBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
          doneBtn.click();
          return true;
        }
        return false;
      });
      logFn(`[Puppet] Done button clicked status: ${doneBtnClicked}`);
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

    // Verify the schedule actually applied. Previously "success" == "did not throw", so a save that
    // quietly kept the video Private/Draft was reported as scheduled → false-complete. If a schedule
    // was requested but the video isn't showing "Scheduled", throw a RETRYABLE error so the scheduler
    // routes it to the retry/recovery path instead of marking the post complete.
    if (scheduledAt) {
      await new Promise(r => setTimeout(r, 2000));
      const visState = await page.evaluate(() => {
        function deep(sel, root = document, out = []) {
          out.push(...root.querySelectorAll(sel));
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
          return out;
        }
        const els = deep('ytcp-video-metadata-visibility, ytcp-video-visibility-select, #visibility, .visibility-container');
        const scoped = els.map(e => (e.textContent || '').trim()).join(' | ').toLowerCase();
        return scoped || (document.body.innerText || '').toLowerCase();
      }).catch(() => '');
      const looksScheduled = /scheduled|zamanland|premiere|premiyer/.test(visState);
      logFn(`[Puppet] Post-save visibility check: scheduled=${looksScheduled} (state: "${visState.slice(0, 80)}")`);
      if (!looksScheduled) {
        throw new Error('Schedule was not applied on the edit page (video still shows unscheduled) — will retry automatically.');
      }
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
/**
 * Verify a video's real state on YouTube and compare it to what was intended.
 * Reads the edit page (schedule / premiere / thumbnail / title) and the watch page (pinned comment),
 * and returns a health report with a list of issues + likely reasons. Best-effort: anything it can't
 * read is reported as "unknown" rather than a false failure.
 */
export async function verifyVideoOnYouTube(channelId, youtubeVideoId, expected = {}, logFn = console.log) {
  await closeBrowserSession(channelId);
  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();
  try {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;
  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Verify] Inspecting video ${youtubeVideoId} on YouTube (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  const report = {
    videoId: youtubeVideoId,
    checkedAt: new Date().toISOString(),
    loggedIn: true,
    videoFound: null,
    processing: null,
    schedule: { ok: null, actual: '', detail: '' },
    premiere: { ok: null, actual: '', detail: '' },
    thumbnail: { ok: null, detail: '' },
    title: { ok: null, actual: '', detail: '' },
    comment: { ok: null, detail: '' },
    issues: []
  };

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({ username: proxyConfig.username || '', password: proxyConfig.password || '' });
    }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    // ---- Edit page: schedule / premiere / thumbnail / title ----
    logFn('[Verify] Loading edit page...');
    await page.goto(`https://studio.youtube.com/video/${youtubeVideoId}/edit?hl=en&persist_hl=1`, { waitUntil: 'networkidle2', timeout: 60000 });
    if (page.url().includes('accounts.google.com')) {
      report.loggedIn = false;
      report.issues.push('Not logged in — cannot verify. Re-run the browser login for this channel.');
      await browser.close();
      return report;
    }
    await new Promise(r => setTimeout(r, 2500));
    const edit = await page.evaluate(() => {
      function deep(sel, root = document, out = []) {
        out.push(...root.querySelectorAll(sel));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
        return out;
      }
      const bodyText = (document.body.innerText || '').toLowerCase();
      const notFound = bodyText.includes("this page isn't available") || bodyText.includes('video unavailable') || bodyText.includes('kullanılamıyor');
      const processing = bodyText.includes('processing') || bodyText.includes('checks in progress') || bodyText.includes('ışleniyor');
      const titleEl = deep('#title-textarea #textbox, ytcp-social-suggestions-textbox #textbox')[0];
      const title = titleEl ? (titleEl.textContent || '').trim() : '';
      const visEls = deep('ytcp-video-visibility-select, #visibility, .visibility-container, ytcp-video-metadata-visibility');
      let visText = '';
      for (const v of visEls) { const t = (v.textContent || '').trim(); if (t) visText += ' | ' + t; }
      if (!visText) {
        const m = bodyText.match(/(scheduled|zamanland[ıi]|premiere|premiyer|public|private|özel|unlisted|draft|taslak)/);
        visText = m ? m[1] : '';
      }
      const premiere = /premiere|premiyer|g[öo]sterim/.test((visText + ' ' + bodyText).toLowerCase());
      const thumbImgs = deep('ytcp-video-thumbnail-with-edit img, #still-1 img, ytcp-thumbnail-editor img, img.thumbnail');
      const hasCustomThumb = thumbImgs.some(i => i.src && (i.src.startsWith('http') || i.src.startsWith('data:')) && !i.src.includes('default'));
      return { notFound, processing, title, visText: visText.trim(), premiere, hasCustomThumb };
    }).catch(() => null);

    if (edit && edit.notFound) {
      report.videoFound = false;
      report.issues.push('Video not found on YouTube — it may have been deleted.');
      await browser.close();
      return report;
    }
    report.videoFound = true;
    report.processing = !!(edit && edit.processing);

    if (edit) {
      const vt = (edit.visText || '').toLowerCase();
      const looksScheduled = /scheduled|zamanland/.test(vt);
      report.schedule.actual = edit.visText || (edit.processing ? 'Processing' : 'Unknown');
      if (expected.scheduledAt) {
        report.schedule.ok = looksScheduled ? true : (edit.processing ? null : false);
        report.schedule.detail = looksScheduled
          ? 'Video is scheduled on YouTube.'
          : (edit.processing ? 'Still processing — schedule not confirmable yet, try again shortly.' : `NOT scheduled (YouTube shows: "${edit.visText || 'unknown'}").`);
        if (report.schedule.ok === false) report.issues.push(report.schedule.detail);
      } else { report.schedule.detail = 'Not a scheduled upload.'; }

      report.premiere.actual = edit.premiere ? 'Premiere' : 'Not premiere';
      if (expected.isPremiere) {
        report.premiere.ok = !!edit.premiere;
        report.premiere.detail = edit.premiere ? 'Set as premiere.' : 'Expected a premiere, but no premiere indicator was found.';
        if (!edit.premiere) report.issues.push(report.premiere.detail);
      } else { report.premiere.detail = 'Premiere not requested.'; }

      if (expected.hasThumbnail) {
        report.thumbnail.ok = !!edit.hasCustomThumb;
        report.thumbnail.detail = edit.hasCustomThumb ? 'Custom thumbnail present.' : 'Expected a custom thumbnail, but none was detected.';
        if (!edit.hasCustomThumb) report.issues.push(report.thumbnail.detail);
      } else { report.thumbnail.detail = 'No custom thumbnail requested.'; }

      if (expected.title) {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const match = norm(edit.title) === norm(expected.title) || (edit.title && norm(expected.title).startsWith(norm(edit.title)));
        report.title.actual = edit.title || '';
        report.title.ok = !!match;
        report.title.detail = match ? 'Title matches.' : `Title on YouTube ("${edit.title}") differs from intended.`;
        if (!match && edit.title) report.issues.push(report.title.detail);
      }
    } else {
      report.issues.push('Could not read the edit page (YouTube layout changed or video still loading).');
    }

    // ---- Watch page: pinned / owner comment ----
    if (expected.hasComment) {
      try {
        logFn('[Verify] Loading watch page for comment...');
        await page.goto(`https://www.youtube.com/watch?v=${youtubeVideoId}`, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2500));
        await page.evaluate(() => window.scrollBy(0, 900));
        await new Promise(r => setTimeout(r, 2500));
        const c = await page.evaluate(() => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          const commentsOff = bodyText.includes('comments are turned off') || bodyText.includes('yorumlar kapalı');
          const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
          const ownerOrPinned = threads.some(t => t.querySelector('ytd-author-comment-badge-renderer, #author-comment-badge, ytd-pinned-comment-badge-renderer'));
          const premiereWaiting = bodyText.includes('premieres') || bodyText.includes('waiting');
          return { commentsOff, ownerOrPinned, premiereWaiting };
        }).catch(() => null);
        if (c) {
          if (c.commentsOff) { report.comment.ok = false; report.comment.detail = 'Comments are turned off on this video.'; report.issues.push(report.comment.detail); }
          else if (c.ownerOrPinned) { report.comment.ok = true; report.comment.detail = 'Pinned/owner comment found.'; }
          else if (c.premiereWaiting) { report.comment.detail = 'Premiere has not aired yet — the comment posts once it goes live.'; }
          else { report.comment.ok = false; report.comment.detail = 'No pinned/owner comment found yet.'; report.issues.push(report.comment.detail); }
        } else { report.comment.detail = 'Could not read the comments section.'; }
      } catch (e) { report.comment.detail = 'Comment check failed: ' + e.message; }
    } else { report.comment.detail = 'No auto-comment configured.'; }

    await browser.close();
    logFn(`[Verify] Done for ${youtubeVideoId}. Issues: ${report.issues.length ? report.issues.join(' ; ') : 'none'}`);
    return report;
  } catch (err) {
    logFn(`[Verify] Error: ${err.message}`);
    try { await browser.close(); } catch {}
    report.issues.push('Verification could not complete: ' + err.message);
    return report;
  }
}

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

    // Conservative verification: only fail if YouTube actually surfaced an error dialog
    // (e.g. thumbnail too large / wrong format). We do NOT require a positive "saved" signal,
    // to avoid false failures — but this stops us reporting success when the save was rejected.
    const saveError = await page.evaluate(() => {
      function qAll(sel, root = document) {
        const els = Array.from(root.querySelectorAll(sel));
        for (const c of root.querySelectorAll('*')) { if (c.shadowRoot) els.push(...qAll(sel, c.shadowRoot)); }
        return els;
      }
      const dialogs = qAll('tp-yt-paper-dialog, ytcp-dialog, ytcp-uploads-still-processing-dialog, .error-message, #error-message');
      for (const d of dialogs) {
        if (d && d.offsetParent !== null) {
          const t = (d.textContent || '').toLowerCase();
          if (t.includes('error') || t.includes('too large') || t.includes("couldn't") || t.includes('could not') ||
              t.includes('failed') || t.includes('invalid') || t.includes('hata') || t.includes('boyut') || t.includes('geçersiz')) {
            return (d.textContent || '').trim().slice(0, 200);
          }
        }
      }
      return null;
    }).catch(() => null);
    if (saveError) {
      throw new Error('YouTube rejected the thumbnail save: ' + saveError);
    }

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
    await stopVncSessionForProfile(getProfilePath(channelId));
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

/**
 * Update the profile picture logo, banner image, and description in YouTube Studio using Puppeteer.
 * @param {number} channelId
 * @param {object} opts { logoPath, bannerPath, description }
 * @param {function} logFn
 */
export async function updateChannelBrandingBrowser(channelId, opts, logFn = console.log) {
  await closeBrowserSession(channelId);
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up lock files
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const f of lockFiles) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet Branding] Starting browser branding update for channel ${channelId} (headless: ${runHeadless})`);
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
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });

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

    const hasLogo = opts.logoPath && fs.existsSync(opts.logoPath);
    const hasBanner = opts.bannerPath && fs.existsSync(opts.bannerPath);
    const hasDescription = opts.description !== undefined && opts.description !== null;

    if (hasLogo || hasBanner || hasDescription) {
      const initialUrl = channel.youtube_channel_id
        ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/videos/upload?hl=en`
        : `https://studio.youtube.com/videos/upload?hl=en`;

      logFn(`[Puppet Branding] Navigating to initial URL to set session context: ${initialUrl}`);
      await page.goto(initialUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      if (page.url().includes('accounts.google.com')) {
        throw new Error('Not logged in. Please set up your browser session in the channel settings first.');
      }

      logFn('[Puppet Branding] Waiting 5 seconds on content page...');
      await new Promise(r => setTimeout(r, 5000));

      logFn('[Puppet Branding] Searching for Customization sidebar link...');
      const clickedSidebar = await page.evaluate(async () => {
        const navItems = Array.from(document.querySelectorAll('ytcp-navigation-item, a'));
        const customizationItem = navItems.find(el => {
          const text = (el.textContent || '').trim().toLowerCase();
          const href = el.getAttribute('href') || '';
          return text.includes('customization') || text.includes('özelleştirme') || text.includes('ozellestirme') || href.includes('editing');
        });

        if (customizationItem) {
          customizationItem.scrollIntoView();
          customizationItem.click();
          return true;
        }
        return false;
      });

      const targetUrl = channel.youtube_channel_id
        ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/editing/profile?hl=en`
        : `https://studio.youtube.com/editing/profile?hl=en`;

      if (clickedSidebar) {
        logFn('[Puppet Branding] Clicked sidebar link, waiting for customization page load...');
        await page.waitForSelector('ytcp-profile-image-upload, ytcp-banner-upload', { timeout: 15000 }).catch(() => null);
      } else {
        logFn(`[Puppet Branding] Could not find or click sidebar link. Falling back to direct navigation: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      }

      logFn('[Puppet Branding] Waiting for customization page elements to render...');
      await page.waitForSelector('ytcp-profile-image-upload, ytcp-banner-upload, ytcp-button, button', { timeout: 20000 }).catch(() => null);
      await new Promise(r => setTimeout(r, 4000)); // Allow dynamic components to settle

      if (hasLogo) {
        logFn('[Puppet Branding] Finding profile logo upload button...');
        const logoButtonHandle = await page.evaluateHandle(() => {
          return document.querySelector('.upload-btn.style-scope.ytcp-profile-image-upload') ||
                 document.querySelector('ytcp-profile-image-upload button, ytcp-profile-image-upload ytcp-button') ||
                 document.querySelector('ytcp-profile-image-upload [id="upload-button"]');
        });

        if (logoButtonHandle && logoButtonHandle.asElement()) {
          logFn('[Puppet Branding] Logo upload button found. Launching file chooser...');
          const btnElement = logoButtonHandle.asElement();
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 15000 }),
            btnElement.click()
          ]);
          await fileChooser.accept([opts.logoPath]);

          logFn('[Puppet Branding] Logo file uploaded, waiting for crop dialog Done button...');
          await new Promise(r => setTimeout(r, 3000));
          const doneBtn = await page.waitForSelector('#done-button, ytcp-button#done-button, ytcp-button[id="done-button"]', { timeout: 10000 }).catch(() => null);
          if (doneBtn) {
            await safeClick(page, doneBtn);
          } else {
            await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('ytcp-button, paper-button, button'));
              const btn = buttons.find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'done' || text === 'bitti' || text.includes('done') || text.includes('bitti');
              });
              if (btn) btn.click();
            });
          }
          await new Promise(r => setTimeout(r, 3000));
          logFn('[Puppet Branding] Logo crop confirmed.');
        } else {
          logFn('[Puppet Branding] Warning: Could not find logo upload button.');
        }
      }

      if (hasBanner) {
        logFn('[Puppet Branding] Finding banner image upload button...');
        const bannerButtonHandle = await page.evaluateHandle(() => {
          return document.querySelector('.upload-btn.style-scope.ytcp-banner-upload') ||
                 document.querySelector('ytcp-banner-upload button, ytcp-banner-upload ytcp-button') ||
                 document.querySelector('ytcp-banner-upload [id="upload-button"]');
        });

        if (bannerButtonHandle && bannerButtonHandle.asElement()) {
          logFn('[Puppet Branding] Banner upload button found. Launching file chooser...');
          const btnElement = bannerButtonHandle.asElement();
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 15000 }),
            btnElement.click()
          ]);
          await fileChooser.accept([opts.bannerPath]);

          logFn('[Puppet Branding] Banner file uploaded, waiting for crop dialog Done button...');
          await new Promise(r => setTimeout(r, 3000));
          const doneBtn = await page.waitForSelector('#done-button, ytcp-button#done-button, ytcp-button[id="done-button"]', { timeout: 10000 }).catch(() => null);
          if (doneBtn) {
            await safeClick(page, doneBtn);
          } else {
            await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('ytcp-button, paper-button, button'));
              const btn = buttons.find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'done' || text === 'bitti' || text.includes('done') || text.includes('bitti');
              });
              if (btn) btn.click();
            });
          }
          await new Promise(r => setTimeout(r, 3000));
          logFn('[Puppet Branding] Banner crop confirmed.');
        } else {
          logFn('[Puppet Branding] Warning: Could not find banner upload button.');
        }
      }

      if (hasDescription) {
        logFn('[Puppet Branding] Inputting description...');
        const descInput = await page.waitForSelector('ytcp-textarea[id*="description"] #textbox, #description-textarea #textbox, div#textbox[contenteditable="true"], textarea', { timeout: 10000 }).catch(() => null);
        if (descInput) {
          await safeClick(page, descInput, { scroll: true, focus: true });
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await page.keyboard.type(opts.description);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          logFn('[Puppet Branding] Warning: Could not find description input field.');
        }
      }

      logFn('[Puppet Branding] Publishing changes...');
      const publishBtn = await page.waitForSelector('#publish-button, ytcp-button#publish-button', { timeout: 10000 }).catch(() => null);
      if (publishBtn) {
        await safeClick(page, publishBtn);
      } else {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('ytcp-button, button'));
          const btn = buttons.find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            return text === 'publish' || text === 'yayınla' || text === 'yayinla' || text.includes('publish') || text.includes('yayınla');
          });
          if (btn) btn.click();
        });
      }
      await new Promise(r => setTimeout(r, 5000));
      logFn('[Puppet Branding] Branding update complete.');
    }
    await browser.close();
  } catch (err) {
    logFn(`[Puppet Branding] Branding update error: ${err.message}`);
    try {
      await page.screenshot({ path: path.join(profilePath, 'puppet_branding_error.png') });
    } catch {}
    try {
      await browser.close();
    } catch {}
    throw err;
  }
}

/**
 * Headlessly navigate to YouTube Studio content uploads page to extract visible videos.
 * Compares them with completed scheduled posts in the database from the last 7 days.
 * Marks missing ones as cancelled and reclaims assets.
 * @param {number} channelId
 * @param {function} logFn
 */
/**
 * List videos on a channel's YouTube Studio "Content" page that still need scheduling
 * (draft / private / unlisted / unknown — i.e. NOT already scheduled or public). Powers the
 * "Studio Videos" recovery tab so a video that uploaded but failed to schedule can be scheduled
 * manually. Best-effort DOM scrape; throws only on hard failures (not logged in, page never loads).
 * @param {number} channelId
 * @param {function} logFn
 * @returns {Promise<Array<{videoId:string,title:string,thumbnail:string,status:string}>>}
 */
export async function listStudioDraftsBrowser(channelId, logFn = console.log) {
  await closeBrowserSession(channelId);
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
  await new Promise(r => setTimeout(r, 800));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();
  try {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lp = path.join(profilePath, f);
      if (fs.existsSync(lp)) fs.unlinkSync(lp);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  if (!channel) throw new Error(`Channel ${channelId} not found.`);
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet Studio] Listing drafts for channel ${channelId} (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({ username: proxyConfig.username || '', password: proxyConfig.password || '' });
    }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const targetUrl = channel.youtube_channel_id
      ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/videos/upload?hl=en&persist_hl=1`
      : `https://studio.youtube.com/channel/videos?hl=en&persist_hl=1`;
    logFn(`[Puppet Studio] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in for this channel. Set up the browser session in channel settings first.');
    }

    // Patient wait for the video rows to render (slow proxies can be slow to paint the list).
    let rowsReady = false;
    for (let a = 1; a <= 4 && !rowsReady; a++) {
      rowsReady = await page.waitForSelector('ytcp-video-row', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!rowsReady && a < 4) {
        logFn(`[Puppet Studio] Video rows not ready (attempt ${a}/4), waiting...`);
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    await new Promise(r => setTimeout(r, 2500));

    const rows = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const row of Array.from(document.querySelectorAll('ytcp-video-row'))) {
        let title = '';
        const t = row.querySelector('#video-title, a#video-title, #video-title-container a, #video-title-container');
        if (t) title = norm(t.textContent);
        let thumbnail = '';
        const img = row.querySelector('img');
        if (img) thumbnail = img.src || img.getAttribute('src') || '';
        // Draft rows have NO /video/ link (only an "Edit draft" button), so derive the id from the
        // thumbnail URL (/vi/<id>/) or any id attribute, not just from an anchor href.
        const idFrom = (s) => {
          if (!s) return '';
          const m = s.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//) || s.match(/\/video\/([a-zA-Z0-9_-]{11})/) || s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
          return m ? m[1] : '';
        };
        let videoId = '';
        for (const a of row.querySelectorAll('a')) { videoId = idFrom(a.href || ''); if (videoId) break; }
        if (!videoId) videoId = idFrom(thumbnail);
        if (!videoId) {
          const idEl = row.querySelector('[video-id],[videoid]');
          if (idEl) { const vv = idEl.getAttribute('video-id') || idEl.getAttribute('videoid'); if (vv && vv.length === 11) videoId = vv; }
        }
        const rowText = norm(row.textContent).toLowerCase();
        let status = 'unknown';
        if (/schedul|zamanlan/.test(rowText)) status = 'scheduled';
        else if (/edit draft|taslağı düzenle|\bdraft\b|taslak/.test(rowText)) status = 'draft';
        else if (/public|herkese/.test(rowText)) status = 'public';
        else if (/unlisted|liste dış/.test(rowText)) status = 'unlisted';
        else if (/private|özel/.test(rowText)) status = 'private';
        if (videoId) out.push({ videoId, title, thumbnail, status });
      }
      return out;
    });

    await browser.close();
    logFn(`[Puppet Studio] Found ${rows.length} rows total on the page.`);
    // Keep only videos that still need scheduling (exclude already-scheduled and already-public).
    const needs = rows.filter(r => r.status !== 'scheduled' && r.status !== 'public');
    logFn(`[Puppet Studio] ${needs.length} of them still need scheduling.`);
    return needs;
  } catch (err) {
    logFn(`[Puppet Studio] Error listing drafts: ${err.message}`);
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

/**
 * Schedule a DRAFT that already exists on Studio by driving the "Edit draft" wizard (the same
 * upload dialog used during upload) — a draft's normal edit page has no Visibility control, so the
 * edit-page reschedule cannot work on it. Reuses the tested dialog helpers. Does NOT re-upload.
 * Hard guard: never clicks the primary button unless it is the "Schedule" button (so it can never
 * accidentally publish the video immediately).
 */
export async function scheduleStudioDraftBrowser(channelId, videoId, scheduledAt, isPremiere = false, logFn = console.log) {
  await closeBrowserSession(channelId);
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
  await new Promise(r => setTimeout(r, 800));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();
  try {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lp = path.join(profilePath, f);
      if (fs.existsSync(lp)) fs.unlinkSync(lp);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  if (!channel) throw new Error(`Channel ${channelId} not found.`);
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;
  const opts = { scheduledAt, isPremiere: isPremiere ? 1 : 0 };

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet Draft] Scheduling draft ${videoId} on channel ${channelId} (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({ username: proxyConfig.username || '', password: proxyConfig.password || '' });
    }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const targetUrl = channel.youtube_channel_id
      ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/videos/upload?hl=en&persist_hl=1`
      : `https://studio.youtube.com/channel/videos?hl=en&persist_hl=1`;
    logFn(`[Puppet Draft] Opening content page: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in for this channel. Set up the browser session first.');
    }

    let rowsReady = false;
    for (let a = 1; a <= 4 && !rowsReady; a++) {
      rowsReady = await page.waitForSelector('ytcp-video-row', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!rowsReady && a < 4) await new Promise(r => setTimeout(r, 4000));
    }
    await new Promise(r => setTimeout(r, 2000));

    // Tag the "Edit draft" control on the row that matches this video id, then TRUSTED-click it.
    const tagged = await page.evaluate((vid) => {
      const rows = Array.from(document.querySelectorAll('ytcp-video-row'));
      for (const row of rows) {
        const hasId = Array.from(row.querySelectorAll('a,img')).some(e => ((e.href || e.src || '')).includes(vid));
        if (!hasId) continue;
        const cands = Array.from(row.querySelectorAll('button, a, ytcp-button, [role="button"]'));
        const editBtn = cands.find(b => /edit draft|taslağı düzenle/i.test(b.textContent || ''));
        const target = editBtn || row.querySelector('a#video-title, #video-title a, #thumbnail, a');
        if (target) { target.setAttribute('data-gag-target', '1'); return true; }
      }
      return false;
    }, videoId);
    if (!tagged) throw new Error('Could not find this draft on the content page (it may have been published or removed).');

    const editHandle = await page.$('[data-gag-target="1"]');
    if (!editHandle) throw new Error('Could not access the Edit draft button.');
    await editHandle.click();
    logFn('[Puppet Draft] Clicked Edit draft; waiting for the upload dialog...');

    let dialogReady = false;
    for (let a = 1; a <= 4 && !dialogReady; a++) {
      dialogReady = await page.waitForSelector('ytcp-uploads-dialog, #details, ytcp-uploads-details', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!dialogReady && a < 4) await new Promise(r => setTimeout(r, 3000));
    }
    if (!dialogReady) throw new Error('The Edit draft dialog did not open (slow proxy, or the draft is not editable).');
    await new Promise(r => setTimeout(r, 2500));

    // Make sure "Made for kids" is set to No so the wizard isn't blocked on step 1.
    try {
      await page.evaluate(() => {
        function deep(sel, root = document, out = []) {
          out.push(...root.querySelectorAll(sel));
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out);
          return out;
        }
        const vis = el => el && el.offsetParent !== null;
        const radios = deep('tp-yt-paper-radio-button, [role="radio"]').filter(vis);
        const notForKids = radios.find(el => {
          const text = (el.textContent || '').toLowerCase();
          return text.includes('not made for kids') || text.includes('çocuklara özel değil') || (el.getAttribute('name') === 'VIDEO_MADE_FOR_KIDS_NOT_FOR_KIDS');
        });
        if (notForKids) {
          const isChecked = notForKids.checked || notForKids.hasAttribute('checked') || notForKids.getAttribute('aria-checked') === 'true';
          if (!isChecked) notForKids.click();
        }
      });
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      logFn(`[Puppet Draft] Warning during audience selection check: ${e.message}`);
    }

    // Details -> Video elements -> Checks -> Visibility (mirror upload flow: up to 3 Next).
    for (let i = 1; i <= 3; i++) {
      const nb = await page.waitForSelector('#next-button', { timeout: 15000 }).catch(() => null);
      if (!nb) { logFn(`[Puppet Draft] No #next-button at step ${i} - assuming already at Visibility.`); break; }
      await safeClick(page, nb, { scroll: true });
      await new Promise(r => setTimeout(r, 1500));
    }

    logFn('[Puppet Draft] Activating Schedule mode + applying date/time...');
    await activateScheduleMode(page, logFn);
    await new Promise(r => setTimeout(r, 800));
    await reapplyDateTime(page, opts, logFn);
    await new Promise(r => setTimeout(r, 800));

    // NOTE: premiere is intentionally NOT toggled in this draft-recovery path. In the Edit-draft dialog
    // toggling premiere collapses the schedule step (picker + commit button vanish -> "Could not find
    // the Schedule button"), and recovery is unreliable. This path exists to RELIABLY schedule a video
    // that got stuck as a draft, so we schedule it as a normal scheduled video (it still goes live at
    // the chosen time). Premieres should be set at upload time via the edit-page enforce path.
    if (opts.isPremiere) {
      logFn('[Puppet Draft] Scheduling as a normal scheduled video (premiere is skipped here to keep draft scheduling reliable).');
    }

    let { handle: primaryBtn, id: primaryId } = await getPrimaryButtonHandle(page);
    for (let attempt = 1; attempt <= 2 && !/schedule/i.test(primaryId || ''); attempt++) {
      logFn(`[Puppet Draft] Primary button is "${primaryId}" (not schedule) - re-activating (attempt ${attempt}).`);
      await activateScheduleMode(page, logFn);
      if (!scheduleIsIntact(await readScheduleValues(page), opts).ok) await reapplyDateTime(page, opts, logFn);
      await new Promise(r => setTimeout(r, 1000));
      if (primaryBtn) { await primaryBtn.dispose(); }
      ({ handle: primaryBtn, id: primaryId } = await getPrimaryButtonHandle(page));
    }
    if (!primaryBtn) {
      // Dump the dialog state so we can see WHERE it stopped (wrong step? processing screen? different
      // commit button id?) instead of guessing.
      try {
        const dump = await page.evaluate(() => {
          function deep(sel, root = document, out = []) { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deep(sel, el.shadowRoot, out); return out; }
          const vis = el => el && el.offsetParent !== null;
          const desc = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28)}"`;
          const buttons = deep('ytcp-button, button').filter(el => vis(el) && el.id).map(desc).slice(0, 16);
          const steps = deep('[id^="step-badge"]').map(el => `${el.id}${el.getAttribute('aria-selected') === 'true' ? '(active)' : ''}`);
          const dlg = deep('ytcp-uploads-dialog')[0];
          return { buttons, steps, dialogVisible: vis(dlg), dialogText: dlg ? (dlg.innerText || dlg.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '(no uploads dialog)' };
        });
        logFn(`[Puppet Draft] BUTTON-MISSING DUMP: ${JSON.stringify(dump)}`);
      } catch (e) { logFn(`[Puppet Draft] button-missing dump failed: ${e.message}`); }
      throw new Error('Could not find the Schedule button in the draft dialog.');
    }
    if (!/schedule/i.test(primaryId || '')) {
      throw new Error(`Draft would not enter Schedule mode (button stayed "${primaryId}") - not committing, to avoid publishing immediately.`);
    }

    logFn(`[Puppet Draft] Clicking "${primaryId}" (trusted)...`);
    await trustedClickHandle(page, primaryBtn, logFn);
    try { await primaryBtn.dispose(); } catch (e) {}
    await new Promise(r => setTimeout(r, 4000));

    logFn('[Puppet Draft] Schedule committed. Closing browser.');
    await browser.close();
    return { videoId, scheduled: true };
  } catch (err) {
    logFn(`[Puppet Draft] Error scheduling draft: ${err.message}`);
    try {
      const sp = path.join(profilePath, 'puppet_draft_error.png');
      await page.screenshot({ path: sp });
      logFn(`[Puppet Draft] Saved error screenshot: ${sp}`);
    } catch (e) {}
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

/**
 * Scan ALL videos on a channel's YouTube Studio content page (scheduled, published, private, draft…)
 * for the "Sync from YouTube" reconcile. Returns { videoId, title, thumbnail, status, isPremiere, dateText }.
 * Best-effort DOM scrape; throws only on hard failures (not logged in / page never loads).
 */
export async function listAllStudioVideosBrowser(channelId, logFn = console.log) {
  await closeBrowserSession(channelId);
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
  await new Promise(r => setTimeout(r, 800));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();
  try {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lp = path.join(profilePath, f);
      if (fs.existsSync(lp)) fs.unlinkSync(lp);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  if (!channel) throw new Error(`Channel ${channelId} not found.`);
  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet Studio] Scanning ALL videos for channel ${channelId} (headless: ${runHeadless})`);
  const browser = await launchBrowserWithRetry(chromePath, profilePath, runHeadless, 3, 3000, proxyUrl);

  let page;
  try {
    page = await browser.newPage();
    if (proxyConfig && (proxyConfig.username || proxyConfig.password)) {
      await page.authenticate({ username: proxyConfig.username || '', password: proxyConfig.password || '' });
    }
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const targetUrl = channel.youtube_channel_id
      ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/videos/upload?hl=en&persist_hl=1`
      : `https://studio.youtube.com/channel/videos?hl=en&persist_hl=1`;
    logFn(`[Puppet Studio] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in for this channel. Set up the browser session in channel settings first.');
    }

    let rowsReady = false;
    for (let a = 1; a <= 4 && !rowsReady; a++) {
      rowsReady = await page.waitForSelector('ytcp-video-row', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!rowsReady && a < 4) await new Promise(r => setTimeout(r, 4000));
    }
    await new Promise(r => setTimeout(r, 2500));

    const rows = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const idFrom = (s) => {
        if (!s) return '';
        const m = s.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//) || s.match(/\/video\/([a-zA-Z0-9_-]{11})/) || s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : '';
      };
      const out = [];
      for (const row of Array.from(document.querySelectorAll('ytcp-video-row'))) {
        let title = '';
        const t = row.querySelector('#video-title, a#video-title, #video-title-container a, #video-title-container');
        if (t) title = norm(t.textContent);
        let thumbnail = '';
        const img = row.querySelector('img');
        if (img) thumbnail = img.src || img.getAttribute('src') || '';
        let videoId = '';
        for (const a of row.querySelectorAll('a')) { videoId = idFrom(a.href || ''); if (videoId) break; }
        if (!videoId) videoId = idFrom(thumbnail);
        if (!videoId) { const idEl = row.querySelector('[video-id],[videoid]'); if (idEl) { const vv = idEl.getAttribute('video-id') || idEl.getAttribute('videoid'); if (vv && vv.length === 11) videoId = vv; } }
        const rowText = norm(row.textContent);
        const low = rowText.toLowerCase();
        let status = 'unknown';
        if (/schedul|zamanlan|upcoming|premieres/.test(low)) status = 'scheduled';
        else if (/edit draft|taslağı düzenle|\bdraft\b|taslak/.test(low)) status = 'draft';
        else if (/public|herkese/.test(low)) status = 'public';
        else if (/unlisted|liste dış/.test(low)) status = 'unlisted';
        else if (/private|özel/.test(low)) status = 'private';
        const isPremiere = /premiere|premieres|pr[oö]miyer/i.test(rowText) ? 1 : 0;
        let dateText = '';
        const dm = rowText.match(/[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*(?:AM|PM))?/) || rowText.match(/\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/);
        if (dm) dateText = dm[0];
        if (videoId) out.push({ videoId, title, thumbnail, status, isPremiere, dateText });
      }
      return out;
    });

    await browser.close();
    logFn(`[Puppet Studio] Scanned ${rows.length} videos on the channel.`);
    return rows;
  } catch (err) {
    logFn(`[Puppet Studio] Error scanning videos: ${err.message}`);
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

export async function syncChannelWithYouTubeBrowser(channelId, logFn = console.log) {
  await closeBrowserSession(channelId);
  try { await stopVncSessionForProfile(getProfilePath(channelId)); } catch (e) {}
  await new Promise(r => setTimeout(r, 1000));

  const profilePath = getProfilePath(channelId);
  const chromePath = getChromePath();

  // Force clean up lock files
  try {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const f of lockFiles) {
      const p = path.join(profilePath, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {}

  const channel = queryOne('SELECT * FROM channels WHERE id = @id', { id: channelId });
  if (!channel) throw new Error(`Channel ${channelId} not found.`);

  const proxyConfig = resolveChannelProxy(channel);
  const proxyUrl = proxyConfig ? proxyConfig.proxyUrl : null;

  const runHeadless = process.env.PUPPET_HEADLESS !== 'false';
  logFn(`[Puppet Sync] Starting browser sync for channel ${channelId} (headless: ${runHeadless})`);
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
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setUserAgent(getUserAgent());
    await page.setViewport({ width: 1280, height: 800 });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const targetUrl = channel.youtube_channel_id
      ? `https://studio.youtube.com/channel/${channel.youtube_channel_id}/videos/upload?hl=en`
      : `https://studio.youtube.com/channel/videos?hl=en`;

    logFn(`[Puppet Sync] Navigating to Content page: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    if (page.url().includes('accounts.google.com')) {
      throw new Error('Not logged in. Please set up your browser session in the channel settings first.');
    }

    logFn('[Puppet Sync] Waiting for videos list to load...');
    await page.waitForSelector('ytcp-video-row, #row-container, ytcp-video-list-cell-video, a', { timeout: 15000 }).catch(() => null);

    // Give a small delay for react rendering
    await new Promise(r => setTimeout(r, 3000));

    logFn('[Puppet Sync] Extracting video IDs from the page DOM...');
    const videoIds = await page.evaluate(() => {
      const ids = new Set();
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.href || '';
        const watchMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (watchMatch) {
          ids.add(watchMatch[1]);
          continue;
        }
        const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) {
          ids.add(shortsMatch[1]);
          continue;
        }
        const editMatch = href.match(/\/video\/([a-zA-Z0-9_-]{11})/);
        if (editMatch) {
          ids.add(editMatch[1]);
          continue;
        }
      }
      const elements = Array.from(document.querySelectorAll('[video-id], [videoid]'));
      for (const el of elements) {
        const vid = el.getAttribute('video-id') || el.getAttribute('videoid');
        if (vid && vid.length === 11) {
          ids.add(vid);
        }
      }
      return Array.from(ids);
    });

    logFn(`[Puppet Sync] Found ${videoIds.length} video IDs on the visible page.`);
    await browser.close();

    // Query completed posts from last 14 days
    const cutoffDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const completedPosts = queryAll(
      `SELECT * FROM scheduled_posts 
       WHERE channel_id = @channelId 
         AND status = 'complete' 
         AND youtube_video_id IS NOT NULL
         AND scheduled_at >= @cutoffDate`,
      { channelId, cutoffDate }
    );

    let cancelledCount = 0;
    for (const post of completedPosts) {
      if (!videoIds.includes(post.youtube_video_id)) {
        logFn(`[Puppet Sync] Video ${post.youtube_video_id} ("${post.title}") not found on YouTube Studio. Reclaiming assets...`);
        // Reclaim thumbnail
        if (post.thumbnail_id) {
          run(`UPDATE thumbnails SET used = 0 WHERE id = @id`, { id: post.thumbnail_id });
        }
        // Reclaim title
        if (post.title) {
          run(`
            UPDATE titles 
            SET used = 0 
            WHERE id = (
              SELECT id FROM titles 
              WHERE channel_id = @channelId AND text = @title AND used = 1 
              ORDER BY id DESC 
              LIMIT 1
            )
          `, { channelId: post.channel_id, title: post.title });
        }
        // Mark post as cancelled
        run(`UPDATE scheduled_posts SET status = 'cancelled' WHERE id = @id`, { id: post.id });
        // The uploads table's CHECK constraint does NOT include 'cancelled' — writing it threw a
        // SqliteError that aborted the whole sync mid-run (leaving its browser lingering, which then
        // collided with the next upload). Use a valid status and guard it so bookkeeping can never
        // crash the sync. The scheduled_posts row is already marked cancelled above (what matters).
        try {
          run(`UPDATE uploads SET status = 'error' WHERE channel_id = @channelId AND youtube_video_id = @youtubeVideoId`, {
            channelId: post.channel_id,
            youtubeVideoId: post.youtube_video_id
          });
        } catch (e) {
          logFn(`[Puppet Sync] Could not update uploads row for ${post.youtube_video_id}: ${e.message}`);
        }
        cancelledCount++;
      }
    }

    logFn(`[Puppet Sync] Sync complete. Synced: ${completedPosts.length}, Cancelled: ${cancelledCount}`);
    return { synced: completedPosts.length, cancelled: cancelledCount };
  } catch (err) {
    logFn(`[Puppet Sync] Sync error: ${err.message}`);
    try {
      await page.screenshot({ path: path.join(profilePath, 'puppet_sync_error.png') });
    } catch {}
    try {
      await browser.close();
    } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
