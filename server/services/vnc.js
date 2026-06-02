/**
 * VNC-based remote browser management for YouTube Login Setup.
 * 
 * Architecture:
 *   Xvfb (virtual display :99)
 *     └─ openbox (window manager)
 *         └─ Chrome (visible, with --remote-debugging-port=9222)
 *   x11vnc (shares display :99 over VNC on port 5999)
 *   websockify (bridges VNC:5999 → WebSocket:6080, serves noVNC web client)
 *
 * The frontend embeds an <iframe> pointing to noVNC on port 6080.
 * All keyboard/mouse interaction is handled natively by noVNC — no manual forwarding needed.
 */

import { spawn, execSync } from 'child_process';
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISPLAY = ':99';
const VNC_PORT = 5999;
const WS_PORT = 6080;
const CDP_PORT = 9222;
const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');

if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

let vncSession = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function killProc(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
  }, 2000);
}

function execQuiet(cmd) {
  try { execSync(cmd, { stdio: 'ignore', timeout: 5000 }); } catch {}
}

/**
 * Find Google Chrome on the system
 */
function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return process.env.CHROME_PATH || '/usr/bin/google-chrome';
}

/**
 * Check if VNC dependencies are installed
 */
function checkVncDeps() {
  const deps = ['Xvfb', 'x11vnc', 'websockify'];
  const missing = [];
  for (const dep of deps) {
    try {
      execSync(`which ${dep}`, { stdio: 'ignore', timeout: 3000 });
    } catch {
      missing.push(dep);
    }
  }
  // Also check for noVNC web directory
  const novncPaths = ['/usr/share/novnc', '/usr/share/noVNC', '/opt/novnc'];
  const novncDir = novncPaths.find(p => fs.existsSync(p));
  if (!novncDir) missing.push('novnc');

  return { ok: missing.length === 0, missing, novncDir };
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

/**
 * Launch a full VNC session: Xvfb → openbox → Chrome → x11vnc → websockify
 * Returns { ws_port, vnc_available, missing_deps }
 */
export async function launchVncSession(profileName = 'yt_setup_global') {
  // Kill any existing session first
  await stopVncSession();

  // Check dependencies
  const depsCheck = checkVncDeps();
  if (!depsCheck.ok) {
    console.warn('[VNC] Missing dependencies:', depsCheck.missing);
    return {
      success: true,
      mode: 'vnc',
      vnc_available: false,
      missing_deps: depsCheck.missing,
      ws_port: WS_PORT
    };
  }

  const profilePath = path.join(PROFILES_DIR, profileName);
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

  // Clean Chrome lock files
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(profilePath, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  // Kill any stale processes from previous runs
  execQuiet('pkill -f "Xvfb :99"');
  execQuiet('pkill -f "x11vnc.*5999"');
  execQuiet('pkill -f "websockify.*6080"');
  execQuiet('pkill -f "openbox.*DISPLAY=:99"');
  await sleep(500);

  const env = { ...process.env, DISPLAY };

  console.log('[VNC] Starting Xvfb on display :99...');
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-ac'], {
    detached: true, stdio: 'ignore'
  });
  xvfb.unref();
  await sleep(1000);

  console.log('[VNC] Starting openbox window manager...');
  const openbox = spawn('openbox', [], {
    detached: true, stdio: 'ignore', env
  });
  openbox.unref();
  await sleep(500);

  console.log('[VNC] Launching Chrome...');
  const chromePath = findChrome();
  const chrome = spawn(chromePath, [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    '--window-size=1280,800',
    '--window-position=0,0',
    '--start-maximized',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    'https://studio.youtube.com?hl=en&persist_hl=1'
  ], {
    detached: true, stdio: 'ignore', env
  });
  chrome.unref();
  await sleep(2500);

  console.log('[VNC] Starting x11vnc...');
  const x11vnc = spawn('x11vnc', [
    '-display', DISPLAY,
    '-nopw',
    '-forever',
    '-shared',
    '-rfbport', String(VNC_PORT),
    '-cursor', 'arrow',
    '-noxdamage',
    '-xkb',
    '-ncache', '0'
  ], {
    detached: true, stdio: 'ignore'
  });
  x11vnc.unref();
  await sleep(1000);

  console.log('[VNC] Starting websockify (noVNC bridge)...');
  const websockify = spawn('websockify', [
    '--web', depsCheck.novncDir,
    String(WS_PORT),
    `localhost:${VNC_PORT}`
  ], {
    detached: true, stdio: 'ignore'
  });
  websockify.unref();
  await sleep(1000);

  vncSession = { xvfb, openbox, chrome, x11vnc, websockify, profilePath, profileName };

  console.log(`[VNC] Session ready. noVNC available at port ${WS_PORT}`);

  return {
    success: true,
    mode: 'vnc',
    vnc_available: true,
    ws_port: WS_PORT,
    missing_deps: []
  };
}

