const tok = (s) => ((s||'').toLowerCase().match(/[a-zçğıöşü]+|\d+/g)||[]).map(t=>t.replace(/^0+(\d)/,'$1'));
function verify(target, final){
  const want=tok(target); const got=new Set(tok(final));
  return !(final && want.length && !want.every(t=>got.has(t))); // true = ok, false = would abort
}
let p=0,f=0; const ok=(n,c)=>{c?(p++,console.log('  PASS',n)):(f++,console.log('  FAIL',n));};
ok('correct match (en)', verify('Jul 6, 2026','Jul 6, 2026')===true);
ok('correct match leading-zero numeric', verify('06.07.2026','6.7.2026')===true);
ok('correct match turkish', verify('6 Tem 2026','6 Tem 2026')===true);
ok('WRONG later date caught (Aug vs Jul)', verify('Jul 6, 2026','Aug 15, 2026')===false);
ok('WRONG later year caught', verify('Jul 6, 2026','Jul 6, 2027')===false);
ok('WRONG day caught', verify('Jul 6, 2026','Jul 20, 2026')===false);
ok('empty final does not false-abort', verify('Jul 6, 2026','')===true);
ok('reformatted same date passes', verify('Jul 6, 2026','6 Jul 2026')===true);
console.log(`\nDATE VERIFY: ${p} passed, ${f} failed`); process.exit(f?1:0);
