const db = require('../../db/queries');
const { pool } = require('../../db');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MIN_WAGER = 100;

const activeRumbles = new Map();

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

// Called once on bot startup — cleans up stuck rumbles
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

      console.log(`[RUMBLE RECOVERY] Cancelled rumble #${rumble.id}, refunded ${rumble.players?.length || 0} player(s).`);

      if (rumble.chat_id && bot) {
        try {
          await bot.sendMessage(rumble.chat_id,
            `⏰ <b>Rumble #${rumble.id} was cancelled</b> — the bot restarted before it could begin.\nAll wagers have been refunded.`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {}
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
      `🥊 <b>RUMBLE MODE</b>\n\n` +
      `Usage: /rumble &lt;players&gt; &lt;wager&gt;\n\n` +
      `Example: /rumble 10 5000\n` +
      `• Min players: ${MIN_PLAYERS}, Max: ${MAX_PLAYERS}\n` +
      `• Min wager: ${MIN_WAGER} $YC\n` +
      `• Last player standing wins the
