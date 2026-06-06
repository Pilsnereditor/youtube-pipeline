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
import { queryOne } from '../db/database.js';

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
  
  // For new channel logins, start with a completely fresh profile
  if (profileName === 'yt_setup_new' && fs.existsSync(profilePath)) {
    console.log('[VNC] Clearing fresh profile for new channel login...');
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
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
  
  // Resolve proxy
  let proxyArg = null;
  let activeProxyPoolId = null;
  let needsAuth = false;
  let proxyUser = '';
  let proxyPass = '';
  try {
    
    // Check if there is a temp proxy pool ID setting for this profile
    const setting = queryOne("SELECT value FROM settings WHERE key = @key", { key: `proxy_for_profile_${profileName}` });
    if (setting && setting.value) {
      activeProxyPoolId = Number(setting.value);
    }
    
    // If not found in settings, check if there's an existing channel linked to this profile
    if (!activeProxyPoolId) {
      const channel = queryOne('SELECT * FROM channels WHERE profile_name = @profileName LIMIT 1', { profileName });
      if (channel && channel.proxy_pool_id) {
        activeProxyPoolId = channel.proxy_pool_id;
      }
    }
    
    if (activeProxyPoolId) {
      const proxy = queryOne('SELECT * FROM proxy_pool WHERE id = @id', { id: activeProxyPoolId });
      if (proxy) {
        proxyArg = `--proxy-server=${proxy.protocol}://${proxy.host}:${proxy.port}`;
        console.log(`[VNC] Using proxy ${proxy.protocol}://${proxy.host}:${proxy.port} for setup profile "${profileName}"`);
        if (proxy.username) {
          needsAuth = true;
          proxyUser = proxy.username;
          proxyPass = proxy.password || '';
        }
      }
    }
  } catch (err) {
    console.error('[VNC] Error resolving proxy for VNC setup session:', err);
  }

  const chromeArgs = [
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
    '--password-store=basic',
    '--use-mock-keychain'
  ];

  if (proxyArg) {
    chromeArgs.push(proxyArg);
  }

  // WebRTC leak prevention
  chromeArgs.push('--enforce-webrtc-ip-permission-check');
  chromeArgs.push('--disable-webrtc-hw-decoding');
  chromeArgs.push('--disable-webrtc-hw-encoding');
  chromeArgs.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');

  if (needsAuth) {
    chromeArgs.push('about:blank');
    console.log('[VNC] Proxy needs authentication. Starting Chrome on about:blank to configure auth first...');
  } else {
    chromeArgs.push('https://studio.youtube.com?hl=en&persist_hl=1');
  }

  const chrome = spawn(chromePath, chromeArgs, {
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

  // Automate proxy authentication if proxy has username/password
  let cdpBrowser = null;
  if (needsAuth) {
    try {
      console.log('[VNC] Connecting via CDP to authenticate proxy credentials...');
      // Wait to ensure CDP port is active
      await sleep(1500);
      cdpBrowser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${CDP_PORT}`,
        defaultViewport: null
      });

      const applyAuth = async (p) => {
        try {
          await p.authenticate({
            username: proxyUser,
            password: proxyPass
          });
          console.log('[VNC] Proxy credentials applied.');
        } catch (e) {
          console.error('[VNC] Failed to apply proxy credentials to page:', e);
        }
      };

      const pages = await cdpBrowser.pages();
      for (const p of pages) {
        await applyAuth(p);
      }

      // Listen for new targets (tabs/windows)
      cdpBrowser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
          const p = await target.page();
          if (p) {
            await applyAuth(p);
          }
        }
      });

      // Now navigate to YouTube Studio after authentication is set up
      if (pages.length > 0) {
        const page = pages[0];
        console.log('[VNC] Navigating page to YouTube Studio after auth setup...');
        page.goto('https://studio.youtube.com?hl=en&persist_hl=1').catch(err => {
          console.error('[VNC] Navigation error (expected if loading takes long):', err.message);
        });
      }
    } catch (err) {
      console.warn('[VNC] Failed to automate proxy credentials via CDP:', err.message);
    }
  }

  vncSession = { xvfb, openbox, chrome, x11vnc, websockify, profilePath, profileName, cdpBrowser };

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
 * Get the current VNC session's profile name
 */
export function getVncProfileName() {
  return vncSession ? vncSession.profileName : null;
}

/**
 * Get the current VNC session's profile path
 */
export function getVncProfilePath() {
  return vncSession ? vncSession.profilePath : null;
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
        waitUntil: 'networkidle2',
        timeout: 45000
      });
      await sleep(5000);
    }

    // --- Extract channel ID from URL (most reliable) ---
    const currentUrl = page.url();
    let ytChannelId = '';
    const cidMatch = currentUrl.match(/channel\/(UC[A-Za-z0-9_-]+)/);
    if (cidMatch) ytChannelId = cidMatch[1];

    // If no channel ID in URL, try finding it in page links
    if (!ytChannelId) {
      ytChannelId = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="channel/UC"]');
        for (const link of links) {
          const m = link.href.match(/channel\/(UC[A-Za-z0-9_-]+)/);
          if (m) return m[1];
        }
        // Also check meta tags and canonical URLs
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) {
          const m = canonical.href.match(/channel\/(UC[A-Za-z0-9_-]+)/);
          if (m) return m[1];
        }
        return '';
      });
    }

    // --- Extract channel name ---
    // Strategy: Use the YouTube API endpoint that Studio itself uses
    let channelName = '';

    // Method 1: Try clicking the account avatar to open the account menu
    try {
      // Click the avatar button in top-right to open account switcher
      const avatarBtn = await page.$('button#avatar-btn, img.channel-thumbnail-icon, #avatar-btn img, button[aria-label*="Account"], .ytcp-account-settings img');
      if (avatarBtn) {
        await avatarBtn.click();
        await sleep(1500);
        
        // Now look for channel name in the opened menu
        channelName = await page.evaluate(() => {
          // The account menu shows channel name prominently
          const nameSelectors = [
            '.yt-spec-touch-feedback-shape__fill + div',
            '#channel-name',
            '.channel-name',
            'yt-formatted-string.style-scope.ytd-active-account-header-renderer',
            '[data-e2e-active-account-name]',
          ];
          for (const sel of nameSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) return el.textContent.trim();
          }
          return '';
        });
        
        // Close the menu by pressing Escape
        await page.keyboard.press('Escape');
        await sleep(500);
      }
    } catch (e) {
      console.warn('[VNC Verify] Avatar click method failed:', e.message);
    }

    // Method 2: Navigate to channel customization page to get the name
    if (!channelName) {
      try {
        const customUrl = ytChannelId 
          ? `https://studio.youtube.com/channel/${ytChannelId}/editing/details`
          : 'https://studio.youtube.com/channel/editing/details';
        await page.goto(customUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
        
        channelName = await page.evaluate(() => {
          // On the customization page, the channel name is in an input field
          const nameInput = document.querySelector('#name-input input, #channel-name-input input, [aria-label="Channel name"] input, #textbox[aria-label*="name"]');
          if (nameInput && nameInput.value) return nameInput.value.trim();
          
          // Or try the text content of the name area
          const nameArea = document.querySelector('#name-input #textbox, .channel-name-text');
          if (nameArea && nameArea.textContent.trim()) return nameArea.textContent.trim();
          
          return '';
        });

        // Navigate back to dashboard
        if (ytChannelId) {
          await page.goto(`https://studio.youtube.com/channel/${ytChannelId}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
      } catch (e) {
        console.warn('[VNC Verify] Customization page method failed:', e.message);
      }
    }

    // Method 3: Broad DOM search — find text near "Your channel" label
    if (!channelName) {
      channelName = await page.evaluate(() => {
        // Look for all text nodes and find channel-like text
        const badNames = ['channel dashboard', 'channel content', 'channel analytics', 
                          'your channel', 'youtube studio', 'dashboard', 'content',
                          'analytics', 'community', 'subtitles', 'settings'];
        
        // Try to find the channel name near the avatar/profile section
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          if (el.children.length > 0) continue; // Only leaf nodes
          const text = (el.textContent || '').trim();
          if (text.length >= 2 && text.length <= 60 && !badNames.includes(text.toLowerCase())) {
            // Check if this element is near a channel avatar or "Your channel" text
            const parent = el.parentElement;
            const grandparent = parent ? parent.parentElement : null;
            const context = (parent?.textContent || '') + (grandparent?.textContent || '');
            if (context.toLowerCase().includes('your channel') && text.toLowerCase() !== 'your channel') {
              return text;
            }
          }
        }
        
        // Look for @handle
        const bodyText = document.body.innerText || '';
        const handleMatch = bodyText.match(/@[\w][\w.-]{1,30}/);
        if (handleMatch) return handleMatch[0];
        
        return '';
      });
    }

    // Method 4: Use channel ID as fallback name
    if (!channelName && ytChannelId) {
      channelName = ytChannelId;
    }

    console.log(`[VNC Verify] Found channel: name="${channelName}", id="${ytChannelId}"`);

    const channels = [];
    if (channelName || ytChannelId) {
      channels.push({
        name: channelName || ytChannelId,
        ytChannelId: ytChannelId,
        url: currentUrl
      });
    }

    return { channels, pageTitle: await page.title(), url: currentUrl };
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
    if (vncSession.cdpBrowser) {
      try { vncSession.cdpBrowser.disconnect(); } catch {}
    }
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
