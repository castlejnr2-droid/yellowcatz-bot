const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
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
require('dotenv').config();

let connection;
let hotWallet;
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
    if (!process.env.SOLANA_PRIVATE_KEY) throw new Error('SOLANA_PRIVATE_KEY not set');
    const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
    hotWallet = Keypair.fromSecretKey(secretKey);
  }
  return hotWallet;
}

function getTokenMint() {
  if (!tokenMint) {
    if (!process.env.YELLOWCATZ_TOKEN_MINT) throw new Error('YELLOWCATZ_TOKEN_MINT not set');
    tokenMint = new PublicKey(process.env.YELLOWCATZ_TOKEN_MINT);
  }
  return tokenMint;
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
 * Returns the address string.
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
 * Ensure the deposit ATA exists on-chain. Creates it if needed.
 * Called when user runs /deposit.
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

  // Check if ATA already exists on-chain
  try {
    await getAccount(conn, ataAddress, 'confirmed', TOKEN_2022_PROGRAM_ID);
    // Already exists
    return ataAddress.toBase58();
  } catch (e) {
    // Doesn't exist — create it
  }

  console.log(`[Deposit] Creating ATA for user ${telegramId}...`);

  const ix = createAssociatedTokenAccountInstruction(
    wallet.publicKey,         // payer
    ataAddress,               // ATA to create
    depositKeypair.publicKey, // owner
    mint,                     // mint
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
  console.log(`[Deposit] Created ATA for user ${telegramId}: ${ataAddress.toBase58()} (tx: ${sig})`);

  return ataAddress.toBase58();
}

/**
 * Get or create a user's deposit address, storing in DB.
 * This is the main entry point for /deposit command.
 */
async function getOrCreateUserDepositATA(telegramId) {
  // Ensure deposit_ata column exists
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_ata TEXT');
  } catch (e) { /* already exists */ }

  // Check DB first
  const res = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  if (res.rows[0]?.deposit_ata) {
    return res.rows[0].deposit_ata;
  }

  // Derive address (offline) and store in DB
  const ataAddress = getUserDepositAddress(telegramId);
  await query('UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2', [ataAddress, String(telegramId)]);

  // Create on-chain (this is the only RPC call)
  try {
    await ensureDepositATA(telegramId);
  } catch (err) {
    console.error(`[Deposit] Error creating ATA on-chain for ${telegramId}:`, err.message);
    // Address is still saved — poller will skip if ATA doesn't exist yet
    // User can retry /deposit later
  }

  return ataAddress;
}

// Track last processed signature per user ATA
const lastProcessedSig = new Map();

/**
 * Poll for new deposits to all user ATAs
 */
async function pollDeposits(bot) {
  try {
    const conn = getConnection();
    const mint = getTokenMint();

    // Cache mint decimals
    if (!mintDecimals) {
      try {
        const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
        mintDecimals = mintInfo.decimals;
      } catch (err) {
        console.error('[Deposit] Failed to get mint info:', err.message);
        return; // Can't proceed without decimals
      }
    }

    // Only poll users who have deposit ATAs
    const res = await query('SELECT telegram_id, deposit_ata FROM users WHERE deposit_ata IS NOT NULL');

    for (const user of res.rows) {
      try {
        const ataPublicKey = new PublicKey(user.deposit_ata);

        // Check if ATA exists on-chain before querying signatures
        try {
          await getAccount(conn, ataPublicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
        } catch {
          // ATA not created yet on-chain — skip
          continue;
        }

        const lastSig = lastProcessedSig.get(user.deposit_ata);

        // Fetch recent signatures
        const opts = { limit: 5 };
        if (lastSig) opts.until = lastSig;

        const signatures = await conn.getSignaturesForAddress(ataPublicKey, opts);

        if (signatures.length === 0) continue;

        // Process oldest to newest
        const toProcess = signatures.reverse();

        for (const sigInfo of toProcess) {
          if (sigInfo.err) continue;

          // Check if already processed
          const already = await query('SELECT id FROM deposits WHERE tx_signature = $1', [sigInfo.signature]);
          if (already.rows.length > 0) continue;

          // Fetch full transaction
          const tx = await conn.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
          });

          if (!tx || !tx.meta) continue;

          // Parse token balance changes
          const preBalances = tx.meta.preTokenBalances || [];
          const postBalances = tx.meta.postTokenBalances || [];

          const accountKeys = tx.transaction.message.staticAccountKeys ||
                              tx.transaction.message.accountKeys;
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

          // Credit user (use a dedicated client so BEGIN/COMMIT are on the same connection)
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
            console.error(`[Deposit] Failed to credit user ${user.telegram_id}:`, err.message, err.stack || '');
          } finally {
            client.release();
          }

          if (!credited) continue;

          // Auto-sweep: move tokens from user ATA to hot wallet
          try {
            const swept = await sweepUserATA(user.telegram_id);
            if (swept) {
              console.log(`[Deposit] Auto-swept ${swept.amount} $YC from user ${user.telegram_id} to hot wallet (tx: ${swept.signature.slice(0, 12)}...)`);
            }
          } catch (sweepErr) {
            console.error(`[Deposit] Auto-sweep failed for user ${user.telegram_id}:`, sweepErr.message);
            // Non-fatal: balance already credited, admin can sweep manually via /sweep_<id>
          }

          // Notify via Telegram
          if (bot) {
            try {
              const shortTx = sigInfo.signature.slice(0, 12) + '...' + sigInfo.signature.slice(-8);
              await bot.sendMessage(user.telegram_id,
                `✅ *Deposit Received!*\n\n` +
                `Amount: \`${depositAmount.toLocaleString()}\` $YC\n` +
                `TX: \`${shortTx}\`\n\n` +
                `Tokens credited to your 💲 Spot Balance!`,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              console.error(`[Deposit] Failed to notify user ${user.telegram_id}:`, e.message);
            }
          }
        }

        // Update last processed signature
        if (toProcess.length > 0) {
          lastProcessedSig.set(user.deposit_ata, toProcess[toProcess.length - 1].signature);
        }

      } catch (err) {
        if (!err.message?.includes('429')) {
          console.error(`[Deposit] Error polling user ${user.telegram_id}:`, err.message);
        }
      }

      // Delay between users to avoid rate limits
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error('[Deposit] Poller error:', err?.message || err);
    if (err?.stack) console.error('[Deposit] Stack:', err.stack);
  }
}

