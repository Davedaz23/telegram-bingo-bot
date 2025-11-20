// services/userService.js
const User = require('../models/User');

class UserService {
  static async findOrCreateUser(telegramUser) {
    try {
      const { id, username, first_name, last_name, language_code, is_bot } = telegramUser;

      console.log('Looking for user with telegramId:', id.toString());
      
      let user = await User.findOne({ telegramId: id.toString() });

      if (!user) {
        console.log('Creating new user...');
        user = await User.create({
          telegramId: id.toString(),
          username: username || null,
          firstName: first_name || null,
          lastName: last_name || null,
          languageCode: language_code || null,
          isBot: is_bot || false,
        });
        console.log('New user created:', user);
      } else {
        console.log('Existing user found:', user);
      }

      return user;
    } catch (error) {
      console.error('Error in findOrCreateUser:', error);
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
}

module.exports = UserService;