const { getMainMenuKeyboard, getPortfolioText } = require('../commands/start');
const { showFundsMenu, handleToSpot, handleToGamble, handleWithdrawStart, showWithdrawalHistory, confirmWithdrawal, clearState } = require('./funds');
const { showReferralMenu } = require('./referral');
const { showBattleMenu, handleBattleAccept, handleBattleHistory, handleCancelBattle } = require('../commands/battle');
const db = require('../../db/queries');
const { formatBalance } = require('../commands/start');

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
    } catch {
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

  // ── Leaderboard ──
  if (data === 'menu_leaderboard') return await showLeaderboard(bot, chatId, msgId);
}

async function showLeaderboard(bot, chatId, msgId) {
  try {
    const topCollectors = await db.getTopCollectors(5);
    const topBattlers = await db.getTopBattlers(5);

    let text = `🏆 *Leaderboard*\n\n`;

    text += `💰 *Top Collectors:*\n`;
    if (topCollectors.length === 0) {
      text += `_No collectors yet!_\n`;
    } else {
      topCollectors.forEach((u, i) => {
        const name = u.username ? `@${u.username}` : u.first_name || 'Anonymous';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        text += `${medals[i]} ${name}: \`${formatBalance(u.total_collected)} $YellowCatz\`\n`;
      });
    }

    text += `\n⚔️ *Top Battlers:*\n`;
    if (topBattlers.length === 0) {
      text += `_No battlers yet!_\n`;
    } else {
      topBattlers.forEach((u, i) => {
        const name = u.username ? `@${u.username}` : u.first_name || 'Anonymous';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        text += `${medals[i]} ${name}: \`${u.wins} wins\`\n`;
      });
    }

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] } };
    if (msgId) {
      try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); return; } catch {}
    }
    await bot.sendMessage(chatId, text, opts);
  } catch (err) {
    console.error('[LEADERBOARD] Error:', err.message);
    const errorText = `🏆 *Leaderboard*\n\n_Unable to load leaderboard. Please try again later._`;
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] } };
    if (msgId) {
      try { await bot.editMessageText(errorText, { chat_id: chatId, message_id: msgId, ...opts }); return; } catch {}
    }
    await bot.sendMessage(chatId, errorText, opts);
  }
}

module.exports = { handleCallbackQuery };
