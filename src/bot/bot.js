const TelegramBot = require('node-telegram-bot-api');
const { handleStart } = require('./commands/start');
const { handleCollect } = require('./commands/collect');
const { handleBattleCommand } = require('./commands/battle');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleTextInput } = require('./handlers/funds');
const { sendTokens } = require('../solana/withdraw');
const db = require('../db/queries');
const { formatBalance } = require('./commands/start');

require('dotenv').config();

function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set!');

  const bot = new TelegramBot(token, { polling: true });

  console.log('🤖 YellowCatz Bot starting...');

  // ── /start ──
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const referralCode = match[1] ? match[1].trim() : null;
    await handleStart(bot, msg, referralCode);
  });

  // ── /collect ──
  bot.onText(/\/collect/, async (msg) => {
    await handleCollect(bot, msg);
  });

  // ── /battle or /PvP ──
  bot.onText(/\/(?:battle|[Pp][Vv][Pp])(?:\s+(.+))?/, async (msg, match) => {
    const args = match[1] ? match[1].trim().split(/\s+/) : [];
    await handleBattleCommand(bot, msg, args);
  });

  // ── /help ──
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `🐱 *YellowCatz Bot Help*\n\n` +
      `*Commands:*\n` +
      `▸ /start — View portfolio & main menu\n` +
      `▸ /collect — Claim free $YellowCatz (5m cooldown)\n` +
      `▸ /battle <amount> — Create a battle\n` +
      `▸ /help — Show this message\n\n` +
      `*Balances:*\n` +
      `▸ 🎰 *Gamble* — Used for battles & collects\n` +
      `▸ 💲 *Spot* — Used for withdrawals\n\n` +
      `Transfer between balances via 🧰 Manage Funds.\n` +
      `Minimum withdrawal: *1,000 $YellowCatz* to Spot.\n\n` +
      `*Referrals:* Earn *500 $YellowCatz* per friend!\n\n` +
      `🌐 Website: ${process.env.BASE_URL || 'coming soon'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin Commands ──
  const isAdmin = (telegramId) => {
    const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
    return admins.includes(String(telegramId));
  };

  // /approve_<id>
  bot.onText(/\/approve_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const withdrawalId = parseInt(match[1]);
    const withdrawal = db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(msg.chat.id, `❌ Withdrawal #${withdrawalId} not found.`);
    if (withdrawal.status !== 'pending') return await bot.sendMessage(msg.chat.id, `❌ Already ${withdrawal.status}.`);

    db.updateWithdrawalStatus(withdrawalId, 'processing');
    await bot.sendMessage(msg.chat.id, `🔄 Processing withdrawal #${withdrawalId}...`);

    try {
      const txHash = await sendTokens(withdrawal.solana_address, withdrawal.amount);
      db.updateWithdrawalStatus(withdrawalId, 'completed', txHash);
      await bot.sendMessage(msg.chat.id, `✅ Withdrawal #${withdrawalId} completed!\nTX: \`${txHash}\``, { parse_mode: 'Markdown' });

      // Notify user
      try {
        await bot.sendMessage(withdrawal.user_id,
          `✅ *Withdrawal Complete!*\n\n` +
          `Amount: \`${formatBalance(withdrawal.amount)}\` $YellowCatz\n` +
          `TX: \`${txHash}\`\n\n` +
          `Your tokens are on their way! 🐱`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    } catch (err) {
      db.updateWithdrawalStatus(withdrawalId, 'failed', null, err.message);
      db.refundWithdrawal(withdrawal);
      await bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}\nBalance refunded.`);
      try {
        await bot.sendMessage(withdrawal.user_id,
          `❌ *Withdrawal Failed*\n\n` +
          `Your \`${formatBalance(withdrawal.amount)}\` $YellowCatz has been refunded to your Spot Balance.\n` +
          `Please try again.`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    }
  });

  // /reject_<id>
  bot.onText(/\/reject_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const withdrawalId = parseInt(match[1]);
    const withdrawal = db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(msg.chat.id, `❌ Not found.`);
    db.refundWithdrawal(withdrawal);
    await bot.sendMessage(msg.chat.id, `✅ Rejected & refunded #${withdrawalId}.`);
    try {
      await bot.sendMessage(withdrawal.user_id,
        `❌ *Withdrawal Rejected*\n\n` +
        `Your \`${formatBalance(withdrawal.amount)}\` $YellowCatz has been refunded.\n` +
        `Contact support if you have questions.`,
        { parse_mode: 'Markdown' }
      );
    } catch { }
  });

  // /pending — show pending withdrawals
  bot.onText(/\/pending/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const pending = db.getPendingWithdrawals();
    if (pending.length === 0) return await bot.sendMessage(msg.chat.id, `✅ No pending withdrawals.`);
    let text = `📋 *Pending Withdrawals (${pending.length}):*\n\n`;
    pending.forEach(w => {
      text += `#${w.id} — \`${formatBalance(w.amount)}\` $YellowCatz\n`;
      text += `User: @${w.username || w.first_name || w.user_id}\n`;
      text += `Address: \`${w.solana_address.slice(0, 12)}...\`\n`;
      text += `/approve_${w.id} | /reject_${w.id}\n\n`;
    });
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });

  // /stats — admin stats
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const stats = db.getStats();
    await bot.sendMessage(msg.chat.id,
      `📊 *YellowCatz Stats*\n\n` +
      `👥 Users: \`${stats.users}\`\n` +
      `💰 Total Collected: \`${formatBalance(stats.totalCollected)}\` $YellowCatz\n` +
      `⚔️ Total Battles: \`${stats.totalBattles}\`\n` +
      `🏧 Total Withdrawn: \`${formatBalance(stats.totalWithdrawn)}\` $YellowCatz`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Callback Queries ──
  bot.on('callback_query', async (query) => {
    await handleCallbackQuery(bot, query);
  });

  // ── Text Messages (multi-step flows) ──
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    await handleTextInput(bot, msg);
  });

  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  console.log('✅ YellowCatz Bot is running!');
  return bot;
}

module.exports = { createBot };
