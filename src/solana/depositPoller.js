const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const crypto = require('crypto');
const { query, pool } = require('../db');
const { registerAddressWithHelius, syncHeliusWatchlist } = require('./helius');
require('dotenv').config();

let connection;
let hotWallet;
let hotWalletPublicKey;
let tokenMint;
let mintDecimals;

function getConnection() {
  if (!connection) {
    connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  }
  return connection;
}

function getHotWallet() {
  if (!hotWallet) {
    const key = process.env.PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    if (!key) throw new Error('PRIVATE_KEY not set');
    const secretKey = bs58.decode(key);
    hotWallet = Keypair.fromSecretKey(secretKey);
  }
  return hotWallet;
}

function getTokenMint() {
  if (!tokenMint) {
    const mint = process.env.YC_TOKEN_MINT || process.env.YELLOWCATZ_TOKEN_MINT;
    if (!mint) throw new Error('YC_TOKEN_MINT not set');
    tokenMint = new PublicKey(mint);
  }
  return tokenMint;
}

/**
 * Returns the PublicKey of HOT_WALLET_ADDRESS — the actual destination for swept tokens.
 * This is distinct from the PRIVATE_KEY signing keypair (which pays fees and derives
 * child deposit keypairs but does NOT receive the swept tokens).
 */
function getHotWalletAddress() {
  if (!hotWalletPublicKey) {
    const addr = process.env.HOT_WALLET_ADDRESS;
    if (!addr) throw new Error('HOT_WALLET_ADDRESS not set');
    hotWalletPublicKey = new PublicKey(addr);
  }
  return hotWalletPublicKey;
}

/**
 * Retry wrapper for all Solana RPC calls.
 * On HTTP 429 (rate limit), backs off exponentially and retries up to maxRetries times.
 * All other errors are rethrown immediately.
 */
