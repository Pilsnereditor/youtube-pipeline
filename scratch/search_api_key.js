import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('server/services/gemini.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('settings') || line.includes('key') || line.includes('api')) {
    if (line.includes('DB') || line.includes('query') || line.includes('SELECT')) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
