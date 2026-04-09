const db = require('../../db/queries');
const { formatBalance } = require('./start');

const MIN_WAGER = 10;

function calcPayout(amount) {
  const pot = amount * 2;
  const fee = Math.floor(pot * 0.05);
  return { pot, fee, payout: pot - fee };
}

async function safeAnswerCb(bot, queryId, text, showAlert = false) {
  try {
    if (text) {
      await bot.answerCallbackQuery(queryId, { text, show_alert: showAlert });
    } else {
      await bot.answerCallbackQuery(queryId);
    }
  } catch {}
}

async function safeEdit(bot, chatId, msgId, text) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
  } catch {
    try { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch {}
  }
}

// ── Create a direct challenge ─────────────────────────────────────────────────

async function handleDirectChallenge(bot, msg, targetUsername, amount) {
  const { id: challengerId, username: challengerUsername, first_name: challengerFirst } = msg.from;
  const chatId = msg.chat.id;

  if (isNaN(amount) || amount < MIN_WAGER) {
    return await bot.sendMessage(chatId,
      `⚔️ Minimum wager is \`${MIN_WAGER} $YC\`.\nUsage: \`/pvp @username <amount>\``,
      { parse_mode: 'Markdown' }
    );
  }

  const targetUser = await db.getUserByUsername(targetUsername);
  if (!targetUser) {
    return await bot.sendMessage(chatId,
      `❌ User *${targetUsername}* not found. They must have used the bot at least once.`,
      { parse_mode: 'Markdown' }
    );
  }

  const targetId = targetUser.telegram_id;

  if (String(targetId) === String(challengerId)) {
    return await bot.sendMessage(chatId, `🐱 You can't duel yourself!`);
  }

  const challenger = await db.getUser(challengerId);
  if ((challenger.gamble_balance || 0) < amount) {
    return await bot.sendMessage(chatId,
      `🐱 *Insufficient Gamble Balance!*\n\nYou need \`${formatBalance(amount)}\` but only have \`${formatBalance(challenger.gamble_balance)}\` $YC.`,
      { parse_mode: 'Markdown' }
    );
  }

  const existing = await db.getPendingDuelBetween(challengerId, targetId);
  if (existing) {
    return await bot.sendMessage(chatId,
      `❌ You already have a pending challenge against this user (Duel #${existing.id}).`,
      { parse_mode: 'Markdown' }
    );
  }

  // Lock challenger tokens and create challenge row
  const duel = await db.createDuelChallenge(challengerId, targetId, amount);
  const { pot, fee, payout } = calcPayout(amount);
  const challengerName = challengerUsername ? `@${challengerUsername}` : (challengerFirst || 'Someone');
  const targetName = targetUser.username ? `@${targetUser.username}` : (targetUser.first_name || 'Opponent');

  // Send DM to target
  let targetMsgId = null;
  try {
    const targetMsg = await bot.sendMessage(targetId,
      `⚔️ *Private Duel Challenge!*\n\n` +
      `*${challengerName}* has challenged YOU specifically to a battle!\n\n` +
      `💰 Amount: \`${formatBalance(amount)}\` $YC each\n` +
      `🏆 Winner takes: \`${formatBalance(payout)}\` $YC _(after 5% house fee)_\n` +
      `⏰ Expires in: 5 minutes`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Accept Challenge', callback_data: `accept_duel_${duel.id}` },
            { text: '❌ Decline', callback_data: `decline_duel_${duel.id}` }
          ]]
        }
      }
    );
    targetMsgId = targetMsg.message_id;
  } catch {
    // Can't DM target — cancel and refund
    await db.cancelDuel(duel.id);
    return await bot.sendMessage(chatId,
      `❌ Couldn't reach *${targetName}* via DM. They need to start a private chat with the bot first.\n\nYour \`${formatBalance(amount)}\` $YC has been refunded.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Send confirmation to challenger
  const challengerMsg = await bot.sendMessage(chatId,
    `⚔️ *Challenge Sent!*\n\n` +
    `Your challenge to *${targetName}* for \`${formatBalance(amount)}\` $YC has been sent.\n` +
    `⏰ Waiting for them to accept _(expires in 5 minutes)_`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '❌ Cancel Challenge', callback_data: `cancel_duel_${duel.id}` }
        ]]
      }
    }
  );

  await db.setDuelMessageIds(duel.id, challengerMsg.message_id, targetMsgId);
}

// ── Accept ────────────────────────────────────────────────────────────────────

