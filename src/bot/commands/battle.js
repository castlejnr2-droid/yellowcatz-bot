const db = require('../../db/queries');
const { formatBalance } = require('./start');

const MIN_WAGER = 10;

async function handleBattleCommand(bot, msg, args) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  const user = db.getOrCreateUser({ telegramId, username, firstName });

  if (!args || !args[0]) {
    return await showBattleMenu(bot, chatId, telegramId);
  }

  const amount = parseFloat(args[0]);
  if (isNaN(amount) || amount < MIN_WAGER) {
    return await bot.sendMessage(chatId,
      `⚔️ *Battle Command*\n\n` +
      `Usage: \`/battle <amount>\`\n` +
      `Minimum wager: \`${MIN_WAGER} $YellowCatz\`\n\n` +
      `Example: \`/battle 100\``,
      { parse_mode: 'Markdown' }
    );
  }

  if ((user.gamble_balance || 0) < amount) {
    return await bot.sendMessage(chatId,
      `🐱 *Insufficient Gamble Balance!*\n\n` +
      `You need \`${formatBalance(amount)}\` $YellowCatz but only have \`${formatBalance(user.gamble_balance)}\` $YellowCatz in your Gamble Balance.\n\n` +
      `Use /collect to earn more, or transfer from Spot balance!`,
      { parse_mode: 'Markdown' }
    );
  }

  const battleId = db.createBattle(telegramId, amount);
  const displayName = username ? `@${username}` : firstName || 'Someone';

  await bot.sendMessage(chatId,
    `⚔️ ${displayName} has challenged someone to PvP for ${formatBalance(amount)} $YellowCatz!\nClick the button below to accept.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚔️ Accept Challenge', callback_data: `battle_accept_${battleId}` }]
        ]
      }
    }
  );
}

async function showBattleMenu(bot, chatId, telegramId) {
  const battles = db.getOpenBattles(telegramId);
  const stats = db.getBattleStats(telegramId);

  let text = `⚔️ *Battle Arena*\n\n`;
  text += `📊 *Your Stats:*\n`;
  text += `🏆 Wins: \`${stats.wins}\` | 💀 Losses: \`${stats.losses}\`\n`;
  text += `💰 Total Won: \`${formatBalance(stats.earned)} $YellowCatz\`\n\n`;

  if (battles.length > 0) {
    text += `🎯 *Open Battles:*\n`;
    battles.forEach(b => {
      const name = b.challenger_name || b.challenger_first || 'Unknown';
      text += `• #${b.id} — \`${formatBalance(b.wager_amount)} $YellowCatz\` by @${name}\n`;
    });
    text += `\n_Use the buttons to accept a battle_`;
  } else {
    text += `_No open battles right now._\n_Create one with /battle <amount>_`;
  }

  const keyboard = [];
  battles.slice(0, 3).forEach(b => {
    const name = b.challenger_name || b.challenger_first || 'Unknown';
    keyboard.push([{ text: `⚔️ Accept #${b.id} (${formatBalance(b.wager_amount)} $YellowCatz)`, callback_data: `battle_accept_${b.id}` }]);
  });
  keyboard.push([{ text: '📜 My Battle History', callback_data: 'battle_history' }]);
  keyboard.push([{ text: '🏠 Back', callback_data: 'back_main' }]);

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleBattleAccept(bot, chatId, telegramId, username, firstName, battleId, messageId) {
  const user = db.getOrCreateUser({ telegramId, username, firstName });
  const battle = db.getBattleById(battleId);

  if (!battle || battle.status !== 'open') {
    return await bot.answerCallbackQuery(null, { text: 'This battle is no longer available!' });
  }

  if (String(battle.challenger_id) === String(telegramId)) {
    return await bot.answerCallbackQuery(null, { text: "You can't battle yourself!" });
  }

  if ((user.gamble_balance || 0) < battle.wager_amount) {
    return await bot.answerCallbackQuery(null, { text: `You need ${formatBalance(battle.wager_amount)} $YellowCatz to accept!` });
  }

  const result = db.acceptBattle(battleId, telegramId);
  if (!result) {
    return await bot.answerCallbackQuery(null, { text: 'Could not accept battle.' });
  }

  const challengerUser = db.getUser(battle.challenger_id);
  const challengerName = challengerUser?.username ? `@${challengerUser.username}` : (challengerUser?.first_name || 'Player 1');
  const opponentName = username ? `@${username}` : (firstName || 'Player 2');
  const winnerName = result.winner_id === String(telegramId) ? opponentName : challengerName;
  const loserName = result.winner_id === String(telegramId) ? challengerName : opponentName;
  const pot = battle.wager_amount;

  // Edit the original challenge message to show result
  const resultText = `⚔️ PvP Battle Result!\n\n` +
    `🏆 ${winnerName} won ${formatBalance(pot)} $YellowCatz!\n` +
    `💀 ${loserName} lost ${formatBalance(pot)} $YellowCatz!`;

  if (messageId) {
    try {
      await bot.editMessageText(resultText, { chat_id: chatId, message_id: messageId });
    } catch {
      await bot.sendMessage(chatId, resultText);
    }
  } else {
    await bot.sendMessage(chatId, resultText);
  }

  // DM the challenger about the result
  const challengerWon = result.winner_id === String(battle.challenger_id);
  try {
    await bot.sendMessage(battle.challenger_id,
      `⚔️ ${opponentName} accepted your PvP challenge!\n\n` +
      (challengerWon
        ? `🏆 You won ${formatBalance(pot)} $YellowCatz!`
        : `💀 You lost ${formatBalance(pot)} $YellowCatz!`)
    );
  } catch { /* user blocked bot */ }
}

async function handleBattleHistory(bot, chatId, telegramId) {
  const battles = db.getUserBattles(telegramId);
  if (battles.length === 0) {
    return await bot.sendMessage(chatId,
      `⚔️ *Battle History*\n\n_No battles yet! Use /battle <amount> to start._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] } }
    );
  }

  let text = `⚔️ *Battle History* (last 10)\n\n`;
  battles.forEach(b => {
    const won = b.winner_id === String(telegramId);
    const opponent = String(b.challenger_id) === String(telegramId)
      ? (b.opponent_name || b.opponent_first || 'Unknown')
      : (b.challenger_name || b.challenger_first || 'Unknown');
    const emoji = won ? '🏆' : '💀';
    text += `${emoji} vs @${opponent} — \`${formatBalance(b.wager_amount)} $YellowCatz\` ${won ? 'WON' : 'LOST'}\n`;
  });

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⚔️ Battle Arena', callback_data: 'menu_battles' }, { text: '🏠 Home', callback_data: 'back_main' }]] }
  });
}

async function handleCancelBattle(bot, chatId, telegramId, battleId) {
  const battle = db.getBattleById(battleId);
  if (!battle || String(battle.challenger_id) !== String(telegramId)) {
    return await bot.sendMessage(chatId, `❌ You can only cancel your own battles.`);
  }
  const success = db.cancelBattle(battleId);
  if (success) {
    await bot.sendMessage(chatId,
      `✅ Battle #${battleId} cancelled. Your wager of \`${formatBalance(battle.wager_amount)}\` $YellowCatz has been refunded.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'back_main' }]] } }
    );
  } else {
    await bot.sendMessage(chatId, `❌ Could not cancel battle — it may have already been accepted.`);
  }
}

module.exports = {
  handleBattleCommand,
  showBattleMenu,
  handleBattleAccept,
  handleBattleHistory,
  handleCancelBattle
};
