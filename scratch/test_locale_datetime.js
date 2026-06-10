import { formatPublishDate, formatPublishTime } from '../server/services/puppet.js';

console.log('=== YouTube Rescheduling Locale Datetime Formatting Test ===');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion Failed: ${message}`);
    process.exit(1);
  }
  console.log(`✅ Passed: ${message}`);
}

// Test Case 1: Standard June 10, 2026 at 7:30 PM (19:30)
const testDate1 = '2026-06-10T19:30:00';

// English assertions
assert(formatPublishDate(testDate1, 'en') === 'Jun 10, 2026', 'English Date formatted correctly (Jun 10, 2026)');
assert(formatPublishTime(testDate1, 'en') === '7:30 PM', 'English Time formatted correctly (7:30 PM)');

// Turkish assertions
assert(formatPublishDate(testDate1, 'tr') === '10 Haz 2026', 'Turkish Date formatted correctly (10 Haz 2026)');
assert(formatPublishTime(testDate1, 'tr') === '19:30', 'Turkish Time formatted correctly (19:30)');


// Test Case 2: Single digit day and AM hour: June 5, 2026 at 7:05 AM (07:05)
const testDate2 = '2026-06-05T07:05:00';

// English assertions
assert(formatPublishDate(testDate2, 'en') === 'Jun 5, 2026', 'English Date single-digit day formatted correctly (Jun 5, 2026)');
assert(formatPublishTime(testDate2, 'en') === '7:05 AM', 'English Time single-digit AM formatted correctly (7:05 AM)');

// Turkish assertions
assert(formatPublishDate(testDate2, 'tr') === '5 Haz 2026', 'Turkish Date single-digit day formatted correctly (5 Haz 2026)');
assert(formatPublishTime(testDate2, 'tr') === '07:05', 'Turkish Time 24h formatted correctly (07:05)');

console.log('\n🎉 All locale formatting assertions passed successfully!');
