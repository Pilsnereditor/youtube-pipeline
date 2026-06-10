// Mirrors the exact allocateSlot algorithm + session map from server/services/vnc.js
const SLOTS = [
  { display: ':99',  vncPort: 5999, wsPort: 6080, cdpPort: 9222 },
  { display: ':100', vncPort: 6000, wsPort: 6081, cdpPort: 9223 },
  { display: ':101', vncPort: 6001, wsPort: 6082, cdpPort: 9224 },
  { display: ':102', vncPort: 6002, wsPort: 6083, cdpPort: 9225 },
];
const vncSessions = new Map();
function allocateSlot() {
  const usedDisplays = new Set();
  for (const s of vncSessions.values()) if (s.slot) usedDisplays.add(s.slot.display);
  for (const slot of SLOTS) if (!usedDisplays.has(slot.display)) return slot;
  return null;
}
function launch(userId, profilePath) {
  // mirrors launchVncSession: stop this user's existing session, then allocate
  if (vncSessions.has(userId)) vncSessions.delete(userId);
  const slot = allocateSlot();
  if (!slot) throw new Error(`All ${SLOTS.length} login slots in use`);
  vncSessions.set(userId, { userId, slot, profilePath });
  return slot;
}
function stop(userId){ vncSessions.delete(userId); }
function stopForProfile(profilePath){
  for (const [uid,s] of vncSessions.entries()){ if (s.profilePath===profilePath){ vncSessions.delete(uid); return uid; } }
  return null;
}
let pass=0, fail=0;
function ok(name,cond){ if(cond){pass++;console.log('  PASS',name);}else{fail++;console.log('  FAIL',name);} }

// 1. Three users get three DISTINCT slots (no collision)
const sA=launch(101,'/p/yt_setup_101'), sB=launch(102,'/p/yt_setup_102'), sC=launch(103,'/p/yt_setup_103');
ok('3 users -> distinct displays', new Set([sA.display,sB.display,sC.display]).size===3);
ok('3 users -> distinct ws ports', new Set([sA.wsPort,sB.wsPort,sC.wsPort]).size===3);
ok('each user maps to own ws port', sA.wsPort===6080 && sB.wsPort===6081 && sC.wsPort===6082);

// 2. A 4th concurrent login uses the 4th slot
const sD=launch(104,'/p/yt_setup_104');
ok('4th user gets 4th slot', sD.display===':102');

// 3. A 5th concurrent login is refused (not silently sharing a slot)
let refused=false; try{ launch(105,'/p/x'); }catch(e){ refused=true; }
ok('5th concurrent login refused (no slot sharing)', refused);

// 4. Stopping one frees its slot for reuse
stop(102);
const sE=launch(105,'/p/yt_setup_105');
ok('freed slot is reused', sE.display===':100');

// 5. Re-launch by same user does not consume a 2nd slot
const before=vncSessions.size; const sA2=launch(101,'/p/yt_setup_101b');
ok('relaunch same user keeps session count', vncSessions.size===before);

// 6. Upload teardown only stops the login on the MATCHING profile (C4 isolation)
const target='/p/yt_setup_103';
const killed=stopForProfile(target);
ok('stopForProfile kills only matching user', killed===103 && !vncSessions.has(103));
ok('stopForProfile leaves other users untouched', vncSessions.has(101)&&vncSessions.has(104)&&vncSessions.has(105));
ok('stopForProfile on unknown profile is a no-op', stopForProfile('/p/does_not_exist')===null);

console.log(`\nSLOT LOGIC: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
