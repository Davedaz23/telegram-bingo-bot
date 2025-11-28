// services/walletService.js - SIMPLIFIED SMS PROCESSING
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PaymentMethod = require('../models/PaymentMethod');
const SMSDeposit = require('../models/SMSDeposit');

class WalletService {
  
static async resolveUserId(userId) {
    try {
      console.log('🔄 Resolving user ID:', userId, 'Type:', typeof userId);
      
      if (mongoose.Types.ObjectId.isValid(userId) && new mongoose.Types.ObjectId(userId).toString() === userId) {
        console.log('✅ Input is already MongoDB ObjectId');
        return userId;
      }
      
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


 // NEW: Get specific SMS deposit by ID with proper population
  static async getSMSDepositById(smsDepositId) {
    try {
      return await SMSDeposit.findById(smsDepositId)
        .populate('userId', 'firstName username telegramId')
        .populate('processedBy', 'firstName username');
    } catch (error) {
      console.error('❌ Error getting SMS deposit by ID:', error);
      throw error;
    }
  }
  // NEW: Auto-process received SMS immediately
  static async autoProcessReceivedSMS() {
    try {
      const receivedSMS = await SMSDeposit.find({ status: 'RECEIVED' })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: 1 })
        .limit(50);

      let processedCount = 0;
      let approvedCount = 0;

      console.log(`🔄 Found ${receivedSMS.length} received SMS to process`);

      for (const sms of receivedSMS) {
        try {
          // Mark as processing
          sms.status = 'PROCESSING';
          await sms.save();

          const result = await this.processSMSDeposit(
            sms.userId.telegramId,
            sms.paymentMethod,
            sms.originalSMS,
            true // Auto-approve
          );

          processedCount++;
          if (result.autoApproved) {
            approvedCount++;
          }

          console.log(`✅ Processed SMS ${sms._id}: ${result.autoApproved ? 'Auto-approved' : 'Needs review'}`);
        } catch (error) {
          console.error(`❌ Failed to process SMS ${sms._id}:`, error.message);
          // Reset status to RECEIVED if processing failed
          await SMSDeposit.findByIdAndUpdate(sms._id, { 
            status: 'RECEIVED',
            'metadata.processError': error.message 
          });
        }
      }

      return { 
        total: receivedSMS.length, 
        processed: processedCount, 
        approved: approvedCount 
      };
    } catch (error) {
      console.error('❌ Error in auto-process SMS:', error);
      throw error;
    }
  }


  // NEW: Detect payment method from SMS content
  static detectPaymentMethodFromSMS(smsText) {
    const sms = smsText.toLowerCase();
    
    if (sms.includes('cbe') && sms.includes('birr')) return 'CBE Birr';
    if (sms.includes('cbe') && !sms.includes('birr')) return 'CBE Bank';
    if (sms.includes('awash')) return 'Awash Bank';
    if (sms.includes('dashen')) return 'Dashen Bank';
    if (sms.includes('telebirr')) return 'Telebirr';
    
    return 'UNKNOWN';
  }

  // NEW: Process stored SMS for deposit
  static async processSMSDeposit(userId, paymentMethodName, smsText, autoApprove = true) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('🚀 Starting SMS deposit processing...');
      
      const mongoUserId = await this.resolveUserId(userId);
      const user = await User.findById(mongoUserId);
      
      if (!user) {
        throw new Error('User not found');
      }

      console.log('✅ User found:', user.telegramId);

      const paymentMethod = await PaymentMethod.findOne({ 
        name: paymentMethodName
      });
      
      if (!paymentMethod && paymentMethodName !== 'UNKNOWN') {
        throw new Error('Invalid payment method: ' + paymentMethodName);
      }

      console.log('✅ Payment method:', paymentMethodName);

      const amount = this.extractAmountFromSMS(smsText);
      if (!amount || amount <= 0) {
        throw new Error('Could not extract valid amount from SMS.');
      }

      console.log('✅ Amount extracted:', amount);

      let transaction = null;
      let wallet = null;

