import { initDb } from '../server/db/database.js';
import { syncChannelWithYouTubeBrowser } from '../server/services/puppet.js';

initDb();
console.log('Running browser sync for channel 1004...');
syncChannelWithYouTubeBrowser(1004, console.log).then(res => {
  console.log('Success! Result:', res);
  process.exit(0);
}).catch(err => {
  console.error('Failed! Error:', err);
  process.exit(1);
});
