import express from 'express';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import sqlite3Store from 'connect-sqlite3';
import { fileURLToPath } from 'url';
import { initDb, queryOne } from './db/database.js';
import { init as initScheduler } from './services/scheduler.js';
import { sendPuppetClick, sendPuppetType, sendPuppetKey, resetPuppetSessionUrl } from './services/puppet.js';
import { getVncPort } from './services/vnc.js';

// Load routes
import authRouter from './routes/auth.js';
import channelsRouter, { setBroadcast as setChannelsBroadcast } from './routes/channels.js';
import mediaRouter, { setBroadcast as setMediaBroadcast } from './routes/media.js';
import scheduleRouter, { setScheduleBroadcast } from './routes/schedule.js';
import settingsRouter from './routes/settings.js';
import aiRouter from './routes/ai.js';
import commentsRouter from './routes/comments.js';
import schedulePresetsRouter from './routes/schedulePresets.js';
import proxyPoolRouter from './routes/proxyPool.js';
import { createPipelineRouter } from './routes/pipeline.js';

// Resolve directory names
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// ──────────────────────────────────────────────────────────────────────────────
// Global crash guards — prevent Puppeteer/Chrome/proxy failures from killing
// the entire server process. These are especially important when Chrome fails
// to connect via SOCKS5 proxy or disconnects unexpectedly.
// ──────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (server will continue):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection (server will continue):', reason?.message || reason);
});

// Init database
initDb();


const app = express();
// Behind nginx in production: trust the first proxy so HTTPS detection and secure
// cookies work correctly (relies on nginx forwarding X-Forwarded-Proto / Host).
app.set('trust proxy', 1);
const server = http.createServer(app);
server.timeout = 3600000;
server.headersTimeout = 3600000;
server.requestTimeout = 3600000;
server.keepAliveTimeout = 3600000;
const wss = new WebSocketServer({ noServer: true });

// Setup middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup sessions database store
const SQLiteStore = sqlite3Store(session);
const sessionStore = new SQLiteStore({
  db: 'sessions.db',
  dir: path.join(__dirname, '..', 'data'),
  table: 'sessions'
});

// Resolve a strong session secret. Use SESSION_SECRET if provided; otherwise generate
// one and persist it to data/.session_secret so sessions survive restarts. Never fall
// back to a guessable hardcoded string (which would let an attacker forge logins).
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(__dirname, '..', 'data', '.session_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('[Server] No SESSION_SECRET set — generated and persisted a random secret to data/.session_secret');
    return generated;
  } catch (e) {
    console.error('[Server] Could not persist session secret; using an ephemeral one:', e.message);
    return crypto.randomBytes(48).toString('hex');
  }
}

const sessionMiddleware = session({
  store: sessionStore,
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',   // mark cookie Secure automatically when served over HTTPS (via nginx)
    httpOnly: true,   // not readable by client-side JS (mitigates XSS session theft)
    sameSite: 'lax',  // CSRF mitigation
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
});

app.use(sessionMiddleware);

// Import client router
import clientRouter from './routes/client.js';

// Serve noVNC static files (before auth — the iframe is already behind auth)
const novncDir = '/usr/share/novnc';
try {
  if (fs.existsSync(novncDir)) {
    app.use('/novnc', express.static(novncDir));
    console.log('[Server] Serving noVNC from', novncDir);
  }
} catch (e) {
  console.warn('[Server] noVNC directory not found:', novncDir);
}

