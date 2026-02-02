// src/app.js - UPDATED VERSION WITH WEBSOCKET
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');
const walletRoutes = require('./src/routes/wallet');
const testRoutes = require('./src/routes/test');
const cron = require('node-cron');
const WebSocketService = require('./src/services/webSocketService');  
const ReconciliationService = require('./src/services/reconciliationService');
const WalletService = require('./src/services/walletService');
const GameService = require('./src/services/gameService');

const app = express();
const server = http.createServer(app);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ FIXED: Bot initialization with better error handling
let botController = null;
let servicesInitialized = false;
let webSocketService = null;
let botInitializationAttempts = 0;
const MAX_BOT_RETRIES = 5;

const AdminUtils = {
  adminIds: [],
  
  initialize() {
    const singleAdmin = process.env.ADMIN_TELEGRAM_ID || '';
    const multipleAdmins = process.env.ADMIN_TELEGRAM_IDS || '';
    
    let allAdmins = [];
    
    if (singleAdmin) {
      allAdmins.push(singleAdmin.trim());
    }
    
    if (multipleAdmins) {
      const ids = multipleAdmins.split(',').map(id => id.trim()).filter(id => id);
      allAdmins = [...allAdmins, ...ids];
    }
    
    this.adminIds = [...new Set(allAdmins)].filter(id => id !== '');
    
    console.log(`👑 AdminUtils initialized with ${this.adminIds.length} admins: ${this.adminIds.join(', ')}`);
  },
  
  isAdmin(userId) {
    const userIdStr = userId.toString();
    return this.adminIds.includes(userIdStr);
  },
  
  getAdminCount() {
    return this.adminIds.length;
  },
  
  getAdminList() {
    return this.adminIds.join(', ');
  },
  
  getAdminIds() {
    return [...this.adminIds];
  }
};

// ✅ FIXED: Better bot initialization with retry mechanism
const initializeBot = async (retryCount = 0) => {
  try {
    if (!process.env.BOT_TOKEN) {
      console.warn('⚠️ BOT_TOKEN not found - Telegram bot disabled');
      return null;
    }

    console.log(`🤖 Initializing Telegram bot (Attempt ${retryCount + 1}/${MAX_BOT_RETRIES})...`);
    
    // Clear any existing instance first
    if (botController) {
      try {
        botController.stop();
      } catch (e) {
        console.log('⚠️ Could not stop existing bot instance:', e.message);
      }
      botController = null;
    }
    
    // Initialize AdminUtils first
    AdminUtils.initialize();
    
    // Import and create BotController
    const BotController = require('./src/controllers/botController');
    
    // Use singleton pattern properly
    if (BotController._instance) {
      console.log('🤖 Reusing existing bot instance');
      botController = BotController._instance;
    } else {
      botController = new BotController(
        process.env.BOT_TOKEN,
        process.env.ADMIN_TELEGRAM_ID || ''
      );
    }
    
    // Launch the bot immediately
    botController.launch();
    console.log('✅ Telegram Bot launched successfully');
    
    // Reset retry counter on success
    botInitializationAttempts = 0;
    
    return botController;
  } catch (error) {
    console.error('❌ Failed to initialize Telegram bot:', error.message);
    
    // Retry logic
    if (retryCount < MAX_BOT_RETRIES - 1) {
      const delay = Math.min(5000 * (retryCount + 1), 30000); // Exponential backoff, max 30s
      console.log(`🔄 Retrying bot initialization in ${delay/1000} seconds...`);
      
      setTimeout(() => {
        initializeBot(retryCount + 1);
      }, delay);
    } else {
      console.error(`❌ Bot initialization failed after ${MAX_BOT_RETRIES} attempts`);
      console.error('Bot error details:', error.stack);
      
      // Schedule retry in 1 minute
      setTimeout(() => {
        console.log('🔄 Scheduled bot retry after failure...');
        initializeBot(0);
      }, 60000);
    }
    
    return null;
  }
};

// ✅ FIXED: Bot health monitoring
const checkBotHealth = () => {
  if (!botController) {
    console.warn('🤖 Bot controller not initialized');
    return false;
  }
  
  try {
    // Try to send a test message to check if bot is alive
    const isRunning = botController.isRunning || false;
    
    if (!isRunning) {
      console.warn('🤖 Bot is marked as not running, attempting restart...');
      initializeBot();
    }
    
    return isRunning;
  } catch (error) {
    console.error('❌ Bot health check failed:', error.message);
    return false;
  }
};

