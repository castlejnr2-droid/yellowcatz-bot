const TelegramBot = require('node-telegram-bot-api');
const { handleStart } = require('./commands/start');
const { handleCollect } = require('./commands/collect');
const { handleBattleCommand } = require('./commands/battle');
const { startDuelExpiryJob } = require('./commands/duel');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleTextInput, handleDeposit } = require('./handlers/funds');
const { sendTokens } = require('../solana/withdraw');
const { startDepositPoller, sweepUserATA, sweepAll, findUserByATA, rescanUser, rescanAll, debugUserDeposit, forceSweepATA, creditDepositsBySignatures, getUserDepositAddress } = require('../solana/depositPoller');
const db = require('../db/queries');
const { pool } = require('../db');
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

  // ── Shared approve/reject logic ──
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
      console.error(`[APPROVE] Withdrawal #${withdrawalId} sendTokens failed:`, err.message, err.stack || '');
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
    if (withdrawal.status !== 'pending') return await bot.sendMessage(chatId, `❌ Withdrawal #${withdrawalId} is already ${withdrawal.status}. Only pending withdrawals can be rejected.`);
    await db.refundWithdrawal(withdrawal);
    await bot.sendMessage(chatId, `✅ Rejected & refunded #${withdrawalId}.`);
    try {
      await bot.sendMessage(withdrawal.user_id,
        `❌ *Withdrawal Rejected*\n\nYour \`${formatBalance(withdrawal.amount)}\` $YC has been refunded.\nContact support if you have questions.`,
        { parse_mode: 'Markdown' }
      );
    } catch { }
  }

  // /approve_<id>  OR  /approve <id>
  bot.onText(/\/approve[_ ](\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    await processApproval(msg.chat.id, parseInt(match[1]));
  });

  // /reject_<id>  OR  /reject <id>
  bot.onText(/\/reject[_ ](\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    await processRejection(msg.chat.id, parseInt(match[1]));
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

  // /credituser <telegramId> <amount> — manually credit a user's spot balance (admin only)
  bot.onText(/\/credituser\s+(\d+)\s+([\d.]+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = String(match[1]);
    const amount = parseFloat(match[2]);
    if (isNaN(amount) || amount <= 0) {
      return await bot.sendMessage(msg.chat.id, `❌ Invalid amount.`);
    }

    console.log(`[CreditUser] Starting manual credit: user=${targetId} amount=${amount}`);

    // Step 1: confirm user exists and read current balance
    const userCheck = await pool.query('SELECT telegram_id, spot_balance FROM users WHERE telegram_id = $1', [targetId]);
    if (userCheck.rows.length === 0) {
      console.error(`[CreditUser] ABORT — no user row found for telegram_id=${targetId}`);
      return await bot.sendMessage(msg.chat.id,
        `❌ User \`${targetId}\` not found in database. They must /start the bot first.`,
        { parse_mode: 'Markdown' }
      );
    }
    const balanceBefore = parseFloat(userCheck.rows[0].spot_balance) || 0;
    console.log(`[CreditUser] User found. spot_balance BEFORE = ${balanceBefore}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Step 2: update balance — capture rowCount to detect silent 0-row updates
      const updateRes = await client.query(
        'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
        [amount, targetId]
      );
      console.log(`[CreditUser] UPDATE rowCount = ${updateRes.rowCount}`);
      if (updateRes.rowCount === 0) {
        throw new Error(`UPDATE matched 0 rows for telegram_id=${targetId} — balance not changed`);
      }

      // Step 3: insert audit record (skip if deposits table FK would reject it)
      const syntheticSig = `manual_credit:${targetId}:${Date.now()}`;
      try {
        await client.query(
          'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
          [targetId, amount, syntheticSig, 'manual_admin_credit']
        );
      } catch (insertErr) {
        // FK violation means deposits table references users but the row wasn't found —
        // UPDATE already confirmed user exists so log this but don't block the credit
        console.warn(`[CreditUser] deposits INSERT skipped (${insertErr.message}) — balance update will still commit`);
      }

      await client.query('COMMIT');

      // Step 4: read back to confirm
      const afterRes = await pool.query('SELECT spot_balance FROM users WHERE telegram_id = $1', [targetId]);
      const balanceAfter = parseFloat(afterRes.rows[0]?.spot_balance) || 0;
      console.log(`[CreditUser] COMMITTED. spot_balance AFTER = ${balanceAfter} (expected ${balanceBefore + amount})`);

      await bot.sendMessage(msg.chat.id,
        `✅ *Manual Credit Applied*\n\n` +
        `User: \`${targetId}\`\n` +
        `Amount: \`${formatBalance(amount)}\` $YC\n` +
        `Balance: \`${formatBalance(balanceBefore)}\` → \`${formatBalance(balanceAfter)}\` $YC`,
        { parse_mode: 'Markdown' }
      );
      try {
        await bot.sendMessage(targetId,
          `✅ *Balance Credited!*\n\n\`${formatBalance(amount)}\` $YC has been added to your 💲 Spot Balance.`,
          { parse_mode: 'Markdown' }
        );
      } catch { }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[CreditUser] ROLLED BACK — ${err.message}`);
      await bot.sendMessage(msg.chat.id, `❌ Credit failed: ${err.message}`);
    } finally {
      client.release();
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

  // /checkdeposit <telegramId> — debug a user's deposit ATA (admin only)
  bot.onText(/\/checkdeposit\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const telegramId = match[1];
    await bot.sendMessage(msg.chat.id, `🔍 Checking deposit ATA for user ${telegramId}...`);
    try {
      const d = await debugUserDeposit(telegramId);

      let text = `🔍 *Deposit Debug — User ${telegramId}*\n\n`;

      text += `*Env Mint (YELLOWCATZ_TOKEN_MINT):*\n\`${d.mintEnvVar}\`\n\n`;

      text += `*Stored ATA (DB):*\n\`${d.storedAta || 'NOT SET'}\`\n\n`;

      text += `*Re-derived ATAs from current env:*\n`;
      if (d.derivedAta_token2022) {
        const match2022 = d.storedMatchesToken2022 ? '✅ matches stored' : '❌ MISMATCH vs stored';
        text += `• Token-2022: \`${d.derivedAta_token2022}\`\n  ${match2022}\n`;
      }
      if (d.derivedAta_stdToken) {
        const matchStd = d.storedMatchesStdToken ? '✅ matches stored' : '❌ MISMATCH vs stored';
        text += `• Std Token:  \`${d.derivedAta_stdToken}\`\n  ${matchStd}\n`;
      }
      text += '\n';

      text += `*On-chain balance of stored ATA:*\n`;
      text += `• Token-2022 program: \`${d.balance_token2022 ?? 'n/a'}\`\n`;
      text += `• Std Token program:  \`${d.balance_stdToken ?? 'n/a'}\`\n`;
      if (d.ataOnChainMint) {
        const mintMatch = d.ataOnChainMint === d.mintEnvVar ? '✅ matches env' : '❌ DIFFERENT from env!';
        text += `• ATA's actual mint:  \`${d.ataOnChainMint}\`\n  ${mintMatch}\n`;
      }

      if (d.errors.length > 0) {
        text += `\n*Errors:*\n`;
        d.errors.forEach(e => { text += `• ${e}\n`; });
      }

      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ checkdeposit error: ${err.message}`);
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
      const results = await sweepAll(bot);
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

  // /sweep_<telegramId> — credit + sweep a single user's ATA (admin only)
  bot.onText(/\/sweep_(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = match[1];
    await bot.sendMessage(msg.chat.id, `🔄 Processing deposit + sweep for user ${targetId}...`);
    try {
      // Credit any unprocessed deposits (real sig dedup) and notify user
      let userAta;
      try {
        userAta = getUserDepositAddress(targetId);
        await creditDepositsBySignatures(targetId, userAta, bot);
      } catch (creditErr) {
        console.error(`[Sweep] creditDepositsBySignatures failed for user ${targetId}:`, creditErr.message);
      }

      // Sweep remaining on-chain balance to hot wallet
      const result = await sweepUserATA(targetId);
      if (!result) {
        return await bot.sendMessage(msg.chat.id, `✅ Deposits credited. ATA empty or already swept.`);
      }
      await bot.sendMessage(msg.chat.id,
        `✅ *Swept ${formatBalance(result.amount)} $YC* from user ${targetId}\nTX: \`${result.signature}\``,
        { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /forcesweep <ataAddress> — sweep a specific ATA even if getAccount throws (admin only)
  // Uses getTokenAccountBalance so it works on "closed"-status Token-2022 accounts
  bot.onText(/\/forcesweep\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const ataAddress = match[1].trim();
    await bot.sendMessage(msg.chat.id, `🔄 Force-sweeping ATA \`${ataAddress.slice(0, 12)}...\``, { parse_mode: 'Markdown' });
    try {
      const result = await forceSweepATA(ataAddress);
      if (!result) {
        return await bot.sendMessage(msg.chat.id, `✅ Nothing to sweep — ATA balance is 0.`);
      }
      await bot.sendMessage(msg.chat.id,
        `✅ *Force Sweep Complete!*\n\n` +
        `ATA: \`${ataAddress}\`\n` +
        `User: \`${result.telegramId}\`\n` +
        `Amount: \`${formatBalance(result.amount)}\` $YC\n` +
        `TX: \`${result.signature}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Force sweep failed: ${err.message}`);
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

  // /housefees — show house fee balance (admin only)
  bot.onText(/\/housefees$/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    try {
      const house = await db.getHouseBalance();
      await bot.sendMessage(msg.chat.id,
        `🏠 *House Balance*\n\n` +
        `💰 Current balance: \`${formatBalance(house.balance)}\` $YC\n` +
        `📊 Total fees ever collected: \`${formatBalance(house.total_fees_collected)}\` $YC\n\n` +
        `🔢 Use /housewithdraw <amount> to transfer to your Spot Balance`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /housewithdraw <amount> — transfer from house balance to admin spot balance (admin only)
  bot.onText(/\/housewithdraw\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const amount = parseFloat(match[1]);
    if (isNaN(amount) || amount <= 0) {
      return await bot.sendMessage(msg.chat.id, `❌ Usage: /housewithdraw <amount>`);
    }
    try {
      const result = await db.withdrawFromHouse(amount, msg.from.id);
      await bot.sendMessage(msg.chat.id,
        `✅ *House Withdrawal*\n\n` +
        `Withdrew \`${formatBalance(amount)}\` $YC from house balance\n` +
        `Added to your 💲 Spot Balance\n` +
        `Remaining house balance: \`${formatBalance(result.remainingBalance)}\` $YC`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
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

  // Start duel expiry job (checks every 60s)
  startDuelExpiryJob(bot);

  console.log('✅ YellowCatz Bot is running!');
  return bot;
}

module.exports = { createBot };
