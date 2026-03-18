const { getDb, getDbAsync } = require('./index');
const { v4: uuidv4 } = require('uuid');

// ─── USERS ───────────────────────────────────────────────────────────────────

function getUser(telegramId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function createUser({ telegramId, username, firstName, referredBy }) {
  const db = getDb();
  const referralCode = 'ref_' + telegramId;
  db.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, username, first_name, referral_code, referred_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(telegramId), username || null, firstName || null, referralCode, referredBy || null);
  return getUser(telegramId);
}

function getOrCreateUser({ telegramId, username, firstName, referredBy }) {
  let user = getUser(telegramId);
  if (!user) {
    user = createUser({ telegramId, username, firstName, referredBy });
  }
  return user;
}

function updateUserBalances(telegramId, gambleDelta, spotDelta) {
  const db = getDb();
  db.prepare(`
    UPDATE users 
    SET gamble_balance = gamble_balance + ?,
        spot_balance = spot_balance + ?,
        updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(gambleDelta, spotDelta, String(telegramId));
}

function setLastCollect(telegramId) {
  const db = getDb();
  db.prepare(`UPDATE users SET last_collect_at = datetime('now') WHERE telegram_id = ?`).run(String(telegramId));
}

function getAllUsers() {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

function getTotalUserCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
}

// ─── COLLECTIONS ─────────────────────────────────────────────────────────────

function recordCollection(telegramId, amount) {
  const db = getDb();
  db.prepare('INSERT INTO collections (user_id, amount) VALUES (?, ?)').run(String(telegramId), amount);
  updateUserBalances(telegramId, amount, 0);
  setLastCollect(telegramId);
}

function getUserCollections(telegramId, limit = 20) {
  const db = getDb();
  return db.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY collected_at DESC LIMIT ?')
    .all(String(telegramId), limit);
}

function getTotalCollected(telegramId) {
  const db = getDb();
  const result = db.prepare('SELECT SUM(amount) as total FROM collections WHERE user_id = ?').get(String(telegramId));
  return result.total || 0;
}

// ─── TRANSFERS ───────────────────────────────────────────────────────────────

function recordTransfer(telegramId, fromWallet, toWallet, amount) {
  const db = getDb();
  // Update balances atomically
  const update = db.transaction(() => {
    if (fromWallet === 'gamble' && toWallet === 'spot') {
      db.prepare(`UPDATE users SET gamble_balance = gamble_balance - ?, spot_balance = spot_balance + ? WHERE telegram_id = ?`)
        .run(amount, amount, String(telegramId));
    } else if (fromWallet === 'spot' && toWallet === 'gamble') {
      db.prepare(`UPDATE users SET spot_balance = spot_balance - ?, gamble_balance = gamble_balance + ? WHERE telegram_id = ?`)
        .run(amount, amount, String(telegramId));
    }
    db.prepare('INSERT INTO transfers (user_id, from_wallet, to_wallet, amount) VALUES (?, ?, ?, ?)')
      .run(String(telegramId), fromWallet, toWallet, amount);
  });
  update();
}

// ─── WITHDRAWALS ─────────────────────────────────────────────────────────────

function createWithdrawal(telegramId, amount, solanaAddress) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET spot_balance = spot_balance - ? WHERE telegram_id = ?`)
      .run(amount, String(telegramId));
    const result = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, solana_address) VALUES (?, ?, ?)
    `).run(String(telegramId), amount, solanaAddress);
    return result.lastInsertRowid;
  });
  return tx();
}

function getUserWithdrawals(telegramId) {
  const db = getDb();
  return db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(String(telegramId));
}

function getPendingWithdrawals() {
  const db = getDb();
  return db.prepare(`
    SELECT w.*, u.username, u.first_name 
    FROM withdrawals w JOIN users u ON w.user_id = u.telegram_id
    WHERE w.status = 'pending' ORDER BY w.created_at ASC
  `).all();
}

function updateWithdrawalStatus(id, status, txHash = null, notes = null) {
  const db = getDb();
  db.prepare(`
    UPDATE withdrawals SET status = ?, tx_hash = ?, notes = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, txHash, notes, id);
}