// CORS configuration
const corsOptions = {
  origin: [
    'https://bingominiapp.vercel.app',
    'https://desta.et',
    'http://localhost:3001',
    'http://localhost:3000',
    'ws://localhost:3000',
    'ws://localhost:3001'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api', testRoutes);
app.use('/api/admin', require('./src/routes/admin'));

// WebSocket info endpoint
app.get('/ws/info', (req, res) => {
  res.json({
    success: true,
    webSocketEnabled: true,
    wsUrl: process.env.NODE_ENV === 'production' 
      ? `wss://${req.headers.host}` 
      : `ws://${req.headers.host}`,
    endpoints: {
      game: '/ws/game',
      notifications: '/ws/notifications',
      admin: '/ws/admin'
    },
    events: [
      'CONNECTED',
      'ERROR',
      'TAKEN_CARDS_UPDATE',
      'GAME_STATUS_UPDATE',
      'NUMBER_CALLED',
      'BINGO_CLAIMED',
      'USER_JOINED',
      'USER_LEFT',
      'WALLET_UPDATE',
      'ADMIN_NOTIFICATION'
    ]
  });
});

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

// ✅ FIXED: Initialize services with better error handling
const initializeServices = async () => {
  if (servicesInitialized) {
    console.log('✅ Services already initialized, skipping...');
    return;
  }

  try {
    console.log('🔄 Initializing all services...');
    
    // 1. Initialize WebSocket service
    console.log('🔗 Initializing WebSocket service...');
    webSocketService = new WebSocketService(server);
    console.log('✅ WebSocket service initialized successfully');

    // 2. Initialize GameService with WebSocket service
    if (GameService && typeof GameService.setWebSocketService === 'function') {
      GameService.setWebSocketService(webSocketService);
      console.log('✅ WebSocket service injected into GameService');
    }

    // 3. Initialize payment methods
    console.log('💰 Initializing payment methods...');
    await WalletService.initializePaymentMethods();
    console.log('✅ Payment methods initialized successfully');

    // 4. Initialize auto-game service
    console.log('🎮 Initializing auto-game service...');
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      GameService.startAutoGameService();
      console.log('✅ Auto-game service initialized successfully');
    } else {
      console.warn('⚠️ GameService.startAutoGameService is not available');
    }

    // 5. Initialize Telegram bot (async but don't wait for it)
    console.log('🤖 Initializing Telegram bot...');
    initializeBot().then(controller => {
      if (controller) {
        console.log('✅ Telegram bot initialized successfully');
      } else {
        console.warn('⚠️ Telegram bot not initialized (check BOT_TOKEN in .env)');
      }
    }).catch(error => {
      console.error('❌ Telegram bot initialization failed:', error);
    });

    servicesInitialized = true;
    console.log('🎉 All services initialized successfully!');
    
  } catch (error) {
    console.error('❌ Failed to initialize services:', error);
    console.error('Error details:', error.message);
    
    // Schedule retry
    setTimeout(() => {
      console.log('🔄 Retrying services initialization...');
      initializeServices();
    }, 10000);
  }
};

// ✅ FIXED: Enhanced health check with bot status verification
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

    // Check bot status with verification
    let botStatus = '❌ Not running';
    if (botController) {
      botStatus = botController.isRunning ? '✅ Running' : '❌ Not running';
    }

    const webSocketStatus = webSocketService ? '✅ Running' : '❌ Not running';
    const activeConnections = webSocketService ? webSocketService.getConnectionCount() : 0;

    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
      wallet: {
        totalWallets,
        pendingDeposits
      },
      telegramBot: {
        status: botStatus,
        instance: botController ? 'Initialized' : 'Not initialized',
        attempts: botInitializationAttempts,
        adminIds: AdminUtils.getAdminIds()
      },
      webSocket: {
        status: webSocketStatus,
        activeConnections,
        gameRooms: webSocketService ? webSocketService.getGameRoomCount() : 0
      },
      servicesInitialized,
      uptime: process.uptime(),
      cors: {
        allowedOrigins: corsOptions.origin
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

    const webSocketStats = webSocketService ? {
      activeConnections: webSocketService.getConnectionCount(),
      gameRooms: webSocketService.getGameRoomCount(),
      messagesSent: webSocketService.getMessagesSent(),
      messagesReceived: webSocketService.getMessagesReceived()
    } : null;

    // Bot status with details
    let botDetails = { status: 'Not running' };
    if (botController) {
      botDetails = {
        status: botController.isRunning ? 'Running' : 'Not running',
        isRunning: botController.isRunning,
        adminCount: AdminUtils.getAdminCount(),
        initialized: true
      };
    }

    res.json({
      status: 'OK',
      system: 'Bingo Admin Dashboard',
      timestamp: new Date().toISOString(),
      stats,
      telegramBot: botDetails,
      webSocket: webSocketStats,
      servicesInitialized,
      botInitializationAttempts
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
  let botStatus = '❌ Not running';
  if (botController) {
    botStatus = botController.isRunning ? '✅ Running' : '❌ Not running';
  }
  
  const webSocketStatus = webSocketService ? '✅ Running' : '❌ Not running';
  
  res.json({
    message: 'Bingo API Server with Wallet System',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    status: {
      telegramBot: botStatus,
      webSocket: webSocketStatus,
      walletSystem: '✅ Enabled',
      gameService: '✅ Active',
      servicesInitialized
    },
    features: [
      'Telegram Authentication',
      'Real-time Bingo Games',
      'WebSocket Support',
      'Wallet System with Ethiopian Payments',
      'Admin Dashboard'
    ],
    frontend: 'https://desta.et',
    webSocketInfo: {
      enabled: true,
      endpoint: '/ws/game',
      supportedEvents: [
        'TAKEN_CARDS_UPDATE',
        'GAME_STATUS_UPDATE',
        'NUMBER_CALLED',
        'BINGO_CLAIMED'
      ]
    },
    endpoints: {
      root: '/',
      health: '/health',
      wsInfo: '/ws/info',
      auth: '/api/auth/telegram',
      games: '/api/games/*',
      wallet: '/api/wallet/*',
      admin: '/api/admin/*'
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
      wsInfo: '/ws/info',
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

  if (err.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'Duplicate entry found'
    });
  }

  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors
    });
  }

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

// ✅ ADD: Scheduled bot health check
cron.schedule('*/5 * * * *', () => {
  console.log('🩺 Running scheduled bot health check...');
  checkBotHealth();
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

// WebSocket connection cleanup every hour
cron.schedule('0 * * * *', () => {
  if (webSocketService && typeof webSocketService.cleanupStaleConnections === 'function') {
    console.log('🧹 Cleaning up stale WebSocket connections...');
    const cleaned = webSocketService.cleanupStaleConnections();
    console.log(`✅ Cleaned up ${cleaned} stale connections`);
  }
});

// ✅ ADD: Service restart scheduler (in case of failures)
cron.schedule('0 */6 * * *', () => {
  console.log('🔄 Running scheduled services health check...');
  if (!servicesInitialized) {
    console.log('🔄 Services not initialized, attempting restart...');
    initializeServices();
  }
  
  // Check bot status
  if (!botController || !botController.isRunning) {
    console.log('🤖 Bot not running, attempting restart...');
    initializeBot();
  }
});

const PORT = process.env.PORT || 3000;

// Start server and THEN initialize services
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`💰 Wallet System: Enabled`);
  console.log(`🔗 WebSocket: Enabled`);
  console.log(`🤖 Telegram Bot: ${process.env.BOT_TOKEN ? 'Enabled' : 'Disabled'}`);
  console.log(`👑 Admin IDs: ${AdminUtils.getAdminList() || 'Not set'}`);
  console.log(`🌐 CORS enabled for:`);
  console.log(`   - https://bingominiapp.vercel.app (Production)`);
  console.log(`   - http://localhost:3001 (Development)`);
  console.log(`   - http://localhost:3000 (Development)`);
  console.log(`   - WebSocket support enabled`);

  // Initialize services after server is running
  console.log('🔄 Initializing services...');
  initializeServices();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down gracefully...');
  
  servicesInitialized = false;

  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
  }

  // Clean up WebSocket connections
  if (webSocketService && typeof webSocketService.closeAllConnections === 'function') {
    console.log('🔌 Closing all WebSocket connections...');
    webSocketService.closeAllConnections();
    console.log('✅ All WebSocket connections closed');
  }

  // Stop bot if running
  if (botController && botController.bot) {
    try {
      botController.stop('SIGINT');
      console.log('✅ Telegram bot stopped');
    } catch (error) {
      console.error('❌ Error stopping bot:', error);
    }
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
  
  servicesInitialized = false;

  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
  }

  // Clean up WebSocket connections
  if (webSocketService && typeof webSocketService.closeAllConnections === 'function') {
    console.log('🔌 Closing all WebSocket connections...');
    webSocketService.closeAllConnections();
    console.log('✅ All WebSocket connections closed');
  }

  // Stop bot if running
  if (botController && botController.bot) {
    try {
      botController.stop('SIGTERM');
      console.log('✅ Telegram bot stopped');
    } catch (error) {
      console.error('❌ Error stopping bot:', error);
    }
  }

  // Close MongoDB connection
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// ✅ ADD: Process error handlers to restart bot on crash
process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception:', error);
  console.error('Error stack:', error.stack);
  
  // Don't exit, but restart bot if it's a bot error
  if (error.message.includes('bot') || error.message.includes('telegram')) {
    console.log('🔄 Bot crashed, attempting restart...');
    setTimeout(() => {
      initializeBot();
    }, 5000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
  
  // Restart bot if it's related to bot operations
  if (reason.message && (reason.message.includes('bot') || reason.message.includes('telegram'))) {
    console.log('🔄 Bot promise rejection, attempting restart...');
    setTimeout(() => {
      initializeBot();
    }, 5000);
  }
});

// Export for use in other files
module.exports = { app, server, webSocketService };