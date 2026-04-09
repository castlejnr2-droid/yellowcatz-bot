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
  const received = req.headers['authorization'];

  if (secret && received !== secret) {
    console.warn(
      `[Webhook] Auth FAILED from ${req.ip}` +
      ` — expected secret (${secret.length} chars),` +
      ` got: ${received ? `"${received.slice(0, 8)}..." (${received.length} chars)` : 'MISSING'}`
    );
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
router.post('/helius', (req, res, next) => {
  const auth = req.headers['authorization'];
  console.log(
    `[Webhook] Incoming POST /api/webhook/helius` +
    ` | ip=${req.ip}` +
    ` | auth=${auth ? `present (${auth.length} chars)` : 'MISSING'}` +
    ` | content-type=${req.headers['content-type'] || 'none'}` +
    ` | body-events=${Array.isArray(req.body) ? req.body.length : (req.body ? 1 : 0)}`
  );
  next();
}, verifyHelius, async (req, res) => {
  // Acknowledge immediately — Helius retries on non-2xx for up to 24 hours
  res.json({ ok: true });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const mintAddress = process.env.YELLOWCATZ_TOKEN_MINT;

  console.log(`[Webhook] Processing ${events.length} event(s) | YELLOWCATZ_TOKEN_MINT=${mintAddress || 'NOT SET'}`);

  // Dump the raw payload of the first event so we can verify field names
  if (events[0]) {
    const e0 = events[0];
    console.log(`[Webhook] RAW event[0] keys: ${Object.keys(e0).join(', ')}`);
    console.log(`[Webhook] event[0].type=${e0.type} | signature=${String(e0.signature || '').slice(0, 16)}...`);
    const transfers = e0.tokenTransfers || e0.token_transfers || [];
    console.log(`[Webhook] event[0].tokenTransfers count: ${transfers.length}`);
    if (transfers[0]) {
      console.log(`[Webhook] tokenTransfers[0] keys: ${Object.keys(transfers[0]).join(', ')}`);
      console.log(`[Webhook] tokenTransfers[0] = ${JSON.stringify(transfers[0])}`);
    }
  }

  for (const event of events) {
    try {
      const signature = event.signature;
      const transfers = event.tokenTransfers || event.token_transfers || [];

      for (const transfer of transfers) {
        // Only care about transfers of our token into a token account
        if (transfer.mint !== mintAddress) {
          console.log(`[Webhook] SKIP transfer — mint mismatch: got=${transfer.mint} want=${mintAddress}`);
          continue;
        }
        const ataAddress = transfer.toTokenAccount;
        const amount = Number(transfer.tokenAmount);
        if (!ataAddress || !amount || amount <= 0) {
          console.log(`[Webhook] SKIP transfer — invalid ataAddress=${ataAddress} amount=${amount}`);
          continue;
        }

        console.log(`[Webhook] Matched transfer: to=${ataAddress} amount=${amount} mint=${transfer.mint}`);

        // Find which user owns this ATA
        const userRes = await query(
          'SELECT telegram_id FROM users WHERE deposit_ata = $1',
          [ataAddress]
        );
        if (!userRes.rows[0]) {
          console.log(`[Webhook] SKIP — no user in DB with deposit_ata=${ataAddress}`);
          // Log nearby ATAs to catch near-misses (old vs new address after migration)
          const nearby = await query(
            'SELECT telegram_id, deposit_ata FROM users WHERE deposit_ata IS NOT NULL LIMIT 5'
          );
          console.log(`[Webhook] Sample DB deposit_ata values: ${nearby.rows.map(r => r.deposit_ata).join(', ')}`);
          continue;
        }

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
