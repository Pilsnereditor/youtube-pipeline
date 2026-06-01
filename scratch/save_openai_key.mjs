import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'pipeline.db'));

const key = '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';

db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('openai_api_key', ?)").run(key);

const check = db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get();
console.log('✅ OpenAI API key saved. Starts with:', check.value.substring(0, 20) + '...');
db.close();
