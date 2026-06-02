import puppeteer from 'puppeteer-core';
import fs from 'fs';

const paths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

console.log("Checking Chrome paths:");
for (const p of paths) {
  console.log(`${p}: ${fs.existsSync(p) ? 'EXISTS' : 'NOT FOUND'}`);
}

async function run() {
  const chromePath = paths.find(fs.existsSync) || paths[0];
  console.log(`Using Chrome path: ${chromePath}`);
  try {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log("Browser launched successfully!");
    const version = await browser.version();
    console.log(`Chrome Version: ${version}`);
    await browser.close();
  } catch (err) {
    console.error("Failed to launch browser:", err);
  }
}

run();
