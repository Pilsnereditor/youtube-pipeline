/**
 * VNC-based remote browser management for YouTube Login Setup.
 *
 * Multi-user architecture (Solution A):
 *   Each concurrent user login gets its own isolated "slot" — a unique virtual
 *   display, x11vnc port, websockify port, and Chrome debugging port — so up to
 *   SLOTS.length users can run interactive logins at the same time without ever
 *   sharing a screen, cookies, or a session.
 *
 *   Per slot:
 *     Xvfb (virtual display :99/:100/:101)
 *       └─ openbox (window manager)
 *           └─ Chrome (visible, --remote-debugging-port=92xx)
 *     x11vnc (shares the display over VNC on port 59xx/60xx)
 *     websockify (bridges VNC → WebSocket on port 608x, serves noVNC)
 *
 *   Sessions are tracked in a Map keyed by userId. The websockify proxy in
 *   server/index.js resolves the requesting user and routes them only to their
 *   own slot's websockify port.
 */

import { spawn, execSync } from 'child_process';
import net from 'net';
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { queryOne } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILES_DIR = path.join(__dirname, '..', '..', 'data', 'profiles');

if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Fixed pool of isolated resource slots. One slot per concurrent interactive login.
// Sized to the number of users expected to log in simultaneously.
const SLOTS = [
  { display: ':99',  vncPort: 5910, wsPort: 6080, cdpPort: 9222 },
  { display: ':100', vncPort: 5911, wsPort: 6081, cdpPort: 9223 },
  { display: ':101', vncPort: 5912, wsPort: 6082, cdpPort: 9224 },
  { display: ':102', vncPort: 5913, wsPort: 6083, cdpPort: 9225 },
];

// userId -> session object (includes its allocated slot)
const vncSessions = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Awaitable termination: SIGTERM, escalate to SIGKILL, resolve only once the
 *  process has actually exited (or was already dead). Prevents port-rebind races. */
function killProcAsync(proc, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', finish);
    proc.once('error', finish);
    try { proc.kill('SIGTERM'); } catch { return finish(); }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      setTimeout(finish, 300);
    }, timeoutMs);
  });
}

function execQuiet(cmd) {
  try { execSync(cmd, { stdio: 'ignore', timeout: 5000 }); } catch {}
}

// --- Readiness / lifecycle helpers ----------------------------------------

/** ':99' -> '99' */
function displayNumber(display) {
  return String(display).replace(':', '').trim();
}

/** Remove stale X11 lock + socket for a display so a new Xvfb can bind it. */
function cleanX11Locks(display) {
  const n = displayNumber(display);
  for (const p of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

/** Spawn with an 'error' listener so ENOENT etc. don't throw uncaught, and early
 *  death is observable via proc.exitCode / proc._spawnErr. */
function spawnTracked(cmd, args, opts) {
  const proc = spawn(cmd, args, opts);
  proc._spawnErr = null;
  proc.on('error', (e) => { proc._spawnErr = e; });
  proc.unref();
  return proc;
}

/** Fail fast if a just-spawned process died within a short grace window. */
async function assertAlive(proc, label, graceMs = 400) {
  await sleep(graceMs);
  if (proc._spawnErr) throw new Error(`${label} failed to spawn: ${proc._spawnErr.message}`);
  if (proc.exitCode !== null) throw new Error(`${label} exited immediately with code ${proc.exitCode}`);
  if (proc.signalCode !== null) throw new Error(`${label} was killed by ${proc.signalCode}`);
}

/** Poll a TCP port on loopback until it accepts a connection or times out. */
function waitForPort(port, { host = '127.0.0.1', timeoutMs = 8000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ host, port });
      let done = false;
      const settle = (ok) => {
        if (done) return;
        done = true;
        sock.destroy();
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, intervalMs);
      };
      sock.once('connect', () => settle(true));
      sock.once('error', () => settle(false));
      sock.setTimeout(1000, () => settle(false));
    };
    attempt();
  });
}

