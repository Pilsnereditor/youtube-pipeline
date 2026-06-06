-- YouTube Pipeline Dashboard Schema

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    license_key TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT DEFAULT '',
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    youtube_channel_id TEXT,
    name TEXT NOT NULL,
    niche TEXT DEFAULT '',
    description TEXT DEFAULT '',
    schedule_time TEXT DEFAULT '10:00',
    schedule_days TEXT DEFAULT 'mon,wed,fri',
    upload_privacy TEXT DEFAULT 'private' CHECK(upload_privacy IN ('public', 'private', 'unlisted')),
    category TEXT DEFAULT '22',
    comment_template TEXT DEFAULT '',
    upload_mode TEXT DEFAULT 'api' CHECK(upload_mode IN ('api', 'browser')),
    schedule_as_premiere INTEGER DEFAULT 0,
    proxy_type TEXT DEFAULT 'none' CHECK(proxy_type IN ('none', 'http', 'socks5')),
    proxy_host TEXT DEFAULT '',
    proxy_port INTEGER DEFAULT 0,
    proxy_username TEXT DEFAULT '',
    proxy_password TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date INTEGER,
    scope TEXT DEFAULT '',
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    channel_id INTEGER,
    original_filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filesize INTEGER DEFAULT 0,
    mimetype TEXT DEFAULT '',
    duration REAL,
    title TEXT,
    description TEXT,
    tags TEXT,
    thumbnail_id INTEGER REFERENCES thumbnails(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thumbnails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    channel_id INTEGER,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    youtube_video_id TEXT,
    title TEXT,
    description TEXT,
    thumbnail_path TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'uploading', 'processing', 'complete', 'error')),
    scheduled_at TEXT,
    uploaded_at TEXT,
    error_message TEXT,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'preparing', 'uploading', 'commenting', 'complete', 'error', 'cancelled')),
    summary TEXT DEFAULT '',
    started_at TEXT,
    completed_at TEXT,
    log TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 1,
    name TEXT NOT NULL,
    time TEXT NOT NULL,
    days TEXT DEFAULT 'everyday',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);

-- Seed default settings if not present
INSERT OR IGNORE INTO settings (key, value) VALUES ('gemini_api_key', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_privacy', 'private');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_category', '22');
INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_cleanup_published', 'false');

-- Seed default distributor/admin user
-- Password: GagEditor_Secure545! -> SHA-256 hash: f6376f5dbef97649870f129c11c576b26d8d51a93bfeb0669dedf007dcfd494e
INSERT OR IGNORE INTO users (id, email, password_hash, license_key, role)
VALUES (1, 'pilsnereditor@gmail.com', 'f6376f5dbef97649870f129c11c576b26d8d51a93bfeb0669dedf007dcfd494e', '9fdc4711-a840-42ee-9526-f809318ae803', 'admin');
