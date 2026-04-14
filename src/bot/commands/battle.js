const db = require('../../db/queries');
const { formatBalance } = require('./start');
const { handleDirectChallenge } = require('./duel');

const MIN_WAGER = 10;

// Safe HTML escaping
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function editOrSend(bot, chatId, msgId, text, opts = {}) {
  const options = { parse_mode: 'HTML', ...opts };
  if (msgId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...options });
    } catch (e) {
      console.error('[BATTLE EDIT ERROR]', e.message);
    }
  }
  return await bot.sendMessage(chatId, text, options);
}

async function handleBattleCommand(bot, msg, args) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  if (!args || !args[0]) {
    return await showBattleMenu(bot, chatId, telegramId);
  }

  const usernameArg = args.find(a => a.startsWith('@'));
  const amountArg = args.find(a => !a.startsWith('@'));

  if (usernameArg) {
    const amount = parseFloat(amountArg);
    return await handleDirectChallenge(bot, msg, usernameArg, amount);
  }

  const user = await db.getOrCreateUser({ telegramId, username, firstName });
  const amount = parseFloat(args[0]);

  if (isNaN(amount) || amount < MIN_WAGER) {
    return await bot.sendMessage(chatId,
      `⚔️ <b>Battle Command</b>\n\nUsage:\n` +
      `  /pvp &lt;amount&gt; — open matchmaking\n` +
      `  /pvp @username &lt;amount&gt; — direct duel\n\n` +
      `Minimum wager: <b>${MIN_WAGER} $YC</b>`,
      { parse_mode: 'HTML' }
    );
  }

  if ((user.gamble_balance || 0) < amount) {
    return await bot.sendMessage(chatId,
      `🐱 <b>Insufficient Gamble Balance!</b>\n\nYou need <b>${formatBalance(amount)}</b> but only have <b>${formatBalance(user.gamble_balance)}</b> $YC.\n\nUse /collect to earn more!`,
      { parse_mode: 'HTML' }
    );
  }

  const battleId = await db.createBattle(telegramId, amount);
  const displayName = username ? `@${username}` : firstName || 'Someone';

  await bot.sendMessage(chatId,
    `⚔️ ${escapeHtml(displayName)} has challenged someone to PvP for ${formatBalance(amount)} $YC!\nClick the button below to accept.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚔️ Accept Challenge', callback_data: `battle_accept_${battleId}` }]
        ]
      }
    }
  );
}

async function showBattleMenu(bot, chatId, telegramId, msgId = null) {
  const battles = await db.getOpenBattles(telegramId);
  const stats = await db.getBattleStats(telegramId);

  let text = `⚔️ <b>Battle Arena</b>\n\n`;
  text += `📊 <b>Your Stats:</b>\n`;
  text += `🏆 Wins: <b>${stats.wins}</b> | 💀 Losses: <b>${stats.losses}</b>\n`;
  text += `💰 Total Won: <b>${formatBalance(stats.earned)}</b> $YC\n\n`;

  if (battles.length > 0) {
    text += `🎯 <b>Open Battles:</b>\n`;
    battles.forEach(b => {
      const name = b.challenger_name || b.challenger_first || 'Unknown';
      text += `• #${b.id} — <b>${formatBalance(b.wager_amount)} $YC</b> by @${escapeHtml(name)}\n`;
    });
    text += `\n<i>Use the buttons to accept a battle</i>`;
  } else {
    text += `<i>No open battles right now.</i>\nCreate one with /battle &lt;amount&gt;`;
  }

  const keyboard = [];
  battles.slice(0, 3).forEach(b => {
    const name = b.challenger_name || b.challenger_first || 'Unknown';
    keyboard.push([{
      text: `⚔️ Accept #${b.id} (${formatBalance(b.wager_amount)} $YC)`,
      callback_data: `battle_accept_${b.id}`
    }]);
  });
  keyboard.push([{ text: '📜 My Battle History', callback_data: 'battle_history' }]);
  keyboard.push([{ text: '🏠 Back', callback_data: 'back_main' }]);

  await editOrSend(bot, chatId, msgId, text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleBattleAccept(bot, chatId, telegramId, username, firstName, battleId, messageId) {
  const user = await db.getOrCreateUser({ telegramId, username, firstName });
  const battle = await db.getBattleById(battleId);

  if (!battle || battle.status !== 'open') {
    return await bot.sendMessage(chatId, `❌ This battle is no longer available!`, { parse_mode: 'HTML' });
  }

  if (String(battle.challenger_id) === String(telegramId)) {
    return await bot.sendMessage(chatId, `🐱 You can't battle yourself!`, { parse_mode: 'HTML' });
  }

  if ((user.gamble_balance || 0) < battle.wager_amount) {
    return await bot.sendMessage(chatId, `🐱 You need <b>${formatBalance(battle.wager_amount)}</b> $YC to accept!`, { parse_mode: 'HTML' });
  }

  const result = await db.acceptBattle(battleId, telegramId);
  if (!result) {
    return await bot.sendMessage(chatId, `❌ Could not accept battle.`, { parse_mode: 'HTML' });
  }

  const challengerUser = await db.getUser(battle.challenger_id);
  const challengerName = challengerUser?.username ? `@${challengerUser.username}` : (challengerUser?.first_name || 'Player 1');
  const opponentName = username ? `@${username}` : (firstName || 'Player 2');
  const winnerName = result.winner_id === String(telegramId) ? opponentName : challengerName;
  const loserName = result.winner_id === String(telegramId) ? challengerName : opponentName;
  const { pot, fee, payout } = result;

  const resultText = 
    `⚔️ <b>Battle Result</b>\n\n` +
    `🏆 Winner: <b>${escapeHtml(winnerName)}</b>\n` +
    `⚔️ Fell in battle: <b>${escapeHtml(loserName)}</b>\n` +
    `💰 Prize: <b>${formatBalance(payout)}</b> $YC <i>(after 5% house fee)</i>\n` +
    `🏠 House fee: <b>${formatBalance(fee)}</b> $YC\n` +
    `📊 Total pot was: <b>${formatBalance(pot)}</b> $YC`;

  if (messageId) {
    try {
      await bot.editMessageText(resultText, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch {
      await bot.sendMessage(chatId, resultText, { parse_mode: 'HTML' });
    }
  } else {
    await bot.sendMessage(chatId, resultText, { parse_mode: 'HTML' });
  }

  const challengerWon = result.winner_id === String(battle.challenger_id);
  try {
    await bot.sendMessage(battle.challenger_id,
      `⚔️ <b>${escapeHtml(opponentName)}</b> accepted your PvP challenge!\n\n` +
      (challengerWon
        ? `🏆 You won <b>${formatBalance(payout)}</b> $YC! <i>(5% house fee deducted)</i>`
        : `💀 You lost <b>${formatBalance(battle.wager_amount)}</b> $YC`),
      { parse_mode: 'HTML' }
    );
  } catch {}
}

async function handleBattleHistory(bot, chatId, telegramId, msgId) {
  const battles = await db.getUserBattles(telegramId);
  if (battles.length === 0) {
    return await editOrSend(bot, chatId, msgId,
      `⚔️ <b>Battle History</b>\n\nNo battles yet! Use /battle &lt;amount&gt; to start.`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'back_main' }]] } }
    );
  }

  let text = `⚔️ <b>Battle History</b> (last 10)\n\n`;
  battles.forEach(b => {
    const won = b.winner_id === String(telegramId);
    const opponent = String(b.challenger_id) === String(telegramId)
      ? (b.opponent_name || b.opponent_first || 'Unknown')
      : (b.challenger_name || b.challenger_first || 'Unknown');
    text += `${won ? '🏆' : '💀'} vs @${escapeHtml(opponent)} — <b>${formatBalance(b.wager_amount)}</b> $YC ${won ? 'WON' : 'LOST'}\n`;
  });

  await editOrSend(bot, chatId, msgId, text, {
    reply_markup: { inline_keyboard: [[
      { text: '⚔️ Battle Arena', callback_data: 'menu_battles' },
      { text: '🏠 Home', callback_data: 'back_main' }
    ]] }
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
      `✅ Battle #${battleId} cancelled. Your wager of <b>${formatBalance(battle.wager_amount)}</b> $YC has been refunded.`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'back_main' }]] } }
    );
  } else {
    await editOrSend(bot, chatId, msgId, `❌ Could not cancel — may have already been accepted.`);
  }
}

module.exports = { handleBattleCommand, showBattleMenu, handleBattleAccept, handleBattleHistory, handleCancelBattle };
