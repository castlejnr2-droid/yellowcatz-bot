const { getMainMenuKeyboard, getPortfolioText } = require('../commands/start');
const { showFundsMenu, handleToSpot, handleToGamble, handleWithdrawStart, showWithdrawalHistory, confirmWithdrawal, handleDeposit, clearState } = require('./funds');
const { showReferralMenu } = require('./referral');
const { showBattleMenu, handleBattleAccept, handleBattleHistory, handleCancelBattle } = require('../commands/battle');
const db = require('../../db/queries');
const { formatBalance } = require('../commands/start');
const { sendTokens } = require('../../solana/withdraw');

async function handleCallbackQuery(bot, query) {
  try { await _handleCallback(bot, query); } catch (err) { console.error('[CALLBACK ERROR]', err.message); }
}

async function _handleCallback(bot, query) {
  const { id: queryId, message, from, data } = query;
  const chatId = message.chat.id;
  const telegramId = from.id;
  const { username, first_name: firstName } = from;

  try { await bot.answerCallbackQuery(queryId); } catch {}
  const msgId = message.message_id;

  async function edit(text, opts = {}) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...opts });
    } catch (err) {
      // If message content is identical, Telegram throws "not modified" — just ignore it
      if (err && err.message && err.message.includes('message is not modified')) return;
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
    }
  }

  // ── Main Menu ──
  if (data === 'back_main' || data === 'menu_refresh') {
    const user = await db.getOrCreateUser({ telegramId, username, firstName });
    return await edit(getPortfolioText(user), { reply_markup: getMainMenuKeyboard(chatId) });
  }

  // ── Funds Menu ──
  if (data === 'menu_funds') {
    clearState(telegramId);
    return await showFundsMenu(bot, chatId, telegramId, msgId);
  }
  if (data === 'funds_to_spot') return await handleToSpot(bot, chatId, telegramId, msgId);
  if (data === 'funds_to_gamble') return await handleToGamble(bot, chatId, telegramId, msgId);
  if (data === 'funds_deposit') return await handleDeposit(bot, chatId, telegramId, msgId);
  if (data === 'funds_withdraw') return await handleWithdrawStart(bot, chatId, telegramId, msgId);
  if (data === 'funds_history') return await showWithdrawalHistory(bot, chatId, telegramId, msgId);
  if (data === 'funds_cancel') {
    clearState(telegramId);
    return await edit(`❌ Cancelled.`, { reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } });
  }
  if (data === 'withdraw_confirm') return await confirmWithdrawal(bot, chatId, telegramId, msgId);

  // ── Referral ──
  if (data === 'menu_referral') return await showReferralMenu(bot, chatId, telegramId, msgId);

  // ── Battles ──
  if (data === 'menu_battles') return await showBattleMenu(bot, chatId, telegramId, msgId);
  if (data === 'battle_list') return await showBattleMenu(bot, chatId, telegramId, msgId);
  if (data === 'battle_history') return await handleBattleHistory(bot, chatId, telegramId, msgId);
  if (data.startsWith('battle_accept_')) {
    const battleId = parseInt(data.replace('battle_accept_', ''));
    return await handleBattleAccept(bot, chatId, telegramId, username, firstName, battleId, msgId);
  }
  if (data.startsWith('battle_cancel_')) {
    const battleId = parseInt(data.replace('battle_cancel_', ''));
    return await handleCancelBattle(bot, chatId, telegramId, battleId, msgId);
  }

  // ── Admin Approve/Reject Withdrawals ──
  if (data.startsWith('admin_approve_') || data.startsWith('admin_reject_')) {
    const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
    if (!admins.includes(String(telegramId))) return;

    const isApprove = data.startsWith('admin_approve_');
    const wId = parseInt(data.replace(/^admin_(approve|reject)_/, ''));
    const withdrawal = await db.getWithdrawalById(wId);

    if (!withdrawal) return await edit(`❌ Withdrawal #${wId} not found.`);
    if (withdrawal.status !== 'pending') return await edit(`❌ #${wId} already ${withdrawal.status}.`);

    if (!isApprove) {
      await db.refundWithdrawal(withdrawal);
      await edit(`❌ *Rejected & refunded #${wId}*`);
      try {
        await bot.sendMessage(withdrawal.user_id,
          `❌ *Withdrawal Rejected*\n\nYour \`${formatBalance(withdrawal.amount)}\` $YC has been refunded.`,
          { parse_mode: 'Markdown' });
      } catch {}
      return;
    }

    await db.updateWithdrawalStatus(wId, 'processing');
    await edit(`🔄 Processing #${wId}...`);

    try {
      const txHash = await sendTokens(withdrawal.solana_address, withdrawal.amount);
      await db.updateWithdrawalStatus(wId, 'completed', txHash);
      await edit(`✅ *#${wId} completed!*\nTX: \`${txHash}\``);
      try {
        await bot.sendMessage(withdrawal.user_id,
          `✅ *Withdrawal Complete!*\n\nAmount: \`${formatBalance(withdrawal.amount)}\` $YC\nTX: \`${txHash}\``,
          { parse_mode: 'Markdown' });
      } catch {}
    } catch (err) {
      await db.updateWithdrawalStatus(wId, 'failed', null, err.message);
      await db.refundWithdrawal(withdrawal);
      await edit(`❌ *#${wId} failed:* ${err.message}\nBalance refunded.`);
      try {
        await bot.sendMessage(withdrawal.user_id,
          `❌ *Withdrawal Failed*\n\nYour \`${formatBalance(withdrawal.amount)}\` $YC has been refunded.`,
          { parse_mode: 'Markdown' });
      } catch {}
    }
    return;
  }

  // ── Leaderboard ──
  if (data === 'menu_leaderboard') return await showLeaderboard(bot, chatId, msgId);
}

