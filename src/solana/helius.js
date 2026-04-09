/**
 * Helius webhook address management.
 *
 * Helius only fires webhook events for addresses on its watchlist.
 * Every time a user gets a deposit address we must register it here,
 * otherwise deposits arrive silently and are never webhook-detected.
 *
 * Required env vars:
 *   HELIUS_API_KEY   — API key (same key used in the RPC URL)
 *   HELIUS_WEBHOOK_ID — webhook ID from Helius dashboard
 *                       (dev.helius.xyz → Webhooks → click webhook → copy ID)
 */

const { query } = require('../db');

const HELIUS_BASE = 'https://api.helius.xyz/v0';

function getConfig() {
  const apiKey = process.env.HELIUS_API_KEY;
  const webhookId = process.env.HELIUS_WEBHOOK_ID;
  if (!apiKey || !webhookId) return null;
  return { apiKey, webhookId };
}

/**
 * Fetch the current webhook config from Helius.
 * Returns the full webhook object, or null if env vars are not set.
 */
async function getHeliusWebhook() {
  const cfg = getConfig();
  if (!cfg) return null;

  const url = `${HELIUS_BASE}/webhooks/${cfg.webhookId}?api-key=${cfg.apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Helius GET webhook failed: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * Replace the full accountAddresses list on the Helius webhook.
 * @param {string[]} addresses - complete list of addresses to watch
 * @param {string} webhookURL  - the webhook's own URL (required by Helius PUT)
 */
async function setHeliusWatchlist(addresses, webhookURL) {
  const cfg = getConfig();
  if (!cfg) return;

  const url = `${HELIUS_BASE}/webhooks/${cfg.webhookId}?api-key=${cfg.apiKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookURL, accountAddresses: addresses }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Helius PUT webhook failed: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * Add a single deposit address to the Helius webhook watchlist.
 * Fetches the current list first so existing addresses are not removed.
 * No-ops silently if HELIUS_API_KEY / HELIUS_WEBHOOK_ID are not set.
 */
async function registerAddressWithHelius(depositAddress) {
  const cfg = getConfig();
  if (!cfg) {
    console.warn('[Helius] HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set — skipping address registration');
    return;
  }

  try {
    const webhook = await getHeliusWebhook();
    const existing = webhook.accountAddresses || [];

    if (existing.includes(depositAddress)) {
      console.log(`[Helius] ${depositAddress.slice(0, 8)}... already on watchlist — no update needed`);
      return;
    }

    const updated = [...existing, depositAddress];
    await setHeliusWatchlist(updated, webhook.webhookURL);
    console.log(`[Helius] Registered ${depositAddress.slice(0, 8)}... (watchlist now has ${updated.length} address(es))`);
  } catch (err) {
    // Non-fatal — deposit poller backup will still catch the deposit
    console.error(`[Helius] Failed to register ${depositAddress.slice(0, 8)}...:`, err.message);
  }
}

/**
 * Sync all deposit addresses from the deposit_wallets table with the Helius watchlist.
 * Called on startup to ensure every known deposit address is watched.
 *
 * If HELIUS_API_KEY or HELIUS_WEBHOOK_ID are not set, logs a warning and returns.
 */
async function syncHeliusWatchlist() {
  const cfg = getConfig();
  if (!cfg) {
    console.warn('[Helius] HELIUS_API_KEY or HELIUS_WEBHOOK_ID not set — Helius watchlist sync SKIPPED');
    console.warn('[Helius] Set these env vars so webhook events fire for user deposit addresses');
    return;
  }

  console.log('[Helius] Syncing deposit addresses with Helius watchlist...');

  try {
    // Get all known deposit addresses from DB
    const [walletRows, userRows] = await Promise.all([
      query('SELECT deposit_address FROM deposit_wallets'),
      query('SELECT deposit_ata FROM users WHERE deposit_ata IS NOT NULL'),
    ]);

    const dbAddresses = new Set();
    for (const row of walletRows.rows) dbAddresses.add(row.deposit_address);
    for (const row of userRows.rows) dbAddresses.add(row.deposit_ata);

    if (dbAddresses.size === 0) {
      console.log('[Helius] No deposit addresses in DB yet — nothing to sync');
      return;
    }

    // Get current Helius watchlist
    const webhook = await getHeliusWebhook();
    const existing = new Set(webhook.accountAddresses || []);

    // Find addresses missing from Helius
    const missing = [...dbAddresses].filter(a => !existing.has(a));

    if (missing.length === 0) {
      console.log(`[Helius] Watchlist up to date — ${existing.size} address(es) already registered`);
      return;
    }

    // Add missing addresses
    const updated = [...existing, ...missing];
    await setHeliusWatchlist(updated, webhook.webhookURL);
    console.log(`[Helius] Sync complete — added ${missing.length} address(es), watchlist now has ${updated.length} total`);
    for (const addr of missing) {
      console.log(`[Helius]   + ${addr}`);
    }
  } catch (err) {
    // Non-fatal — deposit poller backup still catches deposits
    console.error('[Helius] Watchlist sync failed:', err.message);
  }
}

module.exports = { registerAddressWithHelius, syncHeliusWatchlist, getHeliusWebhook };
