const db = require('../../db/queries');
const { validateSolanaAddress } = require('../../solana/withdraw');
const { getOrCreateUserDepositATA } = require('../../solana/depositPoller');
const { formatBalance } = require('../commands/start');

const MIN_WITHDRAW = 1000;

const userStates = new Map();
function setState(telegramId, state) { userStates.set(String(telegramId), state); }
function getState(telegramId) { return userStates.get(String(telegramId)) || null; }
function clearState(telegramId) { userStates.delete(String(telegramId)); }

function getFundsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📥 Deposit', callback_data: 'funds_deposit' }, { text: '🐱 Withdraw', callback_data: 'funds_withdraw' }],
      [{ text: '💲 To Spot', callback_data: 'funds_to_spot' }, { text: '🎰 To Gamble', callback_data: 'funds_to_gamble' }],
      [{ text: '📒 History', callback_data: 'funds_history' }],
      [{ text: '🐾 Back', callback_data: 'back_main' }]
    ]
  };
}

async function editOrSend(bot, chatId, msgId, text, opts = {}) {
  if (msgId) {
    try { return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...opts }); } catch {}
  }
  return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}

async function showFundsMenu(bot, chatId, telegramId, msgId) {
  const user = await db.getUser(telegramId);
  if (!user) return;
  const text = `🧰 *Manage Funds*\n\n🎰 Gamble Balance: \`${formatBalance(user.gamble_balance)} $YC\`\n💲 Spot Balance:   \`${formatBalance(user.spot_balance)} $YC\`\n\nChoose an action:`;
  await editOrSend(bot, chatId, msgId, text, { reply_markup: getFundsKeyboard() });
}

async function handleToSpot(bot, chatId, telegramId, msgId) {
  const user = await db.getUser(telegramId);
  if (!user) return;
  if ((user.gamble_balance || 0) <= 0) {
    return await editOrSend(bot, chatId, msgId, `🐱 Your Gamble Balance is empty!\n\nUse /collect to earn tokens first.`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
  }
  setState(telegramId, { step: 'transfer_to_spot' });
  await editOrSend(bot, chatId, msgId,
    `💲 *Transfer to Spot Balance*\n\nGamble Balance: \`${formatBalance(user.gamble_balance)} $YC\`\n\nEnter amount to transfer (or type \`all\`):`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } });
}

async function handleToGamble(bot, chatId, telegramId, msgId) {
  const user = await db.getUser(telegramId);
  if (!user) return;
  if ((user.spot_balance || 0) <= 0) {
    return await editOrSend(bot, chatId, msgId, `🐱 Your Spot Balance is empty!`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
  }
  setState(telegramId, { step: 'transfer_to_gamble' });
  await editOrSend(bot, chatId, msgId,
    `🎰 *Transfer to Gamble Balance*\n\nSpot Balance: \`${formatBalance(user.spot_balance)} $YC\`\n\nEnter amount to transfer (or type \`all\`):`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } });
}

async function handleWithdrawStart(bot, chatId, telegramId, msgId) {
  const user = await db.getUser(telegramId);
  if (!user) return;
  if ((user.spot_balance || 0) < MIN_WITHDRAW) {
    return await editOrSend(bot, chatId, msgId,
      `🐱 *Minimum Withdrawal: ${MIN_WITHDRAW.toLocaleString()} $YC*\n\nYour Spot Balance: \`${formatBalance(user.spot_balance)} $YC\`\n\nTransfer tokens to your Spot Balance first!`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
  }
  setState(telegramId, { step: 'withdraw_amount' });
  await editOrSend(bot, chatId, msgId,
    `🐱 *Withdraw $YC*\n\nSpot Balance: \`${formatBalance(user.spot_balance)} $YC\`\nMinimum: \`${MIN_WITHDRAW.toLocaleString()} $YC\`\n\nEnter amount to withdraw (or type \`all\`):`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } });
}

