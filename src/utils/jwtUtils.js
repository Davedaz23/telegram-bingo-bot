const jwt = require('jsonwebtoken');

class JWTUtils {
  static generateToken(payload) {
    const secret = process.env.JWT_SECRET || 'fallback-secret-key-for-development-only';
    const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
    
    return jwt.sign(payload, secret, {
      expiresIn: expiresIn,
    });
  }

  static verifyToken(token) {
    try {
      const secret = process.env.JWT_SECRET || 'fallback-secret-key-for-development-only';
      return jwt.verify(token, secret);
    } catch (error) {
      console.error('JWT verification error:', error.message);
      return null;
    }
  }

  static generateUserToken(telegramUser) {
    // Handle both development and production user data
    const userId = telegramUser.id || telegramUser._id || Date.now();
    const username = telegramUser.username || telegramUser.first_name || 'user';
    const firstName = telegramUser.first_name || telegramUser.firstName || 'User';
    
    const payload = {
      userId: userId.toString(),
      telegramId: userId.toString(),
      username: username,
      firstName: firstName,
      timestamp: Date.now()
    };
    
    console.log('Generating JWT token for user:', payload);
    
    return this.generateToken(payload);
  }

  // Additional helper method to decode token without verification (for debugging)
  static decodeToken(token) {
    try {
      return jwt.decode(token);
    } catch (error) {
      console.error('JWT decode error:', error.message);
      return null;
    }
  }
}

module.exports = JWTUtils;