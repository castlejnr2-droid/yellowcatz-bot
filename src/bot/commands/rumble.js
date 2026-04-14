const db = require('../../db/queries');
const { pool } = require('../../db');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MIN_WAGER = 100;

const activeRumbles = new Map();

// Called once on bot startup — cleans up any rumbles left in 'waiting' state
async function recoverRumbles(bot) {
  try {
    const { rows: stuckRumbles } = await pool.query(
      `SELECT r.id, r.wager_amount, r.chat_id,
              json_agg(json_build_object('userId', rp.user_id, 'username', rp.username, 'firstName', rp.first_name)) AS players
       FROM rumbles r
       JOIN rumble_players rp ON rp.rumble_id = r.id
       WHERE r.status = 'waiting'
       GROUP BY r.id`
    );

    if (stuckRumbles.length === 0) {
      console.log('[RUMBLE RECOVERY] No stuck rumbles found.');
      return;
    }

    console.log(`[RUMBLE RECOVERY] Found ${stuckRumbles.length} stuck rumble(s) — refunding and cancelling...`);

    for (const rumble of stuckRumbles) {
      for (const player of rumble.players || []) {
        await pool.query(
          'UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
          [rumble.wager_amount, player.userId]
        );
      }

      await pool.query('UPDATE rumbles SET status = $1 WHERE id = $2', ['cancelled', rumble.id]);

      console.log(`[RUMBLE RECOVERY] Cancelled rumble #${rumble.id}, refunded ${rumble.players.length} player(s).`);

      if (rumble.chat_id && bot) {
        try {
          await bot.sendMessage(rumble.chat_id,
            `⏰ *Rumble #${rumble.id} was cancelled* — the bot restarted before it could begin.\nAll wagers have been refunded.`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
    }

    console.log('[RUMBLE RECOVERY] Done.');
  } catch (err) {
    console.error('[RUMBLE RECOVERY] Error:', err.message);
  }
}

async function handleRumbleCommand(bot, msg, args) {
  const { id: telegramId, username, first_name: firstName } = msg.from;
  const chatId = msg.chat.id;

  if (!args || args.length < 2) {
    return bot.sendMessage(chatId,
      `🥊 *Rumble Mode*\n\n` +
      `Usage: \`/rumble <players> <wager>\`\n\n` +
      `Example: \`/rumble 10 5000\`\n` +
      `• Min players: ${MIN_PLAYERS}, Max: ${MAX_PLAYERS}\n` +
      `• Min wager: ${MIN_WAGER} $YC\n` +
      `• Last player standing wins the entire pot!`,
      { parse_mode: 'Markdown' }
    );
  }

  const maxPlayers = parseInt(args[0]);
  const wager = parseFloat(args[1]);

  if (isNaN(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
    return bot.sendMessage(chatId,
      `❌ Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (isNaN(wager) || wager < MIN_WAGER) {
    return bot.sendMessage(chatId,
      `❌ Minimum wager is ${MIN_WAGER} $YC.`,
      { parse_mode: 'Markdown' }
    );
  }

  const user = await db.getOrCreateUser({ telegramId, username, firstName });

  if ((user.gamble_balance || 0) < wager) {
    return bot.sendMessage(chatId,
      `🐱 *Insufficient Gamble Balance!*\n\nYou need \`${wager}\` but only have \`${user.gamble_balance}\` $YC.`,
      { parse_mode: 'Markdown' }
    );
  }

  await pool.query('UPDATE users SET gamble_balance = gamble_balance - $1 WHERE telegram_id = $2',
    [wager, String(telegramId)]);

  const res = await pool.query(
    'INSERT INTO rumbles (max_players, wager_amount, status, chat_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [maxPlayers, wager, 'waiting', String(chatId)]
  );
  const rumbleId = res.rows[0].id;

  await pool.query(
    'INSERT INTO rumble_players (rumble_id, user_id, username, first_name) VALUES ($1, $2, $3, $4)',
    [rumbleId, String(telegramId), username, firstName]
  );

  const pot = wager * maxPlayers;
  const players = [{ userId: String(telegramId), username, firstName }];
  const text = getRumbleLobbyText(rumbleId, maxPlayers, wager, pot, players);

  const sentMsg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: `⚔️ Join Rumble (#${rumbleId})`, callback_data: `join_rumble_${rumbleId}` }
      ]]
    }
  });

  activeRumbles.set(rumbleId, {
    chatId,
    msgId: sentMsg.message_id,
    hostId: String(telegramId),
    players,
    maxPlayers,
    wager,
    pot,
    timer: setTimeout(() => cancelRumble(bot, rumbleId), 5 * 60 * 1000)
  });
}

