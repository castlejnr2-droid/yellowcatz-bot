const TelegramBot = require('node-telegram-bot-api');
const { handleStart } = require('./commands/start');
const { handleCollect } = require('./commands/collect');
const { handleBattleCommand } = require('./commands/battle');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleTextInput, handleDeposit } = require('./handlers/funds');
const { sendTokens } = require('../solana/withdraw');
const { startDepositPoller, sweepUserATA, sweepAll, findUserByATA, rescanUser, rescanAll } = require('../solana/depositPoller');
const db = require('../db/queries');
const { formatBalance } = require('./commands/start');

require('dotenv').config();

// Escape Telegram Markdown v1 special chars in user-provided text
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

    const netAmount = withdrawal.amount - (withdrawal.fee || 0);
    try {
      const txHash = await sendTokens(withdrawal.solana_address, netAmount);
      await db.updateWithdrawalStatus(withdrawalId, 'completed', txHash);
      await bot.sendMessage(msg.chat.id, `✅ Withdrawal #${withdrawalId} completed!\nTX: \`${txHash}\``, { parse_mode: 'Markdown' });

      // Notify user
      try {
        await bot.sendMessage(withdrawal.user_id,
          `✅ *Withdrawal Complete!*\n\n` +
          `Amount: \`${formatBalance(netAmount)}\` $YC\n` +
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

  // /totaldeposited — per-user deposit ranking (admin only)
  bot.onText(/\/totaldeposited$/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    try {
      const rows = await db.getDepositLeaderboard();
      const grand = rows.reduce((s, r) => s + parseFloat(r.total_deposited), 0);
      const active = rows.filter(r => parseFloat(r.total_deposited) > 0);

      let text = `📥 *Total Deposited Leaderboard*\n\n`;
      text += `💰 *Grand Total:* \`${formatBalance(grand)}\` $YC\n`;
      text += `👥 *Depositors:* ${active.length}\n\n`;

      if (active.length === 0) {
        text += `_No deposits yet._`;
      } else {
        active.forEach((r, i) => {
          const label = r.username ? `@${escMd(r.username)}` : (escMd(r.first_name) || `ID:${r.telegram_id}`);
          text += `${i + 1}. ${label} — \`${formatBalance(r.total_deposited)}\` (${r.num_deposits} tx)\n`;
        });
      }

      if (text.length <= 4096) {
        await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
      } else {
        const lines = text.split('\n');
        let chunk = '';
        for (const line of lines) {
          if ((chunk + line + '\n').length > 4000) {
            await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
            chunk = '';
          }
          chunk += line + '\n';
        }
        if (chunk.trim()) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /totalwithdrawals — per-user withdrawal breakdown with approve/reject for pending (admin only)
  bot.onText(/\/totalwithdrawals$/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    try {
      const rows = await db.getWithdrawalBreakdown();
      const pending = await db.getPendingWithdrawals();

      const grandRequested = rows.reduce((s, r) => s + parseFloat(r.total_requested), 0);
      const grandCompleted = rows.reduce((s, r) => s + parseFloat(r.total_completed), 0);
      const grandPending = rows.reduce((s, r) => s + parseFloat(r.total_pending), 0);

      let text = `📤 *Total Withdrawals Breakdown*\n\n`;
      text += `💰 *Requested:* \`${formatBalance(grandRequested)}\` $YC\n`;
      text += `✅ *Processed:* \`${formatBalance(grandCompleted)}\` $YC\n`;
      text += `⏳ *Pending:* \`${formatBalance(grandPending)}\` $YC\n\n`;

      if (rows.length === 0) {
        text += `_No withdrawals yet._\n`;
      } else {
        text += `*Per User (by total requested):*\n\n`;
        rows.forEach((r, i) => {
          const label = r.username ? `@${escMd(r.username)}` : (escMd(r.first_name) || `ID:${r.telegram_id}`);
          text += `*${i + 1}. ${label}*\n`;
          text += `  Total: \`${formatBalance(r.total_requested)}\` (${r.num_total} req)\n`;
          if (parseInt(r.num_completed) > 0) text += `  ✅ Done: \`${formatBalance(r.total_completed)}\` (${r.num_completed})\n`;
          if (parseInt(r.num_pending) > 0) text += `  ⏳ Pending: \`${formatBalance(r.total_pending)}\` (${r.num_pending})\n`;
          if (parseInt(r.num_failed) > 0) text += `  ❌ Failed: \`${formatBalance(r.total_failed)}\` (${r.num_failed})\n`;
          text += `\n`;
        });
      }

      // Send the breakdown (paginated)
      if (text.length <= 4096) {
        await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
      } else {
        const lines = text.split('\n');
        let chunk = '';
        for (const line of lines) {
          if ((chunk + line + '\n').length > 4000) {
            await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
            chunk = '';
          }
          chunk += line + '\n';
        }
        if (chunk.trim()) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
      }

      // Show pending with approve/reject buttons
      if (pending.length > 0) {
        for (const w of pending) {
          const label = w.username ? `@${escMd(w.username)}` : (escMd(w.first_name) || `ID:${w.user_id}`);
          await bot.sendMessage(msg.chat.id,
            `⏳ *Pending #${w.id}*\n` +
            `User: ${label}\n` +
            `Amount: \`${formatBalance(w.amount)}\` $YC\n` +
            `Address: \`${w.solana_address}\``,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `admin_approve_${w.id}` },
                  { text: '❌ Reject', callback_data: `admin_reject_${w.id}` }
                ]]
              }
            }
          );
        }
      }
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /rescan — rescan ALL user ATAs for missed deposits (admin only)
  bot.onText(/\/rescan$/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    await bot.sendMessage(msg.chat.id, `🔍 Rescanning all user ATAs for missed deposits...`);
    try {
      const results = await rescanAll(bot);
      if (results.length === 0) {
        return await bot.sendMessage(msg.chat.id, `✅ No missed deposits found.`);
      }
      let text = `✅ *Rescan Complete\\!*\n\n`;
      let grandTotal = 0;
      for (const r of results) {
        const userTotal = r.deposits.reduce((s, d) => s + d.amount, 0);
        grandTotal += userTotal;
        text += `• User ${r.telegramId}: \`${formatBalance(userTotal)}\` $YC (${r.deposits.length} tx)\n`;
      }
      text += `\n💰 *Total recovered:* \`${formatBalance(grandTotal)}\` $YC`;
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Rescan error: ${err.message}`);
    }
  });

  // /rescan_<telegramId> — rescan a single user (admin only)
  bot.onText(/\/rescan_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = match[1];
    await bot.sendMessage(msg.chat.id, `🔍 Rescanning deposits for user ${targetId}...`);
    try {
      const results = await rescanUser(targetId, bot);
      if (results.length === 0) {
        return await bot.sendMessage(msg.chat.id, `✅ No missed deposits for user ${targetId}.`);
      }
      const total = results.reduce((s, d) => s + d.amount, 0);
      let text = `✅ *Found ${results.length} missed deposit(s)!*\n\n`;
      results.forEach(d => {
        text += `• \`${formatBalance(d.amount)}\` $YC — TX: \`${d.signature.slice(0, 16)}...\`\n`;
      });
      text += `\n💰 *Total credited:* \`${formatBalance(total)}\` $YC`;
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /whoseata <address> — find which user owns an ATA (admin only)
  bot.onText(/\/whoseata\s+(.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const address = match[1].trim();
    const user = await findUserByATA(address);
    if (user) {
      const label = user.username ? `@${escMd(user.username)}` : (escMd(user.first_name) || `ID:${user.telegram_id}`);
      await bot.sendMessage(msg.chat.id, `🔍 ATA \`${address}\` belongs to *${label}* (${user.telegram_id})`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, `❌ No user found with that ATA address.`);
    }
  });

  // /sweep — sweep all user ATA tokens to hot wallet (admin only)
  bot.onText(/\/sweep$/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    await bot.sendMessage(msg.chat.id, `🔄 Sweeping all user ATAs to hot wallet...`);
    try {
      const results = await sweepAll();
      if (results.length === 0) {
        return await bot.sendMessage(msg.chat.id, `✅ Nothing to sweep — all ATAs are empty.`);
      }
      let text = `✅ *Sweep Complete!*\n\n`;
      let total = 0;
      results.forEach(r => {
        total += r.amount;
        text += `• User ${r.telegramId}: \`${formatBalance(r.amount)}\` $YC\n  TX: \`${r.signature.slice(0, 16)}...\`\n`;
      });
      text += `\n💰 *Total swept:* \`${formatBalance(total)}\` $YC`;
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Sweep error: ${err.message}`);
    }
  });

  // /sweep_<telegramId> — sweep a single user's ATA (admin only)
  bot.onText(/\/sweep_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = match[1];
    await bot.sendMessage(msg.chat.id, `🔄 Sweeping ATA for user ${targetId}...`);
    try {
      const result = await sweepUserATA(targetId);
      if (!result) {
        return await bot.sendMessage(msg.chat.id, `✅ Nothing to sweep — ATA empty or doesn't exist.`);
      }
      await bot.sendMessage(msg.chat.id,
        `✅ *Swept ${formatBalance(result.amount)} $YC* from user ${targetId}\nTX: \`${result.signature}\``,
        { parse_mode: 'Markdown' });
    } catch (err) {
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
  bot.onText(/\/totalclaimed$/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
      return await bot.sendMessage(msg.chat.id, `⛔ Not authorized.`);
    }
    let rows;
    try {
      rows = await db.getTotalClaimedLeaderboard();
    } catch (err) {
      console.error('[totalclaimed] DB error:', err.message);
      return await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total_claimed), 0);

    let text = `🏆 *Total Claimed Leaderboard*\n\n`;
    text += `💰 *Grand Total:* \`${formatBalance(grandTotal)}\` $YC\n\n`;

    const topRows = rows.filter(r => parseFloat(r.total_claimed) > 0);
    if (topRows.length === 0) {
      text += `_No claims yet._`;
    } else {
      topRows.forEach((r, i) => {
        const label = r.username ? `@${escMd(r.username)}` : (escMd(r.first_name) || `ID:${r.telegram_id}`);
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
