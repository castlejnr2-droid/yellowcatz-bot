const db = require('../../db/queries');
const { validateSolanaAddress } = require('../../solana/withdraw');
const { formatBalance } = require('../commands/start');

const MIN_WITHDRAW = 1000;

// Track multi-step conversation state in memory
const userStates = new Map();

function setState(telegramId, state) {
  userStates.set(String(telegramId), state);
}

function getState(telegramId) {
  return userStates.get(String(telegramId)) || null;
}

function clearState(telegramId) {
  userStates.delete(String(telegramId));
}

function getFundsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💲 To Spot', callback_data: 'funds_to_spot' },
        { text: '🎰 To Gamble', callback_data: 'funds_to_gamble' }
      ],
      [
        { text: '🐱 Withdraw', callback_data: 'funds_withdraw' },
        { text: '📒 History', callback_data: 'funds_history' }
      ],
      [
        { text: '🐾 Back', callback_data: 'back_main' }
      ]
    ]
  };
}

async function showFundsMenu(bot, chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) return;

  const text =
    `🧰 *Manage Funds*\n\n` +
    `🎰 Gamble Balance: \`${formatBalance(user.gamble_balance)} $YellowCatz\`\n` +
    `💲 Spot Balance:   \`${formatBalance(user.spot_balance)} $YellowCatz\`\n\n` +
    `Choose an action:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: getFundsKeyboard()
  });
}

async function handleToSpot(bot, chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) return;
  if ((user.gamble_balance || 0) <= 0) {
    return await bot.sendMessage(chatId,
      `🐱 Your Gamble Balance is empty!\n\nUse /collect to earn tokens first.`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } }
    );
  }
  setState(telegramId, { step: 'transfer_to_spot' });
  await bot.sendMessage(chatId,
    `💲 *Transfer to Spot Balance*\n\n` +
    `Gamble Balance: \`${formatBalance(user.gamble_balance)} $YellowCatz\`\n\n` +
    `Enter amount to transfer (or type \`all\`):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } }
  );
}

async function handleToGamble(bot, chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) return;
  if ((user.spot_balance || 0) <= 0) {
    return await bot.sendMessage(chatId,
      `🐱 Your Spot Balance is empty!`,
      { reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } }
    );
  }
  setState(telegramId, { step: 'transfer_to_gamble' });
  await bot.sendMessage(chatId,
    `🎰 *Transfer to Gamble Balance*\n\n` +
    `Spot Balance: \`${formatBalance(user.spot_balance)} $YellowCatz\`\n\n` +
    `Enter amount to transfer (or type \`all\`):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } }
  );
}

async function handleWithdrawStart(bot, chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) return;
  if ((user.spot_balance || 0) < MIN_WITHDRAW) {
    return await bot.sendMessage(chatId,
      `🐱 *Minimum Withdrawal: ${MIN_WITHDRAW.toLocaleString()} $YellowCatz*\n\n` +
      `Your Spot Balance: \`${formatBalance(user.spot_balance)} $YellowCatz\`\n\n` +
      `Transfer tokens to your Spot Balance first!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } }
    );
  }
  setState(telegramId, { step: 'withdraw_amount' });
  await bot.sendMessage(chatId,
    `🐱 *Withdraw $YellowCatz*\n\n` +
    `Spot Balance: \`${formatBalance(user.spot_balance)} $YellowCatz\`\n` +
    `Minimum: \`${MIN_WITHDRAW.toLocaleString()} $YellowCatz\`\n\n` +
    `Enter amount to withdraw (or type \`all\`):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } }
  );
}

async function showWithdrawalHistory(bot, chatId, telegramId) {
  const withdrawals = db.getUserWithdrawals(telegramId);
  if (withdrawals.length === 0) {
    return await bot.sendMessage(chatId,
      `📒 *Withdrawal History*\n\n_No withdrawals yet._`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] } }
    );
  }

  let text = `📒 *Withdrawal History*\n\n`;
  withdrawals.slice(0, 10).forEach(w => {
    const statusEmoji = { pending: '⏳', processing: '🔄', completed: '✅', failed: '❌' }[w.status] || '❓';
    const date = w.created_at.split(' ')[0];
    const shortAddr = w.solana_address.slice(0, 8) + '...' + w.solana_address.slice(-6);
    text += `${statusEmoji} \`${formatBalance(w.amount)}\` $YellowCatz → \`${shortAddr}\`\n`;
    text += `   ${w.status.toUpperCase()} — ${date}\n`;
    if (w.tx_hash) text += `   TX: \`${w.tx_hash.slice(0, 12)}...\`\n`;
    text += '\n';
  });

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🐾 Back', callback_data: 'menu_funds' }]] }
  });
}

