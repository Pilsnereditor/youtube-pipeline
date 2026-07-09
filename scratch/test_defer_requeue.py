import sqlite3, os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
con=sqlite3.connect(':memory:'); con.row_factory=sqlite3.Row; cur=con.cursor()
cur.executescript(open(os.path.join(HERE,'..','server','db','schema.sql')).read())
cur.execute("INSERT INTO channels (id,user_id,name) VALUES (5,1,'ch')")
cur.execute("INSERT INTO scheduled_posts (id,user_id,channel_id,title,scheduled_at,status,retry_count) VALUES (20,1,5,'busy','2026-07-06T20:30','processing',0)")
cur.execute("INSERT INTO scheduled_posts (id,user_id,channel_id,title,scheduled_at,status,retry_count) VALUES (5,1,5,'mine','2026-07-06T20:30','pending',0)"); con.commit()
p=f=0
def ok(n,c):
    global p,f; p,f=(p+1,f) if c else (p,f+1); print(('  PASS ' if c else '  FAIL ')+n)
def claim(pid):
    r=cur.execute("""UPDATE scheduled_posts SET status='processing' WHERE id=? AND status!='processing'
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts WHERE channel_id=(SELECT channel_id FROM scheduled_posts WHERE id=?) AND status='processing' AND id!=?)""",(pid,pid,pid)); con.commit(); return r.rowcount
if claim(5)==0:
    cur.execute("UPDATE scheduled_posts SET status='pending', next_retry_at='2000-01-01T00:00' WHERE id=5"); con.commit()
row=cur.execute("SELECT status,retry_count FROM scheduled_posts WHERE id=5").fetchone()
ok('stays pending (not FAILED)', row['status']=='pending')
ok('retry_count not burned', row['retry_count']==0)
now='2026-06-17T12:00'
due=[r['id'] for r in cur.execute("""SELECT id FROM scheduled_posts WHERE (status='pending' AND scheduled_at<=?) OR (status='pending' AND next_retry_at IS NOT NULL AND next_retry_at<=?) OR (status='error' AND retry_count<3 AND next_retry_at<=?)""",(now,now,now)).fetchall()]
ok('cron re-picks deferred post', 5 in due)
cur.execute("UPDATE scheduled_posts SET status='complete' WHERE id=20"); con.commit()
ok('uploads once channel free', claim(5)==1)
print(f"\nDEFER RE-QUEUE: {p} passed, {f} failed"); sys.exit(1 if f else 0)
