import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const profilePath = '/var/www/youtube-pipeline/data/profiles/profile_Levo_SG_Arsiv';
  const chromePath = '/usr/bin/google-chrome'; // Standard path on Linux VPS

  console.log('Launching browser directly via puppeteer-core...');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir: profilePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Use generic URL without channel ID prefix
  const targetUrl = 'https://studio.youtube.com/editing/branding?hl=en';
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('Waiting 10 seconds for page render...');
  await new Promise(r => setTimeout(r, 10000));

  // Save screenshot
  const screenshotPath = path.join(__dirname, 'scratch', 'branding_vps_screenshot.png');
  const scratchDir = path.join(__dirname, 'scratch');
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }
  
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved to ${screenshotPath}`);

  // Dump buttons, iframes and general text
  const domInfo = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ id: f.id, class: f.className, src: f.src }));
    const buttons = Array.from(document.querySelectorAll('ytcp-button, paper-button, button, [role="button"]')).map(b => ({
      tag: b.tagName,
      id: b.id,
      class: b.className,
      text: (b.textContent || '').trim(),
      role: b.getAttribute('role')
    }));
    return {
      url: window.location.href,
      title: document.title,
      iframes,
      buttons: buttons.slice(0, 100), // first 100
      bodyTextLength: document.body.textContent.length,
      bodyTextSnippet: document.body.textContent.substring(0, 800)
    };
  });

  const dumpPath = path.join(__dirname, 'scratch', 'branding_vps_dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(domInfo, null, 2));
  console.log(`DOM dump saved to ${dumpPath}`);

  await browser.close();
  console.log('Done!');
}

run().catch(err => {
  console.error('Diagnostic failed:', err);
});
