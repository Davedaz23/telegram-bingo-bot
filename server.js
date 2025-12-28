// src/app.js - UPDATED VERSION WITH CRITICAL FIXES
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
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

// ==================== CRITICAL FIX 1: SERVER TIMEOUT CONFIG ====================
// Set timeout BEFORE any middleware
app.use((req, res, next) => {
  // Prevent hanging requests
  req.setTimeout(15000); // 15 seconds
  res.setTimeout(15000);
  next();
});

// ==================== CRITICAL FIX 2: SECURITY & PERFORMANCE MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// ==================== CRITICAL FIX 3: RATE LIMITING ====================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // Limit each IP to 150 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});

// Apply rate limiting to API routes
app.use('/api', apiLimiter);

// ==================== CRITICAL FIX 4: OPTIMIZED CORS ====================
app.use(cors({
  origin: [
    'https://bingominiapp.vercel.app',
    'http://localhost:3001',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400 // 24 hours cache
}));

// ==================== CRITICAL FIX 5: OPTIMIZED BODY PARSING ====================
app.use(express.json({ 
  limit: '2mb', // Reduced from 10mb
  verify: (req, res, buf, encoding) => {
    // Quick JSON validation to prevent malformed requests
    if (buf && buf.length > 0) {
      try {
        JSON.parse(buf.toString());
      } catch(e) {
        res.status(400).json({ 
          success: false, 
          error: 'Invalid JSON payload' 
        });
        throw new Error('Invalid JSON');
      }
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '2mb',
  parameterLimit: 100
}));

// Static files with cache
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  etag: true
}));

// ==================== CRITICAL FIX 6: REQUEST TIMEOUT HANDLER ====================
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      console.warn(`⏰ Request timeout: ${req.method} ${req.originalUrl}`);
      res.status(504).json({
        success: false,
        error: 'Request timeout',
        message: 'Server took too long to respond'
      });
    }
  }, 20000); // 20 seconds max
  
  // Clean up timeout
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  
  next();
});

// ==================== CRITICAL FIX 7: OPTIMIZED MONGODB CONNECTION ====================
// Use database.js instead of direct mongoose.connect
const database = require('./src/config/database');

// Initialize database connection
database.connect().then(() => {
  console.log('✅ Database service initialized');
}).catch(err => {
  console.error('❌ Database initialization failed:', err.message);
});

// ✅ FIXED: Simplified bot initialization with singleton pattern
let botController = null;
let servicesInitialized = false; // Add flag to track initialization

