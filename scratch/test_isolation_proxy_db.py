import sqlite3, os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
schema=open(os.path.join(HERE,'..','server','db','schema.sql')).read()
con=sqlite3.connect(':memory:'); con.row_factory=sqlite3.Row; cur=con.cursor()
cur.executescript(schema)
p=f=0
def ok(n,c):
    global p,f
    p,f=(p+1,f) if c else (p,f+1); print(('  PASS ' if c else '  FAIL ')+n)
cur.execute("INSERT INTO users (id,email,password_hash,license_key,role) VALUES (2,'b@x.com','h','k','user')")
cur.execute("INSERT INTO users (id,email,password_hash,license_key,role) VALUES (3,'c@x.com','h','k','user')")
for i in range(20): cur.execute("INSERT INTO proxy_pool (user_id,host,port,protocol) VALUES (1,?,?,'http')",(f'10.0.0.{i}',8000+i))
con.commit(); pid=[r['id'] for r in cur.execute('SELECT id FROM proxy_pool ORDER BY id')]
for cid,uid,nm in [(10,1,'A1'),(11,1,'A2'),(12,2,'B1'),(13,3,'C1')]:
    cur.execute("INSERT INTO channels (id,user_id,name) VALUES (?,?,?)",(cid,uid,nm))
cur.execute("UPDATE channels SET proxy_pool_id=? WHERE id=10",(pid[15],)); con.commit()
def lst(u): return cur.execute("SELECT pp.* FROM proxy_pool pp WHERE pp.user_id=? GROUP BY pp.id",(u,)).fetchall()
def assign(ids,t):
    for x in ids:
        if cur.execute("UPDATE proxy_pool SET user_id=? WHERE id=?",(t,x)).rowcount:
            cur.execute("UPDATE channels SET proxy_pool_id=NULL WHERE proxy_pool_id=? AND user_id!=?",(x,t))
    con.commit()
ok('admin owns 20',len(lst(1))==20); ok('B owns 0',len(lst(2))==0)
assign(pid[10:15],2); assign(pid[15:20],3)
ok('admin->10',len(lst(1))==10); ok('B->5',len(lst(2))==5); ok('C->5',len(lst(3))==5)
ok('cross-user channel unlinked', cur.execute("SELECT proxy_pool_id FROM channels WHERE id=10").fetchone()['proxy_pool_id'] is None)
ok('B sees only own channel',[r['id'] for r in cur.execute("SELECT id FROM channels WHERE user_id=2")]==[12])
print(f"\nDB ISOLATION/PROXY: {p} passed, {f} failed"); sys.exit(1 if f else 0)
