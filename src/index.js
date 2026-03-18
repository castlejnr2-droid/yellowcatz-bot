require('dotenv').config();
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err.message); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err?.message || err); });

const { createBot } = require('./bot/bot');
const { createServer } = require('./server/index');
const { initSchema } = require('./db/index');

async function main() {
  console.log('🐱 Starting YellowCatz...\n');

  await initSchema();

  createServer();
  createBot();

  console.log('\n✅ YellowCatz is fully running!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
