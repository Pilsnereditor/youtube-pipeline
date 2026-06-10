import { 
  formatPublishDate, 
  formatPublishTime, 
  formatDateLikeInitial, 
  formatTimeLikeInitial 
} from '../server/services/puppet.js';

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

// English fallback assertions
assert(formatPublishDate(testDate1, 'en') === 'Jun 10, 2026', 'English Date formatted correctly (Jun 10, 2026)');
assert(formatPublishTime(testDate1, 'en') === '7:30 PM', 'English Time formatted correctly (7:30 PM)');

// Turkish fallback assertions
assert(formatPublishDate(testDate1, 'tr') === '10 Haz 2026', 'Turkish Date formatted correctly (10 Haz 2026)');
assert(formatPublishTime(testDate1, 'tr') === '19:30', 'Turkish Time formatted correctly (19:30)');


// Test Case 2: Single digit day and AM hour: June 5, 2026 at 7:05 AM (07:05)
const testDate2 = '2026-06-05T07:05:00';

// English fallback assertions
assert(formatPublishDate(testDate2, 'en') === 'Jun 5, 2026', 'English Date single-digit day formatted correctly (Jun 5, 2026)');
assert(formatPublishTime(testDate2, 'en') === '7:05 AM', 'English Time single-digit AM formatted correctly (7:05 AM)');

// Turkish fallback assertions
assert(formatPublishDate(testDate2, 'tr') === '5 Haz 2026', 'Turkish Date single-digit day formatted correctly (5 Haz 2026)');
assert(formatPublishTime(testDate2, 'tr') === '07:05', 'Turkish Time 24h formatted correctly (07:05)');


// Test Case 3: Adaptive Formatting matches initialValue format
const targetDate = '2026-06-15T18:45:00'; // June 15, 2026 at 6:45 PM (18:45)

// Date adaptiveness
assert(formatDateLikeInitial('Jun 12, 2026', targetDate) === 'Jun 15, 2026', 'Adaptive Date matches Month Day, Year');
assert(formatDateLikeInitial('12 Haz 2026', targetDate) === '15 Haz 2026', 'Adaptive Date matches Day Month Year (Turkish)');
assert(formatDateLikeInitial('12.06.2026', targetDate) === '15.06.2026', 'Adaptive Date matches DD.MM.YYYY');
assert(formatDateLikeInitial('12/06/2026', targetDate) === '15/06/2026', 'Adaptive Date matches DD/MM/YYYY');
assert(formatDateLikeInitial('2026-06-12', targetDate) === '2026-06-15', 'Adaptive Date matches YYYY-MM-DD');

// Time adaptiveness
assert(formatTimeLikeInitial('12:00 AM', targetDate) === '6:45 PM', 'Adaptive Time matches unpadded 12h format');
assert(formatTimeLikeInitial('07:30 PM', targetDate) === '06:45 PM', 'Adaptive Time matches padded 12h format');
assert(formatTimeLikeInitial('19:30', targetDate) === '18:45', 'Adaptive Time matches 24h format');

console.log('\n🎉 All locale formatting assertions passed successfully!');
