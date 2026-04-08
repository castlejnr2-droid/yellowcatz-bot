const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferCheckedInstruction, getMint, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
require('dotenv').config();

let connection;
let hotWallet;
let tokenMint;

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

async function validateSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

async function sendTokens(recipientAddress, amount) {
  const conn = getConnection();
  const wallet = getHotWallet();
  const mint = getTokenMint();

  // Get mint info for decimals
  const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const rawAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));

  // Get or create sender ATA
  const senderATA = await getOrCreateAssociatedTokenAccount(
    conn, wallet, mint, wallet.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID
  );

  // Get or create recipient ATA
  const recipientPubkey = new PublicKey(recipientAddress);
  const recipientATA = await getOrCreateAssociatedTokenAccount(
    conn, wallet, mint, recipientPubkey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID
  );

  // Token-2022 requires TransferChecked (includes mint + decimals for on-chain verification)
  const transferIx = createTransferCheckedInstruction(
    senderATA.address,
    mint,
    recipientATA.address,
    wallet.publicKey,
    rawAmount,
    decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );

  // Send transaction
  const tx = new Transaction().add(transferIx);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);

  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(signature, 'confirmed');

  return signature;
}

async function getHotWalletBalance() {
  try {
    const conn = getConnection();
    const wallet = getHotWallet();
    const mint = getTokenMint();
    const ata = await getOrCreateAssociatedTokenAccount(conn, wallet, mint, wallet.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);
    const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const balance = Number(ata.amount) / Math.pow(10, mintInfo.decimals);
    return balance;
  } catch (err) {
    console.error('Error fetching hot wallet balance:', err.message);
    return null;
  }
}

module.exports = { sendTokens, validateSolanaAddress, getHotWalletBalance };
