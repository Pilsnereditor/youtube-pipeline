const fs = require('fs');
const readline = require('readline');
const path = require('path');

const logPath = 'C:\\Users\\nesim\\.gemini\\antigravity\\brain\\d167de64-9d7f-49d4-a639-b277c39f88ea\\.system_generated\\logs\\transcript.jsonl';

async function readLogs() {
  const fileStream = fs.createReadStream(logPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const userMessages = [];
  let stepIndex = 0;

  for await (const line of rl) {
    try {
      const step = JSON.parse(line);
      stepIndex++;
      if (step.type === 'USER_INPUT') {
        userMessages.push({ stepIndex, content: step.content });
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  console.log(`Total steps: ${stepIndex}`);
  console.log(`User messages count: ${userMessages.length}`);
  
  console.log('\n--- LAST 10 USER MESSAGES ---');
  const lastN = userMessages.slice(-10);
  for (const msg of lastN) {
    console.log(`\n[Step ${msg.stepIndex}] USER:`);
    console.log(msg.content.substring(0, 1000));
  }
}

readLogs();
