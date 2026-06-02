import WebSocket from 'ws';

async function runTest() {
  console.log('[Test] Initiating session with local server...');
  
  // 1. Establish session and get cookie
  const initRes = await fetch('http://localhost:3000/api/channels', {
    headers: { 'Host': 'localhost' }
  });
  
  const setCookie = initRes.headers.get('set-cookie');
  if (!setCookie) {
    console.error('[Test] Failed to get session cookie from server.');
    return;
  }
  
  const cookie = setCookie.split(';')[0];
  console.log('[Test] Obtained session cookie:', cookie);

  // Parse channel ID from response
  const channels = await initRes.json();
  if (!channels || channels.length === 0) {
    console.error('[Test] No channels found in database to test.');
    return;
  }
  const channelId = channels[0].id;
  console.log('[Test] Testing channel ID:', channelId);

  // 2. Open WebSocket connection using the session cookie
  console.log('[Test] Connecting to WebSocket...');
  const ws = new WebSocket('ws://localhost:3000/', {
    headers: {
      'Cookie': cookie,
      'Host': 'localhost'
    }
  });

  let sessionReadyReceived = false;
  let screencastFramesCount = 0;
  let errorReceived = null;

  ws.on('open', () => {
    console.log('[Test] WebSocket connected successfully!');
    
    // 3. Trigger browser login session via POST request
    console.log(`[Test] Triggering browser login for channel ${channelId}...`);
    fetch(`http://localhost:3000/api/channels/${channelId}/browser-login`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Host': 'localhost'
      }
    })
    .then(res => res.json())
    .then(data => {
      console.log('[Test] Start browser login response:', data);
    })
    .catch(err => {
      console.error('[Test] Error starting browser login:', err);
    });
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('[WS Msg] Received type:', data.type);
      
      if (data.type === 'puppet:session_ready') {
        sessionReadyReceived = true;
        console.log('[Test] SUCCESS: Received puppet:session_ready event!');
      } else if (data.type === 'puppet:screencast') {
        screencastFramesCount++;
        if (screencastFramesCount === 1) {
          console.log('[Test] SUCCESS: Received first screencast frame (size:', data.frame.length, 'bytes)');
        }
      } else if (data.type === 'puppet:session_error') {
        errorReceived = data.error;
        console.error('[Test] ERROR: Received session error:', data.error);
      }
    } catch (e) {
      console.log('[WS Msg Raw]', message.toString().substring(0, 100));
    }
  });

  ws.on('error', (err) => {
    console.error('[WS Error]', err);
  });

  ws.on('close', () => {
    console.log('[Test] WebSocket connection closed.');
  });

  // 4. Timeout and cleanup check
  setTimeout(async () => {
    console.log('\n[Test] --- TEST RESULTS ---');
    console.log('Session Ready Received:', sessionReadyReceived);
    console.log('Screencast Frames Count:', screencastFramesCount);
    console.log('Error Received:', errorReceived);
    
    console.log(`\n[Test] Cleaning up and closing browser session for channel ${channelId}...`);
    await fetch(`http://localhost:3000/api/channels/${channelId}/browser-login-close`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Host': 'localhost'
      }
    });
    
    ws.close();
    
    if (sessionReadyReceived && screencastFramesCount > 0) {
      console.log('\n[Test] VERIFICATION: PASS 100%');
      process.exit(0);
    } else {
      console.error('\n[Test] VERIFICATION: FAIL');
      process.exit(1);
    }
  }, 10000);
}

runTest().catch(console.error);
