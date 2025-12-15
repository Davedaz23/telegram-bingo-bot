// src/app.js - UPDATED VERSION
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');
const walletRoutes = require('./src/routes/wallet');
const testRoutes = require('./src/routes/test');
const cron = require('node-cron');
const ReconciliationService = require('./src/services/reconciliationService');
// Import WalletService to initialize payment methods
const WalletService = require('./src/services/walletService');
// Import GameService - make sure the path is correct
const GameService = require('./src/services/gameService');

const app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ FIXED: Simplified bot initialization
let botController = null;

const initializeBot = () => {
  try {
    if (!process.env.BOT_TOKEN) {
      console.warn('⚠️ BOT_TOKEN not found - Telegram bot disabled');
      return null;
    }

    if (!process.env.ADMIN_TELEGRAM_ID) {
      console.warn('⚠️ ADMIN_TELEGRAM_ID not found - Admin features disabled');
    }

    console.log('🤖 Initializing Telegram bot...');
    
    const BotController = require('./src/controllers/botController');
    botController = new BotController(
      process.env.BOT_TOKEN,
      process.env.ADMIN_TELEGRAM_ID || ''
    );
    
    // Launch the bot immediately
    botController.launch();
    console.log('✅ Telegram Bot launched successfully');
    
    return botController;
  } catch (error) {
    console.error('❌ Failed to initialize Telegram bot:', error);
    console.error('Error details:', error.stack);
    return null;
  }
};