const AdminUtils = {
  adminIds: [],
  
  initialize() {
    // Get admin IDs from environment variables
    // Support both ADMIN_TELEGRAM_ID (single) and ADMIN_TELEGRAM_IDS (multiple)
    const singleAdmin = process.env.ADMIN_TELEGRAM_ID || '';
    const multipleAdmins = process.env.ADMIN_TELEGRAM_IDS || '';
    
    // Combine both - remove empty strings and duplicates
    let allAdmins = [];
    
    if (singleAdmin) {
      allAdmins.push(singleAdmin.trim());
    }
    
    if (multipleAdmins) {
      const ids = multipleAdmins.split(',').map(id => id.trim()).filter(id => id);
      allAdmins = [...allAdmins, ...ids];
    }
    
    // Remove duplicates
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

const initializeBot = () => {
  try {
    if (!process.env.BOT_TOKEN) {
      console.warn('⚠️ BOT_TOKEN not found - Telegram bot disabled');
      return null;
    }

    console.log('🤖 Initializing Telegram bot...');
    
    // Initialize AdminUtils first
    AdminUtils.initialize();
    
    // Use the BotController - it will use AdminUtils internally
    const BotController = require('./src/controllers/botController');
    botController = new BotController(
      process.env.BOT_TOKEN,
      process.env.ADMIN_TELEGRAM_ID || '' // Keep for backward compatibility
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

// ==================== CRITICAL FIX 8: OPTIMIZED SERVICE INITIALIZATION ====================
const initializeServices = async () => {
  // Check if services are already initialized
  if (servicesInitialized) {
    console.log('✅ Services already initialized, skipping...');
    return;
  }

  try {
    console.log('🔄 Initializing all services...');
    
    // 1. Initialize payment methods (lightweight, do first)
    console.log('💰 Initializing payment methods...');
    try {
      await WalletService.initializePaymentMethods();
      console.log('✅ Payment methods initialized successfully');
    } catch (error) {
      console.warn('⚠️ Payment methods initialization warning:', error.message);
    }

    // 2. Wait for database to be ready
    console.log('⏳ Waiting for database connection...');
    let dbReady = false;
    for (let i = 0; i < 30; i++) { // 30 second timeout
      const health = await database.healthCheck();
      if (health.connected) {
        dbReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (!dbReady) {
      console.warn('⚠️ Database not ready, continuing with limited functionality');
    } else {
      console.log('✅ Database ready for service initialization');
    }

    // 3. Initialize auto-game service with reduced polling
    console.log('🎮 Initializing auto-game service...');
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      // Modified GameService to use optimized polling
      if (typeof GameService.startOptimizedService === 'function') {
        GameService.startOptimizedService(); // Use optimized version
        console.log('✅ Auto-game service initialized with optimized polling');
      } else {
        GameService.startAutoGameService();
        console.log('✅ Auto-game service initialized (standard mode)');
      }
    } else {
      console.error('❌ GameService.startAutoGameService is not available');
    }

    // 4. Initialize Telegram bot last (heaviest)
    console.log('🤖 Initializing Telegram bot...');
    botController = initializeBot();
    
    if (botController) {
      console.log('✅ Telegram bot initialized successfully');
    } else {
      console.warn('⚠️ Telegram bot not initialized (check BOT_TOKEN in .env)');
    }

    servicesInitialized = true;
    console.log('🎉 All services initialized successfully!');
    
  } catch (error) {
    console.error('❌ Failed to initialize services:', error.message);
    console.error('Error stack:', error.stack);
    servicesInitialized = false;
  }
};

// ==================== CRITICAL FIX 9: OPTIMIZED HEALTH CHECK ====================
app.get('/health', async (req, res) => {
  try {
    // Fast health check with timeout
    const healthCheckPromise = (async () => {
      const dbHealth = await database.healthCheck();
      
      // Lightweight checks - don't query collections unless necessary
      let walletStats = { totalWallets: 0, pendingDeposits: 0 };
      
      if (dbHealth.connected) {
        try {
          const Wallet = require('./src/models/Wallet');
          const Transaction = require('./src/models/Transaction');
          
          // Use estimatedDocumentCount for faster counting
          walletStats.totalWallets = await Wallet.estimatedDocumentCount();
          walletStats.pendingDeposits = await Transaction.countDocuments({
            type: 'DEPOSIT',
            status: 'PENDING'
          }).maxTimeMS(3000); // 3 second timeout
        } catch (dbError) {
          console.warn('Health check DB query warning:', dbError.message);
        }
      }

      return {
        status: dbHealth.connected ? 'OK' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        database: dbHealth,
        wallet: walletStats,
        telegramBot: botController ? '✅ Running' : '❌ Not running',
        servicesInitialized,
        uptime: process.uptime(),
        memory: {
          rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`,
          heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`
        }
      };
    })();

    // Add timeout to health check
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Health check timeout')), 5000)
    );

    const result = await Promise.race([healthCheckPromise, timeoutPromise]);
    res.json(result);
    
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: error.message,
      uptime: process.uptime()
    });
  }
});

// Admin health check endpoint
app.get('/admin/health', async (req, res) => {
  try {
    const dbHealth = await database.healthCheck();
    
    if (!dbHealth.connected) {
      return res.status(503).json({
        status: 'ERROR',
        error: 'Database not connected'
      });
    }

    // Use aggregation for faster stats
    const [userCount, walletCount, transactionStats] = await Promise.all([
      require('./src/models/User').estimatedDocumentCount(),
      require('./src/models/Wallet').estimatedDocumentCount(),
      require('./src/models/Transaction').aggregate([
        {
          $facet: {
            total: [{ $count: "count" }],
            pending: [
              { $match: { type: 'DEPOSIT', status: 'PENDING' } },
              { $count: "count" }
            ],
            completed: [
              { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
              { $count: "count" }
            ]
          }
        }
      ])
    ]);

    res.json({
      status: 'OK',
      system: 'Bingo Admin Dashboard',
      timestamp: new Date().toISOString(),
      stats: {
        users: userCount,
        wallets: walletCount,
        totalTransactions: transactionStats[0]?.total[0]?.count || 0,
        pendingDeposits: transactionStats[0]?.pending[0]?.count || 0,
        completedDeposits: transactionStats[0]?.completed[0]?.count || 0
      },
      telegramBot: botController ? 'Running' : 'Not running',
      servicesInitialized
    });
  } catch (error) {
    console.error('Admin health check error:', error);
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// ==================== CRITICAL FIX 10: ADD SYSTEM STATUS ENDPOINT ====================
app.get('/api/status', (req, res) => {
  res.json({
    api: 'online',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`,
      heapTotal: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`,
      heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`
    },
    services: {
      wallet: servicesInitialized ? 'online' : 'offline',
      gameService: servicesInitialized ? 'online' : 'offline',
      telegramBot: botController ? 'online' : 'offline'
    }
  });
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
      gameService: '✅ Active',
      servicesInitialized
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
      health: '/health',
      status: '/api/status'
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
      status: '/api/status',
      auth: '/api/auth/telegram',
      games: '/api/games/*',
      wallet: '/api/wallet/*',
      admin: '/api/admin/*'
    }
  });
});

// ==================== CRITICAL FIX 11: OPTIMIZED ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  
  // Don't log stack trace for timeout errors
  if (!err.message.includes('timeout') && !err.message.includes('Timeout')) {
    console.error('Error Stack:', err.stack);
  }

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

  // Timeout errors
  if (err.message.includes('timeout') || err.message.includes('Timeout')) {
    return res.status(504).json({
      success: false,
      error: 'Request timeout',
      message: 'The server took too long to respond'
    });
  }

  // Wallet service errors
  if (err.message.includes('Wallet') || err.message.includes('balance')) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }

  // Default error
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
  });
});

// ==================== CRITICAL FIX 12: OPTIMIZED CRON JOBS ====================
// Reduce cron frequency and add error handling
cron.schedule('30 * * * *', async () => { // Every hour at minute 30
  console.log('🕐 Running hourly reconciliation check...');
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Reconciliation timeout')), 30000)
    );
    
    await Promise.race([
      ReconciliationService.runDailyReconciliation(),
      timeoutPromise
    ]);
    console.log('✅ Hourly reconciliation completed');
  } catch (error) {
    console.error('❌ Hourly reconciliation failed:', error.message);
  }
});

// Run comprehensive reconciliation at 2 AM (off-peak)
cron.schedule('0 2 * * *', async () => {
  console.log('🌙 Running comprehensive reconciliation...');
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Reconciliation timeout')), 60000)
    );
    
    const result = await Promise.race([
      ReconciliationService.runDailyReconciliation(),
      timeoutPromise
    ]);
    console.log('✅ Midnight reconciliation complete:', result);
  } catch (error) {
    console.error('❌ Midnight reconciliation failed:', error.message);
  }
});

const PORT = process.env.PORT || 3000;

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`💰 Wallet System: Enabled`);
  console.log(`🤖 Telegram Bot: ${process.env.BOT_TOKEN ? 'Enabled' : 'Disabled'}`);
  console.log(`👑 Admin IDs: ${process.env.ADMIN_TELEGRAM_IDS || 'Not set'}`);
  console.log(`🌐 CORS enabled for production frontend`);
  console.log(`⏱️  Request timeout: 15s`);
  console.log(`📊 Rate limiting: 150 requests/15min per IP`);
  
  // Initialize services with delay
  setTimeout(() => {
    console.log('🔄 Starting service initialization in 3 seconds...');
    initializeServices();
  }, 3000);
});

// ==================== CRITICAL FIX 13: SERVER KEEP-ALIVE SETTINGS ====================
// Optimize server for better timeout handling
server.keepAliveTimeout = 60000; // 60 seconds
server.headersTimeout = 65000;   // 65 seconds
server.maxConnections = 1000;

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
  
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('🛑 Server shutting down gracefully...');
  
  servicesInitialized = false;

  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
  }

  // Stop bot if running
  if (botController && botController.bot) {
    botController.bot.stop();
    console.log('✅ Telegram bot stopped');
  }

  // Close database connection
  await database.disconnect();
  console.log('✅ Database connection closed');

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;