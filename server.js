// src/app.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');
const walletRoutes = require('./src/routes/wallet');

const BotController = require('./src/controllers/botController');
// Import WalletService to initialize payment methods
const WalletService = require('./src/services/walletService');
// Import GameService - make sure the path is correct
const GameService = require('./src/services/gameService');

const app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ ADD THIS: Initialize and launch the bot with admin ID
let botController;
try {
  if (process.env.BOT_TOKEN) {
    botController = new BotController(process.env.BOT_TOKEN, process.env.ADMIN_TELEGRAM_ID);
    botController.launch();
    console.log('🤖 Telegram Bot initialized successfully');
  } else {
    console.warn('⚠️ BOT_TOKEN not found - Telegram bot disabled');
  }
} catch (error) {
  console.error('❌ Failed to initialize Telegram bot:', error);
}

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

// ✅ ADD: Admin routes for wallet management
app.use('/api/admin', require('./src/routes/admin'));

// ✅ MODIFIED: Initialize auto-game service AND wallet payment methods
const initializeServices = async () => {
  try {
    // Initialize payment methods
    console.log('💰 Initializing payment methods...');
    await WalletService.initializePaymentMethods();
    console.log('✅ Payment methods initialized successfully');

    // Initialize auto-game service
    console.log('🎮 Initializing auto-game service...');
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      GameService.startAutoGameService();
      console.log('✅ Auto-game service initialized successfully');
    } else {
      console.error('❌ GameService.startAutoGameService is not available');
    }
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
    
    res.json({ 
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
      wallet: {
        totalWallets,
        pendingDeposits
      },
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
      stats
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
  res.json({
    message: 'Bingo API Server with Wallet System',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
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