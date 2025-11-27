// services/userService.js - UPDATED VERSION
const User = require('../models/User');

class UserService {
  static async findOrCreateUser(telegramUser) {
    try {
      // Validate that we have a real Telegram user with required fields
      if (!telegramUser || !telegramUser.id || !telegramUser.first_name) {
        console.error('❌ Invalid Telegram user data:', telegramUser);
        throw new Error('Invalid Telegram user data: id and first_name are required');
      }

      const { id, username, first_name, last_name, language_code, is_bot } = telegramUser;

      console.log('🔍 Looking for user with telegramId:', id.toString());
      
      let user = await User.findOne({ telegramId: id.toString() });

      if (!user) {
        console.log('👤 Creating new user from real Telegram data...');
        user = await User.create({
          telegramId: id.toString(),
          username: username || `user_${id}`,
          firstName: first_name,
          lastName: last_name || '',
          languageCode: language_code || 'en',
          isBot: is_bot || false,
          gamesPlayed: 0,
          gamesWon: 0,
          totalScore: 0,
          walletBalance: 100,
          isActive: true
        });
        console.log('✅ New user created from Telegram:', {
          telegramId: user.telegramId,
          username: user.username,
          firstName: user.firstName
        });
      } else {
        console.log('✅ Existing user found:', {
          telegramId: user.telegramId,
          username: user.username
        });
      }

      return user;
    } catch (error) {
      console.error('❌ Error in findOrCreateUser:', error);
      throw error;
    }
  }

  static async getUserByTelegramId(telegramId) {
    try {
      // Validate telegramId format (should be numeric)
      if (!telegramId || !telegramId.toString().match(/^\d+$/)) {
        console.error(`❌ Invalid Telegram ID format: ${telegramId}`);
        return null;
      }

      const user = await User.findOne({ telegramId: telegramId.toString() });
      
      if (!user) {
        console.log(`❌ User not found for Telegram ID: ${telegramId}`);
        return null;
      }
      
      return user;
    } catch (error) {
      console.error('❌ Error in getUserByTelegramId:', error);
      throw error;
    }
  }

  // REMOVED: createUserIfNotExists method to prevent anonymous user creation
  // Only real Telegram users should be created via findOrCreateUser

  static async getUserStats(telegramId) {
    // Validate telegramId format
    if (!telegramId || !telegramId.toString().match(/^\d+$/)) {
      throw new Error('Invalid Telegram ID format');
    }

    const user = await User.findOne({ telegramId: telegramId.toString() })
      .select('username firstName gamesPlayed gamesWon totalScore createdAt');

    return user;
  }

  static async updateUserStats(userId, won = false) {
    const updateData = {
      $inc: { gamesPlayed: 1 }
    };

    if (won) {
      updateData.$inc.gamesWon = 1;
      updateData.$inc.totalScore = 10;
    }

    return await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true }
    );
  }

  static async findByTelegramId(telegramId) {
    // Validate telegramId format
    if (!telegramId || !telegramId.toString().match(/^\d+$/)) {
      console.error(`❌ Invalid Telegram ID format: ${telegramId}`);
      return null;
    }

    return await User.findOne({ telegramId: telegramId.toString() });
  }

  static async getWalletBalance(telegramId) {
    // Validate telegramId format
    if (!telegramId || !telegramId.toString().match(/^\d+$/)) {
      throw new Error('Invalid Telegram ID format. Must be numeric.');
    }

    const user = await User.findOne({ telegramId: telegramId.toString() })
      .select('walletBalance telegramId username');
    
    if (!user) {
      throw new Error(`User not found for Telegram ID: ${telegramId}`);
    }

    return user.walletBalance;
  }

  // New method to validate if a user exists (without creating)
  static async validateUserExists(telegramId) {
    if (!telegramId || !telegramId.toString().match(/^\d+$/)) {
      return false;
    }

    const user = await User.findOne({ telegramId: telegramId.toString() });
    return !!user;
  }
}

module.exports = UserService;