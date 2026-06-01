import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('public/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('function initWS(') || line.includes('initWS = function') || line.includes('initWS()')) {
    console.log(`Found initWS on line ${idx + 1}`);
    for (let i = Math.max(0, idx - 5); i < Math.min(lines.length, idx + 45); i++) {
      console.log(`${i + 1}: ${lines[i]}`);
    }
  }
});
