// src/routes/admin.js
const express = require('express');
const router = express.Router();
const WalletService = require('../services/walletService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

// Admin middleware (simple version - enhance with proper auth)
const adminAuth = (req, res, next) => {
  // In production, use proper JWT or session auth
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === process.env.ADMIN_SECRET) {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required' });
  }
};

// Get all pending deposits
router.get('/deposits/pending', adminAuth, async (req, res) => {
  try {
    const deposits = await WalletService.getPendingDeposits();
    res.json({ success: true, deposits });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Approve deposit
router.post('/deposits/:id/approve', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body; // Telegram ID of approving admin
    
    const result = await WalletService.approveDeposit(id, adminId);
    
    res.json({ 
      success: true, 
      message: 'Deposit approved successfully',
      transaction: result.transaction,
      newBalance: result.wallet.balance
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Reject deposit
router.post('/deposits/:id/reject', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const transaction = await Transaction.findByIdAndUpdate(
      id,
      { 
        status: 'FAILED',
        description: `Rejected: ${reason}`
      },
      { new: true }
    );
    
    if (!transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    res.json({ success: true, message: 'Deposit rejected', transaction });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get system statistics
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalWallets = await require('../models/Wallet').countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    
    const revenueStats = await Transaction.aggregate([
      { $match: { type: 'GAME_ENTRY', status: 'COMPLETED' } },
      { $group: { _id: null, totalRevenue: { $sum: '$amount' } } }
    ]);
    
    const depositStats = await Transaction.aggregate([
      { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
      { $group: { _id: null, totalDeposits: { $sum: '$amount' } } }
    ]);
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        totalWallets,
        totalTransactions,
        totalRevenue: revenueStats[0]?.totalRevenue || 0,
        totalDeposits: depositStats[0]?.totalDeposits || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent transactions
router.get('/transactions', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const transactions = await Transaction.find()
      .populate('userId', 'username firstName telegramId')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Transaction.countDocuments();
    
    res.json({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;