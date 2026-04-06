const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, getMint, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const { query } = require('../db');
require('dotenv').config();

// Reuse same connection/wallet logic as withdraw.js
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

// Track last processed signature per user ATA to avoid double-crediting
const lastProcessedSig = new Map();

/**
 * Create or load a personal deposit ATA for a user.
 * Uses a deterministic seed derived from the user's telegram_id
 * so each user gets a unique ATA owned by the hot wallet.
 */
async function getOrCreateUserDepositATA(telegramId) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();

  // Ensure deposit_ata column exists
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_ata TEXT');
  } catch (e) {
    // Column might already exist, that's fine
  }

  // Check if user already has a deposit_ata stored
  const res = await query('SELECT deposit_ata FROM users WHERE telegram_id = $1', [String(telegramId)]);
  if (res.rows[0]?.deposit_ata) {
    return res.rows[0].deposit_ata;
  }

  // Create a new ATA owned by the hot wallet for this user
  // We use getOrCreateAssociatedTokenAccount which is deterministic per (owner, mint)
  // Since all users share the same hot wallet owner, we need a different approach:
  // We'll generate a unique keypair per user derived from a seed
  const seed = `yellowcatz-deposit-${telegramId}`;
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(seed);
  
  // Create a deterministic keypair for this user's deposit account
  // Use a hash of (hot wallet secret + telegram_id) as the seed
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(Buffer.from(wallet.secretKey))
    .update(Buffer.from(String(telegramId)))
    .digest();
  
  const depositKeypair = Keypair.fromSeed(hash);
  
  // Get the ATA for this deposit keypair
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    wallet,        // payer (hot wallet pays for creation)
    mint,
    depositKeypair.publicKey,  // owner is the unique deposit keypair
    false,
    'confirmed',
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  const ataAddress = ata.address.toBase58();

  // Save to database
  await query('UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2', [ataAddress, String(telegramId)]);

  console.log(`[Deposit] Created ATA for user ${telegramId}: ${ataAddress}`);
  return ataAddress;
}

/**
 * Initialize ATAs for all existing users who don't have one yet
 */
async function initAllUserATAs() {
  const res = await query('SELECT telegram_id FROM users WHERE deposit_ata IS NULL');
  console.log(`[Deposit] Initializing ATAs for ${res.rows.length} users without deposit addresses...`);
  
  for (const row of res.rows) {
    try {
      await getOrCreateUserDepositATA(row.telegram_id);
    } catch (err) {
      console.error(`[Deposit] Failed to create ATA for user ${row.telegram_id}:`, err.message);
    }
  }
  console.log(`[Deposit] ATA initialization complete.`);
}

/**
 * Poll for new deposits to all user ATAs
 */
async function pollDeposits(bot) {
  try {
    const conn = getConnection();
    const mint = getTokenMint();
    
    // Get mint decimals (cache it)
    if (!mintDecimals) {
      const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
      mintDecimals = mintInfo.decimals;
    }

    // Get all users with deposit ATAs
    const res = await query('SELECT telegram_id, deposit_ata FROM users WHERE deposit_ata IS NOT NULL');
    
    for (const user of res.rows) {
      try {
        const ataPublicKey = new PublicKey(user.deposit_ata);
        const lastSig = lastProcessedSig.get(user.deposit_ata);
        
        // Fetch recent signatures for this ATA
        const opts = { limit: 5 };
        if (lastSig) opts.until = lastSig;
        
        const signatures = await conn.getSignaturesForAddress(ataPublicKey, opts);
        
        if (signatures.length === 0) continue;
        
        // Process from oldest to newest
        const toProcess = signatures.reverse();
        
        for (const sigInfo of toProcess) {
          if (sigInfo.err) continue; // Skip failed transactions
          
          // Check if already processed in DB
          const alreadyProcessed = await query(
            'SELECT id FROM deposits WHERE tx_signature = $1',
            [sigInfo.signature]
          );
          if (alreadyProcessed.rows.length > 0) continue;
          
          // Fetch full transaction
          const tx = await conn.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
          });
          
          if (!tx || !tx.meta) continue;
          
          // Parse token balance changes for this ATA
          const preBalances = tx.meta.preTokenBalances || [];
          const postBalances = tx.meta.postTokenBalances || [];
          
          // Find the post-balance for our ATA
          const ataIndex = tx.transaction.message.staticAccountKeys
            ? tx.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === user.deposit_ata)
            : tx.transaction.message.accountKeys.findIndex(k => k.toBase58() === user.deposit_ata);
          
          if (ataIndex === -1) continue;
          
          const preBal = preBalances.find(b => b.accountIndex === ataIndex);
          const postBal = postBalances.find(b => b.accountIndex === ataIndex);
          
          if (!postBal) continue;
          
          const preAmount = preBal ? parseFloat(preBal.uiTokenAmount.uiAmount || 0) : 0;
          const postAmount = parseFloat(postBal.uiTokenAmount.uiAmount || 0);
          const depositAmount = postAmount - preAmount;
          
          if (depositAmount <= 0) continue; // Not a deposit (could be a withdrawal)
          
          // Credit the user
          await query('BEGIN');
          try {
            // Record the deposit
            await query(
              'INSERT INTO deposits (user_id, amount, tx_signature, from_address) VALUES ($1, $2, $3, $4)',
              [user.telegram_id, depositAmount, sigInfo.signature, 'on-chain']
            );
            
            // Credit spot balance
            await query(
              'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
              [depositAmount, user.telegram_id]
            );
            
            await query('COMMIT');
            
            console.log(`[Deposit] Credited ${depositAmount} $YC to user ${user.telegram_id} (tx: ${sigInfo.signature.slice(0, 12)}...)`);
            
            // Notify user via Telegram
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
        // Don't crash the whole poller for one user's error
        if (!err.message?.includes('429')) {
          console.error(`[Deposit] Error polling user ${user.telegram_id}:`, err.message);
        }
      }
      
      // Small delay between users to avoid RPC rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error('[Deposit] Poller error:', err?.message || err?.toString() || JSON.stringify(err));
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
  
  // Don't init all ATAs on startup — create lazily via /deposit command
  // This avoids hammering the RPC on boot
  
  // Poll every 30 seconds (less aggressive on free RPC)
  const interval = setInterval(() => pollDeposits(bot), 30000);
  
  // Return interval so it can be cleared if needed
  return interval;
}

module.exports = { startDepositPoller, getOrCreateUserDepositATA };
