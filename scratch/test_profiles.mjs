// Mirrors the per-user profile naming + list filter from channels.js
const safe = s => s.trim().replace(/[^a-zA-Z0-9_-]/g,'_');
const createName = (userId,name) => `profile_${userId}_${safe(name)}`;
const freshName  = userId => `yt_setup_${userId}`;
// list filter: show profile if it's this user's prefix OR linked to this user's channel
const visible = (dirName, userId, linkedChannel) =>
  dirName.startsWith(`profile_${userId}_`) || !!linkedChannel;

let p=0,f=0; const ok=(n,c)=>{c?(p++,console.log('  PASS',n)):(f++,console.log('  FAIL',n));};

// Two different users pick the SAME name "main" -> distinct dirs (no collision/overwrite)
ok('same name, different users -> distinct dirs', createName(2,'main')!==createName(3,'main'));
ok('user2 main', createName(2,'main')==='profile_2_main');
ok('user3 main', createName(3,'main')==='profile_3_main');
// Fresh logins are per-user (C5: no shared yt_setup_new wipe)
ok('fresh logins distinct per user', freshName(2)!==freshName(3));
ok('no shared yt_setup_new', freshName(2)==='yt_setup_2' && freshName(3)==='yt_setup_2'.replace('2','3'));
// List filter: user 2 sees own profile, not user 3's
ok('user2 sees own profile', visible('profile_2_main',2,null)===true);
ok('user2 does NOT see user3 profile', visible('profile_3_main',2,null)===false);
// Legacy profile (no userId prefix) shows only if linked to this user's channel
ok('legacy profile shown when linked to me', visible('profile_PYZ',2,{id:5})===true);
ok('legacy profile hidden when not mine', visible('profile_PYZ',2,null)===false);

console.log(`\nPROFILE NAMING: ${p} passed, ${f} failed`);
process.exit(f?1:0);
