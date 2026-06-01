import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('server/routes/schedule.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('UPDATE scheduled_posts')) {
    console.log(`\nLine ${idx + 1}:`);
    for (let i = Math.max(0, idx - 2); i < Math.min(lines.length, idx + 5); i++) {
      console.log(`  ${i + 1}: ${lines[i]}`);
    }
  }
});