/** Wait for a file (e.g. the X11 unix socket) to appear. */
async function waitForFile(filePath, timeoutMs = 6000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** One-time boot self-heal: kill orphaned children (detached+unref'd, survive a
 *  server restart) and wipe stale X11 locks for ALL slots. Safe: runs at module load
 *  when vncSessions is empty, so nothing it kills belongs to a live session. */
function selfHealSlotsOnStartup() {
  if (process.platform === 'win32') return;
  for (const slot of SLOTS) {
    const { display, vncPort, wsPort, cdpPort } = slot;
    execQuiet(`pkill -f "Xvfb ${display} "`);
    execQuiet(`pkill -f "x11vnc.*-rfbport ${vncPort}"`);
    execQuiet(`pkill -f "websockify.* ${wsPort} "`);
    execQuiet(`pkill -f "remote-debugging-port=${cdpPort}"`);
    cleanX11Locks(display);
  }
  console.log('[VNC] Startup self-heal complete (stale locks + orphan processes cleared).');
}

selfHealSlotsOnStartup();

/** Allocate a free slot, or null if all slots are in use. */
function allocateSlot() {
  const usedDisplays = new Set();
  for (const s of vncSessions.values()) {
    if (s.slot) usedDisplays.add(s.slot.display);
  }
  for (const slot of SLOTS) {
    if (!usedDisplays.has(slot.display)) return slot;
  }
  return null;
}

/**
 * Find Google Chrome on the system
 */
function findChrome() {
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LocalAppData || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return process.env.CHROME_PATH || 'chrome.exe';
  }

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
  if (process.platform === 'win32') {
    return { ok: true, missing: [], novncDir: '' };
  }
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

/**
 * Resolve the proxy (if any) for a given profile name.
 * Returns { proxyArg, needsAuth, proxyUser, proxyPass } or proxyArg=null.
 */
function resolveProxyForProfile(profileName) {
  let proxyArg = null;
  let activeProxyPoolId = null;
  let needsAuth = false;
  let proxyUser = '';
  let proxyPass = '';
  try {
    const setting = queryOne("SELECT value FROM settings WHERE key = @key", { key: `proxy_for_profile_${profileName}` });
    if (setting && setting.value) {
      activeProxyPoolId = Number(setting.value);
    }
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
    console.error('[VNC] Error resolving proxy for setup session:', err);
  }
  return { proxyArg, needsAuth, proxyUser, proxyPass };
}

/** Apply proxy auth to all current and future pages of a CDP browser. */
async function applyProxyAuth(cdpBrowser, proxyUser, proxyPass) {
  const applyAuth = async (p) => {
    try {
      await p.authenticate({ username: proxyUser, password: proxyPass });
      console.log('[VNC] Proxy credentials applied.');
    } catch (e) {
      console.error('[VNC] Failed to apply proxy credentials to page:', e);
    }
  };
  const pages = await cdpBrowser.pages();
  for (const p of pages) {
    await applyAuth(p);
  }
  cdpBrowser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const p = await target.page();
      if (p) await applyAuth(p);
    }
  });
  if (pages.length > 0) {
    const page = pages[0];
    console.log('[VNC] Navigating page to YouTube Studio after auth setup...');
    page.goto('https://studio.youtube.com?hl=en&persist_hl=1').catch(err => {
      console.error('[VNC] Navigation error (expected if loading takes long):', err.message);
    });
  }
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

/**
 * Launch a full VNC session for a specific user: Xvfb → openbox → Chrome → x11vnc → websockify
 * Each user gets an isolated slot (display + ports). Returns { ws_port, vnc_available, ... }.
 */
