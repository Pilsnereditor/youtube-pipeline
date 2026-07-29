#!/bin/bash
# gageditor diagnostic bundle — READ-ONLY. Run on the VPS, then paste the output to Claude.
# It changes nothing; it only reads logs, the database, and lists screenshots.
#
# Usage:
#   cd /var/www/youtube-pipeline && bash diagnose.sh
# Then copy everything it prints (and, if it lists a puppet_*_error.png, send that image too).

APP=/var/www/youtube-pipeline
DB="$APP/data/pipeline.db"
OUT=/tmp/gageditor_diag_$(date +%Y%m%d_%H%M%S).txt

{
echo "############ GAGEDITOR DIAGNOSTIC — $(date) ############"

echo; echo "===== 1. SYSTEM RESOURCES (full disk / low RAM crash Chrome) ====="
uptime
echo "-- disk --";   df -h "$APP" /tmp 2>/dev/null
echo "-- memory --"; free -m
echo "-- browser stack process count --"
ps aux | grep -E 'chrome|Xvfb|x11vnc|websockify' | grep -v grep | wc -l
ps aux | grep -E 'Xvfb|x11vnc|websockify' | grep -v grep | awk '{print $2, $11, $12, $13, $14}'

echo; echo "===== 2. KEY LOG EVENTS (last 300 lines, filtered) ====="
pm2 logs youtube-pipeline --lines 300 --nostream 2>/dev/null \
  | grep -Ei 'Puppet|\[Sync\]|\[VNC\]|Scheduler\] (Processing|Uploaded|deferred|complete|failed)|Extracted YouTube Video ID|already running|detached|target closed|visibility editor|proxy|error' \
  | tail -140

echo; echo "===== 3. ERROR / DEBUG SCREENSHOTS (newest first — SEND THE TOP ONE) ====="
ls -lt "$APP"/data/profiles/*/puppet_*error*.png "$APP"/data/profiles/*/puppet_*debug*.png 2>/dev/null | head -12
echo "(these PNGs are the exact YouTube page at the moment of failure — the single most useful artifact)"

echo; echo "===== 4. STUCK / RECENT POSTS (database) ====="
node -e '
try {
  const Database = require("'"$APP"'/node_modules/better-sqlite3");
  const db = new Database("'"$DB"'", { readonly: true });
  const rows = db.prepare(`
    SELECT sp.id, sp.status, sp.youtube_video_id AS ytid, sp.is_premiere AS prem,
           sp.retry_count AS rc, sp.comment_status AS comment_st,
           substr(COALESCE(sp.error_message,""),1,55) AS error_msg,
           c.name AS channel, c.upload_mode AS mode
    FROM scheduled_posts sp JOIN channels c ON c.id = sp.channel_id
    WHERE sp.status IN (\"pending\",\"processing\",\"error\")
       OR sp.created_at >= datetime(\"now\",\"-1 day\")
    ORDER BY sp.id DESC LIMIT 25`).all();
  console.table(rows);
} catch (e) { console.log("DB read failed:", e.message); }
'

echo; echo "===== 5. CHANNELS: upload mode + proxy (the User1 vs User2 difference) ====="
node -e '
try {
  const Database = require("'"$APP"'/node_modules/better-sqlite3");
  const db = new Database("'"$DB"'", { readonly: true });
  const rows = db.prepare(`
    SELECT c.id, c.user_id AS uid, c.name, c.upload_mode AS mode,
           CASE WHEN EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.channel_id=c.id) THEN "yes" ELSE "no" END AS has_api_token,
           c.proxy_pool_id AS proxy_id, p.host AS proxy_host,
           p.is_healthy AS healthy, p.last_latency_ms AS latency_ms
    FROM channels c LEFT JOIN proxy_pool p ON p.id = c.proxy_pool_id
    ORDER BY c.user_id, c.id`).all();
  console.table(rows);
} catch (e) { console.log("DB read failed:", e.message); }
'

echo; echo "############ END — paste everything above to Claude ############"
} | tee "$OUT"

echo
echo ">>> Also saved to: $OUT"
