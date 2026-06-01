import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('public/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes("status === 'error'") || line.includes("status === 'pending'") || line.includes('upcomingQueue')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
