const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const UserService = require('../services/userService');
const JWTUtils = require('../utils/jwtUtils');

// Validate Telegram WebApp initData
function validateTelegramInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    
    const hash = urlParams.get('hash');
    const authDate = urlParams.get('auth_date');
    const userJson = urlParams.get('user');
    
    if (!hash || !authDate || !userJson) {
      return { isValid: false, error: 'Missing required parameters' };
    }
    
    const authDateTimestamp = parseInt(authDate) * 1000;
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    if (authDateTimestamp < oneDayAgo) {
      return { isValid: false, error: 'Authentication data expired' };
    }
    
    const userData = JSON.parse(userJson);
    
    return { 
      isValid: true, 
      userData,
      hash,
      authDate 
    };
  } catch (error) {
    return { isValid: false, error: error.message };
  }
}

// Generate Telegram data-check-string for validation
function generateDataCheckString(initData) {
  const urlParams = new URLSearchParams(initData);
  const params = [];
  
  for (const [key, value] of urlParams) {
    if (key !== 'hash') {
      params.push(`${key}=${value}`);
    }
  }
  
  params.sort();
  return params.join('\n');
}

// Validate Telegram hash
function validateTelegramHash(initData, botToken) {
  const dataCheckString = generateDataCheckString(initData);
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  const urlParams = new URLSearchParams(initData);
  const receivedHash = urlParams.get('hash');
  
  return calculatedHash === receivedHash;
}

// Helper function to parse Telegram initData
function parseInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    
    if (userStr) {
      return JSON.parse(userStr);
    }
    
    return null;
  } catch (error) {
    console.error('Error parsing initData:', error);
    return null;
  }
}

// Create test user data for development
function createTestUserData(telegramId) {
  return {
    id: telegramId || Math.floor(Math.random() * 1000000),
    first_name: 'Test User',
    username: 'test_user_' + Math.floor(Math.random() * 1000),
    language_code: 'en',
    is_bot: false
  };
}

// Middleware to validate user exists (without auto-creation)
async function validateUserExists(req, res, next) {
  try {
    const telegramId = req.params.userId || req.params.telegramId || req.query.userId;
    
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    console.log(`🔍 Validating user exists: ${telegramId}`);
    
    const userExists = await UserService.validateUserExists(telegramId);
    
    if (!userExists) {
      return res.status(404).json({
        success: false,
        error: 'User not found. Please authenticate via Telegram first.'
      });
    }

    const user = await UserService.getUserByTelegramId(telegramId);
    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Error in validateUserExists:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Play endpoint - only works with Telegram user data
router.post('/play', async (req, res) => {
  try {
    const { telegramId, initData } = req.body;

    let userData = {};
    let user;

    if (initData && initData !== 'development') {
      // Production: Validate Telegram initData
      const validation = validateTelegramInitData(initData);
      if (!validation.isValid) {
        return res.status(401).json({
          success: false,
          error: `Invalid initData: ${validation.error}`
        });
      }
      
      userData = validation.userData;
      user = await UserService.findOrCreateUser(userData);
    } else {
      // Development: Create test user data
      if (initData === 'development') {
        userData = createTestUserData(telegramId);
        user = await UserService.findOrCreateUser(userData);
      } else {
        // No initData provided and not development mode
        return res.status(400).json({
          success: false,
          error: 'Telegram initData is required for authentication'
        });
      }
    }

    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100
      },
      message: 'User ready to play'
    });

  } catch (error) {
    console.error('❌ Play endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start game: ' + error.message
    });
  }
});

// Telegram WebApp authentication (primary endpoint)
router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    
    let userData;
    
    if (initData === 'development' || !initData) {
      // Development mode
      userData = createTestUserData();
      console.log('🔧 Development mode - using test user:', userData.username);
    } else {
      // Production mode with Telegram validation
      const validation = validateTelegramInitData(initData);
      if (!validation.isValid) {
        return res.status(401).json({
          success: false,
          error: `Invalid initData: ${validation.error}`
        });
      }
      
      // Validate hash if BOT_TOKEN is available
      if (process.env.BOT_TOKEN) {
        const isValidHash = validateTelegramHash(initData, process.env.BOT_TOKEN);
        if (!isValidHash) {
          return res.status(401).json({
            success: false,
            error: 'Invalid Telegram hash'
          });
        }
      } else {
        console.warn('⚠️ BOT_TOKEN not set, skipping hash validation');
      }
      
      userData = validation.userData;
      console.log('🔐 Production auth for:', userData.username || userData.first_name);
    }
    
    const user = await UserService.findOrCreateUser(userData);
    
    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100
      }
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed: ' + error.message
    });
  }
});

// Get user profile - requires existing user
router.get('/profile/:userId', validateUserExists, async (req, res) => {
  try {
    const user = req.user;

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get user profile by telegramId - requires existing user
router.get('/profile/telegram/:telegramId', validateUserExists, async (req, res) => {
  try {
    const user = req.user;

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get user stats - requires existing user
router.get('/stats/:userId', validateUserExists, async (req, res) => {
  try {
    const user = req.user;
    
    const winRate = user.gamesPlayed > 0 ? 
      ((user.gamesWon / user.gamesPlayed) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      stats: {
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        winRate: parseFloat(winRate),
        walletBalance: user.walletBalance || 100
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Quick auth endpoint - now requires Telegram data
router.post('/quick-auth', async (req, res) => {
  try {
    const { telegramId, initData } = req.body;

    if (!telegramId && !initData) {
      return res.status(400).json({
        success: false,
        error: 'Either telegramId with initData or development mode required'
      });
    }

    let userData;
    let user;

    if (initData && initData !== 'development') {
      // Use real Telegram data
      const validation = validateTelegramInitData(initData);
      if (!validation.isValid) {
        return res.status(401).json({
          success: false,
          error: `Invalid initData: ${validation.error}`
        });
      }
      userData = validation.userData;
      user = await UserService.findOrCreateUser(userData);
    } else {
      // Development mode
      userData = createTestUserData(telegramId);
      user = await UserService.findOrCreateUser(userData);
    }

    console.log(`⚡ Quick auth for: ${user.telegramId}`);
    
    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        walletBalance: user.walletBalance || 100
      }
    });

  } catch (error) {
    console.error('❌ Quick auth error:', error);
    res.status(500).json({
      success: false,
      error: 'Quick authentication failed: ' + error.message
    });
  }
});

// Verify endpoint - only with Telegram data
router.post('/verify', async (req, res) => {
  try {
    const { initData } = req.body;
    
    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'No init data provided'
      });
    }

    let userData;

    if (initData === 'development') {
      // Development mode
      userData = createTestUserData();
    } else {
      // Parse and validate initData
      userData = parseInitData(initData);
      
      if (!userData || !userData.id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid init data'
        });
      }
    }

    const user = await UserService.findOrCreateUser(userData);
    
    console.log(`✅ User verified: ${user.telegramId} -> ${user._id}`);

    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100,
        isActive: user.isActive
      }
    });

  } catch (error) {
    console.error('❌ Auth verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed: ' + error.message
    });
  }
});

// Health check for auth service
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Authentication Service',
    status: 'OK',
    timestamp: new Date().toISOString(),
    features: {
      telegramAuth: true,
      jwtTokens: true,
      userManagement: true,
      telegramUserCreation: true,
      quickAuth: true
    }
  });
});

// Get user by Telegram ID (read-only, requires existing user)
router.get('/user/:telegramId', validateUserExists, async (req, res) => {
  try {
    const user = req.user;

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        totalScore: user.totalScore || 0,
        walletBalance: user.walletBalance || 100,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;