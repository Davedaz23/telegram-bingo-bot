// services/walletService.js - UPDATED WITH PROPER ID HANDLING
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User'); // ADD THIS

class WalletService {
  
  // NEW: Helper function to convert Telegram ID to MongoDB ObjectId
  static async resolveUserId(userId) {
    try {
      // If it's already a valid MongoDB ObjectId, return it
      if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
        return userId;
      }
      
      // Otherwise, treat it as a Telegram ID and find the corresponding MongoDB user
      const user = await User.findOne({ telegramId: userId.toString() });
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${userId}`);
      }
      
      console.log(`🔄 Resolved Telegram ID ${userId} to MongoDB ID ${user._id}`);
      return user._id;
      
    } catch (error) {
      console.error('❌ Error resolving user ID:', error);
      throw error;
    }
  }

  static async initializeWallet(userId) {
    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      let wallet = await Wallet.findOne({ userId: mongoUserId });
      
      if (!wallet) {
        wallet = new Wallet({
          userId: mongoUserId,
          balance: 0,
          currency: 'USD'
        });
        await wallet.save();
        console.log(`💰 Wallet initialized for user ${mongoUserId}`);
      }
      
      return wallet;
    } catch (error) {
      console.error('❌ Error initializing wallet:', error);
      throw error;
    }
  }

  static async getWallet(userId) {
    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      let wallet = await Wallet.findOne({ userId: mongoUserId });
      
      if (!wallet) {
        wallet = await this.initializeWallet(mongoUserId);
      }
      
      return wallet;
    } catch (error) {
      console.error('❌ Error getting wallet:', error);
      throw error;
    }
  }

  static async getBalance(userId) {
    try {
      const wallet = await this.getWallet(userId);
      return wallet.balance;
    } catch (error) {
      console.error('❌ Error getting balance:', error);
      throw error;
    }
  }

  static async createDepositRequest(userId, amount, receiptImage, reference, description = 'Bank deposit') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      const wallet = await this.getWallet(mongoUserId);
      
      // Create pending deposit transaction
      const transaction = new Transaction({
        userId: mongoUserId, // Use resolved MongoDB ID
        type: 'DEPOSIT',
        amount,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance, // Will be updated when approved
        status: 'PENDING',
        description,
        receiptImage,
        reference,
        metadata: {
          approvedBy: null,
          approvedAt: null
        }
      });

      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`📥 Deposit request created for user ${mongoUserId}: $${amount}`);

      return transaction;
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error creating deposit request:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async approveDeposit(transactionId, approvedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transaction = await Transaction.findById(transactionId).session(session);
      
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status !== 'PENDING') {
        throw new Error('Transaction already processed');
      }

      if (transaction.type !== 'DEPOSIT') {
        throw new Error('Only deposit transactions can be approved');
      }

      const wallet = await Wallet.findOne({ userId: transaction.userId }).session(session);
      
      // Update wallet balance
      wallet.balance += transaction.amount;
      
      // Update transaction
      transaction.balanceAfter = wallet.balance;
      transaction.status = 'COMPLETED';
      transaction.metadata.approvedBy = approvedBy;
      transaction.metadata.approvedAt = new Date();

      await wallet.save({ session });
      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`✅ Deposit approved for user ${transaction.userId}: $${transaction.amount}. New balance: $${wallet.balance}`);

      return { wallet, transaction };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error approving deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deductGameEntry(userId, gameId, entryFee, description = 'Game entry fee') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (wallet.balance < entryFee) {
        throw new Error('Insufficient balance for game entry');
      }

      // Deduct entry fee
      const balanceBefore = wallet.balance;
      wallet.balance -= entryFee;
      const balanceAfter = wallet.balance;

      // Create transaction record
      const transaction = new Transaction({
        userId: mongoUserId, // Use resolved MongoDB ID
        type: 'GAME_ENTRY',
        amount: -entryFee, // Negative for deduction
        balanceBefore,
        balanceAfter,
        status: 'COMPLETED',
        description,
        gameId
      });

      await wallet.save({ session });
      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`🎮 Game entry fee deducted for user ${mongoUserId}: $${entryFee}. New balance: $${balanceAfter}`);

      return { wallet, transaction };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error deducting game entry:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async addWinning(userId, gameId, amount, description = 'Game winning') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;

      // Create transaction record
      const transaction = new Transaction({
        userId: mongoUserId, // Use resolved MongoDB ID
        type: 'WINNING',
        amount,
        balanceBefore,
        balanceAfter,
        status: 'COMPLETED',
        description,
        gameId
      });

      await wallet.save({ session });
      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`🏆 Winning added for user ${mongoUserId}: $${amount}. New balance: $${balanceAfter}`);

      return { wallet, transaction };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error adding winning:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getTransactionHistory(userId, limit = 10, page = 1) {
    try {
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      
      const skip = (page - 1) * limit;
      
      const transactions = await Transaction.find({ userId: mongoUserId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('gameId', 'code');
      
      const total = await Transaction.countDocuments({ userId: mongoUserId });
      
      return {
        transactions,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('❌ Error getting transaction history:', error);
      throw error;
    }
  }

  static async getPendingDeposits() {
    try {
      return await Transaction.find({
        type: 'DEPOSIT',
        status: 'PENDING'
      })
      .populate('userId', 'username firstName email')
      .sort({ createdAt: 1 });
    } catch (error) {
      console.error('❌ Error getting pending deposits:', error);
      throw error;
    }
  }

  // NEW: Get wallet by Telegram ID (convenience method)
  static async getWalletByTelegramId(telegramId) {
    try {
      const user = await User.findOne({ telegramId: telegramId.toString() });
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${telegramId}`);
      }
      
      return await this.getWallet(user._id);
    } catch (error) {
      console.error('❌ Error getting wallet by Telegram ID:', error);
      throw error;
    }
  }

  // NEW: Get balance by Telegram ID (convenience method)
  static async getBalanceByTelegramId(telegramId) {
    try {
      const user = await User.findOne({ telegramId: telegramId.toString() });
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${telegramId}`);
      }
      
      return await this.getBalance(user._id);
    } catch (error) {
      console.error('❌ Error getting balance by Telegram ID:', error);
      throw error;
    }
  }
}

module.exports = WalletService;