import { initDb, queryOne } from './server/db/database.js';
import { generateTitles } from './server/services/gemini.js';

async function main() {
  initDb();
  console.log("Generating titles list...");
  const titles = await generateTitles("General", 5, "", 1, "Oyun Bonusları");
  console.log("Generated Titles:", titles);
}

main().catch(console.error);
