'use strict';
/**
 * migrateAllATAs.js — Re-derive deposit ATAs for ALL users from current SOLANA_PRIVATE_KEY
 *
 * For each user in the database:
 *   1. Derives the correct deposit ATA using SHA256(secretKey + telegramId) → Keypair.fromSeed()
 *   2. Compares against the stored deposit_ata
 *   3. Updates the DB if they differ
 *
 * Usage:
 *   node migrateAllATAs.js          ← dry run (prints what would change, no writes)
 *   DRY_RUN=false node migrateAllATAs.js  ← apply changes
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

const DRY_RUN = process.env.DRY_RUN !== 'false';

// ── Derivation — mirrors getUserDepositKeypair + getUserDepositAddress exactly ──

function deriveDepositATA(hotSecretKey, telegramId, mint) {
  const seed = crypto.createHash('sha256')
    .update(Buffer.from(hotSecretKey))
    .update(Buffer.from(String(telegramId)))
    .digest();
  const depositKeypair = Keypair.fromSeed(seed);
  return getAssociatedTokenAddressSync(
    mint,
    depositKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ).toBase58();
}

async function main() {
  // ── Guards ────────────────────────────────────────────────────────────────
  if (!process.env.SOLANA_PRIVATE_KEY)    { console.error('SOLANA_PRIVATE_KEY not set');    process.exit(1); }
  if (!process.env.YELLOWCATZ_TOKEN_MINT) { console.error('YELLOWCATZ_TOKEN_MINT not set'); process.exit(1); }
  if (!process.env.DATABASE_URL)          { console.error('DATABASE_URL not set');           process.exit(1); }

  const bs58mod = bs58.default || bs58;
  const hotSecretKey = bs58mod.decode(process.env.SOLANA_PRIVATE_KEY);
  const hotKeypair   = Keypair.fromSecretKey(hotSecretKey);
  const mint         = new PublicKey(process.env.YELLOWCATZ_TOKEN_MINT);

  console.log(`\nYellowCatz ATA Migration`);
  console.log(`Mode         : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE — will update DB'}`);
  console.log(`Hot wallet   : ${hotKeypair.publicKey.toBase58()}`);
  console.log(`Mint         : ${mint.toBase58()}`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    const { rows: users } = await pool.query(
      'SELECT telegram_id, deposit_ata FROM users ORDER BY telegram_id'
    );

    console.log(`\nUsers found  : ${users.length}\n`);
    console.log(`${'telegram_id'.padEnd(20)} ${'status'.padEnd(10)} ${'old address'.padEnd(46)} → new address`);
    console.log('─'.repeat(140));

    let alreadyCorrect = 0;
    let updated        = 0;
    let nullSet        = 0;
    let errors         = 0;

    for (const user of users) {
      const telegramId = user.telegram_id;
      let derived;
      try {
        derived = deriveDepositATA(hotSecretKey, telegramId, mint);
      } catch (e) {
        console.error(`ERROR  ${telegramId}: derivation failed — ${e.message}`);
        errors++;
        continue;
      }

      const stored = user.deposit_ata;

      if (stored === derived) {
        console.log(`${telegramId.padEnd(20)} ${'OK'.padEnd(10)} ${derived}`);
        alreadyCorrect++;
        continue;
      }

      const status = stored ? 'UPDATE' : 'SET';
      const oldDisplay = stored ? stored.padEnd(46) : '(null)'.padEnd(46);
      console.log(`${telegramId.padEnd(20)} ${status.padEnd(10)} ${oldDisplay} → ${derived}`);

      if (!DRY_RUN) {
        try {
          await pool.query(
            'UPDATE users SET deposit_ata = $1 WHERE telegram_id = $2',
            [derived, telegramId]
          );
        } catch (e) {
          console.error(`  !! DB update failed for ${telegramId}: ${e.message}`);
          errors++;
          continue;
        }
      }

      if (stored) updated++; else nullSet++;
    }

    console.log('\n' + '─'.repeat(140));
    console.log(`Already correct : ${alreadyCorrect}`);
    console.log(`Updated         : ${updated}${DRY_RUN ? ' (dry run — not written)' : ''}`);
    console.log(`Newly set       : ${nullSet}${DRY_RUN ? ' (dry run — not written)' : ''}`);
    if (errors) console.log(`Errors          : ${errors}`);
    console.log(DRY_RUN
      ? '\nDry run complete. Run with DRY_RUN=false to apply.\n'
      : '\nMigration complete.\n'
    );
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
