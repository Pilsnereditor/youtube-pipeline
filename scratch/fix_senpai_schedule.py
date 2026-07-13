import sqlite3

db_path = "/var/www/youtube-pipeline/data/pipeline.db"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# 1. Delete the duplicate scheduled post (id: 32)
cursor.execute("DELETE FROM scheduled_posts WHERE id = 32")
print("Deleted duplicate scheduled post (ID: 32).")

# 2. Update the scheduled_at date for post 30 to match the actual YouTube Premiere time (July 13, 2026, 16:00:00)
cursor.execute("""
    UPDATE scheduled_posts 
    SET scheduled_at = '2026-07-13 16:00:00' 
    WHERE id = 30
""")
print("Updated post 30 scheduled time to '2026-07-13 16:00:00' to match YouTube Premiere.")

conn.commit()
print("Success! Senpai schedule database entries adjusted correctly.")
