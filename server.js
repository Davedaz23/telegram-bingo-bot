// src/app.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');
const walletRoutes = require('./src/routes/wallet'); // ADD THIS
const BotController = require('./src/controllers/botController');

// Import GameService - make sure the path is correct
const GameService = require('./src/services/gameService');

const app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ ADD THIS: Initialize and launch the bot
let botController;
try {
  if (process.env.BOT_TOKEN) {
    botController = new BotController(process.env.BOT_TOKEN);
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
app.use(express.json({ limit: '10mb' })); // ADD limit for receipt images
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/wallet', walletRoutes); // ADD THIS

// ✅ MODIFIED: Initialize auto-game service AFTER server starts
const initializeGameService = () => {
  try {
    // Check if GameService and the method exist
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      GameService.startAutoGameService();
      console.log('🎮 Auto-game service initialized successfully');
    } else {
      console.error('❌ GameService.startAutoGameService is not available');
    }
  } catch (error) {
    console.error('❌ Failed to initialize auto-game service:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
  }
};

// Health check - ENHANCED with wallet status
app.get('/health', async (req, res) => {
  try {
    // Simple MongoDB health check
    await mongoose.connection.db.admin().ping();
    
    // Check if wallet models are available
    const walletModels = {
      Wallet: mongoose.models.Wallet !== undefined,
      Transaction: mongoose.models.Transaction !== undefined
    };
    
    res.json({ 
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
      walletSystem: walletModels,
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

// Root route - UPDATED with wallet info
app.get('/', (req, res) => {
  res.json({
    message: 'Bingo API Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    features: {
      authentication: true,
      games: true,
      wallet: true, // ADD THIS
      telegramBot: !!process.env.BOT_TOKEN
    },
    frontend: 'https://bingominiapp.vercel.app',
    endpoints: {
      auth: '/api/auth/telegram',
      games: '/api/games',
      wallet: '/api/wallet', // ADD THIS
      health: '/health'
    }
  });
});

// 404 handler - UPDATED with wallet endpoints
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableEndpoints: {
      root: '/',
      health: '/health',
      auth: '/api/auth/telegram',
      games: '/api/games/*',
      wallet: '/api/wallet/*' // ADD THIS
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
  
  // Wallet-specific errors
  if (err.message.includes('balance') || err.message.includes('wallet')) {
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

// Start server and THEN initialize game service
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`CORS enabled for:`);
  console.log(`- https://bingominiapp.vercel.app (Production)`);
  console.log(`- http://localhost:3001 (Development)`);
  console.log(`- http://localhost:3000 (Development)`);
  console.log(`💰 Wallet system: ENABLED`); // ADD THIS
  
  // Initialize game service after server is running
  setTimeout(() => {
    console.log('🔄 Initializing game service...');
    initializeGameService();
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down gracefully...');
  
  // Clean up game service intervals
  if (GameService && typeof GameService.cleanupAllIntervals === 'function') {
    GameService.cleanupAllIntervals();
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
  
  // Close MongoDB connection
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

module.exports = app;