// Handle text input for multi-step flows
async function handleTextInput(bot, msg) {
  const { id: telegramId } = msg.from;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const state = getState(telegramId);

  if (!state) return false;

  const user = db.getUser(telegramId);
  if (!user) return false;

  // ── Transfer to Spot ──
  if (state.step === 'transfer_to_spot') {
    const amount = text.toLowerCase() === 'all' ? user.gamble_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return await bot.sendMessage(chatId, `❌ Invalid amount. Enter a number or "all".`);
    }
    if (amount > user.gamble_balance) {
      return await bot.sendMessage(chatId, `❌ Insufficient Gamble Balance. You have \`${formatBalance(user.gamble_balance)}\` $YellowCatz.`, { parse_mode: 'Markdown' });
    }
    db.recordTransfer(telegramId, 'gamble', 'spot', amount);
    clearState(telegramId);
    const updated = db.getUser(telegramId);
    await bot.sendMessage(chatId,
      `✅ *Transfer Complete!*\n\n` +
      `Moved \`${formatBalance(amount)}\` $YellowCatz to Spot Balance.\n\n` +
      `🎰 Gamble: \`${formatBalance(updated.gamble_balance)}\` $YellowCatz\n` +
      `💲 Spot: \`${formatBalance(updated.spot_balance)}\` $YellowCatz`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } }
    );
    return true;
  }

  // ── Transfer to Gamble ──
  if (state.step === 'transfer_to_gamble') {
    const amount = text.toLowerCase() === 'all' ? user.spot_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return await bot.sendMessage(chatId, `❌ Invalid amount.`);
    }
    if (amount > user.spot_balance) {
      return await bot.sendMessage(chatId, `❌ Insufficient Spot Balance.`);
    }
    db.recordTransfer(telegramId, 'spot', 'gamble', amount);
    clearState(telegramId);
    const updated = db.getUser(telegramId);
    await bot.sendMessage(chatId,
      `✅ *Transfer Complete!*\n\n` +
      `Moved \`${formatBalance(amount)}\` $YellowCatz to Gamble Balance.\n\n` +
      `🎰 Gamble: \`${formatBalance(updated.gamble_balance)}\` $YellowCatz\n` +
      `💲 Spot: \`${formatBalance(updated.spot_balance)}\` $YellowCatz`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🐾 Back to Funds', callback_data: 'menu_funds' }]] } }
    );
    return true;
  }

  // ── Withdraw Amount ──
  if (state.step === 'withdraw_amount') {
    const amount = text.toLowerCase() === 'all' ? user.spot_balance : parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return await bot.sendMessage(chatId, `❌ Invalid amount.`);
    }
    if (amount < MIN_WITHDRAW) {
      return await bot.sendMessage(chatId, `❌ Minimum withdrawal is ${MIN_WITHDRAW.toLocaleString()} $YellowCatz.`);
    }
    if (amount > user.spot_balance) {
      return await bot.sendMessage(chatId, `❌ Insufficient Spot Balance.`);
    }
    setState(telegramId, { step: 'withdraw_address', amount });
    await bot.sendMessage(chatId,
      `🐱 *Withdraw ${formatBalance(amount)} $YellowCatz*\n\n` +
      `Now enter your **Solana wallet address**:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'funds_cancel' }]] } }
    );
    return true;
  }

  // ── Withdraw Address ──
  if (state.step === 'withdraw_address') {
    const address = text;
    const valid = await validateSolanaAddress(address);
    if (!valid) {
      return await bot.sendMessage(chatId, `❌ Invalid Solana address. Please double-check and try again.`);
    }
    // Confirm
    setState(telegramId, { step: 'withdraw_confirm', amount: state.amount, address });
    await bot.sendMessage(chatId,
      `🐱 *Confirm Withdrawal*\n\n` +
      `Amount: \`${formatBalance(state.amount)}\` $YellowCatz\n` +
      `To: \`${address}\`\n\n` +
      `⚠️ Double-check the address. Withdrawals cannot be reversed!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm Withdraw', callback_data: 'withdraw_confirm' }],
            [{ text: '❌ Cancel', callback_data: 'funds_cancel' }]
          ]
        }
      }
    );
    return true;
  }

  return false;
}

async function confirmWithdrawal(bot, chatId, telegramId) {
  const state = getState(telegramId);
  if (!state || state.step !== 'withdraw_confirm') {
    return await bot.sendMessage(chatId, `❌ No pending withdrawal. Start again with Manage Funds.`);
  }
  const user = db.getUser(telegramId);
  if ((user.spot_balance || 0) < state.amount) {
    clearState(telegramId);
    return await bot.sendMessage(chatId, `❌ Insufficient balance.`);
  }

  const withdrawalId = db.createWithdrawal(telegramId, state.amount, state.address);
  clearState(telegramId);

  await bot.sendMessage(chatId,
    `✅ *Withdrawal Submitted!*\n\n` +
    `ID: \`#${withdrawalId}\`\n` +
    `Amount: \`${formatBalance(state.amount)}\` $YellowCatz\n` +
    `Status: ⏳ *Pending*\n\n` +
    `Your withdrawal will be processed shortly.\nUse 📒 *Historical Withdrawals* to track status.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📒 View History', callback_data: 'funds_history' }, { text: '🏠 Home', callback_data: 'back_main' }]] } }
  );

  // Notify admins
  const admins = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').filter(Boolean);
  for (const adminId of admins) {
    try {
      await bot.sendMessage(adminId,
        `🆕 *New Withdrawal Request*\n\n` +
        `User: @${user.username || user.first_name || telegramId} (\`${telegramId}\`)\n` +
        `Amount: \`${formatBalance(state.amount)}\` $YellowCatz\n` +
        `Address: \`${state.address}\`\n` +
        `ID: \`#${withdrawalId}\`\n\n` +
        `Use /approve_${withdrawalId} or /reject_${withdrawalId}`,
        { parse_mode: 'Markdown' }
      );
    } catch { /* admin may not have started bot */ }
  }
}

module.exports = {
  showFundsMenu, handleToSpot, handleToGamble, handleWithdrawStart,
  showWithdrawalHistory, handleTextInput, confirmWithdrawal, clearState
};
