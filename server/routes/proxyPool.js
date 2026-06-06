import { Router } from 'express';
import { queryAll, queryOne, run, insert } from '../db/database.js';

const router = Router();

/** GET /api/proxy-pool — List all proxies with assigned channel count */
router.get('/', (req, res) => {
  const userId = req.session.userId;
  try {
    const proxies = queryAll(`
      SELECT pp.*, 
             COUNT(c.id) as assigned_channels,
             GROUP_CONCAT(c.name, ', ') as channel_names
      FROM proxy_pool pp
      LEFT JOIN channels c ON c.proxy_pool_id = pp.id
      WHERE pp.user_id = @userId
      GROUP BY pp.id
      ORDER BY pp.created_at DESC
    `, { userId });
    res.json(proxies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/proxy-pool — Add a single proxy */
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { label, host, port, username, password, protocol, country_code, city, provider, external_id } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Host and port are required.' });
  try {
    const id = insert(
      `INSERT INTO proxy_pool (user_id, label, host, port, username, password, protocol, country_code, city, provider, external_id)
       VALUES (@userId, @label, @host, @port, @username, @password, @protocol, @countryCode, @city, @provider, @externalId)`,
      {
        userId,
        label: label || '',
        host,
        port: Number(port),
        username: username || '',
        password: password || '',
        protocol: protocol || 'http',
        countryCode: country_code || '',
        city: city || '',
        provider: provider || 'manual',
        externalId: external_id || ''
      }
    );
    const proxy = queryOne('SELECT * FROM proxy_pool WHERE id = @id', { id });
    res.json(proxy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/proxy-pool/bulk — Import multiple proxies (IP:Port:User:Pass format) */
router.post('/bulk', (req, res) => {
  const userId = req.session.userId;
  const { proxies_text, protocol } = req.body;
  if (!proxies_text) return res.status(400).json({ error: 'No proxy text provided.' });
  
  const lines = proxies_text.trim().split('\n').filter(l => l.trim());
  let imported = 0;
  const errors = [];
  
  for (const line of lines) {
    const parts = line.trim().split(':');
    if (parts.length < 2) {
      errors.push(`Invalid format: ${line}`);
      continue;
    }
    try {
      insert(
        `INSERT INTO proxy_pool (user_id, host, port, username, password, protocol, provider)
         VALUES (@userId, @host, @port, @username, @password, @protocol, 'manual')`,
        {
          userId,
          host: parts[0],
          port: Number(parts[1]),
          username: parts[2] || '',
          password: parts[3] || '',
          protocol: protocol || 'http'
        }
      );
      imported++;
    } catch (err) {
      errors.push(`Failed: ${line} — ${err.message}`);
    }
  }
  
  res.json({ imported, errors });
});

/** POST /api/proxy-pool/sync-webshare — Fetch proxies from Webshare API */
router.post('/sync-webshare', async (req, res) => {
  const userId = req.session.userId;
  
  // Get API key from request body or settings
  let apiKey = req.body.api_key;
  if (!apiKey) {
    const setting = queryOne("SELECT value FROM settings WHERE key = 'webshare_api_key'");
    apiKey = setting?.value;
  }
  if (!apiKey) return res.status(400).json({ error: 'Webshare API key not configured.' });
  
  // Save API key to settings
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('webshare_api_key', @apiKey)", { apiKey });
  
  try {
    let allProxies = [];
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const response = await fetch(
        `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=${page}&page_size=100`,
        { headers: { 'Authorization': `Token ${apiKey}` } }
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: `Webshare API error: ${errorText}` });
      }
      
      const data = await response.json();
      allProxies = allProxies.concat(data.results || []);
      hasMore = !!data.next;
      page++;
    }
    
    // Upsert proxies
    let imported = 0;
    let updated = 0;
    
    for (const p of allProxies) {
      const existing = queryOne(
        'SELECT id FROM proxy_pool WHERE external_id = @extId AND user_id = @userId',
        { extId: p.id, userId }
      );
      
      if (existing) {
        run(`UPDATE proxy_pool SET 
              host = @host, port = @port, username = @username, password = @password,
              country_code = @countryCode, city = @city, is_healthy = @isHealthy,
              last_tested_at = @lastVerification
            WHERE id = @id`, {
          host: p.proxy_address,
          port: p.port,
          username: p.username,
          password: p.password,
          countryCode: p.country_code || '',
          city: p.city_name || '',
          isHealthy: p.valid ? 1 : 0,
          lastVerification: p.last_verification || null,
          id: existing.id
        });
        updated++;
      } else {
        insert(`INSERT INTO proxy_pool (user_id, label, host, port, username, password, protocol, country_code, city, provider, external_id, is_healthy, last_tested_at)
                VALUES (@userId, @label, @host, @port, @username, @password, 'http', @countryCode, @city, 'webshare', @extId, @isHealthy, @lastVerification)`, {
          userId,
          label: `${p.city_name || p.country_code || 'Proxy'} #${p.port}`,
          host: p.proxy_address,
          port: p.port,
          username: p.username,
          password: p.password,
          countryCode: p.country_code || '',
          city: p.city_name || '',
          extId: p.id,
          isHealthy: p.valid ? 1 : 0,
          lastVerification: p.last_verification || null
        });
        imported++;
      }
    }
    
    // Fetch updated list
    const proxies = queryAll(`
      SELECT pp.*, 
             COUNT(c.id) as assigned_channels,
             GROUP_CONCAT(c.name, ', ') as channel_names
      FROM proxy_pool pp
      LEFT JOIN channels c ON c.proxy_pool_id = pp.id
      WHERE pp.user_id = @userId
      GROUP BY pp.id
      ORDER BY pp.created_at DESC
    `, { userId });
    
    res.json({ imported, updated, total: allProxies.length, proxies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/proxy-pool/:id */
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  try {
    // Unlink any channels first
    run('UPDATE channels SET proxy_pool_id = NULL WHERE proxy_pool_id = @id AND user_id = @userId', { id, userId });
    const result = run('DELETE FROM proxy_pool WHERE id = @id AND user_id = @userId', { id, userId });
    if (result.changes === 0) return res.status(404).json({ error: 'Proxy not found.' });
    res.json({ message: 'Proxy deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/proxy-pool/:id/test — Test proxy connectivity */
router.post('/:id/test', async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const proxy = queryOne('SELECT * FROM proxy_pool WHERE id = @id AND user_id = @userId', { id, userId });
  if (!proxy) return res.status(404).json({ error: 'Proxy not found.' });
  
  const start = Date.now();
  try {
    // Use Node's built-in fetch with a timeout
    const proxyUrl = `${proxy.protocol}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    
    // Simple connectivity test — try to reach httpbin via the proxy
    // For a basic check, we'll just try to connect to the proxy itself
    const net = await import('net');
    const latency = await new Promise((resolve, reject) => {
      const socket = net.default.createConnection({ host: proxy.host, port: proxy.port }, () => {
        const ms = Date.now() - start;
        socket.destroy();
        resolve(ms);
      });
      socket.setTimeout(10000);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timeout')); });
      socket.on('error', (err) => reject(err));
    });
    
    run(`UPDATE proxy_pool SET is_healthy = 1, last_latency_ms = @latency, last_tested_at = datetime('now') WHERE id = @id`,
      { latency, id });
    
    res.json({ healthy: true, latency_ms: latency });
  } catch (err) {
    run(`UPDATE proxy_pool SET is_healthy = 0, last_tested_at = datetime('now') WHERE id = @id`, { id });
    res.json({ healthy: false, error: err.message });
  }
});

/** POST /api/proxy-pool/test-all — Test all proxies */
router.post('/test-all', async (req, res) => {
  const userId = req.session.userId;
  const proxies = queryAll('SELECT * FROM proxy_pool WHERE user_id = @userId', { userId });
  
  const results = [];
  const net = await import('net');
  
  for (const proxy of proxies) {
    const start = Date.now();
    try {
      const latency = await new Promise((resolve, reject) => {
        const socket = net.default.createConnection({ host: proxy.host, port: proxy.port }, () => {
          const ms = Date.now() - start;
          socket.destroy();
          resolve(ms);
        });
        socket.setTimeout(10000);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout')); });
        socket.on('error', (err) => reject(err));
      });
      
      run(`UPDATE proxy_pool SET is_healthy = 1, last_latency_ms = @latency, last_tested_at = datetime('now') WHERE id = @id`,
        { latency, id: proxy.id });
      results.push({ id: proxy.id, host: proxy.host, healthy: true, latency_ms: latency });
    } catch (err) {
      run(`UPDATE proxy_pool SET is_healthy = 0, last_tested_at = datetime('now') WHERE id = @id`, { id: proxy.id });
      results.push({ id: proxy.id, host: proxy.host, healthy: false, error: err.message });
    }
  }
  
  res.json({ results });
});

/** POST /api/proxy-pool/auto-assign — Auto-assign unassigned channels to proxies */
router.post('/auto-assign', (req, res) => {
  const userId = req.session.userId;
  try {
    const unassigned = queryAll(
      'SELECT id, name FROM channels WHERE user_id = @userId AND (proxy_pool_id IS NULL OR proxy_pool_id = 0)',
      { userId }
    );
    
    if (unassigned.length === 0) {
      return res.json({ message: 'All channels already have proxies assigned.', assignments: [] });
    }
    
    // Get proxies with current assignment counts
    const proxies = queryAll(`
      SELECT pp.id, pp.host, pp.max_channels, COUNT(c.id) as current_count
      FROM proxy_pool pp
      LEFT JOIN channels c ON c.proxy_pool_id = pp.id
      WHERE pp.user_id = @userId AND pp.is_healthy = 1
      GROUP BY pp.id
      HAVING current_count < pp.max_channels
      ORDER BY current_count ASC
    `, { userId });
    
    if (proxies.length === 0) {
      return res.status(400).json({ error: 'No available proxies with free slots. Add more proxies or increase max_channels.' });
    }
    
    const assignments = [];
    let proxyIdx = 0;
    
    for (const channel of unassigned) {
      // Re-check available proxies (counts may have changed)
      const available = queryAll(`
        SELECT pp.id, pp.host, pp.max_channels, COUNT(c.id) as current_count
        FROM proxy_pool pp
        LEFT JOIN channels c ON c.proxy_pool_id = pp.id
        WHERE pp.user_id = @userId AND pp.is_healthy = 1
        GROUP BY pp.id
        HAVING current_count < pp.max_channels
        ORDER BY current_count ASC
        LIMIT 1
      `, { userId });
      
      if (available.length === 0) break;
      
      const proxy = available[0];
      run('UPDATE channels SET proxy_pool_id = @proxyId WHERE id = @channelId', 
        { proxyId: proxy.id, channelId: channel.id });
      assignments.push({ channel_id: channel.id, channel_name: channel.name, proxy_id: proxy.id, proxy_host: proxy.host });
    }
    
    res.json({ message: `Assigned ${assignments.length} channels.`, assignments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/proxy-pool/assign — Manually assign a channel to a proxy */
router.post('/assign', (req, res) => {
  const userId = req.session.userId;
  const { channel_id, proxy_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id is required.' });
  
  try {
    if (proxy_id) {
      // Check proxy exists and has capacity
      const proxy = queryOne(`
        SELECT pp.*, COUNT(c.id) as current_count
        FROM proxy_pool pp
        LEFT JOIN channels c ON c.proxy_pool_id = pp.id
        WHERE pp.id = @proxyId AND pp.user_id = @userId
        GROUP BY pp.id
      `, { proxyId: proxy_id, userId });
      
      if (!proxy) return res.status(404).json({ error: 'Proxy not found.' });
      if (proxy.current_count >= proxy.max_channels) {
        return res.status(400).json({ error: `Proxy already has ${proxy.current_count}/${proxy.max_channels} channels assigned.` });
      }
    }
    
    run('UPDATE channels SET proxy_pool_id = @proxyId WHERE id = @channelId AND user_id = @userId',
      { proxyId: proxy_id || null, channelId: channel_id, userId });
    
    res.json({ message: 'Channel proxy assignment updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/proxy-pool/unassign — Remove proxy from a channel */
router.post('/unassign', (req, res) => {
  const userId = req.session.userId;
  const { channel_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id is required.' });
  
  try {
    run('UPDATE channels SET proxy_pool_id = NULL WHERE id = @channelId AND user_id = @userId',
      { channelId: channel_id, userId });
    res.json({ message: 'Proxy unassigned from channel.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
