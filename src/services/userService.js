// services/userService.js
const User = require('../models/User');

class UserService {
  static async findOrCreateUser(telegramUser) {
    try {
      const { id, username, first_name, last_name, language_code, is_bot } = telegramUser;

      console.log('🔍 Looking for user with telegramId:', id.toString());
      
      let user = await User.findOne({ telegramId: id.toString() });

      if (!user) {
        console.log('👤 Creating new user...');
        user = await User.create({
          telegramId: id.toString(),
          username: username || `user_${id}`,
          firstName: first_name || 'Anonymous',
          lastName: last_name || '',
          languageCode: language_code || 'en',
          isBot: is_bot || false,
          gamesPlayed: 0,
          gamesWon: 0,
          totalScore: 0,
          walletBalance: 100, // Starting balance
          isActive: true
        });
        console.log('✅ New user created:', user.telegramId);
      } else {
        console.log('✅ Existing user found:', user.telegramId);
      }

      return user;
    } catch (error) {
      console.error('❌ Error in findOrCreateUser:', error);
      throw error;
    }
  }

  static async getUserByTelegramId(telegramId) {
    try {
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

  static async createUserIfNotExists(telegramId, userData = {}) {
    try {
      console.log(`🔍 Checking if user exists: ${telegramId}`);
      
      let user = await User.findOne({ telegramId: telegramId.toString() });

      if (!user) {
        console.log(`👤 Creating new user for Telegram ID: ${telegramId}`);
        
        const defaultUserData = {
          telegramId: telegramId.toString(),
          username: userData.username || `user_${telegramId}`,
          firstName: userData.first_name || userData.firstName || 'Anonymous',
          lastName: userData.last_name || userData.lastName || '',
          languageCode: userData.language_code || userData.languageCode || 'en',
          isBot: userData.is_bot || userData.isBot || false,
          gamesPlayed: 0,
          gamesWon: 0,
          totalScore: 0,
          walletBalance: 100, // Starting balance
          isActive: true
        };

        user = await User.create(defaultUserData);
        console.log(`✅ New user created: ${user.telegramId}`);
      } else {
        console.log(`✅ User already exists: ${user.telegramId}`);
      }

      return user;
    } catch (error) {
      console.error('❌ Error in createUserIfNotExists:', error);
      throw error;
    }
  }

  static async getUserStats(telegramId) {
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
    return await User.findOne({ telegramId: telegramId.toString() });
  }

  static async getWalletBalance(telegramId) {
    const user = await User.findOne({ telegramId: telegramId.toString() })
      .select('walletBalance telegramId username');
    
    if (!user) {
      throw new Error(`User not found for Telegram ID: ${telegramId}`);
    }

    return user.walletBalance;
  }
}

module.exports = UserService;