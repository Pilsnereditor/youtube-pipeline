import fs from 'fs';
import path from 'path';

const appJsPath = 'C:\\Users\\nesim\\.gemini\\antigravity\\scratch\\youtube-pipeline\\public\\app.js';
const content = fs.readFileSync(appJsPath, 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('cancelScheduledPost')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