async function showLeaderboard(bot, chatId, msgId) {
  try {
    console.log('[LEADERBOARD] Fetching data...');
    const topCollectors = await db.getTopCollectors(5);
    const topBattlers = await db.getTopBattlers(5);
    console.log('[LEADERBOARD] Collectors:', topCollectors.length, 'Battlers:', topBattlers.length);

    let text = `🏆 Leaderboard\n\n`;

    text += `💰 Top Collectors:\n`;
    if (!topCollectors || topCollectors.length === 0) {
      text += `  No collectors yet!\n`;
    } else {
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
      topCollectors.forEach((u, i) => {
        const name = u.username || u.first_name || 'Anonymous';
        text += `${medals[i]} ${name} — ${formatBalance(u.total_collected)} $YC\n`;
      });
    }

    text += `\n⚔️ Top Battlers:\n`;
    if (!topBattlers || topBattlers.length === 0) {
      text += `  No battlers yet!\n`;
    } else {
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
      topBattlers.forEach((u, i) => {
        const name = u.username || u.first_name || 'Anonymous';
        text += `${medals[i]} ${name} — ${u.wins} wins\n`;
      });
    }

    const kb = { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] };
    if (msgId) {
      try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }); return; } catch (e) { if (e.message && e.message.includes('message is not modified')) return; console.error('[LEADERBOARD] Edit failed:', e.message); }
    }
    await bot.sendMessage(chatId, text, { reply_markup: kb });
  } catch (err) {
    console.error('[LEADERBOARD] Error:', err.message, err.stack);
    const kb = { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] };
    const errorText = `🏆 Leaderboard\n\nUnable to load leaderboard. Please try again later.`;
    if (msgId) {
      try { await bot.editMessageText(errorText, { chat_id: chatId, message_id: msgId, reply_markup: kb }); return; } catch {}
    }
    await bot.sendMessage(chatId, errorText, { reply_markup: kb });
  }
}

module.exports = { handleCallbackQuery };
