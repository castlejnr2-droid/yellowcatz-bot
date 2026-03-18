const { handleStart, handleRefresh, getMainMenuKeyboard, getPortfolioText } = require('../commands/start');
const { showFundsMenu, handleToSpot, handleToGamble, handleWithdrawStart, showWithdrawalHistory, confirmWithdrawal, clearState } = require('./funds');
const { showReferralMenu } = require('./referral');
const { showBattleMenu, handleBattleAccept, handleBattleHistory, handleCancelBattle } = require('../commands/battle');
const db = require('../../db/queries');
const { formatBalance } = require('../commands/start');

async function handleCallbackQuery(bot, query) {
  const { id: queryId, message, from, data } = query;
  const chatId = message.chat.id;
  const telegramId = from.id;
  const { username, first_name: firstName } = from;

  await bot.answerCallbackQuery(queryId).catch(() => {});

  // ── Main Menu ──
  if (data === 'back_main' || data === 'menu_refresh') {
    const user = db.getOrCreateUser({ telegramId, username, firstName });
    try {
      await bot.editMessageText(getPortfolioText(user), {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(chatId)
      });
    } catch {
      await bot.sendMessage(chatId, getPortfolioText(user), {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(chatId)
      });
    }
    return;
  }

  // ── Funds Menu ──
  if (data === 'menu_funds') {
    clearState(telegramId);
    return await showFundsMenu(bot, chatId, telegramId);
  }
  if (data === 'funds_to_spot') return await handleToSpot(bot, chatId, telegramId);
  if (data === 'funds_to_gamble') return await handleToGamble(bot, chatId, telegramId);
  if (data === 'funds_withdraw') return await handleWithdrawStart(bot, chatId, telegramId);
  if (data === 'funds_history') return await showWithdrawalHistory(bot, chatId, telegramId);
  if (data === 'funds_cancel') {
    clearState(telegramId);
    return await bot.sendMessage(chatId, `❌ Cancelled.`, {
      reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] }
    });
  }
  if (data === 'withdraw_confirm') return await confirmWithdrawal(bot, chatId, telegramId);

  // ── Referral ──
  if (data === 'menu_referral') return await showReferralMenu(bot, chatId, telegramId);

  // ── Battles ──
  if (data === 'menu_battles') return await showBattleMenu(bot, chatId, telegramId);
  if (data === 'battle_list') return await showBattleMenu(bot, chatId, telegramId);
  if (data === 'battle_history') return await handleBattleHistory(bot, chatId, telegramId);
  if (data.startsWith('battle_accept_')) {
    const battleId = parseInt(data.replace('battle_accept_', ''));
    return await handleBattleAccept(bot, chatId, telegramId, username, firstName, battleId);
  }
  if (data.startsWith('battle_cancel_')) {
    const battleId = parseInt(data.replace('battle_cancel_', ''));
    return await handleCancelBattle(bot, chatId, telegramId, battleId);
  }

  // ── Leaderboard ──
  if (data === 'menu_leaderboard') return await showLeaderboard(bot, chatId);
}

async function showLeaderboard(bot, chatId) {
  const topCollectors = db.getTopCollectors(5);
  const topBattlers = db.getTopBattlers(5);

  let text = `🏆 *Leaderboard*\n\n`;

  text += `💰 *Top Collectors:*\n`;
  topCollectors.forEach((u, i) => {
    const name = u.username ? `@${u.username}` : u.first_name || 'Anonymous';
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    text += `${medals[i]} ${name}: \`${formatBalance(u.total_collected)} $YellowCatz\`\n`;
  });

  text += `\n⚔️ *Top Battlers:*\n`;
  topBattlers.forEach((u, i) => {
    const name = u.username ? `@${u.username}` : u.first_name || 'Anonymous';
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    text += `${medals[i]} ${name}: \`${u.wins} wins\`\n`;
  });

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] }
  });
}

module.exports = { handleCallbackQuery };
