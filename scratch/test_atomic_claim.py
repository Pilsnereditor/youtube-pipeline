import sqlite3, os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
con=sqlite3.connect(':memory:'); con.row_factory=sqlite3.Row; cur=con.cursor()
cur.executescript(open(os.path.join(HERE,'..','server','db','schema.sql')).read())
cur.execute("INSERT INTO channels (id,user_id,name) VALUES (5,1,'ch')")
cur.execute("INSERT INTO scheduled_posts (id,user_id,channel_id,title,scheduled_at,status) VALUES (1,1,5,'a','2026-07-01T10:00','pending')")
cur.execute("INSERT INTO scheduled_posts (id,user_id,channel_id,title,scheduled_at,status) VALUES (2,1,5,'b','2026-07-01T11:00','pending')"); con.commit()
def claim(pid):
    r=cur.execute("""UPDATE scheduled_posts SET status='processing' WHERE id=? AND status!='processing'
       AND NOT EXISTS (SELECT 1 FROM scheduled_posts WHERE channel_id=(SELECT channel_id FROM scheduled_posts WHERE id=?) AND status='processing' AND id!=?)""",(pid,pid,pid)); con.commit(); return r.rowcount
p=f=0
def ok(n,c):
    global p,f; p,f=(p+1,f) if c else (p,f+1); print(('  PASS ' if c else '  FAIL ')+n)
ok('post 1 claims', claim(1)==1)
ok('post 2 blocked same channel', claim(2)==0)
cur.execute("UPDATE scheduled_posts SET status='complete' WHERE id=1"); con.commit()
ok('post 2 claims after 1 done', claim(2)==1)
print(f"\nATOMIC CLAIM: {p} passed, {f} failed"); sys.exit(1 if f else 0)
