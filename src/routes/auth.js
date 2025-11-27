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

// Middleware to ensure user exists
async function ensureUserExists(req, res, next) {
  try {
    const telegramId = req.params.userId || req.params.telegramId || req.query.userId;
    
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    console.log(`🔍 Ensuring user exists: ${telegramId}`);
    
    const user = await UserService.createUserIfNotExists(telegramId);
    
    if (!user) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create user'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Error in ensureUserExists:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Play endpoint - creates user if doesn't exist
router.post('/play', async (req, res) => {
  try {
    const { telegramId, initData } = req.body;

    let userData = {};
    let user;

    if (initData && initData !== 'development') {
      const validation = validateTelegramInitData(initData);
      if (validation.isValid) {
        userData = validation.userData;
        user = await UserService.findOrCreateUser(userData);
      } else {
        user = await UserService.createUserIfNotExists(telegramId);
      }
    } else {
      if (initData === 'development') {
        userData = {
          id: telegramId,
          first_name: 'Test User',
          username: 'test_user_' + Math.floor(Math.random() * 1000),
          language_code: 'en',
          is_bot: false
        };
        user = await UserService.findOrCreateUser(userData);
      } else {
        user = await UserService.createUserIfNotExists(telegramId);
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

// Telegram WebApp authentication
router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    
    let userData;
    
    if (initData === 'development' || !initData) {
      userData = {
        id: Math.floor(Math.random() * 1000000),
        first_name: 'Test User',
        username: 'test_user_' + Math.floor(Math.random() * 1000),
        language_code: 'en',
        is_bot: false
      };
      console.log('🔧 Development mode - using test user:', userData.username);
    } else {
      const validation = validateTelegramInitData(initData);
      if (!validation.isValid) {
        return res.status(401).json({
          success: false,
          error: `Invalid initData: ${validation.error}`
        });
      }
      
      if (!process.env.BOT_TOKEN) {
        console.warn('⚠️ BOT_TOKEN not set, skipping hash validation');
      } else {
        const isValidHash = validateTelegramHash(initData, process.env.BOT_TOKEN);
        if (!isValidHash) {
          return res.status(401).json({
            success: false,
            error: 'Invalid Telegram hash'
          });
        }
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

// Get user profile with auto-creation
router.get('/profile/:userId', ensureUserExists, async (req, res) => {
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

// Get user profile by telegramId with auto-creation
router.get('/profile/telegram/:telegramId', ensureUserExists, async (req, res) => {
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

// Get user stats with auto-creation
router.get('/stats/:userId', ensureUserExists, async (req, res) => {
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

// Quick auth endpoint for frontend
router.post('/quick-auth', async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    console.log(`⚡ Quick auth for: ${telegramId}`);
    
    const user = await UserService.createUserIfNotExists(telegramId);

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

// Verify endpoint
router.post('/verify', async (req, res) => {
  try {
    const { initData } = req.body;
    
    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'No init data provided'
      });
    }

    const userData = parseInitData(initData);
    
    if (!userData || !userData.id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid init data'
      });
    }

    const user = await UserService.findOrCreateUser(userData);
    
    if (!user) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create user'
      });
    }

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
      error: 'Authentication failed'
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
      autoUserCreation: true,
      quickAuth: true
    }
  });
});

// Get user by Telegram ID (legacy support)
router.get('/user/:telegramId', ensureUserExists, async (req, res) => {
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