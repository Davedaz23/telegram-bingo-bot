const express = require('express');
const router = express.Router();
const WalletService = require('../services/walletService');
const auth = require('../middleware/auth');

// Get wallet balance
router.get('/balance', auth, async (req, res) => {
  try {
    const balance = await WalletService.getBalance(req.user._id);
    res.json({ success: true, balance });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Create deposit request
router.post('/deposit', auth, async (req, res) => {
  try {
    const { amount, receiptImage, reference, description } = req.body;
    
    const transaction = await WalletService.createDepositRequest(
      req.user._id,
      amount,
      receiptImage,
      reference,
      description
    );
    
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get transaction history
router.get('/transactions', auth, async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    
    const history = await WalletService.getTransactionHistory(
      req.user._id,
      parseInt(limit),
      parseInt(page)
    );
    
    res.json({ success: true, ...history });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Get pending deposits
router.get('/admin/pending-deposits', auth, async (req, res) => {
  try {
    // Check if user is admin (you'll need to implement this check)
    // if (!req.user.isAdmin) {
    //   return res.status(403).json({ success: false, error: 'Access denied' });
    // }
    
    const pendingDeposits = await WalletService.getPendingDeposits();
    res.json({ success: true, deposits: pendingDeposits });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Approve deposit
router.post('/admin/approve-deposit/:transactionId', auth, async (req, res) => {
  try {
    // Check if user is admin
    // if (!req.user.isAdmin) {
    //   return res.status(403).json({ success: false, error: 'Access denied' });
    // }
    
    const { transactionId } = req.params;
    
    const result = await WalletService.approveDeposit(transactionId, req.user._id);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;