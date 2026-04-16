const { pool, query } = require('./index');

// ─── USERS ───────────────────────────────────────────────────────────────────

async function getUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
  return res.rows[0] || null;
}

async function createUser({ telegramId, username, firstName, referredBy }) {
  const referralCode = 'ref_' + telegramId;
  await query(`
    INSERT INTO users (telegram_id, username, first_name, referral_code, referred_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (telegram_id) DO NOTHING
  `, [String(telegramId), username || null, firstName || null, referralCode, referredBy || null]);
  return getUser(telegramId);
}

async function getOrCreateUser({ telegramId, username, firstName, referredBy }) {
  let user = await getUser(telegramId);
  if (!user) {
    user = await createUser({ telegramId, username, firstName, referredBy });
  }
  return user;
}

async function updateUserBalances(telegramId, gambleDelta, spotDelta) {
  await query(`
    UPDATE users 
    SET gamble_balance = gamble_balance + $1,
        spot_balance = spot_balance + $2,
        updated_at = NOW()
    WHERE telegram_id = $3
  `, [gambleDelta, spotDelta, String(telegramId)]);
}

async function setLastCollect(telegramId) {
  await query('UPDATE users SET last_collect_at = NOW() WHERE telegram_id = $1', [String(telegramId)]);
}

async function getAllUsers() {
  const res = await query('SELECT * FROM users ORDER BY created_at DESC');
  return res.rows;
}

async function getTotalUserCount() {
  const res = await query('SELECT COUNT(*) as count FROM users');
  return parseInt(res.rows[0].count);
}

// ─── COLLECTIONS ─────────────────────────────────────────────────────────────

