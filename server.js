// src/app.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/games');

const app = express();

console.log('=== ENVIRONMENT VARIABLES DEBUG ===');
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'EXISTS' : 'MISSING');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? 'EXISTS' : 'MISSING'); 
console.log('WEB_APP_URL:', process.env.WEB_APP_URL ? 'EXISTS' : 'MISSING');
console.log('Total env vars loaded:', Object.keys(process.env).length);
console.log('All env keys:', Object.keys(process.env));
console.log('====================================');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

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
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/games', gameRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    // Simple MongoDB health check
    await mongoose.connection.db.admin().ping();
    
    res.json({ 
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'MongoDB Connected',
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

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Bingo API Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    frontend: 'https://bingominiapp.vercel.app',
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
    error: 'Route not found',
    availableEndpoints: {
      root: '/',
      health: '/health',
      auth: '/api/auth/telegram',
      games: '/api/games/*'
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
  
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`CORS enabled for:`);
  console.log(`- https://bingominiapp.vercel.app (Production)`);
  console.log(`- http://localhost:3001 (Development)`);
  console.log(`- http://localhost:3000 (Development)`);
});

module.exports = app;