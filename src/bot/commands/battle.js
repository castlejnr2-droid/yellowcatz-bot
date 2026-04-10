const db = require('../../db/queries');
const { formatBalance } = require('./start');
const { handleDirectChallenge } = require('./duel');

const MIN_WAGER = 10;

async function editOrSend(bot, chatId, msgId, text, opts = {}) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...opts }); } catch {}
  }
  return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}

async function handleBattleCommand(bot, msg, args) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  if (!args || !args[0]) {
    return await showBattleMenu(bot, chatId, telegramId);
  }

  // Detect direct challenge: any arg starts with '@'
  const usernameArg = args.find(a => a.startsWith('@'));
  const amountArg = args.find(a => !a.startsWith('@'));

  if (usernameArg) {
    // /pvp @username <amount> — locked direct challenge
    const amount = parseFloat(amountArg);
    return await handleDirectChallenge(bot, msg, usernameArg, amount);
  }

  // /pvp <amount> — existing open matchmaking (unchanged)
  const user = await db.getOrCreateUser({ telegramId, username, firstName });
  const amount = parseFloat(args[0]);
  if (isNaN(amount) || amount < MIN_WAGER) {
    return await bot.sendMessage(chatId,
      `⚔️ *Battle Command*\n\nUsage:\n` +
      `  \`/pvp <amount>\` — open matchmaking\n` +
      `  \`/pvp @username <amount>\` — direct duel\n\n` +
      `Minimum wager: \`${MIN_WAGER} $YC\``,
      { parse_mode: 'Markdown' }
    );
  }

  if ((user.gamble_balance || 0) < amount) {
    return await bot.sendMessage(chatId,
      `🐱 *Insufficient Gamble Balance!*\n\nYou need \`${formatBalance(amount)}\` but only have \`${formatBalance(user.gamble_balance)}\` $YC.\n\nUse /collect to earn more!`,
      { parse_mode: 'Markdown' }
    );
  }

  const battleId = await db.createBattle(telegramId, amount);
  const displayName = username ? `@${username}` : firstName || 'Someone';

  await bot.sendMessage(chatId,
    `⚔️ ${displayName} has challenged someone to PvP for ${formatBalance(amount)} $YC!\nClick the button below to accept.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚔️ Accept Challenge', callback_data: `battle_accept_${battleId}` }]
        ]
      }
    }
  );
}

async function showBattleMenu(bot, chatId, telegramId, msgId) {
  const battles = await db.getOpenBattles(telegramId);
  const stats = await db.getBattleStats(telegramId);

  let text = `⚔️ *Battle Arena*\n\n`;
  text += `📊 *Your Stats:*\n`;
  text += `🏆 Wins: \`${stats.wins}\` | 💀 Losses: \`${stats.losses}\`\n`;
  text += `💰 Total Won: \`${formatBalance(stats.earned)} $YC\`\n\n`;

  if (battles.length > 0) {
    text += `🎯 *Open Battles:*\n`;
    battles.forEach(b => {
      const name = b.challenger_name || b.challenger_first || 'Unknown';
      text += `• #${b.id} — \`${formatBalance(b.wager_amount)} $YC\` by @${name}\n`;
    });
    text += `\n_Use the buttons to accept a battle_`;
  } else {
    text += `_No open battles right now._\n_Create one with /battle <amount>_`;
  }

  const keyboard = [];
  battles.slice(0, 3).forEach(b => {
    const name = b.challenger_name || b.challenger_first || 'Unknown';
    keyboard.push([{ text: `⚔️ Accept #${b.id} (${formatBalance(b.wager_amount)} $YC)`, callback_data: `battle_accept_${b.id}` }]);
  });
  keyboard.push([{ text: '📜 My Battle History', callback_data: 'battle_history' }]);
  keyboard.push([{ text: '🏠 Back', callback_data: 'back_main' }]);

  await editOrSend(bot, chatId, msgId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function handleBattleAccept(bot, chatId, telegramId, username, firstName, battleId, messageId) {
  const user = await db.getOrCreateUser({ telegramId, username, firstName });
  const battle = await db.getBattleById(battleId);

  if (!battle || battle.status !== 'open') {
    return await bot.sendMessage(chatId, `❌ This battle is no longer available!`);
  }

  if (String(battle.challenger_id) === String(telegramId)) {
    return await bot.sendMessage(chatId, `🐱 You can't battle yourself!`);
  }

  if ((user.gamble_balance || 0) < battle.wager_amount) {
    return await bot.sendMessage(chatId, `🐱 You need ${formatBalance(battle.wager_amount)} $YC to accept!`);
  }

  const result = await db.acceptBattle(battleId, telegramId);
  if (!result) {
    return await bot.sendMessage(chatId, `❌ Could not accept battle.`);
  }

  const challengerUser = await db.getUser(battle.challenger_id);
  const challengerName = challengerUser?.username ? `@${challengerUser.username}` : (challengerUser?.first_name || 'Player 1');
  const opponentName = username ? `@${username}` : (firstName || 'Player 2');
  const winnerName = result.winner_id === String(telegramId) ? opponentName : challengerName;
  const loserName = result.winner_id === String(telegramId) ? challengerName : opponentName;
  const { pot, fee, payout } = result;


const resultText =
  `⚔️ *Battle Result*\n\n` +
  `🏆 Winner: *${winnerName}*\n` +
  `⚔️ Fell in battle: *${loserName}*\n` +
  `💰 Prize: \`${formatBalance(payout)}\` $YC _(after 5% house fee)_\n` +
  `🏠 House fee: \`${formatBalance(fee)}\` $YC\n` +
  `📊 Total pot was: \`${formatBalance(pot)}\` $YC`;

  if (messageId) {
    try { await bot.editMessageText(resultText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }); }
    catch { await bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' }); }
  } else {
    await bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' });
  }

  const challengerWon = result.winner_id === String(battle.challenger_id);
  try {
    await bot.sendMessage(battle.challenger_id,
      `⚔️ *${opponentName} accepted your PvP challenge!*\n\n` +
      (challengerWon
        ? `🏆 You won \`${formatBalance(payout)}\` $YC! _(5% house fee deducted)_`
        : `💀 You lost \`${formatBalance(battle.wager_amount)}\` $YC`),
      { parse_mode: 'Markdown' }
    );
  } catch {}
}

async function handleBattleHistory(bot, chatId, telegramId, msgId) {
  const battles = await db.getUserBattles(telegramId);
  if (battles.length === 0) {
    return await editOrSend(bot, chatId, msgId,
      `⚔️ *Battle History*\n\n_No battles yet! Use /battle <amount> to start._`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] } }
    );
  }

  let text = `⚔️ *Battle History* (last 10)\n\n`;
  battles.forEach(b => {
    const won = b.winner_id === String(telegramId);
    const opponent = String(b.challenger_id) === String(telegramId)
      ? (b.opponent_name || b.opponent_first || 'Unknown')
      : (b.challenger_name || b.challenger_first || 'Unknown');
    text += `${won ? '🏆' : '💀'} vs @${opponent} — \`${formatBalance(b.wager_amount)} $YC\` ${won ? 'WON' : 'LOST'}\n`;
  });

  await editOrSend(bot, chatId, msgId, text, {
    reply_markup: { inline_keyboard: [[{ text: '⚔️ Battle Arena', callback_data: 'menu_battles' }, { text: '🏠 Home', callback_data: 'back_main' }]] }
  });
}

async function handleCancelBattle(bot, chatId, telegramId, battleId, msgId) {
  const battle = await db.getBattleById(battleId);
  if (!battle || String(battle.challenger_id) !== String(telegramId)) {
    return await editOrSend(bot, chatId, msgId, `❌ You can only cancel your own battles.`);
  }
  const success = await db.cancelBattle(battleId);
  if (success) {
    await editOrSend(bot, chatId, msgId,
      `✅ Battle #${battleId} cancelled. Your wager of \`${formatBalance(battle.wager_amount)}\` $YC has been refunded.`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'back_main' }]] } }
    );
  } else {
    await editOrSend(bot, chatId, msgId, `❌ Could not cancel — may have already been accepted.`);
  }
}

module.exports = { handleBattleCommand, showBattleMenu, handleBattleAccept, handleBattleHistory, handleCancelBattle };
