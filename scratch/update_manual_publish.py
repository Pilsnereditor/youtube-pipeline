import sqlite3
import datetime

db_path = "/var/www/youtube-pipeline/data/pipeline.db"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Find the video matching the title
cursor.execute("""
    SELECT id, user_id, channel_id, title, description, tags, thumbnail_id 
    FROM videos 
    WHERE title LIKE '%HACKSAW YENİ SLOT OYUNU%' 
    ORDER BY id DESC LIMIT 1
""")
video = cursor.fetchone()

if not video:
    print("Error: Could not find the video in the database.")
    exit(1)

video_id, user_id, channel_id, title, description, tags, thumbnail_id = video
youtube_video_id = "rnjSwtKSW9A"
now = datetime.datetime.now().isoformat()

# Insert completed scheduled post to link the video and mark it published
cursor.execute("""
    INSERT INTO scheduled_posts (
        user_id, channel_id, youtube_video_id, title, description, tags, 
        thumbnail_id, video_id, scheduled_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')
""", (user_id, channel_id, youtube_video_id, title, description, tags, thumbnail_id, video_id, now))

# Insert/update uploads table for complete tracking
cursor.execute("""
    INSERT OR REPLACE INTO uploads (
        channel_id, youtube_video_id, title, description, status, uploaded_at
    ) VALUES (?, ?, ?, ?, 'complete', ?)
""", (channel_id, youtube_video_id, title, description, now))

conn.commit()
print(f"Success! Linked video ID {video_id} ('{title}') to YouTube ID {youtube_video_id} and marked complete.")
