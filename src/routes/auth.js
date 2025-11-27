const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const UserService = require('../services/userService');
const JWTUtils = require('../utils/jwtUtils');

// Validate Telegram WebApp initData
function validateTelegramInitData(initData) {
  try {
    const urlParams = new URLSearchParams(initData);
    
    // Extract required parameters
    const hash = urlParams.get('hash');
    const authDate = urlParams.get('auth_date');
    const userJson = urlParams.get('user');
    
    if (!hash || !authDate || !userJson) {
      return { isValid: false, error: 'Missing required parameters' };
    }
    
    // Check if auth_date is not too old (e.g., within 1 day)
    const authDateTimestamp = parseInt(authDate) * 1000;
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    if (authDateTimestamp < oneDayAgo) {
      return { isValid: false, error: 'Authentication data expired' };
    }
    
    // Parse user data
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
  
  // Sort parameters alphabetically
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

// Telegram WebApp authentication
router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    
    let userData;
    
    // Development mode - allow test users
    if (initData === 'development' || !initData) {
      userData = {
        id: Math.floor(Math.random() * 1000000),
        first_name: 'Test User',
        username: 'test_user_' + Math.floor(Math.random() * 1000),
        language_code: 'en',
        is_bot: false
      };
      console.log('🔧 Development mode - using test user:', userData.username);
    } 
    // Production mode - validate Telegram WebApp data
    else {
      // Step 1: Basic validation
      const validation = validateTelegramInitData(initData);
      if (!validation.isValid) {
        return res.status(401).json({
          success: false,
          error: `Invalid initData: ${validation.error}`
        });
      }
      
      // Step 2: Cryptographic validation
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
    
    // Find or create user in database
    const user = await UserService.findOrCreateUser(userData);
    
    // Generate JWT token with user ID from database
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
        gamesPlayed: user.gamesPlayed,
        gamesWon: user.gamesWon,
        totalScore: user.totalScore
      },
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed: ' + error.message
    });
  }
});

// Get user profile
router.get('/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await UserService.findByTelegramId(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        gamesPlayed: user.gamesPlayed,
        gamesWon: user.gamesWon,
        totalScore: user.totalScore,
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

// Get user stats
router.get('/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const stats = await UserService.getUserStats(userId);
    
    res.json({
      success: true,
      stats: {
        gamesPlayed: stats?.gamesPlayed || 0,
        gamesWon: stats?.gamesWon || 0,
        totalScore: stats?.totalScore || 0,
        winRate: stats?.gamesPlayed > 0 ? 
          ((stats.gamesWon / stats.gamesPlayed) * 100).toFixed(1) : 0
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
      userManagement: true
    }
  });
});
router.post('/verify', async (req, res) => {
  try {
    const { initData } = req.body;
    
    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'No init data provided'
      });
    }

    // In a production environment, you should verify the initData signature
    // For now, we'll parse the initData to get user information
    const userData = parseInitData(initData);
    
    if (!userData || !userData.id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid init data'
      });
    }

    // Get or create user in MongoDB
    const user = await UserMappingService.getOrCreateUser(userData);
    
    if (!user) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create user'
      });
    }

    console.log(`✅ User verified: ${user.telegramId} -> ${user._id}`);

    res.json({
      success: true,
      user: {
        _id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
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

module.exports = router;