async function rpcCallWithRetry(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
        const delay = Math.min(2000 * Math.pow(2, i), 30000);
        console.log(`[RPC] Rate limited, waiting ${delay}ms before retry ${i + 1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max RPC retries exceeded');
}

/**
 * Cache and return mint decimals.
 */
async function ensureMintDecimals() {
  if (mintDecimals != null) return mintDecimals;
  const conn = getConnection();
  const mint = getTokenMint();
  const mintInfo = await rpcCallWithRetry(() => getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID));
  mintDecimals = mintInfo.decimals;
  return mintDecimals;
}

/**
 * Derive a deterministic keypair for a user's deposit wallet.
 * This keypair "owns" the user's deposit ATA.
 */
function getUserDepositKeypair(telegramId) {
  const wallet = getHotWallet();
  const hash = crypto.createHash('sha256')
    .update(Buffer.from(wallet.secretKey))
    .update(Buffer.from(String(telegramId)))
    .digest();
  return Keypair.fromSeed(hash);
}

/**
 * Get deposit ATA address for a user (offline — no RPC call).
 */
function getUserDepositAddress(telegramId) {
  const depositKeypair = getUserDepositKeypair(telegramId);
  const mint = getTokenMint();
  const ata = getAssociatedTokenAddressSync(
    mint,
    depositKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata.toBase58();
}

/**
 * Check SOL balance of a deposit wallet and top it up if below 0.002 SOL.
 * Sends 0.005 SOL from hot wallet. Called before every sweep attempt.
 * @param {PublicKey} pubkey - the deposit keypair public key (ATA owner)
 */
async function fundDepositWalletIfNeeded(pubkey) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const MIN_LAMPORTS = Math.round(0.002 * LAMPORTS_PER_SOL);
  const FUND_LAMPORTS = Math.round(0.005 * LAMPORTS_PER_SOL);

  const balance = await rpcCallWithRetry(() => conn.getBalance(pubkey, 'confirmed'));
  if (balance >= MIN_LAMPORTS) return;

  const toSend = FUND_LAMPORTS - balance;
  console.log(`[Fund] ${pubkey.toBase58().slice(0, 8)}... has ${balance} lamports — topping up with ${toSend} lamports`);

  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: pubkey,
    lamports: toSend,
  }));
  const { blockhash } = await rpcCallWithRetry(() => conn.getLatestBlockhash());
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await rpcCallWithRetry(() => sendAndConfirmTransaction(conn, tx, [wallet]));
  console.log(`[Fund] Sent ${toSend / LAMPORTS_PER_SOL} SOL to ${pubkey.toBase58().slice(0, 8)}... (tx: ${sig})`);
}

/**
 * Ensure the deposit ATA exists on-chain. Creates it if needed.
 * Also funds the deposit keypair with SOL if below threshold.
 */
async function ensureDepositATA(telegramId) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();
  const depositKeypair = getUserDepositKeypair(telegramId);

  const ataAddress = getAssociatedTokenAddressSync(
    mint,
    depositKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Fund the deposit keypair before doing anything on-chain
  await fundDepositWalletIfNeeded(depositKeypair.publicKey);

  // Check if ATA already exists on-chain
  try {
    await rpcCallWithRetry(() => getAccount(conn, ataAddress, 'confirmed', TOKEN_2022_PROGRAM_ID));
    return ataAddress.toBase58(); // Already exists
  } catch (e) {
    // Doesn't exist — create it
  }

  console.log(`[Deposit] Creating ATA for user ${telegramId}...`);

  const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
    wallet.publicKey,
    ataAddress,
    depositKeypair.publicKey,
    mint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ));

  const { blockhash } = await rpcCallWithRetry(() => conn.getLatestBlockhash());
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await rpcCallWithRetry(() => sendAndConfirmTransaction(conn, tx, [wallet]));
  console.log(`[Deposit] Created ATA for user ${telegramId}: ${ataAddress.toBase58()} (tx: ${sig})`);

  return ataAddress.toBase58();
}

/**
 * Get or create a user's deposit address.
 * Stores in both users.deposit_ata and deposit_wallets table.
 */
async function getOrCreateUserDepositATA(telegramId) {
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_ata TEXT');
  } catch (e) { /* already exists */ }

  const currentAddress = getUserDepositAddress(telegramId);

  const res = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  const storedAddress = res.rows[0]?.deposit_ata;

  if (storedAddress !== currentAddress) {
    if (storedAddress) {
      console.log(`[Deposit] Key rotation detected for user ${telegramId} — updating deposit ATA: ${storedAddress.slice(0, 8)}... → ${currentAddress.slice(0, 8)}...`);
    }
    await query('UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2', [currentAddress, String(telegramId)]);
  }

  // Upsert into deposit_wallets so sweepAll() and the webhook can find this address
  await query(`
    INSERT INTO deposit_wallets (user_id, deposit_address)
    VALUES ($1, $2)
    ON CONFLICT (deposit_address) DO UPDATE SET user_id = EXCLUDED.user_id
  `, [String(telegramId), currentAddress]);

  // Register with Helius so webhook events fire for this deposit address.
  // Fire-and-forget — failure is non-fatal (backup poller still catches deposits).
  registerAddressWithHelius(currentAddress).catch(err =>
    console.error(`[Deposit] Helius registration failed for user ${telegramId}:`, err.message)
  );

  try {
    await ensureDepositATA(telegramId);
  } catch (err) {
    console.error(`[Deposit] Error creating ATA on-chain for ${telegramId}:`, err.message);
  }

  return currentAddress;
}

/**
 * Credit a user for any unprocessed deposit transactions in their ATA's history.
 * Uses real on-chain transaction signatures — the single source of truth for dedup.
 * Returns total amount newly credited.
 */
async function creditDepositsBySignatures(telegramId, ataAddress, bot) {
  const conn = getConnection();
  await ensureMintDecimals();

  const ataPublicKey = new PublicKey(ataAddress);
  let signatures;
  try {
    signatures = await rpcCallWithRetry(() => conn.getSignaturesForAddress(ataPublicKey, { limit: 10 }));
  } catch (err) {
    console.error(`[Deposit] getSignaturesForAddress failed for ${ataAddress.slice(0, 8)}...:`, err.message);
    return 0;
  }

  if (signatures.length === 0) return 0;

  let totalCredited = 0;

  for (const sigInfo of signatures.reverse()) {
    if (sigInfo.err) continue;

    const already = await query('SELECT id FROM deposits WHERE tx_signature = $1', [sigInfo.signature]);
    if (already.rows.length > 0) continue;

    const tx = await rpcCallWithRetry(() => conn.getTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }));
    if (!tx || !tx.meta) continue;

    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
    const ataIndex = accountKeys.findIndex(k => {
      const addr = typeof k === 'string' ? k : k.toBase58();
      return addr === ataAddress;
    });
    if (ataIndex === -1) continue;

    const preBal = preBalances.find(b => b.accountIndex === ataIndex);
    const postBal = postBalances.find(b => b.accountIndex === ataIndex);
    if (!postBal) continue;

    const preAmount = preBal ? parseFloat(preBal.uiTokenAmount.uiAmount || 0) : 0;
    const postAmount = parseFloat(postBal.uiTokenAmount.uiAmount || 0);
    const depositAmount = postAmount - preAmount;
    if (depositAmount <= 0) continue;

    const client = await pool.connect();
    let credited = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
        [String(telegramId), depositAmount, sigInfo.signature, ataAddress]
      );
      await client.query(
        'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
        [depositAmount, String(telegramId)]
      );
      await client.query('COMMIT');
      credited = true;
      totalCredited += depositAmount;
      console.log(`[Deposit] Credited ${depositAmount} $YC to user ${telegramId} (tx: ${sigInfo.signature.slice(0, 12)}...)`);
    } catch (err) {
      await client.query('ROLLBACK');
      if (!err.message?.includes('duplicate key') && !err.message?.includes('unique constraint')) {
        console.error(`[Deposit] Credit failed for user ${telegramId}:`, err.message);
      }
    } finally {
      client.release();
    }

    if (credited && bot) {
      try {
        const shortTx = sigInfo.signature.slice(0, 12) + '...' + sigInfo.signature.slice(-8);
        await bot.sendMessage(telegramId,
          `✅ *Deposit Received!*\n\nAmount: \`${depositAmount.toLocaleString()}\` $YC\nTX: \`${shortTx}\`\n\nTokens credited to your 💲 Spot Balance!`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.error(`[Deposit] Failed to notify user ${telegramId}:`, e.message);
      }
    }
  }

  return totalCredited;
}

