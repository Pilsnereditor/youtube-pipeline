import express from 'express';
import http from 'http';
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

// Load routes
import authRouter from './routes/auth.js';
import channelsRouter, { setBroadcast as setChannelsBroadcast } from './routes/channels.js';
import mediaRouter, { setBroadcast as setMediaBroadcast } from './routes/media.js';
import scheduleRouter from './routes/schedule.js';
import settingsRouter from './routes/settings.js';
import aiRouter from './routes/ai.js';
import commentsRouter from './routes/comments.js';
import schedulePresetsRouter from './routes/schedulePresets.js';
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
const server = http.createServer(app);
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

const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'youtube-pipeline-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
});

app.use(sessionMiddleware);

// Import client router
import clientRouter from './routes/client.js';

// Authentication middleware
app.use((req, res, next) => {
  // Bypass authentication and auto-login if running locally
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (isLocal && req.session && !req.session.userId) {
    req.session.userId = 1;
    req.session.userRole = 'admin';
    req.session.email = 'pilsnereditor@gmail.com';
    console.log('[Auth] Auto-authenticated localhost request as admin.');
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

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
});
