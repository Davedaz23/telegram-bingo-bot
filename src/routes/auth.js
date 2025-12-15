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

// Get admin Telegram ID from environment
function getAdminTelegramId() {
  return process.env.ADMIN_TELEGRAM_ID || null;
}

// Get moderator Telegram IDs from environment
function getModeratorTelegramIds() {
  const moderatorIds = process.env.MODERATOR_TELEGRAM_IDS;
  return moderatorIds ? moderatorIds.split(',') : [];
}
// Get admin Telegram IDs from environment (supports multiple admins)
function getAdminTelegramIds() {
  // First check for multiple admins
  const adminIdsEnv = process.env.ADMIN_TELEGRAM_IDS;
  if (adminIdsEnv) {
    return adminIdsEnv.split(',').map(id => id.trim());
  }
  
  // Fallback to single admin for backward compatibility
  const singleAdminId = process.env.ADMIN_TELEGRAM_ID;
  return singleAdminId ? [singleAdminId] : [];
}

// Get moderator Telegram IDs from environment
function getModeratorTelegramIds() {
  const moderatorIds = process.env.MODERATOR_TELEGRAM_IDS;
  return moderatorIds ? moderatorIds.split(',').map(id => id.trim()) : [];
}
// Check and assign user role based on Telegram ID

function assignUserRole(telegramId, userData = {}) {
  // Get admin Telegram IDs from environment
  const adminTelegramIds = getAdminTelegramIds();
  const moderatorTelegramIds = getModeratorTelegramIds();
  
  console.log('👑 Role assignment check:', {
    telegramId,
    adminTelegramIds,
    moderatorTelegramIds,
    existingRole: userData.role
  });

  // If user already has a role, preserve it
  if (userData.role && ['admin', 'moderator'].includes(userData.role)) {
    return userData.role;
  }

  // Check if Telegram ID is in admin list
  if (adminTelegramIds.includes(telegramId)) {
    console.log('✅ Assigning admin role to:', telegramId);
    return 'admin';
  } else if (moderatorTelegramIds.includes(telegramId)) {
    console.log('✅ Assigning moderator role to:', telegramId);
    return 'moderator';
  }

  return 'user';
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

// Middleware to check if user has admin role
async function requireAdmin(req, res, next) {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const user = await UserService.getUserById(userId);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    req.adminUser = user;
    next();
  } catch (error) {
    console.error('❌ Admin check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify admin access'
    });
  }
}

// Middleware to check if user has moderator or admin role
async function requireModerator(req, res, next) {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const user = await UserService.getUserById(userId);
    
    if (!user || !['admin', 'moderator'].includes(user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Moderator or admin access required'
      });
    }

    req.moderatorUser = user;
    next();
  } catch (error) {
    console.error('❌ Moderator check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify moderator access'
    });
  }
}

// Play endpoint - requires Telegram user data
router.post('/play', async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'Telegram initData is required for authentication'
      });
    }

    // Validate Telegram initData
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
    
    const userData = validation.userData;
    const user = await UserService.findOrCreateUser(userData);

    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username,
      role: user.role
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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
    
    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'Telegram initData is required'
      });
    }

    // Validate Telegram initData
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
    
    const userData = validation.userData;
    const user = await UserService.findOrCreateUser(userData);
    
    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username,
      role: user.role
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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
        walletBalance: user.walletBalance || 100,
        role: user.role
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

// Quick auth endpoint - requires Telegram data
router.post('/quick-auth', async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'Telegram initData is required'
      });
    }

    // Validate Telegram initData
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
    }

    const userData = validation.userData;
    const user = await UserService.findOrCreateUser(userData);

    console.log(`⚡ Quick auth for: ${user.telegramId} (Role: ${user.role})`);
    
    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username,
      role: user.role
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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

// Verify endpoint - requires Telegram data
router.post('/verify', async (req, res) => {
  try {
    const { initData } = req.body;
    
    if (!initData) {
      return res.status(400).json({
        success: false,
        error: 'Telegram initData is required'
      });
    }

    // Parse and validate initData
    const userData = parseInitData(initData);
    
    if (!userData || !userData.id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Telegram init data'
      });
    }

    // Validate Telegram hash if BOT_TOKEN is available
    if (process.env.BOT_TOKEN) {
      const isValidHash = validateTelegramHash(initData, process.env.BOT_TOKEN);
      if (!isValidHash) {
        return res.status(401).json({
          success: false,
          error: 'Invalid Telegram hash'
        });
      }
    }

    const user = await UserService.findOrCreateUser(userData);
    
    console.log(`✅ User verified: ${user.telegramId} -> ${user._id} (Role: ${user.role})`);

    const token = JWTUtils.generateUserToken({
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username,
      role: user.role
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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

// ADMIN ROUTES

// Get all users (admin only)
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await UserService.getAllUsers();
    
    const userList = users.map(user => ({
      id: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      totalWinnings: user.totalWinnings,
      walletBalance: user.walletBalance,
      lastLogin: user.lastLogin,
      joinedAt: user.joinedAt,
      isActive: user.isActive
    }));

    res.json({
      success: true,
      users: userList,
      total: users.length,
      admin: req.adminUser.firstName
    });
  } catch (error) {
    console.error('❌ Admin get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get users'
    });
  }
});

// Update user role (admin only)
router.patch('/admin/users/:userId/role', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!['user', 'moderator', 'admin'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Must be: user, moderator, or admin'
      });
    }

    const user = await UserService.updateUserRole(userId, role);
    
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator'
      },
      message: `User role updated to ${role}`,
      updatedBy: req.adminUser.firstName
    });
  } catch (error) {
    console.error('❌ Update user role error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user role'
    });
  }
});

// Get admin dashboard stats (admin only)
router.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const stats = await UserService.getAdminStats();
    
    res.json({
      success: true,
      stats: {
        ...stats,
        admin: req.adminUser.firstName,
        role: req.adminUser.role
      }
    });
  } catch (error) {
    console.error('❌ Admin dashboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get admin stats'
    });
  }
});

// MODERATOR ROUTES

// Get moderation dashboard (moderator and admin)
router.get('/moderator/dashboard', requireModerator, async (req, res) => {
  try {
    const stats = await UserService.getModeratorStats();
    
    res.json({
      success: true,
      stats: {
        ...stats,
        moderator: req.moderatorUser.firstName,
        role: req.moderatorUser.role
      }
    });
  } catch (error) {
    console.error('❌ Moderator dashboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get moderator stats'
    });
  }
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
        role: user.role,
        isAdmin: user.role === 'admin',
        isModerator: user.role === 'moderator',
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
      roleManagement: true,
      adminRoutes: true,
      moderatorRoutes: true,
      quickAuth: true
    },
    roles: {
      admin: getAdminTelegramId() ? 'Configured' : 'Not configured',
      moderators: getModeratorTelegramIds().length > 0 ? 'Configured' : 'Not configured'
    }
  });
});

module.exports = router;