// Track last processed signature per user ATA
const lastProcessedSig = new Map();

/**
 * Backup poll for new deposits to all user ATAs.
 * Webhook is the primary detection path; this catches anything missed.
 */
async function pollDeposits(bot) {
  try {
    const conn = getConnection();
    await ensureMintDecimals();

    const res = await query('SELECT telegram_id, deposit_ata FROM users WHERE deposit_ata IS NOT NULL');

    for (const user of res.rows) {
      try {
        const ataPublicKey = new PublicKey(user.deposit_ata);

        try {
          await rpcCallWithRetry(() => getAccount(conn, ataPublicKey, 'confirmed', TOKEN_2022_PROGRAM_ID));
        } catch {
          continue; // ATA not on-chain yet
        }

        const lastSig = lastProcessedSig.get(user.deposit_ata);
        const opts = { limit: 5 };
        if (lastSig) opts.until = lastSig;

        const signatures = await rpcCallWithRetry(() => conn.getSignaturesForAddress(ataPublicKey, opts));
        if (signatures.length === 0) continue;

        const toProcess = signatures.reverse();

        for (const sigInfo of toProcess) {
          if (sigInfo.err) continue;

          const already = await query('SELECT id FROM deposits WHERE tx_signature = $1', [sigInfo.signature]);
          if (already.rows.length > 0) continue;

          const tx = await rpcCallWithRetry(() => conn.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }));
          if (!tx || !tx.meta) continue;

          const preBalances = tx.meta.preTokenBalances || [];
          const postBalances = tx.meta.postTokenBalances || [];
          const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
          const ataIndex = accountKeys.findIndex(k => {
            const addr = typeof k === 'string' ? k : k.toBase58();
            return addr === user.deposit_ata;
          });
          if (ataIndex === -1) continue;

          const preBal = preBalances.find(b => b.accountIndex === ataIndex);
          const postBal = postBalances.find(b => b.accountIndex === ataIndex);
          if (!postBal) continue;

          const preAmount = preBal ? parseFloat(preBal.uiTokenAmount.uiAmount || 0) : 0;
          const postAmount = parseFloat(postBal.uiTokenAmount.uiAmount || 0);
          const depositAmount = postAmount - preAmount;
          if (depositAmount <= 0) continue;

          const client = await pool.connect();
          let credited = false;
          try {
            await client.query('BEGIN');
            await client.query(
              'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
              [user.telegram_id, depositAmount, sigInfo.signature, user.deposit_ata]
            );
            await client.query(
              'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
              [depositAmount, user.telegram_id]
            );
            await client.query('COMMIT');
            credited = true;
            console.log(`[Deposit] Credited ${depositAmount} $YC to user ${user.telegram_id} (tx: ${sigInfo.signature.slice(0, 12)}...)`);
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[Deposit] Failed to credit user ${user.telegram_id}:`, err.message);
          } finally {
            client.release();
          }

          if (!credited) continue;

          try {
            const swept = await sweepUserATA(user.telegram_id);
            if (swept) console.log(`[Deposit] Auto-swept ${swept.amount} $YC from user ${user.telegram_id} (tx: ${swept.signature.slice(0, 12)}...)`);
          } catch (sweepErr) {
            console.error(`[Deposit] Auto-sweep failed for user ${user.telegram_id}:`, sweepErr.message);
          }

          if (bot) {
            try {
              const shortTx = sigInfo.signature.slice(0, 12) + '...' + sigInfo.signature.slice(-8);
              await bot.sendMessage(user.telegram_id,
                `✅ *Deposit Received!*\n\nAmount: \`${depositAmount.toLocaleString()}\` $YC\nTX: \`${shortTx}\`\n\nTokens credited to your 💲 Spot Balance!`,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              console.error(`[Deposit] Failed to notify user ${user.telegram_id}:`, e.message);
            }
          }
        }

        if (toProcess.length > 0) {
          lastProcessedSig.set(user.deposit_ata, toProcess[toProcess.length - 1].signature);
        }
      } catch (err) {
        console.error(`[Deposit] Error polling user ${user.telegram_id}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    // Never rethrow — a failed poll cycle must not crash the process
    console.error('[Deposit] Poll cycle failed, will retry next interval:', err?.message || err);
  }
}

/**
 * Sweep tokens from a single user's ATA to the hot wallet.
 *
 * Uses getTokenAccountBalance() instead of getAccount() as the primary balance
 * check — works even for "closed"-status ATAs and avoids program-ID mismatch failures.
 * All RPC calls are wrapped in rpcCallWithRetry to handle 429 rate limits.
 *
 * Returns { amount, signature } or null if nothing to sweep.
 */
async function sweepUserATA(telegramId) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();
  const depositKeypair = getUserDepositKeypair(telegramId);

  await ensureMintDecimals();

  const userAtaStr = getUserDepositAddress(telegramId);
  const userAta = new PublicKey(userAtaStr);

  // Use getTokenAccountBalance — works regardless of ATA state or token program
  let rawBalance = 0;
  try {
    const balResp = await rpcCallWithRetry(() => conn.getTokenAccountBalance(userAta, 'confirmed'));
    rawBalance = Number(balResp?.value?.amount || 0);
  } catch {
    return null; // ATA doesn't exist or has no tokens
  }

  if (rawBalance === 0) return null;

  // Fund deposit keypair with SOL before sweeping
  try {
    await fundDepositWalletIfNeeded(depositKeypair.publicKey);
  } catch (fundErr) {
    console.error(`[Sweep] SOL fund failed for user ${telegramId} — proceeding anyway (hot wallet pays fees):`, fundErr.message);
  }

  const hotAta = getAssociatedTokenAddressSync(
    mint, getHotWalletAddress(), false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();
  try {
    await rpcCallWithRetry(() => getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID));
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, hotAta, getHotWalletAddress(), mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  tx.add(createTransferCheckedInstruction(
    userAta, mint, hotAta, depositKeypair.publicKey, BigInt(rawBalance), mintDecimals, [], TOKEN_2022_PROGRAM_ID
  ));

  const { blockhash } = await rpcCallWithRetry(() => conn.getLatestBlockhash());
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await rpcCallWithRetry(() => sendAndConfirmTransaction(conn, tx, [wallet, depositKeypair]));
  const uiAmount = rawBalance / Math.pow(10, mintDecimals);
  console.log(`[Sweep] Swept ${uiAmount} $YC from user ${telegramId} to hot wallet (tx: ${sig})`);
  return { amount: uiAmount, signature: sig };
}

/**
 * Sweep ALL deposit wallets to the hot wallet.
 *
 * Reads from BOTH deposit_wallets and users.deposit_ata.
 * For each address:
 *   1. Queries on-chain balance via getTokenAccountBalance() — never trusts DB
 *   2. Funds deposit keypair with SOL if below 0.002 SOL
 *   3. Credits user's spot balance for any uncredited amount
 *   4. Sweeps all tokens to the hot wallet
 */
async function sweepAll(bot) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();
  const results = [];

  await ensureMintDecimals();

  const [walletRows, userRows] = await Promise.all([
    query('SELECT user_id, deposit_address FROM deposit_wallets'),
    query('SELECT telegram_id AS user_id, deposit_ata AS deposit_address FROM users WHERE deposit_ata IS NOT NULL'),
  ]);

  // Merge: deposit_wallets takes precedence on conflict
  const addressMap = new Map();
  for (const row of userRows.rows) addressMap.set(row.deposit_address, row.user_id);
  for (const row of walletRows.rows) addressMap.set(row.deposit_address, row.user_id);

  console.log(`[Sweep] Checking ${addressMap.size} deposit wallet(s)...`);

  for (const [ataAddress, telegramId] of addressMap) {
    try {
      const ataPublicKey = new PublicKey(ataAddress);

      // Check on-chain balance — never trust DB
      let rawBalance = 0;
      try {
        const balResp = await rpcCallWithRetry(() => conn.getTokenAccountBalance(ataPublicKey, 'confirmed'));
        rawBalance = Number(balResp?.value?.amount || 0);
      } catch (balErr) {
        console.log(`[Sweep] Could not check balance for ${ataAddress.slice(0, 8)}...: ${balErr.message}`);
        continue;
      }
      

      if (rawBalance === 0) {
        console.log(`[Sweep] ${ataAddress.slice(0, 8)}... has 0 tokens on-chain, skipping`);
        continue;
      }

      const uiAmount = rawBalance / Math.pow(10, mintDecimals);
      console.log(`[Sweep] ${ataAddress.slice(0, 8)}... (user ${telegramId}) has ${uiAmount} $YC on-chain`);

      // Fund deposit keypair with SOL if needed
      const depositKeypair = getUserDepositKeypair(telegramId);
      try {
        await fundDepositWalletIfNeeded(depositKeypair.publicKey);
      } catch (fundErr) {
        console.error(`[Sweep] SOL fund failed for user ${telegramId} — proceeding anyway:`, fundErr.message);
      }

      // Credit user for any unprocessed deposit txs using real tx signatures (dedup-safe)
      await creditDepositsBySignatures(String(telegramId), ataAddress, bot);

      // Sweep tokens to hot wallet
      const hotAta = getAssociatedTokenAddressSync(
        mint, getHotWalletAddress(), false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const tx = new Transaction();
      try {
        await rpcCallWithRetry(() => getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID));
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(
          wallet.publicKey, hotAta, getHotWalletAddress(), mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        ));
      }
      tx.add(createTransferCheckedInstruction(
        ataPublicKey, mint, hotAta, depositKeypair.publicKey, BigInt(rawBalance), mintDecimals, [], TOKEN_2022_PROGRAM_ID
      ));

      const { blockhash } = await rpcCallWithRetry(() => conn.getLatestBlockhash());
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      const sig = await rpcCallWithRetry(() => sendAndConfirmTransaction(conn, tx, [wallet, depositKeypair]));
      console.log(`[Sweep] Swept ${uiAmount} $YC from user ${telegramId} to hot wallet (tx: ${sig})`);
      results.push({ telegramId, amount: uiAmount, signature: sig });
    } catch (err) {
      console.error(`[Sweep] Failed for ${ataAddress.slice(0, 8)}... (user ${telegramId}):`, err.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  return results;
}

/**
 * Startup recovery: scan all known deposit wallets for on-chain token balances,
 * fund SOL if needed, credit any uncredited amounts, then sweep to hot wallet.
 */
async function recoverDepositWallets(bot) {
  console.log('[Recovery] Starting startup deposit wallet recovery scan...');
  try {
    const results = await sweepAll(bot);
    if (results.length === 0) {
      console.log('[Recovery] No stuck deposits found.');
    } else {
      const total = results.reduce((s, r) => s + r.amount, 0);
      console.log(`[Recovery] Recovered ${results.length} deposit(s) totalling ${total.toFixed(2)} $YC`);
    }
  } catch (err) {
    console.error('[Recovery] Error during recovery scan:', err.message);
  }
}

/**
 * Start the deposit polling loop
 */
function startDepositPoller(bot) {
  if (!process.env.YC_TOKEN_MINT && !process.env.YELLOWCATZ_TOKEN_MINT) {
    console.error('[Deposit] ⚠️  YC_TOKEN_MINT is not set — deposit poller DISABLED. No deposits will be detected!');
    return;
  }
  if (!process.env.PRIVATE_KEY && !process.env.SOLANA_PRIVATE_KEY) {
    console.error('[Deposit] ⚠️  PRIVATE_KEY is not set — deposit poller DISABLED. Cannot derive user addresses!');
    return;
  }

  console.log('[Deposit] Starting deposit poller (webhook-first; backup poll every 5 minutes)...');

  query(`CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    tx_signature TEXT UNIQUE NOT NULL,
    from_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(err => console.error('[Deposit] Failed to create deposits table:', err?.message));

  // Sync all known deposit addresses with Helius watchlist on startup
  syncHeliusWatchlist().catch(err => console.error('[Helius] Startup sync error:', err.message));

  // Run one-time recovery scan on startup to catch any stuck tokens
  recoverDepositWallets(bot).catch(err => console.error('[Recovery] Startup recovery error:', err.message));

  // Backup poll every 5 minutes (webhook is primary detection path)
  pollDeposits(bot).catch(err => console.error('[Deposit] Initial poll error:', err.message));
  const interval = setInterval(() => pollDeposits(bot), 5 * 60 * 1000);
  return interval;
}

/**
 * Rescan a user's ATA for missed deposits by directly checking on-chain balance.
 */
async function rescanUser(telegramId, bot) {
  const conn = getConnection();
  await ensureMintDecimals();

  const userRes = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  const storedAta = userRes.rows[0]?.deposit_ata;
  if (!storedAta) throw new Error('User has no deposit ATA');

  const correctAta = getUserDepositAddress(telegramId);
  const addressesToCheck = [...new Set([storedAta, correctAta])];
  const credited = [];

  for (const ataAddress of addressesToCheck) {
    const ataPublicKey = new PublicKey(ataAddress);

    let onChainRaw = 0;
    try {
      const account = await rpcCallWithRetry(() => getAccount(conn, ataPublicKey, 'confirmed', TOKEN_2022_PROGRAM_ID));
      onChainRaw = Number(account.amount);
    } catch {
      try {
        const balResp = await rpcCallWithRetry(() => conn.getTokenAccountBalance(ataPublicKey, 'confirmed'));
        if (balResp?.value?.amount) {
          onChainRaw = Number(balResp.value.amount);
          console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0, 8)}...: getAccount failed, fallback balance = ${onChainRaw}`);
        }
      } catch {
        console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0, 8)}...: not found on-chain, skipping`);
        continue;
      }
    }

    if (onChainRaw === 0) {
      console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0, 8)}...: balance is 0, skipping`);
      continue;
    }

    const onChainBalance = onChainRaw / Math.pow(10, mintDecimals);

    const alreadyRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE user_id = $1 AND from_address = $2`,
      [String(telegramId), ataAddress]
    );
    const alreadyCredited = parseFloat(alreadyRes.rows[0].total) || 0;
    const alreadyCreditedRaw = Math.round(alreadyCredited * Math.pow(10, mintDecimals));
    const uncreditedRaw = onChainRaw - alreadyCreditedRaw;

    if (uncreditedRaw <= 0) {
      console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0, 8)}...: ${onChainBalance} on-chain, ${alreadyCredited} already credited — nothing new`);
      continue;
    }

    const uncreditedAmount = uncreditedRaw / Math.pow(10, mintDecimals);
    console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0, 8)}...: ${onChainBalance} on-chain, ${alreadyCredited} already credited — crediting ${uncreditedAmount}`);

    const creditedAmount = await creditDepositsBySignatures(String(telegramId), ataAddress, bot);
    if (creditedAmount > 0) {
      credited.push({ amount: creditedAmount, signature: `credited:${ataAddress}` });
      console.log(`[Rescan] Credited ${creditedAmount} $YC to user ${telegramId} from ATA ${ataAddress.slice(0, 8)}...`);
    }
  }

  if (correctAta !== storedAta) {
    await query('UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2', [correctAta, String(telegramId)]);
    console.log(`[Rescan] Corrected deposit ATA for user ${telegramId} → ${correctAta.slice(0, 8)}...`);
  }

  return credited;
}

