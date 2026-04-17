const TelegramBot = require('node-telegram-bot-api');
const { handleStart } = require('./commands/start');
const { handleCollect } = require('./commands/collect');
const { handleBattleCommand, handleAdminCancelBattle, startBattleExpiry } = require('./commands/battle');
const { handleRumbleCommand, handleJoinRumble, recoverRumbles } = require('./commands/rumble');
const { startDuelExpiryJob } = require('./commands/duel');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleTextInput, handleDeposit } = require('./handlers/funds');
const { sendTokens } = require('../solana/withdraw');
const { 
  startDepositPoller, 
  sweepUserATA, 
  sweepAll, 
  findUserByATA, 
  rescanUser, 
  rescanAll, 
  debugUserDeposit, 
  forceSweepATA, 
  creditDepositsBySignatures, 
  getUserDepositAddress 
} = require('../solana/depositPoller');

const db = require('../db/queries');
const { pool } = require('../db');
const { formatBalance } = require('./commands/start');

require('dotenv').config();

// Escape Telegram Markdown v1 special chars
function escMd(str) {
  if (!str) return '';
  return str.replace(/[_*`\[]/g, '');
}

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

  // ── /deposit ──
  bot.onText(/\/deposit/, async (msg) => {
    await handleDeposit(bot, msg.chat.id, msg.from.id, null);
  });

  // ── /rumble ──
  bot.onText(/\/rumble(.*)/, async (msg, match) => {
    const args = match[1].trim().split(/\s+/).filter(Boolean);
    await handleRumbleCommand(bot, msg, args);
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
      `▸ /collect — Claim free $YC (5m cooldown)\n` +
      `▸ /deposit — Get your personal deposit address\n` +
      `▸ /battle <amount> — Create a battle\n` +
      `▸ /help — Show this message\n\n` +
      `*Balances:*\n` +
      `▸ 🎰 *Gamble* — Used for battles & collects\n` +
      `▸ 💲 *Spot* — Used for withdrawals\n\n` +
      `Transfer between balances via 🧰 Manage Funds.\n` +
      `Minimum withdrawal: *1,000 $YC* to Spot.\n\n` +
      `*Referrals:* Earn *500 $YC* per friend!\n\n` +
      `🌐 Website: ${process.env.BASE_URL || 'coming soon'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Admin Commands ──
  const isAdmin = (telegramId) => {
    const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
    return admins.includes(String(telegramId));
  };

  // Shared approve/reject logic
  async function processApproval(chatId, withdrawalId) {
    const withdrawal = await db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} not found.`);
    if (withdrawal.status !== 'pending') return await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} is already ${withdrawal.status}.`);

    await db.updateWithdrawalStatus(withdrawalId, 'processing');
    await bot.sendMessage(chatId, `🔄 Processing withdrawal #${withdrawalId}...`);

    const netAmount = withdrawal.amount - (withdrawal.fee || 0);
    try {
      const txHash = await sendTokens(withdrawal.solana_address, netAmount);
      await db.updateWithdrawalStatus(withdrawalId, 'completed', txHash);
      await bot.sendMessage(chatId, `✅ Withdrawal #${withdrawalId} completed!\nTX: \`${txHash}\``, { parse_mode: 'Markdown' });
      try {
        await bot.sendMessage(withdrawal.user_id,
          `✅ *Withdrawal Complete!*\n\nAmount: \`${formatBalance(netAmount)}\` $YC\nTX: \`${txHash}\`\n\nYour tokens are on their way! 🐱`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    } catch (err) {
      console.error(`[APPROVE] Withdrawal #${withdrawalId} sendTokens failed:`, err.message);
      try {
        await db.updateWithdrawalStatus(withdrawalId, 'failed', null, err.message);
        await db.refundWithdrawal(withdrawal);
      } catch (dbErr) {
        console.error(`[APPROVE] DB refund error for #${withdrawalId}:`, dbErr.message);
      }
      await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} failed:\n\`${err.message}\`\n\nBalance has been refunded to user.`, { parse_mode: 'Markdown' });
      try {
        await bot.sendMessage(withdrawal.user_id,
          `❌ *Withdrawal Failed*\n\nYour \`${formatBalance(withdrawal.amount)}\` $YC has been refunded to your Spot Balance.\nPlease try again.`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    }
  }

  async function processRejection(chatId, withdrawalId) {
    const withdrawal = await db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} not found.`);
    if (withdrawal.status !== 'pending') return await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} is already ${withdrawal.status}.`);
    await db.refundWithdrawal(withdrawal);
    await bot.sendMessage(chatId, `✅ Rejected & refunded #${withdrawalId}.`);
    try {
      await bot.sendMessage(withdrawal.user_id,
        `❌ *Withdrawal Rejected*\n\nYour \`${formatBalance(withdrawal.amount)}\` $YC has been refunded.\nContact support if you have questions.`,
        { parse_mode: 'Markdown' }
      );
    } catch { }
  }

  bot.onText(/\/approve[_ ](\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    await processApproval(msg.chat.id, parseInt(match[1]));
  });

  bot.onText(/\/reject[_ ](\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    await processRejection(msg.chat.id, parseInt(match[1]));
  });

  bot.onText(/\/pending/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const pending = await db.getPendingWithdrawals();
    if (pending.length === 0) return await bot.sendMessage(msg.chat.id, `✅ No pending withdrawals.`);
    let text = `📋 *Pending Withdrawals (${pending.length}):*\n\n`;
    pending.forEach(w => {
      text += `#${w.id} — \`${formatBalance(w.amount)}\` $YC\n`;
      text += `User: @${w.username || w.first_name || w.user_id}\n`;
      text += `Address: \`${w.solana_address.slice(0, 12)}...\`\n`;
      text += `/approve_${w.id} | /reject_${w.id}\n\n`;
    });
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });

  // ── /cancelpvp <id> — Admin force-cancel any open PvP battle ──
  bot.onText(/\/cancelpvp(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const args = match[1] ? [match[1]] : [];
    await handleAdminCancelBattle(bot, msg, args);
  });
// ── /credituser <telegramId> <amount> — Admin manually credit a user ──
bot.onText(/\/credituser(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const chatId = msg.chat.id;
  const targetId = match[1];
  const amount = parseFloat(match[2]);

  if (!targetId || isNaN(amount) || amount <= 0) {
    return bot.sendMessage(chatId,
      `Usage: /credituser &lt;telegramId&gt; &lt;amount&gt;`,
      { parse_mode: 'HTML' }
    );
  }

  const user = await db.getUser(targetId);
  if (!user) {
    return bot.sendMessage(chatId, `❌ User ${targetId} not found.`);
  }

  await pool.query(
    'UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
    [amount, String(targetId)]
  );

  await bot.sendMessage(chatId,
    `✅ Credited <b>${formatBalance(amount)}</b> $YC to @${user.username || user.first_name || targetId}'s Gamble balance.`,
    { parse_mode: 'HTML' }
  );

  try {
    await bot.sendMessage(targetId,
      `🎁 <b>You've been credited ${formatBalance(amount)} $YC</b> to your Gamble balance by an admin!`,
      { parse_mode: 'HTML' }
    );
  } catch {}
});
  // Callback Queries
  bot.on('callback_query', async (query) => {
    await handleCallbackQuery(bot, query);
  });

  // Text Messages
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    await handleTextInput(bot, msg);
  });

  bot.on('polling_error', (err) => {
    if (!err.message?.includes('ETELEGRAM')) console.error('Polling error:', err.message);
  });

  // Start services
  startDepositPoller(bot);
  startDuelExpiryJob(bot);
  recoverRumbles(bot);
  startBattleExpiry(bot);

  console.log('✅ YellowCatz Bot is running!');
  return bot;
}

module.exports = { createBot };
