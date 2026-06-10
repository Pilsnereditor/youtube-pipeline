import fs from 'fs';
import https from 'https';

function checkVideoOnYouTube(videoId) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Look for ytInitialPlayerResponse
        const match = data.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (!match) {
          // Fallback check: check if page contains specific strings
          if (data.includes('Video unavailable') || data.includes('This video is unavailable') || data.includes('removed by the user')) {
            resolve({ exists: false, reason: 'unavailable_text' });
          } else {
            resolve({ exists: true, reason: 'no_player_response_fallback' });
          }
          return;
        }
        
        try {
          const playerResponse = JSON.parse(match[1]);
          const status = playerResponse.playabilityStatus?.status;
          const reason = playerResponse.playabilityStatus?.reason;
          console.log(`Video ${videoId} status:`, status, 'reason:', reason);
          
          if (status === 'ERROR' && (reason?.includes('unavailable') || reason?.includes('removed'))) {
            resolve({ exists: false, reason: reason || 'ERROR' });
          } else {
            resolve({ exists: true, status, reason });
          }
        } catch (e) {
          resolve({ exists: true, reason: 'parse_error_fallback' });
        }
      });
    }).on('error', reject);
  });
}

async function test() {
  const pzExists = await checkVideoOnYouTube('pzT5WTe3n2E');
  console.log('pzT5WTe3n2E (deleted) result:', pzExists);

  const activeExists = await checkVideoOnYouTube('41L6vOfkBBk'); // let's check the other one
  console.log('41L6vOfkBBk result:', activeExists);
}

test();
