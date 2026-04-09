require('dotenv').config();
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack || '');
  // do NOT exit — keep the bot running
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
  // do NOT exit — keep the bot running
});

const { createBot } = require('./bot/bot');
const { createServer, setWebhookBot } = require('./server/index');
const { initSchema } = require('./db/index');

async function main() {
  console.log('🐱 Starting YellowCatz...\n');

  await initSchema();

  createServer();
  const bot = createBot();
  setWebhookBot(bot); // wire bot into webhook handler for deposit notifications

  console.log('\n✅ YellowCatz is fully running!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
