const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
} = require('@solana/spl-token');
const bs58 = require('bs58');
const crypto = require('crypto');
const { query } = require('../db');
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
          const ataIndex = accountKeys.findIndex(k => k.toBase58() === user.deposit_ata);

          if (ataIndex === -1) continue;

          const preBal = preBalances.find(b => b.accountIndex === ataIndex);
          const postBal = postBalances.find(b => b.accountIndex === ataIndex);

          if (!postBal) continue;

          const preAmount = preBal ? parseFloat(preBal.uiTokenAmount.uiAmount || 0) : 0;
          const postAmount = parseFloat(postBal.uiTokenAmount.uiAmount || 0);
          const depositAmount = postAmount - preAmount;

          if (depositAmount <= 0) continue;

          // Credit user
          await query('BEGIN');
          try {
            await query(
              'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
              [user.telegram_id, depositAmount, sigInfo.signature, 'on-chain']
            );

            await query(
              'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
              [depositAmount, user.telegram_id]
            );

            await query('COMMIT');

            console.log(`[Deposit] Credited ${depositAmount} $YC to user ${user.telegram_id} (tx: ${sigInfo.signature.slice(0, 12)}...)`);

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
          } catch (err) {
            await query('ROLLBACK');
            console.error(`[Deposit] Failed to credit user ${user.telegram_id}:`, err.message);
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
    console.log('[Deposit] YELLOWCATZ_TOKEN_MINT not set, skipping deposit poller.');
    return;
  }

  console.log('[Deposit] Starting deposit poller (every 30 seconds)...');

  // Ensure deposits table exists
  query(`CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    tx_signature TEXT UNIQUE NOT NULL,
    from_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(err => console.error('[Deposit] Failed to create deposits table:', err?.message));

  // Poll every 30 seconds
  const interval = setInterval(() => pollDeposits(bot), 30000);
  return interval;
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

  const userAta = getAssociatedTokenAddressSync(
    mint, depositKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Check balance
  let account;
  try {
    account = await getAccount(conn, userAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    return null; // ATA doesn't exist
  }

  const balance = Number(account.amount);
  if (balance === 0) return null;

  // Get or create hot wallet ATA
  const { createAssociatedTokenAccountInstruction: createATAIx } = require('@solana/spl-token');
  const hotAta = getAssociatedTokenAddressSync(
    mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { createTransferInstruction } = require('@solana/spl-token');
  const tx = new Transaction();

  // Ensure hot wallet ATA exists
  try {
    await getAccount(conn, hotAta, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, hotAta, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  // Transfer from user ATA to hot wallet ATA
  tx.add(createTransferInstruction(
    userAta, hotAta, depositKeypair.publicKey, BigInt(balance), [], TOKEN_2022_PROGRAM_ID
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

module.exports = { startDepositPoller, getOrCreateUserDepositATA, sweepUserATA, sweepAll, findUserByATA };
