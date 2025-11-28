// services/walletService.js - FIXED VERSION
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PaymentMethod = require('../models/PaymentMethod');
const SMSDeposit = require('../models/SMSDeposit');


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
      console.log('🔍 Extracting amount from SMS:', smsText.substring(0, 100));
      
      // Multiple pattern matching for Ethiopian SMS formats
      const patterns = [
        /(\d+\.?\d*)\s*ETB/i,
        /(\d+\.?\d*)\s*Br/i,
        /(\d+\.?\d*)\s*birr/i,
        /amount[:\s]*(\d+\.?\d*)/i,
        /sent\s*(\d+\.?\d*)/i,
        /received\s*(\d+\.?\d*)/i,
        /transfer\s*(\d+\.?\d*)/i
      ];

      let amount = null;
      
      for (const pattern of patterns) {
        const match = smsText.match(pattern);
        if (match && match[1]) {
          amount = parseFloat(match[1]);
          console.log('✅ Amount extracted with pattern:', pattern, amount);
          break;
        }
      }

      // Special handling for CBE Birr format
      if (!amount && paymentMethod === 'CBE Birr') {
        const cbeMatch = smsText.match(/sent\s*(\d+\.?\d*)\.\d*\s*Br/i);
        if (cbeMatch) {
          amount = parseFloat(cbeMatch[1]);
          console.log('✅ CBE Birr amount extracted:', amount);
        }
      }

      return amount;
    } catch (error) {
      console.error('❌ Error extracting amount from SMS:', error);
      return null;
    }
  }

  // Validate SMS format
 static validateSMSFormat(smsText, paymentMethod) {
    const method = paymentMethod.toLowerCase();
    const sms = smsText.toLowerCase();
    
    console.log('🔍 Validating SMS for method:', method);
    
    const validators = {
      'cbe bank': () => (sms.includes('cbe') && (sms.includes('etb') || sms.includes('birr') || sms.includes('br'))) || sms.includes('commercial bank'),
      'awash bank': () => sms.includes('awash') && (sms.includes('etb') || sms.includes('birr') || sms.includes('br')),
      'dashen bank': () => sms.includes('dashen') && (sms.includes('etb') || sms.includes('birr') || sms.includes('br')),
      'cbe birr': () => (sms.includes('cbe') || sms.includes('cbebirr') || sms.includes('commercial bank')) && (sms.includes('birr') || sms.includes('br') || sms.includes('etb')),
      'telebirr': () => sms.includes('telebirr') && (sms.includes('birr') || sms.includes('br') || sms.includes('etb'))
    };

    const validator = validators[method];
    const isValid = validator ? validator() : false;
    
    console.log('✅ SMS validation result:', isValid);
    return isValid;
  }
   // NEW: Process SMS deposit with auto-approval option
  static async processSMSDeposit(userId, paymentMethodName, smsText, autoApprove = false) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Resolve user ID
      const mongoUserId = await this.resolveUserId(userId);
      const user = await User.findById(mongoUserId);
      
      if (!user) {
        throw new Error('User not found');
      }

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

      // Create SMS deposit record
      const smsDeposit = new SMSDeposit({
        userId: mongoUserId,
        telegramId: user.telegramId,
        originalSMS: smsText,
        paymentMethod: paymentMethodName,
        extractedAmount: amount,
        status: 'PENDING',
        metadata: {
          smsLength: smsText.length,
          hasTransactionId: smsText.includes('Txn ID') || smsText.includes('Transaction'),
          hasBalance: smsText.includes('balance') || smsText.includes('Balance')
        }
      });

      let transaction = null;
      let wallet = null;

      // Auto-approve if enabled
      if (autoApprove) {
        wallet = await this.getWallet(mongoUserId);
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;

        // Create completed transaction
        transaction = new Transaction({
          userId: mongoUserId,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter,
          status: 'COMPLETED',
          description: `Auto-approved deposit via ${paymentMethodName}`,
          reference: `SMS-AUTO-${Date.now()}`,
          metadata: {
            paymentMethod: paymentMethodName,
            smsText: smsText.substring(0, 500), // Store first 500 chars
            approvedBy: 'SYSTEM',
            approvedAt: new Date(),
            autoApproved: true,
            smsDepositId: smsDeposit._id
          }
        });

        smsDeposit.status = 'AUTO_APPROVED';
        smsDeposit.transactionId = transaction._id;
        smsDeposit.autoApproved = true;

        await transaction.save({ session });
        await wallet.save({ session });
        
        console.log(`✅ Auto-approved SMS deposit: $${amount} for user ${user.telegramId}`);
      }

      await smsDeposit.save({ session });
      await session.commitTransaction();

      return {
        smsDeposit,
        transaction,
        wallet,
        autoApproved: autoApprove
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // NEW: Manual approval for SMS deposits
  static async approveSMSDeposit(smsDepositId, adminUserId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const smsDeposit = await SMSDeposit.findById(smsDepositId).session(session);
      
      if (!smsDeposit) {
        throw new Error('SMS deposit not found');
      }

      if (smsDeposit.status !== 'PENDING') {
        throw new Error(`SMS deposit already ${smsDeposit.status}`);
      }

      const wallet = await this.getWallet(smsDeposit.userId);
      const balanceBefore = wallet.balance;
      wallet.balance += smsDeposit.extractedAmount;
      const balanceAfter = wallet.balance;

      // Create completed transaction
      const transaction = new Transaction({
        userId: smsDeposit.userId,
        type: 'DEPOSIT',
        amount: smsDeposit.extractedAmount,
        balanceBefore,
        balanceAfter,
        status: 'COMPLETED',
        description: `Approved deposit via ${smsDeposit.paymentMethod}`,
        reference: `SMS-APPROVED-${Date.now()}`,
        metadata: {
          paymentMethod: smsDeposit.paymentMethod,
          smsText: smsDeposit.originalSMS.substring(0, 500),
          approvedBy: adminUserId,
          approvedAt: new Date(),
          smsDepositId: smsDeposit._id
        }
      });

      // Update SMS deposit
      smsDeposit.status = 'APPROVED';
      smsDeposit.transactionId = transaction._id;
      smsDeposit.processedBy = adminUserId;
      smsDeposit.processedAt = new Date();

      await transaction.save({ session });
      await wallet.save({ session });
      await smsDeposit.save({ session });
      await session.commitTransaction();

      console.log(`✅ Manual approved SMS deposit: $${smsDeposit.extractedAmount} for user ${smsDeposit.telegramId}`);

      return {
        smsDeposit,
        transaction,
        wallet
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error approving SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // NEW: Reject SMS deposit
  static async rejectSMSDeposit(smsDepositId, adminUserId, reason = '') {
    try {
      const smsDeposit = await SMSDeposit.findById(smsDepositId);
      
      if (!smsDeposit) {
        throw new Error('SMS deposit not found');
      }

      if (smsDeposit.status !== 'PENDING') {
        throw new Error(`SMS deposit already ${smsDeposit.status}`);
      }

      smsDeposit.status = 'REJECTED';
      smsDeposit.processedBy = adminUserId;
      smsDeposit.processedAt = new Date();
      smsDeposit.metadata.rejectionReason = reason;

      await smsDeposit.save();

      console.log(`❌ Rejected SMS deposit: $${smsDeposit.extractedAmount} for user ${smsDeposit.telegramId}`);

      return smsDeposit;
    } catch (error) {
      console.error('❌ Error rejecting SMS deposit:', error);
      throw error;
    }
  }

  // NEW: Get pending SMS deposits
  static async getPendingSMSDeposits(limit = 50) {
    try {
      return await SMSDeposit.find({ status: 'PENDING' })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: 1 })
        .limit(limit);
    } catch (error) {
      console.error('❌ Error getting pending SMS deposits:', error);
      throw error;
    }
  }

  // NEW: Get all SMS deposits with pagination
  static async getSMSDeposits(page = 1, limit = 20, status = null) {
    try {
      const skip = (page - 1) * limit;
      const query = status ? { status } : {};
      
      const [deposits, total] = await Promise.all([
        SMSDeposit.find(query)
          .populate('userId', 'firstName username telegramId')
          .populate('processedBy', 'firstName username')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
        SMSDeposit.countDocuments(query)
      ]);

      return {
        deposits,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('❌ Error getting SMS deposits:', error);
      throw error;
    }
  }

  // NEW: Auto-approve deposits under certain amount
  static async processAutoApproveDeposits(maxAutoApproveAmount = 100) {
    try {
      const pendingDeposits = await this.getPendingSMSDeposits();
      let approvedCount = 0;

      for (const deposit of pendingDeposits) {
        if (deposit.extractedAmount <= maxAutoApproveAmount) {
          try {
            await this.approveSMSDeposit(deposit._id, 'SYSTEM_AUTO');
            approvedCount++;
            console.log(`✅ Auto-approved deposit ${deposit._id} for $${deposit.extractedAmount}`);
          } catch (error) {
            console.error(`❌ Failed to auto-approve deposit ${deposit._id}:`, error);
          }
        }
      }

      return { processed: pendingDeposits.length, approved: approvedCount };
    } catch (error) {
      console.error('❌ Error in auto-approve process:', error);
      throw error;
    }
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