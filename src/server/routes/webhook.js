const express = require('express');
const router = express.Router();
const { query, pool } = require('../../db');
const { sweepUserATA } = require('../../solana/depositPoller');

// Bot reference — set after bot is created via setBot()
let _bot = null;
function setBot(bot) { _bot = bot; }

// Helius sends the value of your authHeader field in the Authorization header
function verifyHelius(req, res, next) {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (secret && req.headers['authorization'] !== secret) {
    console.warn('[Webhook] Rejected unauthorized request from', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST /api/webhook/helius
 *
 * Helius Enhanced Transaction webhook. Fires immediately when any transaction
 * touches a monitored address (the token mint). We filter for transfers into
 * known user ATAs, credit the user, then sweep to hot wallet.
 */
router.post('/helius', verifyHelius, async (req, res) => {
  // Acknowledge immediately — Helius retries on non-2xx for up to 24 hours
  res.json({ ok: true });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const mintAddress = process.env.YELLOWCATZ_TOKEN_MINT;

  for (const event of events) {
    try {
      const signature = event.signature;
      const transfers = event.tokenTransfers || [];

      for (const transfer of transfers) {
        // Only care about transfers of our token into a token account
        if (transfer.mint !== mintAddress) continue;
        const ataAddress = transfer.toTokenAccount;
        const amount = Number(transfer.tokenAmount);
        if (!ataAddress || !amount || amount <= 0) continue;

        // Find which user owns this ATA
        const userRes = await query(
          'SELECT telegram_id FROM users WHERE deposit_ata = $1',
          [ataAddress]
        );
        if (!userRes.rows[0]) continue; // Not one of our ATAs

        const telegramId = userRes.rows[0].telegram_id;

        // Dedup — signature is unique per on-chain tx
        const already = await query('SELECT id FROM deposits WHERE tx_signature = $1', [signature]);
        if (already.rows.length > 0) {
          console.log(`[Webhook] Already processed tx ${signature.slice(0, 12)}... for user ${telegramId}, skipping`);
          continue;
        }

        // Credit user
        const client = await pool.connect();
        let credited = false;
        try {
          await client.query('BEGIN');
          await client.query(
            'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
            [telegramId, amount, signature, ataAddress]
          );
          await client.query(
            'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
            [amount, telegramId]
          );
          await client.query('COMMIT');
          credited = true;
          console.log(`[Webhook] Credited ${amount} $YC to user ${telegramId} (tx: ${signature.slice(0, 12)}...)`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[Webhook] Failed to credit user ${telegramId}:`, err.message);
        } finally {
          client.release();
        }

        if (!credited) continue;

        // Auto-sweep to hot wallet
        try {
          const swept = await sweepUserATA(telegramId);
          if (swept) {
            console.log(`[Webhook] Auto-swept ${swept.amount} $YC from user ${telegramId} (tx: ${swept.signature.slice(0, 12)}...)`);
          }
        } catch (sweepErr) {
          console.error(`[Webhook] Auto-sweep failed for user ${telegramId}:`, sweepErr.message);
        }

        // Notify user via Telegram
        if (_bot) {
          try {
            const shortTx = signature.slice(0, 12) + '...' + signature.slice(-8);
            await _bot.sendMessage(telegramId,
              `✅ *Deposit Received!*\n\n` +
              `Amount: \`${amount.toLocaleString()}\` $YC\n` +
              `TX: \`${shortTx}\`\n\n` +
              `Tokens credited to your 💲 Spot Balance!`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            console.error(`[Webhook] Failed to notify user ${telegramId}:`, e.message);
          }
        }
      }
    } catch (err) {
      console.error('[Webhook] Error processing event:', err.message, err.stack || '');
    }
  }
});

module.exports = { router, setBot };
