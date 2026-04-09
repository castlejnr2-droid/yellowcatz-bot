const express = require('express');
const router = express.Router();
const { query, pool } = require('../../db');
const { sweepUserATA } = require('../../solana/depositPoller');

// Bot reference — set after bot is created via setBot()
let _bot = null;
function setBot(bot) { _bot = bot; }

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
 * Look up which user owns a deposit address.
 * Checks deposit_wallets first (most up-to-date), then users.deposit_ata as fallback.
 */
async function findTelegramIdByAddress(address) {
  const dwRes = await query(
    'SELECT user_id FROM deposit_wallets WHERE deposit_address = $1',
    [address]
  );
  if (dwRes.rows[0]) return dwRes.rows[0].user_id;

  const userRes = await query(
    'SELECT telegram_id FROM users WHERE deposit_ata = $1',
    [address]
  );
  return userRes.rows[0]?.telegram_id || null;
}

/**
 * Credit a user and trigger a sweep + notification. Returns true if credited.
 */
async function creditAndSweep(telegramId, amount, signature, fromAddress) {
  // Dedup — tx_signature has a UNIQUE constraint
  const already = await query('SELECT id FROM deposits WHERE tx_signature = $1', [signature]);
  if (already.rows.length > 0) {
    console.log(`[Webhook] Already processed tx ${signature.slice(0, 12)}... for user ${telegramId}, skipping`);
    return false;
  }

  // ── Credit ─────────────────────────────────────────────────────────────────
  console.log(`[Webhook] Crediting userId=${telegramId} with amount=${amount} from=${fromAddress}`);

  const client = await pool.connect();
  let credited = false;
  let newBalance = null;
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
      [telegramId, amount, signature, fromAddress]
    );
    const balRes = await client.query(
      'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING spot_balance',
      [amount, telegramId]
    );
    await client.query('COMMIT');
    credited = true;
    newBalance = balRes.rows[0]?.spot_balance;
    console.log(`[Webhook] Credit SUCCESS userId=${telegramId} new balance=${newBalance}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Webhook] Credit FAILED userId=${telegramId} error=${err.message}`);
  } finally {
    client.release();
  }

  if (!credited) return false;

  // ── Sweep ──────────────────────────────────────────────────────────────────
  console.log(`[Webhook] Sweep attempt for userId=${telegramId} address=${fromAddress}`);
  try {
    const swept = await sweepUserATA(telegramId);
    if (swept) {
      console.log(`[Webhook] Sweep SUCCESS userId=${telegramId} amount=${swept.amount} tx=${swept.signature.slice(0, 16)}...`);
    } else {
      console.log(`[Webhook] Sweep skipped for userId=${telegramId} (ATA empty or not found)`);
    }
  } catch (sweepErr) {
    console.error(`[Webhook] Sweep FAILED userId=${telegramId} error=${sweepErr.message}`, sweepErr.stack || '');
  }

  // ── Notify ─────────────────────────────────────────────────────────────────
  if (_bot) {
    try {
      const shortTx = signature.slice(0, 12) + '...' + signature.slice(-8);
      await _bot.sendMessage(telegramId,
        `✅ *Deposit Received!*\n\n` +
        `Amount: \`${Number(amount).toLocaleString()}\` $YC\n` +
        `TX: \`${shortTx}\`\n\n` +
        `Tokens credited to your 💲 Spot Balance!`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error(`[Webhook] Failed to notify user ${telegramId}:`, e.message);
    }
  }

  return true;
}

/**
 * POST /api/webhook/helius
 *
 * Helius Enhanced Transaction webhook.
 *
 * PRIMARY path: reads event.tokenTransfers[] — the standard Helius format for
 * SPL token transfers. For each transfer whose mint matches YC_TOKEN_MINT and
 * whose toUserAccount is a known deposit address, credit the user and sweep.
 *
 * FALLBACK path: reads meta.preTokenBalances / meta.postTokenBalances for
 * events where tokenTransfers is absent or empty.
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
  const mintAddress = process.env.YC_TOKEN_MINT || process.env.YELLOWCATZ_TOKEN_MINT;

  console.log(`[Webhook] Processing ${events.length} event(s) | mint=${mintAddress || 'NOT SET'}`);

  for (const event of events) {
    try {
      const signature = event.signature;

      // ── PRIMARY: tokenTransfers[] ──────────────────────────────────────────
      const tokenTransfers = Array.isArray(event.tokenTransfers) ? event.tokenTransfers : [];

      console.log(
        `[Webhook] tx=${String(signature).slice(0, 16)}...` +
        ` | tokenTransfers=${tokenTransfers.length}` +
        ` | preBalances=${(event.meta?.preTokenBalances ?? []).length}` +
        ` | postBalances=${(event.meta?.postTokenBalances ?? []).length}`
      );

      for (const transfer of tokenTransfers) {
        if (transfer.mint !== mintAddress) continue;

        const toAddress = transfer.toUserAccount;
        const amount = Number(transfer.tokenAmount || 0);

        if (!toAddress || amount <= 0) continue;

        const telegramId = await findTelegramIdByAddress(toAddress);
        if (!telegramId) {
          console.log(`[Webhook] SKIP tokenTransfer — no user for address ${toAddress}`);
          continue;
        }

        await creditAndSweep(telegramId, amount, signature, toAddress);
      }

      // ── FALLBACK: preTokenBalances / postTokenBalances ─────────────────────
      // Used when Helius sends raw transaction data instead of enhanced format.
      const pre  = event.meta?.preTokenBalances  ?? [];
      const post = event.meta?.postTokenBalances ?? [];

      if (post.length === 0) continue; // No balance data and no tokenTransfers

      const message = event.transaction?.message;
      const rawKeys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
      const accountKeys = rawKeys.map(k => (typeof k === 'string' ? k : k?.pubkey ?? String(k)));

      for (const postBal of post) {
        if (postBal.mint !== mintAddress) continue;

        const accountIndex = postBal.accountIndex;
        const ataAddress = accountKeys[accountIndex];
        if (!ataAddress) {
          console.log(`[Webhook] SKIP fallback — no accountKey at index ${accountIndex}`);
          continue;
        }

        const preBal = pre.find(p => p.accountIndex === accountIndex);
        const preAmount  = Number(preBal?.uiTokenAmount?.uiAmount ?? 0);
        const postAmount = Number(postBal.uiTokenAmount?.uiAmount ?? 0);
        const delta = postAmount - preAmount;

        if (delta <= 0) continue;

        const telegramId = await findTelegramIdByAddress(ataAddress);
        if (!telegramId) {
          console.log(`[Webhook] SKIP fallback — no user for ${ataAddress}`);
          continue;
        }

        console.log(`[Webhook] Fallback match: Account[${accountIndex}] ${ataAddress.slice(0, 8)}... delta=${delta}`);
        await creditAndSweep(telegramId, delta, signature, ataAddress);
      }
    } catch (err) {
      console.error('[Webhook] Error processing event:', err.message, err.stack || '');
    }
  }
});

module.exports = { router, setBot };