/**
 * Check if VNC session is active
 */
export function isVncActive() {
  return vncSession !== null;
}

/**
 * Get the websockify port for noVNC
 */
export function getVncPort() {
  return WS_PORT;
}

/**
 * Verify channels by connecting to Chrome via CDP and scraping YouTube Studio
 */
export async function verifyVncChannels() {
  if (!vncSession) {
    throw new Error('No active browser session. Please launch Chrome first.');
  }

  let browser = null;
  try {
    // Connect to the Chrome instance via CDP
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null
    });

    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('studio.youtube.com'));
    if (!page) page = pages[0];

    const url = page.url();

    // Check if we're on Google login page
    if (url.includes('accounts.google.com')) {
      throw new Error('Not logged in yet. Please sign in to your Google account in the browser first.');
    }

    // Navigate to YouTube Studio if not already there
    if (!url.includes('studio.youtube.com')) {
      await page.goto('https://studio.youtube.com?hl=en&persist_hl=1', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await sleep(3000);
    }

    // Extract channel info from the Studio page
    const channelInfo = await page.evaluate(() => {
      const channels = [];

      // Try multiple selectors for channel name
      const selectors = [
        '.channel-name',
        '.ytcp-account-settings__channel-name',
        '.ytcpAppHeaderChannelName',
        '.dashboard-channel-name',
        '[class*="channel-name"]',
        'ytcp-account-settings .ytcp-account-settings__channel-name'
      ];

      let name = '';
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          name = el.textContent.trim();
          break;
        }
      }

      // Try getting channel name from the page title
      if (!name && document.title) {
        const match = document.title.match(/(.+?)\s*[-–—]\s*YouTube Studio/);
        if (match) name = match[1].trim();
      }

      // Get channel ID from URL
      const currentUrl = window.location.href;
      const channelIdMatch = currentUrl.match(/channel\/(UC[A-Za-z0-9_-]+)/);

      if (name) {
        channels.push({
          name,
          ytChannelId: channelIdMatch ? channelIdMatch[1] : '',
          url: currentUrl
        });
      }

      return { channels, pageTitle: document.title, url: currentUrl };
    });

    return channelInfo;
  } finally {
    // Disconnect (don't close — Chrome should keep running)
    if (browser) {
      try { browser.disconnect(); } catch {}
    }
  }
}

/**
 * Stop VNC session and kill all processes
 */
export async function stopVncSession() {
  if (vncSession) {
    console.log('[VNC] Stopping VNC session...');
    killProc(vncSession.websockify);
    killProc(vncSession.x11vnc);
    killProc(vncSession.chrome);
    killProc(vncSession.openbox);
    killProc(vncSession.xvfb);
    vncSession = null;
  }

  // Kill any remaining processes by name (safety net)
  execQuiet('pkill -f "Xvfb :99"');
  execQuiet('pkill -f "x11vnc.*5999"');
  execQuiet('pkill -f "websockify.*6080"');
  await sleep(500);

  console.log('[VNC] Session stopped.');
}
