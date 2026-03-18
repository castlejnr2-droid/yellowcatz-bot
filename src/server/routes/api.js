const express = require('express');
const router = express.Router();
const db = require('../../db/queries');

// ── Public Stats ──
router.get('/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Leaderboard ──
router.get('/leaderboard', (req, res) => {
  try {
    const collectors = db.getTopCollectors(10);
    const battlers = db.getTopBattlers(10);
    const referrers = db.getTopReferrers(10);
    res.json({ success: true, data: { collectors, battlers, referrers } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Info (by telegram ID) ──
router.get('/user/:telegramId', (req, res) => {
  try {
    const user = db.getUser(req.params.telegramId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { telegram_id, username, first_name, gamble_balance, spot_balance, created_at } = user;
    const refStats = db.getReferralStats(telegram_id);
    const battleStats = db.getBattleStats(telegram_id);
    const totalCollected = db.getTotalCollected(telegram_id);

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
router.get('/user/:telegramId/collections', (req, res) => {
  try {
    const collections = db.getUserCollections(req.params.telegramId, 20);
    res.json({ success: true, data: collections });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Withdrawals ──
router.get('/user/:telegramId/withdrawals', (req, res) => {
  try {
    const withdrawals = db.getUserWithdrawals(req.params.telegramId);
    res.json({ success: true, data: withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Battles ──
router.get('/user/:telegramId/battles', (req, res) => {
  try {
    const battles = db.getUserBattles(req.params.telegramId, 20);
    res.json({ success: true, data: battles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
