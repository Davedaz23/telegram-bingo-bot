// services/userMappingService.js
const mongoose = require('mongoose');
const UserMapping = require('../models/UserMapping');
const User = require('../models/User');

class UserMappingService {
  
  // Create or get user mapping
  static async getOrCreateMapping(telegramId, telegramUserData = null) {
    try {
      // Check if mapping already exists
      let mapping = await UserMapping.findOne({ telegramId });
      
      if (mapping) {
        return mapping.mongoUserId;
      }

      // Create new user and mapping
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Create user in MongoDB
        const user = new User({
          username: telegramUserData?.username || `user_${telegramId}`,
          firstName: telegramUserData?.first_name || 'Telegram',
          lastName: telegramUserData?.last_name || 'User',
          telegramId: telegramId,
          isActive: true
        });

        await user.save({ session });

        // Create mapping
        const newMapping = new UserMapping({
          telegramId: telegramId,
          mongoUserId: user._id
        });

        await newMapping.save({ session });
        await session.commitTransaction();

        console.log(`✅ Created user mapping: Telegram ${telegramId} -> MongoDB ${user._id}`);
        return user._id;

      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }

    } catch (error) {
      console.error('❌ Error in getOrCreateMapping:', error);
      throw error;
    }
  }

  // Get MongoDB UserId from Telegram ID
  static async getMongoUserId(telegramId) {
    try {
      const mapping = await UserMapping.findOne({ telegramId });
      return mapping ? mapping.mongoUserId : null;
    } catch (error) {
      console.error('❌ Error getting MongoDB user ID:', error);
      return null;
    }
  }

  // Get Telegram ID from MongoDB UserId
  static async getTelegramId(mongoUserId) {
    try {
      const mapping = await UserMapping.findOne({ mongoUserId });
      return mapping ? mapping.telegramId : null;
    } catch (error) {
      console.error('❌ Error getting Telegram ID:', error);
      return null;
    }
  }

  // Get or create user with full data
  static async getOrCreateUser(telegramUserData) {
    try {
      const { id: telegramId, username, first_name, last_name } = telegramUserData;
      
      const mongoUserId = await this.getOrCreateMapping(telegramId, {
        username,
        first_name,
        last_name
      });

      // Return the full user data
      const user = await User.findById(mongoUserId);
      return user;

    } catch (error) {
      console.error('❌ Error in getOrCreateUser:', error);
      throw error;
    }
  }
}

module.exports = UserMappingService;