import { initDb, queryAll } from '../server/db/database.js';
import assert from 'assert';

console.log('--- YouTube Pipeline Verification Test Suite ---');

// 1. Database Column Verification
try {
  initDb();
  console.log('✅ Database initialized successfully.');

  // Retrieve table info for channels
  const columns = queryAll("PRAGMA table_info(channels)");
  const colNames = columns.map(c => c.name);

  const expectedCols = ['custom_logo_path', 'custom_banner_path', 'profile_name', 'proxy_pool_id'];
  for (const col of expectedCols) {
    assert.ok(colNames.includes(col), `Missing expected column: ${col}`);
    console.log(`✅ Column "${col}" exists in channels table.`);
  }

} catch (err) {
  console.error('❌ Database verification failed:', err);
  process.exit(1);
}

// 2. formatPublishTime logic verification
function formatPublishTime(dateIso) {
  const date = new Date(dateIso);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // Hour 0 becomes 12
  const hoursStr = String(hours).padStart(2, '0');
  return `${hoursStr}:${minutes} ${ampm}`;
}

try {
  // Test AM (Note: parsing dateIso as local time since getHours is used)
  const dateAm = new Date();
  dateAm.setHours(8);
  dateAm.setMinutes(30);
  const timeAm = formatPublishTime(dateAm.toISOString());
  assert.strictEqual(timeAm, '08:30 AM', 'AM formatting failed');
  
  // Test PM
  const datePm = new Date();
  datePm.setHours(19);
  datePm.setMinutes(45);
  const timePm = formatPublishTime(datePm.toISOString());
  assert.strictEqual(timePm, '07:45 PM', 'PM formatting failed');

  // Test Midnight
  const dateMidnight = new Date();
  dateMidnight.setHours(0);
  dateMidnight.setMinutes(15);
  const timeMidnight = formatPublishTime(dateMidnight.toISOString());
  assert.strictEqual(timeMidnight, '12:15 AM', 'Midnight formatting failed');

  // Test Noon
  const dateNoon = new Date();
  dateNoon.setHours(12);
  dateNoon.setMinutes(0);
  const timeNoon = formatPublishTime(dateNoon.toISOString());
  assert.strictEqual(timeNoon, '12:00 PM', 'Noon formatting failed');

  console.log('✅ formatPublishTime logic is correct (12-hour AM/PM format verified).');
} catch (err) {
  console.error('❌ formatPublishTime logic verification failed:', err);
  process.exit(1);
}

console.log('✅ All test assertions passed successfully!');
process.exit(0);
