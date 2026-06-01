import { syncChannelWithYouTube } from './server/services/youtube.js';
import { initDb } from './server/db/database.js';

initDb();
console.log('Running sync for channel 1...');
syncChannelWithYouTube(1).then(res => {
  console.log('Result:', res);
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
