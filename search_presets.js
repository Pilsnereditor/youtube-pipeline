import fs from 'fs';
import path from 'path';

const htmlPath = 'C:\\Users\\nesim\\.gemini\\antigravity\\scratch\\youtube-pipeline\\public\\index.html';
const appJsPath = 'C:\\Users\\nesim\\.gemini\\antigravity\\scratch\\youtube-pipeline\\public\\app.js';

const htmlLines = fs.readFileSync(htmlPath, 'utf8').split('\n');
const appLines = fs.readFileSync(appJsPath, 'utf8').split('\n');

console.log('=== Presets in index.html ===');
htmlLines.forEach((line, idx) => {
  if (line.includes('preset') || line.includes('Preset')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});

console.log('\n=== Presets in app.js ===');
appLines.forEach((line, idx) => {
  if (line.includes('preset') || line.includes('Preset')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