async function handleJoinRumble(bot, callbackQuery, rumbleId) {
  const { id: telegramId, username, first_name: firstName } = callbackQuery.from;
  const chatId = callbackQuery.message.chat.id;

  let rumble = activeRumbles.get(rumbleId);

  // DB fallback if rumble not in memory (after bot restart)
  if (!rumble) {
    try {
      const { rows } = await pool.query(`
        SELECT r.id, r.max_players, r.wager_amount, r.chat_id,
               json_agg(json_build_object('userId', rp.user_id, 'username', rp.username, 'firstName', rp.first_name)) AS players
        FROM rumbles r
        JOIN rumble_players rp ON rp.rumble_id = r.id
        WHERE r.id = $1 AND r.status = 'waiting'
        GROUP BY r.id
      `, [rumbleId]);

      if (rows.length === 0) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This rumble no longer exists or has already started.' });
      }

      const dbRumble = rows[0];
      rumble = {
        chatId: parseInt(dbRumble.chat_id),
        msgId: callbackQuery.message.message_id,
        hostId: dbRumble.players && dbRumble.players[0] ? dbRumble.players[0].userId : null,
        players: dbRumble.players || [],
        maxPlayers: dbRumble.max_players,
        wager: parseFloat(dbRumble.wager_amount),
        pot: parseFloat(dbRumble.wager_amount) * (dbRumble.players ? dbRumble.players.length : 0),
        timer: null
      };

      activeRumbles.set(rumbleId, rumble);
      console.log(`[RUMBLE] Loaded rumble #${rumbleId} from database after restart`);
    } catch (err) {
      console.error('[RUMBLE] DB fallback failed:', err.message);
      return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This rumble no longer exists.' });
    }
  }

  // Normal join logic
  if (rumble.players.find(p => p.userId === String(telegramId))) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ You already joined this rumble!' });
  }

  const user = await db.getOrCreateUser({ telegramId, username, firstName });

  if ((user.gamble_balance || 0) < rumble.wager) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `❌ Insufficient balance! Need ${rumble.wager} $YC.`
    });
  }

  await pool.query('UPDATE users SET gamble_balance = gamble_balance - $1 WHERE telegram_id = $2',
    [rumble.wager, String(telegramId)]);

  await pool.query(
    'INSERT INTO rumble_players (rumble_id, user_id, username, first_name) VALUES ($1, $2, $3, $4)',
    [rumbleId, String(telegramId), username, firstName]
  );

  rumble.players.push({ userId: String(telegramId), username, firstName });

  await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ You joined the rumble!' });

  const isFull = rumble.players.length >= rumble.maxPlayers;
  const canStartEarly = !isFull && rumble.players.length >= MIN_PLAYERS;
  const displayPot = rumble.wager * rumble.players.length;
  const text = getRumbleLobbyText(rumbleId, rumble.maxPlayers, rumble.wager, displayPot, rumble.players);

  let inlineKeyboard = [];
  if (!isFull) {
    const row = [{ text: `⚔️ Join Rumble (#${rumbleId})`, callback_data: `join_rumble_${rumbleId}` }];
    if (canStartEarly) {
      row.push({ text: `🚀 Start Now (Host Only)`, callback_data: `start_rumble_${rumbleId}` });
    }
    inlineKeyboard.push(row);
  }

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: rumble.msgId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: inlineKeyboard }
  });

  if (isFull) {
    if (rumble.timer) clearTimeout(rumble.timer);
    setTimeout(() => startRumble(bot, rumbleId), 2000);
  }
}

async function handleStartRumbleEarly(bot, callbackQuery, rumbleId) {
  const { id: telegramId } = callbackQuery.from;

  const rumble = activeRumbles.get(rumbleId);
  if (!rumble) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This rumble no longer exists.' });
  }

  if (String(telegramId) !== rumble.hostId) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '⛔ Only the rumble host can start early!',
      show_alert: true
    });
  }

  if (rumble.players.length < MIN_PLAYERS) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `⚠️ Need at least ${MIN_PLAYERS} players to start early.`,
      show_alert: true
    });
  }

  await bot.answerCallbackQuery(callbackQuery.id, { text: '🚀 Starting rumble early!' });

  rumble.pot = rumble.wager * rumble.players.length;

  const finalText = getRumbleLobbyText(rumbleId, rumble.maxPlayers, rumble.wager, rumble.pot, rumble.players, true);

  await bot.editMessageText(finalText, {
    chat_id: rumble.chatId,
    message_id: rumble.msgId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [] }
  });

  clearTimeout(rumble.timer);
  setTimeout(() => startRumble(bot, rumbleId), 2000);
}

