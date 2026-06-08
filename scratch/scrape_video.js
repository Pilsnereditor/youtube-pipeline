import puppeteer from 'puppeteer-core';

async function run() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    console.log('Navigating to video...');
    await page.goto('https://www.youtube.com/watch?v=Em30yE-6kiA', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('Current URL:', page.url());
    
    // Wait 5 seconds
    await new Promise(r => setTimeout(r, 5000));
    
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1500));
    console.log('\nPage Title:', title);
    console.log('Body Text Preview:\n', bodyText);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

run();
