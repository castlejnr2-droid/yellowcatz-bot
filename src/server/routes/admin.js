const express = require('express');
const router = express.Router();
const db = require('../../db/queries');

// Simple API key middleware for admin routes
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

router.use(adminAuth);

router.get('/pending-withdrawals', async (req, res) => {
  const pending = await db.getPendingWithdrawals();
  res.json({ success: true, data: pending });
});

router.post('/withdrawal/:id/approve', async (req, res) => {
  const { id } = req.params;
  const w = await db.getWithdrawalById(id);
  if (!w) return res.status(404).json({ success: false, error: 'Not found' });
  await db.updateWithdrawalStatus(id, 'processing');
  res.json({ success: true, message: `Processing withdrawal #${id}` });
});

router.post('/withdrawal/:id/reject', async (req, res) => {
  const { id } = req.params;
  const w = await db.getWithdrawalById(id);
  if (!w) return res.status(404).json({ success: false, error: 'Not found' });
  await db.refundWithdrawal(w);
  res.json({ success: true, message: `Rejected & refunded #${id}` });
});

router.get('/users', async (req, res) => {
  const users = await db.getAllUsers();
  res.json({ success: true, data: users });
});

router.get('/stats', async (req, res) => {
  const stats = await db.getStats();
  res.json({ success: true, data: stats });
});

module.exports = router;
