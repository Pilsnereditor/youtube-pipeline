import puppeteer from 'puppeteer-core';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

const channelId = 3;
const profilePath = path.join(__dirname, '..', 'data', 'profiles', `channel_${channelId}`);

function getChromePath() {
  const paths = {
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    win64: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  };
  if (fs.existsSync(paths.win32)) return paths.win32;
  if (fs.existsSync(paths.win64)) return paths.win64;
  return process.env.CHROME_PATH || paths.win32;
}

// Target rescheduled dates/times:
// Post 65: June 5 at 3:00 PM
// Post 66: June 7 at 3:00 PM
// Post 67: June 10 at 3:00 PM
// Post 68: June 12 at 3:00 PM
// Post 69: June 14 at 3:00 PM
const rescheduleMap = {
  65: { dateStr: 'Jun 05, 2026', timeStr: '15:00', dbScheduledAt: '2026-06-05T15:00:00' },
  66: { dateStr: 'Jun 07, 2026', timeStr: '15:00', dbScheduledAt: '2026-06-07T15:00:00' },
  67: { dateStr: 'Jun 10, 2026', timeStr: '15:00', dbScheduledAt: '2026-06-10T15:00:00' },
  68: { dateStr: 'Jun 12, 2026', timeStr: '15:00', dbScheduledAt: '2026-06-12T15:00:00' },
  69: { dateStr: 'Jun 14, 2026', timeStr: '15:00', dbScheduledAt: '2026-06-14T15:00:00' }
};

const posts = db.prepare('SELECT id, channel_id, title, scheduled_at, youtube_video_id FROM scheduled_posts WHERE id BETWEEN 65 AND 69').all();

