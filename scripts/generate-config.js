const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const outputPath = path.join(__dirname, '..', 'extension', 'config.js');

const env = fs.readFileSync(envPath, 'utf8');
const match = env.match(/OPENAI_API_KEY=([^\n\r]+)/);
if (!match) {
  console.error('OPENAI_API_KEY not found in .env');
  process.exit(1);
}

const key = match[1].trim();
const contents = `export const OPENAI_API_KEY = '${key.replace(/'/g, "\\'")}';\n`;
fs.writeFileSync(outputPath, contents, 'utf8');
console.log(`Wrote ${outputPath}`);
