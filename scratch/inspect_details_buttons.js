import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const channelId = 3;
const profilePath = path.join(__dirname, '..', 'data', 'profiles', `channel_${channelId}`);

function getChromePath() {
  const paths = {
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    win64: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  };
  if (fs.existsSync(paths.win32)) return paths.win32;
  if (fs.existsSync(paths.win64)) return paths.win64;
  return paths.win32;
}

async function run() {
  const chromePath = getChromePath();
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true, // we can run headless to inspect
    userDataDir: profilePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const [page] = await browser.pages();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    const url = 'https://studio.youtube.com/video/M13dXetVxtw/edit?hl=en';
    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });

    console.log('Opening visibility select...');
    const visibilityBtn = await page.waitForSelector(
      '#visibility-select, ytcp-video-metadata-visibility, #visibility-display, [aria-label="Visibility"], [aria-label*="visibility" i]',
      { timeout: 15000 }
    );
    await visibilityBtn.click();
    await new Promise(r => setTimeout(r, 2000));

    console.log('Inspecting buttons on page...');
    const buttonData = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('ytcp-button, paper-button, button, a'));
      return elements.map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName,
          id: el.id || '',
          className: el.className || '',
          text: (el.textContent || '').trim().replace(/\s+/g, ' '),
          visible: rect.width > 0 && rect.height > 0,
          parentId: el.parentElement ? el.parentElement.id : '',
          parentTag: el.parentElement ? el.parentElement.tagName : ''
        };
      });
    });

    console.log('\n=== LIST OF ALL VISIBLE BUTTONS / LINKS ===');
    const visibleButtons = buttonData.filter(b => b.visible && b.text.length > 0);
    visibleButtons.forEach((b, idx) => {
      console.log(`${idx}: [${b.tagName}] id="${b.id}" class="${b.className}" text="${b.text}" parent=[${b.parentTag} id="${b.parentId}"]`);
    });

  } catch (err) {
    console.error('Error during inspection:', err);
  } finally {
    await browser.close();
  }
}

run();
