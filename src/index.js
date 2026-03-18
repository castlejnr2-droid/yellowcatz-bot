require('dotenv').config();
const { createBot } = require('./bot/bot');
const { createServer } = require('./server/index');
const { getDbAsync } = require('./db/index');

async function main() {
  console.log('🐱 Starting YellowCatz...\n');

  // Initialize database (async for sql.js)
  await getDbAsync();

  // Start web server
  createServer();

  // Start Telegram bot
  createBot();

  console.log('\n✅ YellowCatz is fully running!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
