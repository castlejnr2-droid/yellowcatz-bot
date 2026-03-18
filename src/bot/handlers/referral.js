const db = require('../../db/queries');
const { formatBalance } = require('../commands/start');

require('dotenv').config();

const BOT_USERNAME = process.env.BOT_USERNAME || 'YellowCatzBot';

async function showReferralMenu(bot, chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) return;

  const stats = db.getReferralStats(telegramId);
  const refLink = `https://t.me/${BOT_USERNAME}?start=${user.referral_code}`;

  const text =
    `👥 *Referral Program*\n\n` +
    `🐱 Invite friends and earn *500 $YellowCatz* for each one!\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📊 *Your Stats:*\n` +
    `👥 Total Referrals: \`${stats.count}\`\n` +
    `💰 Total Earned: \`${formatBalance(stats.totalEarned)} $YellowCatz\`\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `🔗 *Your Referral Link:*\n` +
    `\`${refLink}\`\n\n` +
    `_Share this link with friends. When they join and collect for the first time, you earn the bonus!_ 🐾`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Share Link', switch_inline_query: `Join me on YellowCatz! Use my link: ${refLink}` }],
        [{ text: '🏠 Back', callback_data: 'back_main' }]
      ]
    }
  });
}

module.exports = { showReferralMenu };