// Authentication middleware
app.use((req, res, next) => {
  // Local auto-login is DISABLED by default. It only activates if the operator
  // explicitly sets ALLOW_LOCAL_ADMIN=true (for local development). This prevents a
  // request carrying "Host: localhost" from silently gaining admin access in production.
  if (process.env.ALLOW_LOCAL_ADMIN === 'true') {
    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (isLocal && req.session && !req.session.userId) {
      req.session.userId = 1;
      req.session.userRole = 'admin';
      req.session.email = 'pilsnereditor@gmail.com';
      console.log('[Auth] Auto-authenticated localhost request as admin (ALLOW_LOCAL_ADMIN dev mode).');
    }
  }

  const publicPaths = ['/login.html', '/index.css', '/favicon.ico'];
  const publicApis = ['/api/client/login', '/api/client/me'];

  if (publicPaths.includes(req.path) || publicApis.includes(req.path)) {
    return next();
  }

  if (req.session && req.session.userId) {
    if (req.path === '/login.html') {
      return res.redirect('/');
    }
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  res.redirect('/login.html');
});

// Serve static frontend files
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// WebSocket clients set
const clients = new Set();

wss.on('connection', (ws, request) => {
  const userId = request.session.userId;
  ws.userId = userId;
  clients.add(ws);
  console.log(`[WS] Client connected for user ${userId}`);
  ws.send(JSON.stringify({ type: 'info', message: 'Connected to pipeline server WebSocket' }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Safety check: ensure target channel belongs to this user!
      if (data.type && data.type.startsWith('puppet:')) {
        // Per-channel puppet session
        const channelId = Number(data.channelId);
        if (!channelId) return;
        
        const channel = queryOne('SELECT id FROM channels WHERE id = @id AND user_id = @userId', { id: channelId, userId });
        if (!channel) {
          console.warn(`[WS] Blocked unauthorized remote puppet interaction for channel ${channelId} by user ${userId}`);
          return;
        }

        if (data.type === 'puppet:click') {
          await sendPuppetClick(channelId, userId, data.x, data.y);
        } else if (data.type === 'puppet:type') {
          await sendPuppetType(channelId, userId, data.text);
        } else if (data.type === 'puppet:key') {
          await sendPuppetKey(channelId, userId, data.key, data.modifiers || {});
        } else if (data.type === 'puppet:url_reset') {
          await resetPuppetSessionUrl(channelId);
        }
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected for user ${userId}`);
  });
});

// Upgrade HTTP connection to WS
server.on('upgrade', (request, socket, head) => {
  // Proxy /websockify to the local websockify (VNC) server
  if (request.url && request.url.startsWith('/websockify')) {
    // Resolve the requesting user and route them ONLY to their own VNC slot's
    // websockify port, so a user can never reach another user's login screen.
    const proxyRes = {
      getHeader: () => {}, setHeader: () => {}, writeHead: () => {}, end: () => {}
    };
    sessionMiddleware(request, proxyRes, () => {
      const userId = request.session && request.session.userId;
      if (!userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const wsPort = getVncPort(userId);
      if (!wsPort) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }
      const target = net.createConnection({ host: '127.0.0.1', port: wsPort }, () => {
        // Reconstruct the HTTP upgrade request and forward to this user's websockify
        let httpReq = `GET ${request.url} HTTP/${request.httpVersion}\r\n`;
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          httpReq += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
        }
        httpReq += '\r\n';
        target.write(httpReq);
        if (head && head.length > 0) target.write(head);
        socket.pipe(target).pipe(socket);
      });
      target.on('error', (err) => {
        console.error('[VNC Proxy] Error:', err.message);
        socket.destroy();
      });
      socket.on('error', () => target.destroy());
    });
    return;
  }

  // Normal WebSocket upgrade (app WS)
  const res = { 
    getHeader: () => {},
    setHeader: () => {},
    writeHead: () => {},
    end: () => {}
  };
  sessionMiddleware(request, res, () => {
    if (!request.session || !request.session.userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
});

// Broadcast helper function
function broadcast(data, targetUserId) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      if (targetUserId !== undefined && targetUserId !== null && Number(client.userId) !== Number(targetUserId)) {
        continue;
      }
      client.send(payload);
    }
  }
}

// Inject broadcast function to route and service initializers
initScheduler(broadcast);
setMediaBroadcast(broadcast);
setChannelsBroadcast(broadcast);
setScheduleBroadcast(broadcast);
const pipelineRouter = createPipelineRouter(broadcast);

// Register routes
app.use('/api/client', clientRouter);
app.use('/api/auth', authRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/schedule-presets', schedulePresetsRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/proxy-pool', proxyPoolRouter);

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
});
