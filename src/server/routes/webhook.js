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
 * Helius Enhanced Transaction webhook. Token-2022 transfers do NOT populate
 * tokenTransfers in the Helius payload, so we parse deposits from the raw
 * meta.preTokenBalances / meta.postTokenBalances instead.
 *
 * For each account whose YC balance increased:
 *   1. Resolve its address from transaction.message.accountKeys[accountIndex]
 *   2. Look up the matching user in the DB by deposit_ata
 *   3. Credit the user and trigger a sweep to the hot wallet
 */
router.post('/helius', (req, res, next) => {
  const auth = req.headers['authorization'];
  console.log(
    `[Webhook] Incoming POST /api/webhook/helius` +
    ` | ip=${req.ip}` +
    ` | auth=${auth ? `present (${auth.length} chars)` : 'MISSING'}` +
    ` | events=${Array.isArray(req.body) ? req.body.length : (req.body ? 1 : 0)}`
  );
  next();
}, verifyHelius, async (req, res) => {
  // Acknowledge immediately — Helius retries on non-2xx for up to 24 hours
  res.json({ ok: true });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  const mintAddress = process.env.YELLOWCATZ_TOKEN_MINT;

  console.log(`[Webhook] Processing ${events.length} event(s) | mint=${mintAddress || 'NOT SET'}`);

  for (const event of events) {
    try {
      const signature = event.signature;

      // Resolve account key list — handles both legacy and versioned transactions
      const message = event.transaction?.message;
      const rawKeys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
      const accountKeys = rawKeys.map(k => (typeof k === 'string' ? k : k?.pubkey ?? String(k)));

      const pre  = event.meta?.preTokenBalances  ?? [];
      const post = event.meta?.postTokenBalances ?? [];

      console.log(`[Webhook] tx=${String(signature).slice(0, 16)}... | accounts=${accountKeys.length} | preBalances=${pre.length} | postBalances=${post.length}`);

      for (const postBal of post) {
        // Only our mint
        if (postBal.mint !== mintAddress) continue;

        const accountIndex = postBal.accountIndex;
        const ataAddress   = accountKeys[accountIndex];
        if (!ataAddress) {
          console.log(`[Webhook] SKIP — no accountKey at index ${accountIndex}`);
          continue;
        }

        // Calculate how much was received (UI amount)
        const preBal    = pre.find(p => p.accountIndex === accountIndex);
        const preAmount  = Number(preBal?.uiTokenAmount?.uiAmount  ?? 0);
        const postAmount = Number(postBal.uiTokenAmount?.uiAmount  ?? 0);
        const delta      = postAmount - preAmount;

        console.log(`[Webhook] Account[${accountIndex}] ${ataAddress.slice(0, 8)}... | pre=${preAmount} post=${postAmount} delta=${delta}`);

        if (delta <= 0) continue;

        // Find which user owns this ATA
        const userRes = await query(
          'SELECT telegram_id FROM users WHERE deposit_ata = $1',
          [ataAddress]
        );
        if (!userRes.rows[0]) {
          console.log(`[Webhook] SKIP — no user in DB with deposit_ata=${ataAddress}`);
          continue;
        }

        const telegramId = userRes.rows[0].telegram_id;
        const amount     = delta;

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
