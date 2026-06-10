import sqlite3, os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
schema=open(os.path.join(HERE,'..','server','db','schema.sql')).read()
con=sqlite3.connect(':memory:'); con.row_factory=sqlite3.Row; cur=con.cursor(); cur.executescript(schema)
p=f=0
def ok(n,c):
    global p,f; p,f=(p+1,f) if c else (p,f+1); print(('  PASS ' if c else '  FAIL ')+n)
cur.execute("INSERT INTO users (id,email,password_hash,license_key,role) VALUES (2,'b','h','k','user')")
cur.execute("INSERT INTO users (id,email,password_hash,license_key,role) VALUES (3,'c','h','k','user')")
cur.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('webshare_api_key','LEGACYKEY123')"); con.commit()
# migration
cur.execute("INSERT OR IGNORE INTO user_settings (user_id,key,value) VALUES (1,'webshare_api_key','seed')")
lg=cur.execute("SELECT value FROM settings WHERE key='webshare_api_key'").fetchone()
if lg and lg['value']:
    cur.execute("INSERT INTO user_settings (user_id,key,value) VALUES (1,'webshare_api_key',?) ON CONFLICT(user_id,key) DO UPDATE SET value=?",(lg['value'],lg['value']))
    cur.execute("DELETE FROM settings WHERE key='webshare_api_key'")
con.commit()
ok('global key removed', cur.execute("SELECT 1 FROM settings WHERE key='webshare_api_key'").fetchone() is None)
ok('admin migrated', cur.execute("SELECT value FROM user_settings WHERE user_id=1 AND key='webshare_api_key'").fetchone()['value']=='LEGACYKEY123')
ok('B isolated (no key)', cur.execute("SELECT 1 FROM user_settings WHERE user_id=2 AND key='webshare_api_key'").fetchone() is None)
print(f"\nH1 WEBSHARE: {p} passed, {f} failed"); sys.exit(1 if f else 0)