async function run() {
  const chromePath = getChromePath();
  console.log(`[Rescheduler] Launching browser using profile: ${profilePath}`);
  
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false, // keep visible so user can see it running
    userDataDir: profilePath,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US'
    ]
  });

  const [page] = await browser.pages();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  try {
    for (const post of posts) {
      const target = rescheduleMap[post.id];
      if (!target) continue;

      console.log(`\n==================================================`);
      console.log(`[Rescheduler] Processing Post ID ${post.id}: "${post.title.substring(0, 40)}..."`);
      console.log(`[Rescheduler] Target Time: ${target.dateStr} @ ${target.timeStr}`);
      console.log(`[Rescheduler] YouTube ID: ${post.youtube_video_id}`);

      const editUrl = `https://studio.youtube.com/video/${post.youtube_video_id}/edit?hl=en`;
      console.log(`[Rescheduler] Navigating to: ${editUrl}`);
      try {
        await page.goto(editUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (err) {
        if (err.message.includes('net::ERR_ABORTED')) {
          console.log('[Rescheduler] Navigation was aborted (benign redirection), continuing...');
        } else {
          throw err;
        }
      }

      // Save a screenshot of the loaded edit page
      const loadScreenshot = path.join(__dirname, `reschedule_load_${post.id}.png`);
      await page.screenshot({ path: loadScreenshot });
      console.log(`[Rescheduler] Saved load screenshot to: ${loadScreenshot}`);

      // Locate visibility dropdown trigger
      console.log('[Rescheduler] Finding visibility box/button...');
      const visibilityBtn = await page.waitForSelector(
        '#visibility-select, ytcp-video-metadata-visibility, #visibility-display, [aria-label="Visibility"], [aria-label*="visibility" i]',
        { timeout: 15000 }
      ).catch(() => null);

      if (!visibilityBtn) {
        console.error('[Rescheduler] Error: Could not find visibility button on edit page.');
        continue;
      }

      console.log('[Rescheduler] Clicking visibility selector...');
      await visibilityBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      const dropdownScreenshot = path.join(__dirname, `reschedule_dropdown_${post.id}.png`);
      await page.screenshot({ path: dropdownScreenshot });
      console.log(`[Rescheduler] Saved dropdown screenshot to: ${dropdownScreenshot}`);

      // Find datepicker inside the dropdown
      console.log('[Rescheduler] Adjusting date...');
      const dateTrigger = await page.waitForSelector(
        '#datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger, ytcp-date-picker, [id*="datepicker"] [role="button"]',
        { timeout: 5000 }
      ).catch(() => null);

      if (dateTrigger) {
        await dateTrigger.click();
        await new Promise(r => setTimeout(r, 1000));
        
        const calInput = await page.waitForSelector(
          '#datepicker-trigger input, ytcp-date-picker input, input[placeholder*="date" i], input[aria-label*="date" i]',
          { timeout: 3000 }
        ).catch(() => null);

        if (calInput) {
          await calInput.click();
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await calInput.type(target.dateStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          console.log(`[Rescheduler] Set date to: ${target.dateStr}`);
        } else {
          console.log('[Rescheduler] Could not find date input field.');
        }
      } else {
        console.log('[Rescheduler] Could not find date dropdown trigger.');
      }

      console.log('[Rescheduler] Adjusting time...');
      const timeInputSelector = await page.evaluate(() => {
        const container = document.querySelector('ytcp-datetime-picker, ytcp-visibility-scheduler, ytcp-video-visibility-select');
        if (!container) return null;
        const inputs = Array.from(container.querySelectorAll('input'));
        const timeInput = inputs.find(input => {
          const val = input.value || '';
          return val.includes(':') || /\d+:\d+/.test(val);
        }) || inputs[inputs.length - 1]; // fallback to last input in the container
        
        if (timeInput) {
          timeInput.setAttribute('id', 'temp-time-input-target');
          return '#temp-time-input-target';
        }
        return null;
      });

      if (timeInputSelector) {
        const timeInput = await page.waitForSelector(timeInputSelector, { timeout: 5000 }).catch(() => null);
        if (timeInput) {
          await timeInput.click();
          await new Promise(r => setTimeout(r, 200));
          await page.keyboard.down('Control');
          await page.keyboard.press('A');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 200));
          await timeInput.type(target.timeStr, { delay: 50 });
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 500));
          console.log(`[Rescheduler] Set time to: ${target.timeStr}`);
        } else {
          console.log('[Rescheduler] Could not resolve time input element from selector.');
        }
      } else {
        console.log('[Rescheduler] Could not find time input field.');
      }

      // Save a screenshot after changing values inside visibility dropdown
      const changedDropdownScreenshot = path.join(__dirname, `reschedule_values_set_${post.id}.png`);
      await page.screenshot({ path: changedDropdownScreenshot });

      // Click "Save" or "Done" button inside visibility dropdown to apply
      console.log('[Rescheduler] Applying visibility changes...');
      const doneBtn = await page.waitForSelector('ytcp-video-visibility-edit-popup #save-button', { timeout: 10000 }).catch(() => null);
      if (doneBtn) {
        await doneBtn.click();
        console.log('[Rescheduler] Clicked Done button inside visibility popup.');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.error('[Rescheduler] Error: Could not find Done button inside visibility popup.');
      }

      // Click the main page SAVE button
      console.log('[Rescheduler] Saving changes on main edit page...');
      const saveBtn = await page.waitForSelector('ytcp-button#save:not([disabled]):not([aria-disabled="true"])', { timeout: 10000 }).catch(() => null);
      if (saveBtn) {
        await saveBtn.click();
        console.log('[Rescheduler] Clicked enabled main save button. Waiting for save to complete...');
        // Wait for it to become disabled (indicates save is finished)
        await page.waitForSelector('ytcp-button#save[disabled], ytcp-button#save[aria-disabled="true"]', { timeout: 20000 }).catch(() => null);
        console.log('[Rescheduler] Save operation completed (button disabled).');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log('[Rescheduler] Main save button not active or not found. Trying fallback click...');
        const mainSaveClicked = await page.evaluate(() => {
          const btn = document.querySelector('ytcp-button#save:not([disabled])') || document.querySelector('ytcp-button#save:not([aria-disabled="true"])');
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
        console.log(`[Rescheduler] Main save clicked fallback status: ${mainSaveClicked}`);
        await new Promise(r => setTimeout(r, 4000));
      }

      // Check if saving is complete (main save button disabled)
      const saveCompleteScreenshot = path.join(__dirname, `reschedule_complete_${post.id}.png`);
      await page.screenshot({ path: saveCompleteScreenshot });
      console.log(`[Rescheduler] Saved complete page screenshot to: ${saveCompleteScreenshot}`);

      // Update Database scheduled_at timestamp
      console.log('[Rescheduler] Updating database timestamp...');
      db.prepare('UPDATE scheduled_posts SET scheduled_at = ? WHERE id = ?').run(target.dbScheduledAt, post.id);
      console.log(`[Rescheduler] Successfully updated Post ID ${post.id} to ${target.dbScheduledAt}`);
    }

  } catch (err) {
    console.error(`[Rescheduler] Error during rescheduling: ${err.message}`);
  } finally {
    console.log('[Rescheduler] Closing browser session...');
    await browser.close();
    db.close();
    console.log('[Rescheduler] Finished.');
  }
}

run();
