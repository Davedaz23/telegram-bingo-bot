// src/routes/admin.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const WalletService = require('../services/walletService');
const GameService = require('../services/gameService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Game = require('../models/Game');
const Wallet = require('../models/Wallet');
const Reconciliation = require('../models/Reconciliation');
const SMSDeposit = require('../models/SMSDeposit');
const BingoCard = require('../models/BingoCard');
const GamePlayer = require('../models/GamePlayer'); // ← ADD THIS LINE

// ================ ADMIN AUTHENTICATION ================
// Enhanced admin middleware with proper auth
const adminAuth = async (req, res, next) => {
  try {
    // Method 1: API Key (simpler for now)
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.ADMIN_API_KEY) {
      req.adminId = 'system';
      return next();
    }
    
    // Method 2: Bearer Token (JWT) - implement later
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      // Add JWT verification here
      // const decoded = jwt.verify(token, process.env.JWT_SECRET);
      // req.adminId = decoded.id;
      // return next();
    }
    
    // Method 3: Admin Key header (backward compatibility)
    const adminKey = req.headers['x-admin-key'];
    if (adminKey && adminKey === process.env.ADMIN_SECRET) {
      req.adminId = 'system';
      return next();
    }
    
    res.status(403).json({ 
      success: false, 
      error: 'Admin access required. Valid API key or admin token needed.' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Apply admin auth to all routes
router.use(adminAuth);

// ================ DASHBOARD STATS ================
router.get('/dashboard/stats', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);
    startOfWeek.setHours(0, 0, 0, 0);
    
    const startOfMonth = new Date(now);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    
    // Run all queries in parallel for better performance
    const [
      totalUsers,
      newUsersToday,
      activeUsersToday,
      totalGames,
      activeGames,
      completedGamesToday,
      totalPot,
      totalWinnings,
      platformFees,
      totalBalance,
      pendingWithdrawals,
      pendingSMS,
      unprocessedSMS,
      gameRevenue,
      userGrowth
    ] = await Promise.all([
      // User stats
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfDay } }),
      User.countDocuments({ lastActive: { $gte: startOfDay } }),
      
      // Game stats
      Game.countDocuments(),
      Game.countDocuments({ 
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] } 
      }),
      Game.countDocuments({ 
        status: 'FINISHED', 
        endedAt: { $gte: startOfDay } 
      }),
      
      // Financial stats
      Reconciliation.aggregate([
        { $group: { _id: null, total: { $sum: '$totalPot' } } }
      ]),
      Reconciliation.aggregate([
        { $match: { status: 'WINNER_DECLARED' } },
        { $group: { _id: null, total: { $sum: '$winnerAmount' } } }
      ]),
      Reconciliation.aggregate([
        { $group: { _id: null, total: { $sum: '$platformFee' } } }
      ]),
      
      // Wallet stats
      Wallet.aggregate([
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ]),
      
      // Pending items
      Transaction.countDocuments({ type: 'WITHDRAWAL', status: 'PENDING' }),
      SMSDeposit.countDocuments({ status: 'RECEIVED_WAITING_MATCH' }),
      SMSDeposit.countDocuments({ status: 'RECEIVED' }),
      
      // Game revenue (entry fees)
      Transaction.aggregate([
        { $match: { type: 'GAME_ENTRY', status: 'COMPLETED' } },
        { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } }
      ]),
      
      // User growth (last 7 days)
      User.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfWeek }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id': 1 } }
      ])
    ]);
    
    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          newToday: newUsersToday,
          activeToday: activeUsersToday,
          growth: userGrowth
        },
        games: {
          total: totalGames,
          active: activeGames,
          completedToday: completedGamesToday
        },
        finances: {
          totalPot: totalPot[0]?.total || 0,
          totalWinnings: totalWinnings[0]?.total || 0,
          platformFees: platformFees[0]?.total || 0,
          totalBalance: totalBalance[0]?.total || 0,
          gameRevenue: gameRevenue[0]?.total || 0,
          pendingWithdrawals
        },
        pending: {
          withdrawals: pendingWithdrawals,
          smsToMatch: pendingSMS,
          unprocessedSMS: unprocessedSMS
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ USER MANAGEMENT ================
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = 'all' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build search query
    let query = {};
    if (search) {
      query.$or = [
        { telegramId: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Filter by status
    if (status === 'active') {
      query.isActive = true;
    } else if (status === 'inactive') {
      query.isActive = false;
    }
    
    // Get users with pagination
    const users = await User.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();
    
    // Get wallet info for each user
    const userIds = users.map(u => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } });
    
    // Get transaction counts
    const transactionCounts = await Transaction.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { 
        _id: '$userId', 
        totalTransactions: { $sum: 1 },
        totalDeposits: { 
          $sum: { 
            $cond: [{ $eq: ['$type', 'DEPOSIT'] }, 1, 0] 
          } 
        },
        totalWithdrawals: { 
          $sum: { 
            $cond: [{ $eq: ['$type', 'WITHDRAWAL'] }, 1, 0] 
          } 
        }
      } }
    ]);
    
    // Create map for quick lookup
    const transactionMap = {};
    transactionCounts.forEach(t => {
      transactionMap[t._id.toString()] = t;
    });
    
    const usersWithDetails = users.map(user => ({
      ...user,
      wallet: wallets.find(w => w.userId.toString() === user._id.toString()) || { 
        balance: 0, 
        lockedAmount: 0 
      },
      transactionStats: transactionMap[user._id.toString()] || {
        totalTransactions: 0,
        totalDeposits: 0,
        totalWithdrawals: 0
      }
    }));
    
    const total = await User.countDocuments(query);
    
    res.json({
      success: true,
      data: usersWithDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/users/:userId/details', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    // Run parallel queries
    const [
      wallet,
      transactions,
      gameHistory,
      smsDeposits,
      gameStats,
      recentActivity
    ] = await Promise.all([
      Wallet.findOne({ userId: user._id }),
      Transaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Game.find({ 'players.userId': user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('winnerId', 'username firstName telegramId')
        .lean(),
      SMSDeposit.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      
      // Game statistics
      Game.aggregate([
        { $match: { 'players.userId': user._id } },
        { $group: {
          _id: null,
          totalGames: { $sum: 1 },
          gamesWon: {
            $sum: { $cond: [{ $eq: ['$winnerId', user._id] }, 1, 0] }
          }
        } }
      ]),
      
      // Recent activity (last 30 days)
      Transaction.aggregate([
        { $match: { 
          userId: user._id,
          createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        } },
        { $group: {
          _id: { 
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } 
          },
          total: { $sum: 1 }
        } },
        { $sort: { '_id': 1 } }
      ])
    ]);
    
    // Calculate summary
    const totalDeposits = transactions
      .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalWithdrawals = transactions
      .filter(t => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const totalWinnings = transactions
      .filter(t => t.type === 'WINNING' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalGameEntries = transactions
      .filter(t => t.type === 'GAME_ENTRY' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    res.json({
      success: true,
      data: {
        user,
        wallet: wallet || { balance: 0, lockedAmount: 0, currency: 'USD' },
        transactions,
        gameHistory,
        smsDeposits,
        stats: {
          totalDeposits,
          totalWithdrawals,
          totalWinnings,
          totalGameEntries,
          netBalance: totalDeposits + totalWinnings - totalWithdrawals - totalGameEntries,
          gamesPlayed: gameStats[0]?.totalGames || 0,
          gamesWon: gameStats[0]?.gamesWon || 0,
          winRate: gameStats[0]?.totalGames ? 
            ((gameStats[0].gamesWon / gameStats[0].totalGames) * 100).toFixed(1) : 0
        },
        activity: recentActivity
      }
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/users/:userId/toggle-status', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive, reason } = req.body;
    
    const user = await User.findByIdAndUpdate(
      userId,
      { 
        isActive,
        statusChangedAt: new Date(),
        statusChangeReason: reason,
        statusChangedBy: req.adminId
      },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    res.json({
      success: true,
      data: user,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ DEPOSIT MANAGEMENT (from original) ================
router.get('/deposits/pending', async (req, res) => {
  try {
    const deposits = await WalletService.getPendingDeposits();
    res.json({ success: true, deposits });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/deposits/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { adminId } = req.body;
    
    const result = await WalletService.approveDeposit(id, adminId || req.adminId);
    
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

router.post('/deposits/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const transaction = await Transaction.findByIdAndUpdate(
      id,
      { 
        status: 'FAILED',
        description: `Rejected: ${reason || 'No reason provided'}`,
        metadata: {
          rejectedBy: req.adminId,
          rejectedAt: new Date(),
          reason: reason
        }
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

// ================ WITHDRAWAL MANAGEMENT ================
router.get('/withdrawals/pending', async (req, res) => {
  try {
    const withdrawals = await WalletService.getPendingWithdrawals(100);
    res.json({ success: true, data: withdrawals });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/withdrawals/all', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = { type: 'WITHDRAWAL' };
    if (status) query.status = status;
    
    const withdrawals = await Transaction.find(query)
      .populate('userId', 'username firstName telegramId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await Transaction.countDocuments(query);
    
    res.json({
      success: true,
      data: withdrawals,
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

router.post('/withdrawals/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { adminUserId } = req.body;
    
    const result = await WalletService.approveWithdrawal(id, adminUserId || req.adminId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const result = await WalletService.rejectWithdrawal(id, req.adminId, reason);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ SMS DEPOSIT MANAGEMENT ================
router.get('/sms-deposits', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const result = await WalletService.getAllSMSDeposits(parseInt(page), parseInt(limit), status);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sms-deposits/unmatched', async (req, res) => {
  try {
    const result = await WalletService.getUnmatchedSMS();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sms-deposits/match', async (req, res) => {
  try {
    const { senderSMSId, receiverSMSId } = req.body;
    const result = await WalletService.adminForceMatchSMS(senderSMSId, receiverSMSId, req.adminId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sms-deposits/auto-match', async (req, res) => {
  try {
    const result = await WalletService.autoMatchAllSMS();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sms-deposits/stats', async (req, res) => {
  try {
    const stats = await WalletService.getSMSDepositStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ GAME MANAGEMENT ================
router.get('/games', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = status ? { status } : {};
    const games = await Game.find(query)
      .populate('winnerId', 'username firstName telegramId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    // Get player counts for each game
    const gameIds = games.map(g => g._id);
    const playerCounts = await GamePlayer.aggregate([
      { $match: { gameId: { $in: gameIds } } },
      { $group: { _id: '$gameId', count: { $sum: 1 } } }
    ]);
    
    const playerCountMap = {};
    playerCounts.forEach(p => {
      playerCountMap[p._id.toString()] = p.count;
    });
    
    const gamesWithDetails = games.map(game => ({
      ...game,
      actualPlayerCount: playerCountMap[game._id.toString()] || 0,
      duration: game.startedAt && game.endedAt ? 
        Math.round((game.endedAt - game.startedAt) / 60000) : null
    }));
    
    const total = await Game.countDocuments(query);
    
    res.json({
      success: true,
      data: gamesWithDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get games error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/games/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [game, bingoCards, reconciliation, gamePlayers] = await Promise.all([
      Game.findById(id)
        .populate('winnerId', 'username firstName telegramId')
        .lean(),
      BingoCard.find({ gameId: id })
        .populate('userId', 'username firstName telegramId')
        .lean(),
      Reconciliation.findOne({ gameId: id }).lean(),
      GamePlayer.find({ gameId: id })
        .populate('userId', 'username firstName telegramId')
        .lean()
    ]);
    
    if (!game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    
    // Calculate game statistics
    const totalPlayers = bingoCards.length;
    const playersWithBingo = bingoCards.filter(c => c.isWinner).length;
    const averageMarks = bingoCards.length > 0 ?
      bingoCards.reduce((sum, c) => sum + (c.markedPositions?.length || 0), 0) / bingoCards.length : 0;
    
    res.json({
      success: true,
      data: {
        game: {
          ...game,
          totalPlayers,
          playersWithBingo,
          averageMarks: averageMarks.toFixed(1)
        },
        bingoCards,
        reconciliation,
        players: gamePlayers,
        timeline: {
          created: game.createdAt,
          started: game.startedAt,
          ended: game.endedAt,
          duration: game.startedAt && game.endedAt ?
            Math.round((game.endedAt - game.startedAt) / 60000) : null
        }
      }
    });
  } catch (error) {
    console.error('Get game details error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/games/:id/force-end', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const game = await GameService.endGame(id, reason);
    res.json({ 
      success: true, 
      data: game,
      message: 'Game ended successfully' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ TRANSACTION MANAGEMENT ================
router.get('/transactions', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      type, 
      status,
      userId,
      startDate,
      endDate 
    } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build query
    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (userId) query.userId = userId;
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    
    const transactions = await Transaction.find(query)
      .populate('userId', 'username firstName telegramId')
      .populate('gameId', 'code')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await Transaction.countDocuments(query);
    
    // Calculate summary
    const summary = await Transaction.aggregate([
      { $match: query },
      { $group: {
        _id: null,
        totalAmount: { $sum: '$amount' },
        totalDeposits: { 
          $sum: { $cond: [{ $eq: ['$type', 'DEPOSIT'] }, '$amount', 0] } 
        },
        totalWithdrawals: { 
          $sum: { $cond: [{ $eq: ['$type', 'WITHDRAWAL'] }, { $abs: '$amount' }, 0] } 
        },
        totalGameEntries: { 
          $sum: { $cond: [{ $eq: ['$type', 'GAME_ENTRY'] }, { $abs: '$amount' }, 0] } 
        },
        totalWinnings: { 
          $sum: { $cond: [{ $eq: ['$type', 'WINNING'] }, '$amount', 0] } 
        }
      } }
    ]);
    
    res.json({
      success: true,
      data: transactions,
      summary: summary[0] || {
        totalAmount: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalGameEntries: 0,
        totalWinnings: 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ FINANCIAL REPORTS ================
router.get('/reports/daily', async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    
    const [
      games,
      reconciliations,
      transactions,
      smsDeposits,
      hourlyBreakdown
    ] = await Promise.all([
      Game.find({
        createdAt: { $gte: targetDate, $lt: nextDay }
      }).populate('winnerId', 'username firstName').lean(),
      
      Reconciliation.find({
        createdAt: { $gte: targetDate, $lt: nextDay }
      }).lean(),
      
      Transaction.find({
        createdAt: { $gte: targetDate, $lt: nextDay }
      }).populate('userId', 'username firstName telegramId').lean(),
      
      SMSDeposit.find({
        createdAt: { $gte: targetDate, $lt: nextDay }
      }).populate('userId', 'username firstName telegramId').lean(),
      
      // Hourly breakdown
      Transaction.aggregate([
        {
          $match: {
            createdAt: { $gte: targetDate, $lt: nextDay },
            status: 'COMPLETED'
          }
        },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id': 1 } }
      ])
    ]);
    
    // Calculate totals
    const totalDeposits = transactions
      .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalWithdrawals = transactions
      .filter(t => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED')
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const totalGameEntries = transactions
      .filter(t => t.type === 'GAME_ENTRY')
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const totalWinnings = transactions
      .filter(t => t.type === 'WINNING')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const platformFees = reconciliations
      .filter(r => r.status === 'WINNER_DECLARED')
      .reduce((sum, r) => sum + (r.platformFee || 0), 0);
    
    // Top users
    const topDepositors = await Transaction.aggregate([
      {
        $match: {
          type: 'DEPOSIT',
          status: 'COMPLETED',
          createdAt: { $gte: targetDate, $lt: nextDay }
        }
      },
      {
        $group: {
          _id: '$userId',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      }
    ]);
    
    res.json({
      success: true,
      data: {
        date: targetDate.toISOString().split('T')[0],
        summary: {
          gamesPlayed: games.length,
          gamesWithWinner: games.filter(g => g.status === 'FINISHED' && g.winnerId).length,
          gamesWithoutWinner: games.filter(g => g.status === 'NO_WINNER').length,
          totalDeposits,
          totalWithdrawals,
          totalGameEntries,
          totalWinnings,
          platformFees,
          netRevenue: platformFees,
          smsDepositsProcessed: smsDeposits.length,
          uniqueUsers: new Set(transactions.map(t => t.userId?._id?.toString()).filter(Boolean)).size
        },
        games,
        reconciliations,
        transactions: transactions.slice(0, 100),
        smsDeposits: smsDeposits.slice(0, 50),
        hourlyBreakdown,
        topDepositors
      }
    });
  } catch (error) {
    console.error('Daily report error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/reports/range', async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    let dateFormat;
    if (groupBy === 'day') dateFormat = '%Y-%m-%d';
    else if (groupBy === 'week') dateFormat = '%Y-%U';
    else if (groupBy === 'month') dateFormat = '%Y-%m';
    
    const [transactionStats, gameStats, userStats] = await Promise.all([
      // Transaction stats by date
      Transaction.aggregate([
        {
          $match: {
            createdAt: { $gte: start, $lte: end },
            status: 'COMPLETED'
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: dateFormat, date: '$createdAt' } },
              type: '$type'
            },
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]),
      
      // Game stats by date
      Game.aggregate([
        {
          $match: {
            createdAt: { $gte: start, $lte: end }
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: dateFormat, date: '$createdAt' } },
              status: '$status'
            },
            count: { $sum: 1 },
            totalPlayers: { $sum: '$currentPlayers' }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]),
      
      // User acquisition
      User.aggregate([
        {
          $match: {
            createdAt: { $gte: start, $lte: end }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id': 1 } }
      ])
    ]);
    
    res.json({
      success: true,
      data: {
        dateRange: {
          start: start.toISOString().split('T')[0],
          end: end.toISOString().split('T')[0]
        },
        transactionStats,
        gameStats,
        userStats,
        summary: {
          totalTransactions: transactionStats.reduce((sum, t) => sum + t.count, 0),
          totalGames: gameStats.reduce((sum, g) => sum + g.count, 0),
          newUsers: userStats.reduce((sum, u) => sum + u.count, 0)
        }
      }
    });
  } catch (error) {
    console.error('Range report error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ ADMIN ACTIONS ================
router.post('/admin/adjust-balance', async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    
    if (!userId || amount === undefined || !reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId, amount, and reason are required' 
      });
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const mongoUserId = await WalletService.resolveAnyUserId(userId);
      const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;
      
      const transaction = new Transaction({
        userId: mongoUserId,
        type: amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
        amount,
        balanceBefore,
        balanceAfter,
        status: 'COMPLETED',
        description: `Admin ${amount > 0 ? 'credit' : 'debit'}: ${reason}`,
        metadata: {
          adjustedBy: req.adminId,
          adjustedAt: new Date(),
          reason
        }
      });
      
      await wallet.save({ session });
      await transaction.save({ session });
      await session.commitTransaction();
      
      res.json({
        success: true,
        data: {
          wallet,
          transaction,
          newBalance: wallet.balance
        },
        message: `Balance ${amount > 0 ? 'increased' : 'decreased'} by $${Math.abs(amount)}`
      });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Adjust balance error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/admin/system-stats', async (req, res) => {
  try {
    const [
      dbStats,
      activeConnections,
      gameServiceStatus,
      walletHealth
    ] = await Promise.all([
      mongoose.connection.db.stats(),
      GameService.getTotalConnections ? GameService.getTotalConnections() : 0,
      {
        activeGames: GameService.activeIntervals?.size || 0,
        winnerDeclared: GameService.winnerDeclared?.size || 0,
        processingGames: GameService.processingGames?.size || 0
      },
      WalletService.walletHealthCheck ? await WalletService.walletHealthCheck() : null
    ]);
    
    res.json({
      success: true,
      data: {
        database: {
          collections: dbStats.collections,
          objects: dbStats.objects,
          dataSize: dbStats.dataSize,
          storageSize: dbStats.storageSize,
          indexes: dbStats.indexes,
          indexSize: dbStats.indexSize
        },
        gameService: gameServiceStatus,
        walletHealth,
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          nodeVersion: process.version,
          timestamp: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    console.error('System stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================ EXPORT & UTILITIES ================
router.get('/export/transactions', async (req, res) => {
  try {
    const { startDate, endDate, format = 'csv' } = req.query;
    
    const query = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    
    const transactions = await Transaction.find(query)
      .populate('userId', 'username firstName telegramId')
      .populate('gameId', 'code')
      .sort({ createdAt: -1 })
      .lean();
    
    if (format === 'csv') {
      // Convert to CSV
      const headers = ['Date', 'User', 'Type', 'Amount', 'Status', 'Description', 'Reference'];
      const csvRows = [];
      csvRows.push(headers.join(','));
      
      for (const t of transactions) {
        const row = [
          new Date(t.createdAt).toISOString(),
          t.userId?.username || t.userId?.telegramId || 'Unknown',
          t.type,
          t.amount,
          t.status,
          `"${t.description.replace(/"/g, '""')}"`,
          t.reference || ''
        ];
        csvRows.push(row.join(','));
      }
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
      res.send(csvRows.join('\n'));
    } else {
      res.json({ success: true, data: transactions });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;