// CORS configuration - UPDATED with your live frontend URL
app.use(cors({
  origin: [
    'https://bingominiapp.vercel.app', // Your live frontend
    'http://localhost:3001', // Development
    'http://localhost:3000'  // Development
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

// Middleware
app.use(express.json({ limit: '10mb' })); // Increased for receipt images if needed
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api', testRoutes);
// ✅ ADD: Admin routes for wallet management
app.use('/api/admin', require('./src/routes/admin'));

app.get('/test-sms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/test-sms.html'));
});

// Quick test endpoint
app.get('/test-quick', async (req, res) => {
  const testSMS = req.query.sms || `Dear Defar, You have transfered ETB 50.00 to Defar Gobeze on 07/12/2025 at 21:58:15 from your account 1*****6342. Your account has been debited with a S.charge of ETB 0.50 and  15% VAT of ETB0.08, with a total of ETB50.58. Your Current Balance is ETB 285,823.10. Thank you for Banking with CBE! https://apps.cbe.com.et:100/?id=FT253422RPRW11206342 For feedback click the link https://forms.gle/R1s9nkJ6qZVCxRVu9`;

  try {
    const result = {
      originalSMS: testSMS,
      extraction: WalletService.extractTransactionIdentifiers(testSMS),
      cleaned: WalletService.cleanCBEReference(WalletService.extractTransactionIdentifiers(testSMS).refNumber)
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ MODIFIED: Initialize services with proper error handling
const initializeServices = async () => {
  try {
    console.log('🔄 Initializing all services...');

    // 1. Initialize payment methods
    console.log('💰 Initializing payment methods...');
    await WalletService.initializePaymentMethods();
    console.log('✅ Payment methods initialized successfully');

    // 2. Initialize auto-game service
    console.log('🎮 Initializing auto-game service...');
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      GameService.startAutoGameService();
      console.log('✅ Auto-game service initialized successfully');
    } else {
      console.error('❌ GameService.startAutoGameService is not available');
    }

    // 3. Initialize Telegram bot
    console.log('🤖 Initializing Telegram bot...');
    botController = initializeBot();
    
    if (botController) {
      console.log('✅ Telegram bot initialized successfully');
    } else {
      console.warn('⚠️ Telegram bot not initialized (check BOT_TOKEN in .env)');
    }

    console.log('🎉 All services initialized successfully!');
    
  } catch (error) {
    console.error('❌ Failed to initialize services:', error);
    console.error('Error details:', error.message);
  }
};

// Enhanced health check with wallet status
app.get('/health', async (req, res) => {
  try {
    // MongoDB health check
    await mongoose.connection.db.admin().ping();

    // Check wallet service status
    const Wallet = require('./src/models/Wallet');
    const Transaction = require('./src/models/Transaction');

    const totalWallets = await Wallet.countDocuments();
    const pendingDeposits = await Transaction.countDocuments({
      type: 'DEPOSIT',
      status: 'PENDING'
    });

    const botStatus = botController ? '✅ Running' : '❌ Not running';

    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
      wallet: {
        totalWallets,
        pendingDeposits
      },
      telegramBot: botStatus,
      uptime: process.uptime(),
      cors: {
        allowedOrigins: [
          'https://bingominiapp.vercel.app',
          'http://localhost:3001',
          'http://localhost:3000'
        ]
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed',
      uptime: process.uptime()
    });
  }
});

// Admin health check endpoint
app.get('/admin/health', async (req, res) => {
  try {
    const Wallet = require('./src/models/Wallet');
    const Transaction = require('./src/models/Transaction');
    const User = require('./src/models/User');

    const stats = {
      users: await User.countDocuments(),
      wallets: await Wallet.countDocuments(),
      totalTransactions: await Transaction.countDocuments(),
      pendingDeposits: await Transaction.countDocuments({
        type: 'DEPOSIT',
        status: 'PENDING'
      }),
      completedDeposits: await Transaction.countDocuments({
        type: 'DEPOSIT',
        status: 'COMPLETED'
      }),
      totalBalance: await Wallet.aggregate([
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ])
    };

    res.json({
      status: 'OK',
      system: 'Bingo Admin Dashboard',
      timestamp: new Date().toISOString(),
      stats,
      telegramBot: botController ? 'Running' : 'Not running'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// Root route
app.get('/', (req, res) => {
  const botStatus = botController ? '✅ Running' : '❌ Not running';
  
  res.json({
    message: 'Bingo API Server with Wallet System',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    status: {
      telegramBot: botStatus,
      walletSystem: '✅ Enabled',
      gameService: '✅ Active'
    },
    features: [
      'Telegram Authentication',
      'Real-time Bingo Games',
      'Wallet System with Ethiopian Payments',
      'Admin Dashboard'
    ],
    frontend: 'https://bingominiapp.vercel.app',
    endpoints: {
      auth: '/api/auth/telegram',
      games: '/api/games',
      wallet: '/api/wallet',
      admin: '/api/admin',
      health: '/health'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableEndpoints: {
      root: '/',
      health: '/health',
      auth: '/api/auth/telegram',
      games: '/api/games/*',
      wallet: '/api/wallet/*',
      admin: '/api/admin/*'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error Stack:', err.stack);

  // MongoDB duplicate key error
  if (err.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'Duplicate entry found'
    });
  }

  // MongoDB validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors
    });
  }

  // Wallet service errors
  if (err.message.includes('Wallet') || err.message.includes('balance')) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }

  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
  });
});

cron.schedule('0 * * * *', async () => {
  console.log('🕐 Running hourly reconciliation check...');
  try {
    await ReconciliationService.runDailyReconciliation();
  } catch (error) {
    console.error('❌ Hourly reconciliation failed:', error);
  }
});

// Run comprehensive reconciliation at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('🌙 Running midnight comprehensive reconciliation...');
  try {
    const result = await ReconciliationService.runDailyReconciliation();
    console.log('✅ Midnight reconciliation complete:', result);
  } catch (error) {
    console.error('❌ Midnight reconciliation failed:', error);
  }
});

const PORT = process.env.PORT || 3000;

// Start server and THEN initialize services
const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`💰 Wallet System: Enabled`);
  console.log(`🤖 Telegram Bot: ${process.env.BOT_TOKEN ? 'Enabled' : 'Disabled'}`);
  console.log(`👑 Admin ID: ${process.env.ADMIN_TELEGRAM_ID || 'Not set'}`);
  console.log(`🌐 CORS enabled for:`);
  console.log(`   - https://bingominiapp.vercel.app (Production)`);
  console.log(`   - http://localhost:3001 (Development)`);
  console.log(`   - http://localhost:3000 (Development)`);

  // Initialize services after server is running
  setTimeout(() => {
    console.log('🔄 Initializing services...');
    initializeServices();
  }, 2000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down gracefully...');

  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
  }

  // Stop bot if running
  if (botController && botController.bot) {
    botController.bot.stop();
    console.log('✅ Telegram bot stopped');
  }

  // Close MongoDB connection
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('🛑 Server terminating gracefully...');

  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
  }

  // Stop bot if running
  if (botController && botController.bot) {
    botController.bot.stop();
    console.log('✅ Telegram bot stopped');
  }

  // Close MongoDB connection
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

module.exports = app;