async function startRumble(bot, rumbleId) {
  const rumble = activeRumbles.get(rumbleId);
  if (!rumble) return;

  await pool.query('UPDATE rumbles SET status = $1 WHERE id = $2', ['active', rumbleId]);

  let survivors = [...rumble.players];
  let roundNum = 1;

  await bot.sendMessage(rumble.chatId,
    `🥊 *RUMBLE #${rumbleId} BEGINS!*\n💰 Pot: *${rumble.pot.toLocaleString()} $YC*\n👥 ${survivors.length} fighters enter!`,
    { parse_mode: 'Markdown' }
  );
  await sleep(2000);

  while (survivors.length > 1) {
    await bot.sendMessage(rumble.chatId,
      `⚔️ *Round ${roundNum}* — ${survivors.length} fighters remain!`,
      { parse_mode: 'Markdown' }
    );
    await sleep(1500);

    survivors = shuffle(survivors);
    const nextSurvivors = [];

    for (let i = 0; i < survivors.length; i += 2) {
      if (i + 1 >= survivors.length) {
        nextSurvivors.push(survivors[i]);
        await bot.sendMessage(rumble.chatId,
          `🛡️ *${getDisplayName(survivors[i])}* gets a bye this round!`,
          { parse_mode: 'Markdown' }
        );
        await sleep(1000);
        continue;
      }

      const p1 = survivors[i];
      const p2 = survivors[i + 1];
      const p1Roll = Math.floor(Math.random() * 6) + 1;
      const p2Roll = Math.floor(Math.random() * 6) + 1;

      let winner, loser;
      if (p1Roll >= p2Roll) {
        winner = p1; loser = p2;
      } else {
        winner = p2; loser = p1;
      }

      nextSurvivors.push(winner);

      await bot.sendMessage(rumble.chatId,
        `🎲 *${getDisplayName(p1)}* [${p1Roll}] vs *${getDisplayName(p2)}* [${p2Roll}]\n💀 *${getDisplayName(loser)}* has been eliminated!`,
        { parse_mode: 'Markdown' }
      );
      await sleep(1500);
    }

    survivors = nextSurvivors;
    roundNum++;
    await sleep(1000);
  }

  const winner = survivors[0];

  await pool.query('UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
    [rumble.pot, winner.userId]);

  await pool.query('UPDATE rumbles SET status = $1, winner_id = $2 WHERE id = $3',
    ['completed', winner.userId, rumbleId]);

  await bot.sendMessage(rumble.chatId,
    `🏆 *RUMBLE OVER!*\n\n👑 *${getDisplayName(winner)}* is the last one standing!\n\n💰 *${rumble.pot.toLocaleString()} $YC* added to their Gamble balance!\n\n_GG to all fighters!_ 🐱`,
    { parse_mode: 'Markdown' }
  );

  activeRumbles.delete(rumbleId);
}

async function cancelRumble(bot, rumbleId) {
  const rumble = activeRumbles.get(rumbleId);
  if (!rumble) return;

  for (const player of rumble.players) {
    await pool.query('UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
      [rumble.wager, player.userId]);
  }

  await pool.query('UPDATE rumbles SET status = $1 WHERE id = $2', ['cancelled', rumbleId]);

  await bot.sendMessage(rumble.chatId,
    `⏰ *Rumble #${rumbleId} cancelled* — not enough players joined in time.\nAll wagers have been refunded.`,
    { parse_mode: 'Markdown' }
  );

  activeRumbles.delete(rumbleId);
}

function getRumbleLobbyText(rumbleId, maxPlayers, wager, pot, players, started = false) {
  const playerList = players.map((p, i) => `${i + 1}. ${getDisplayName(p)}`).join('\n');
  const footer = started
    ? `_Host started early — battle beginning now!_`
    : players.length >= MIN_PLAYERS
      ? `_${maxPlayers - players.length} spot(s) left · Host can start early or wait for more!_`
      : `_Rumble starts when all ${maxPlayers} spots are filled or cancels after 5 minutes!_`;

  return `🥊 *RUMBLE #${rumbleId}*\n\n` +
    `💰 Wager: *${wager.toLocaleString()} $YC* per fighter\n` +
    `🏆 Current Pot: *${pot.toLocaleString()} $YC*\n` +
    `👥 Players: *${players.length}/${maxPlayers}*\n\n` +
    `*Fighters:*\n${playerList}\n\n` +
    footer;
}

function getDisplayName(player) {
  return player.username ? `@${player.username}` : (player.firstName || player.first_name || 'Unknown');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { handleRumbleCommand, handleJoinRumble, handleStartRumbleEarly, recoverRumbles };
