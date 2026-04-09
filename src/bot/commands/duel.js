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
    await bot.answerCallbackQuery(queryId, text ? { text, show_alert: showAlert } : {});
  } catch {}
}

// Edit a stored message; silently swallow errors (message may be too old, etc.)
async function safeEdit(bot, chatId, msgId, text, opts = {}) {
  if (!chatId || !msgId) return;
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...opts });
  } catch {}
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
  const { payout } = calcPayout(amount);
  const challengerName = challengerUsername ? `@${challengerUsername}` : (challengerFirst || 'Someone');
  const targetName = targetUser.username ? `@${targetUser.username}` : (targetUser.first_name || 'Opponent');

  // 1. Post the challenge message IN THIS CHAT — always works (group or DM)
  const challengeMsg = await bot.sendMessage(chatId,
    `⚔️ *Direct Duel Challenge!*\n\n` +
    `*${challengerName}* has challenged *${targetName}* to a battle!\n\n` +
    `💰 Amount: \`${formatBalance(amount)}\` $YC each\n` +
    `🏆 Winner takes: \`${formatBalance(payout)}\` $YC _(after 5% house fee)_\n` +
    `⏰ Expires in 5 minutes\n\n` +
    `${targetName} — tap below to respond!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept', callback_data: `accept_duel_${duel.id}` },
          { text: '❌ Decline', callback_data: `decline_duel_${duel.id}` }
        ]]
      }
    }
  );

  // 2. Bonus: try to DM the target a heads-up notification (fire-and-forget, no buttons)
  try {
    await bot.sendMessage(targetId,
      `⚔️ *You've been challenged to a duel!*\n\n` +
      `*${challengerName}* challenged you to a \`${formatBalance(amount)}\` $YC battle.\n\n` +
      `Go to the chat and tap *Accept* to respond!`,
      { parse_mode: 'Markdown' }
    );
  } catch { /* target hasn't DM'd the bot — fine, they'll see it in the chat */ }

  // 3. Send Cancel button to challenger — try DM first, fallback to same chat
  let cancelMsgId = null;
  let cancelChatId = null;
  try {
    const cancelMsg = await bot.sendMessage(challengerId,
      `⚔️ *Challenge Sent!*\n\n` +
      `Your challenge to *${targetName}* for \`${formatBalance(amount)}\` $YC is live.\n` +
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
    cancelMsgId = cancelMsg.message_id;
    cancelChatId = challengerId; // private chat ID = user ID
  } catch {
    // Challenger DM failed — put the Cancel button in the same chat
    try {
      const cancelMsg = await bot.sendMessage(chatId,
        `${challengerName} — use the button below if you want to cancel:`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '❌ Cancel Challenge', callback_data: `cancel_duel_${duel.id}` }
            ]]
          }
        }
      );
      cancelMsgId = cancelMsg.message_id;
      cancelChatId = chatId;
    } catch {}
  }

  // Store: challenger_message_id = cancel msg, target_message_id = challenge msg
  await db.setDuelMessageIds(duel.id, cancelMsgId, challengeMsg.message_id, chatId, cancelChatId);
}

// ── Accept ────────────────────────────────────────────────────────────────────

async function handleDuelAccept(bot, from, cbQuery, duelId) {
  const userId = String(from.id);

  const duel = await db.getDuelChallenge(duelId);
  if (!duel) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge not found.', true);
  }

  // Identity guards — specific error messages per spec
  if (String(duel.challenger_id) === userId) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ You cannot accept your own challenge.', true);
  }
  if (String(duel.target_id) !== userId) {
    const targetUser = await db.getUser(duel.target_id);
    const targetName = targetUser?.username ? `@${targetUser.username}` : 'the intended recipient';
    return await safeAnswerCb(bot, cbQuery.id, `❌ This challenge is for ${targetName} only.`, true);
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

  await safeAnswerCb(bot, cbQuery.id); // ACK before DB work

  const result = await db.acceptDuel(duelId);
  if (!result) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge is no longer active.', true);
  }
  if (result.insufficientBalance) {
    // Race condition — balance changed between check and lock
    return await bot.sendMessage(from.id,
      `❌ You need \`${formatBalance(result.required)}\` $YC but only have \`${formatBalance(result.available)}\`.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
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

  // Edit the challenge message in the group chat
  await safeEdit(bot, duel.challenge_chat_id, duel.target_message_id, resultText);
  // Edit the cancel message
  await safeEdit(bot, duel.cancel_chat_id, duel.challenger_message_id, resultText);
}

// ── Decline ───────────────────────────────────────────────────────────────────

async function handleDuelDecline(bot, from, cbQuery, duelId) {
  const userId = String(from.id);

  const duel = await db.getDuelChallenge(duelId);
  if (!duel) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ Challenge not found.', true);
  }
  if (String(duel.challenger_id) === userId) {
    return await safeAnswerCb(bot, cbQuery.id, '❌ You cannot decline your own challenge. Use Cancel instead.', true);
  }
  if (String(duel.target_id) !== userId) {
    const targetUser = await db.getUser(duel.target_id);
    const targetName = targetUser?.username ? `@${targetUser.username}` : 'the intended recipient';
    return await safeAnswerCb(bot, cbQuery.id, `❌ This challenge is for ${targetName} only.`, true);
  }
  if (duel.status !== 'pending') {
    return await safeAnswerCb(bot, cbQuery.id, 'Challenge is no longer active.', true);
  }

  await safeAnswerCb(bot, cbQuery.id);
  await db.declineDuel(duelId);

  const targetName = from.username ? `@${from.username}` : (from.first_name || 'Opponent');

  const declinedText =
    `❌ *Duel Declined*\n\n` +
    `*${targetName}* declined the challenge.\n` +
    `\`${formatBalance(duel.amount)}\` $YC has been refunded to the challenger.`;

  await safeEdit(bot, duel.challenge_chat_id, duel.target_message_id, declinedText);
  await safeEdit(bot, duel.cancel_chat_id, duel.challenger_message_id, declinedText);
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

  const cancelledText =
    `❌ *Challenge Cancelled*\n\n` +
    `The challenger cancelled this duel.\n` +
    `\`${formatBalance(duel.amount)}\` $YC has been refunded.`;

  await safeEdit(bot, duel.challenge_chat_id, duel.target_message_id, cancelledText);
  await safeEdit(bot, duel.cancel_chat_id, duel.challenger_message_id, cancelledText);
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
            `The challenge has expired.\n` +
            `\`${formatBalance(duel.amount)}\` $YC has been refunded to the challenger.`;

          await safeEdit(bot, duel.challenge_chat_id, duel.target_message_id, expiryText);
          await safeEdit(bot, duel.cancel_chat_id, duel.challenger_message_id, expiryText);
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