      // AUTO-APPROVE LOGIC
      const shouldAutoApprove = autoApprove && this.shouldAutoApproveSMS(smsText, amount);
      
      if (shouldAutoApprove) {
        console.log('🤖 Auto-approving deposit...');
        
        wallet = await this.getWallet(mongoUserId);
        const balanceBefore = wallet.balance;
        wallet.balance += amount;
        const balanceAfter = wallet.balance;

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
            smsText: smsText.substring(0, 500),
            approvedBy: 'SYSTEM',
            approvedAt: new Date(),
            autoApproved: true,
            confidence: this.getSMSConfidence(smsText)
          }
        });

        await transaction.save({ session });
        await wallet.save({ session });
        
        console.log(`✅ Auto-approved SMS deposit: $${amount} for user ${user.telegramId}`);
      } else {
        console.log('⏳ Creating pending transaction...');
        
        wallet = await this.getWallet(mongoUserId);
        const balanceBefore = wallet.balance;

        transaction = new Transaction({
          userId: mongoUserId,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter: balanceBefore,
          status: 'PENDING',
          description: `SMS deposit via ${paymentMethodName} - Needs Review`,
          reference: `SMS-PENDING-${Date.now()}`,
          metadata: {
            paymentMethod: paymentMethodName,
            smsText: smsText.substring(0, 500),
            approvedBy: null,
            approvedAt: null,
            autoApproved: false,
            confidence: this.getSMSConfidence(smsText),
            needsManualReview: true,
            reviewReason: this.getReviewReason(smsText, amount)
          }
        });

        await transaction.save({ session });
      }

      await session.commitTransaction();

      console.log('✅ SMS deposit processed successfully');

      return {
        transaction,
        wallet,
        autoApproved: shouldAutoApprove
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // NEW: Process existing SMS deposit record
  static async processExistingSMSDeposit(smsDepositId, adminUserId = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('🔄 Processing existing SMS deposit:', smsDepositId);
      
      const smsDeposit = await SMSDeposit.findById(smsDepositId).session(session);
      
      if (!smsDeposit) {
        throw new Error('SMS deposit not found');
      }

      if (smsDeposit.status === 'APPROVED' || smsDeposit.status === 'AUTO_APPROVED') {
        throw new Error('SMS deposit already processed');
      }

      const user = await User.findById(smsDeposit.userId).session(session);
      if (!user) {
        throw new Error('User not found');
      }

      const amount = smsDeposit.extractedAmount;
      if (!amount || amount <= 0) {
        throw new Error('Invalid amount in SMS deposit');
      }

      console.log('✅ Processing amount:', amount);

      const wallet = await this.getWallet(smsDeposit.userId);
      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;

      const isAutoApproved = !adminUserId && this.shouldAutoApproveSMS(smsDeposit.originalSMS, amount);
      
      const transaction = new Transaction({
        userId: smsDeposit.userId,
        type: 'DEPOSIT',
        amount,
        balanceBefore,
        balanceAfter,
        status: isAutoApproved ? 'COMPLETED' : 'PENDING',
        description: `${isAutoApproved ? 'Auto-approved' : 'Approved'} deposit via ${smsDeposit.paymentMethod}`,
        reference: `SMS-${isAutoApproved ? 'AUTO' : 'APPROVED'}-${Date.now()}`,
        metadata: {
          paymentMethod: smsDeposit.paymentMethod,
          smsText: smsDeposit.originalSMS.substring(0, 500),
          approvedBy: isAutoApproved ? 'SYSTEM' : adminUserId,
          approvedAt: new Date(),
          autoApproved: isAutoApproved,
          smsDepositId: smsDeposit._id,
          confidence: this.getSMSConfidence(smsDeposit.originalSMS)
        }
      });

      // Update SMS deposit
      smsDeposit.status = isAutoApproved ? 'AUTO_APPROVED' : 'APPROVED';
      smsDeposit.transactionId = transaction._id;
      smsDeposit.autoApproved = isAutoApproved;
      smsDeposit.processedAt = new Date();
      
      if (adminUserId) {
        smsDeposit.processedBy = adminUserId;
      }

      await transaction.save({ session });
      await wallet.save({ session });
      await smsDeposit.save({ session });
      await session.commitTransaction();

      console.log(`✅ Processed SMS deposit: $${amount} for user ${user.telegramId}`);

      return {
        smsDeposit,
        transaction,
        wallet,
        autoApproved: isAutoApproved
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing existing SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
  static async getAllSMSDeposits(page = 1, limit = 20, status = null) {
    try {
      const skip = (page - 1) * limit;
      const query = status ? { status } : {};
      
      const [deposits, total] = await Promise.all([
        SMSDeposit.find(query)
          .populate('userId', 'firstName username telegramId')
          .populate('processedBy', 'firstName username')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(), // Use lean for better performance
        SMSDeposit.countDocuments(query)
      ]);

      // Ensure all deposits have proper user information
      const enhancedDeposits = deposits.map(deposit => {
        if (!deposit.userId) {
          // If user population failed, create a minimal user object
          deposit.userId = {
            firstName: 'Unknown User',
            username: 'unknown',
            telegramId: deposit.telegramId || 'unknown'
          };
        }
        return deposit;
      });

      return {
        deposits: enhancedDeposits,
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
// NEW: Batch approve multiple SMS deposits
  static async batchApproveSMSDeposits(smsDepositIds, adminUserId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('🔄 Batch approving SMS deposits:', smsDepositIds);

      const results = {
        successful: [],
        failed: []
      };

      for (const smsDepositId of smsDepositIds) {
        try {
          const result = await this.approveReceivedSMS(smsDepositId, adminUserId);
          results.successful.push({
            smsDepositId,
            amount: result.transaction.amount,
            user: result.user.telegramId
          });
        } catch (error) {
          results.failed.push({
            smsDepositId,
            error: error.message
          });
        }
      }

      await session.commitTransaction();

      console.log(`✅ Batch approval completed: ${results.successful.length} successful, ${results.failed.length} failed`);

      return results;

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error in batch approval:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
  // NEW: Get received SMS for admin
  static async getReceivedSMSDeposits(limit = 50) {
    try {
      return await SMSDeposit.find({ status: 'RECEIVED' })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: 1 })
        .limit(limit);
    } catch (error) {
      console.error('❌ Error getting received SMS deposits:', error);
      throw error;
    }
  }

  // NEW: Admin approve received SMS
  static async approveReceivedSMS(smsDepositId, adminUserId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('🔄 Approving received SMS deposit:', smsDepositId);
      
      // Get SMS deposit with user populated
      const smsDeposit = await SMSDeposit.findById(smsDepositId)
        .populate('userId')
        .session(session);
      
      if (!smsDeposit) {
        throw new Error('SMS deposit not found');
      }

      if (smsDeposit.status !== 'RECEIVED' && smsDeposit.status !== 'PENDING') {
        throw new Error(`SMS deposit already ${smsDeposit.status}`);
      }

      // Check if user exists - userId should already be a populated user object
      const user = smsDeposit.userId;
      if (!user) {
        throw new Error('User not found in SMS deposit');
      }

      const amount = smsDeposit.extractedAmount;
      if (!amount || amount <= 0) {
        throw new Error('Invalid amount in SMS deposit');
      }

      console.log('✅ Processing amount:', amount, 'for user:', user.telegramId);

      // Get or create wallet - USE THE USER'S MONGODB ID DIRECTLY
      let wallet = await Wallet.findOne({ userId: user._id }).session(session);
      if (!wallet) {
        console.log('💰 Creating new wallet for user:', user.telegramId);
        wallet = new Wallet({
          userId: user._id,
          balance: 0,
          currency: 'USD'
        });
      }

      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;

      // Create transaction
      const transaction = new Transaction({
        userId: user._id,
        type: 'DEPOSIT',
        amount,
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
          autoApproved: false,
          smsDepositId: smsDeposit._id,
          confidence: this.getSMSConfidence(smsDeposit.originalSMS)
        }
      });

      // Update SMS deposit
      smsDeposit.status = 'APPROVED';
      smsDeposit.transactionId = transaction._id;
      smsDeposit.processedBy = adminUserId;
      smsDeposit.processedAt = new Date();
      smsDeposit.autoApproved = false;

      await transaction.save({ session });
      await wallet.save({ session });
      await smsDeposit.save({ session });
      await session.commitTransaction();

      console.log(`✅ Approved SMS deposit: $${amount} for user ${user.telegramId}`);

      return {
        smsDeposit,
        transaction,
        wallet,
        user,
        autoApproved: false
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error approving received SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }


  // NEW: Get unprocessed SMS messages
  static async getUnprocessedSMS(limit = 50) {
    try {
      return await SMSDeposit.find({ status: 'RECEIVED' })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: 1 })
        .limit(limit);
    } catch (error) {
      console.error('❌ Error getting unprocessed SMS:', error);
      throw error;
    }
  }

  // NEW: Auto-process all received SMS
   static async autoProcessReceivedSMS() {
    try {
      const receivedSMS = await SMSDeposit.find({ status: 'RECEIVED' })
        .populate('userId')
        .sort({ createdAt: 1 })
        .limit(50);

      let processedCount = 0;
      let approvedCount = 0;
      let failedCount = 0;

      console.log(`🔄 Found ${receivedSMS.length} received SMS to process`);

      for (const sms of receivedSMS) {
        try {
          // Mark as processing
          sms.status = 'PROCESSING';
          await sms.save();

          let user = sms.userId;
          
          // If user population failed, try to find user by telegramId
          if (!user && sms.telegramId) {
            user = await User.findOne({ telegramId: sms.telegramId });
            if (user) {
              sms.userId = user._id;
              await sms.save();
            }
          }

          if (!user) {
            throw new Error(`User not found for SMS deposit ${sms._id}`);
          }

          const result = await this.processSMSDeposit(
            user.telegramId || user._id,
            sms.paymentMethod,
            sms.originalSMS,
            true // Auto-approve
          );

          processedCount++;
          if (result.autoApproved) {
            approvedCount++;
          }

          console.log(`✅ Processed SMS ${sms._id}: ${result.autoApproved ? 'Auto-approved' : 'Needs review'}`);
        } catch (error) {
          console.error(`❌ Failed to process SMS ${sms._id}:`, error.message);
          failedCount++;
          
          // Reset status to RECEIVED if processing failed
          await SMSDeposit.findByIdAndUpdate(sms._id, { 
            status: 'RECEIVED',
            'metadata.processError': error.message,
            'metadata.lastProcessAttempt': new Date()
          });
        }
      }

      return { 
        total: receivedSMS.length, 
        processed: processedCount, 
        approved: approvedCount,
        failed: failedCount
      };
    } catch (error) {
      console.error('❌ Error in auto-process SMS:', error);
      throw error;
    }
  }
  static async initializeWallet(userId) {
    try {
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

  // SIMPLIFIED: Process SMS deposit with automatic handling
  static async processSMSDeposit(userId, paymentMethodName, smsText, autoApprove = true) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('🚀 Starting SMS deposit processing...');
      
      // Resolve user ID
      const mongoUserId = await this.resolveUserId(userId);
      const user = await User.findById(mongoUserId);
      
      if (!user) {
        throw new Error('User not found');
      }

      console.log('✅ User found:', user.telegramId);

      // Get payment method
      const paymentMethod = await PaymentMethod.findOne({ 
        name: paymentMethodName
      });
      
      if (!paymentMethod) {
        throw new Error('Invalid payment method: ' + paymentMethodName);
      }

      console.log('✅ Payment method found:', paymentMethodName);

      // Extract amount from SMS
      const amount = this.extractAmountFromSMS(smsText);
      if (!amount || amount <= 0) {
        throw new Error('Could not extract valid amount from SMS. Please make sure the amount is clearly mentioned.');
      }

      console.log('✅ Amount extracted:', amount);

      // Create SMS deposit record (ALWAYS store the SMS)
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
          hasBalance: smsText.includes('balance') || smsText.includes('Balance'),
          processedAt: new Date(),
          autoApproveAttempted: autoApprove
        }
      });

      let transaction = null;
      let wallet = null;

      // AUTO-APPROVE LOGIC: Automatically approve if amount is clear and reasonable
      const shouldAutoApprove = autoApprove && this.shouldAutoApproveSMS(smsText, amount);
      
      if (shouldAutoApprove) {
        console.log('🤖 Auto-approving deposit...');
        
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
            smsText: smsText.substring(0, 500),
            approvedBy: 'SYSTEM',
            approvedAt: new Date(),
            autoApproved: true,
            smsDepositId: smsDeposit._id,
            confidence: this.getSMSConfidence(smsText)
          }
        });

        smsDeposit.status = 'AUTO_APPROVED';
        smsDeposit.transactionId = transaction._id;
        smsDeposit.autoApproved = true;
        smsDeposit.processedAt = new Date();

        await transaction.save({ session });
        await wallet.save({ session });
        
        console.log(`✅ Auto-approved SMS deposit: $${amount} for user ${user.telegramId}`);
      } else {
        console.log('⏳ Creating pending SMS deposit for manual review...');
        
        // For unclear amounts or suspicious SMS, create pending transaction
        wallet = await this.getWallet(mongoUserId);
        const balanceBefore = wallet.balance;

        transaction = new Transaction({
          userId: mongoUserId,
          type: 'DEPOSIT',
          amount,
          balanceBefore,
          balanceAfter: balanceBefore,
          status: 'PENDING',
          description: `SMS deposit via ${paymentMethodName} - Needs Review`,
          reference: `SMS-PENDING-${Date.now()}`,
          metadata: {
            paymentMethod: paymentMethodName,
            smsText: smsText.substring(0, 500),
            approvedBy: null,
            approvedAt: null,
            autoApproved: false,
            smsDepositId: smsDeposit._id,
            confidence: this.getSMSConfidence(smsText),
            needsManualReview: true,
            reviewReason: this.getReviewReason(smsText, amount)
          }
        });

        smsDeposit.transactionId = transaction._id;
        smsDeposit.metadata.needsManualReview = true;
        smsDeposit.metadata.reviewReason = this.getReviewReason(smsText, amount);

        await transaction.save({ session });
      }

      // ALWAYS save the SMS deposit record
      await smsDeposit.save({ session });
      await session.commitTransaction();

      console.log('✅ SMS deposit processed successfully');

      return {
        smsDeposit,
        transaction,
        wallet,
        autoApproved: shouldAutoApprove
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing SMS deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
 static async storeSMSMessage(userId, smsText, paymentMethod = 'UNKNOWN') {
    try {
      console.log('💾 Storing SMS message from user:', userId);
      
      const mongoUserId = await this.resolveUserId(userId);
      const user = await User.findById(mongoUserId);
      
      if (!user) {
        throw new Error('User not found');
      }

      const amount = this.extractAmountFromSMS(smsText);
      const detectedMethod = this.detectPaymentMethodFromSMS(smsText);
      const finalMethod = paymentMethod === 'UNKNOWN' ? detectedMethod : paymentMethod;

      const smsDeposit = new SMSDeposit({
        userId: mongoUserId,
        telegramId: user.telegramId,
        originalSMS: smsText,
        paymentMethod: finalMethod,
        extractedAmount: amount || 0,
        status: 'RECEIVED',
        metadata: {
          smsLength: smsText.length,
          hasTransactionId: smsText.includes('Txn ID') || smsText.includes('Transaction'),
          hasBalance: smsText.includes('balance') || smsText.includes('Balance'),
          amountDetected: !!amount,
          detectedAmount: amount,
          storedAt: new Date(),
          autoProcessAttempted: false
        },
        smsType: 'BANK_SMS'
      });

      await smsDeposit.save();
      console.log('✅ SMS stored successfully:', smsDeposit._id);

      return smsDeposit;
    } catch (error) {
      console.error('❌ Error storing SMS:', error);
      throw error;
    }
  }
  // NEW: Determine if SMS should be auto-approved
  static shouldAutoApproveSMS(smsText, amount) {
    const sms = smsText.toLowerCase();
    
    // Auto-approve conditions
    const conditions = [
      // Amount is reasonable (between 1 and 200)
      amount >= 1 && amount <= 200,
      
      // SMS contains clear transaction indicators
      sms.includes('sent') || sms.includes('received') || sms.includes('transfer'),
      
      // SMS contains amount with currency
      (sms.includes('etb') || sms.includes('birr') || sms.includes('br')),
      
      // SMS has reasonable length (not too short)
      smsText.length > 20,
      
      // Amount matches common deposit patterns
      this.isCommonAmount(amount)
    ];

    // Count how many conditions are met
    const metConditions = conditions.filter(Boolean).length;
    const confidence = metConditions / conditions.length;

    console.log(`🔍 Auto-approve confidence: ${confidence} (${metConditions}/${conditions.length} conditions met)`);

    // Auto-approve if high confidence (at least 80% conditions met)
    return confidence >= 0.8;
  }

  // NEW: Get SMS confidence score
  static getSMSConfidence(smsText) {
    const sms = smsText.toLowerCase();
    let confidence = 0;
    
    // Confidence factors
    if (sms.includes('transaction') || sms.includes('txn')) confidence += 0.3;
    if (sms.includes('sent') || sms.includes('transfer')) confidence += 0.2;
    if (sms.includes('received') || sms.includes('deposit')) confidence += 0.2;
    if (sms.includes('etb') || sms.includes('birr')) confidence += 0.2;
    if (sms.includes('balance')) confidence += 0.1;
    if (smsText.length > 50) confidence += 0.1;
    if (smsText.length > 100) confidence += 0.1;
    
    return Math.min(confidence, 1.0);
  }

  // NEW: Get reason for manual review
  static getReviewReason(smsText, amount) {
    const reasons = [];
    
    if (amount > 200) reasons.push('Large amount');
    if (amount < 1) reasons.push('Very small amount');
    
    const sms = smsText.toLowerCase();
    if (!sms.includes('etb') && !sms.includes('birr') && !sms.includes('br')) {
      reasons.push('No currency mentioned');
    }
    
    if (smsText.length < 30) reasons.push('SMS too short');
    
    if (!sms.includes('sent') && !sms.includes('received') && !sms.includes('transfer')) {
      reasons.push('No transaction verbs');
    }
    
    return reasons.length > 0 ? reasons.join(', ') : 'Low confidence score';
  }

  // NEW: Check if amount is common
  static isCommonAmount(amount) {
    const commonAmounts = [10, 20, 30, 50, 100, 150, 200, 250, 300, 500, 1000];
    return commonAmounts.includes(amount) || (amount % 10 === 0 && amount <= 1000);
  }

  // ENHANCED: Extract amount from SMS with multiple patterns
  static extractAmountFromSMS(smsText) {
    try {
      console.log('🔍 Extracting amount from SMS:', smsText.substring(0, 100));
      
      const patterns = [
        /(\d+\.?\d*)\s*ETB/i,
        /(\d+\.?\d*)\s*Br/i,
        /(\d+\.?\d*)\s*birr/i,
        /amount[:\s]*(\d+\.?\d*)/i,
        /sent\s*(\d+\.?\d*)/i,
        /received\s*(\d+\.?\d*)/i,
        /transfer\s*(\d+\.?\d*)/i,
        /you have sent\s*(\d+\.?\d*)/i,
        /deposit\s*(\d+\.?\d*)/i,
        /(\d+\.?\d*)\s*(?:ETB|Birr|Br)/i,
        /(?:ETB|Birr|Br)\s*(\d+\.?\d*)/i
      ];

      let amount = null;
      
      for (const pattern of patterns) {
        const match = smsText.match(pattern);
        if (match && match[1]) {
          amount = parseFloat(match[1]);
          console.log('✅ Amount extracted with pattern:', pattern, amount);
          if (amount > 0) break;
        }
      }

      // Final fallback - look for any number that could be an amount
      if (!amount || amount <= 0) {
        const numbers = smsText.match(/\d+\.?\d*/g);
        if (numbers) {
          // Filter reasonable amounts (between 1 and 10,000)
          const possibleAmounts = numbers.map(n => parseFloat(n)).filter(n => n >= 1 && n <= 10000);
          if (possibleAmounts.length > 0) {
            amount = possibleAmounts[0];
            console.log('✅ Amount extracted as first reasonable number:', amount);
          }
        }
      }

      return amount;
    } catch (error) {
      console.error('❌ Error extracting amount from SMS:', error);
      return null;
    }
  }

  // Rest of the methods remain the same as previous version...
  static async createDepositRequest(userId, amount, receiptImage, reference, description = 'Bank deposit') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const mongoUserId = await this.resolveUserId(userId);
      const wallet = await this.getWallet(mongoUserId);
      
      const transaction = new Transaction({
        userId: mongoUserId,
        type: 'DEPOSIT',
        amount,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
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

  static async approveDeposit(transactionId, adminUserId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transaction = await Transaction.findById(transactionId).session(session);
      
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status !== 'PENDING') {
        throw new Error(`Transaction already ${transaction.status}`);
      }

      const wallet = await Wallet.findOne({ userId: transaction.userId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const balanceBefore = wallet.balance;
      wallet.balance += transaction.amount;
      const balanceAfter = wallet.balance;

      transaction.balanceBefore = balanceBefore;
      transaction.balanceAfter = balanceAfter;
      transaction.status = 'COMPLETED';
      transaction.metadata.approvedBy = adminUserId;
      transaction.metadata.approvedAt = new Date();

      await wallet.save({ session });
      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`✅ Deposit approved: $${transaction.amount} for user ${transaction.userId}`);

      return { wallet, transaction };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error approving deposit:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

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

  static async processAutoApproveDeposits(maxAutoApproveAmount = 100) {
    try {
      const pendingDeposits = await this.getPendingSMSDeposits();
      let approvedCount = 0;

      for (const deposit of pendingDeposits) {
        if (deposit.extractedAmount <= maxAutoApproveAmount && this.shouldAutoApproveSMS(deposit.originalSMS, deposit.extractedAmount)) {
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

  // Other existing methods...
  static async deductGameEntry(userId, gameId, entryFee, description = 'Game entry fee') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const mongoUserId = await this.resolveUserId(userId);
      const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (wallet.balance < entryFee) {
        throw new Error('Insufficient balance for game entry');
      }

      const balanceBefore = wallet.balance;
      wallet.balance -= entryFee;
      const balanceAfter = wallet.balance;

      const transaction = new Transaction({
        userId: mongoUserId,
        type: 'GAME_ENTRY',
        amount: -entryFee,
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
      const mongoUserId = await this.resolveUserId(userId);
      const wallet = await Wallet.findOne({ userId: mongoUserId }).session(session);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const balanceBefore = wallet.balance;
      wallet.balance += amount;
      const balanceAfter = wallet.balance;

      const transaction = new Transaction({
        userId: mongoUserId,
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

  //helpers
  // Add this method to WalletService
static async checkUserExists(userId) {
  try {
    const user = await User.findById(userId);
    return !!user;
  } catch (error) {
    console.error('Error checking user existence:', error);
    return false;
  }
}

// And update the getSMSDepositById method to handle missing users
static async getSMSDepositById(smsDepositId) {
  try {
    const smsDeposit = await SMSDeposit.findById(smsDepositId)
      .populate('userId', 'firstName username telegramId')
      .populate('processedBy', 'firstName username');
    
    // If user population failed but we have telegramId, create a minimal user object
    if (!smsDeposit.userId && smsDeposit.telegramId) {
      smsDeposit.userId = {
        firstName: 'Unknown User',
        username: 'unknown',
        telegramId: smsDeposit.telegramId
      };
    }
    
    return smsDeposit;
  } catch (error) {
    console.error('❌ Error getting SMS deposit by ID:', error);
    throw error;
  }
}
}

module.exports = WalletService;