async function recordCollection(telegramId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO collections (user_id, amount) VALUES ($1, $2)', [String(telegramId), amount]);
    await client.query(`
      UPDATE users
      SET gamble_balance   = gamble_balance + $1,
          total_collected  = total_collected + $1,
          last_collect_at  = NOW(),
          updated_at       = NOW()
      WHERE telegram_id = $2
    `, [amount, String(telegramId)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getUserCollections(telegramId, limit = 20) {
  const res = await query('SELECT * FROM collections WHERE user_id = $1 ORDER BY collected_at DESC LIMIT $2',
    [String(telegramId), limit]);
  return res.rows;
}

async function getTotalCollected(telegramId) {
  const res = await query('SELECT SUM(amount) as total FROM collections WHERE user_id = $1', [String(telegramId)]);
  return parseFloat(res.rows[0].total) || 0;
}

// ─── TRANSFERS ───────────────────────────────────────────────────────────────

async function recordTransfer(telegramId, fromWallet, toWallet, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fromWallet === 'gamble' && toWallet === 'spot') {
      await client.query('UPDATE users SET gamble_balance = gamble_balance - $1, spot_balance = spot_balance + $1 WHERE telegram_id = $2',
        [amount, String(telegramId)]);
    } else if (fromWallet === 'spot' && toWallet === 'gamble') {
      await client.query('UPDATE users SET spot_balance = spot_balance - $1, gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
        [amount, String(telegramId)]);
    }
    await client.query('INSERT INTO transfers (user_id, from_wallet, to_wallet, amount) VALUES ($1, $2, $3, $4)',
      [String(telegramId), fromWallet, toWallet, amount]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── WITHDRAWALS ─────────────────────────────────────────────────────────────

async function createWithdrawal(telegramId, amount, solanaAddress, fee = 0) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET spot_balance = spot_balance - $1 WHERE telegram_id = $2',
      [amount, String(telegramId)]);
    const res = await client.query(
      'INSERT INTO withdrawals (user_id, amount, solana_address, fee) VALUES ($1, $2, $3, $4) RETURNING id',
      [String(telegramId), amount, solanaAddress, fee]);
    await client.query('COMMIT');
    return res.rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getUserWithdrawals(telegramId) {
  const res = await query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [String(telegramId)]);
  return res.rows;
}

async function getPendingWithdrawals() {
  const res = await query(`
    SELECT w.*, u.username, u.first_name 
    FROM withdrawals w JOIN users u ON w.user_id = u.telegram_id
    WHERE w.status = 'pending' ORDER BY w.created_at ASC
  `);
  return res.rows;
}

async function updateWithdrawalStatus(id, status, txHash = null, notes = null) {
  await query('UPDATE withdrawals SET status = $1, tx_hash = $2, notes = $3, updated_at = NOW() WHERE id = $4',
    [status, txHash, notes, id]);
}

async function getWithdrawalById(id) {
  const res = await query('SELECT * FROM withdrawals WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function refundWithdrawal(withdrawal) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET spot_balance = spot_balance + $1 WHERE telegram_id = $2',
      [withdrawal.amount, withdrawal.user_id]);
    await client.query("UPDATE withdrawals SET status = 'failed', updated_at = NOW() WHERE id = $1",
      [withdrawal.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── BATTLES ─────────────────────────────────────────────────────────────────

async function createBattle(challengerId, wagerAmount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET gamble_balance = gamble_balance - $1 WHERE telegram_id = $2',
      [wagerAmount, String(challengerId)]);
    const res = await client.query('INSERT INTO battles (challenger_id, wager_amount) VALUES ($1, $2) RETURNING id',
      [String(challengerId), wagerAmount]);
    await client.query('COMMIT');
    return res.rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getOpenBattles(excludeUserId) {
  const res = await query(`
    SELECT b.*, u.username as challenger_name, u.first_name as challenger_first
    FROM battles b JOIN users u ON b.challenger_id = u.telegram_id
    WHERE b.status = 'open' AND b.challenger_id != $1
    ORDER BY b.created_at DESC LIMIT 10
  `, [String(excludeUserId)]);
  return res.rows;
}

async function getBattleById(id) {
  const res = await query('SELECT * FROM battles WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function acceptBattle(battleId, opponentId) {
  const battle = await getBattleById(battleId);
  if (!battle || battle.status !== 'open') return null;

  let challengerRoll = Math.floor(Math.random() * 100) + 1;
  let opponentRoll = Math.floor(Math.random() * 100) + 1;
  if (challengerRoll === opponentRoll) {
    challengerRoll = Math.floor(Math.random() * 100) + 1;
    opponentRoll = Math.floor(Math.random() * 100) + 1;
  }

  const winnerId = challengerRoll > opponentRoll ? battle.challenger_id : String(opponentId);
  const pot = battle.wager_amount * 2;
  const fee = Math.floor(pot * 0.05);
  const payout = pot - fee;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET gamble_balance = gamble_balance - $1 WHERE telegram_id = $2',
      [battle.wager_amount, String(opponentId)]);
    await client.query('UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
      [payout, winnerId]);
    await client.query(`
      UPDATE battles SET opponent_id = $1, status = 'completed', winner_id = $2,
        challenger_roll = $3, opponent_roll = $4, fee_amount = $5, updated_at = NOW()
      WHERE id = $6
    `, [String(opponentId), winnerId, challengerRoll, opponentRoll, fee, battleId]);
    await client.query(`
      UPDATE house_balance
      SET balance = balance + $1, total_fees_collected = total_fees_collected + $1, updated_at = NOW()
    `, [fee]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`[Battle] Battle #${battleId} finalized. Pot=${pot} Fee=${fee} Payout=${payout}`);
  return { ...battle, opponent_id: opponentId, winner_id: winnerId, challenger_roll: challengerRoll, opponent_roll: opponentRoll, pot, fee, payout };
}

async function cancelBattle(battleId) {
  const battle = await getBattleById(battleId);
  if (!battle || battle.status !== 'open') return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
      [battle.wager_amount, battle.challenger_id]);
    await client.query("UPDATE battles SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [battleId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return true;
}
async function getOpenBattlesOlderThan(minutes) {
  const res = await query(
    `SELECT * FROM battles
     WHERE status = 'open'
     AND created_at < NOW() - INTERVAL '1 minute' * $1`,
    [minutes]
  );
  return res.rows;
}
async function getUserBattles(telegramId, limit = 10) {
  const res = await query(`
    SELECT b.*,
      uc.username as challenger_name, uc.first_name as challenger_first,
      uo.username as opponent_name, uo.first_name as opponent_first
    FROM battles b
    LEFT JOIN users uc ON b.challenger_id = uc.telegram_id
    LEFT JOIN users uo ON b.opponent_id = uo.telegram_id
    WHERE (b.challenger_id = $1 OR b.opponent_id = $1) AND b.status = 'completed'
    ORDER BY b.updated_at DESC LIMIT $2
  `, [String(telegramId), limit]);
  return res.rows;
}

async function getBattleStats(telegramId) {
  const tid = String(telegramId);
  const winsRes = await query("SELECT COUNT(*) as c FROM battles WHERE winner_id = $1 AND status = 'completed'", [tid]);
  const totalRes = await query("SELECT COUNT(*) as c FROM battles WHERE (challenger_id = $1 OR opponent_id = $2) AND status = 'completed'", [tid, tid]);
  const earnedRes = await query("SELECT COALESCE(SUM(wager_amount), 0) as s FROM battles WHERE winner_id = $1 AND status = 'completed'", [tid]);
  const wins = parseInt(winsRes.rows[0].c);
  const total = parseInt(totalRes.rows[0].c);
  const earned = parseFloat(earnedRes.rows[0].s) || 0;
  return { wins, losses: total - wins, total, earned: earned * 2 };
}

// ─── REFERRALS ───────────────────────────────────────────────────────────────

async function creditReferral(referrerId, referredId, bonusAmount = 500) {
  const existing = await query('SELECT id FROM referrals WHERE referred_id = $1', [String(referredId)]);
  if (existing.rows.length > 0) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO referrals (referrer_id, referred_id, bonus_amount) VALUES ($1, $2, $3)',
      [String(referrerId), String(referredId), bonusAmount]);
    await client.query('UPDATE users SET gamble_balance = gamble_balance + $1 WHERE telegram_id = $2',
      [bonusAmount, String(referrerId)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return true;
}

async function getReferralStats(telegramId) {
  const countRes = await query('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = $1', [String(telegramId)]);
  const totalRes = await query('SELECT COALESCE(SUM(bonus_amount), 0) as s FROM referrals WHERE referrer_id = $1', [String(telegramId)]);
  return { count: parseInt(countRes.rows[0].c), totalEarned: parseFloat(totalRes.rows[0].s) || 0 };
}

async function getUserByReferralCode(code) {
  const res = await query('SELECT * FROM users WHERE referral_code = $1', [code]);
  return res.rows[0] || null;
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────

async function getTopCollectors(limit = 10) {
  try {
    const res = await query(`
      SELECT u.telegram_id, u.username, u.first_name,
        COALESCE(SUM(c.amount), 0) as total_collected, COUNT(c.id) as collect_count
      FROM collections c JOIN users u ON c.user_id = u.telegram_id
      GROUP BY u.telegram_id, u.username, u.first_name ORDER BY total_collected DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (err) {
    console.error('[DB] getTopCollectors error:', err.message);
    return [];
  }
}

async function getTopBattlers(limit = 10) {
  try {
    const res = await query(`
      SELECT u.telegram_id, u.username, u.first_name,
        COUNT(b.id) as wins,
        COALESCE(SUM(b.wager_amount * 2), 0) as total_won
      FROM battles b JOIN users u ON b.winner_id = u.telegram_id
      WHERE b.status = 'completed' AND b.winner_id IS NOT NULL
      GROUP BY u.telegram_id, u.username, u.first_name ORDER BY wins DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (err) {
    console.error('[DB] getTopBattlers error:', err.message);
    return [];
  }
}

async function getTopReferrers(limit = 10) {
  const res = await query(`
    SELECT u.telegram_id, u.username, u.first_name,
      COUNT(r.id) as referral_count,
      SUM(r.bonus_amount) as total_bonus
    FROM referrals r JOIN users u ON r.referrer_id = u.telegram_id
    GROUP BY u.telegram_id, u.username, u.first_name ORDER BY referral_count DESC LIMIT $1
  `, [limit]);
  return res.rows;
}

async function getTotalClaimedLeaderboard() {
  const res = await query(`
    SELECT u.telegram_id, u.username, u.first_name,
      COALESCE(SUM(c.amount), 0) as total_claimed
    FROM users u
    LEFT JOIN collections c ON c.user_id = u.telegram_id
    GROUP BY u.telegram_id, u.username, u.first_name
    ORDER BY total_claimed DESC
  `);
  return res.rows;
}

async function getDepositLeaderboard() {
  const res = await query(`
    SELECT u.telegram_id, u.username, u.first_name,
  COALESCE(SUM(d.amount), 0) as total_deposited,
  COUNT(d.id) as num_deposits,
  dw.deposit_address
FROM users u
LEFT JOIN deposits d ON d.user_id = u.telegram_id
LEFT JOIN deposit_wallets dw ON dw.user_id = u.telegram_id
GROUP BY u.telegram_id, u.username, u.first_name, dw.deposit_address
    ORDER BY total_deposited DESC
  `);
  return res.rows;
}

async function getWithdrawalBreakdown() {
  const res = await query(`
    SELECT u.telegram_id, u.username, u.first_name,
      COALESCE(SUM(w.amount), 0) as total_requested,
      COUNT(w.id) as num_total,
      COALESCE(SUM(CASE WHEN w.status = 'completed' THEN w.amount ELSE 0 END), 0) as total_completed,
      SUM(CASE WHEN w.status = 'completed' THEN 1 ELSE 0 END) as num_completed,
      COALESCE(SUM(CASE WHEN w.status = 'pending' THEN w.amount ELSE 0 END), 0) as total_pending,
      SUM(CASE WHEN w.status = 'pending' THEN 1 ELSE 0 END) as num_pending,
      COALESCE(SUM(CASE WHEN w.status = 'failed' THEN w.amount ELSE 0 END), 0) as total_failed,
      SUM(CASE WHEN w.status = 'failed' THEN 1 ELSE 0 END) as num_failed
    FROM users u
    INNER JOIN withdrawals w ON w.user_id = u.telegram_id
    GROUP BY u.telegram_id, u.username, u.first_name
    ORDER BY total_requested DESC
  `);
  return res.rows;
}

// ─── DUEL CHALLENGES ─────────────────────────────────────────────────────────

async function getUserByUsername(username) {
  const clean = username.replace(/^@/, '');
  const res = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [clean]);
  return res.rows[0] || null;
}

async function getPendingDuelBetween(challengerId, targetId) {
  const res = await query(
    "SELECT id FROM duel_challenges WHERE challenger_id = $1 AND target_id = $2 AND status = 'pending'",
    [String(challengerId), String(targetId)]
  );
  return res.rows[0] || null;
}

async function createDuelChallenge(challengerId, targetId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance - $1, updated_at = NOW() WHERE telegram_id = $2',
      [amount, String(challengerId)]
    );
    const res = await client.query(
      'INSERT INTO duel_challenges (challenger_id, target_id, amount) VALUES ($1, $2, $3) RETURNING *',
      [String(challengerId), String(targetId), amount]
    );
    await client.query('COMMIT');
    return res.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getDuelChallenge(id) {
  const res = await query('SELECT * FROM duel_challenges WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function setDuelMessageIds(id, cancelMsgId, challengeMsgId, challengeChatId, cancelChatId) {
  await query(
    `UPDATE duel_challenges
     SET challenger_message_id = $1,
         target_message_id     = $2,
         challenge_chat_id     = $3,
         cancel_chat_id        = $4
     WHERE id = $5`,
    [cancelMsgId, challengeMsgId, String(challengeChatId), String(cancelChatId), id]
  );
}

async function acceptDuel(duelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const duelRes = await client.query(
      "SELECT * FROM duel_challenges WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [duelId]
    );
    const duel = duelRes.rows[0];
    if (!duel) { await client.query('ROLLBACK'); return null; }

    const targetRes = await client.query(
      'SELECT gamble_balance FROM users WHERE telegram_id = $1 FOR UPDATE',
      [duel.target_id]
    );
    const targetBalance = parseFloat(targetRes.rows[0]?.gamble_balance || 0);
    if (targetBalance < duel.amount) {
      await client.query('ROLLBACK');
      return { insufficientBalance: true, required: duel.amount, available: targetBalance };
    }

    const pot = duel.amount * 2;
    const fee = Math.floor(pot * 0.05);
    const payout = pot - fee;

    let challengerRoll = Math.floor(Math.random() * 100) + 1;
    let opponentRoll = Math.floor(Math.random() * 100) + 1;
    while (challengerRoll === opponentRoll) {
      challengerRoll = Math.floor(Math.random() * 100) + 1;
      opponentRoll = Math.floor(Math.random() * 100) + 1;
    }
    const winnerId = challengerRoll > opponentRoll ? duel.challenger_id : duel.target_id;

    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance - $1, updated_at = NOW() WHERE telegram_id = $2',
      [duel.amount, duel.target_id]
    );
    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
      [payout, winnerId]
    );
    await client.query(
      'UPDATE house_balance SET balance = balance + $1, total_fees_collected = total_fees_collected + $1, updated_at = NOW()',
      [fee]
    );
    await client.query("UPDATE duel_challenges SET status = 'completed' WHERE id = $1", [duelId]);

    await client.query('COMMIT');
    console.log(`[Duel] #${duelId} resolved. Pot=${pot} Fee=${fee} Payout=${payout} Winner=${winnerId}`);
    return { duel, winnerId, challengerRoll, opponentRoll, pot, fee, payout };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function cancelDuel(duelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duelRes = await client.query(
      "SELECT * FROM duel_challenges WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [duelId]
    );
    const duel = duelRes.rows[0];
    if (!duel) { await client.query('ROLLBACK'); return null; }
    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
      [duel.amount, duel.challenger_id]
    );
    await client.query("UPDATE duel_challenges SET status = 'cancelled' WHERE id = $1", [duelId]);
    await client.query('COMMIT');
    return duel;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function declineDuel(duelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duelRes = await client.query(
      "SELECT * FROM duel_challenges WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [duelId]
    );
    const duel = duelRes.rows[0];
    if (!duel) { await client.query('ROLLBACK'); return null; }
    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
      [duel.amount, duel.challenger_id]
    );
    await client.query("UPDATE duel_challenges SET status = 'declined' WHERE id = $1", [duelId]);
    await client.query('COMMIT');
    return duel;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getExpiredDuels() {
  const res = await query(
    "SELECT * FROM duel_challenges WHERE status = 'pending' AND expires_at < NOW()"
  );
  return res.rows;
}

async function expireDuel(duelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duelRes = await client.query(
      "SELECT * FROM duel_challenges WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [duelId]
    );
    const duel = duelRes.rows[0];
    if (!duel) { await client.query('ROLLBACK'); return null; }
    await client.query(
      'UPDATE users SET gamble_balance = gamble_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
      [duel.amount, duel.challenger_id]
    );
    await client.query("UPDATE duel_challenges SET status = 'expired' WHERE id = $1", [duelId]);
    await client.query('COMMIT');
    return duel;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── HOUSE BALANCE ───────────────────────────────────────────────────────────

async function getHouseBalance() {
  const res = await query('SELECT balance, total_fees_collected FROM house_balance LIMIT 1');
  return res.rows[0] || { balance: 0, total_fees_collected: 0 };
}

async function withdrawFromHouse(amount, adminTelegramId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const houseRes = await client.query('SELECT balance FROM house_balance LIMIT 1 FOR UPDATE');
    const currentBalance = parseFloat(houseRes.rows[0]?.balance || 0);
    if (currentBalance < amount) {
      throw new Error(`Insufficient house balance: ${currentBalance} $YC available`);
    }
    await client.query(
      'UPDATE house_balance SET balance = balance - $1, updated_at = NOW()',
      [amount]
    );
    await client.query(
      'UPDATE users SET spot_balance = spot_balance + $1, updated_at = NOW() WHERE telegram_id = $2',
      [amount, String(adminTelegramId)]
    );
    const remainRes = await client.query('SELECT balance FROM house_balance LIMIT 1');
    const remainingBalance = parseFloat(remainRes.rows[0]?.balance || 0);
    await client.query('COMMIT');
    console.log(`[House] Withdrew ${amount} $YC by admin ${adminTelegramId}. Remaining: ${remainingBalance}`);
    return { remainingBalance };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getStats() {
  const usersRes = await query('SELECT COUNT(*) as c FROM users');
  const collectedRes = await query('SELECT COALESCE(SUM(amount), 0) as s FROM collections');
  const battlesRes = await query("SELECT COUNT(*) as c FROM battles WHERE status = 'completed'");
  const withdrawnRes = await query("SELECT COALESCE(SUM(amount), 0) as s FROM withdrawals WHERE status = 'completed'");
  return {
    users: parseInt(usersRes.rows[0].c),
    totalCollected: parseFloat(collectedRes.rows[0].s) || 0,
    totalBattles: parseInt(battlesRes.rows[0].c),
    totalWithdrawn: parseFloat(withdrawnRes.rows[0].s) || 0
  };
}

module.exports = {
  getUser, createUser, getOrCreateUser, updateUserBalances, getAllUsers, getTotalUserCount,
  recordCollection, getUserCollections, getTotalCollected,
  recordTransfer,
  createWithdrawal, getUserWithdrawals, getPendingWithdrawals, updateWithdrawalStatus,
  getWithdrawalById, refundWithdrawal,
  createBattle, getOpenBattles, getBattleById, getOpenBattlesOlderThan, acceptBattle, cancelBattle, getUserBattles, getBattleStats,
  creditReferral, getReferralStats, getUserByReferralCode,
  getTopCollectors, getTopBattlers, getTopReferrers, getTotalClaimedLeaderboard, getDepositLeaderboard, getWithdrawalBreakdown, getStats,
  getHouseBalance, withdrawFromHouse,
  getUserByUsername, getPendingDuelBetween, createDuelChallenge, getDuelChallenge,
  setDuelMessageIds, acceptDuel, cancelDuel, declineDuel, getExpiredDuels, expireDuel
};
