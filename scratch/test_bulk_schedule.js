import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'pipeline.db');
const db = new Database(dbPath);

const userId = 1;
const channelIds = [3];
const count = 5;
const isDays = false;
const presetId = 1; // egt

const DAYS_MAP = {
  'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6,
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6
};

function parseDays(daysStr) {
  if (!daysStr) return [];
  const normalized = daysStr.toLowerCase().trim();
  if (normalized === 'everyday') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  return normalized.split(',')
    .map(d => {
      const clean = d.trim().replace(/^every\s+/i, '');
      return DAYS_MAP[clean];
    })
    .filter(d => d !== undefined);
}

function getLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

try {
  db.transaction(() => {
    for (const channelId of channelIds) {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      console.log(`Channel: ${channel.name}`);

      let scheduleDays = channel.schedule_days;
      let scheduleTime = channel.schedule_time;

      if (presetId) {
        const preset = db.prepare('SELECT * FROM schedule_presets WHERE id = ?').get(presetId);
        if (preset) {
          scheduleDays = preset.days;
          scheduleTime = preset.time;
        }
      }

      console.log(`Schedule Days: ${scheduleDays}, Time: ${scheduleTime}`);
      const targetDays = parseDays(scheduleDays);
      console.log(`Parsed Days: ${targetDays}`);

      const timeParts = (scheduleTime || '10:00').split(':');
      const hours = parseInt(timeParts[0], 10) || 0;
      const minutes = parseInt(timeParts[1], 10) || 0;

      const existingPosts = db.prepare(
        `SELECT scheduled_at FROM scheduled_posts 
         WHERE channel_id = ? AND status IN ('pending', 'processing', 'complete')`
      ).all(channelId);
      
      const takenDates = new Set(
        existingPosts.map(p => p.scheduled_at.split('T')[0])
      );
      console.log('Taken Dates:', Array.from(takenDates));

      const candidateDates = [];
      let now = new Date();
      
      if (isDays) {
        for (let i = 1; i <= count; i++) {
          const checkDate = new Date();
          checkDate.setDate(now.getDate() + i);
          if (targetDays.includes(checkDate.getDay())) {
            const dateStr = getLocalDateString(checkDate);
            if (!takenDates.has(dateStr)) {
              candidateDates.push(dateStr);
            }
          }
        }
      } else {
        let daysSearched = 0;
        let checkDate = new Date();
        checkDate.setDate(now.getDate() + 1); // Start tomorrow

        while (candidateDates.length < count && daysSearched < 365) {
          if (targetDays.includes(checkDate.getDay())) {
            const dateStr = getLocalDateString(checkDate);
            if (!takenDates.has(dateStr)) {
              candidateDates.push(dateStr);
            }
          }
          checkDate.setDate(checkDate.getDate() + 1);
          daysSearched++;
        }
      }

      console.log('Candidate Dates:', candidateDates);
    }
    // rollback transaction so we don't write anything
    throw new Error('ROLLBACK');
  })();
} catch (e) {
  if (e.message !== 'ROLLBACK') {
    console.error(e);
  }
}

db.close();