async function showWithdrawalHistory(bot, chatId, telegramId, msgId) {
  const withdrawals = await db.getUserWithdrawals(telegramId);
  if (withdrawals.length === 0) {
    return await editOrSend(bot, chatId, msgId, `📒 *Withdrawal History*\n\n_No withdrawals yet._`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
  }
  let text = `📒 *Withdrawal History*\n\n`;
  withdrawals.slice(0, 10).forEach(w => {
    const statusEmoji = { pending: '⏳', processing: '🔄', completed: '✅', failed: '❌' }[w.status] || '❓';
    const date = w.created_at.toISOString().split('T')[0];
    const shortAddr = w.solana_address.slice(0, 8) + '...' + w.solana_address.slice(-6);
    text += `${statusEmoji} \`${formatBalance(w.amount)}\` $YC → \`${shortAddr}\`\n   ${w.status.toUpperCase()} — ${date}\n`;
    if (w.tx_hash) text += `   TX: \`${w.tx_hash.slice(0, 12)}...\`\n`;
    text += '\n';
  });
  await editOrSend(bot, chatId, msgId, text, { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
}

async function handleTextInput(bot, msg) {
  const { id: telegramId } = msg.from;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const state = getState(telegramId);
  if (!state) return false;

  const user = await db.getUser(telegramId);
  if (!user) return false;

  if (state.step === 'transfer_to_spot') {
    const amount = text.toLowerCase() === 'all' ? user.gamble_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) return await bot.sendMessage(chatId, `❌ Invalid amount.`);
    if (amount > user.gamble_balance) return await bot.sendMessage(chatId, `❌ Insufficient Gamble Balance.`);
    await db.recordTransfer(telegramId, 'gamble', 'spot', amount);
    clearState(telegramId);
    const updated = await db.getUser(telegramId);
    await bot.sendMessage(chatId,
      `✅ *Transfer Complete!*\n\nMoved \`${formatBalance(amount)}\` $YC to Spot.\n\n🎰 Gamble: \`${formatBalance(updated.gamble_balance)}\`\n💲 Spot: \`${formatBalance(updated.spot_balance)}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } });
    return true;
  }

  if (state.step === 'transfer_to_gamble') {
    const amount = text.toLowerCase() === 'all' ? user.spot_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) return await bot.sendMessage(chatId, `❌ Invalid amount.`);
    if (amount > user.spot_balance) return await bot.sendMessage(chatId, `❌ Insufficient Spot Balance.`);
    await db.recordTransfer(telegramId, 'spot', 'gamble', amount);
    clearState(telegramId);
    const updated = await db.getUser(telegramId);
    await bot.sendMessage(chatId,
      `✅ *Transfer Complete!*\n\nMoved \`${formatBalance(amount)}\` $YC to Gamble.\n\n🎰 Gamble: \`${formatBalance(updated.gamble_balance)}\`\n💲 Spot: \`${formatBalance(updated.spot_balance)}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } });
    return true;
  }

  if (state.step === 'withdraw_amount') {
    const amount = text.toLowerCase() === 'all' ? user.spot_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) return await bot.sendMessage(chatId, `❌ Invalid amount.`);
    if (amount < MIN_WITHDRAW) return await bot.sendMessage(chatId, `❌ Minimum withdrawal is ${MIN_WITHDRAW.toLocaleString()} $YC.`);
    if (amount > user.spot_balance) return await bot.sendMessage(chatId, `❌ Insufficient Spot Balance.`);
    setState(telegramId, { step: 'withdraw_address', amount });
    await bot.sendMessage(chatId,
      `🐱 *Withdraw ${formatBalance(amount)} $YC*\n\nNow enter your **Solana wallet address**:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } });
    return true;
  }

  if (state.step === 'withdraw_address') {
    const address = text;
    const valid = await validateSolanaAddress(address);
    if (!valid) return await bot.sendMessage(chatId, `❌ Invalid Solana address.`);
    setState(telegramId, { step: 'withdraw_confirm', amount: state.amount, address });
    await bot.sendMessage(chatId,
      `🐱 *Confirm Withdrawal*\n\nAmount: \`${formatBalance(state.amount)}\` $YC\nTo: \`${address}\`\n\n⚠️ Double-check the address!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'withdraw_confirm' }], [{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } });
    return true;
  }

  return false;
}

async function confirmWithdrawal(bot, chatId, telegramId, msgId) {
  const state = getState(telegramId);
  if (!state || state.step !== 'withdraw_confirm') return await bot.sendMessage(chatId, `❌ No pending withdrawal.`);
  const user = await db.getUser(telegramId);
  if ((user.spot_balance || 0) < state.amount) { clearState(telegramId); return await bot.sendMessage(chatId, `❌ Insufficient balance.`); }

  const withdrawalId = await db.createWithdrawal(telegramId, state.amount, state.address);
  clearState(telegramId);

  await editOrSend(bot, chatId, msgId,
    `✅ *Withdrawal Submitted!*\n\nID: \`#${withdrawalId}\`\nAmount: \`${formatBalance(state.amount)}\` $YC\nStatus: ⏳ *Pending*`,
    { reply_markup: { inline_keyboard: [[{ text: '📒 View History', callback_data: 'funds_history' }, { text: '🏠 Home', callback_data: 'back_main' }]] } });

  const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').filter(Boolean);
  for (const adminId of admins) {
    try {
      await bot.sendMessage(adminId,
        `🆕 *New Withdrawal*\n\nUser: @${user.username || telegramId}\nAmount: \`${formatBalance(state.amount)}\` $YC\nAddress: \`${state.address}\`\nID: #${withdrawalId}\n\n/approve_${withdrawalId} or /reject_${withdrawalId}`,
        { parse_mode: 'Markdown' });
    } catch {}
  }
}

async function handleDeposit(bot, chatId, telegramId, msgId) {
  try {
    await editOrSend(bot, chatId, msgId, `⏳ Generating your personal deposit address...`);
    
    const depositATA = await getOrCreateUserDepositATA(telegramId);
    
    await editOrSend(bot, chatId, msgId,
      `✅ *Your Personal Deposit Address for $YC*\n\n` +
      `Send any amount of $YC to:\n\n` +
      `\`${depositATA}\`\n\n` +
      `Tokens will be automatically credited to your 💲 Spot balance in 5-30 seconds.\n\n` +
      `_No memo, no extra commands, no signature needed!_`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } });
  } catch (err) {
    console.error('[Deposit] Error generating address:', err.message);
    await editOrSend(bot, chatId, msgId,
      `❌ Failed to generate deposit address. Please try again later.`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } });
  }
}

module.exports = { showFundsMenu, handleToSpot, handleToGamble, handleWithdrawStart, showWithdrawalHistory, handleTextInput, confirmWithdrawal, handleDeposit, clearState };
