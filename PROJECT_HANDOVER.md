# YouTube Pipeline: Complete Project Handover & Context Guide

This document is a comprehensive context guide designed to bring any AI assistant (like Claude) fully up to speed on the **youtube-pipeline** project. It details the architecture, database schema, key fixes, VPS environments, and workflow patterns.

---

## 1. Project Overview & Tech Stack
* **Repository**: `https://github.com/Pilsnereditor/youtube-pipeline.git`
* **Local Workspace**: `c:\Users\nesim\.gemini\antigravity\scratch\youtube-pipeline`
* **VPS Environment**: `95.111.250.107` (`gageditor.com`), deployed at `/var/www/youtube-pipeline`
* **Process Manager**: PM2 (`pm2 restart youtube-pipeline`, `pm2 logs`)
* **Core Technologies**:
  * **Backend**: Node.js, Express, ES Modules.
  * **Database**: SQLite via `better-sqlite3` (located at `data/pipeline.db`).
  * **Browser Automation**: Puppeteer (`puppeteer-core`) targeting a system Chrome instance.
  * **Frontend**: Vanilla HTML5, CSS (glassmorphism/dark mode), and Vanilla JavaScript (`public/app.js`).

---

## 2. Key Directories & Core Files
* `server/services/puppet.js`: Puppeteer automation wrapper for YouTube Studio interactions (uploads, rescheduling, posting comments, profile customization, syncs).
* `server/services/scheduler.js`: Orchestrates the cron-based job processing for uploading/scheduling videos, handling fail-safe retries, and synchronizing channel videos.
* `server/services/pipeline.js`: Sequenced execution flow coordinates (reads status, locks the channel, uploads, schedules, comments).
* `server/db/database.js`: SQLite connection initialization, table setup, migration rules, and helper queries.
* `public/app.js` & `public/index.html`: GagEditor dashboard user interface.

---

## 3. Database Schema Reference
```sql
-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    license_key TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Proxy Pool
CREATE TABLE IF NOT EXISTS proxy_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    label TEXT DEFAULT '',
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT DEFAULT '',
    password TEXT DEFAULT '',
    protocol TEXT DEFAULT 'http' CHECK(protocol IN ('http', 'https', 'socks5')),
    country_code TEXT DEFAULT '',
    city TEXT DEFAULT '',
    provider TEXT DEFAULT 'manual',
    external_id TEXT DEFAULT '',
    last_tested_at TEXT,
    last_latency_ms INTEGER,
    is_healthy INTEGER DEFAULT 1,
    max_channels INTEGER DEFAULT 3,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Channels Table
CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    youtube_channel_id TEXT,
    name TEXT NOT NULL,
    niche TEXT DEFAULT '',
    description TEXT DEFAULT '',
    schedule_time TEXT DEFAULT '10:00',
    schedule_days TEXT DEFAULT 'mon,wed,fri',
    upload_privacy TEXT DEFAULT 'private' CHECK(upload_privacy IN ('private', 'unlisted', 'public')),
    category TEXT DEFAULT '22',
    comment_template TEXT DEFAULT '',
    upload_mode TEXT DEFAULT 'api' CHECK(upload_mode IN ('api', 'browser')),
    schedule_as_premiere INTEGER DEFAULT 0,
    proxy_type TEXT DEFAULT 'none' CHECK(proxy_type IN ('none', 'http', 'socks5')),
    proxy_host TEXT DEFAULT '',
    proxy_port INTEGER DEFAULT 0,
    proxy_username TEXT DEFAULT '',
    proxy_password TEXT DEFAULT '',
    profile_name TEXT DEFAULT NULL,
    proxy_pool_id INTEGER DEFAULT NULL,
    custom_logo_path TEXT DEFAULT NULL,
    custom_banner_path TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Scheduled Posts Table
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    channel_id INTEGER NOT NULL,
    youtube_video_id TEXT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    thumbnail_id INTEGER,
    video_id INTEGER,
    video_path TEXT,
    scheduled_at TEXT NOT NULL,
    custom_comment TEXT DEFAULT '',
    is_premiere INTEGER DEFAULT 0,
    privacy TEXT DEFAULT NULL,
    comment_status TEXT DEFAULT 'none',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'complete', 'error', 'cancelled')),
    retry_count INTEGER DEFAULT 0,
    next_retry_at TEXT DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (thumbnail_id) REFERENCES thumbnails(id) ON DELETE SET NULL,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
);
```

---

## 4. Key Fixes & Critical Mechanics Developed

### A. Date/Time Rescheduling Fixes (Locale-Aware & Self-Adaptive)
* **The Problem**: YouTube Studio formats dates/times based on the account's language settings (Turkish vs. English). If English formats (`Jun 12, 2026` / `7:30 PM`) are typed into a Turkish interface, the input fails validation, defaulting the schedule to a fallback date (often June 12, 2026 at 12:00 AM).
* **The Solution**: 
  1. `detectPageLanguage(page)` recursively pierces the Shadow Roots of YouTube Studio to detect if the workspace is rendering in Turkish or English.
  2. `formatDateLikeInitial(initialValue, targetDateIso)` and `formatTimeLikeInitial(initialValue, targetDateIso)` read the current input value mask in the field (e.g. `12 Haz 2026`, `12.06.2026`, `2026-06-12`, `19:30`, `07:30 PM`) and format the target schedule to match this EXACT separator, padding, and month name.
  3. **Keystroke Clearing**: Polymer inputs ignore programmatic clear bindings (`value = ''`). The script uses native keystrokes (`Control+A` + `Backspace` + fallback single backspaces) to trigger UI state changes.
  4. **Verification Screenshots**: Visual captures are taken right before click confirmations and saved to `/data/profiles/channel_<id>/puppet_reschedule_debug.png` and `/data/profiles/channel_<id>/puppet_upload_debug.png`.

### B. Stuck Uploads & Premature Browser Termination
* **The Problem**: Puppeteer uploads were terminating at 20-30% because the browser closed prematurely. This was caused by the exit condition matcher detecting a `"Close"` string in the share-dialog before the file actually uploaded.
* **The Solution**: Moved the upload completion loops to run *before* clicking the final "Done/Save" button. Polling now checks for `"Upload complete"`, `"Processing"`, or `"Checks"` directly inside the active `ytcp-uploads-dialog` element.

### C. Channel-Level Media Isolation
* **The Problem**: Selecting an empty channel option in the Media Library displayed videos from other channels.
* **The Solution**: Form elements now block video list requests when the channel ID is empty and clear grid states automatically.

### D. Duplicate Auto-Comment Fix
* **The Problem**: When updating schedules, line endings (`\r\n` vs `\n`) caused comparisons to flag comments as modified, generating duplicate comment submissions.
* **The Solution**: A comment normalization utility strips carriage returns (`\r`) and white-spaces before evaluating if comments changed.

### E. Database Self-Healing on Crash
* **The Problem**: A crashed server left active uploads in a perpetual `'processing'` state.
* **The Solution**: On startup, `initDb()` resets all stuck `'processing'` runs to `'error'` and releases the channel concurrency locks.

---

## 5. Deployment Commands (For User & Claude reference)
To deploy changes on the VPS:
```bash
cd /var/www/youtube-pipeline
git pull origin main
pm2 restart youtube-pipeline
```

To run formatting test suite locally:
```bash
node scratch/test_locale_datetime.js
```

To verify database columns:
```bash
node scratch/verify_all.js
```
