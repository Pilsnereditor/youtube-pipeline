import https from 'https';

const url = 'https://www.youtube.com/watch?v=IQwFlwLKO3I';

https.get(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    const ownerChannelName = data.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    const externalChannelId = data.match(/"externalChannelId"\s*:\s*"([^"]+)"/);
    const channelId = data.match(/"channelId"\s*:\s*"([^"]+)"/);
    const titleMatch = data.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
    
    console.log('ownerChannelName:', ownerChannelName ? ownerChannelName[1] : 'Not found');
    console.log('externalChannelId:', externalChannelId ? externalChannelId[1] : 'Not found');
    console.log('channelId:', channelId ? channelId[1] : 'Not found');
    console.log('titleMatch:', titleMatch ? titleMatch[1] : 'Not found');
  });
}).on('error', (err) => {
  console.error('Error fetching page:', err);
});