function getWithdrawalById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
}

function refundWithdrawal(withdrawal) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET spot_balance = spot_balance + ? WHERE telegram_id = ?`)
      .run(withdrawal.amount, withdrawal.user_id);
    db.prepare(`UPDATE withdrawals SET status = 'failed', updated_at = datetime('now') WHERE id = ?`)
      .run(withdrawal.id);
  });
  tx();
}

// ─── BATTLES ─────────────────────────────────────────────────────────────────

function createBattle(challengerId, wagerAmount) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET gamble_balance = gamble_balance - ? WHERE telegram_id = ?`)
      .run(wagerAmount, String(challengerId));
    const result = db.prepare(`
      INSERT INTO battles (challenger_id, wager_amount) VALUES (?, ?)
    `).run(String(challengerId), wagerAmount);
    return result.lastInsertRowid;
  });
  return tx();
}

function getOpenBattles(excludeUserId) {
  const db = getDb();
  return db.prepare(`
    SELECT b.*, u.username as challenger_name, u.first_name as challenger_first
    FROM battles b JOIN users u ON b.challenger_id = u.telegram_id
    WHERE b.status = 'open' AND b.challenger_id != ?
    ORDER BY b.created_at DESC LIMIT 10
  `).all(String(excludeUserId));
}

function getBattleById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
}

function acceptBattle(battleId, opponentId) {
  const db = getDb();
  const battle = getBattleById(battleId);
  if (!battle || battle.status !== 'open') return null;

  const challengerRoll = Math.floor(Math.random() * 100) + 1;
  const opponentRoll = Math.floor(Math.random() * 100) + 1;
  
  // Re-roll on tie
  let finalChallenger = challengerRoll;
  let finalOpponent = opponentRoll;
  if (finalChallenger === finalOpponent) {
    finalChallenger = Math.floor(Math.random() * 100) + 1;
    finalOpponent = Math.floor(Math.random() * 100) + 1;
  }
  
  const winnerId = finalChallenger > finalOpponent ? battle.challenger_id : String(opponentId);
  const loserId = winnerId === battle.challenger_id ? String(opponentId) : battle.challenger_id;
  const pot = battle.wager_amount * 2;

  const tx = db.transaction(() => {
    // Deduct wager from opponent
    db.prepare(`UPDATE users SET gamble_balance = gamble_balance - ? WHERE telegram_id = ?`)
      .run(battle.wager_amount, String(opponentId));
    // Award pot to winner
    db.prepare(`UPDATE users SET gamble_balance = gamble_balance + ? WHERE telegram_id = ?`)
      .run(pot, winnerId);
    // Update battle record
    db.prepare(`
      UPDATE battles SET opponent_id = ?, status = 'completed', winner_id = ?,
      challenger_roll = ?, opponent_roll = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(opponentId), winnerId, finalChallenger, finalOpponent, battleId);
  });
  tx();

  return { ...battle, opponent_id: opponentId, winner_id: winnerId, challenger_roll: finalChallenger, opponent_roll: finalOpponent };
}

function cancelBattle(battleId) {
  const db = getDb();
  const battle = getBattleById(battleId);
  if (!battle || battle.status !== 'open') return false;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET gamble_balance = gamble_balance + ? WHERE telegram_id = ?`)
      .run(battle.wager_amount, battle.challenger_id);
    db.prepare(`UPDATE battles SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
      .run(battleId);
  });
  tx();
  return true;
}

function getUserBattles(telegramId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT b.*,
      uc.username as challenger_name, uc.first_name as challenger_first,
      uo.username as opponent_name, uo.first_name as opponent_first
    FROM battles b
    LEFT JOIN users uc ON b.challenger_id = uc.telegram_id
    LEFT JOIN users uo ON b.opponent_id = uo.telegram_id
    WHERE (b.challenger_id = ? OR b.opponent_id = ?) AND b.status = 'completed'
    ORDER BY b.updated_at DESC LIMIT ?
  `).all(String(telegramId), String(telegramId), limit);
}

function getBattleStats(telegramId) {
  const db = getDb();
  const wins = db.prepare(`SELECT COUNT(*) as c FROM battles WHERE winner_id = ? AND status = 'completed'`).get(String(telegramId)).c;
  const total = db.prepare(`SELECT COUNT(*) as c FROM battles WHERE (challenger_id = ? OR opponent_id = ?) AND status = 'completed'`).get(String(telegramId), String(telegramId)).c;
  const earned = db.prepare(`SELECT SUM(wager_amount) as s FROM battles WHERE winner_id = ? AND status = 'completed'`).get(String(telegramId)).s || 0;
  return { wins, losses: total - wins, total, earned: earned * 2 };
}

// ─── REFERRALS ───────────────────────────────────────────────────────────────

function creditReferral(referrerId, referredId, bonusAmount = 500) {
  const db = getDb();
  // Check if already credited
  const exists = db.prepare('SELECT id FROM referrals WHERE referred_id = ?').get(String(referredId));
  if (exists) return false;
  
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO referrals (referrer_id, referred_id, bonus_amount) VALUES (?, ?, ?)')
      .run(String(referrerId), String(referredId), bonusAmount);
    db.prepare(`UPDATE users SET gamble_balance = gamble_balance + ? WHERE telegram_id = ?`)
      .run(bonusAmount, String(referrerId));
  });
  tx();
  return true;
}

