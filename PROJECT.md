# YouTube Pipeline Dashboard — Project Reference

## Stack
- **Backend:** Node.js + Express, SQLite (better-sqlite3), WebSocket
- **Frontend:** Vanilla HTML/CSS/JS SPA (dark glassmorphism theme)
- **Auth:** express-session, SHA-256 password hashing, license key + email + password login

## File Map

### Server
| File | Purpose |
|------|---------|
| `server/index.js` | Express app, session middleware, auth gating, WS setup, route registration |
| `server/db/schema.sql` | Full SQLite schema (users, channels, videos, thumbnails, scheduled_posts, etc.) |
| `server/db/database.js` | DB init, self-healing migrations, query helpers (queryAll, queryOne, run, insert) |
| `server/routes/client.js` | Auth endpoints: login, logout, /me, user CRUD (admin only) |
| `server/routes/auth.js` | Google OAuth 2.0 flow |
| `server/routes/channels.js` | Channel CRUD, titles, thumbnails per channel |
| `server/routes/media.js` | Video/thumbnail upload and management |
| `server/routes/schedule.js` | Scheduled posts CRUD |
| `server/routes/settings.js` | User settings (Gemini API key, defaults) |
| `server/routes/ai.js` | Gemini AI title/description generation |
| `server/routes/comments.js` | Saved comment templates |
| `server/routes/pipeline.js` | Pipeline orchestration (start/stop/status) |
| `server/services/youtube.js` | YouTube Data API v3 wrapper |
| `server/services/gemini.js` | Gemini API service (user-scoped API keys) |
| `server/services/scheduler.js` | Cron-based auto-publisher |
| `server/services/pipeline.js` | Pipeline state machine (user-scoped) |

### Frontend
| File | Purpose |
|------|---------|
| `public/index.html` | Main SPA — 6 tabs: Dashboard, Channels, Media, Schedule, Logs, Settings + hidden Users tab (admin) |
| `public/app.js` | All frontend logic — state, API calls, rendering, auth, user management |
| `public/index.css` | Full design system (dark theme, glassmorphism, animations) |
| `public/login.html` | Standalone login page with license key, email, password fields |

## Auth Architecture
- **Session:** `req.session.userId`, `req.session.userRole`, `req.session.email`
- **Middleware:** Global auth gate in `index.js` redirects unauthenticated users to `/login.html`
- **Data isolation:** Every route reads `req.session.userId` and scopes all SQL to that user
- **Admin user:** Seeded in schema.sql (pilsnereditor@gmail.com, admin role)
- **Users tab:** Only visible to admin role users

## Key Patterns
- All SQL queries use named params: `@paramName`
- Services use in-memory maps keyed by userId for concurrent isolation
- WebSocket broadcasts pipeline/scheduler events to all connected clients
- Frontend uses a global `state` object for all UI data

## Current Status
All 8 phases complete. Fully functional multi-user SaaS panel.
