// src/app.js - UPDATED VERSION
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');
const walletRoutes = require('./src/routes/wallet');

const BotController = require('./src/controllers/botController');
const GameService = require('./src/services/gameService');

const app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ IMPROVED: Bot initialization with conflict handling
let botController;
const initializeBot = () => {
  try {
    if (process.env.BOT_TOKEN) {
      // Check if we're in Render.com or similar environment
      const isRender = process.env.RENDER || process.env.NODE_ENV === 'production';
      
      if (isRender) {
        console.log('🌐 Production environment detected - using webhook mode');
        // In production, we'll set up webhooks instead of polling
        botController = new BotController(process.env.BOT_TOKEN);
        
        // Don't launch immediately in production - set up webhook endpoint first
        app.use('/api/bot', require('./src/routes/bot')(botController));
        
      } else {
        console.log('💻 Development environment - using polling mode');
        botController = new BotController(process.env.BOT_TOKEN);
        botController.launch();
      }
      
      console.log('🤖 Telegram Bot initialized successfully');
    } else {
      console.warn('⚠️ BOT_TOKEN not found - Telegram bot disabled');
    }
  } catch (error) {
    console.error('❌ Failed to initialize Telegram bot:', error.message);
    // Don't crash the server if bot fails
  }
};

// CORS configuration
app.use(cors({
  origin: [
    'https://bingominiapp.vercel.app',
    'http://localhost:3001',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/wallet', walletRoutes);

// Initialize game service
const initializeGameService = () => {
  try {
    if (GameService && typeof GameService.startAutoGameService === 'function') {
      GameService.startAutoGameService();
      console.log('🎮 Auto-game service initialized successfully');
    } else {
      console.error('❌ GameService.startAutoGameService is not available');
    }
  } catch (error) {
    console.error('❌ Failed to initialize auto-game service:', error);
  }
};

// Health check
app.get('/health', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    
    res.json({ 
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
      bot: botController ? (botController.isRunning ? 'Running' : 'Stopped') : 'Disabled',
      uptime: process.uptime()
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

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Bingo API Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    bot: botController ? 'Enabled' : 'Disabled',
    endpoints: {
      auth: '/api/auth/telegram',
      games: '/api/games',
      health: '/health'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  
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
  
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
  });
});

const PORT = process.env.PORT || 3000;

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`🌐 CORS enabled for:`);
  console.log(`- https://bingominiapp.vercel.app (Production)`);
  console.log(`- http://localhost:3001 (Development)`);
  console.log(`- http://localhost:3000 (Development)`);
  
  // Initialize services after server is running
  setTimeout(() => {
    console.log('🔄 Initializing services...');
    initializeBot();
    initializeGameService();
  }, 2000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Server shutting down gracefully...');
  
  // Stop bot
  if (botController) {
    botController.stop();
  }
  
  // Clean up game service
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