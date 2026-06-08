import db from './server/db/database.js';
db.initDb();

const channels = db.queryAll('SELECT id, name, upload_mode, youtube_channel_id FROM channels');
console.log('=== CHANNELS ===');
console.log(channels);

for (const ch of channels) {
  const token = db.queryOne('SELECT id, expiry_date FROM oauth_tokens WHERE channel_id = @id', { id: ch.id });
  console.log(`OAuth Token for channel "${ch.name}":`, token ? 'FOUND' : 'MISSING');
}
