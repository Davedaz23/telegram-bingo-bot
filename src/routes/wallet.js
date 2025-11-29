// routes/wallet.js - COMPLETE VERSION WITH AUTO ENDPOINTS
const express = require('express');
const router = express.Router();
const WalletService = require('../services/walletService');

// Get wallet balance - accepts both MongoDB ID and Telegram ID
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

// NEW: Auto balance endpoint that tries multiple strategies
router.get('/balance/auto', async (req, res) => {
  try {
    console.log('💰 Auto balance endpoint called');
    
    // Get user ID from various sources
    const userId = req.query.userId || req.body.userId;
    const telegramId = req.query.telegramId || req.body.telegramId;
    
    console.log('💰 Auto balance - Available IDs:', { userId, telegramId });

    // Strategy 1: Use provided Telegram ID
    if (telegramId && telegramId.match(/^\d+$/)) {
      console.log('💰 Auto: Using Telegram ID:', telegramId);
      try {
        const balance = await WalletService.getBalanceByTelegramId(telegramId);
        return res.json({ 
          success: true, 
          balance,
          source: 'telegram_id',
          telegramId 
        });
      } catch (error) {
        console.warn('💰 Auto: Telegram ID strategy failed:', error.message);
      }
    }

    // Strategy 2: Use provided user ID (could be MongoDB ID or Telegram ID)
    if (userId) {
      console.log('💰 Auto: Using provided user ID:', userId);
      try {
        const balance = await WalletService.getBalance(userId);
        return res.json({ 
          success: true, 
          balance,
          source: 'user_id',
          userId 
        });
      } catch (error) {
        console.warn('💰 Auto: User ID strategy failed:', error.message);
      }
    }

    // Strategy 3: Try to get from auth context (if available)
    if (req.user && req.user.telegramId) {
      console.log('💰 Auto: Using auth context Telegram ID:', req.user.telegramId);
      try {
        const balance = await WalletService.getBalanceByTelegramId(req.user.telegramId);
        return res.json({ 
          success: true, 
          balance,
          source: 'auth_context',
          telegramId: req.user.telegramId 
        });
      } catch (error) {
        console.warn('💰 Auto: Auth context strategy failed:', error.message);
      }
    }

    // Strategy 4: Try to get from auth context MongoDB ID
    if (req.user && req.user._id) {
      console.log('💰 Auto: Using auth context MongoDB ID:', req.user._id);
      try {
        const balance = await WalletService.getBalance(req.user._id);
        return res.json({ 
          success: true, 
          balance,
          source: 'auth_context_mongo',
          userId: req.user._id 
        });
      } catch (error) {
        console.warn('💰 Auto: Auth context MongoDB strategy failed:', error.message);
      }
    }

    throw new Error('No valid user identification found. Please provide userId or telegramId.');

  } catch (error) {
    console.error('❌ Auto balance error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message,
      details: 'Provide userId or telegramId in query parameters or ensure user is authenticated'
    });
  }
});

// Get balance by Telegram ID (explicit route)
router.get('/balance/telegram/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'telegramId is required',
      });
    }

    const balance = await WalletService.getBalanceByTelegramId(telegramId);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Get balance by Telegram ID error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get wallet info by Telegram ID
