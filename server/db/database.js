import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'pipeline.db');

let db = null;

/**
 * Initialize the SQLite database, creating the data directory and running
 * the schema migration if the database doesn't already exist.
 */
export function initDb() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enforce foreign keys
  db.pragma('foreign_keys = ON');

  // Read and execute the schema file
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Self-healing migrations for user_id column
  const tablesToMigrate = ['channels', 'videos', 'thumbnails', 'scheduled_posts', 'saved_comments', 'pipeline_runs', 'schedule_presets'];
  for (const table of tablesToMigrate) {
    try {
      const pragma = db.prepare(`PRAGMA table_info(${table})`).all();
      const hasUserId = pragma.some(col => col.name === 'user_id');
      if (!hasUserId) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER DEFAULT 1`).run();
        console.log(`[DB Migration] Added user_id column to ${table} table.`);
      }
    } catch (err) {
      console.error(`[DB Migration] Error migrating table ${table}:`, err);
    }
  }

  // Self-healing migration for video title, description, tags columns
  try {
    const pragma = db.prepare(`PRAGMA table_info(videos)`).all();
    const columnsToAdd = ['title', 'description', 'tags'];
    for (const col of columnsToAdd) {
      const hasColumn = pragma.some(c => c.name === col);
      if (!hasColumn) {
        db.prepare(`ALTER TABLE videos ADD COLUMN ${col} TEXT`).run();
        console.log(`[DB Migration] Added ${col} column to videos table.`);
      }
    }
    
    const hasThumbnailId = pragma.some(c => c.name === 'thumbnail_id');
    if (!hasThumbnailId) {
      db.prepare(`ALTER TABLE videos ADD COLUMN thumbnail_id INTEGER REFERENCES thumbnails(id) ON DELETE SET NULL`).run();
      console.log(`[DB Migration] Added thumbnail_id column to videos table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding columns to videos:`, err);
  }

  // Self-healing migration for youtube_video_id column in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    const hasYoutubeVideoId = pragma.some(col => col.name === 'youtube_video_id');
    if (!hasYoutubeVideoId) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN youtube_video_id TEXT`).run();
      console.log(`[DB Migration] Added youtube_video_id column to scheduled_posts table.`);
      
      // Run backfill migration to link existing uploads to scheduled_posts if matching by channel_id and title
      const backfillResult = db.prepare(`
        UPDATE scheduled_posts
        SET youtube_video_id = (
          SELECT youtube_video_id
          FROM uploads
          WHERE uploads.channel_id = scheduled_posts.channel_id
            AND uploads.title = scheduled_posts.title
            AND uploads.status = 'complete'
          LIMIT 1
        )
        WHERE youtube_video_id IS NULL AND status = 'complete'
      `).run();
      console.log(`[DB Migration] Backfilled youtube_video_id for ${backfillResult.changes} completed scheduled posts.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding youtube_video_id column:`, err);
  }

  // Self-healing migration for upload_mode column in channels
  try {
    const pragma = db.prepare(`PRAGMA table_info(channels)`).all();
    const hasUploadMode = pragma.some(col => col.name === 'upload_mode');
    if (!hasUploadMode) {
      db.prepare(`ALTER TABLE channels ADD COLUMN upload_mode TEXT DEFAULT 'api' CHECK(upload_mode IN ('api', 'browser'))`).run();
      console.log(`[DB Migration] Added upload_mode column to channels table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding upload_mode column:`, err);
  }

  // Self-healing migration for schedule_as_premiere column in channels
  try {
    const pragma = db.prepare(`PRAGMA table_info(channels)`).all();
    const hasCol = pragma.some(col => col.name === 'schedule_as_premiere');
    if (!hasCol) {
      db.prepare(`ALTER TABLE channels ADD COLUMN schedule_as_premiere INTEGER DEFAULT 0`).run();
      console.log(`[DB Migration] Added schedule_as_premiere column to channels table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding schedule_as_premiere column:`, err);
  }

  // Self-healing migration for proxy configuration columns in channels
  try {
    const pragma = db.prepare('PRAGMA table_info(channels)').all();
    const cols = {
      proxy_type: "TEXT DEFAULT 'none' CHECK(proxy_type IN ('none', 'http', 'socks5'))",
      proxy_host: "TEXT DEFAULT ''",
      proxy_port: "INTEGER DEFAULT 0",
      proxy_username: "TEXT DEFAULT ''",
      proxy_password: "TEXT DEFAULT ''"
    };
    for (const [col, def] of Object.entries(cols)) {
      if (!pragma.some(c => c.name === col)) {
        db.prepare(`ALTER TABLE channels ADD COLUMN ${col} ${def}`).run();
        console.log(`[DB Migration] Added ${col} column to channels table.`);
      }
    }
  } catch (err) {
    console.error('[DB Migration] Error adding proxy columns to channels:', err);
  }

  // Self-healing migration for profile_name column in channels
  try {
    const pragma = db.prepare('PRAGMA table_info(channels)').all();
    if (!pragma.some(c => c.name === 'profile_name')) {
      db.prepare(`ALTER TABLE channels ADD COLUMN profile_name TEXT DEFAULT NULL`).run();
      console.log('[DB Migration] Added profile_name column to channels table.');
    }
  } catch (err) {
    console.error('[DB Migration] Error adding profile_name column to channels:', err);
  }

  // Self-healing migration for is_premiere column in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    const hasCol = pragma.some(col => col.name === 'is_premiere');
    if (!hasCol) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN is_premiere INTEGER DEFAULT 0`).run();
      console.log(`[DB Migration] Added is_premiere column to scheduled_posts table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding is_premiere column:`, err);
  }

  // Self-healing migration for retry columns in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    const hasRetryCount = pragma.some(col => col.name === 'retry_count');
    if (!hasRetryCount) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN retry_count INTEGER DEFAULT 0`).run();
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN next_retry_at TEXT DEFAULT NULL`).run();
      console.log(`[DB Migration] Added retry_count and next_retry_at columns to scheduled_posts table.`);
    }
    const hasErrorMessage = pragma.some(col => col.name === 'error_message');
    if (!hasErrorMessage) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN error_message TEXT DEFAULT NULL`).run();
      console.log(`[DB Migration] Added error_message column to scheduled_posts table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding retry columns to scheduled_posts:`, err);
  }

  // Self-healing migration for privacy column in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    const hasPrivacy = pragma.some(col => col.name === 'privacy');
    if (!hasPrivacy) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN privacy TEXT DEFAULT NULL`).run();
      console.log(`[DB Migration] Added privacy column to scheduled_posts table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding privacy column:`, err);
  }

  // Self-healing migration for comment_status column in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    const hasCommentStatus = pragma.some(col => col.name === 'comment_status');
    if (!hasCommentStatus) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN comment_status TEXT DEFAULT 'none'`).run();
      console.log(`[DB Migration] Added comment_status column to scheduled_posts table.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding comment_status column:`, err);
  }

  // Self-healing migration for comment retry columns in scheduled_posts
  try {
    const pragma = db.prepare(`PRAGMA table_info(scheduled_posts)`).all();
    if (!pragma.some(col => col.name === 'comment_retry_count')) {
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN comment_retry_count INTEGER DEFAULT 0`).run();
      db.prepare(`ALTER TABLE scheduled_posts ADD COLUMN comment_next_retry_at TEXT DEFAULT NULL`).run();
      console.log(`[DB Migration] Added comment_retry_count and comment_next_retry_at columns to scheduled_posts.`);
    }
  } catch (err) {
    console.error(`[DB Migration] Error adding comment retry columns:`, err);
  }

  // Self-healing migration for pipeline_runs constraints
  try {
    const schemaInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_runs'").get();
    if (schemaInfo && !schemaInfo.sql.includes('preparing')) {
      console.log('[DB Migration] Migrating pipeline_runs table for status check constraints...');
      db.exec(`
        PRAGMA foreign_keys=OFF;
        CREATE TABLE IF NOT EXISTS pipeline_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'preparing', 'uploading', 'commenting', 'complete', 'error', 'cancelled')),
            summary TEXT DEFAULT '',
            started_at TEXT,
            completed_at TEXT,
            log TEXT DEFAULT '',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO pipeline_runs_new (id, user_id, status, summary, started_at, completed_at, log)
        SELECT id, user_id, 
               CASE WHEN status NOT IN ('idle', 'preparing', 'uploading', 'commenting', 'complete', 'error', 'cancelled') THEN 'error' ELSE status END,
               summary, started_at, completed_at, log 
         FROM pipeline_runs;
        DROP TABLE pipeline_runs;
        ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
        PRAGMA foreign_keys=ON;
      `);
      console.log('[DB Migration] pipeline_runs table migrated successfully.');
    }
  } catch (err) {
    console.error('[DB Migration] Error migrating pipeline_runs schema:', err);
  }

  // Self-healing migration for weekly_cleanup_published setting default seed
  try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_cleanup_published', 'false')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('nordvpn_username', '')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('nordvpn_password', '')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('protonvpn_username', '')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('protonvpn_password', '')").run();
  } catch (err) {
    console.error('[DB Migration] Error seeding weekly_cleanup_published setting:', err);
  }

  // Self-healing migration for proxy_pool_id column in channels
  try {
    const pragma = db.prepare('PRAGMA table_info(channels)').all();
    if (!pragma.some(c => c.name === 'proxy_pool_id')) {
      db.prepare(`ALTER TABLE channels ADD COLUMN proxy_pool_id INTEGER DEFAULT NULL`).run();
      console.log('[DB Migration] Added proxy_pool_id column to channels table.');
    }
  } catch (err) {
    console.error('[DB Migration] Error adding proxy_pool_id column to channels:', err);
  }

  // Self-healing migration for custom_logo_path and custom_banner_path columns in channels
  try {
    const pragma = db.prepare('PRAGMA table_info(channels)').all();
    if (!pragma.some(c => c.name === 'custom_logo_path')) {
      db.prepare(`ALTER TABLE channels ADD COLUMN custom_logo_path TEXT DEFAULT NULL`).run();
      console.log('[DB Migration] Added custom_logo_path column to channels table.');
    }
    if (!pragma.some(c => c.name === 'custom_banner_path')) {
      db.prepare(`ALTER TABLE channels ADD COLUMN custom_banner_path TEXT DEFAULT NULL`).run();
      console.log('[DB Migration] Added custom_banner_path column to channels table.');
    }
  } catch (err) {
    console.error('[DB Migration] Error adding branding columns to channels:', err);
  }

  // Seed webshare_api_key setting
  try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('webshare_api_key', 'grts0ygdwgzh971s0iblqmssqogisrc04adyjm4d')").run();
    db.prepare("UPDATE settings SET value = 'grts0ygdwgzh971s0iblqmssqogisrc04adyjm4d' WHERE key = 'webshare_api_key' AND (value IS NULL OR value = '')").run();
  } catch (err) {
    console.error('[DB Migration] Error seeding webshare_api_key:', err);
  }

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

/**
 * Return the active database instance. Throws if initDb() has not been called.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a SELECT that returns all matching rows. */
export function queryAll(sql, params = {}) {
  return getDb().prepare(sql).all(params);
}

/** Run a SELECT that returns a single row (or undefined). */
export function queryOne(sql, params = {}) {
  return getDb().prepare(sql).get(params);
}

/** Run an INSERT / UPDATE / DELETE and return the `changes` info object. */
export function run(sql, params = {}) {
  return getDb().prepare(sql).run(params);
}

/** Convenience: insert a row and return lastInsertRowid. */
export function insert(sql, params = {}) {
  const info = getDb().prepare(sql).run(params);
  return info.lastInsertRowid;
}

export default { initDb, getDb, queryAll, queryOne, run, insert };
