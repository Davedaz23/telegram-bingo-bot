// routes/auth.js
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

router.post('/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    
    let userData;
    
    // Development mode
    if (initData === 'development' || !initData) {
      userData = {
        id: Date.now(),
        first_name: 'Test User',
        username: 'test_user',
        last_name: 'Developer',
        language_code: 'en',
        is_bot: false
      };
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
      const isValidHash = validateTelegramHash(initData, process.env.BOT_TOKEN);
      if (!isValidHash) {
        return res.status(401).json({
          success: false,
          error: 'Invalid Telegram hash'
        });
      }
      
      userData = validation.userData;
    }
    
    console.log('Authenticating user:', userData.username || userData.first_name);
    
    // Find or create user in database
    const user = await UserService.findOrCreateUser(userData);
    
    // Generate JWT token
    const token = JWTUtils.generateUserToken(userData);

    res.json({
      success: true,
      token,
      user: {
        id: user._id ? user._id.toString() : user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
      },
    });
    
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
});

module.exports = router;