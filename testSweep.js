'use strict';
/**
 * testSweep.js — End-to-end verification of the deposit address system
 *
 * Tests that for a given telegram_id:
 *   1. The deposit ATA can be derived deterministically from SOLANA_PRIVATE_KEY
 *   2. The ATA exists on-chain with a readable balance
 *   3. The derived keypair is the on-chain authority for that ATA (owner matches)
 *
 * Usage:
 *   SOLANA_PRIVATE_KEY=... YELLOWCATZ_TOKEN_MINT=... node testSweep.js
 *   TELEGRAM_ID=12345 node testSweep.js   ← test a different user
 */

require('dotenv').config();

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const crypto = require('crypto');
const bs58   = require('bs58');

const TELEGRAM_ID = process.env.TELEGRAM_ID || '8304440423';
const RPC_URL     = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const GRN  = '\x1b[32m'; const RED = '\x1b[31m'; const YLW = '\x1b[33m';
const BLU  = '\x1b[34m'; const RST = '\x1b[0m';  const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;

function pass(label, detail = '') {
  passed++;
  console.log(`${GRN}${BOLD}  ✓ PASS${RST}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function fail(label, detail = '') {
  failed++;
  console.log(`${RED}${BOLD}  ✗ FAIL${RST}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function info(label, value) {
  console.log(`${BLU}${BOLD}  →${RST}  ${label.padEnd(28)} ${value}`);
}

// ── Derivation (mirrors getUserDepositKeypair + getUserDepositAddress exactly) ──

function deriveDepositKeypair(telegramId) {
  const bs58mod = bs58.default || bs58;
  const secretKey = bs58mod.decode(process.env.SOLANA_PRIVATE_KEY);
  const hotKeypair = Keypair.fromSecretKey(secretKey);

  const seed = crypto.createHash('sha256')
    .update(Buffer.from(hotKeypair.secretKey))
    .update(Buffer.from(String(telegramId)))
    .digest();

  return Keypair.fromSeed(seed);
}

function deriveDepositATA(depositKeypair) {
  const mint = new PublicKey(process.env.YELLOWCATZ_TOKEN_MINT);
  return getAssociatedTokenAddressSync(
    mint,
    depositKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${YLW}╔══════════════════════════════════════════════════╗${RST}`);
  console.log(`${BOLD}${YLW}║   YellowCatz Deposit System Test                 ║${RST}`);
  console.log(`${BOLD}${YLW}╚══════════════════════════════════════════════════╝${RST}`);
  console.log(`\n  telegram_id : ${TELEGRAM_ID}`);
  console.log(`  RPC         : ${RPC_URL}\n`);

  // ── Guard: required env vars ───────────────────────────────────────────────
  console.log(`${BOLD}── Prerequisites ───────────────────────────────────────────────${RST}`);

  if (!process.env.SOLANA_PRIVATE_KEY) {
    fail('SOLANA_PRIVATE_KEY is set');
    console.log(`\n${RED}Cannot continue without SOLANA_PRIVATE_KEY.${RST}`);
    process.exit(1);
  }
  pass('SOLANA_PRIVATE_KEY is set');

  if (!process.env.YELLOWCATZ_TOKEN_MINT) {
    fail('YELLOWCATZ_TOKEN_MINT is set');
    console.log(`\n${RED}Cannot continue without YELLOWCATZ_TOKEN_MINT.${RST}`);
    process.exit(1);
  }
  pass('YELLOWCATZ_TOKEN_MINT is set');

  // ── Test 1: Deterministic derivation ──────────────────────────────────────
  console.log(`\n${BOLD}── Test 1: Deterministic derivation ────────────────────────────${RST}`);

  let depositKeypair, depositAta;
  try {
    depositKeypair = deriveDepositKeypair(TELEGRAM_ID);
    depositAta     = deriveDepositATA(depositKeypair);
    pass('Deposit keypair derived without error');
  } catch (e) {
    fail('Deposit keypair derived without error', e.message);
    process.exit(1);
  }

  info('Deposit keypair pubkey:', depositKeypair.publicKey.toBase58());
  info('Deposit ATA address:', depositAta.toBase58());

  // Derive twice — must be identical
  try {
    const kp2  = deriveDepositKeypair(TELEGRAM_ID);
    const ata2 = deriveDepositATA(kp2);
    if (kp2.publicKey.toBase58() === depositKeypair.publicKey.toBase58() &&
        ata2.toBase58() === depositAta.toBase58()) {
      pass('Derivation is deterministic (same result on second call)');
    } else {
      fail('Derivation is deterministic', 'got different addresses on second call');
    }
  } catch (e) {
    fail('Derivation is deterministic', e.message);
  }

  // ── Test 2: On-chain ATA state ─────────────────────────────────────────────
  console.log(`\n${BOLD}── Test 2: On-chain ATA state ──────────────────────────────────${RST}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  let ataInfo;
  try {
    ataInfo = await connection.getParsedAccountInfo(depositAta);
  } catch (e) {
    fail('RPC call succeeded', e.message);
    process.exit(1);
  }
  pass('RPC call succeeded');

  if (!ataInfo.value) {
    fail('ATA exists on-chain', 'account not found — run /deposit to create it');
    console.log(`\n${YLW}  The ATA doesn't exist yet. This is OK for a brand-new address.${RST}`);
    console.log(`  Address to fund: ${depositAta.toBase58()}\n`);
    printSummary();
    return;
  }
  pass('ATA exists on-chain');

  const parsed   = ataInfo.value.data?.parsed?.info;
  const onChainOwner  = parsed?.owner;
  const rawAmount     = BigInt(parsed?.tokenAmount?.amount ?? '0');
  const decimals      = parsed?.tokenAmount?.decimals ?? 6;
  const uiAmount      = Number(rawAmount) / 10 ** decimals;
  const lamports      = ataInfo.value.lamports;

  info('On-chain owner:', onChainOwner ?? '(not parsed)');
  info('Balance:', `${rawAmount} raw  (${uiAmount} YC)`);
  info('Rent lamports:', lamports.toString());

  // ── Test 3: Authority verification ────────────────────────────────────────
  console.log(`\n${BOLD}── Test 3: Authority verification ──────────────────────────────${RST}`);

  if (!onChainOwner) {
    fail('On-chain owner field is readable');
  } else if (onChainOwner === depositKeypair.publicKey.toBase58()) {
    pass('Derived keypair matches on-chain ATA owner',
         'keypair CAN sign transfers from this ATA');
  } else {
    fail('Derived keypair matches on-chain ATA owner',
         `expected ${depositKeypair.publicKey.toBase58()}, got ${onChainOwner}`);
    console.log(`\n${YLW}  The ATA owner does not match the derived keypair.${RST}`);
    console.log(`  This means the ATA was created with a different key (old rotation).`);
    console.log(`  Use OLD_SOLANA_PRIVATE_KEY in recoverTokens.js to recover it.`);
  }

  // ── Test 4: Mint matches ───────────────────────────────────────────────────
  console.log(`\n${BOLD}── Test 4: Mint verification ────────────────────────────────────${RST}`);

  const onChainMint = parsed?.mint;
  info('On-chain mint:', onChainMint ?? '(not parsed)');
  if (onChainMint === process.env.YELLOWCATZ_TOKEN_MINT) {
    pass('ATA mint matches YELLOWCATZ_TOKEN_MINT');
  } else {
    fail('ATA mint matches YELLOWCATZ_TOKEN_MINT',
         `expected ${process.env.YELLOWCATZ_TOKEN_MINT}, got ${onChainMint}`);
  }

  printSummary();
}

function printSummary() {
  const total = passed + failed;
  console.log(`\n${BOLD}── Result ───────────────────────────────────────────────────────${RST}`);
  if (failed === 0) {
    console.log(`${GRN}${BOLD}  PASS  ${RST}${passed}/${total} tests passed\n`);
  } else {
    console.log(`${RED}${BOLD}  FAIL  ${RST}${passed}/${total} tests passed, ${failed} failed\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${RED}${BOLD}Fatal error:${RST}`, err.message);
  process.exit(1);
});
