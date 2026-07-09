const channelOpQueues = new Map();
function withChannelLock(channelId, fn){
  const key=String(channelId);
  const prev=channelOpQueues.get(key)||Promise.resolve();
  const run=prev.then(()=>fn(),()=>fn());
  channelOpQueues.set(key, run.then(()=>{},()=>{}));
  return run;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let log=[];
async function op(ch,name,ms,fail){ log.push(name+':start'); await sleep(ms); log.push(name+':end'); if(fail) throw new Error(name+' failed'); return name; }
let p=0,f=0; const ok=(n,c)=>{c?(p++,console.log('  PASS',n)):(f++,console.log('  FAIL',n));};
(async()=>{
  // same channel: A then B -> B starts only after A ends
  log=[];
  const a=withChannelLock(5,()=>op(5,'A',40));
  const b=withChannelLock(5,()=>op(5,'B',10));
  await Promise.all([a,b]);
  ok('same channel serialized (A fully before B)', log.join(',')==='A:start,A:end,B:start,B:end');

  // different channels: run in parallel (interleaved)
  log=[];
  const x=withChannelLock(1,()=>op(1,'X',30));
  const y=withChannelLock(2,()=>op(2,'Y',30));
  await Promise.all([x,y]);
  ok('different channels parallel', log[0]==='X:start' && log[1]==='Y:start');

  // a failure in first op does NOT block the next on same channel
  log=[];
  const e1=withChannelLock(9,()=>op(9,'E1',10,true)).catch(()=>'caught');
  const e2=withChannelLock(9,()=>op(9,'E2',10));
  const r1=await e1; const r2=await e2;
  ok('failed op does not break queue', r1==='caught' && r2==='E2' && log.includes('E2:end'));

  console.log(`\nCHANNEL LOCK: ${p} passed, ${f} failed`); process.exit(f?1:0);
})();
