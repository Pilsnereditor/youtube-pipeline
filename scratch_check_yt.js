import { initDb } from './server/db/database.js';
import { getAuthenticatedClient } from './server/services/youtube.js';
import { google } from 'googleapis';

async function run() {
  try {
    initDb();
    
    const auth = await getAuthenticatedClient(2);
    const yt = google.youtube({ version: 'v3', auth });
    
    console.log('Querying channel details...');
    const channelRes = await yt.channels.list({
      part: ['id', 'snippet'],
      mine: true
    });
    
    if (channelRes.data.items && channelRes.data.items.length > 0) {
      const channel = channelRes.data.items[0];
      console.log(`Authenticated Channel ID: ${channel.id}`);
      console.log(`Authenticated Channel Title: ${channel.snippet.title}`);
    } else {
      console.log('No channels found for this token.');
    }
  } catch (err) {
    console.error('Error in script:', err);
  }
}

run();
