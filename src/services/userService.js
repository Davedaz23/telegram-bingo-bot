// services/userService.js - COMPLETE WORKING VERSION
const User = require('../models/User');

class UserService {
  static async findOrCreateUser(telegramUser) {
    try {
      console.log('🔍 Processing Telegram user:', telegramUser);
      
      // Validate that we have a real Telegram user with required fields
      if (!telegramUser || !telegramUser.id) {
        console.error('❌ Invalid Telegram user data:', telegramUser);
        throw new Error('Invalid Telegram user data: id is required');
      }

      const { id, username, first_name, last_name, language_code, is_bot } = telegramUser;

      console.log('🔍 Looking for user with telegramId:', id.toString());
      
      // Try to find existing user
      let user = await User.findOne({ telegramId: id.toString() });

      if (!user) {
        console.log('👤 Creating new user from Telegram data...');
        
        // Create user with minimal required fields
        const userData = {
          telegramId: id.toString(),
          firstName: first_name || 'User',
          username: username || `user_${id}`,
          isBot: is_bot || false,
          isActive: true
        };

        // Add optional fields if they exist
        if (last_name) userData.lastName = last_name;
        if (language_code) userData.languageCode = language_code;

        try {
          user = await User.create(userData);
          console.log('✅ New user created successfully:', {
            telegramId: user.telegramId,
            username: user.username,
            firstName: user.firstName,
            _id: user._id
          });
        } catch (createError) {
          console.error('❌ Error creating user:', createError);
          
          // If creation fails, try to find again (race condition)
          user = await User.findOne({ telegramId: id.toString() });
          if (!user) {
            throw createError;
          }
          console.log('✅ User found after creation failure (race condition)');
        }
      } else {
        console.log('✅ Existing user found:', {
          telegramId: user.telegramId,
          username: user.username,
          _id: user._id
        });
      }

      return user;
    } catch (error) {
      console.error('❌ Error in findOrCreateUser:', error);
      
      // Provide more specific error messages
      if (error.code === 11000) {
        throw new Error('User already exists (duplicate key)');
      } else if (error.name === 'ValidationError') {
        throw new Error(`User validation failed: ${error.message}`);
      } else {
        throw new Error(`Failed to create/find user: ${error.message}`);
      }
    }
  }

  static async getUserByTelegramId(telegramId) {
    try {
      if (!telegramId) {
        console.error('❌ No Telegram ID provided');
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

  static async getUserStats(telegramId) {
    try {
      if (!telegramId) {
        throw new Error('Telegram ID is required');
      }

      const user = await User.findOne({ telegramId: telegramId.toString() })
        .select('username firstName gamesPlayed gamesWon totalScore createdAt');

      if (!user) {
        throw new Error('User not found');
      }

      // Calculate win rate
      const winRate = user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(1) : 0;
      
      return {
        gamesPlayed: user.gamesPlayed || 0,
        gamesWon: user.gamesWon || 0,
        winRate: winRate,
        totalWinnings: user.totalScore || 0,
        recentGames: 'No recent games'
      };
    } catch (error) {
      console.error('Error getting user stats:', error);
      // Return default stats if user not found
      return {
        gamesPlayed: 0,
        gamesWon: 0,
        winRate: 0,
        totalWinnings: 0,
        recentGames: 'No games played yet'
      };
    }
  }

  static async updateUserStats(userId, won = false) {
    try {
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
    } catch (error) {
      console.error('Error updating user stats:', error);
      throw error;
    }
  }

  static async getWalletBalance(telegramId) {
    try {
      if (!telegramId) {
        throw new Error('Telegram ID is required');
      }

      const user = await User.findOne({ telegramId: telegramId.toString() })
        .select('walletBalance telegramId username');
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${telegramId}`);
      }

      return user.walletBalance;
    } catch (error) {
      console.error('Error getting wallet balance: ', error);
      throw error;
    }
  }

  static async validateUserExists(telegramId) {
    try {
      if (!telegramId) {
        return false;
      }

      const user = await User.findOne({ telegramId: telegramId.toString() });
      return !!user;
    } catch (error) {
      console.error('Error validating user existence:', error);
      return false;
    }
  }
}

module.exports = UserService;