function getReferralStats(telegramId) {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?').get(String(telegramId)).c;
  const total = db.prepare('SELECT SUM(bonus_amount) as s FROM referrals WHERE referrer_id = ?').get(String(telegramId)).s || 0;
  return { count, totalEarned: total };
}

function getUserByReferralCode(code) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────

function getTopCollectors(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT u.telegram_id, u.username, u.first_name,
      SUM(c.amount) as total_collected, COUNT(c.id) as collect_count
    FROM collections c JOIN users u ON c.user_id = u.telegram_id
    GROUP BY c.user_id ORDER BY total_collected DESC LIMIT ?
  `).all(limit);
}

function getTopBattlers(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT u.telegram_id, u.username, u.first_name,
      COUNT(b.id) as wins,
      SUM(b.wager_amount * 2) as total_won
    FROM battles b JOIN users u ON b.winner_id = u.telegram_id
    WHERE b.status = 'completed'
    GROUP BY b.winner_id ORDER BY wins DESC LIMIT ?
  `).all(limit);
}

function getTopReferrers(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT u.telegram_id, u.username, u.first_name,
      COUNT(r.id) as referral_count,
      SUM(r.bonus_amount) as total_bonus
    FROM referrals r JOIN users u ON r.referrer_id = u.telegram_id
    GROUP BY r.referrer_id ORDER BY referral_count DESC LIMIT ?
  `).all(limit);
}

function getStats() {
  const db = getDb();
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalCollected = db.prepare('SELECT SUM(amount) as s FROM collections').get().s || 0;
  const totalBattles = db.prepare(`SELECT COUNT(*) as c FROM battles WHERE status = 'completed'`).get().c;
  const totalWithdrawn = db.prepare(`SELECT SUM(amount) as s FROM withdrawals WHERE status = 'completed'`).get().s || 0;
  return { users, totalCollected, totalBattles, totalWithdrawn };
}

module.exports = {
  getUser, createUser, getOrCreateUser, updateUserBalances, getAllUsers, getTotalUserCount,
  recordCollection, getUserCollections, getTotalCollected,
  recordTransfer,
  createWithdrawal, getUserWithdrawals, getPendingWithdrawals, updateWithdrawalStatus,
  getWithdrawalById, refundWithdrawal,
  createBattle, getOpenBattles, getBattleById, acceptBattle, cancelBattle, getUserBattles, getBattleStats,
  creditReferral, getReferralStats, getUserByReferralCode,
  getTopCollectors, getTopBattlers, getTopReferrers, getStats
};
