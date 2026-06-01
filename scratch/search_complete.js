import fs from 'fs';
import path from 'path';

const targets = [
  'server/routes/media.js',
  'server/services/pipeline.js',
  'server/services/scheduler.js',
  'server/services/youtube.js'
];

targets.forEach(target => {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) return;
  const content = fs.readFileSync(p, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes("status = 'complete'") || line.includes('status = "complete"')) {
      console.log(`${target}:${idx + 1}: ${line.trim()}`);
    }
  });
});
