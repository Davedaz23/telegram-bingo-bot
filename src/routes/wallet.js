const express = require('express');
const router = express.Router();
const WalletService = require('../services/walletService');

// Get wallet balance - userId in query params
router.get('/balance', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required in query parameters',
      });
    }

    const balance = await WalletService.getBalance(userId);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Create deposit request - userId in request body
router.post('/deposit', async (req, res) => {
  try {
    const { userId, amount, receiptImage, reference, description } = req.body;
    
    if (!userId || !amount || !receiptImage || !reference) {
      return res.status(400).json({
        success: false,
        error: 'userId, amount, receiptImage, and reference are required',
      });
    }

    const transaction = await WalletService.createDepositRequest(
      userId,
      amount,
      receiptImage,
      reference,
      description
    );
    
    res.json({ success: true, transaction });
  } catch (error) {
    console.error('Create deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get transaction history - userId in query params
router.get('/transactions', async (req, res) => {
  try {
    const { userId, limit = 10, page = 1 } = req.query;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required in query parameters',
      });
    }

    const history = await WalletService.getTransactionHistory(
      userId,
      parseInt(limit),
      parseInt(page)
    );
    
    res.json({ success: true, ...history });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Get pending deposits - userId in query params
router.get('/admin/pending-deposits', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required in query parameters',
      });
    }

    // Optional: Add admin check here if needed
    // const isAdmin = await checkIfAdmin(userId);
    // if (!isAdmin) {
    //   return res.status(403).json({ success: false, error: 'Access denied' });
    // }
    
    const pendingDeposits = await WalletService.getPendingDeposits();
    res.json({ success: true, deposits: pendingDeposits });
  } catch (error) {
    console.error('Get pending deposits error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Approve deposit - userId in request body
router.post('/admin/approve-deposit/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required in request body',
      });
    }

    // Optional: Add admin check here if needed
    // const isAdmin = await checkIfAdmin(userId);
    // if (!isAdmin) {
    //   return res.status(403).json({ success: false, error: 'Access denied' });
    // }
    
    const result = await WalletService.approveDeposit(transactionId, userId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Approve deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Join game with wallet payment
router.post('/join-with-wallet', async (req, res) => {
  try {
    const { userId, gameCode, entryFee = 10 } = req.body;
    
    if (!userId || !gameCode) {
      return res.status(400).json({
        success: false,
        error: 'userId and gameCode are required',
      });
    }

    const result = await WalletService.deductGameEntry(userId, gameCode, entryFee);
    
    res.json({ 
      success: true, 
      message: 'Successfully joined game with wallet payment',
      ...result 
    });
  } catch (error) {
    console.error('Join with wallet error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Add winning to wallet
router.post('/add-winning', async (req, res) => {
  try {
    const { userId, gameId, amount, description } = req.body;
    
    if (!userId || !gameId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'userId, gameId, and amount are required',
      });
    }

    const result = await WalletService.addWinning(
      userId, 
      gameId, 
      amount, 
      description || 'Game winning'
    );
    
    res.json({ 
      success: true, 
      message: 'Winning added to wallet',
      ...result 
    });
  } catch (error) {
    console.error('Add winning error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Initialize wallet for user
router.post('/initialize', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const wallet = await WalletService.initializeWallet(userId);
    
    res.json({ 
      success: true, 
      message: 'Wallet initialized successfully',
      wallet 
    });
  } catch (error) {
    console.error('Initialize wallet error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;