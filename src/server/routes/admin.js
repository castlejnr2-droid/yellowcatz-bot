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

router.get('/pending-withdrawals', (req, res) => {
  const pending = db.getPendingWithdrawals();
  res.json({ success: true, data: pending });
});

router.post('/withdrawal/:id/approve', (req, res) => {
  const { id } = req.params;
  const w = db.getWithdrawalById(id);
  if (!w) return res.status(404).json({ success: false, error: 'Not found' });
  db.updateWithdrawalStatus(id, 'processing');
  res.json({ success: true, message: `Processing withdrawal #${id}` });
});

router.post('/withdrawal/:id/reject', (req, res) => {
  const { id } = req.params;
  const w = db.getWithdrawalById(id);
  if (!w) return res.status(404).json({ success: false, error: 'Not found' });
  db.refundWithdrawal(w);
  res.json({ success: true, message: `Rejected & refunded #${id}` });
});

router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, data: users });
});

router.get('/stats', (req, res) => {
  const stats = db.getStats();
  res.json({ success: true, data: stats });
});

module.exports = router;
