const { pool, query } = require('./index');

// ─────────────────────────────────────────────────────────────
// Basic functions needed for cancel feature
// ─────────────────────────────────────────────────────────────

async function getUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
  return res.rows[0] || null;
}

async function getBattleById(id) {
  const res = await query('SELECT * FROM battles WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getPendingBattleByHost(telegramId) {
  const res = await query(`
    SELECT * FROM battles 
    WHERE challenger_id = $1 
      AND status = 'open' 
    LIMIT 1
  `, [String(telegramId)]);
  return res.rows[0] || null;
}

async function cancelBattleWithRefund(battleId, cancelledBy = null) {
  const battle = await getBattleById(battleId);
  if (!battle || battle.status !== 'open') return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Refund wager to challenger
    await client.query(`
      UPDATE users 
      SET gamble_balance = gamble_balance + $1, 
          updated_at = NOW() 
      WHERE telegram_id = $2
    `, [battle.wager_amount, battle.challenger_id]);

    // Mark battle as cancelled
    await client.query(`
      UPDATE battles 
      SET status = 'cancelled', 
          cancelled_by = $1, 
          updated_at = NOW() 
      WHERE id = $2
    `, [cancelledBy, battleId]);

    await client.query('COMMIT');
    console.log(`[Cancel] Battle #${battleId} cancelled by ${cancelledBy || 'host'}`);
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[CancelBattle] Error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// Export what we need for now
module.exports = {
  getUser,
  getBattleById,
  getPendingBattleByHost,
  cancelBattleWithRefund
};
