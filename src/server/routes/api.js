const express = require('express');
const router = express.Router();
const db = require('../../db/queries');

// ── Public Stats ──
router.get('/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Leaderboard ──
router.get('/leaderboard', async (req, res) => {
  try {
    const collectors = await db.getTopCollectors(10);
    const battlers = await db.getTopBattlers(10);
    const referrers = await db.getTopReferrers(10);
    res.json({ success: true, data: { collectors, battlers, referrers } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Info (by telegram ID) ──
router.get('/user/:telegramId', async (req, res) => {
  try {
    const user = await db.getUser(req.params.telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { telegram_id, username, first_name, gamble_balance, spot_balance, created_at } = user;
    const refStats = await db.getReferralStats(telegram_id);
    const battleStats = await db.getBattleStats(telegram_id);
    const totalCollected = await db.getTotalCollected(telegram_id);

    res.json({
      success: true,
      data: {
        telegram_id, username, first_name,
        gamble_balance, spot_balance,
        total: (gamble_balance || 0) + (spot_balance || 0),
        total_collected: totalCollected,
        referrals: refStats,
        battles: battleStats,
        created_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Collections ──
router.get('/user/:telegramId/collections', async (req, res) => {
  try {
    const collections = await db.getUserCollections(req.params.telegramId, 20);
    res.json({ success: true, data: collections });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Withdrawals ──
router.get('/user/:telegramId/withdrawals', async (req, res) => {
  try {
    const withdrawals = await db.getUserWithdrawals(req.params.telegramId);
    res.json({ success: true, data: withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Battles ──
router.get('/user/:telegramId/battles', async (req, res) => {
  try {
    const battles = await db.getUserBattles(req.params.telegramId, 20);
    res.json({ success: true, data: battles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
