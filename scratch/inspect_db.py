import sqlite3
import json

db_path = "/var/www/youtube-pipeline/data/pipeline.db"
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

# Get all scheduled posts for channel 4 (Senpai)
cursor.execute("""
    SELECT sp.id, sp.title, sp.scheduled_at, sp.status, sp.youtube_video_id, sp.is_premiere
    FROM scheduled_posts sp
    WHERE sp.channel_id = 4
    ORDER BY sp.scheduled_at ASC
""")
rows = [dict(r) for r in cursor.fetchall()]

print("--- SENPAI SCHEDULED POSTS ---")
print(json.dumps(rows, indent=2))