async function handleDuelAccept(bot, from, cbQuery, duelId) {
  const userId = String(from.id);

  const duel = await db.getDuelChallenge(duelId);
  if (!duel) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge not found.', true);
  }
  if (String(duel.target_id) !== userId) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ This challenge is not for you.', true);
  }

  const statusMessages = {
    cancelled: 'This challenge was cancelled.',
    expired:   'This challenge has expired.',
    completed: 'This challenge has already been resolved.',
    declined:  'This challenge was already declined.',
  };
  if (duel.status !== 'pending') {
    return await safeAnswerCb(bot, cbQuery.id, statusMessages[duel.status] || 'Challenge is no longer active.', true);
  }

  const targetUser = await db.getUser(userId);
  if ((targetUser.gamble_balance || 0) < duel.amount) {
    return await safeAnswerCb(bot, cbQuery.id,
      `❌ You need ${formatBalance(duel.amount)} $YC in your Gamble Balance to accept.`, true
    );
  }

  await safeAnswerCb(bot, cbQuery.id);

  const result = await db.acceptDuel(duelId);
  if (!result) {
    return await bot.sendMessage(from.id, `❌ Challenge is no longer active.`);
  }
  if (result.insufficientBalance) {
    return await bot.sendMessage(from.id,
      `❌ You need \`${formatBalance(result.required)}\` $YC but only have \`${formatBalance(result.available)}\`.`,
      { parse_mode: 'Markdown' }
    );
  }

  const { winnerId, challengerRoll, opponentRoll, pot, fee, payout } = result;

  const challengerUser = await db.getUser(duel.challenger_id);
  const challengerName = challengerUser?.username ? `@${challengerUser.username}` : (challengerUser?.first_name || 'Challenger');
  const opponentName = from.username ? `@${from.username}` : (from.first_name || 'Opponent');
  const winnerName = winnerId === duel.challenger_id ? challengerName : opponentName;

  const resultText =
    `⚔️ *Duel Result!*\n\n` +
    `🎲 ${challengerName}: \`${challengerRoll}\` vs ${opponentName}: \`${opponentRoll}\`\n\n` +
    `🏆 Winner: *${winnerName}*\n` +
    `💰 Prize: \`${formatBalance(payout)}\` $YC _(after 5% house fee)_\n` +
    `🏠 House fee: \`${formatBalance(fee)}\` $YC\n` +
    `📊 Total pot: \`${formatBalance(pot)}\` $YC`;

  // Edit target's message (the one with the buttons)
  await safeEdit(bot, from.id, cbQuery.message.message_id, resultText);

  // Edit challenger's message
  if (duel.challenger_message_id) {
    await safeEdit(bot, duel.challenger_id, duel.challenger_message_id, resultText);
  } else {
    try { await bot.sendMessage(duel.challenger_id, resultText, { parse_mode: 'Markdown' }); } catch {}
  }
}

// ── Decline ───────────────────────────────────────────────────────────────────

async function handleDuelDecline(bot, from, cbQuery, duelId) {
  const userId = String(from.id);

  const duel = await db.getDuelChallenge(duelId);
  if (!duel) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge not found.', true);
  }
  if (String(duel.target_id) !== userId) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ This challenge is not for you.', true);
  }
  if (duel.status !== 'pending') {
    return await safeAnswerCb(bot, cbQuery.id, 'Challenge is no longer active.', true);
  }

  await safeAnswerCb(bot, cbQuery.id);
  await db.declineDuel(duelId);

  const targetName = from.username ? `@${from.username}` : (from.first_name || 'Opponent');

  // Edit target's message
  await safeEdit(bot, from.id, cbQuery.message.message_id,
    `❌ *Duel Declined*\n\nYou declined the challenge.`
  );

  // Edit/notify challenger
  const challengerText =
    `❌ *Duel Declined*\n\n` +
    `*${targetName}* declined your challenge of \`${formatBalance(duel.amount)}\` $YC.\n` +
    `Your tokens have been refunded.`;

  if (duel.challenger_message_id) {
    await safeEdit(bot, duel.challenger_id, duel.challenger_message_id, challengerText);
  } else {
    try { await bot.sendMessage(duel.challenger_id, challengerText, { parse_mode: 'Markdown' }); } catch {}
  }
}

// ── Cancel ────────────────────────────────────────────────────────────────────

async function handleDuelCancel(bot, from, cbQuery, duelId) {
  const userId = String(from.id);

  const duel = await db.getDuelChallenge(duelId);
  if (!duel) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge not found.', true);
  }
  if (String(duel.challenger_id) !== userId) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Only the challenger can cancel.', true);
  }
  if (duel.status !== 'pending') {
    return await safeAnswerCb(bot, cbQuery.id, 'Challenge is no longer active.', true);
  }

  await safeAnswerCb(bot, cbQuery.id);
  await db.cancelDuel(duelId);

  // Edit challenger's message
  await safeEdit(bot, from.id, cbQuery.message.message_id,
    `❌ *Challenge Cancelled*\n\nYour \`${formatBalance(duel.amount)}\` $YC has been refunded.`
  );

  // Edit target's message
  if (duel.target_message_id) {
    await safeEdit(bot, duel.target_id, duel.target_message_id,
      `❌ *Challenge Cancelled*\n\nThe challenger cancelled this duel.`
    );
  }
}

// ── Expiry background job ─────────────────────────────────────────────────────

async function startDuelExpiryJob(bot) {
  const tick = async () => {
    try {
      const expired = await db.getExpiredDuels();
      for (const duel of expired) {
        try {
          await db.expireDuel(duel.id);

          const expiryText =
            `⏰ *Duel Expired*\n\n` +
            `Your challenge of \`${formatBalance(duel.amount)}\` $YC has expired. Tokens refunded.`;

          if (duel.challenger_message_id) {
            await safeEdit(bot, duel.challenger_id, duel.challenger_message_id, expiryText);
          } else {
            try { await bot.sendMessage(duel.challenger_id, expiryText, { parse_mode: 'Markdown' }); } catch {}
          }

          if (duel.target_message_id) {
            await safeEdit(bot, duel.target_id, duel.target_message_id,
              `⏰ *Duel Expired*\n\nThe challenge has expired.`
            );
          }
        } catch (err) {
          console.error(`[Duel] Error expiring duel #${duel.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[Duel] Expiry job error:', err.message);
    }
  };

  setInterval(tick, 60 * 1000);
  console.log('[Duel] Expiry job started (60s interval)');
}

module.exports = { handleDirectChallenge, handleDuelAccept, handleDuelDecline, handleDuelCancel, startDuelExpiryJob };
