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

  const steps = [];
  let stepIndex = 0;

  for await (const line of rl) {
    try {
      const step = JSON.parse(line);
      stepIndex++;
      steps.push({ stepIndex, type: step.type, content: step.content });
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Print steps from index 2038 to 2056
  const relevantSteps = steps.filter(s => s.stepIndex >= 2038 && s.stepIndex <= 2057);
  for (const s of relevantSteps) {
    console.log(`\n========================================`);
    console.log(`Step ${s.stepIndex} - Type: ${s.type}`);
    console.log(`========================================`);
    console.log(s.content);
  }
}

readLogs();