/**
 * Start the deposit polling loop
 */
function startDepositPoller(bot) {
  if (!process.env.YELLOWCATZ_TOKEN_MINT) {
    console.error('[Deposit] ⚠️  YELLOWCATZ_TOKEN_MINT is not set — deposit poller DISABLED. No deposits will be detected!');
    return;
  }
  if (!process.env.SOLANA_PRIVATE_KEY) {
    console.error('[Deposit] ⚠️  SOLANA_PRIVATE_KEY is not set — deposit poller DISABLED. Cannot derive user addresses!');
    return;
  }

  console.log('[Deposit] Starting deposit poller (immediately + every 30 seconds)...');

  // Ensure deposits table exists
  query(`CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    tx_signature TEXT UNIQUE NOT NULL,
    from_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(err => console.error('[Deposit] Failed to create deposits table:', err?.message));

  // Run immediately on startup, then every 30 seconds
  pollDeposits(bot).catch(err => console.error('[Deposit] Initial poll error:', err.message));
  const interval = setInterval(() => pollDeposits(bot), 30000);
  return interval;
}

/**
 * Rescan a user's ATA for missed deposits by directly checking on-chain balance.
 * Avoids unreliable transaction history parsing; works even if RPC rate-limits signatures.
 *
 * Dedup logic: sum of deposits WHERE from_address = ataAddress tells us how much has
 * already been credited from that specific ATA (both pollDeposits and prior rescans
 * now store the ATA address in from_address). The difference is credited.
 *
 * Returns array of { amount, signature } for newly credited deposits.
 */
async function rescanUser(telegramId, bot) {
  const conn = getConnection();
  const mint = getTokenMint();

  if (!mintDecimals) {
    const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    mintDecimals = mintInfo.decimals;
  }

  const userRes = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  const storedAta = userRes.rows[0]?.deposit_ata;
  if (!storedAta) throw new Error('User has no deposit ATA');

  // Re-derive the correct TOKEN_2022_PROGRAM_ID address.
  // storedAta may differ if it was incorrectly migrated to TOKEN_PROGRAM_ID in a prior deploy.
  const correctAta = getUserDepositAddress(telegramId);

  // Check both stored and correct addresses — covers any migration inconsistency
  const addressesToCheck = [...new Set([storedAta, correctAta])];
  const credited = [];

  for (const ataAddress of addressesToCheck) {
    const ataPublicKey = new PublicKey(ataAddress);

    // Directly read on-chain token balance — no transaction history needed.
    // Use getTokenAccountBalance as fallback because getAccount throws for
    // "closed"-status ATAs that still hold tokens (Solscan shows CLOSED but RPC confirms balance).
    let onChainRaw = 0;
    try {
      const account = await getAccount(conn, ataPublicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
      onChainRaw = Number(account.amount);
    } catch {
      try {
        const balResp = await conn.getTokenAccountBalance(ataPublicKey, 'confirmed');
        if (balResp?.value?.amount) {
          onChainRaw = Number(balResp.value.amount);
          console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0,8)}...: getAccount failed, fallback balance = ${onChainRaw}`);
        }
      } catch {
        console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0,8)}...: not found on-chain, skipping`);
        continue;
      }
    }

    if (onChainRaw === 0) {
      console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0,8)}...: balance is 0, skipping`);
      continue;
    }

    const onChainBalance = onChainRaw / Math.pow(10, mintDecimals);

    // How much has already been credited from this specific ATA address?
    // pollDeposits now stores from_address = user.deposit_ata, and rescans store from_address = ataAddress
    const alreadyRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE user_id = $1 AND from_address = $2`,
      [String(telegramId), ataAddress]
    );
    const alreadyCredited = parseFloat(alreadyRes.rows[0].total) || 0;

    // Use raw integer units to avoid floating-point rounding errors
    const alreadyCreditedRaw = Math.round(alreadyCredited * Math.pow(10, mintDecimals));
    const uncreditedRaw = onChainRaw - alreadyCreditedRaw;

    if (uncreditedRaw <= 0) {
      console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0,8)}...: ${onChainBalance} on-chain, ${alreadyCredited} already credited — nothing new`);
      continue;
    }

    const uncreditedAmount = uncreditedRaw / Math.pow(10, mintDecimals);
    console.log(`[Rescan] User ${telegramId} ATA ${ataAddress.slice(0,8)}...: ${onChainBalance} on-chain, ${alreadyCredited} already credited — crediting ${uncreditedAmount}`);

    // Synthetic signature is unique per run so the UNIQUE constraint never blocks it
    const syntheticSig = `balance_rescan:${ataAddress}:${Date.now()}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
        [String(telegramId), uncreditedAmount, syntheticSig, ataAddress]
      );
      await client.query(
        'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
        [uncreditedAmount, String(telegramId)]
      );
      await client.query('COMMIT');
      credited.push({ amount: uncreditedAmount, signature: syntheticSig });
      console.log(`[Rescan] Credited ${uncreditedAmount} $YC to user ${telegramId} from ATA ${ataAddress.slice(0,8)}...`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[Rescan] Failed to credit:`, err.message, err.stack || '');
    } finally {
      client.release();
    }
  }

  // Fix stored ATA back to the correct TOKEN_2022_PROGRAM_ID address if it was migrated wrong
  if (correctAta !== storedAta) {
    await query('UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2', [correctAta, String(telegramId)]);
    console.log(`[Rescan] Corrected deposit ATA for user ${telegramId} → ${correctAta.slice(0,8)}...`);
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
 * Sweep tokens from a user's deposit ATA to the hot wallet.
 * Returns { amount, signature } or null if nothing to sweep.
 */
async function sweepUserATA(telegramId) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();
  const depositKeypair = getUserDepositKeypair(telegramId);

  if (!mintDecimals) {
    const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    mintDecimals = mintInfo.decimals;
  }

  // Use the stored ATA address from DB — this is where tokens actually reside.
  // Re-deriving here would give the wrong address if stored ATA differs.
  const userRes = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  const storedAtaStr = userRes.rows[0]?.deposit_ata;
  if (!storedAtaStr) return null;
  const userAta = new PublicKey(storedAtaStr);

  // Check balance using Token-2022 program
  let account;
  try {
    account = await getAccount(conn, userAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    return null; // ATA doesn't exist or is unreadable
  }

  const balance = Number(account.amount);
  if (balance === 0) return null;

  // Derive hot wallet ATA using Token-2022 program
  const hotAta = getAssociatedTokenAddressSync(
    mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();

  // Ensure hot wallet ATA exists
  try {
    await getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, hotAta, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  // Token-2022 requires TransferChecked (includes mint + decimals for on-chain verification)
  tx.add(createTransferCheckedInstruction(
    userAta, mint, hotAta, depositKeypair.publicKey, BigInt(balance), mintDecimals, [], TOKEN_2022_PROGRAM_ID
  ));

  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [wallet, depositKeypair]);
  const uiAmount = balance / Math.pow(10, mintDecimals);

  console.log(`[Sweep] Swept ${uiAmount} $YC from user ${telegramId} to hot wallet (tx: ${sig})`);
  return { amount: uiAmount, signature: sig };
}

/**
 * Sweep ALL user ATAs to the hot wallet.
 * Returns array of { telegramId, amount, signature }.
 */
async function sweepAll() {
  const res = await query('SELECT telegram_id, deposit_ata FROM users WHERE deposit_ata IS NOT NULL');
  const results = [];

  for (const user of res.rows) {
    try {
      const result = await sweepUserATA(user.telegram_id);
      if (result) {
        results.push({ telegramId: user.telegram_id, ...result });
      }
    } catch (err) {
      console.error(`[Sweep] Failed for user ${user.telegram_id}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  return results;
}

/**
 * Find which user owns a given ATA address.
 */
async function findUserByATA(ataAddress) {
  const res = await query('SELECT telegram_id, username, first_name FROM users WHERE deposit_ata = $1', [ataAddress]);
  return res.rows[0] || null;
}

/**
 * Debug helper: inspect a user's deposit ATA — stored address, re-derived addresses
 * using both Token-2022 and standard Token programs, and on-chain balances for each.
 * Returns a plain object safe to render in a Telegram message.
 */
async function debugUserDeposit(telegramId) {
  const conn = getConnection();
  const errors = [];

  const out = {
    telegramId: String(telegramId),
    mintEnvVar: process.env.YELLOWCATZ_TOKEN_MINT || '(NOT SET)',
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

  // 1. Stored ATA from DB
  try {
    const res = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
    out.storedAta = res.rows[0]?.deposit_ata || null;
  } catch (err) {
    errors.push(`DB lookup: ${err.message}`);
  }

  // 2. Re-derive with TOKEN_2022_PROGRAM_ID (what the code currently uses)
  try {
    const depositKeypair = getUserDepositKeypair(telegramId);
    const mint = getTokenMint();
    const ata = getAssociatedTokenAddressSync(mint, depositKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    out.derivedAta_token2022 = ata.toBase58();
    out.storedMatchesToken2022 = out.storedAta === out.derivedAta_token2022;
  } catch (err) {
    errors.push(`Derive Token-2022 ATA: ${err.message}`);
  }

  // 3. Re-derive with standard TOKEN_PROGRAM_ID
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

  // 4. On-chain balance — try Token-2022
  try {
    const account = await getAccount(conn, ataKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
    out.ataOnChainMint = account.mint.toBase58();
    const mintInfo = await getMint(conn, account.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    out.balance_token2022 = Number(account.amount) / Math.pow(10, mintInfo.decimals);
  } catch (err) {
    out.balance_token2022 = `error: ${err.message}`;
  }

  // 5. On-chain balance — try standard Token program
  try {
    const account = await getAccount(conn, ataKey, 'confirmed', TOKEN_PROGRAM_ID);
    if (!out.ataOnChainMint) out.ataOnChainMint = account.mint.toBase58();
    const mintInfo = await getMint(conn, account.mint, 'confirmed', TOKEN_PROGRAM_ID);
    out.balance_stdToken = Number(account.amount) / Math.pow(10, mintInfo.decimals);
  } catch (err) {
    out.balance_stdToken = `error: ${err.message}`;
  }

  return out;
}

/**
 * Sweep tokens from any ATA address to the hot wallet without using getAccount.
 * Uses getTokenAccountBalance (works even for "closed"-status ATAs).
 * Looks up the ATA owner via DB to derive the signing keypair.
 * Returns { amount, signature, telegramId } or null if nothing to sweep.
 */
async function forceSweepATA(ataAddress) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();

  if (!mintDecimals) {
    const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    mintDecimals = mintInfo.decimals;
  }

  const ataPublicKey = new PublicKey(ataAddress);

  // Use getTokenAccountBalance — works even on "closed"-status accounts
  const balResp = await conn.getTokenAccountBalance(ataPublicKey, 'confirmed');
  const rawBalance = Number(balResp.value.amount);
  if (rawBalance === 0) return null;

  // Find which user owns this ATA so we can derive the signing keypair
  const userRes = await query('SELECT telegram_id FROM users WHERE deposit_ata = $1', [ataAddress]);
  if (!userRes.rows[0]) throw new Error(`No user found in DB with ATA ${ataAddress}`);
  const telegramId = userRes.rows[0].telegram_id;
  const depositKeypair = getUserDepositKeypair(telegramId);

  // Derive hot wallet ATA
  const hotAta = getAssociatedTokenAddressSync(
    mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();

  // Ensure hot wallet ATA exists
  try {
    await getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, hotAta, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  tx.add(createTransferCheckedInstruction(
    ataPublicKey, mint, hotAta, depositKeypair.publicKey, BigInt(rawBalance), mintDecimals, [], TOKEN_2022_PROGRAM_ID
  ));

  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [wallet, depositKeypair]);
  const uiAmount = rawBalance / Math.pow(10, mintDecimals);
  console.log(`[ForceSweep] Swept ${uiAmount} $YC from ${ataAddress.slice(0, 8)}... to hot wallet (tx: ${sig})`);
  return { amount: uiAmount, signature: sig, telegramId };
}

module.exports = { startDepositPoller, getOrCreateUserDepositATA, sweepUserATA, sweepAll, findUserByATA, rescanUser, rescanAll, debugUserDeposit, forceSweepATA };
