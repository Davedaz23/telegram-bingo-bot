const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const paymentMethod= require('../models/PaymentMethod');

class WalletService {
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
  static async getWallet(userId) {
    try {
      let wallet = await Wallet.findOne({ userId });
      
      if (!wallet) {
        wallet = await this.initializeWallet(userId);
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
      const wallet = await this.getWallet(userId);
      
      // Create pending deposit transaction
      const transaction = new Transaction({
        userId,
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

      console.log(`📥 Deposit request created for user ${userId}: $${amount}`);

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
      const wallet = await Wallet.findOne({ userId }).session(session);
      
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
        userId,
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

      console.log(`🎮 Game entry fee deducted for user ${userId}: $${entryFee}. New balance: $${balanceAfter}`);

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
      const wallet = await Wallet.findOne({ userId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;

      // Create transaction record
      const transaction = new Transaction({
        userId,
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

      console.log(`🏆 Winning added for user ${userId}: $${amount}. New balance: $${balanceAfter}`);

      return { wallet, transaction };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error adding winning:', error);
      throw error;
    } finally {
      session.endSession();
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

  // Get user transaction history
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
}

module.exports = WalletService;