/**
 * Rescan ALL users with ATAs for missed deposits.
 */
async function rescanAll(bot) {
  const res = await query('SELECT telegram_id FROM users WHERE deposit_ata IS NOT NULL');
  const allResults = [];

  for (const user of res.rows) {
    try {
      const results = await rescanUser(user.telegram_id, bot);
      if (results.length > 0) {
        allResults.push({ telegramId: user.telegram_id, deposits: results });
      }
    } catch (err) {
      console.error(`[Rescan] Error for user ${user.telegram_id}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return allResults;
}

/**
 * Find which user owns a given ATA address.
 * Checks deposit_wallets first, then falls back to users.deposit_ata.
 */
async function findUserByATA(ataAddress) {
  const dwRes = await query(`
    SELECT dw.user_id AS telegram_id, u.username, u.first_name
    FROM deposit_wallets dw
    JOIN users u ON u.telegram_id = dw.user_id
    WHERE dw.deposit_address = $1
  `, [ataAddress]);
  if (dwRes.rows[0]) return dwRes.rows[0];

  const res = await query('SELECT telegram_id, username, first_name FROM users WHERE deposit_ata = $1', [ataAddress]);
  return res.rows[0] || null;
}

/**
 * Debug helper: inspect a user's deposit ATA.
 */
async function debugUserDeposit(telegramId) {
  const conn = getConnection();
  const errors = [];

  const out = {
    telegramId: String(telegramId),
    mintEnvVar: process.env.YC_TOKEN_MINT || process.env.YELLOWCATZ_TOKEN_MINT || '(NOT SET)',
    storedAta: null,
    derivedAta_token2022: null,
    derivedAta_stdToken: null,
    storedMatchesToken2022: null,
    storedMatchesStdToken: null,
    balance_token2022: null,
    balance_stdToken: null,
    ataOnChainMint: null,
    errors,
  };

  try {
    const res = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
    out.storedAta = res.rows[0]?.deposit_ata || null;
  } catch (err) {
    errors.push(`DB lookup: ${err.message}`);
  }

  try {
    const depositKeypair = getUserDepositKeypair(telegramId);
    const mint = getTokenMint();
    const ata = getAssociatedTokenAddressSync(mint, depositKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    out.derivedAta_token2022 = ata.toBase58();
    out.storedMatchesToken2022 = out.storedAta === out.derivedAta_token2022;
  } catch (err) {
    errors.push(`Derive Token-2022 ATA: ${err.message}`);
  }

  try {
    const depositKeypair = getUserDepositKeypair(telegramId);
    const mint = getTokenMint();
    const ata = getAssociatedTokenAddressSync(mint, depositKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    out.derivedAta_stdToken = ata.toBase58();
    out.storedMatchesStdToken = out.storedAta === out.derivedAta_stdToken;
  } catch (err) {
    errors.push(`Derive Std-Token ATA: ${err.message}`);
  }

  if (!out.storedAta) return out;

  const ataKey = new PublicKey(out.storedAta);

  try {
    const account = await rpcCallWithRetry(() => getAccount(conn, ataKey, 'confirmed', TOKEN_2022_PROGRAM_ID));
    out.ataOnChainMint = account.mint.toBase58();
    const mintInfo = await rpcCallWithRetry(() => getMint(conn, account.mint, 'confirmed', TOKEN_2022_PROGRAM_ID));
    out.balance_token2022 = Number(account.amount) / Math.pow(10, mintInfo.decimals);
  } catch (err) {
    out.balance_token2022 = `error: ${err.message}`;
  }

  try {
    const account = await rpcCallWithRetry(() => getAccount(conn, ataKey, 'confirmed', TOKEN_PROGRAM_ID));
    if (!out.ataOnChainMint) out.ataOnChainMint = account.mint.toBase58();
    const mintInfo = await rpcCallWithRetry(() => getMint(conn, account.mint, 'confirmed', TOKEN_PROGRAM_ID));
    out.balance_stdToken = Number(account.amount) / Math.pow(10, mintInfo.decimals);
  } catch (err) {
    out.balance_stdToken = `error: ${err.message}`;
  }

  return out;
}

/**
 * Force sweep any ATA address to the hot wallet.
 * Works even for "closed"-status accounts. Looks up user from both tables.
 */
async function forceSweepATA(ataAddress) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();

  await ensureMintDecimals();

  const ataPublicKey = new PublicKey(ataAddress);

  const balResp = await rpcCallWithRetry(() => conn.getTokenAccountBalance(ataPublicKey, 'confirmed'));
  const rawBalance = Number(balResp.value.amount);
  if (rawBalance === 0) return null;

  // Find user from deposit_wallets first, then users table
  let telegramId;
  const dwRes = await query('SELECT user_id FROM deposit_wallets WHERE deposit_address = $1', [ataAddress]);
  if (dwRes.rows[0]) {
    telegramId = dwRes.rows[0].user_id;
  } else {
    const userRes = await query('SELECT telegram_id FROM users WHERE deposit_ata = $1', [ataAddress]);
    if (!userRes.rows[0]) throw new Error(`No user found in DB with ATA ${ataAddress}`);
    telegramId = userRes.rows[0].telegram_id;
  }

  const depositKeypair = getUserDepositKeypair(telegramId);

  try {
    await fundDepositWalletIfNeeded(depositKeypair.publicKey);
  } catch (fundErr) {
    console.error(`[ForceSweep] SOL fund failed for user ${telegramId} — proceeding anyway:`, fundErr.message);
  }

  const hotAta = getAssociatedTokenAddressSync(
    mint, getHotWalletAddress(), false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();
  try {
    await rpcCallWithRetry(() => getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID));
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, hotAta, getHotWalletAddress(), mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  tx.add(createTransferCheckedInstruction(
    ataPublicKey, mint, hotAta, depositKeypair.publicKey, BigInt(rawBalance), mintDecimals, [], TOKEN_2022_PROGRAM_ID
  ));

  const { blockhash } = await rpcCallWithRetry(() => conn.getLatestBlockhash());
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await rpcCallWithRetry(() => sendAndConfirmTransaction(conn, tx, [wallet, depositKeypair]));
  const uiAmount = rawBalance / Math.pow(10, mintDecimals);
  console.log(`[ForceSweep] Swept ${uiAmount} $YC from ${ataAddress.slice(0, 8)}... to hot wallet (tx: ${sig})`);
  return { amount: uiAmount, signature: sig, telegramId };
}

module.exports = {
  startDepositPoller,
  getOrCreateUserDepositATA,
  getUserDepositAddress,
  sweepUserATA,
  sweepAll,
  findUserByATA,
  rescanUser,
  rescanAll,
  debugUserDeposit,
  forceSweepATA,
  recoverDepositWallets,
  fundDepositWalletIfNeeded,
  creditDepositsBySignatures,
};
