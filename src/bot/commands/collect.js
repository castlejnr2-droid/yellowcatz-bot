const db = require('../../db/queries');

const MIN_COLLECT = 10;
const MAX_COLLECT = 100;
const REFERRAL_BONUS = 50;

// Tiers ordered highest-first so the first match wins
const TIERS = [
  { name: 'Elite',   emoji: '👑', minCollected: 10000, cooldownMs: 60 * 60 * 1000, label: '1 hour' },
  { name: 'Veteran', emoji: '⭐', minCollected: 1000,  cooldownMs: 30 * 60 * 1000, label: '30 mins' },
  { name: 'Starter', emoji: '🌱', minCollected: 0,     cooldownMs:  5 * 60 * 1000, label: '5 mins' },
];

function getTier(totalCollected) {
  const n = Number(totalCollected || 0);
  for (const tier of TIERS) {
    if (n >= tier.minCollected) return tier;
  }
  return TIERS[TIERS.length - 1];
}

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
  const tier = getTier(user.total_collected);
  // Require minimum 5,000 $YC gamble balance to collect
if (Number(user.gamble_balance || 0) < 5000) {
  return bot.sendMessage(chatId,
    `🚫 *Insufficient Gamble Balance*\n\n` +
    `You need at least *5,000 $YC* in your Gamble balance to collect.\n\n` +
    `Your current Gamble balance: *${Number(user.gamble_balance || 0).toLocaleString()} $YC*\n\n` +
    `_Deposit $YC to your wallet and transfer to Gamble balance to start collecting!_`,
    { parse_mode: 'Markdown' }
  );
}

  // Check cooldown
  if (user.last_collect_at) {
    const elapsed = Date.now() - new Date(user.last_collect_at).getTime();
    if (elapsed < tier.cooldownMs) {
      const remaining = tier.cooldownMs - elapsed;
      await bot.sendMessage(chatId,
        `🐱 Patience, little catz!\n\n` +
        `⏳ You can collect again in *${msToMinSec(remaining)}*.\n\n` +
        `🏆 Tier: *${tier.emoji} ${tier.name}* — cooldown ${tier.label}\n\n` +
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
  const newTier = getTier(refreshedUser.total_collected);
  const newBalance = Number(refreshedUser.gamble_balance || 0);

  const catEmojis = ['🐱', '😺', '😸', '🐾', '🌟', '💛', '✨'];
  const randomCat = catEmojis[Math.floor(Math.random() * catEmojis.length)];

  await bot.sendMessage(chatId,
    `${randomCat} *Collect Success!*\n\n` +
    `✅ Collected *${amount.toLocaleString()} $YC*!\n` +
    `💰 Gamble Balance: \`${newBalance.toLocaleString()} $YC\`\n` +
    `⏱ Next collect in: *${newTier.label}*\n` +
    `🏆 Collector tier: *${newTier.emoji} ${newTier.name}*`,
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

module.exports = { handleCollect, getTier, TIERS };
