'use strict';
/**
 * fixUserDepositATA.js — One-time migration for user 8304440423
 *
 * 1. Derives the correct deposit ATA from the current SOLANA_PRIVATE_KEY
 * 2. Prints it so you can verify on Solscan
 * 3. Updates users.deposit_ata in the database
 *
 * Usage:
 *   node fixUserDepositATA.js            # prints derived address, updates DB
 *   DRY_RUN=false node fixUserDepositATA.js  # same (DRY_RUN is false by default here)
 */

require('dotenv').config();

const { Keypair, PublicKey } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const crypto  = require('crypto');
const bs58    = require('bs58');
const { Pool } = require('pg');

const TELEGRAM_ID = '8304440423';
const DRY_RUN = process.env.DRY_RUN === 'true'; // default: actually write to DB

function derive(telegramId) {
  if (!process.env.SOLANA_PRIVATE_KEY) throw new Error('SOLANA_PRIVATE_KEY not set');
  if (!process.env.YELLOWCATZ_TOKEN_MINT) throw new Error('YELLOWCATZ_TOKEN_MINT not set');

  const bs58mod = bs58.default || bs58;
  const hotSecretKey = bs58mod.decode(process.env.SOLANA_PRIVATE_KEY);
  const hotKeypair   = Keypair.fromSecretKey(hotSecretKey);

  // SHA256(hotWallet.secretKey + telegramId) — mirrors getUserDepositKeypair()
  const seed = crypto.createHash('sha256')
    .update(Buffer.from(hotKeypair.secretKey))
    .update(Buffer.from(String(telegramId)))
    .digest();

  const depositKeypair = Keypair.fromSeed(seed);
  const mint = new PublicKey(process.env.YELLOWCATZ_TOKEN_MINT);

  const ata = getAssociatedTokenAddressSync(
    mint,
    depositKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return {
    hotPublicKey:      hotKeypair.publicKey.toBase58(),
    depositPublicKey:  depositKeypair.publicKey.toBase58(),
    depositAta:        ata.toBase58(),
  };
}

async function main() {
  console.log('\n── Deriving deposit address ───────────────────────────────────');
  const { hotPublicKey, depositPublicKey, depositAta } = derive(TELEGRAM_ID);

  console.log(`Hot wallet public key : ${hotPublicKey}`);
  console.log(`Deposit keypair pubkey: ${depositPublicKey}`);
  console.log(`Deposit ATA (Token-22): ${depositAta}`);
  console.log(`\nSolscan: https://solscan.io/account/${depositAta}`);

  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL not set — skipping DB update.');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('\n── Current DB record ──────────────────────────────────────────');
    const current = await pool.query(
      'SELECT telegram_id, deposit_ata FROM users WHERE telegram_id = $1',
      [TELEGRAM_ID]
    );
    if (!current.rows[0]) {
      console.log(`No user found with telegram_id ${TELEGRAM_ID}`);
      return;
    }
    console.log(`Stored deposit_ata: ${current.rows[0].deposit_ata || '(null)'}`);

    if (current.rows[0].deposit_ata === depositAta) {
      console.log('\nAlready up to date — no change needed.');
      return;
    }

    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would update deposit_ata to: ${depositAta}`);
      return;
    }

    await pool.query(
      'UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2',
      [depositAta, TELEGRAM_ID]
    );
    console.log(`\n✓ Updated deposit_ata for ${TELEGRAM_ID} → ${depositAta}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
