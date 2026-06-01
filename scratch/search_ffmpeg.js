import fs from 'fs';
import path from 'path';

function walk(dir) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== '.git') walk(p);
    } else if (f.endsWith('.js')) {
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes('ffmpeg') || content.includes('fluent-ffmpeg')) {
        console.log(p);
      }
    }
  });
}

walk('.');
