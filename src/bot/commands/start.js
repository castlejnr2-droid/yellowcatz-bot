const db = require('../../db/queries');
require('dotenv').config();

const COLLECT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function formatBalance(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function getMainMenuKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: '🧰 Manage Funds', callback_data: 'menu_funds' },
        { text: '⚔️ Battles', callback_data: 'menu_battles' }
      ],
      [
        { text: '👥 Referral Program', callback_data: 'menu_referral' },
        { text: '🏆 Leaderboard', callback_data: 'menu_leaderboard' }
      ],
      [
        { text: '🔄 Refresh', callback_data: 'menu_refresh' }
      ]
    ]
  };
}

function getPortfolioText(user) {
  const gamble = formatBalance(user.gamble_balance);
  const spot = formatBalance(user.spot_balance);
  const total = formatBalance((user.gamble_balance || 0) + (user.spot_balance || 0));
  const name = user.first_name || user.username || 'Catz Fan';

  return (
    `🐱 *Welcome, ${name}!*\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💛 *Your $YC Portfolio*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `🎰 Gamble Balance:  \`${gamble}\` $YC\n` +
    `💲 Spot Balance:    \`${spot}\` $YC\n` +
    `📊 Total:           \`${total}\` $YC\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💡 _Tip: Use /collect to earn free tokens!_\n` +
    `💡 _Use /battle <amount> to challenge someone!_`
  );
}

async function handleStart(bot, msg, referralCode) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  // Only allow /start in private chats
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId,
      `❌ The */start* command is only allowed in private chats. Please start a private chat with the bot.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let referredBy = null;
  if (referralCode && referralCode.startsWith('ref_')) {
    const referrer = await db.getUserByReferralCode(referralCode);
    if (referrer && String(referrer.telegram_id) !== String(telegramId)) {
      referredBy = referralCode;
    }
  }

  const user = await db.getOrCreateUser({ telegramId, username, firstName, referredBy });
  console.log(`[START] User ${telegramId} balance:`, JSON.stringify({gamble: user?.gamble_balance, spot: user?.spot_balance}));

  await bot.sendMessage(chatId, getPortfolioText(user), {
    parse_mode: 'Markdown',
    reply_markup: getMainMenuKeyboard(chatId)
  });
}

async function handleRefresh(bot, chatId, telegramId, msgId) {
  const user = await db.getUser(telegramId);
  if (!user) return;
  if (msgId) {
    try {
      await bot.editMessageText(getPortfolioText(user), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(chatId)
      });
      return;
    } catch (err) {
      if (err && err.message && err.message.includes('message is not modified')) return;
    }
  }
  await bot.sendMessage(chatId, getPortfolioText(user), {
    parse_mode: 'Markdown',
    reply_markup: getMainMenuKeyboard(chatId)
  });
}

module.exports = { handleStart, handleRefresh, getMainMenuKeyboard, getPortfolioText, formatBalance };
