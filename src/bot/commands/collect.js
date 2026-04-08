const db = require('../../db/queries');

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MIN_COLLECT = 10;
const MAX_COLLECT = 200;
const REFERRAL_BONUS = 50;

function randomCollectAmount() {
  return Math.floor(Math.random() * (MAX_COLLECT - MIN_COLLECT + 1)) + MIN_COLLECT;
}

function msToMinSec(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0 && secs > 0) return `${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

async function handleCollect(bot, msg) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  const user = await db.getOrCreateUser({ telegramId, username, firstName });

  // Check cooldown
  if (user.last_collect_at) {
    const lastCollect = new Date(user.last_collect_at).getTime();
    const now = Date.now();
    const elapsed = now - lastCollect;
    if (elapsed < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - elapsed;
      await bot.sendMessage(chatId,
        `🐱 Patience, little catz!\n\n` +
        `⏰ You can collect again in *${msToMinSec(remaining)}*.\n\n` +
        `_Come back soon for more $YC!_ 🐾`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }

  const amount = randomCollectAmount();
  console.log(`[COLLECT] User ${telegramId} collecting ${amount} tokens...`);
  try {
    await db.recordCollection(telegramId, amount);
    console.log(`[COLLECT] recordCollection done for ${telegramId}`);
  } catch (err) {
    console.error(`[COLLECT] ERROR:`, err.message);
    await bot.sendMessage(chatId, `❌ Error collecting tokens. Please try again.`);
    return;
  }

  // Handle first-collect referral bonus
  const collections = await db.getUserCollections(telegramId);
  if (collections.length === 1 && user.referred_by) {
    const referrer = await db.getUserByReferralCode(user.referred_by);
    if (referrer) {
      const credited = await db.creditReferral(referrer.telegram_id, telegramId, REFERRAL_BONUS);
      if (credited) {
        try {
          await bot.sendMessage(
            referrer.telegram_id,
            `🎉 *Referral Bonus!*\n\n` +
            `Your friend *${firstName || username || 'A user'}* just collected for the first time!\n` +
            `You earned *${REFERRAL_BONUS.toLocaleString()} $YC* bonus! 🐱💰`,
            { parse_mode: 'Markdown' }
          );
        } catch { /* user may have blocked bot */ }
      }
    }
  }

  const refreshedUser = await db.getUser(telegramId);
  console.log(`[COLLECT] After update, user ${telegramId} balance:`, JSON.stringify({gamble: refreshedUser?.gamble_balance, spot: refreshedUser?.spot_balance}));
  const newBalance = Number(refreshedUser.gamble_balance || 0);

  const catEmojis = ['🐱', '😺', '😸', '🐾', '🌟', '💛', '✨'];
  const randomCat = catEmojis[Math.floor(Math.random() * catEmojis.length)];

  await bot.sendMessage(chatId,
    `${randomCat} *Collect Success!*\n\n` +
    `💰 You collected *${amount.toLocaleString()} $YC* tokens!\n\n` +
    `🎰 Gamble Balance: \`${newBalance.toLocaleString()} $YC\`\n\n` +
    `_Come back in 5 minutes for more!_ ⏰`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🏠 Main Menu', callback_data: 'back_main' },
          { text: '⚔️ Go Battle!', callback_data: 'menu_battles' }
        ]]
      }
    }
  );
}

module.exports = { handleCollect };
