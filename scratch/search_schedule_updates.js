import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('server/routes/schedule.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('UPDATE scheduled_posts') && (line.includes('pending') || line.includes('status'))) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