export async function launchVncSession(profileName = 'yt_setup_new', userId = null) {
  if (!userId) throw new Error('launchVncSession requires a userId for per-user isolation.');

  // Stop only THIS user's existing session (never touch other users' sessions).
  await stopVncSession(userId);

  // Check dependencies
  const depsCheck = checkVncDeps();
  if (!depsCheck.ok) {
    console.warn('[VNC] Missing dependencies:', depsCheck.missing);
    return {
      success: true,
      mode: 'vnc',
      vnc_available: false,
      missing_deps: depsCheck.missing,
      ws_port: null
    };
  }

  // Allocate an isolated slot for this user.
  const slot = allocateSlot();
  if (!slot) {
    throw new Error(`All ${SLOTS.length} login slots are currently in use. Please wait until another login finishes and try again.`);
  }
  const { display, vncPort, wsPort, cdpPort } = slot;

  const profilePath = path.join(PROFILES_DIR, profileName);

  // For fresh channel logins (profile name starting with "yt_setup_"), start clean.
  if (profileName.startsWith('yt_setup_') && fs.existsSync(profilePath)) {
    console.log(`[VNC] Clearing fresh profile "${profileName}" for new channel login...`);
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

  // Clean Chrome lock files
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(profilePath, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  if (process.platform === 'win32') {
    console.log('[VNC] Launching Chrome directly on Windows desktop...');
    const chromePath = findChrome();
    const { proxyArg, needsAuth, proxyUser, proxyPass } = resolveProxyForProfile(profileName);

    const chromeArgs = [
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
      '--window-size=1280,800',
      '--window-position=0,0',
      '--start-maximized',
      '--password-store=basic',
      '--use-mock-keychain'
    ];
    if (proxyArg) chromeArgs.push(proxyArg);
    chromeArgs.push('--enforce-webrtc-ip-permission-check');
    chromeArgs.push('--disable-webrtc-hw-decoding');
    chromeArgs.push('--disable-webrtc-hw-encoding');
    chromeArgs.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    chromeArgs.push(needsAuth ? 'about:blank' : 'https://studio.youtube.com?hl=en&persist_hl=1');

    const chrome = spawn(chromePath, chromeArgs, { detached: true, stdio: 'ignore' });
    chrome.unref();
    await sleep(2500);

    let cdpBrowser = null;
    if (needsAuth) {
      try {
        console.log('[VNC] Connecting via CDP to authenticate proxy credentials...');
        await sleep(1500);
        cdpBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null });
        await applyProxyAuth(cdpBrowser, proxyUser, proxyPass);
      } catch (err) {
        console.warn('[VNC] Failed to automate proxy credentials via CDP:', err.message);
      }
    }

    vncSessions.set(userId, { userId, slot, chrome, profilePath, profileName, cdpBrowser, isLocalChrome: true });

    return {
      success: true,
      mode: 'vnc',
      vnc_available: true,
      is_local_chrome: true,
      ws_port: null,
      missing_deps: []
    };
  }

  // Kill any stale processes for THIS slot only (never touch other slots/users).
  execQuiet(`pkill -f "Xvfb ${display} "`);
  execQuiet(`pkill -f "x11vnc.*-rfbport ${vncPort}"`);
  execQuiet(`pkill -f "websockify.* ${wsPort} "`);
  execQuiet(`pkill -f "openbox.*DISPLAY=${display}"`);
  execQuiet(`pkill -f "remote-debugging-port=${cdpPort}"`);
  await sleep(300);

  // Remove stale X11 lock + socket so a crashed Xvfb can't silently block a new one.
  cleanX11Locks(display);

  const env = { ...process.env, DISPLAY: display };
  const xSocket = `/tmp/.X11-unix/X${displayNumber(display)}`;

  // Track everything we start so we can clean up on any failure.
  let xvfb, openbox, chrome, x11vnc, websockify, cdpBrowser = null;

  try {
    console.log(`[VNC] Starting Xvfb on display ${display}...`);
    xvfb = spawnTracked('Xvfb', [display, '-screen', '0', '1280x800x24', '-ac', '-nolisten', 'tcp'], {
      detached: true, stdio: 'ignore'
    });
    await assertAlive(xvfb, 'Xvfb');
    if (!await waitForFile(xSocket, 6000)) {
      throw new Error(`Xvfb display ${display} never became ready (no ${xSocket}).`);
    }

    console.log('[VNC] Starting openbox window manager...');
    openbox = spawnTracked('openbox', [], { detached: true, stdio: 'ignore', env });
    await assertAlive(openbox, 'openbox', 300);

    console.log('[VNC] Launching Chrome...');
    const chromePath = findChrome();
    const { proxyArg, needsAuth, proxyUser, proxyPass } = resolveProxyForProfile(profileName);

    const chromeArgs = [
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${cdpPort}`,
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
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--password-store=basic',
      '--use-mock-keychain'
    ];
    if (proxyArg) chromeArgs.push(proxyArg);
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

    chrome = spawnTracked(chromePath, chromeArgs, { detached: true, stdio: 'ignore', env });
    await assertAlive(chrome, 'Chrome', 600);
    if (!await waitForPort(cdpPort, { timeoutMs: 10000 })) {
      throw new Error(`Chrome CDP port ${cdpPort} never opened.`);
    }

    console.log(`[VNC] Starting x11vnc on port ${vncPort}...`);
    x11vnc = spawnTracked('x11vnc', [
      '-display', display,
      '-nopw',
      '-forever',
      '-shared',
      '-localhost',
      '-rfbport', String(vncPort),
      '-cursor', 'arrow',
      '-noxdamage',
      '-xkb',
      '-ncache', '0'
    ], { detached: true, stdio: 'ignore' });
    await assertAlive(x11vnc, 'x11vnc');
    if (!await waitForPort(vncPort, { timeoutMs: 8000 })) {
      throw new Error(`x11vnc port ${vncPort} never opened.`);
    }

    console.log(`[VNC] Starting websockify (noVNC bridge) on port ${wsPort}...`);
    websockify = spawnTracked('websockify', [
      '--web', depsCheck.novncDir,
      String(wsPort),
      `127.0.0.1:${vncPort}`
    ], { detached: true, stdio: 'ignore' });
    await assertAlive(websockify, 'websockify');
    if (!await waitForPort(wsPort, { timeoutMs: 8000 })) {
      throw new Error(`websockify port ${wsPort} never opened.`);
    }

    if (needsAuth) {
      try {
        console.log('[VNC] Connecting via CDP to authenticate proxy credentials...');
        cdpBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null });
        await applyProxyAuth(cdpBrowser, proxyUser, proxyPass);
      } catch (err) {
        console.warn('[VNC] Failed to automate proxy credentials via CDP:', err.message);
      }
    }
  } catch (err) {
    console.error(`[VNC] Launch failed for user ${userId} on ${display}: ${err.message}`);
    await Promise.all([
      killProcAsync(websockify),
      killProcAsync(x11vnc),
      killProcAsync(chrome),
      killProcAsync(openbox),
      killProcAsync(xvfb),
    ]);
    cleanX11Locks(display);
    throw new Error(`Failed to start remote browser session: ${err.message}`);
  }

  vncSessions.set(userId, { userId, slot, xvfb, openbox, chrome, x11vnc, websockify, profilePath, profileName, cdpBrowser });

  console.log(`[VNC] Session ready for user ${userId}. noVNC available on port ${wsPort} (display ${display}).`);

  return {
    success: true,
    mode: 'vnc',
    vnc_available: true,
    ws_port: wsPort,
    missing_deps: []
  };
}

/**
 * Check if a given user has an active VNC session.
 */
export function isVncActive(userId) {
  return userId != null && vncSessions.has(userId);
}

/**
 * Get the websockify port for a user's noVNC session (null if none).
 */
export function getVncPort(userId) {
  const s = userId != null ? vncSessions.get(userId) : null;
  return s && s.slot ? s.slot.wsPort : null;
}

/**
 * Get a user's VNC session profile name.
 */
export function getVncProfileName(userId) {
  const s = userId != null ? vncSessions.get(userId) : null;
  return s ? s.profileName : null;
}

/**
 * Get a user's VNC session profile path.
 */
export function getVncProfilePath(userId) {
  const s = userId != null ? vncSessions.get(userId) : null;
  return s ? s.profilePath : null;
}

/**
 * Whether a user's active session is a local Chrome instance (Windows dev).
 */
export function isLocalChrome(userId) {
  const s = userId != null ? vncSessions.get(userId) : null;
  return s ? !!s.isLocalChrome : false;
}

/**
 * Verify channels for a user by connecting to their Chrome via CDP and scraping YouTube Studio.
 */
export async function verifyVncChannels(userId) {
  const session = userId != null ? vncSessions.get(userId) : null;
  if (!session) {
    throw new Error('No active browser session. Please launch Chrome first.');
  }
  const cdpPort = session.slot.cdpPort;

  let browser = null;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null
    });

    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('studio.youtube.com'));
    if (!page) page = pages[0];

    const url = page.url();

    if (url.includes('accounts.google.com')) {
      throw new Error('Not logged in yet. Please sign in to your Google account in the browser first.');
    }

    if (!url.includes('studio.youtube.com')) {
      await page.goto('https://studio.youtube.com?hl=en&persist_hl=1', {
        waitUntil: 'networkidle2',
        timeout: 45000
      });
      await sleep(5000);
    }

    const currentUrl = page.url();
    let ytChannelId = '';
    const cidMatch = currentUrl.match(/channel\/(UC[A-Za-z0-9_-]+)/);
    if (cidMatch) ytChannelId = cidMatch[1];

    if (!ytChannelId) {
      ytChannelId = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="channel/UC"]');
        for (const link of links) {
          const m = link.href.match(/channel\/(UC[A-Za-z0-9_-]+)/);
          if (m) return m[1];
        }
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) {
          const m = canonical.href.match(/channel\/(UC[A-Za-z0-9_-]+)/);
          if (m) return m[1];
        }
        return '';
      });
    }

    let channelName = '';

    try {
      const avatarBtn = await page.$('button#avatar-btn, img.channel-thumbnail-icon, #avatar-btn img, button[aria-label*="Account"], .ytcp-account-settings img');
      if (avatarBtn) {
        await avatarBtn.click();
        await sleep(1500);
        channelName = await page.evaluate(() => {
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
        await page.keyboard.press('Escape');
        await sleep(500);
      }
    } catch (e) {
      console.warn('[VNC Verify] Avatar click method failed:', e.message);
    }

    if (!channelName) {
      try {
        const customUrl = ytChannelId
          ? `https://studio.youtube.com/channel/${ytChannelId}/editing/details`
          : 'https://studio.youtube.com/channel/editing/details';
        await page.goto(customUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);

        channelName = await page.evaluate(() => {
          const nameInput = document.querySelector('#name-input input, #channel-name-input input, [aria-label="Channel name"] input, #textbox[aria-label*="name"]');
          if (nameInput && nameInput.value) return nameInput.value.trim();
          const nameArea = document.querySelector('#name-input #textbox, .channel-name-text');
          if (nameArea && nameArea.textContent.trim()) return nameArea.textContent.trim();
          return '';
        });

        if (ytChannelId) {
          await page.goto(`https://studio.youtube.com/channel/${ytChannelId}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
      } catch (e) {
        console.warn('[VNC Verify] Customization page method failed:', e.message);
      }
    }

    if (!channelName) {
      channelName = await page.evaluate(() => {
        const badNames = ['channel dashboard', 'channel content', 'channel analytics',
                          'your channel', 'youtube studio', 'dashboard', 'content',
                          'analytics', 'community', 'subtitles', 'settings'];
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          if (el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          if (text.length >= 2 && text.length <= 60 && !badNames.includes(text.toLowerCase())) {
            const parent = el.parentElement;
            const grandparent = parent ? parent.parentElement : null;
            const context = (parent?.textContent || '') + (grandparent?.textContent || '');
            if (context.toLowerCase().includes('your channel') && text.toLowerCase() !== 'your channel') {
              return text;
            }
          }
        }
        const bodyText = document.body.innerText || '';
        const handleMatch = bodyText.match(/@[\w][\w.-]{1,30}/);
        if (handleMatch) return handleMatch[0];
        return '';
      });
    }

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
    if (browser) {
      try { browser.disconnect(); } catch {}
    }
  }
}

/**
 * Stop a specific user's VNC session and free its slot.
 */
export async function stopVncSession(userId) {
  const session = userId != null ? vncSessions.get(userId) : null;
  if (session) {
    console.log(`[VNC] Stopping VNC session for user ${userId}...`);
    if (session.cdpBrowser) {
      try { session.cdpBrowser.disconnect(); } catch {}
    }
    // Awaitable termination: resolve only once each child has actually exited,
    // so the slot's ports/locks are truly free before any relaunch.
    await Promise.all([
      killProcAsync(session.websockify),
      killProcAsync(session.x11vnc),
      killProcAsync(session.chrome),
      killProcAsync(session.openbox),
      killProcAsync(session.xvfb),
    ]);

    // Safety net: kill any stragglers bound to THIS session's slot only,
    // including an orphaned Chrome matched by its unique remote-debugging port.
    if (process.platform !== 'win32' && session.slot) {
      const { display, vncPort, wsPort, cdpPort } = session.slot;
      execQuiet(`pkill -f "Xvfb ${display} "`);
      execQuiet(`pkill -f "x11vnc.*-rfbport ${vncPort}"`);
      execQuiet(`pkill -f "websockify.* ${wsPort} "`);
      execQuiet(`pkill -f "remote-debugging-port=${cdpPort}"`);
      cleanX11Locks(display);
    }

    vncSessions.delete(userId);
    console.log(`[VNC] Session for user ${userId} stopped.`);
  }
}

/**
 * Stop whichever user's VNC session (if any) is currently using a given profile path.
 * Used by upload/reschedule/sync so they only close a login that is using the SAME
 * profile they need — never another user's unrelated login.
 * Returns true if a session was stopped.
 */
export async function stopVncSessionForProfile(profilePath) {
  if (!profilePath) return false;
  const targetReal = (() => { try { return fs.realpathSync(profilePath); } catch { return path.resolve(profilePath); } })();
  for (const [uid, session] of vncSessions.entries()) {
    const sessReal = (() => { try { return fs.realpathSync(session.profilePath); } catch { return path.resolve(session.profilePath || ''); } })();
    if (sessReal === targetReal) {
      await stopVncSession(uid);
      return true;
    }
  }
  return false;
}
