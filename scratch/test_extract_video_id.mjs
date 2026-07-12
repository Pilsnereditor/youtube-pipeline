function extractVideoId(url){
  if(!url) return '';
  const patterns=[/\/shorts\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/,/youtu\.be\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/,/[?&]v=([a-zA-Z0-9_-]{11})(?=[&#]|$)/,/\/video\/([a-zA-Z0-9_-]{11})(?=[/?&#]|$)/];
  for(const p of patterns){const m=url.match(p); if(m) return m[1];}
  return '';
}
let p=0,f=0;const ok=(n,c)=>{c?(p++,console.log('  PASS',n)):(f++,console.log('  FAIL',n));};
ok('youtu.be valid', extractVideoId('https://youtu.be/7iFyATpSaNU')==='7iFyATpSaNU');
ok('watch?v with extra params', extractVideoId('https://youtube.com/watch?v=7iFyATpSaNU&t=3s')==='7iFyATpSaNU');
ok('studio /video/id/edit', extractVideoId('https://studio.youtube.com/video/7iFyATpSaNU/edit')==='7iFyATpSaNU');
ok('shorts', extractVideoId('https://youtube.com/shorts/7iFyATpSaNU')==='7iFyATpSaNU');
ok('rejects 6-char fragment', extractVideoId('https://youtu.be/abc123')==='');
ok('rejects help/answer url', extractVideoId('https://support.google.com/youtube/answer/57407')==='');
ok('rejects empty', extractVideoId('')==='');
ok('rejects 20-char junk', extractVideoId('https://youtu.be/abcdefghij1234567890')==='');
console.log(`\nEXTRACT ID: ${p} passed, ${f} failed`); process.exit(f?1:0);
