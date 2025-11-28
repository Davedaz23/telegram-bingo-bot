// services/walletService.js - FIXED VERSION
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PaymentMethod = require('../models/PaymentMethod');

class WalletService {
  
  // Helper function to convert Telegram ID to MongoDB ObjectId
  static async resolveUserId(userId) {
    try {
      console.log('🔄 Resolving user ID:', userId, 'Type:', typeof userId);
      
      // If it's already a valid MongoDB ObjectId, return it
      if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
        console.log('✅ Input is already MongoDB ObjectId');
        return userId;
      }
      
      // Otherwise, treat it as a Telegram ID and find the corresponding MongoDB user
      console.log('🔍 Looking for user with Telegram ID:', userId.toString());
      const user = await User.findOne({ telegramId: userId.toString() });
      
      if (!user) {
        console.error('❌ User not found for Telegram ID:', userId);
        throw new Error(`User not found for Telegram ID: ${userId}`);
      }
      
      console.log(`✅ Resolved Telegram ID ${userId} to MongoDB ID ${user._id}`);
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
      console.log('🔍 Getting wallet for user:', userId);
      
      // RESOLVE USER ID FIRST
      const mongoUserId = await this.resolveUserId(userId);
      console.log('✅ Resolved to MongoDB ID:', mongoUserId);
      
      let wallet = await Wallet.findOne({ userId: mongoUserId });
      
      if (!wallet) {
        console.log('💰 No wallet found, initializing new one...');
        wallet = await this.initializeWallet(mongoUserId);
      }
      
      console.log('✅ Wallet found/created:', wallet._id);
      return wallet;
    } catch (error) {
      console.error('❌ Error getting wallet:', error);
      throw error;
    }
  }

  static async getBalance(userId) {
    try {
      console.log('💰 Getting balance for user:', userId);
      const wallet = await this.getWallet(userId);
      console.log('✅ Balance retrieved:', wallet.balance);
      return wallet.balance;
    } catch (error) {
      console.error('❌ Error getting balance:', error);
      throw error;
    }
  }

  // NEW: Get wallet by Telegram ID (convenience method)
  static async getWalletByTelegramId(telegramId) {
    try {
      console.log('🔍 Getting wallet by Telegram ID:', telegramId);
      const user = await User.findOne({ telegramId: telegramId.toString() });
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${telegramId}`);
      }
      
      console.log('✅ User found, getting wallet for MongoDB ID:', user._id);
      return await this.getWallet(user._id);
    } catch (error) {
      console.error('❌ Error getting wallet by Telegram ID:', error);
      throw error;
    }
  }

  // NEW: Get balance by Telegram ID (convenience method)
  static async getBalanceByTelegramId(telegramId) {
    try {
      console.log('💰 Getting balance by Telegram ID:', telegramId);
      const user = await User.findOne({ telegramId: telegramId.toString() });
      
      if (!user) {
        throw new Error(`User not found for Telegram ID: ${telegramId}`);
      }
      
      console.log('✅ User found, getting balance for MongoDB ID:', user._id);
      return await this.getBalance(user._id);
    } catch (error) {
      console.error('❌ Error getting balance by Telegram ID:', error);
      throw error;
    }
  }

  // ... [Keep all other methods the same, but make sure they use resolveUserId]

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
      .populate('userId', 'username firstName telegramId')
      .sort({ createdAt: 1 });
    } catch (error) {
      console.error('❌ Error getting pending deposits:', error);
      throw error;
    }
  }

  // NEW: Get user transactions (simple version for bot)
  static async getUserTransactions(userId) {
    try {
      const mongoUserId = await this.resolveUserId(userId);
      
      return await Transaction.find({ userId: mongoUserId })
        .sort({ createdAt: -1 })
        .limit(10);
    } catch (error) {
      console.error('❌ Error getting user transactions:', error);
      throw error;
    }
  }

  // ... [Keep all other methods like initializePaymentMethods, extractAmountFromSMS, etc.]
  static async initializePaymentMethods() {
    const paymentMethods = [
      {
        name: 'CBE Bank',
        type: 'BANK',
        accountName: 'Bingo Game',
        accountNumber: '1000200030004000',
        instructions: 'Send money to CBE account 1000200030004000 via CBE Birr or bank transfer',
        smsFormat: 'You have received|ETB|from|CBE'
      },
      {
        name: 'Awash Bank',
        type: 'BANK', 
        accountName: 'Bingo Game',
        accountNumber: '2000300040005000',
        instructions: 'Send money to Awash Bank account 2000300040005000',
        smsFormat: 'You have received|ETB|from|Awash'
      },
      {
        name: 'Dashen Bank',
        type: 'BANK',
        accountName: 'Bingo Game',
        accountNumber: '3000400050006000',
        instructions: 'Send money to Dashen Bank account 3000400050006000',
        smsFormat: 'You have received|ETB|from|Dashen'
      },
      {
        name: 'CBE Birr',
        type: 'MOBILE_MONEY',
        accountName: 'Bingo Game',
        accountNumber: '0911000000',
        instructions: 'Send money to CBE Birr 0911000000',
        smsFormat: 'You have received|ETB|from|CBEBirr'
      },
      {
        name: 'Telebirr',
        type: 'MOBILE_MONEY',
        accountName: 'Bingo Game',
        accountNumber: '0912000000',
        instructions: 'Send money to Telebirr 0912000000',
        smsFormat: 'You have received|ETB|from|Telebirr'
      }
    ];

    for (const method of paymentMethods) {
      await PaymentMethod.findOneAndUpdate(
        { name: method.name },
        method,
        { upsert: true, new: true }
      );
    }
    console.log('✅ Payment methods initialized');
  }

  static extractAmountFromSMS(smsText, paymentMethod) {
    try {
      const formats = {
        'CBE Bank': /(\d+\.?\d*)\s*ETB/i,
        'Awash Bank': /(\d+\.?\d*)\s*ETB/i,
        'Dashen Bank': /(\d+\.?\d*)\s*ETB/i,
        'CBE Birr': /(\d+\.?\d*)\s*ETB/i,
        'Telebirr': /(\d+\.?\d*)\s*ETB/i
      };

      const regex = formats[paymentMethod] || /(\d+\.?\d*)\s*ETB/i;
      const match = smsText.match(regex);
      
      if (match && match[1]) {
        return parseFloat(match[1]);
      }
      
      // Alternative pattern matching
      const altMatch = smsText.match(/(\d+)\s*birr/i) || smsText.match(/amount[:\s]*(\d+)/i);
      return altMatch ? parseFloat(altMatch[1]) : null;
    } catch (error) {
      console.error('Error extracting amount from SMS:', error);
      return null;
    }
  }

  // Validate SMS format
  static validateSMSFormat(smsText, paymentMethod) {
    const method = paymentMethod.toLowerCase();
    const sms = smsText.toLowerCase();
    
    const validators = {
      'cbe bank': () => sms.includes('cbe') && sms.includes('etb'),
      'awash bank': () => sms.includes('awash') && sms.includes('etb'),
      'dashen bank': () => sms.includes('dashen') && sms.includes('etb'),
      'cbe birr': () => (sms.includes('cbe') || sms.includes('cbebirr')) && sms.includes('etb'),
      'telebirr': () => sms.includes('telebirr') && sms.includes('etb')
    };

    const validator = validators[method];
    return validator ? validator() : false;
  }

  // Create deposit from SMS
  static async createDepositFromSMS(userId, paymentMethodName, smsText) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Resolve user ID
      const mongoUserId = await this.resolveUserId(userId);
      
      // Get payment method
      const paymentMethod = await PaymentMethod.findOne({ 
        name: paymentMethodName, 
        isActive: true 
      });
      
      if (!paymentMethod) {
        throw new Error('Invalid payment method');
      }

      // Validate SMS format
      if (!this.validateSMSFormat(smsText, paymentMethodName)) {
        throw new Error('Invalid SMS format for selected payment method');
      }

      // Extract amount
      const amount = this.extractAmountFromSMS(smsText, paymentMethodName);
      if (!amount || amount <= 0) {
        throw new Error('Could not extract valid amount from SMS');
      }

      const wallet = await this.getWallet(mongoUserId);
      
      // Create pending deposit transaction
      const transaction = new Transaction({
        userId: mongoUserId,
        type: 'DEPOSIT',
        amount,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        status: 'PENDING',
        description: `Deposit via ${paymentMethodName}`,
        receiptImage: null, // No image for SMS
        reference: `SMS-${Date.now()}`,
        metadata: {
          paymentMethod: paymentMethodName,
          smsText: smsText,
          approvedBy: null,
          approvedAt: null,
          extractedAmount: amount
        }
      });

      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`📥 SMS Deposit request created for user ${mongoUserId}: $${amount} via ${paymentMethodName}`);

      return transaction;
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error creating deposit from SMS:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = WalletService;