router.get('/wallet/telegram/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'telegramId is required',
      });
    }

    const wallet = await WalletService.getWalletByTelegramId(telegramId);
    res.json({ success: true, wallet });
  } catch (error) {
    console.error('Get wallet by Telegram ID error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// NEW: Auto wallet endpoint
router.get('/wallet/auto', async (req, res) => {
  try {
    console.log('💰 Auto wallet endpoint called');
    
    // Get user ID from various sources
    const userId = req.query.userId || req.body.userId;
    const telegramId = req.query.telegramId || req.body.telegramId;
    
    console.log('💰 Auto wallet - Available IDs:', { userId, telegramId });

    // Strategy 1: Use provided Telegram ID
    if (telegramId && telegramId.match(/^\d+$/)) {
      console.log('💰 Auto wallet: Using Telegram ID:', telegramId);
      try {
        const wallet = await WalletService.getWalletByTelegramId(telegramId);
        return res.json({ 
          success: true, 
          wallet,
          source: 'telegram_id',
          telegramId 
        });
      } catch (error) {
        console.warn('💰 Auto wallet: Telegram ID strategy failed:', error.message);
      }
    }

    // Strategy 2: Use provided user ID
    if (userId) {
      console.log('💰 Auto wallet: Using provided user ID:', userId);
      try {
        const wallet = await WalletService.getWallet(userId);
        return res.json({ 
          success: true, 
          wallet,
          source: 'user_id',
          userId 
        });
      } catch (error) {
        console.warn('💰 Auto wallet: User ID strategy failed:', error.message);
      }
    }

    // Strategy 3: Try auth context
    if (req.user && req.user.telegramId) {
      console.log('💰 Auto wallet: Using auth context Telegram ID:', req.user.telegramId);
      try {
        const wallet = await WalletService.getWalletByTelegramId(req.user.telegramId);
        return res.json({ 
          success: true, 
          wallet,
          source: 'auth_context',
          telegramId: req.user.telegramId 
        });
      } catch (error) {
        console.warn('💰 Auto wallet: Auth context strategy failed:', error.message);
      }
    }

    throw new Error('No valid user identification found for wallet lookup.');

  } catch (error) {
    console.error('❌ Auto wallet error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Create deposit request - accepts both MongoDB ID and Telegram ID
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

// NEW: Auto deposit endpoint
router.post('/deposit/auto', async (req, res) => {
  try {
    const { amount, receiptImage, reference, description, userId, telegramId } = req.body;
    
    if (!amount || !receiptImage || !reference) {
      return res.status(400).json({
        success: false,
        error: 'amount, receiptImage, and reference are required',
      });
    }

    let targetUserId = userId;

    // If no userId provided, try to get from telegramId or auth context
    if (!targetUserId) {
      if (telegramId) {
        console.log('💰 Auto deposit: Resolving Telegram ID:', telegramId);
        targetUserId = await WalletService.resolveUserId(telegramId);
      } else if (req.user && req.user.telegramId) {
        console.log('💰 Auto deposit: Using auth context Telegram ID:', req.user.telegramId);
        targetUserId = await WalletService.resolveUserId(req.user.telegramId);
      } else if (req.user && req.user._id) {
        console.log('💰 Auto deposit: Using auth context MongoDB ID:', req.user._id);
        targetUserId = req.user._id;
      }
    }

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user. Please provide userId or telegramId, or ensure user is authenticated.',
      });
    }

    const transaction = await WalletService.createDepositRequest(
      targetUserId,
      amount,
      receiptImage,
      reference,
      description
    );
    
    res.json({ 
      success: true, 
      transaction,
      source: targetUserId === userId ? 'provided_user_id' : 'resolved_user_id'
    });
  } catch (error) {
    console.error('Auto deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get transaction history - accepts both MongoDB ID and Telegram ID
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

// NEW: Auto transactions endpoint
router.get('/transactions/auto', async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    
    let userId;

    // Try to get user ID from various sources
    if (req.query.userId) {
      userId = req.query.userId;
    } else if (req.query.telegramId) {
      userId = await WalletService.resolveUserId(req.query.telegramId);
    } else if (req.user && req.user.telegramId) {
      userId = await WalletService.resolveUserId(req.user.telegramId);
    } else if (req.user && req.user._id) {
      userId = req.user._id;
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user. Please provide userId or telegramId, or ensure user is authenticated.',
      });
    }

    const history = await WalletService.getTransactionHistory(
      userId,
      parseInt(limit),
      parseInt(page)
    );
    
    res.json({ success: true, ...history });
  } catch (error) {
    console.error('Auto transactions error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Get pending deposits
router.get('/admin/pending-deposits', async (req, res) => {
  try {
    const pendingDeposits = await WalletService.getPendingDeposits();
    res.json({ success: true, deposits: pendingDeposits });
  } catch (error) {
    console.error('Get pending deposits error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Admin route - Approve deposit - accepts both MongoDB ID and Telegram ID
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

    const result = await WalletService.approveDeposit(transactionId, userId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Approve deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Join game with wallet payment - accepts both MongoDB ID and Telegram ID
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

// NEW: Auto join game with wallet
router.post('/join-with-wallet/auto', async (req, res) => {
  try {
    const { gameCode, entryFee = 10, userId, telegramId } = req.body;
    
    if (!gameCode) {
      return res.status(400).json({
        success: false,
        error: 'gameCode is required',
      });
    }

    let targetUserId = userId;

    // Resolve user ID if not provided
    if (!targetUserId) {
      if (telegramId) {
        targetUserId = await WalletService.resolveUserId(telegramId);
      } else if (req.user && req.user.telegramId) {
        targetUserId = await WalletService.resolveUserId(req.user.telegramId);
      } else if (req.user && req.user._id) {
        targetUserId = req.user._id;
      }
    }

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user. Please provide userId or telegramId, or ensure user is authenticated.',
      });
    }

    const result = await WalletService.deductGameEntry(targetUserId, gameCode, entryFee);
    
    res.json({ 
      success: true, 
      message: 'Successfully joined game with wallet payment',
      ...result 
    });
  } catch (error) {
    console.error('Auto join with wallet error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Add winning to wallet - accepts both MongoDB ID and Telegram ID
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

// Initialize wallet for user - accepts both MongoDB ID and Telegram ID
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

// NEW: Auto initialize wallet
router.post('/initialize/auto', async (req, res) => {
  try {
    let userId;

    // Try to get user ID from various sources
    if (req.body.userId) {
      userId = req.body.userId;
    } else if (req.body.telegramId) {
      userId = await WalletService.resolveUserId(req.body.telegramId);
    } else if (req.user && req.user.telegramId) {
      userId = await WalletService.resolveUserId(req.user.telegramId);
    } else if (req.user && req.user._id) {
      userId = req.user._id;
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user. Please provide userId or telegramId, or ensure user is authenticated.',
      });
    }

    const wallet = await WalletService.initializeWallet(userId);
    
    res.json({ 
      success: true, 
      message: 'Wallet initialized successfully',
      wallet 
    });
  } catch (error) {
    console.error('Auto initialize wallet error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// SMS Deposit endpoints
router.post('/sms/deposit', async (req, res) => {
  try {
    const { userId, smsText, paymentMethod } = req.body;
    
    if (!userId || !smsText) {
      return res.status(400).json({
        success: false,
        error: 'userId and smsText are required',
      });
    }

    const result = await WalletService.processSMSDeposit(
      userId,
      paymentMethod || 'UNKNOWN',
      smsText,
      true // autoApprove
    );
    
    res.json({ 
      success: true, 
      message: result.autoApproved ? 'SMS deposit auto-approved' : 'SMS deposit pending review',
      ...result 
    });
  } catch (error) {
    console.error('SMS deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// NEW: Auto SMS deposit
router.post('/sms/deposit/auto', async (req, res) => {
  try {
    const { smsText, paymentMethod, userId, telegramId } = req.body;
    
    if (!smsText) {
      return res.status(400).json({
        success: false,
        error: 'smsText is required',
      });
    }

    let targetUserId = userId;

    // Resolve user ID if not provided
    if (!targetUserId) {
      if (telegramId) {
        targetUserId = await WalletService.resolveUserId(telegramId);
      } else if (req.user && req.user.telegramId) {
        targetUserId = await WalletService.resolveUserId(req.user.telegramId);
      } else if (req.user && req.user._id) {
        targetUserId = req.user._id;
      }
    }

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user. Please provide userId or telegramId, or ensure user is authenticated.',
      });
    }

    const result = await WalletService.processSMSDeposit(
      targetUserId,
      paymentMethod || 'UNKNOWN',
      smsText,
      true // autoApprove
    );
    
    res.json({ 
      success: true, 
      message: result.autoApproved ? 'SMS deposit auto-approved' : 'SMS deposit pending review',
      ...result 
    });
  } catch (error) {
    console.error('Auto SMS deposit error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Store SMS message
router.post('/sms/store', async (req, res) => {
  try {
    const { userId, smsText, paymentMethod } = req.body;
    
    if (!userId || !smsText) {
      return res.status(400).json({
        success: false,
        error: 'userId and smsText are required',
      });
    }

    const smsDeposit = await WalletService.storeSMSMessage(userId, smsText, paymentMethod);
    
    res.json({ 
      success: true, 
      message: 'SMS stored successfully',
      smsDeposit 
    });
  } catch (error) {
    console.error('Store SMS error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Wallet Service',
    status: 'OK',
    timestamp: new Date().toISOString(),
    features: {
      idResolution: true,
      multiCurrency: true,
      transactionHistory: true,
      adminOperations: true,
      autoEndpoints: true,
      smsProcessing: true
    },
    endpoints: {
      balance: '/wallet/balance',
      autoBalance: '/wallet/balance/auto',
      transactions: '/wallet/transactions',
      autoTransactions: '/wallet/transactions/auto',
      deposit: '/wallet/deposit',
      autoDeposit: '/wallet/deposit/auto',
      smsDeposit: '/wallet/sms/deposit',
      autoSmsDeposit: '/wallet/sms/deposit/auto'
    }
  });
});

// NEW: Detailed status endpoint
router.get('/status', async (req, res) => {
  try {
    const totalWallets = await require('../models/Wallet').countDocuments();
    const totalTransactions = await require('../models/Transaction').countDocuments();
    const totalSMSDeposits = await require('../models/SMSDeposit').countDocuments();
    
    res.json({
      success: true,
      status: 'operational',
      timestamp: new Date().toISOString(),
      statistics: {
        totalWallets,
        totalTransactions,
        totalSMSDeposits,
        pendingDeposits: await require('../models/Transaction').countDocuments({ status: 'PENDING', type: 'DEPOSIT' }),
        pendingSMSDeposits: await require('../models/SMSDeposit').countDocuments({ status: 'PENDING' })
      }
    });
  } catch (error) {
    console.error('Status endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;