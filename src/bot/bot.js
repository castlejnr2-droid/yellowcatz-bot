const TelegramBot = require('node-telegram-bot-api');
const { handleStart } = require('./commands/start');
const { handleCollect } = require('./commands/collect');
const { handleBattleCommand } = require('./commands/battle');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleTextInput, handleDeposit } = require('./handlers/funds');
const { sendTokens } = require('../solana/withdraw');
const { startDepositPoller } = require('../solana/depositPoller');
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

  // ── /deposit ──
  bot.onText(/\/deposit/, async (msg) => {
    await handleDeposit(bot, msg.chat.id, msg.from.id, null);
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

  // /approve_<id>
  bot.onText(/\/approve_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const withdrawalId = parseInt(match[1]);
    const withdrawal = await db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(msg.chat.id, `❌ Withdrawal #${withdrawalId} not found.`);
    if (withdrawal.status !== 'pending') return await bot.sendMessage(msg.chat.id, `❌ Already ${withdrawal.status}.`);

    await db.updateWithdrawalStatus(withdrawalId, 'processing');
    await bot.sendMessage(msg.chat.id, `🔄 Processing withdrawal #${withdrawalId}...`);

    try {
      const txHash = await sendTokens(withdrawal.solana_address, withdrawal.amount);
      await db.updateWithdrawalStatus(withdrawalId, 'completed', txHash);
      await bot.sendMessage(msg.chat.id, `✅ Withdrawal #${withdrawalId} completed!\nTX: \`${txHash}\``, { parse_mode: 'Markdown' });

      // Notify user
      try {
        await bot.sendMessage(withdrawal.user_id,
          `✅ *Withdrawal Complete!*\n\n` +
          `Amount: \`${formatBalance(withdrawal.amount)}\` $YC\n` +
          `TX: \`${txHash}\`\n\n` +
          `Your tokens are on their way! 🐱`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    } catch (err) {
      await db.updateWithdrawalStatus(withdrawalId, 'failed', null, err.message);
      await db.refundWithdrawal(withdrawal);
      await bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}\nBalance refunded.`);
      try {
        await bot.sendMessage(withdrawal.user_id,
          `❌ *Withdrawal Failed*\n\n` +
          `Your \`${formatBalance(withdrawal.amount)}\` $YC has been refunded to your Spot Balance.\n` +
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
    const withdrawal = await db.getWithdrawalById(withdrawalId);
    if (!withdrawal) return await bot.sendMessage(msg.chat.id, `❌ Not found.`);
    await db.refundWithdrawal(withdrawal);
    await bot.sendMessage(msg.chat.id, `✅ Rejected & refunded #${withdrawalId}.`);
    try {
      await bot.sendMessage(withdrawal.user_id,
        `❌ *Withdrawal Rejected*\n\n` +
        `Your \`${formatBalance(withdrawal.amount)}\` $YC has been refunded.\n` +
        `Contact support if you have questions.`,
        { parse_mode: 'Markdown' }
      );
    } catch { }
  });

  // /pending — show pending withdrawals
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

  // /reset_mainnet — ONE-TIME reset for mainnet launch (admin only)
  bot.onText(/\/reset_mainnet/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const { pool } = require('../db');
      const resetSQL = fs.readFileSync(path.join(__dirname, '../db/reset-for-mainnet.sql'), 'utf8');
      await pool.query(resetSQL);
      await bot.sendMessage(msg.chat.id,
        `✅ *MAINNET RESET COMPLETE*\n\n` +
        `• All balances → 0\n` +
        `• All history cleared\n` +
        `• Deposit ATAs cleared (will regenerate)\n\n` +
        `🚀 Ready for token launch!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Reset failed: ${err.message}`);
    }
  });

  // /overview — detailed per-user breakdown (admin only)
  bot.onText(/\/overview/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    try {
      const rows = await db.getUserBreakdown();
      if (rows.length === 0) return await bot.sendMessage(msg.chat.id, `📊 No users yet.`);

      const grandClaimed = rows.reduce((s, r) => s + parseFloat(r.total_claimed), 0);
      const grandDeposited = rows.reduce((s, r) => s + parseFloat(r.total_deposited), 0);
      const grandWRequested = rows.reduce((s, r) => s + parseFloat(r.total_w_requested), 0);
      const grandWCompleted = rows.reduce((s, r) => s + parseFloat(r.total_w_completed), 0);

      let header = `📊 *User Overview* (${rows.length} users)\n\n`;
      header += `💰 Total Claimed: \`${formatBalance(grandClaimed)}\`\n`;
      header += `📥 Total Deposited: \`${formatBalance(grandDeposited)}\`\n`;
      header += `📤 Total W/D Requested: \`${formatBalance(grandWRequested)}\`\n`;
      header += `✅ Total W/D Processed: \`${formatBalance(grandWCompleted)}\`\n`;
      header += `━━━━━━━━━━━━━━━━━━━━\n\n`;

      const chunks = [header];
      let current = header;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const label = r.username ? `@${r.username}` : (r.first_name || `ID:${r.telegram_id}`);
        let entry = `*${i + 1}. ${label}*\n`;
        entry += `  💰 Claimed: \`${formatBalance(r.total_claimed)}\`\n`;
        entry += `  📥 Deposited: \`${formatBalance(r.total_deposited)}\`\n`;
        if (parseFloat(r.total_w_requested) > 0) {
          entry += `  📤 W/D: \`${formatBalance(r.total_w_requested)}\` (${r.num_w_requested} req)\n`;
          if (parseInt(r.num_w_completed) > 0) entry += `    ✅ Done: \`${formatBalance(r.total_w_completed)}\` (${r.num_w_completed})\n`;
          if (parseInt(r.num_w_pending) > 0) entry += `    ⏳ Pending: \`${formatBalance(r.total_w_pending)}\` (${r.num_w_pending})\n`;
          if (parseInt(r.num_w_failed) > 0) entry += `    ❌ Failed: \`${formatBalance(r.total_w_failed)}\` (${r.num_w_failed})\n`;
        }
        entry += `\n`;

        if ((current + entry).length > 4000) {
          await bot.sendMessage(msg.chat.id, current, { parse_mode: 'Markdown' });
          current = entry;
        } else {
          current += entry;
        }
      }
      if (current.trim()) await bot.sendMessage(msg.chat.id, current, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[Overview] Error:', err.message);
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /stats — admin stats
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const stats = await db.getStats();
    await bot.sendMessage(msg.chat.id,
      `📊 *YellowCatz Stats*\n\n` +
      `👥 Users: \`${stats.users}\`\n` +
      `💰 Total Collected: \`${formatBalance(stats.totalCollected)}\` $YC\n` +
      `⚔️ Total Battles: \`${stats.totalBattles}\`\n` +
      `🏧 Total Withdrawn: \`${formatBalance(stats.totalWithdrawn)}\` $YC`,
      { parse_mode: 'Markdown' }
    );
  });

  // /totalclaimed — ranked breakdown of tokens claimed per user (admin only)
  bot.onText(/\/totalclaimed/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      return await bot.sendMessage(msg.chat.id, `⛔ Not authorized.`);
    }
    const rows = await db.getTotalClaimedLeaderboard();
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_claimed), 0);

    let text = `🏆 *Total Claimed Leaderboard*\n\n`;
    text += `💰 *Grand Total:* \`${formatBalance(grandTotal)}\` $YC\n\n`;

    const topRows = rows.filter(r => parseFloat(r.total_claimed) > 0);
    if (topRows.length === 0) {
      text += `_No claims yet._`;
    } else {
      topRows.forEach((r, i) => {
        const label = r.username ? `@${r.username}` : (r.first_name || `ID:${r.telegram_id}`);
        text += `${i + 1}. ${label} — \`${formatBalance(parseFloat(r.total_claimed))}\`\n`;
      });
    }

    // Telegram messages max 4096 chars; split if needed
    if (text.length <= 4096) {
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } else {
      const header = text.slice(0, text.indexOf('\n\n', text.indexOf('Grand Total')) + 2);
      const lines = text.slice(header.length).split('\n');
      let chunk = header;
      for (const line of lines) {
        if ((chunk + line + '\n').length > 4096) {
          await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
          chunk = '';
        }
        chunk += line + '\n';
      }
      if (chunk.trim()) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
    }
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
    if (!err.message?.includes('ETELEGRAM')) console.error('Polling error:', err.message);
  });

  bot.on('error', (err) => {
    console.error('Bot error:', err.message);
  });

  // Start deposit poller
  startDepositPoller(bot);

  console.log('✅ YellowCatz Bot is running!');
  return bot;
}

module.exports = { createBot };
