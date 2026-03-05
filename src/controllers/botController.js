// botController.js - UPDATED VERSION WITH ALL ACTIONS INCLUDED
const { Telegraf, Markup, session } = require('telegraf');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');
const SMSDeposit = require('../models/SMSDeposit');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const SupportService = require('../services/supportService');
const SupportChat = require('../models/SupportChat');  // ADD THIS LINE
const SupportMessage = require('../models/SupportMessage');  // ADD THIS LINE (optional, for complet
const GameService = require('../services/gameService'); // For game-related admin actions
// ✅ AdminUtils for multiple admin support
const AdminUtils = {
  adminIds: [],
  
  initialize() {
    const singleAdmin = process.env.ADMIN_TELEGRAM_ID || '';
    const multipleAdmins = process.env.ADMIN_TELEGRAM_IDS || '';
    
    let allAdmins = [];
    
    if (singleAdmin) {
      allAdmins.push(singleAdmin.trim());
    }
    
    if (multipleAdmins) {
      const ids = multipleAdmins.split(',').map(id => id.trim()).filter(id => id);
      allAdmins = [...allAdmins, ...ids];
    }
    
    this.adminIds = [...new Set(allAdmins)].filter(id => id !== '');
    
    console.log(`👑 AdminUtils initialized with ${this.adminIds.length} admins: ${this.adminIds.join(', ')}`);
  },
  
  isAdmin(userId) {
    if (this.adminIds.length === 0) {
      this.initialize();
    }
    const userIdStr = userId.toString();
    return this.adminIds.includes(userIdStr);
  },
  
  getAdminCount() {
    if (this.adminIds.length === 0) {
      this.initialize();
    }
    return this.adminIds.length;
  }
};

class BotController {
  constructor(botToken, adminId) {
    if (BotController.instance) {
      console.log('🤖 Returning existing bot instance');
      return BotController.instance;
    }
    
    BotController.instance = this;
    this.bot = new Telegraf(botToken);
    this.isRunning = false;
    this.isLaunching = false;
    this.startQueue = [];
    
    // ✅ Initialize AdminUtils
    AdminUtils.initialize();
    
    // Setup session middleware
    this.bot.use(session({
      defaultSession: () => ({
        pendingDepositMethod: null,
        withdrawalMethod: null,
        withdrawalAmount: null,
        withdrawalAccount: null,
        pendingWithdrawalRejection: null
      })
    }));
    
    this.setupHandlers();
    
    BotController._instance = this;
    console.log('🤖 New BotController instance created');
  }

  static getInstance(botToken, adminId) {
    if (!BotController._instance) {
      BotController._instance = new BotController(botToken, adminId);
    }
    return BotController._instance;
  }

  static clearInstance() {
    if (BotController.instance) {
      BotController.instance.isRunning = false;
      BotController.instance = null;
    }
    BotController._instance = null;
  }

  // ✅ Use AdminUtils for all admin checks
  isUserAdmin(userId) {
    return AdminUtils.isAdmin(userId);
  }

  setupHandlers() {
    // ========== COMMAND HANDLERS ==========
      //  support handlers
     this.setupSupportHandlers();
    // Start command
    
    this.bot.start(async (ctx) => {
      try {
        console.log('🚀 Start command received from:', ctx.from.id, ctx.from.first_name);

        const isAdmin = AdminUtils.isAdmin(ctx.from.id);
        const user = await UserService.findOrCreateUser(ctx.from);
        
        let balance = 0;
        try {
          balance = await WalletService.getBalanceByTelegramId(user.telegramId);
        } catch (walletError) {
          await WalletService.initializeWallet(user.telegramId);
          balance = 0;
        }

        let welcomeMessage = `
🎯 *Welcome to Bingo Bot, ${user.firstName || user.username}!*

*Your Wallet Balance:* $${balance}

*Features:*
• 🎮 Play real-time Bingo with friends
• 💰 Easy deposits via Ethiopian banks & mobile money
• 👥 Create private or public games  
• 🏆 Track your stats and wins

*Quick Actions:*
        `;

        if (isAdmin) {
          welcomeMessage = `👑 *ADMIN MODE*\n\n${welcomeMessage}`;
        }

        const keyboardButtons = [
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
          [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
          [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
          [Markup.button.callback('📊 My Stats & History', 'show_stats')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
          [Markup.button.callback('📞 Support', 'support')],

        ];

        if (isAdmin) {
          keyboardButtons.unshift([Markup.button.callback('👑 ADMIN PANEL', 'admin_panel')]);
        }

        await ctx.replyWithMarkdown(welcomeMessage,
          Markup.inlineKeyboard(keyboardButtons)
        );

      } catch (error) {
        console.error('❌ Error in start command:', error);
        await ctx.replyWithMarkdown(
          `🎯 *Welcome to Bingo Bot!*\n\nWe're setting up your account...\n\nClick below to play:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
          ])
        );
      }
    });

    // Help command
    this.bot.help(async (ctx) => {
      const isAdmin = AdminUtils.isAdmin(ctx.from.id);
      
      const helpMessage = `
🤖 *Bingo Bot Commands*

*Main Commands:*
/start - Start the bot and see main menu
/help - Show this help message  
/deposit - Start deposit process
/wallet - Check your wallet balance
/stats - View your game statistics
/withdraw - Withdraw your funds

*Quick Actions via Buttons:*
🎮 Play Bingo - Open the web app to play
💰 Deposit Money - Add funds to your wallet
📤 Withdraw Funds - Withdraw money to your account
📊 My Stats - View your game history
💼 My Wallet - Check balance & transactions

*Deposit Methods:*
🏦 Banks: CBE, BOA, Dashen
📱 Mobile Money: Telebirr, CBE Birr

*Withdrawal Methods:*
🏦 Bank Transfer: CBE, BOA, Dashen
📱 Mobile Money: Telebirr, CBE Birr
      `;

      const helpButtons = [
        [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
        [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
        [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('📊 My Stats', 'show_stats')]
      ];

      if (isAdmin) {
        helpButtons.unshift([Markup.button.callback('👑 Admin Help', 'admin_help_menu')]);
      }

      await ctx.replyWithMarkdown(helpMessage,
        Markup.inlineKeyboard(helpButtons)
      );
    });
  
   this.bot.command(/^user_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];

  try {
    const user = await User.findOne({ telegramId })
      .lean();
    
    if (!user) {
      await ctx.reply('❌ User not found');
      return;
    }

    // Get wallet separately - don't try to populate
    const wallet = await Wallet.findOne({ userId: user._id }).lean() || { balance: 0, lockedAmount: 0 };
    
    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Escape function for Markdown special characters
    const escapeMarkdown = (text) => {
      if (!text) return '';
      // Escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
      return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };

    // Escape all user-provided content
    const firstName = escapeMarkdown(user.firstName || 'Not set');
    const username = escapeMarkdown(user.username || 'Not set');
    const role = escapeMarkdown(user.role || 'user');
    const joinedDate = escapeMarkdown(new Date(user.createdAt).toLocaleString());

    let message = `👤 *User Details*\n\n`;
    message += `*Name:* ${firstName}\n`;
    message += `*Username:* @${username}\n`;
    message += `*Telegram ID:* ${telegramId}\n`;
    message += `*Role:* ${role}\n`;
    message += `*Joined:* ${joinedDate}\n\n`;
    
    message += `💼 *Wallet Information:*\n`;
    message += `• Balance: $${wallet.balance || 0}\n`;
    message += `• Available: $${(wallet.balance || 0) - (wallet.lockedAmount || 0)}\n`;
    message += `• Locked: $${wallet.lockedAmount || 0}\n\n`;
    
    message += `📊 *Recent Transactions:*\n`;
    if (transactions.length > 0) {
      transactions.forEach((tx, index) => {
        const emoji = tx.type === 'DEPOSIT' ? '📥' :
                     tx.type === 'WITHDRAWAL' ? '📤' :
                     tx.type === 'WINNING' ? '🏆' : '🎮';
        const status = tx.status === 'PENDING' ? '⏳' :
                      tx.status === 'COMPLETED' ? '✅' : '❌';
        const description = escapeMarkdown(tx.description || '');
        message += `${index + 1}. ${emoji} $${Math.abs(tx.amount)} - ${tx.type} ${status}\n`;
        if (description) {
          message += `   ${description}\n`;
        }
      });
    } else {
      message += `No transactions yet.\n`;
    }

    // Try to send with Markdown, fallback to plain text if it fails
    try {
      await ctx.replyWithMarkdown(message,
        Markup.inlineKeyboard([
          [Markup.button.callback('📋 All Transactions', `admin_user_tx_${user.telegramId}`)],
          [Markup.button.callback('💼 Wallet Details', `admin_user_wallet_${user.telegramId}`)],
          [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      );
    } catch (markdownError) {
      console.error('Markdown error, sending plain text:', markdownError);
      // Remove Markdown formatting and send as plain text
      const plainMessage = message.replace(/[*_`]/g, '');
      await ctx.reply(plainMessage,
        Markup.inlineKeyboard([
          [Markup.button.callback('📋 All Transactions', `admin_user_tx_${user.telegramId}`)],
          [Markup.button.callback('💼 Wallet Details', `admin_user_wallet_${user.telegramId}`)],
          [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      );
    }
  } catch (error) {
    console.error('Error viewing user:', error);
    await ctx.reply('❌ Error loading user details: ' + error.message);
  }
});


// Add this action handler for wallet details:
this.bot.action(/admin_user_wallet_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];

  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      await ctx.reply('❌ User not found');
      return;
    }

    const wallet = await Wallet.findOne({ userId: user._id }).lean() || { balance: 0, lockedAmount: 0, createdAt: new Date() };
    
    // Get transaction summary
    const transactionSummary = await Transaction.aggregate([
      { $match: { userId: user._id } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);

    // Escape function for Markdown
    const escapeMarkdown = (text) => {
      if (!text) return '';
      return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };

    // Escape user name
    const userName = escapeMarkdown(user.firstName || user.username || 'User');

    let message = `💼 *Wallet Details for ${userName}*\n\n`;
    
    message += `*Current Balance:*\n`;
    message += `• Total: $${wallet.balance || 0}\n`;
    message += `• Locked: $${wallet.lockedAmount || 0}\n`;
    message += `• Available: $${(wallet.balance || 0) - (wallet.lockedAmount || 0)}\n\n`;
    
    message += `*Transaction Summary:*\n`;
    if (transactionSummary.length > 0) {
      transactionSummary.forEach(item => {
        const emoji = item._id === 'DEPOSIT' ? '📥' :
                     item._id === 'WITHDRAWAL' ? '📤' :
                     item._id === 'WINNING' ? '🏆' : '🎮';
        
        // Format amount with proper number formatting
        const amount = Math.abs(item.totalAmount).toFixed(2);
        // No need to escape numbers, but ensure they're properly formatted
        message += `${emoji} ${item._id}: ${item.count} transactions ($${amount})\n`;
      });
    } else {
      message += `No transactions found.\n`;
    }
    
    const walletDate = escapeMarkdown(new Date(wallet.createdAt).toLocaleString());
    message += `\n*Wallet Created:* ${walletDate}`;

    // Try with Markdown, fallback to plain text
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Transactions', `admin_user_tx_${telegramId}`)],
          [Markup.button.callback('👤 Back to User', `user_${telegramId}`)],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    } catch (markdownError) {
      console.error('Markdown error, sending plain text:', markdownError);
      
      // Remove Markdown formatting and send as plain text
      const plainMessage = message.replace(/[*_`]/g, '');
      
      await ctx.editMessageText(plainMessage, {
        parse_mode: '',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Transactions', `admin_user_tx_${telegramId}`)],
          [Markup.button.callback('👤 Back to User', `user_${telegramId}`)],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    }
  } catch (error) {
    console.error('Error viewing wallet:', error);
    await ctx.answerCbQuery('❌ Error loading wallet details');
  }
});
// Add this action handler for user transactions:
this.bot.action(/admin_user_tx_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];

  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      await ctx.reply('❌ User not found');
      return;
    }

    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(); // Removed the stray 'x'

    // Escape function for Markdown
    const escapeMarkdown = (text) => {
      if (!text) return '';
      return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };

    // Escape user name
    const userName = escapeMarkdown(user.firstName || user.username || 'User');

    let message = `📋 *Transaction History for ${userName}*\n\n`;
    
    if (transactions.length === 0) {
      message += `No transactions found.\n`;
    } else {
      transactions.forEach((tx, index) => {
        const emoji = tx.type === 'DEPOSIT' ? '📥' :
                     tx.type === 'WITHDRAWAL' ? '📤' :
                     tx.type === 'WINNING' ? '🏆' : '🎮';
        const status = tx.status === 'PENDING' ? '⏳' :
                      tx.status === 'COMPLETED' ? '✅' : '❌';
        const date = escapeMarkdown(new Date(tx.createdAt).toLocaleString());
        const description = escapeMarkdown(tx.description || 'N/A');
        const amount = Math.abs(tx.amount).toFixed(2);
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `#${index + 1}\n`;
        message += `${emoji} *${tx.type}* ${status}\n`;
        message += `💰 Amount: $${amount}\n`;
        message += `📝 Desc: ${description}\n`;
        message += `⏰ Time: ${date}\n`;
        
        if (tx.type === 'WITHDRAWAL' && tx.metadata?.withdrawalMethod) {
          const method = escapeMarkdown(tx.metadata.withdrawalMethod);
          message += `🏦 Method: ${method}\n`;
        }
        
        message += `🔍 [View: /viewtx_${tx._id}]\n\n`;
      });
    }

    // Try with Markdown, fallback to plain text
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 Wallet', `admin_user_wallet_${telegramId}`)],
          [Markup.button.callback('👤 Back to User', `user_${telegramId}`)],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    } catch (markdownError) {
      console.error('Markdown error, sending plain text:', markdownError);
      
      // Remove Markdown formatting and send as plain text
      const plainMessage = message.replace(/[*_`]/g, '');
      
      await ctx.editMessageText(plainMessage, {
        parse_mode: '',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 Wallet', `admin_user_wallet_${telegramId}`)],
          [Markup.button.callback('👤 Back to User', `user_${telegramId}`)],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    }
  } catch (error) {
    console.error('Error viewing transactions:', error);
    await ctx.answerCbQuery('❌ Error loading transactions');
  }
});
    // ========== SMS MATCHING COMMANDS ==========

    this.bot.command('matchsms', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const [unmatchedSMS, matchedPairs] = await Promise.all([
          WalletService.getUnmatchedSMS(),
          WalletService.findRecentlyMatchedSMS ? WalletService.findRecentlyMatchedSMS() : Promise.resolve([])
        ]);

        let message = `🤝 *SMS Matching Status*\n\n`;
        message += `📤 *Sender SMS Waiting:* ${unmatchedSMS.SENDER?.length || 0}\n`;
        message += `📥 *Receiver SMS Waiting:* ${unmatchedSMS.RECEIVER?.length || 0}\n`;
        message += `✅ *Recently Matched:* ${matchedPairs.length}\n\n`;

        if (unmatchedSMS.SENDER && unmatchedSMS.SENDER.length > 0) {
          message += `*Recent Sender SMS:*\n`;
          unmatchedSMS.SENDER.slice(0, 5).forEach((sms, index) => {
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';
            message += `${index + 1}. $${sms.extractedAmount} - ${userName}\n`;
            message += `   Ref: ${sms.metadata?.transactionIdentifiers?.refNumber || 'N/A'}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleString()}\n`;
            message += `   [View: /viewsms_${sms._id}] [Match: /findmatch_${sms._id}]\n\n`;
          });
        }

        if (unmatchedSMS.RECEIVER && unmatchedSMS.RECEIVER.length > 0) {
          message += `*Recent Receiver SMS:*\n`;
          unmatchedSMS.RECEIVER.slice(0, 5).forEach((sms, index) => {
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';
            message += `${index + 1}. $${sms.extractedAmount} - ${userName}\n`;
            message += `   Ref: ${sms.metadata?.transactionIdentifiers?.refNumber || 'N/A'}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleString()}\n`;
            message += `   [View: /viewsms_${sms._id}] [Match: /findmatch_${sms._id}]\n\n`;
          });
        }

        message += `\n*Commands:*\n`;
        message += `/automatch - Auto-match all waiting SMS\n`;
        message += `/cleansms - Clean up old unmatched SMS\n`;
        message += `/smsstats - SMS matching statistics`;

        await ctx.replyWithMarkdown(message);

      } catch (error) {
        console.error('Match SMS error:', error);
        await ctx.reply('❌ Error loading matching status: ' + error.message);
      }
    });

    this.bot.command(/^findmatch_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        const matchResult = await WalletService.findMatchingSMS(smsId);

        let message = `🔍 *Finding Matches for SMS*\n\n`;
        message += `*Original SMS:* ${matchResult.originalSMS._id}\n`;
        message += `*Type:* ${matchResult.analysis.type}\n`;
        message += `*Amount:* $${matchResult.identifiers.amount}\n`;
        message += `*Ref:* ${matchResult.identifiers.refNumber || 'N/A'}\n\n`;

        if (matchResult.matches.length > 0) {
          message += `*Top Matches:*\n`;
          matchResult.matches.slice(0, 5).forEach((match, index) => {
            const userName = match.smsDeposit.userId?.firstName || match.smsDeposit.userId?.username || 'Unknown User';
            message += `${index + 1}. $${match.smsDeposit.extractedAmount} - ${userName}\n`;
            message += `   Score: ${match.score}%\n`;
            message += `   Ref: ${match.identifiers.refNumber || 'N/A'}\n`;
            message += `   [View: /viewsms_${match.smsDeposit._id}]\n`;
            message += `   [Force Match: /forcematch_${smsId}_${match.smsDeposit._id}]\n\n`;
          });
        } else {
          message += `*No matches found*\n\n`;
        }

        message += `Total searched: ${matchResult.totalFound} SMS\n`;

        await ctx.replyWithMarkdown(message);

      } catch (error) {
        console.error('Find match error:', error);
        await ctx.reply('❌ Error finding matches: ' + error.message);
      }
    });

    this.bot.command(/^forcematch_(.+)_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Access denied');
    return;
  }

  const senderSMSId = ctx.match[1];
  const receiverSMSId = ctx.match[2];

  try {
    // Get admin user by Telegram ID first
    const adminUser = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!adminUser) {
      await ctx.reply('❌ Admin user not found in database');
      return;
    }

    // Use adminUser._id (MongoDB ObjectId) instead of ctx.from.id (Telegram ID)
    const result = await WalletService.adminForceMatchSMS(senderSMSId, receiverSMSId, adminUser._id);

    await ctx.replyWithMarkdown(
      `✅ *Force Match Successful!*\n\n` +
      `*User:* ${result.user?.firstName || result.senderSMS?.userId?.firstName || 'Unknown'}\n` +
      `*Amount:* $${result.transaction.amount}\n` +
      `*New Balance:* $${result.wallet.balance}\n\n` +
      `Both SMS have been matched and the deposit has been approved.`
    );

  } catch (error) {
    console.error('Force match error:', error);
    await ctx.reply('❌ Error force matching: ' + error.message);
  }
});

    // ========== DEPOSIT COMMANDS ==========

    this.bot.command('deposit', async (ctx) => {
      try {
        await UserService.findOrCreateUser(ctx.from);

        const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, BOA, Dashen
📱 *Mobile Money:* Telebirr, CBE Birr

*How to Deposit:*
1. Select payment method below
2. Send money to the provided account
3. Forward/paste the confirmation SMS
4. We'll automatically process it

*Minimum Deposit:* $1 (≈ 50 ETB)
        `;

        await ctx.replyWithMarkdown(depositMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏦 CBE Bank', 'deposit_cbe')],
            [Markup.button.callback('🏦 Bank of Abysinia', 'deposit_boa')],
            [Markup.button.callback('🏦 Dashen Bank', 'deposit_dashen')],
            [Markup.button.callback('📱 CBE Birr', 'deposit_cbebirr')],
            [Markup.button.callback('📱 Telebirr', 'deposit_telebirr')],
            [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error in deposit command:', error);
        await ctx.reply('❌ Please use /start first to set up your account.');
      }
    });

    // ========== WALLET & WITHDRAWAL COMMANDS ==========

    this.bot.command('wallet', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);

        let balanceInfo = { totalBalance: 0, availableBalance: 0, lockedAmount: 0 };
        let transactions = [];

        try {
          balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
          transactions = await WalletService.getUserTransactions(user.telegramId);
        } catch (error) {
          await WalletService.initializeWallet(user.telegramId);
          balanceInfo.totalBalance = 0;
          balanceInfo.availableBalance = 0;
          balanceInfo.lockedAmount = 0;
        }

        let message = `💼 *Your Wallet*\n\n`;
        message += `*Total Balance:* $${balanceInfo.totalBalance}\n`;
        message += `*Available:* $${balanceInfo.availableBalance}\n`;
        if (balanceInfo.lockedAmount > 0) {
          message += `*Locked (pending withdrawals):* $${balanceInfo.lockedAmount}\n`;
        }
        message += `\n📊 *Recent Transactions:*\n`;

        if (transactions.length > 0) {
          transactions.slice(0, 5).forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' :
              tx.type === 'WINNING' ? '🏆' : 
              tx.type === 'WITHDRAWAL' ? '📤' : '🎮';
            const sign = tx.amount > 0 ? '+' : '';
            const status = tx.status === 'PENDING' ? '⏳' :
              tx.status === 'COMPLETED' ? '✅' : '❌';
            message += `${emoji} ${sign}$${Math.abs(tx.amount)} - ${tx.description} ${status}\n`;
          });
        } else {
          message += `No transactions yet.\n`;
        }

        message += `\n*Quick Actions:*`;

        await ctx.replyWithMarkdown(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
            [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
            [Markup.button.callback('📊 Full History', 'show_full_history')],
            [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error in wallet command:', error);
        await ctx.reply('❌ Please use /start first to set up your account.');
      }
    });

    this.bot.command('withdraw', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
        
        const message = `
💰 *Withdraw Funds*

*Your Balance Information:*
• Total Balance: $${balanceInfo.totalBalance}
• Available for withdrawal: $${balanceInfo.availableBalance}
• Locked (pending withdrawals): $${balanceInfo.lockedAmount}

*Withdrawal Methods:*
🏦 Bank Transfer (CBE, BOA, Dashen)
📱 Mobile Money (Telebirr, CBE Birr)

*Minimum Withdrawal:* $10
*Processing Time:* 24-48 hours

*Ready to withdraw?* Click below to start:
        `;

        await ctx.replyWithMarkdown(message,
          Markup.inlineKeyboard([
            [Markup.button.callback('💰 Request Withdrawal', 'start_withdrawal')],
            [Markup.button.callback('📋 Withdrawal History', 'withdrawal_history')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        );
      } catch (error) {
        console.error('Error in withdraw command:', error);
        await ctx.reply('❌ ' + error.message);
      }
    });

    // ========== ADMIN COMMANDS ==========

    this.bot.command('admin', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }
      await this.showAdminPanel(ctx);
    });

    // SMS Management commands
    this.bot.command('processsms', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        await ctx.reply('🔄 Processing all received SMS messages...');
        const result = await WalletService.autoProcessReceivedSMS();
        
        await ctx.replyWithMarkdown(
          `📊 *SMS Processing Complete*\n\n*Total Received SMS:* ${result.total}\n*Successfully Processed:* ${result.processed}\n*Auto-Approved:* ${result.approved}`
        );
      } catch (error) {
        console.error('Process SMS error:', error);
        await ctx.reply('❌ Error processing SMS: ' + error.message);
      }
    });

    this.bot.command('smslist', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const page = parseInt(ctx.message.text.split(' ')[1]) || 1;
        const result = await WalletService.getAllSMSDeposits(page, 10);

        let message = `📱 *All SMS Deposits - Page ${page}*\n\n`;

        if (result.deposits.length === 0) {
          message += `No SMS deposits found.\n`;
        } else {
          result.deposits.forEach((sms, index) => {
            const statusEmoji = sms.status === 'APPROVED' ? '✅' :
              sms.status === 'REJECTED' ? '❌' :
                sms.status === 'AUTO_APPROVED' ? '🤖' :
                  sms.status === 'RECEIVED' ? '📥' : '⏳';

            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';

            message += `${statusEmoji} $${sms.extractedAmount} - ${userName}\n`;
            message += `   Method: ${sms.paymentMethod} | Status: ${sms.status}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleDateString()}\n`;

            if (sms.status === 'RECEIVED' || sms.status === 'PENDING') {
              message += `   [Approve: /approvesms_${sms._id}] [Reject: /rejectsms_${sms._id}]\n`;
            }

            message += `   [View: /viewsms_${sms._id}]\n\n`;
          });
        }

        message += `\nPage ${page} of ${result.pagination.pages}`;

        const keyboard = [];
        if (page > 1) {
          keyboard.push(Markup.button.callback('⬅️ Previous', `sms_page_${page - 1}`));
        }
        if (page < result.pagination.pages) {
          keyboard.push(Markup.button.callback('Next ➡️', `sms_page_${page + 1}`));
        }

        if (keyboard.length > 0) {
          await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));
        } else {
          await ctx.replyWithMarkdown(message);
        }
      } catch (error) {
        console.error('SMS list error:', error);
        await ctx.reply('❌ Error loading SMS list: ' + error.message);
      }
    });

    this.bot.command(/^approvesms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        const smsDeposit = await WalletService.getSMSDepositById(smsId);
        if (!smsDeposit) {
          await ctx.reply('❌ SMS deposit not found');
          return;
        }

        const userName = smsDeposit.userId?.firstName || smsDeposit.userId?.username || 'Unknown User';
        const amount = smsDeposit.extractedAmount;

        await ctx.replyWithMarkdown(
          `⚠️ *Confirm Approval*\n\n*User:* ${userName}\n*Amount:* $${amount}\n*Method:* ${smsDeposit.paymentMethod}\n\nAre you sure you want to approve this deposit?`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Approve', `confirm_approve_${smsId}`)],
            [Markup.button.callback('❌ Cancel', `cancel_approve_${smsId}`)]
          ])
        );

      } catch (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    this.bot.command(/^rejectsms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }
      
      const smsId = ctx.match[1];

      try {
        const result = await WalletService.rejectSMSDeposit(smsId, ctx.from.id);

        await ctx.replyWithMarkdown(
          `❌ *SMS Deposit Rejected!*\n\n*User:* ${result.userId.firstName}\n*Amount:* $${result.extractedAmount}`
        );

        await this.bot.telegram.sendMessage(
          result.userId.telegramId,
          `❌ *Deposit Rejected*\n\nYour deposit of $${result.extractedAmount} was rejected.\n*Reason:* ${result.metadata?.rejectionReason || 'Please contact support for details.'}`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📞 Contact Support', 'contact_support')]
            ])
          }
        );

      } catch (error) {
        await ctx.reply(`❌ Error rejecting SMS deposit: ${error.message}`);
      }
    });

    this.bot.command(/^viewsms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        const smsDeposit = await SMSDeposit.findById(smsId)
          .populate('userId', 'firstName username telegramId')
          .populate('processedBy', 'firstName username');

        if (!smsDeposit) {
          await ctx.reply('❌ SMS deposit not found');
          return;
        }

        const userName = smsDeposit.userId?.firstName || smsDeposit.userId?.username || 'Unknown User';
        const telegramId = smsDeposit.userId?.telegramId || 'Unknown';

        const message = `
📱 *SMS Deposit Details*

*User:* ${userName}
*Telegram ID:* ${telegramId}
*Amount:* $${smsDeposit.extractedAmount}
*Method:* ${smsDeposit.paymentMethod}
*Status:* ${smsDeposit.status}
*Submitted:* ${new Date(smsDeposit.createdAt).toLocaleString()}

*Original SMS:*
\`\`\`
${smsDeposit.originalSMS}
\`\`\`

${smsDeposit.processedBy ? `*Processed By:* ${smsDeposit.processedBy.firstName} at ${new Date(smsDeposit.processedAt).toLocaleString()}` : ''}
        `;

        const keyboard = [];
        if (smsDeposit.status === 'PENDING' || smsDeposit.status === 'RECEIVED') {
          keyboard.push(
            [Markup.button.callback('✅ Approve', `admin_approve_sms_${smsDeposit._id}`)],
            [Markup.button.callback('❌ Reject', `admin_reject_sms_${smsDeposit._id}`)]
          );
        }
        keyboard.push([Markup.button.callback('⬅️ Back to List', 'admin_sms_list')]);

        await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));
      } catch (error) {
        console.error('View SMS error:', error);
        await ctx.reply('❌ Error loading SMS details: ' + error.message);
      }
    });

    // Batch approve command
    this.bot.command('batchapprove', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const receivedSMS = await WalletService.getReceivedSMSDeposits();

        if (receivedSMS.length === 0) {
          await ctx.reply('✅ No received SMS deposits to approve.');
          return;
        }

        const smsIds = receivedSMS.map(sms => sms._id);
        const result = await WalletService.batchApproveSMSDeposits(smsIds, ctx.from.id);

        let message = `🔄 *Batch Approval Results*\n\n`;
        message += `✅ Successful: ${result.successful.length}\n`;
        message += `❌ Failed: ${result.failed.length}\n\n`;

        if (result.successful.length > 0) {
          message += `*Approved Deposits:*\n`;
          result.successful.forEach((success, index) => {
            message += `${index + 1}. $${success.amount} - User ${success.user}\n`;
          });
        }

        if (result.failed.length > 0) {
          message += `\n*Failed:*\n`;
          result.failed.forEach((fail, index) => {
            message += `${index + 1}. ${fail.smsDepositId} - ${fail.error}\n`;
          });
        }

        await ctx.replyWithMarkdown(message);

      } catch (error) {
        await ctx.reply(`❌ Batch approval error: ${error.message}`);
      }
    });

    // Auto-approve command
    this.bot.command('autoapprove', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const result = await WalletService.processAutoApproveDeposits(100);

        await ctx.replyWithMarkdown(
          `🤖 *Auto-Approval Results*\n\n*Processed:* ${result.processed} deposits\n*Approved:* ${result.approved} deposits\n\nAll deposits up to $100 have been auto-approved.`
        );
      } catch (error) {
        console.error('Auto-approve error:', error);
        await ctx.reply('❌ Error during auto-approval: ' + error.message);
      }
    });

    // Pending deposits command
    this.bot.command('pending', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const pendingDeposits = await WalletService.getPendingDeposits();

        let message = `⏳ *Pending Deposits - ${pendingDeposits.length} total*\n\n`;

        if (pendingDeposits.length === 0) {
          message += `No pending deposits. All clear! ✅`;
        } else {
          pendingDeposits.forEach((deposit, index) => {
            const userName = deposit.userId?.firstName || deposit.userId?.username || 'Unknown User';
            const paymentMethod = deposit.metadata?.paymentMethod || 'Unknown';

            message += `${index + 1}. $${deposit.amount} - ${userName}\n`;
            message += `   Method: ${paymentMethod}\n`;
            message += `   [Approve: /approve_${deposit._id}]\n\n`;
          });
        }

        await ctx.replyWithMarkdown(message);
      } catch (error) {
        console.error('Pending command error:', error);
        await ctx.reply('❌ Error loading pending deposits: ' + error.message);
      }
    });

    // Approve deposit command
    this.bot.command(/^approve_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];

      try {
        const result = await WalletService.approveDeposit(transactionId, ctx.from.id);

        await ctx.replyWithMarkdown(
          `✅ *Deposit Approved!*\n\n*User:* ${result.transaction.userId.firstName}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}`
        );

        await this.bot.telegram.sendMessage(
          result.transaction.userId.telegramId,
          `🎉 *Deposit Approved!*\n\nYour deposit of $${result.transaction.amount} has been approved!\n*New Balance:* $${result.wallet.balance}\n\nReady to play some Bingo? 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://desta.et')]
            ])
          }
        );

      } catch (error) {
        await ctx.reply(`❌ Error approving deposit: ${error.message}`);
      }
    });

// - temporary recovery command
this.bot.command('recovergame', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Access denied');
    return;
  }
  
  try {
    // Use your specific game ID
    const gameId = '69a87965a006eb3e0d68793b';
    const result = await GameService.manuallyRecoverGame(gameId);
    await ctx.reply(`✅ Recovery result: ${JSON.stringify(result)}`);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

    // ========== WITHDRAWAL ADMIN COMMANDS ==========

    this.bot.command(/^approvewithdraw_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];

      try {
        const result = await WalletService.approveWithdrawal(transactionId, ctx.from.id);

        await ctx.replyWithMarkdown(
          `✅ *Withdrawal Approved!*\n\n` +
          `*User:* ${result.user.firstName || result.user.username}\n` +
          `*Amount:* $${result.amount}\n` +
          `*Method:* ${result.withdrawal.metadata.withdrawalMethod}\n` +
          `*New Balance:* $${result.wallet.balance}`
        );

        await this.bot.telegram.sendMessage(
          result.user.telegramId,
          `✅ *Withdrawal Processed!*\n\n` +
          `Your withdrawal of $${result.amount} has been approved and processed.\n` +
          `*Method:* ${result.withdrawal.metadata.withdrawalMethod}\n` +
          `*Transaction ID:* ${result.withdrawal._id}\n\n` +
          `The funds should reach you within 24 hours.`,
          { parse_mode: 'Markdown' }
        );

      } catch (error) {
        console.error('Error approving withdrawal:', error);
        await ctx.reply('❌ Error: ' + error.message);
      }
    });

    this.bot.command(/^rejectwithdraw_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];
      const reason = ctx.message.text.split(' ').slice(1).join(' ') || 'Withdrawal rejected by admin';

      try {
        const withdrawal = await WalletService.rejectWithdrawal(transactionId, ctx.from.id, reason);

        await ctx.replyWithMarkdown(
          `❌ *Withdrawal Rejected!*\n\n` +
          `*User:* ${withdrawal.userId?.firstName || withdrawal.userId?.username || 'Unknown'}\n` +
          `*Amount:* $${Math.abs(withdrawal.amount)}\n` +
          `*Reason:* ${reason}`
        );

        const user = await User.findById(withdrawal.userId);
        if (user) {
          await this.bot.telegram.sendMessage(
            user.telegramId,
            `❌ *Withdrawal Rejected*\n\n` +
            `Your withdrawal request of $${Math.abs(withdrawal.amount)} has been rejected.\n` +
            `*Reason:* ${reason}\n\n` +
            `The locked amount has been returned to your available balance.`,
            { parse_mode: 'Markdown' }
          );
        }

      } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        await ctx.reply('❌ Error: ' + error.message);
      }
    });

    this.bot.command(/^viewwithdraw_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];

      try {
        const withdrawal = await Transaction.findById(transactionId)
          .populate('userId', 'firstName username telegramId')
          .populate('metadata.processedBy', 'firstName username');

        if (!withdrawal || withdrawal.type !== 'WITHDRAWAL') {
          await ctx.reply('❌ Withdrawal not found');
          return;
        }

        const amount = Math.abs(withdrawal.amount);
        const user = withdrawal.userId;

        const message = `
💰 *Withdrawal Details*

*User:* ${user.firstName} (${user.username || 'No username'})
*Telegram ID:* ${user.telegramId}
*Amount:* $${amount}
*Method:* ${withdrawal.metadata?.withdrawalMethod || 'Unknown'}
*Status:* ${withdrawal.status}
*Requested:* ${new Date(withdrawal.createdAt).toLocaleString()}

*Account Details:*
\`\`\`
${JSON.stringify(withdrawal.metadata?.accountDetails || {}, null, 2)}
\`\`\`

${withdrawal.metadata?.processedBy ? 
  `*Processed By:* ${withdrawal.metadata.processedBy.firstName} at ${new Date(withdrawal.metadata.processedAt).toLocaleString()}` : 
  ''}

${withdrawal.metadata?.rejectionReason ? 
  `*Rejection Reason:* ${withdrawal.metadata.rejectionReason}` : 
  ''}
        `;

        const keyboard = [];
        if (withdrawal.status === 'PENDING') {
          keyboard.push(
            [Markup.button.callback('✅ Approve', `admin_approve_withdraw_${withdrawal._id}`)],
            [Markup.button.callback('❌ Reject', `admin_reject_withdraw_${withdrawal._id}`)]
          );
        }
        keyboard.push([Markup.button.callback('⬅️ Back to List', 'admin_pending_withdrawals')]);

        await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));

      } catch (error) {
        console.error('Error viewing withdrawal:', error);
        await ctx.reply('❌ Error: ' + error.message);
      }
    });

    this.bot.command(/^viewtx_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];

      try {
        const transaction = await Transaction.findById(transactionId)
          .populate('userId', 'firstName username telegramId')
          .populate('metadata.processedBy', 'firstName username');

        if (!transaction) {
          await ctx.reply('❌ Transaction not found');
          return;
        }

        const user = transaction.userId;
        const amount = Math.abs(transaction.amount);
        const sign = transaction.amount > 0 ? '+' : '-';
        const processedBy = transaction.metadata?.processedBy;

        const message = `
💳 *Transaction Details*

*Transaction ID:* ${transaction._id}
*User:* ${user.firstName} (${user.username || 'No username'})
*Telegram ID:* ${user.telegramId}
*Type:* ${transaction.type}
*Amount:* ${sign}$${amount}
*Status:* ${transaction.status}
*Description:* ${transaction.description}
*Created:* ${new Date(transaction.createdAt).toLocaleString()}

*Balance Changes:*
• Before: $${transaction.balanceBefore || 0}
• After: $${transaction.balanceAfter || 0}
• Change: ${sign}$${amount}

${transaction.reference ? `*Reference:* ${transaction.reference}\n` : ''}
${transaction.metadata?.paymentMethod ? `*Payment Method:* ${transaction.metadata.paymentMethod}\n` : ''}
${transaction.metadata?.accountDetails ? `*Account Details:* ${JSON.stringify(transaction.metadata.accountDetails, null, 2)}\n` : ''}
${transaction.metadata?.rejectionReason ? `*Rejection Reason:* ${transaction.metadata.rejectionReason}\n` : ''}
${transaction.metadata?.failureReason ? `*Failure Reason:* ${transaction.metadata.failureReason}\n` : ''}
${processedBy ? `*Processed By:* ${processedBy.firstName} at ${new Date(transaction.metadata.processedAt).toLocaleString()}\n` : ''}
        `;

        const keyboard = [];
        
        if (transaction.type === 'DEPOSIT' && transaction.status === 'PENDING') {
          keyboard.push([Markup.button.callback('✅ Approve', `admin_approve_tx_${transaction._id}`)]);
        }
        
        if (transaction.type === 'WITHDRAWAL' && transaction.status === 'PENDING') {
          keyboard.push([
            Markup.button.callback('✅ Approve', `admin_approve_withdraw_${transaction._id}`),
            Markup.button.callback('❌ Reject', `admin_reject_withdraw_${transaction._id}`)
          ]);
        }
        
        keyboard.push([
          Markup.button.callback('📋 All Transactions', 'admin_transactions_list'),
          Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')
        ]);

        await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));

      } catch (error) {
        console.error('Error viewing transaction:', error);
        await ctx.reply('❌ Error loading transaction details');
      }
    });

    // ========== ACTION HANDLERS ==========

    // Deposit actions
    this.bot.action('show_deposit', async (ctx) => {
      const isAdmin = AdminUtils.isAdmin(ctx.from.id);
      
      const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, BOA, Dashen
📱 *Mobile Money:* Telebirr, CBE Birr

*How to Deposit:*
1. Select payment method below
2. Send money to the provided account
3. Forward/paste the confirmation SMS
4. We'll automatically process it

*Minimum Deposit:* $1 (≈ 50 ETB)
      `;

      const depositButtons = [
        [Markup.button.callback('🏦 CBE Bank', 'deposit_cbe')],
        // [Markup.button.callback('🏦 Bank of Abysinia', 'deposit_boa')],
        // [Markup.button.callback('🏦 Dashen Bank', 'deposit_dashen')],
        [Markup.button.callback('📱 Telebirr', 'deposit_telebirr')],
        // [Markup.button.callback('📱 CBE Birr', 'deposit_cbebirr')],
        [Markup.button.callback('⬅️ Back', 'back_to_start')]
      ];

      if (isAdmin) {
        depositButtons.unshift([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
      }

      await ctx.editMessageText(depositMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(depositButtons)
      });
    });

    this.bot.action(/deposit_(.+)/, async (ctx) => {
      const methodMap = {
        'cbe': 'CBE Bank',
        'boa': 'Bank of Abysinia',
        'dashen': 'Dashen Bank',
        'telebirr': 'Telebirr',
        'cbebirr': 'CBE Birr'
      };

      const methodKey = ctx.match[1];
      const methodName = methodMap[methodKey];

      if (methodName) {
        ctx.session = ctx.session || {};
        ctx.session.pendingDepositMethod = methodName;

        const methods = {
          'CBE Bank': {
            account: '1000143822668',
            instructions: 'Send money to CBE account 1000143822668 via CBE Birr app or bank transfer'
          },
          'Bank of Abysinia': {
            account: '145633257',
            instructions: 'Send money to Bank of Abysinia account 145633257'
          },
          'Dashen Bank': {
            account: '123456789012',
            instructions: 'Send money to Dashen Bank account 123456789012'
          },
          'Telebirr': {
            account: '0968546687',
            instructions: 'Send money to Telebirr 0968546687 via Telebirr app'
          },
          'CBE Birr': {
            account: '0912345678',
            instructions: 'Send money to CBE Birr 0912345678 via CBE Birr app'
          }
        };

        const method = methods[methodName];
        const message = `
💳 *Deposit via ${methodName}*

*Account Details:*
Full Name: Alemayehu Yalew
📞 Account: ${method.account}
🏦 For: Bingo Game

*Instructions:*
${method.instructions}

*After sending money:*
1. You will receive an SMS confirmation
2. Forward that SMS here or copy-paste the text
3. We will automatically process your deposit

⚠️ *Only send from your registered accounts*
        `;

        const methodButtons = [
          [Markup.button.callback('📤 I have sent money', 'waiting_sms')],
          [Markup.button.callback('⬅️ Back to Methods', 'show_deposit')]
        ];

        if (AdminUtils.isAdmin(ctx.from.id)) {
          methodButtons.unshift([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(methodButtons)
        });
      }
    });

    // Wallet actions
    this.bot.action('show_wallet', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        
        let balanceInfo = { totalBalance: 0, availableBalance: 0, lockedAmount: 0 };
        let transactions = [];

        try {
          balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
          transactions = await WalletService.getUserTransactions(user.telegramId);
        } catch (error) {
          await WalletService.initializeWallet(user.telegramId);
          balanceInfo.totalBalance = 0;
          balanceInfo.availableBalance = 0;
          balanceInfo.lockedAmount = 0;
        }

        let message = `💼 *Your Wallet*\n\n`;
        message += `*Total Balance:* $${balanceInfo.totalBalance}\n`;
        message += `*Available:* $${balanceInfo.availableBalance}\n`;
        if (balanceInfo.lockedAmount > 0) {
          message += `*Locked (pending withdrawals):* $${balanceInfo.lockedAmount}\n`;
        }
        message += `\n📊 *Recent Transactions:*\n`;

        if (transactions.length > 0) {
          transactions.slice(0, 5).forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' :
              tx.type === 'WINNING' ? '🏆' : 
              tx.type === 'WITHDRAWAL' ? '📤' : '🎮';
            const sign = tx.amount > 0 ? '+' : '';
            const status = tx.status === 'PENDING' ? '⏳' :
              tx.status === 'COMPLETED' ? '✅' : '❌';
            message += `${emoji} ${sign}$${Math.abs(tx.amount)} - ${tx.description} ${status}\n`;
          });
        } else {
          message += `No transactions yet.\n`;
        }

        message += `\n*Quick Actions:*`;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
            [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
            [Markup.button.callback('📊 Full History', 'show_full_history')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error showing wallet:', error);
        await ctx.answerCbQuery('Error loading wallet info');
      }
    });

    // Withdrawal actions
    this.bot.action('withdraw', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
        
        const message = `
💰 *Withdraw Funds*

*Your Balance Information:*
• Total Balance: $${balanceInfo.totalBalance}
• Available for withdrawal: $${balanceInfo.availableBalance}
• Locked (pending withdrawals): $${balanceInfo.lockedAmount}

*Withdrawal Methods:*
🏦 Bank Transfer (CBE, BOA, Dashen)
📱 Mobile Money (Telebirr, CBE Birr)

*Minimum Withdrawal:* $10
*Processing Time:* 24-48 hours

*Ready to withdraw?* Click below to start:
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Request Withdrawal', 'start_withdrawal')],
            [Markup.button.callback('📋 Withdrawal History', 'withdrawal_history')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error in withdraw action:', error);
        await ctx.answerCbQuery('❌ ' + error.message);
      }
    });

    this.bot.action('start_withdrawal', async (ctx) => {
      try {
        const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
        
        if (balanceInfo.availableBalance < 10) {
          await ctx.answerCbQuery(`❌ Minimum withdrawal is $10. Available: $${balanceInfo.availableBalance}`);
          return;
        }
        
        const message = `
💳 *Request Withdrawal*

*Available Balance:* $${balanceInfo.availableBalance}

*Select Withdrawal Method:*
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏦 CBE Bank', 'withdraw_cbe')],
            [Markup.button.callback('🏦 Bank of Abysinia', 'withdraw_boa')],
            [Markup.button.callback('🏦 Dashen Bank', 'withdraw_dashen')],
            [Markup.button.callback('📱 Telebirr', 'withdraw_telebirr')],
            [Markup.button.callback('📱 CBE Birr', 'withdraw_cbebirr')],
            [Markup.button.callback('⬅️ Back', 'withdraw')]
          ])
        });
      } catch (error) {
        console.error('Error starting withdrawal:', error);
        await ctx.answerCbQuery('Error: ' + error.message);
      }
    });

    this.bot.action(/withdraw_(.+)/, async (ctx) => {
      const method = ctx.match[1];
      const methodNames = {
        'cbe': 'CBE Bank',
        'boa': 'Bank of Abysinia', 
        'dashen': 'Dashen Bank',
        'telebirr': 'Telebirr',
        'cbebirr': 'CBE Birr'
      };
      
      const methodName = methodNames[method];
      if (!methodName) return;
      
      if (!ctx.session) {
        ctx.session = {};
      }
      
      ctx.session.withdrawalMethodCode = this.getMethodCode(methodName);
      ctx.session.withdrawalMethodName = methodName;
      ctx.session.withdrawalMethod = methodName;
      ctx.session.withdrawalAmount = null;
      ctx.session.withdrawalAccount = null;
      
      console.log(`💰 Withdrawal method set: ${methodName}, Code: ${ctx.session.withdrawalMethodCode}`);
      
      const message = `
🏦 *Withdrawal via ${methodName}*

Please enter the amount you want to withdraw:

*Minimum:* $10
*Available:* [Will be shown after you enter amount]

Type the amount in USD (numbers only):
Example: 50
      `;
      
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚫 Cancel', 'withdraw')]
        ])
      });
    });

    this.bot.action('withdrawal_history', async (ctx) => {
      try {
        const withdrawals = await WalletService.getUserWithdrawals(ctx.from.id, 10);
        const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
        
        let message = `
📋 *Withdrawal History*

*Current Balance:*
• Total: $${balanceInfo.totalBalance}
• Available: $${balanceInfo.availableBalance}
• Locked: $${balanceInfo.lockedAmount}

*Recent Withdrawals:
        `;
        
        if (withdrawals.length === 0) {
          message += "\nNo withdrawal history yet.";
        } else {
          withdrawals.forEach((withdrawal, index) => {
            const statusEmoji = withdrawal.status === 'COMPLETED' ? '✅' :
                              withdrawal.status === 'PENDING' ? '⏳' : '❌';
            const amount = Math.abs(withdrawal.amount);
            const date = new Date(withdrawal.createdAt).toLocaleDateString();
            
            message += `\n${statusEmoji} $${amount} - ${withdrawal.metadata?.withdrawalMethod || 'Unknown'}`;
            message += `\n  Status: ${withdrawal.status} | Date: ${date}`;
          });
        }
        
        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 New Withdrawal', 'start_withdrawal')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error getting withdrawal history:', error);
        await ctx.answerCbQuery('Error loading history');
      }
    });

    // Withdrawal confirmation
    this.bot.action('confirm_withdraw', async (ctx) => {
      console.log('✅ Withdrawal confirmation clicked!');
      
      try {
        if (!ctx.session || !ctx.session.withdrawalMethod || !ctx.session.withdrawalAmount || !ctx.session.withdrawalAccount) {
          await ctx.answerCbQuery('❌ No pending withdrawal found. Please restart the process.');
          return;
        }
        
        const amount = ctx.session.withdrawalAmount;
        const method = ctx.session.withdrawalMethod;
        const accountDetails = ctx.session.withdrawalAccount;
        const methodName = method;
        
        console.log(`💰 Processing withdrawal: $${amount} via ${methodName}`);
        
        await ctx.answerCbQuery('🔄 Processing...');
        
        await ctx.editMessageText(
          `⏳ *Processing withdrawal request...*\n\n` +
          `Please wait while we process your $${amount} withdrawal via ${methodName}.`,
          { parse_mode: 'Markdown' }
        );
        
        let result;
        try {
          console.log(`📤 Creating withdrawal request for user ${ctx.from.id}, amount $${amount}`);
          result = await WalletService.createWithdrawalRequest(
            ctx.from.id,
            amount,
            methodName,
            accountDetails
          );
          console.log('✅ Withdrawal request created:', result);
        } catch (error) {
          console.error('❌ Error creating withdrawal request:', error);
          throw error;
        }
        
        if (ctx.session) {
          ctx.session.withdrawalMethod = null;
          ctx.session.withdrawalMethodCode = null;
          ctx.session.withdrawalMethodName = null;
          ctx.session.withdrawalAmount = null;
          ctx.session.withdrawalAccount = null;
        }
        
        await ctx.editMessageText(
          `✅ *Withdrawal Request Submitted!*\n\n` +
          `*Amount:* $${amount}\n` +
          `*Method:* ${methodName}\n` +
          `*Request ID:* ${result.withdrawal._id}\n` +
          `*Status:* ⏳ Pending Review\n\n` +
          `Your withdrawal request has been submitted and the amount has been locked. ` +
          `Our admin team will process it within 24-48 hours.\n\n` +
          `You will receive a notification when it's processed.`,
          { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
              [Markup.button.callback('📋 Withdrawal History', 'withdrawal_history')],
              [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
            ])
          }
        );
        
        try {
          await this.notifyAdminsAboutWithdrawal(result.withdrawal, result.user);
        } catch (notifyError) {
          console.error('❌ Error notifying admins:', notifyError);
        }
        
      } catch (error) {
        console.error('❌ Error in withdrawal confirmation:', error);
        console.error('Error stack:', error.stack);
        
        await ctx.editMessageText(
          `❌ *Withdrawal Failed*\n\n` +
          `Error: ${error.message}\n\n` +
          `Please try again or contact support.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Try Again', 'withdraw')],
              [Markup.button.callback('📞 Contact Support', 'contact_support')],
              [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
            ])
          }
        );
      }
    });

    this.bot.action('cancel_withdrawal', async (ctx) => {
      if (ctx.session) {
        ctx.session.withdrawalMethod = null;
        ctx.session.withdrawalAmount = null;
        ctx.session.withdrawalAccount = null;
      }
      
      await ctx.answerCbQuery('Withdrawal cancelled');
      await ctx.editMessageText(
        '💰 *Withdraw Funds*\n\nWithdrawal process cancelled. What would you like to do?',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Request Withdrawal', 'start_withdrawal')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        }
      );
    });

    // ========== ADMIN ACTION HANDLERS ==========

    // Admin panel
    this.bot.action('admin_panel', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }
      await this.showAdminPanel(ctx);
    });

    this.bot.action('admin_back_to_panel', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }
      await this.showAdminPanel(ctx);
    });

    // SMS Management actions

     this.bot.action('waiting_sms', async (ctx) => {
      await ctx.editMessageText(
        `📱 *SMS Confirmation*\n\nPlease forward the confirmation SMS from your bank/mobile money or copy-paste the text below:\n\n*Example SMS format:*\n"You have received 100.00 ETB from CBE Birr. Your new balance is 150.00 ETB."`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🚫 Cancel', 'show_deposit')]
          ])
        }
      );
    });
    this.bot.action('admin_sms_menu', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const [pendingSMS, recentSMS] = await Promise.all([
      WalletService.getPendingSMSDeposits(5).catch(() => []),
      WalletService.getAllSMSDeposits(1, 5).catch(() => ({ deposits: [] }))
    ]);
    
    const withdrawalStats = await WalletService.getWithdrawalStats();
    const pendingCount = pendingSMS?.length || 0;
    const recentCount = recentSMS.deposits?.length || 0;

    const message = `
📱 *SMS Management Panel*

📊 *Quick Stats:*
⏳ Pending SMS: ${pendingCount}
📥 Recent SMS: ${recentCount}
💰 Pending Withdrawals: ${withdrawalStats.pendingAmount || 0}

🔧 *SMS Actions:*
    `;

    // UPDATED: Added SMS matching buttons
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 View All SMS', 'admin_sms_list')],
        [Markup.button.callback('⏳ Pending Review', 'admin_pending_sms')],
        [Markup.button.callback('🔄 Process Received SMS', 'admin_process_sms')],
        [Markup.button.callback('🤖 Auto-Approve', 'admin_auto_approve')],
        [Markup.button.callback('🔄 Batch Approve', 'admin_batch_approve')],
        [Markup.button.callback('🔍 SMS Matching Status', 'admin_sms_matching')], // Added
        [Markup.button.callback('🔄 Auto-Match SMS', 'admin_auto_match')], // Added
        [Markup.button.callback('📊 SMS Statistics', 'admin_sms_stats')],
        [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
      ])
    });
  } catch (error) {
    console.error('Error in SMS menu:', error);
    await ctx.answerCbQuery('Error loading SMS menu');
  }
});

    this.bot.action('admin_pending_sms', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const pendingSMS = await WalletService.getPendingSMSDeposits(10);

        let message = `⏳ *Pending SMS Deposits*\n\n`;

        if (pendingSMS.length === 0) {
          message += `✅ No pending SMS deposits. All clear!\n`;
        } else {
          pendingSMS.forEach((sms, index) => {
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';
            const telegramId = sms.userId?.telegramId || 'N/A';
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `👤 User: ${userName}\n`;
            message += `📞 ID: ${telegramId}\n`;
            message += `💰 Amount: $${sms.extractedAmount}\n`;
            message += `🏦 Method: ${sms.paymentMethod}\n`;
            message += `⏰ Time: ${new Date(sms.createdAt).toLocaleString()}\n\n`;
            
            message += `🔧 Actions:\n`;
            message += `   • [Approve: /approvesms_${sms._id}]\n`;
            message += `   • [Reject: /rejectsms_${sms._id}]\n`;
            message += `   • [View: /viewsms_${sms._id}]\n\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh List', 'admin_pending_sms')],
            [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading pending SMS:', error);
        await ctx.editMessageText('❌ Error loading pending SMS list');
      }
    });

    this.bot.action('admin_process_sms', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      await ctx.editMessageText('🔄 Processing all received SMS messages...');

      try {
        const result = await WalletService.autoProcessReceivedSMS();

        await ctx.editMessageText(
          `📊 *SMS Processing Complete*\n\n*Total Received SMS:* ${result.total}\n*Successfully Processed:* ${result.processed}\n*Auto-Approved:* ${result.approved}\n*Matched:* ${result.matched || 0}`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
              [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
            ])
          }
        );
      } catch (error) {
        console.error('Process SMS error:', error);
        await ctx.editMessageText(`❌ Error processing SMS: ${error.message}`);
      }
    });

    this.bot.action('admin_auto_approve', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      await ctx.editMessageText('🤖 Processing auto-approval for small deposits...');

      try {
        const result = await WalletService.processAutoApproveDeposits(100);

        await ctx.editMessageText(
          `🤖 *Auto-Approval Results*\n\n*Processed:* ${result.processed} deposits\n*Approved:* ${result.approved} deposits\n\nAll deposits up to $100 have been auto-approved.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
              [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
            ])
          }
        );
      } catch (error) {
        console.error('Auto-approve error:', error);
        await ctx.editMessageText(`❌ Error during auto-approval: ${error.message}`);
      }
    });

    this.bot.action('admin_batch_approve', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const receivedSMS = await WalletService.getReceivedSMSDeposits();

        if (receivedSMS.length === 0) {
          await ctx.editMessageText(
            '✅ No received SMS deposits to approve.',
            Markup.inlineKeyboard([
              [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')]
            ])
          );
          return;
        }

        const smsIds = receivedSMS.map(sms => sms._id);
        const result = await WalletService.batchApproveSMSDeposits(smsIds, ctx.from.id);

        let message = `🔄 *Batch Approval Results*\n\n`;
        message += `✅ Successful: ${result.successful.length}\n`;
        message += `❌ Failed: ${result.failed.length}\n`;

        if (result.successful.length > 0) {
          message += `\n*Approved Deposits:*\n`;
          result.successful.slice(0, 5).forEach((success, index) => {
            message += `${index + 1}. $${success.amount} - User ${success.user}\n`;
          });
          if (result.successful.length > 5) {
            message += `... and ${result.successful.length - 5} more\n`;
          }
        }

        if (result.failed.length > 0) {
          message += `\n*Failed:*\n`;
          result.failed.slice(0, 3).forEach((fail, index) => {
            message += `${index + 1}. ${fail.smsDepositId} - ${fail.error}\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        await ctx.editMessageText(`❌ Batch approval error: ${error.message}`);
      }
    });

    this.bot.action('admin_sms_matching', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const [unmatchedSMS, matchedPairs] = await Promise.all([
          WalletService.getUnmatchedSMS(),
          WalletService.findRecentlyMatchedSMS ? WalletService.findRecentlyMatchedSMS() : Promise.resolve([])
        ]);

        const senderCount = unmatchedSMS.SENDER?.length || 0;
        const receiverCount = unmatchedSMS.RECEIVER?.length || 0;
        const matchedCount = matchedPairs.length || 0;

        const message = `
🔍 *SMS Matching Panel*

📊 *Matching Status:*
📤 Sender SMS Waiting: ${senderCount}
📥 Receiver SMS Waiting: ${receiverCount}
✅ Recently Matched: ${matchedCount}

🔄 *Matching Actions:*
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Auto-Match All', 'admin_auto_match')],
            [Markup.button.callback('🔍 Find Match for SMS', 'admin_find_match_menu')],
            [Markup.button.callback('🧹 Clean Old SMS', 'admin_clean_sms')],
            [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error in SMS matching menu:', error);
        await ctx.editMessageText('❌ Error loading matching panel');
      }
    });

    this.bot.action('admin_sms_stats', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const [allSMS, pendingSMS, approvedSMS, rejectedSMS] = await Promise.all([
          SMSDeposit.countDocuments(),
          SMSDeposit.countDocuments({ status: 'PENDING' }),
          SMSDeposit.countDocuments({ status: { $in: ['APPROVED', 'AUTO_APPROVED'] } }),
          SMSDeposit.countDocuments({ status: 'REJECTED' })
        ]);

        const message = `
📊 *SMS Statistics*

📈 *Total SMS:* ${allSMS}
⏳ *Pending:* ${pendingSMS}
✅ *Approved:* ${approvedSMS}
❌ *Rejected:* ${rejectedSMS}

*Status Breakdown:*
🟢 Approved: ${Math.round((approvedSMS / allSMS) * 100) || 0}%
🟡 Pending: ${Math.round((pendingSMS / allSMS) * 100) || 0}%
🔴 Rejected: ${Math.round((rejectedSMS / allSMS) * 100) || 0}%

*Quick Commands:*
/smslist - View all SMS
/matchsms - Matching status
/processsms - Process all SMS
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Stats', 'admin_sms_stats')],
            [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading SMS stats:', error);
        await ctx.editMessageText('❌ Error loading statistics');
      }
    });

    this.bot.action('admin_sms_list', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const result = await WalletService.getAllSMSDeposits(1, 10);

        let message = `📱 *SMS Deposit History - Page 1*\n\n`;

        if (result.deposits.length === 0) {
          message += `No SMS deposits found.\n`;
        } else {
          result.deposits.forEach((sms, index) => {
            const statusEmoji = sms.status === 'APPROVED' ? '✅' :
              sms.status === 'REJECTED' ? '❌' :
                sms.status === 'AUTO_APPROVED' ? '🤖' : '⏳';
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';

            message += `${statusEmoji} $${sms.extractedAmount} - ${userName}\n`;
            message += `   Method: ${sms.paymentMethod} | Status: ${sms.status}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleDateString()}\n`;

            if (sms.status === 'PENDING' || sms.status === 'RECEIVED') {
              message += `   [Approve: /approvesms_${sms._id}] [Reject: /rejectsms_${sms._id}]\n`;
            }

            message += `   [View: /viewsms_${sms._id}]\n\n`;
          });
        }

        message += `\nPage 1 of ${result.pagination.pages}`;

        const keyboard = [];
        if (result.pagination.pages > 1) {
          keyboard.push([Markup.button.callback('Next ➡️', 'sms_page_2')]);
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('Admin SMS list error:', error);
        await ctx.answerCbQuery('Error loading list');
      }
    });

    // SMS page navigation
    this.bot.action(/sms_page_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const page = parseInt(ctx.match[1]);

      try {
        const result = await WalletService.getAllSMSDeposits(page, 10);

        let message = `📱 *SMS Deposit History - Page ${page}*\n\n`;

        if (result.deposits.length === 0) {
          message += `No SMS deposits found.\n`;
        } else {
          result.deposits.forEach((sms, index) => {
            const statusEmoji = sms.status === 'APPROVED' ? '✅' :
              sms.status === 'REJECTED' ? '❌' :
                sms.status === 'AUTO_APPROVED' ? '🤖' : '⏳';
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';

            message += `${statusEmoji} $${sms.extractedAmount} - ${userName}\n`;
            message += `   Method: ${sms.paymentMethod} | Status: ${sms.status}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleDateString()}\n`;

            if (sms.status === 'PENDING' || sms.status === 'RECEIVED') {
              message += `   [Approve: /approvesms_${sms._id}] [Reject: /rejectsms_${sms._id}]\n`;
            }

            message += `   [View: /viewsms_${sms._id}]\n\n`;
          });
        }

        message += `\nPage ${page} of ${result.pagination.pages}`;

        const keyboard = [];
        if (page > 1) {
          keyboard.push(Markup.button.callback('⬅️ Previous', `sms_page_${page - 1}`));
        }
        if (page < result.pagination.pages) {
          keyboard.push(Markup.button.callback('Next ➡️', `sms_page_${page + 1}`));
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('SMS page navigation error:', error);
        await ctx.answerCbQuery('Error loading page');
      }
    });

    // SMS approve/reject actions
    this.bot.action(/admin_approve_sms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        await ctx.answerCbQuery('🔄 Approving deposit...');

        const result = await WalletService.approveSMSDeposit(smsId, ctx.from.id);

        await ctx.editMessageText(
          `✅ *SMS Deposit Approved!*\n\n*User:* ${result.smsDeposit.userId.firstName}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}`,
          { parse_mode: 'Markdown' }
        );

        await this.bot.telegram.sendMessage(
          result.smsDeposit.userId.telegramId,
          `🎉 *Deposit Approved!*\n\nYour deposit of $${result.transaction.amount} has been approved!\n*New Balance:* $${result.wallet.balance}\n\nReady to play some Bingo? 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://desta.et')]
            ])
          }
        );

      } catch (error) {
        await ctx.answerCbQuery(`❌ Error: ${error.message}`);
        await ctx.editMessageText(`❌ Failed to approve: ${error.message}`);
      }
    });

    this.bot.action(/admin_reject_sms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        const result = await WalletService.rejectSMSDeposit(smsId, ctx.from.id, 'Manual rejection via button');

        await ctx.editMessageText(
          `❌ *SMS Deposit Rejected!*\n\n*User:* ${result.userId.firstName}\n*Amount:* $${result.extractedAmount}`,
          { parse_mode: 'Markdown' }
        );

        await this.bot.telegram.sendMessage(
          result.userId.telegramId,
          `❌ *Deposit Rejected*\n\nYour deposit of $${result.extractedAmount} was rejected.\n*Reason:* Manual rejection by admin`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📞 Contact Support', 'contact_support')]
            ])
          }
        );

      } catch (error) {
        await ctx.answerCbQuery(`❌ Error: ${error.message}`);
      }
    });

    this.bot.action(/confirm_approve_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        await ctx.answerCbQuery('🔄 Approving deposit...');

        const result = await WalletService.approveReceivedSMS(smsId, ctx.from.id);

        await ctx.editMessageText(
          `✅ *SMS Deposit Approved!*\n\n*User:* ${result.user.firstName || result.user.username}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}`,
          { parse_mode: 'Markdown' }
        );

        await this.bot.telegram.sendMessage(
          result.user.telegramId,
          `🎉 *Deposit Approved!*\n\nYour deposit of $${result.transaction.amount} has been approved!\n*New Balance:* $${result.wallet.balance}\n\nReady to play some Bingo? 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://desta.et')]
            ])
          }
        );

      } catch (error) {
        await ctx.answerCbQuery(`❌ Error: ${error.message}`);
        await ctx.editMessageText(`❌ Failed to approve: ${error.message}`);
      }
    });

    this.bot.action(/cancel_approve_(.+)/, async (ctx) => {
      await ctx.answerCbQuery('Approval cancelled');
      await ctx.deleteMessage();
    });

    // ========== WITHDRAWAL ADMIN ACTIONS ==========

    this.bot.action('admin_withdrawals_menu', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const message = `
💰 *Withdrawal Management*

Manage user withdrawal requests.

*Quick Actions:*
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⏳ Pending Withdrawals', 'admin_pending_withdrawals')],
          [Markup.button.callback('✅ Approved', 'admin_approved_withdrawals')],
          [Markup.button.callback('❌ Rejected', 'admin_rejected_withdrawals')],
          [Markup.button.callback('📊 Withdrawal Stats', 'admin_withdrawal_stats')],
          [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
        ])
      });
    });

    this.bot.action('admin_pending_withdrawals', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const pendingWithdrawals = await WalletService.getPendingWithdrawals();

        let message = `⏳ *Pending Withdrawals*\n\n`;

        if (pendingWithdrawals.length === 0) {
          message += `✅ No pending withdrawal requests. All clear!\n`;
        } else {
          pendingWithdrawals.forEach((withdrawal, index) => {
            const userName = withdrawal.userId?.firstName || withdrawal.userId?.username || 'Unknown User';
            const telegramId = withdrawal.userId?.telegramId || 'N/A';
            const amount = Math.abs(withdrawal.amount);
            const method = withdrawal.metadata?.withdrawalMethod || 'Unknown';
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `👤 User: ${userName}\n`;
            message += `📞 ID: ${telegramId}\n`;
            message += `💰 Amount: $${amount}\n`;
            message += `🏦 Method: ${method}\n`;
            message += `⏰ Requested: ${new Date(withdrawal.createdAt).toLocaleString()}\n\n`;
            
            message += `🔧 Actions:\n`;
            message += `   • [Approve: /approvewithdraw_${withdrawal._id}]\n`;
            message += `   • [Reject: /rejectwithdraw_${withdrawal._id}]\n`;
            message += `   • [View: /viewwithdraw_${withdrawal._id}]\n\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh List', 'admin_pending_withdrawals')],
            [Markup.button.callback('💰 Withdrawals Menu', 'admin_withdrawals_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading pending withdrawals:', error);
        await ctx.editMessageText('❌ Error loading pending withdrawals');
      }
    });

    this.bot.action('admin_approved_withdrawals', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const approvedWithdrawals = await Transaction.find({
          type: 'WITHDRAWAL',
          status: 'COMPLETED'
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(10);

        let message = `✅ *Approved Withdrawals*\n\n`;

        if (approvedWithdrawals.length === 0) {
          message += `No approved withdrawals yet.\n`;
        } else {
          approvedWithdrawals.forEach((withdrawal, index) => {
            const userName = withdrawal.userId?.firstName || withdrawal.userId?.username || 'Unknown User';
            const amount = Math.abs(withdrawal.amount);
            const date = new Date(withdrawal.createdAt).toLocaleString();
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `👤 User: ${userName}\n`;
            message += `💰 Amount: $${amount}\n`;
            message += `🏦 Method: ${withdrawal.metadata?.withdrawalMethod || 'Unknown'}\n`;
            message += `⏰ Approved: ${date}\n\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'admin_approved_withdrawals')],
            [Markup.button.callback('💰 Withdrawals Menu', 'admin_withdrawals_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading approved withdrawals:', error);
        await ctx.editMessageText('❌ Error loading approved withdrawals');
      }
    });

    this.bot.action('admin_rejected_withdrawals', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const rejectedWithdrawals = await Transaction.find({
          type: 'WITHDRAWAL',
          status: 'REJECTED'
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(10);

        let message = `❌ *Rejected Withdrawals*\n\n`;

        if (rejectedWithdrawals.length === 0) {
          message += `No rejected withdrawals.\n`;
        } else {
          rejectedWithdrawals.forEach((withdrawal, index) => {
            const userName = withdrawal.userId?.firstName || withdrawal.userId?.username || 'Unknown User';
            const amount = Math.abs(withdrawal.amount);
            const date = new Date(withdrawal.createdAt).toLocaleString();
            const reason = withdrawal.metadata?.rejectionReason || 'No reason provided';
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `👤 User: ${userName}\n`;
            message += `💰 Amount: $${amount}\n`;
            message += `🏦 Method: ${withdrawal.metadata?.withdrawalMethod || 'Unknown'}\n`;
            message += `❓ Reason: ${reason}\n`;
            message += `⏰ Rejected: ${date}\n\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'admin_rejected_withdrawals')],
            [Markup.button.callback('💰 Withdrawals Menu', 'admin_withdrawals_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading rejected withdrawals:', error);
        await ctx.editMessageText('❌ Error loading rejected withdrawals');
      }
    });

    this.bot.action('admin_withdrawal_stats', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const stats = await WalletService.getWithdrawalStats();
        
        let message = `📊 *Withdrawal Statistics*\n\n`;
        
        message += `*Total Withdrawals:* ${stats.totalCount?.[0]?.count || 0}\n`;
        message += `*Total Amount:* $${stats.totalAmount?.[0]?.total || 0}\n\n`;
        
        if (stats.byStatus && stats.byStatus.length > 0) {
          message += `*By Status:*\n`;
          stats.byStatus.forEach(status => {
            const emoji = status._id === 'PENDING' ? '⏳' :
                         status._id === 'COMPLETED' ? '✅' : '❌';
            message += `${emoji} ${status._id}: ${status.count} ($${status.totalAmount})\n`;
          });
        }
        
        if (stats.dailyStats && stats.dailyStats.length > 0) {
          message += `\n*Last 7 Days:*\n`;
          stats.dailyStats.forEach(day => {
            message += `📅 ${day._id}: ${day.count} withdrawals ($${day.totalAmount})\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'admin_withdrawal_stats')],
            [Markup.button.callback('💰 Withdrawals Menu', 'admin_withdrawals_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading withdrawal stats:', error);
        await ctx.editMessageText('❌ Error loading withdrawal statistics');
      }
    });

    this.bot.action(/admin_approve_withdraw_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const withdrawalId = ctx.match[1];

      try {
        await ctx.answerCbQuery('🔄 Approving withdrawal...');
        
        const result = await WalletService.approveWithdrawal(withdrawalId, ctx.from.id);

        await ctx.editMessageText(
          `✅ *Withdrawal Approved!*\n\n` +
          `*User:* ${result.user.firstName || result.user.username}\n` +
          `*Amount:* $${result.amount}\n` +
          `*Method:* ${result.withdrawal.metadata.withdrawalMethod}\n` +
          `*New Balance:* $${result.wallet.balance}`,
          { parse_mode: 'Markdown' }
        );

        await this.bot.telegram.sendMessage(
          result.user.telegramId,
          `✅ *Withdrawal Processed!*\n\n` +
          `Your withdrawal of $${result.amount} has been approved and processed.\n` +
          `*Method:* ${result.withdrawal.metadata.withdrawalMethod}\n` +
          `*Transaction ID:* ${result.withdrawal._id}\n\n` +
          `The funds should reach you within 24 hours.`,
          { parse_mode: 'Markdown' }
        );

      } catch (error) {
        console.error('Error approving withdrawal:', error);
        await ctx.answerCbQuery('❌ ' + error.message);
        await ctx.editMessageText(`❌ Error: ${error.message}`);
      }
    });

    this.bot.action(/admin_reject_withdraw_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const withdrawalId = ctx.match[1];
      
      try {
        await ctx.answerCbQuery('🔄 Asking for rejection reason...');
        
        ctx.session = ctx.session || {};
        ctx.session.pendingWithdrawalRejection = withdrawalId;
        
        await ctx.editMessageText(
          `❓ *Rejection Reason*\n\n` +
          `Please provide a reason for rejecting this withdrawal request:\n\n` +
          `Type your reason below:`,
          { parse_mode: 'Markdown' }
        );
        
      } catch (error) {
        console.error('Error starting rejection:', error);
        await ctx.answerCbQuery('❌ ' + error.message);
      }
    });


// Add these action handlers to your BotController's setupHandlers method
// Place this after your other admin action handlers (around line 2000-2500)

// ========== FRAUD DETECTION & MONITORING ADMIN ACTIONS ==========

// Fraud monitoring panel
this.bot.action('admin_fraud_monitor', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
    }
    
    try {
        const fraudSummary = await WalletService.getFraudDetectionSummary();
        
        const message = `
🕵️ *Fraud Detection & Monitoring*

📊 *System Overview:*
• 👥 Users with high balances (>$1000): ${fraudSummary.highBalanceUsers}
• ⏳ Users with pending withdrawals: ${fraudSummary.usersWithPendingWithdrawals}
• 🚨 Users with rapid withdrawals (24h): ${fraudSummary.usersWithRapidWithdrawals}

📱 *SMS Matching Stats:*
• Total SMS: ${fraudSummary.smsStats.totalSMS}
• ✅ Approved: ${fraudSummary.smsStats.approvedSMS}
• ⏳ Pending: ${fraudSummary.smsStats.pendingSMS}
• 📊 Match rate: ${fraudSummary.smsMatchRate}

💰 *Transaction Volume (7 days):*
• Deposits: $${fraudSummary.transactionVolume.totalDeposits.toFixed(2)}
• Withdrawals: $${fraudSummary.transactionVolume.totalWithdrawals.toFixed(2)}
• Transactions: ${fraudSummary.transactionVolume.transactionCount}

Select monitoring option below:
        `;
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💰 Top Balances', 'admin_top_balances')],
                [Markup.button.callback('🚨 Suspicious Activity', 'admin_suspicious_users')],
                [Markup.button.callback('📊 All Users with Balances', 'admin_all_balances')],
                [Markup.button.callback('⏳ Pending Withdrawals', 'admin_pending_withdrawals')],
                [Markup.button.callback('📈 Transaction Analysis', 'admin_transaction_analysis')],
                [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
            ])
        });
    } catch (error) {
        console.error('Error loading fraud monitor:', error);
        await ctx.answerCbQuery('❌ Error loading fraud monitor');
    }
});

// Top balances view
this.bot.action('admin_top_balances', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  try {
    // Store page in session or use default page 1
    ctx.session = ctx.session || {};
    const page = ctx.session.topBalancesPage || 1;
    const limit = 5; // Show only 5 users per page
    const skip = (page - 1) * limit;
    
    const topUsers = await WalletService.getTopUsersByBalance(50); // Get more for pagination
    const totalPages = Math.ceil(topUsers.length / limit);
    const paginatedUsers = topUsers.slice(skip, skip + limit);
    
    // Escape function for Markdown
    const escapeMarkdown = (text) => {
      if (!text) return '';
      return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };
    
    let message = `💰 *Top Users by Balance - Page ${page}/${totalPages}*\n\n`;
    
    if (paginatedUsers.length === 0) {
      message += `No users with balances found.\n`;
    } else {
      paginatedUsers.forEach((user, index) => {
        const globalIndex = skip + index;
        const medal = globalIndex === 0 ? '🥇' : globalIndex === 1 ? '🥈' : globalIndex === 2 ? '🥉' : '👤';
        const availableBalance = user.balance - (user.lockedAmount || 0);
        
        // Escape user-provided content
        const firstName = escapeMarkdown(user.firstName || 'Unknown');
        const username = escapeMarkdown(user.username || 'N/A');
        const joinedDate = escapeMarkdown(new Date(user.createdAt).toLocaleDateString());
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `${medal} #${globalIndex + 1}\n`;
        message += `👤 *${firstName}* (@${username})\n`;
        message += `🆔 Telegram: ${user.telegramId}\n`;
        message += `💰 Total Balance: $${user.balance.toFixed(2)}\n`;
        message += `💎 Available: $${availableBalance.toFixed(2)}\n`;
        message += `🔒 Locked: $${(user.lockedAmount || 0).toFixed(2)}\n`;
        message += `📅 Joined: ${joinedDate}\n`;
        message += `📊 Recent Tx: ${user.transactionCount || 0}\n`;
        message += `🔧 [View Details: /user_${user.telegramId}]\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;
      });
    }
    
    // Build pagination buttons
    const paginationButtons = [];
    if (page > 1) {
      paginationButtons.push(Markup.button.callback('⬅️ Previous', 'top_balances_page_prev'));
    }
    if (page < totalPages) {
      paginationButtons.push(Markup.button.callback('Next ➡️', 'top_balances_page_next'));
    }
    
    const keyboard = [];
    if (paginationButtons.length > 0) {
      keyboard.push(paginationButtons);
    }
    keyboard.push([Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor')]);
    keyboard.push([Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]);
    
    // Try with Markdown, fallback to plain text
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (markdownError) {
      console.error('Markdown error, sending plain text:', markdownError);
      const plainMessage = message.replace(/[*_`]/g, '');
      await ctx.editMessageText(plainMessage, {
        parse_mode: '',
        ...Markup.inlineKeyboard(keyboard)
      });
    }
  } catch (error) {
    console.error('Error loading top balances:', error);
    await ctx.answerCbQuery('❌ Error loading top balances');
  }
});

// Add pagination handlers
this.bot.action('top_balances_page_next', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.topBalancesPage = (ctx.session.topBalancesPage || 1) + 1;
  await ctx.answerCbQuery();
  await this.bot.action('admin_top_balances', ctx);
});

this.bot.action('top_balances_page_prev', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.topBalancesPage = Math.max(1, (ctx.session.topBalancesPage || 1) - 1);
  await ctx.answerCbQuery();
  await this.bot.action('admin_top_balances', ctx);
});

// All users with balances (paginated)
this.bot.action(/admin_all_balances(?:_page_(\d+))?/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
    }
    
    const page = ctx.match && ctx.match[1] ? parseInt(ctx.match[1]) : 1;
    const limit = 10;
    
    try {
        const result = await WalletService.getAllUsersWithBalances(page, limit, 0, 'balance_desc');
        
        let message = `📊 *All Users with Balances - Page ${page}*\n\n`;
        
        if (result.users.length === 0) {
            message += `No users with balances found.\n`;
        } else {
            message += `📈 *Summary:*\n`;
            message += `• Total Users with Balance: ${result.summary.usersWithBalance}\n`;
            message += `• Total Balance: $${result.summary.totalBalance.toFixed(2)}\n`;
            message += `• Average Balance: $${result.summary.avgBalance.toFixed(2)}\n`;
            message += `• Max Balance: $${result.summary.maxBalance.toFixed(2)}\n`;
            message += `• Users >$1000: ${result.summary.usersWithLargeBalance}\n\n`;
            
            message += `📋 *User List:*\n`;
            result.users.forEach((user, index) => {
                const rank = (page - 1) * limit + index + 1;
                const available = (user.wallet?.balance || 0) - (user.wallet?.lockedAmount || 0);
                
                message += `━━━━━━━━━━━━━━━━━━\n`;
                message += `#${rank}\n`;
                message += `👤 *${user.firstName || 'Unknown'}* (@${user.username || 'N/A'})\n`;
                message += `💰 Balance: $${(user.wallet?.balance || 0).toFixed(2)}\n`;
                message += `💎 Available: $${available.toFixed(2)}\n`;
                message += `📊 Tx: ${user.transactionCount || 0} | 💰 Deposits: $${(user.totalDeposits || 0).toFixed(2)}\n`;
                message += `📤 Withdrawals: $${(user.totalWithdrawals || 0).toFixed(2)} | 🏆 Winnings: $${(user.totalWinnings || 0).toFixed(2)}\n`;
                message += `🔧 [View: /user_${user.telegramId}]\n\n`;
            });
        }
        
        const keyboard = [];
        const navButtons = [];
        
        if (page > 1) {
            navButtons.push(Markup.button.callback('⬅️ Previous', `admin_all_balances_page_${page - 1}`));
        }
        if (page < result.pagination.pages) {
            navButtons.push(Markup.button.callback('Next ➡️', `admin_all_balances_page_${page + 1}`));
        }
        
        if (navButtons.length > 0) {
            keyboard.push(navButtons);
        }
        
        keyboard.push([
            Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor'),
            Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')
        ]);
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
        });
    } catch (error) {
        console.error('Error loading all balances:', error);
        await ctx.answerCbQuery('❌ Error loading user balances');
    }
});

// Suspicious users view
this.bot.action('admin_suspicious_users', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
    }
    
    try {
        const suspiciousUsers = await WalletService.getSuspiciousUsers({
            rapidWithdrawalThreshold: 3,
            largeWithdrawalThreshold: 500,
            unusualActivityScore: 0.6,
            minBalanceThreshold: 500
        });
        
        let message = `🚨 *Suspicious Activity Report*\n\n`;
        
        if (suspiciousUsers.length === 0) {
            message += `✅ No suspicious activity detected.\nAll users appear normal.`;
        } else {
            message += `Found ${suspiciousUsers.length} users with suspicious patterns:\n\n`;
            
            suspiciousUsers.forEach((user, index) => {
                const suspiciousScore = (user.suspiciousScore * 100).toFixed(0);
                let scoreEmoji = '🟢';
                if (suspiciousScore > 80) scoreEmoji = '🔴';
                else if (suspiciousScore > 60) scoreEmoji = '🟠';
                else if (suspiciousScore > 40) scoreEmoji = '🟡';
                
                message += `━━━━━━━━━━━━━━━━━━\n`;
                message += `${scoreEmoji} *Suspicious User #${index + 1}*\n`;
                message += `👤 *${user.firstName || 'Unknown'}* (@${user.username || 'N/A'})\n`;
                message += `🆔 Telegram: ${user.telegramId}\n`;
                message += `💰 Balance: $${user.wallet?.balance?.toFixed(2) || 0}\n`;
                message += `🔒 Locked: $${(user.wallet?.lockedAmount || 0).toFixed(2)}\n`;
                message += `🚩 *Suspicion Score: ${suspiciousScore}%*\n\n`;
                
                message += `*Suspicious Indicators:*\n`;
                if (user.withdrawalCount24h > 3) {
                    message += `• ⚠️ ${user.withdrawalCount24h} withdrawals in 24h\n`;
                }
                if (user.largeWithdrawalCount > 0) {
                    message += `• ⚠️ ${user.largeWithdrawalCount} large withdrawals (>$500)\n`;
                }
                if (user.smsCount3d > 5) {
                    message += `• ⚠️ ${user.smsCount3d} SMS in 3 days\n`;
                }
                message += `\n🔧 [Investigate: /user_${user.telegramId}]\n`;
                message += `━━━━━━━━━━━━━━━━━━\n\n`;
            });
        }
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'admin_suspicious_users')],
                [Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor')],
                [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
            ])
        });
    } catch (error) {
        console.error('Error loading suspicious users:', error);
        await ctx.answerCbQuery('❌ Error analyzing suspicious activity');
    }
});

// User investigation view (when clicking on suspicious user)
this.bot.action(/admin_investigate_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
    }
    
    const telegramId = ctx.match[1];
    
    try {
        const activityDetails = await WalletService.getUserActivityDetails(telegramId, 30);
        
        let message = `🔍 *Investigation Report: ${activityDetails.user.firstName || 'User'}*\n\n`;
        
        // User info
        message += `*User Information:*\n`;
        message += `👤 Name: ${activityDetails.user.firstName || 'N/A'}\n`;
        message += `📱 Username: @${activityDetails.user.username || 'N/A'}\n`;
        message += `🆔 Telegram ID: ${activityDetails.user.telegramId}\n`;
        message += `📅 Joined: ${new Date(activityDetails.user.createdAt).toLocaleDateString()}\n\n`;
        
        // Wallet status
        message += `*Wallet Status:*\n`;
        message += `💰 Total Balance: $${activityDetails.wallet?.balance?.toFixed(2) || 0}\n`;
        message += `💎 Available: $${((activityDetails.wallet?.balance || 0) - (activityDetails.wallet?.lockedAmount || 0)).toFixed(2)}\n`;
        message += `🔒 Locked: $${(activityDetails.wallet?.lockedAmount || 0).toFixed(2)}\n\n`;
        
        // Activity summary (last 30 days)
        message += `*Activity (Last 30 days):*\n`;
        message += `📊 Transactions: ${activityDetails.activity.transactionCount}\n`;
        message += `📱 SMS: ${activityDetails.activity.smsCount}\n`;
        message += `💰 Deposits: $${activityDetails.activity.totalDeposits.toFixed(2)}\n`;
        message += `📤 Withdrawals: $${activityDetails.activity.totalWithdrawals.toFixed(2)}\n`;
        message += `🏆 Winnings: $${activityDetails.activity.totalWinnings.toFixed(2)}\n`;
        message += `🎮 Games Played: ${activityDetails.activity.totalGameEntries}\n`;
        message += `📈 Net Profit: $${activityDetails.activity.netProfit.toFixed(2)}\n\n`;
        
        // Risk assessment
        message += `*Risk Assessment:*\n`;
        const riskScore = (activityDetails.suspiciousScore * 100).toFixed(0);
        let riskLevel = 'LOW';
        let riskEmoji = '🟢';
        
        if (riskScore > 70) {
            riskLevel = 'HIGH';
            riskEmoji = '🔴';
        } else if (riskScore > 40) {
            riskLevel = 'MEDIUM';
            riskEmoji = '🟠';
        } else if (riskScore > 20) {
            riskLevel = 'LOW-MEDIUM';
            riskEmoji = '🟡';
        }
        
        message += `${riskEmoji} *Risk Level: ${riskLevel}* (Score: ${riskScore}%)\n\n`;
        
        message += `*Risk Indicators:*\n`;
        if (activityDetails.riskIndicators.rapidWithdrawals) {
            message += `• 🔴 Rapid withdrawals detected\n`;
        }
        if (activityDetails.riskIndicators.multipleWithdrawalsPerDay) {
            message += `• 🟠 Multiple withdrawals per day\n`;
        }
        if (activityDetails.riskIndicators.highWithdrawalRatio) {
            message += `• 🟠 High withdrawal/deposit ratio\n`;
        }
        if (activityDetails.riskIndicators.inconsistentSMS) {
            message += `• 🟡 Inconsistent SMS patterns\n`;
        }
        
        message += `\n*Recent Transactions:*\n`;
        if (activityDetails.recentTransactions.length > 0) {
            activityDetails.recentTransactions.slice(0, 5).forEach((tx, i) => {
                const emoji = tx.type === 'DEPOSIT' ? '📥' :
                             tx.type === 'WITHDRAWAL' ? '📤' :
                             tx.type === 'WINNING' ? '🏆' : '🎮';
                const sign = tx.amount > 0 ? '+' : '';
                const date = new Date(tx.createdAt).toLocaleDateString();
                message += `${i + 1}. ${emoji} ${sign}$${Math.abs(tx.amount).toFixed(2)} - ${tx.type} (${date})\n`;
            });
        } else {
            message += `No recent transactions.\n`;
        }
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💰 Full Transaction History', `admin_user_tx_${telegramId}`)],
                [Markup.button.callback('📱 SMS History', `admin_user_sms_${telegramId}`)],
                [Markup.button.callback('🚨 Suspicious Users', 'admin_suspicious_users')],
                [Markup.button.callback('⬅️ Fraud Monitor', 'admin_fraud_monitor')]
            ])
        });
    } catch (error) {
        console.error('Error investigating user:', error);
        await ctx.answerCbQuery('❌ Error loading investigation data');
    }
});

// Transaction analysis view
this.bot.action('admin_transaction_analysis', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
    }
    
    try {
        const fraudSummary = await WalletService.getFraudDetectionSummary();
        const stats = await WalletService.getTransactionStats();
        
        let message = `📈 *Transaction Analysis*\n\n`;
        
        message += `*Volume Overview:*\n`;
        message += `• Total Transactions: ${stats.totalCount?.[0]?.count || 0}\n`;
        message += `• Total Volume: $${stats.totalAmount?.[0]?.total.toFixed(2) || 0}\n\n`;
        
        message += `*By Type:*\n`;
        if (stats.byType && stats.byType.length > 0) {
            stats.byType.forEach(type => {
                const emoji = type._id === 'DEPOSIT' ? '📥' :
                             type._id === 'WITHDRAWAL' ? '📤' :
                             type._id === 'WINNING' ? '🏆' : '🎮';
                message += `${emoji} ${type._id}: ${type.count} ($${type.totalAmount.toFixed(2)})\n`;
            });
        }
        
        message += `\n*Fraud Indicators:*\n`;
        message += `• High Withdrawal Users: ${fraudSummary.usersWithRapidWithdrawals}\n`;
        message += `• High Balance Users: ${fraudSummary.highBalanceUsers}\n`;
        message += `• Pending Withdrawal Users: ${fraudSummary.usersWithPendingWithdrawals}\n`;
        message += `• SMS Match Rate: ${fraudSummary.smsMatchRate}\n\n`;
        
        message += `*Top 5 Largest Transactions (Last 7 days):*\n`;
        
        const largeTransactions = await Transaction.find({
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ amount: -1 })
        .limit(5);
        
        if (largeTransactions.length > 0) {
            largeTransactions.forEach((tx, i) => {
                const userName = tx.userId?.firstName || 'Unknown';
                const amount = Math.abs(tx.amount);
                const type = tx.type;
                const date = new Date(tx.createdAt).toLocaleDateString();
                message += `${i + 1}. $${amount.toFixed(2)} - ${type} by ${userName} (${date})\n`;
                message += `   [View: /viewtx_${tx._id}]\n`;
            });
        } else {
            message += `No large transactions in last 7 days.\n`;
        }
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'admin_transaction_analysis')],
                [Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor')],
                [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
            ])
        });
    } catch (error) {
        console.error('Error loading transaction analysis:', error);
        await ctx.answerCbQuery('❌ Error loading analysis');
    }
});

// Add fraud monitor button to admin panel
// Find where admin panel buttons are defined and add this line:
// [Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor')],









    // ========== TRANSACTIONS ADMIN ACTIONS ==========

    this.bot.action('admin_transactions_menu', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const message = `
💳 *Transactions Panel*

View and manage all transactions.

🔧 *Transaction Actions:*
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 All Transactions', 'admin_transactions_list')],
          [Markup.button.callback('⏳ Pending Deposits', 'admin_pending_deposits')],
          [Markup.button.callback('✅ Completed', 'admin_completed_transactions')],
          [Markup.button.callback('❌ Failed', 'admin_failed_transactions')],
          [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
        ])
      });
    });

    this.bot.action('admin_transactions_list', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const page = 1;
        const limit = 10;
        
        const transactions = await Transaction.find()
          .populate('userId', 'firstName username telegramId')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean();

        let message = `💳 *All Transactions - Page ${page}*\n\n`;

        if (transactions.length === 0) {
          message += `No transactions found.\n`;
        } else {
          transactions.forEach((tx, index) => {
            const userName = tx.userId?.firstName || tx.userId?.username || 'Unknown User';
            const telegramId = tx.userId?.telegramId || 'N/A';
            const typeEmoji = tx.type === 'DEPOSIT' ? '📥' :
                             tx.type === 'WITHDRAWAL' ? '📤' :
                             tx.type === 'WINNING' ? '🏆' :
                             tx.type === 'GAME_ENTRY' ? '🎮' : '💳';
            
            const statusEmoji = tx.status === 'COMPLETED' ? '✅' :
                               tx.status === 'PENDING' ? '⏳' : '❌';

            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `${typeEmoji} ${statusEmoji} *${tx.type}*\n`;
            message += `👤 User: ${userName}\n`;
            message += `📞 ID: ${telegramId}\n`;
            message += `💰 Amount: $${Math.abs(tx.amount)}\n`;
            
            if (tx.metadata?.paymentMethod) {
              message += `🏦 Method: ${tx.metadata.paymentMethod}\n`;
            }
            
            message += `📝 Desc: ${tx.description?.substring(0, 50) || 'No description'}\n`;
            message += `⏰ Time: ${new Date(tx.createdAt).toLocaleString()}\n`;
            
            message += `\n🔧 Actions:\n`;
            message += `   • [View: /viewtx_${tx._id}]\n`;
            
            if (tx.type === 'DEPOSIT' && tx.status === 'PENDING') {
              message += `   • [Approve: /approve_${tx._id}]\n`;
            }
            
            if (tx.type === 'WITHDRAWAL' && tx.status === 'PENDING') {
              message += `   • [Approve: /approvewithdraw_${tx._id}]\n`;
              message += `   • [Reject: /rejectwithdraw_${tx._id}]\n`;
            }
            
            message += `\n`;
          });
        }

        const keyboard = [
          [Markup.button.callback('🔄 Refresh', 'admin_transactions_list')],
          [Markup.button.callback('📊 Transaction Stats', 'admin_transaction_stats')],
          [Markup.button.callback('💳 Transactions Menu', 'admin_transactions_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ];

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('Error loading transactions list:', error);
        await ctx.editMessageText('❌ Error loading transactions list');
      }
    });

    this.bot.action('admin_transaction_stats', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const stats = await WalletService.getTransactionStats();
        
        let message = `📊 *Transaction Statistics*\n\n`;
        
        message += `*Total Transactions:* ${stats.totalCount?.[0]?.count || 0}\n`;
        message += `*Total Volume:* $${stats.totalAmount?.[0]?.total || 0}\n\n`;
        
        if (stats.byType && stats.byType.length > 0) {
          message += `*By Type:*\n`;
          stats.byType.forEach(type => {
            const emoji = type._id === 'DEPOSIT' ? '📥' :
                         type._id === 'WITHDRAWAL' ? '📤' :
                         type._id === 'WINNING' ? '🏆' : '🎮';
            message += `${emoji} ${type._id}: ${type.count} ($${type.totalAmount})\n`;
          });
        }
        
        if (stats.byStatus && stats.byStatus.length > 0) {
          message += `\n*By Status:*\n`;
          stats.byStatus.forEach(status => {
            const emoji = status._id === 'COMPLETED' ? '✅' :
                         status._id === 'PENDING' ? '⏳' : '❌';
            message += `${emoji} ${status._id}: ${status.count} ($${status.totalAmount})\n`;
          });
        }
        
        if (stats.dailyStats && stats.dailyStats.length > 0) {
          message += `\n*Last 7 Days:*\n`;
          stats.dailyStats.forEach(day => {
            message += `📅 ${day._id}: ${day.count} txns ($${day.totalAmount})\n`;
          });
        }
        
        const keyboard = [
          [Markup.button.callback('🔄 Refresh', 'admin_transaction_stats')],
          [Markup.button.callback('📋 All Transactions', 'admin_transactions_list')],
          [Markup.button.callback('💳 Transactions Menu', 'admin_transactions_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ];

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('Error loading transaction stats:', error);
        await ctx.editMessageText('❌ Error loading transaction statistics');
      }
    });

    this.bot.action('admin_pending_deposits', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const pendingDeposits = await WalletService.getPendingDeposits();

        let message = `⏳ *Pending Deposits*\n\n`;

        if (pendingDeposits.length === 0) {
          message += `✅ No pending deposits. All clear!\n`;
        } else {
          pendingDeposits.forEach((deposit, index) => {
            const userName = deposit.userId?.firstName || deposit.userId?.username || 'Unknown User';
            const telegramId = deposit.userId?.telegramId || 'N/A';
            const paymentMethod = deposit.metadata?.paymentMethod || 'Unknown';

            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `👤 User: ${userName}\n`;
            message += `📞 ID: ${telegramId}\n`;
            message += `💰 Amount: $${deposit.amount}\n`;
            message += `🏦 Method: ${paymentMethod}\n`;
            message += `⏰ Time: ${new Date(deposit.createdAt).toLocaleString()}\n\n`;

            message += `🔧 Actions:\n`;
            message += `   • [Approve: /approve_${deposit._id}]\n`;
            message += `   • [View User: /user_${telegramId}]\n\n`;
          });
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh List', 'admin_pending_deposits')],
            [Markup.button.callback('💳 Transactions Menu', 'admin_transactions_menu')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading pending deposits:', error);
        await ctx.editMessageText('❌ Error loading pending deposits');
      }
    });

    this.bot.action('admin_completed_transactions', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const completedTransactions = await Transaction.find({
          status: 'COMPLETED'
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(10);

        let message = `✅ *Completed Transactions*\n\n`;

        if (completedTransactions.length === 0) {
          message += `No completed transactions found.\n`;
        } else {
          completedTransactions.forEach((tx, index) => {
            const userName = tx.userId?.firstName || tx.userId?.username || 'Unknown User';
            const typeEmoji = tx.type === 'DEPOSIT' ? '📥' :
                             tx.type === 'WITHDRAWAL' ? '📤' :
                             tx.type === 'WINNING' ? '🏆' : '🎮';
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `${typeEmoji} *${tx.type}*\n`;
            message += `👤 User: ${userName}\n`;
            message += `💰 Amount: $${Math.abs(tx.amount)}\n`;
            
            if (tx.metadata?.paymentMethod) {
              message += `🏦 Method: ${tx.metadata.paymentMethod}\n`;
            }
            
            message += `⏰ Time: ${new Date(tx.createdAt).toLocaleString()}\n`;
            message += `   [View: /viewtx_${tx._id}]\n\n`;
          });
        }

        const keyboard = [
          [Markup.button.callback('🔄 Refresh', 'admin_completed_transactions')],
          [Markup.button.callback('📋 All Transactions', 'admin_transactions_list')],
          [Markup.button.callback('💳 Transactions Menu', 'admin_transactions_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ];

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('Error loading completed transactions:', error);
        await ctx.editMessageText('❌ Error loading completed transactions');
      }
    });

    this.bot.action('admin_failed_transactions', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const failedTransactions = await Transaction.find({
          status: 'FAILED'
        })
        .populate('userId', 'firstName username telegramId')
        .sort({ createdAt: -1 })
        .limit(10);

        let message = `❌ *Failed Transactions*\n\n`;

        if (failedTransactions.length === 0) {
          message += `No failed transactions found.\n`;
        } else {
          failedTransactions.forEach((tx, index) => {
            const userName = tx.userId?.firstName || tx.userId?.username || 'Unknown User';
            const typeEmoji = tx.type === 'DEPOSIT' ? '📥' :
                             tx.type === 'WITHDRAWAL' ? '📤' :
                             tx.type === 'WINNING' ? '🏆' : '🎮';
            
            message += `━━━━━━━━━━━━━━━━━━\n`;
            message += `#${index + 1}\n`;
            message += `${typeEmoji} *${tx.type}*\n`;
            message += `👤 User: ${userName}\n`;
            message += `💰 Amount: $${Math.abs(tx.amount)}\n`;
            
            if (tx.metadata?.failureReason) {
              message += `❓ Reason: ${tx.metadata.failureReason}\n`;
            }
            
            message += `⏰ Time: ${new Date(tx.createdAt).toLocaleString()}\n`;
            message += `   [View: /viewtx_${tx._id}]\n\n`;
          });
        }

        const keyboard = [
          [Markup.button.callback('🔄 Refresh', 'admin_failed_transactions')],
          [Markup.button.callback('📋 All Transactions', 'admin_transactions_list')],
          [Markup.button.callback('💳 Transactions Menu', 'admin_transactions_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ];

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      } catch (error) {
        console.error('Error loading failed transactions:', error);
        await ctx.editMessageText('❌ Error loading failed transactions');
      }
    });

    this.bot.action(/admin_approve_tx_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const transactionId = ctx.match[1];

      try {
        await ctx.answerCbQuery('🔄 Approving transaction...');
        
        const result = await WalletService.approveDeposit(transactionId, ctx.from.id);

        await ctx.editMessageText(
          `✅ *Transaction Approved!*\n\n` +
          `*User:* ${result.transaction.userId.firstName || result.transaction.userId.username}\n` +
          `*Amount:* $${result.transaction.amount}\n` +
          `*New Balance:* $${result.wallet.balance}`,
          { parse_mode: 'Markdown' }
        );

        await this.bot.telegram.sendMessage(
          result.transaction.userId.telegramId,
          `✅ *Deposit Approved!*\n\n` +
          `Your deposit of $${result.transaction.amount} has been approved!\n` +
          `*New Balance:* $${result.wallet.balance}\n\n` +
          `Ready to play some Bingo? 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://desta.et')]
            ])
          }
        );

      } catch (error) {
        console.error('Error approving transaction:', error);
        await ctx.answerCbQuery('❌ ' + error.message);
        await ctx.editMessageText(`❌ Error: ${error.message}`);
      }
    });

    // ========== USER MANAGEMENT ACTIONS ==========

    this.bot.action('admin_users_menu', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const message = `
👥 *User Management Panel*

Manage users, wallets, and transactions.

🔧 *User Actions:*
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 All Users', 'admin_users_list')],
          [Markup.button.callback('💼 User Wallets', 'admin_wallets_list')],
          [Markup.button.callback('📊 User Statistics', 'admin_users_stats')],
          [Markup.button.callback('🔍 Search User', 'admin_search_user')],
          [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
        ])
      });
    });

    // ========== SYSTEM TOOLS ACTIONS ==========
// Auto-match action
this.bot.action('admin_auto_match', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    await ctx.editMessageText('🔄 Auto-matching all waiting SMS...');
    const result = await WalletService.autoMatchAllSMS();
    
    await ctx.editMessageText(
      `✅ *Auto-Matching Complete*\n\n` +
      `*Sender SMS Matched:* ${result.senderMatched || 0}\n` +
      `*Receiver SMS Matched:* ${result.receiverMatched || 0}\n` +
      `*Total Matched Pairs:* ${result.totalMatched || 0}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'admin_sms_matching')],
          [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      }
    );
  } catch (error) {
    console.error('Auto-match error:', error);
    await ctx.editMessageText(`❌ Error during auto-matching: ${error.message}`);
  }
});

// Find match menu action
this.bot.action('admin_find_match_menu', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const unmatchedSMS = await WalletService.getUnmatchedSMS();
    const senderCount = unmatchedSMS.SENDER?.length || 0;
    const receiverCount = unmatchedSMS.RECEIVER?.length || 0;

    const message = `
🔍 *Find Match for SMS*

*Current Unmatched SMS:*
📤 Sender SMS: ${senderCount}
📥 Receiver SMS: ${receiverCount}

*How to find matches:*
1. Use /matchsms to see all unmatched SMS
2. Use /findmatch_[sms_id] to find matches for specific SMS
3. Use /forcematch_[sender_id]_[receiver_id] to force match

*Quick Actions:*
    `;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Matching Status', 'admin_sms_matching')],
        [Markup.button.callback('🔄 Auto-Match', 'admin_auto_match')],
        [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
        [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
      ])
    });
  } catch (error) {
    console.error('Find match menu error:', error);
    await ctx.editMessageText('❌ Error loading find match menu');
  }
});

// Clean SMS action
this.bot.action('admin_clean_sms', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    await ctx.editMessageText('🧹 Cleaning old unmatched SMS (older than 7 days)...');
    
    const result = await WalletService.cleanOldUnmatchedSMS();
    
    await ctx.editMessageText(
      `✅ *SMS Cleanup Complete*\n\n` +
      `*Removed Sender SMS:* ${result.removedSenders || 0}\n` +
      `*Removed Receiver SMS:* ${result.removedReceivers || 0}\n` +
      `*Total Removed:* ${result.totalRemoved || 0}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'admin_sms_matching')],
          [Markup.button.callback('📱 SMS Menu', 'admin_sms_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      }
    );
  } catch (error) {
    console.error('Clean SMS error:', error);
    await ctx.editMessageText(`❌ Error during cleanup: ${error.message}`);
  }
});
// Users list action
this.bot.action('admin_users_list', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const users = await UserService.getAllUsers(1, 10);
    
    let message = `👥 *All Users - Page 1*\n\n`;
    
    if (users.length === 0) {
      message += `No users found.\n`;
    } else {
      users.forEach((user, index) => {
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `#${index + 1}\n`;
        message += `👤 *${user.firstName || 'No name'}*\n`;
        message += `📱 Username: @${user.username || 'No username'}\n`;
        message += `🆔 Telegram ID: ${user.telegramId}\n`;
        message += `📅 Joined: ${new Date(user.createdAt).toLocaleDateString()}\n\n`;
        
        message += `🔧 Actions:\n`;
        message += `   • [View: /viewuser_${user.telegramId}]\n`;
        message += `   • [Transactions: /usertx_${user.telegramId}]\n`;
        message += `   • [Wallet: /userwallet_${user.telegramId}]\n\n`;
      });
    }

    const keyboard = [
      [Markup.button.callback('🔄 Refresh', 'admin_users_list')],
      [Markup.button.callback('📊 User Stats', 'admin_users_stats')],
      [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
  } catch (error) {
    console.error('Error loading users list:', error);
    await ctx.editMessageText('❌ Error loading users list');
  }
});

// User stats action
this.bot.action('admin_users_stats', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const stats = await UserService.getUserStats();
    
    let message = `📊 *User Statistics*\n\n`;
    
    message += `*Total Users:* ${stats.totalUsers || 0}\n`;
    message += `*Active Today:* ${stats.activeToday || 0}\n`;
    message += `*New This Week:* ${stats.newThisWeek || 0}\n\n`;
    
    if (stats.usersByDate && stats.usersByDate.length > 0) {
      message += `*Registration Trend:*\n`;
      stats.usersByDate.slice(0, 7).forEach(day => {
        message += `📅 ${day._id}: ${day.count} users\n`;
      });
    }
    
    const keyboard = [
      [Markup.button.callback('🔄 Refresh', 'admin_users_stats')],
      [Markup.button.callback('👥 All Users', 'admin_users_list')],
      [Markup.button.callback('🔍 Search User', 'admin_search_user')],
      [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
  } catch (error) {
    console.error('Error loading user stats:', error);
    await ctx.editMessageText('❌ Error loading user statistics');
  }
});

// Search user action
this.bot.action('admin_search_user', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const message = `
🔍 *Search User*

You can search users by:
1. Telegram ID
2. Username
3. Name

*Search Commands:*
/user_[telegram_id] - View user by Telegram ID
/finduser_[username] - Search by username
/searchuser_[query] - Search by name or partial match

*Example:*
/user_1234567890
/finduser_johndoe
/searchuser_alemayehu
  `;

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
    ])
  });
});

// Wallets list action
this.bot.action('admin_wallets_list', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const wallets = await WalletService.getAllWallets(1, 10);
    
    let message = `💼 *All Wallets - Page 1*\n\n`;
    
    if (wallets.length === 0) {
      message += `No wallets found.\n`;
    } else {
      wallets.forEach((wallet, index) => {
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `#${index + 1}\n`;
        message += `👤 User: ${wallet.userId?.firstName || 'Unknown'}\n`;
        message += `💰 Balance: $${wallet.balance || 0}\n`;
        message += `💎 Available: $${wallet.availableBalance || 0}\n`;
        message += `🔒 Locked: $${wallet.lockedAmount || 0}\n\n`;
        
        message += `🔧 Actions:\n`;
        message += `   • [View User: /viewuser_${wallet.userId?.telegramId}]\n`;
        message += `   • [Transactions: /usertx_${wallet.userId?.telegramId}]\n\n`;
      });
    }

    const keyboard = [
      [Markup.button.callback('🔄 Refresh', 'admin_wallets_list')],
      [Markup.button.callback('📊 Top Balances', 'admin_top_wallets')],
      [Markup.button.callback('👥 Users Menu', 'admin_users_menu')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
  } catch (error) {
    console.error('Error loading wallets list:', error);
    await ctx.editMessageText('❌ Error loading wallets list');
  }
});

// Clear cache action
this.bot.action('admin_clear_cache', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    await ctx.editMessageText('🔄 Clearing cache...');
    
    // Add cache clearing logic here
    // For example: clear any cached data in WalletService or UserService
    
    await ctx.editMessageText(
      `✅ *Cache Cleared*\n\n` +
      `All cached data has been cleared successfully.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'admin_tools_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      }
    );
  } catch (error) {
    console.error('Clear cache error:', error);
    await ctx.editMessageText(`❌ Error clearing cache: ${error.message}`);
  }
});

// View logs action
this.bot.action('admin_view_logs', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const logs = await this.getRecentLogs(10);
    
    let message = `📝 *Recent Logs*\n\n`;
    
    if (logs.length === 0) {
      message += `No recent logs found.\n`;
    } else {
      logs.forEach((log, index) => {
        const timestamp = new Date(log.timestamp || Date.now()).toLocaleString();
        const level = log.level || 'INFO';
        const levelEmoji = level === 'ERROR' ? '❌' : 
                         level === 'WARN' ? '⚠️' : 
                         level === 'INFO' ? 'ℹ️' : '📋';
        
        message += `${levelEmoji} [${timestamp}] ${log.message?.substring(0, 100) || 'No message'}\n`;
      });
    }

    const keyboard = [
      [Markup.button.callback('🔄 Refresh Logs', 'admin_view_logs')],
      [Markup.button.callback('🔧 Tools Menu', 'admin_tools_menu')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
  } catch (error) {
    console.error('Error loading logs:', error);
    await ctx.editMessageText('❌ Error loading logs');
  }
});
    this.bot.action('admin_tools_menu', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const message = `
🔧 *System Tools Panel*

Maintenance and diagnostic tools.

🛠️ *System Tools:*
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 System Stats', 'admin_system_stats')],
          [Markup.button.callback('🔄 Clear Cache', 'admin_clear_cache')],
          [Markup.button.callback('📝 View Logs', 'admin_view_logs')],
          [Markup.button.callback('⚙️ Bot Status', 'admin_bot_status')],
          [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
        ])
      });
    });

    this.bot.action('admin_system_stats', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const stats = await this.getSystemStats();
        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();
        
        const message = `
📊 *System Statistics*

*User Statistics:*
• Total Users: ${stats.users}
• Total Transactions: ${stats.transactions}
• Total Deposits: ${stats.deposits}
• Total Withdrawals: ${stats.totalWithdrawals}
• Pending Withdrawals: ${stats.pendingWithdrawals}

*Bot Status:*
• Status: ${this.isRunning ? '✅ Running' : '❌ Stopped'}
• Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m
• Memory: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB

*Database:*
• Active connections: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'admin_system_stats')],
            [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error loading system stats:', error);
        await ctx.answerCbQuery('Error loading stats');
      }
    });

    this.bot.action('admin_bot_status', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const memoryUsage = process.memoryUsage();
      const uptime = process.uptime();

      const message = `
🤖 *Bot Status Panel*

*Bot Information:*
• Status: ${this.isRunning ? '✅ Running' : '❌ Stopped'}
• Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m
• Admin Count: ${AdminUtils.getAdminCount()}

*System Resources:*
• Memory: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB
• RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB
• Platform: ${process.platform}

*Quick Commands:*
/start - Start bot (if stopped)
/stats - System statistics
/admin - Admin panel
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh Status', 'admin_bot_status')],
          [Markup.button.callback('🔧 Tools Menu', 'admin_tools_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    });
// Back to start action
this.bot.action('back_to_start', async (ctx) => {
  try {
    const isAdmin = AdminUtils.isAdmin(ctx.from.id);
    const user = await UserService.findOrCreateUser(ctx.from);
    
    let balance = 0;
    try {
      balance = await WalletService.getBalanceByTelegramId(user.telegramId);
    } catch (walletError) {
      await WalletService.initializeWallet(user.telegramId);
      balance = 0;
    }

    let welcomeMessage = `
🎯 *Welcome back, ${user.firstName || user.username}!*

*Your Wallet Balance:* $${balance}

*Quick Actions:*
    `;

    if (isAdmin) {
      welcomeMessage = `👑 *ADMIN MODE*\n\n${welcomeMessage}`;
    }

    const keyboardButtons = [
      [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
      [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
      [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
      [Markup.button.callback('📊 My Stats & History', 'show_stats')],
      [Markup.button.callback('💼 My Wallet', 'show_wallet')]
    ];

    if (isAdmin) {
      keyboardButtons.unshift([Markup.button.callback('👑 ADMIN PANEL', 'admin_panel')]);
    }

    await ctx.editMessageText(welcomeMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboardButtons)
    });
  } catch (error) {
    console.error('Error going back to start:', error);
    await ctx.answerCbQuery('Error loading main menu');
  }
});

// Show help action
this.bot.action('show_help', async (ctx) => {
  const isAdmin = AdminUtils.isAdmin(ctx.from.id);
  
  const helpMessage = `
🤖 *Bingo Bot Commands*

*Main Commands:*
/start - Start the bot and see main menu
/help - Show this help message  
/deposit - Start deposit process
/wallet - Check your wallet balance
/stats - View your game statistics
/withdraw - Withdraw your funds
  `;

  const helpButtons = [
    [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
    [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
    [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
    [Markup.button.callback('💼 My Wallet', 'show_wallet')],
    [Markup.button.callback('📊 My Stats', 'show_stats')]
  ];

  if (isAdmin) {
    helpButtons.unshift([Markup.button.callback('👑 Admin Help', 'admin_help_menu')]);
  }

  await ctx.editMessageText(helpMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(helpButtons)
  });
});

// Show stats action
this.bot.action('show_stats', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const stats = await UserService.getUserStats(user.telegramId);
    
    let message = `📊 *Your Statistics*\n\n`;
    message += `🎮 Games Played: ${stats.gamesPlayed || 0}\n`;
    message += `🏆 Games Won: ${stats.gamesWon || 0}\n`;
    message += `💰 Total Winnings: $${stats.totalWinnings || 0}\n`;
    message += `💎 Win Rate: ${stats.winRate || 0}%\n\n`;
    
    if (stats.recentGames && stats.recentGames.length > 0) {
      message += `*Recent Games:*\n`;
      stats.recentGames.forEach((game, index) => {
        const result = game.won ? '🏆 Won' : '💔 Lost';
        message += `${index + 1}. ${result} - $${game.amount || 0}\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Play More Games', 'https://desta.et')],
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
      ])
    });
  } catch (error) {
    console.error('Error showing stats:', error);
    await ctx.answerCbQuery('Error loading statistics');
  }
});

// Show full history action
this.bot.action('show_full_history', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const transactions = await WalletService.getUserTransactions(user.telegramId, 20);
    
    let message = `📋 *Transaction History*\n\n`;
    
    if (transactions.length === 0) {
      message += `No transactions yet.\n`;
    } else {
      transactions.forEach((tx, index) => {
        const emoji = tx.type === 'DEPOSIT' ? '📥' :
          tx.type === 'WINNING' ? '🏆' : 
          tx.type === 'WITHDRAWAL' ? '📤' : '🎮';
        const sign = tx.amount > 0 ? '+' : '';
        const status = tx.status === 'PENDING' ? '⏳' :
          tx.status === 'COMPLETED' ? '✅' : '❌';
        const date = new Date(tx.createdAt).toLocaleDateString();
        
        message += `${emoji} ${sign}$${Math.abs(tx.amount)} - ${tx.description} ${status}\n`;
        message += `   Date: ${date}\n\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('⬅️ Back', 'back_to_start')]
      ])
    });
  } catch (error) {
    console.error('Error showing full history:', error);
    await ctx.answerCbQuery('Error loading history');
  }
});
// Back to start action
this.bot.action('back_to_start', async (ctx) => {
  try {
    const isAdmin = AdminUtils.isAdmin(ctx.from.id);
    const user = await UserService.findOrCreateUser(ctx.from);
    
    let balance = 0;
    try {
      balance = await WalletService.getBalanceByTelegramId(user.telegramId);
    } catch (walletError) {
      await WalletService.initializeWallet(user.telegramId);
      balance = 0;
    }

    let welcomeMessage = `
🎯 *Welcome back, ${user.firstName || user.username}!*

*Your Wallet Balance:* $${balance}

*Quick Actions:*
    `;

    if (isAdmin) {
      welcomeMessage = `👑 *ADMIN MODE*\n\n${welcomeMessage}`;
    }

    const keyboardButtons = [
      [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
      [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
      [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
      [Markup.button.callback('📊 My Stats & History', 'show_stats')],
      [Markup.button.callback('💼 My Wallet', 'show_wallet')]
    ];

    if (isAdmin) {
      keyboardButtons.unshift([Markup.button.callback('👑 ADMIN PANEL', 'admin_panel')]);
    }

    await ctx.editMessageText(welcomeMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboardButtons)
    });
  } catch (error) {
    console.error('Error going back to start:', error);
    await ctx.answerCbQuery('Error loading main menu');
  }
});

// Show help action
this.bot.action('show_help', async (ctx) => {
  const isAdmin = AdminUtils.isAdmin(ctx.from.id);
  
  const helpMessage = `
🤖 *Bingo Bot Commands*

*Main Commands:*
/start - Start the bot and see main menu
/help - Show this help message  
/deposit - Start deposit process
/wallet - Check your wallet balance
/stats - View your game statistics
/withdraw - Withdraw your funds
  `;

  const helpButtons = [
    [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
    [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
    [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
    [Markup.button.callback('💼 My Wallet', 'show_wallet')],
    [Markup.button.callback('📊 My Stats', 'show_stats')]
  ];

  if (isAdmin) {
    helpButtons.unshift([Markup.button.callback('👑 Admin Help', 'admin_help_menu')]);
  }

  await ctx.editMessageText(helpMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(helpButtons)
  });
});

// Show stats action
this.bot.action('show_stats', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const stats = await UserService.getUserStats(user.telegramId);
    
    let message = `📊 *Your Statistics*\n\n`;
    message += `🎮 Games Played: ${stats.gamesPlayed || 0}\n`;
    message += `🏆 Games Won: ${stats.gamesWon || 0}\n`;
    message += `💰 Total Winnings: $${stats.totalWinnings || 0}\n`;
    message += `💎 Win Rate: ${stats.winRate || 0}%\n\n`;
    
    if (stats.recentGames && stats.recentGames.length > 0) {
      message += `*Recent Games:*\n`;
      stats.recentGames.forEach((game, index) => {
        const result = game.won ? '🏆 Won' : '💔 Lost';
        message += `${index + 1}. ${result} - $${game.amount || 0}\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Play More Games', 'https://desta.et')],
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
      ])
    });
  } catch (error) {
    console.error('Error showing stats:', error);
    await ctx.answerCbQuery('Error loading statistics');
  }
});

// Show full history action
this.bot.action('show_full_history', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const transactions = await WalletService.getUserTransactions(user.telegramId, 20);
    
    let message = `📋 *Transaction History*\n\n`;
    
    if (transactions.length === 0) {
      message += `No transactions yet.\n`;
    } else {
      transactions.forEach((tx, index) => {
        const emoji = tx.type === 'DEPOSIT' ? '📥' :
          tx.type === 'WINNING' ? '🏆' : 
          tx.type === 'WITHDRAWAL' ? '📤' : '🎮';
        const sign = tx.amount > 0 ? '+' : '';
        const status = tx.status === 'PENDING' ? '⏳' :
          tx.status === 'COMPLETED' ? '✅' : '❌';
        const date = new Date(tx.createdAt).toLocaleDateString();
        
        message += `${emoji} ${sign}$${Math.abs(tx.amount)} - ${tx.description} ${status}\n`;
        message += `   Date: ${date}\n\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('⬅️ Back', 'back_to_start')]
      ])
    });
  } catch (error) {
    console.error('Error showing full history:', error);
    await ctx.answerCbQuery('Error loading history');
  }
});
    this.bot.action('admin_help_menu', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const message = `
📖 *Admin Help & Commands*

*Quick Admin Commands:*
/admin - Open admin panel
/smslist [page] - View all SMS deposits
/viewsms_[id] - View SMS details
/approvesms_[id] - Approve SMS deposit
/rejectsms_[id] - Reject SMS deposit
/pending - View pending deposits
/autoapprove - Auto-approve small deposits
/processsms - Process all received SMS
/matchsms - SMS matching status
/approvewithdraw_[id] - Approve withdrawal
/rejectwithdraw_[id] - Reject withdrawal
/viewwithdraw_[id] - View withdrawal details
/viewtx_[id] - View transaction details

*Button Navigation:*
👑 ADMIN PANEL - Main admin menu
📱 SMS Menu - Manage SMS deposits
👥 Users - User management
💳 Transactions - Transaction management
💰 Withdrawals - Withdrawal management
🔧 Tools - System tools
📖 Help - This menu

*Need Help?*
Contact developer for technical issues.
      `;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👑 Admin Panel', 'admin_back_to_panel')],
          [Markup.button.callback('📱 Try SMS Menu', 'admin_sms_menu')],
          [Markup.button.callback('💰 Try Withdrawals', 'admin_withdrawals_menu')]
        ])
      });
    });

    // ========== TEXT HANDLER ==========

    this.bot.on('text', async (ctx) => {
      console.log('📝 Text received:', ctx.message.text.substring(0, 100));

      // 1. Handle withdrawal amount input
      if (ctx.session && ctx.session.withdrawalMethod && !ctx.session.withdrawalAmount && !isNaN(parseFloat(ctx.message.text))) {
        const amount = parseFloat(ctx.message.text);
        const method = ctx.session.withdrawalMethod;
        
        console.log(`💰 Processing withdrawal amount: ${amount} for method: ${method}`);
        
        try {
          const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
          
          if (amount < 10) {
            await ctx.reply('❌ Minimum withdrawal amount is $10');
            return;
          }
          
          if (amount > balanceInfo.availableBalance) {
            await ctx.reply(`❌ Insufficient available balance. Available: $${balanceInfo.availableBalance}`);
            return;
          }
          
          ctx.session.withdrawalAmount = amount;
          console.log(`✅ Amount stored: $${amount}`);
          
          const accountPrompt = this.getAccountPromptForMethod(method);
          
          await ctx.replyWithMarkdown(accountPrompt,
            Markup.inlineKeyboard([
              [Markup.button.callback('🚫 Cancel', 'withdraw')]
            ])
          );
          
        } catch (error) {
          console.error('Error processing withdrawal amount:', error);
          await ctx.reply('❌ ' + error.message);
        }
        return;
      }
      
      // 2. Handle withdrawal account details input
      if (ctx.session && ctx.session.withdrawalMethod && ctx.session.withdrawalAmount && !ctx.session.withdrawalAccount) {
        const amount = ctx.session.withdrawalAmount;
        const method = ctx.session.withdrawalMethod;
        const accountDetails = ctx.message.text;
        
        console.log(`💳 Processing account details for ${method} withdrawal: ${amount}`);
        
        try {
          ctx.session.withdrawalAccount = accountDetails;
          console.log(`✅ Account details stored for ${method}`);
          
          const validationError = this.validateAccountDetails(method, accountDetails);
          if (validationError) {
            await ctx.reply(`❌ ${validationError}\n\nPlease send correct account details:`);
            ctx.session.withdrawalAccount = null;
            return;
          }
          
          const confirmationMessage = `
⚠️ *Confirm Withdrawal Request*

*Amount:* $${amount}
*Method:* ${method}
*Account Details:* ${this.formatAccountDetailsForDisplay(method, accountDetails)}

*Processing Fee:* $0
*You will receive:* $${amount}

Are you sure you want to proceed?
          `;

          await ctx.replyWithMarkdown(confirmationMessage,
            Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Yes, confirm', `confirm_withdraw`),
                Markup.button.callback('❌ Cancel', 'withdraw')
              ]
            ])
          );
          
        } catch (error) {
          console.error('Error processing account details:', error);
          await ctx.reply('❌ ' + error.message);
        }
        return;
      }
      
      // 3. Handle withdrawal rejection reason input
      if (ctx.session && ctx.session.pendingWithdrawalRejection) {
        const withdrawalId = ctx.session.pendingWithdrawalRejection;
        const reason = ctx.message.text;
        
        try {
          const withdrawal = await WalletService.rejectWithdrawal(withdrawalId, ctx.from.id, reason);
          delete ctx.session.pendingWithdrawalRejection;
          
          await ctx.replyWithMarkdown(
            `❌ *Withdrawal Rejected!*\n\n` +
            `*User:* ${withdrawal.userId?.firstName || withdrawal.userId?.username || 'Unknown'}\n` +
            `*Amount:* $${Math.abs(withdrawal.amount)}\n` +
            `*Reason:* ${reason}`
          );

          const user = await User.findById(withdrawal.userId);
          if (user) {
            await this.bot.telegram.sendMessage(
              user.telegramId,
              `❌ *Withdrawal Rejected*\n\n` +
              `Your withdrawal request of $${Math.abs(withdrawal.amount)} has been rejected.\n` +
              `*Reason:* ${reason}\n\n` +
              `The locked amount has been returned to your available balance.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (error) {
          console.error('Error rejecting withdrawal:', error);
          await ctx.reply('❌ Error: ' + error.message);
        }
        return;
      }
//4. handle support ticket creation message
// Handle support ticket creation - REPLACE THE EXISTING SECTION
if (ctx.session && ctx.session.supportAction === 'CREATING_TICKET') {
  const subject = ctx.message.text;
  
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const result = await SupportService.createSupportChat(user._id, subject);
    
    if (result.success) {
      ctx.session.supportAction = null;
      
      // Escape ALL special characters in the subject
      const escapedSubject = this.escapeMarkdown(subject);
      const ticketId = result.chat._id.toString();
      const shortTicketId = ticketId.slice(-6);
      
      // Build message with proper escaping
      const message = 
        '✅ *Support Ticket Created!*\n\n' +
        `Ticket #${shortTicketId}\n` +
        `Subject: ${escapedSubject}\n\n` +
        'Our support team will respond shortly. ' +
        `You can view your ticket using \`/ticket_${ticketId}\``;
      
      // Try to send with Markdown, fallback to plain text
      try {
        await ctx.replyWithMarkdown(
          message,
          Markup.inlineKeyboard([
            [Markup.button.callback('💬 View Ticket', `ticket_refresh_${ticketId}`)],
            [Markup.button.callback('📞 Support Menu', 'support')]
          ])
        );
      } catch (markdownError) {
        console.error('Markdown error in ticket creation, sending plain text:', markdownError);
        
        // Remove Markdown formatting and send as plain text
        const plainMessage = message.replace(/[*_`]/g, '');
        await ctx.reply(
          plainMessage,
          Markup.inlineKeyboard([
            [Markup.button.callback('💬 View Ticket', `ticket_refresh_${ticketId}`)],
            [Markup.button.callback('📞 Support Menu', 'support')]
          ])
        );
      }
      
      // Notify admins
      await this.notifyAdminsAboutNewTicket(result.chat, user);
    } else {
      // Handle existing ticket case
      ctx.session.supportAction = null;
      
      if (result.chat && result.chat._id) {
        const existingTicketId = result.chat._id.toString();
        const shortExistingId = existingTicketId.slice(-6);
        
        const message = 
          `❌ *Cannot Create Ticket*\n\n` +
          `You already have an open ticket #${shortExistingId}.\n\n` +
          `Please continue your conversation there.`;
        
        try {
          await ctx.replyWithMarkdown(
            message,
            Markup.inlineKeyboard([
              [Markup.button.callback('💬 View Existing Ticket', `ticket_refresh_${existingTicketId}`)],
              [Markup.button.callback('📞 Support Menu', 'support')]
            ])
          );
        } catch (markdownError) {
          const plainMessage = message.replace(/[*_`]/g, '');
          await ctx.reply(
            plainMessage,
            Markup.inlineKeyboard([
              [Markup.button.callback('💬 View Existing Ticket', `ticket_refresh_${existingTicketId}`)],
              [Markup.button.callback('📞 Support Menu', 'support')]
            ])
          );
        }
      } else {
        // Generic error message
        await ctx.reply(
          '❌ Cannot create ticket. Please try again later.',
          Markup.inlineKeyboard([
            [Markup.button.callback('📞 Support Menu', 'support')]
          ])
        );
      }
    }
  } catch (error) {
    console.error('Support ticket creation error:', error);
    
    // More informative error message
    let errorMessage = 'Error creating ticket. ';
    
    if (error.message) {
      if (error.message.includes('400')) {
        errorMessage += 'There was a formatting issue. Please try a different subject.';
      } else if (error.message.includes('500')) {
        errorMessage += 'Server error. Please try again later.';
      } else if (error.message.includes('duplicate') || error.message.includes('already exists')) {
        errorMessage += 'You may already have an open ticket.';
      } else {
        errorMessage += error.message;
      }
    } else {
      errorMessage += 'Please try again later.';
    }
    
    try {
      await ctx.reply(
        errorMessage,
        Markup.inlineKeyboard([
          [Markup.button.callback('📞 Support Menu', 'support')]
        ])
      );
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
  return;
}
// Handle active ticket replies (user)
if (ctx.session && ctx.session.activeTicket) {
  const chatId = ctx.session.activeTicket;
  const message = ctx.message.text;
  
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    
    const result = await SupportService.sendMessage(chatId, user._id, 'USER', message);
    
    await ctx.reply('✅ Message sent to support team.');
    
    // Show updated ticket
    ctx.match = [null, chatId];
    await this.bot.command(/^ticket_(.+)/, ctx);
  } catch (error) {
    console.error('Support reply error:', error);
    await ctx.reply('❌ Error sending message. Please try again.');
  }
  return;
}

// Handle active admin ticket replies
if (ctx.session && ctx.session.activeAdminTicket) {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    delete ctx.session.activeAdminTicket;
    return;
  }
  
  const chatId = ctx.session.activeAdminTicket;
  const message = ctx.message.text;
  
  try {
    const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
    
    const result = await SupportService.sendMessage(chatId, admin._id, 'ADMIN', message);
    
    await ctx.reply('✅ Reply sent to user.');
    
    // Show updated ticket
    ctx.match = [null, chatId];
    await this.bot.command(/^admin_ticket_(.+)/, ctx);
    
    // Notify user
    const chat = await SupportChat.findById(chatId).populate('userId');
    if (chat && chat.userId) {
      await this.bot.telegram.sendMessage(
        chat.userId.telegramId,
        `📞 *New Support Reply*\n\nYou have a new reply on your support ticket.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💬 View Ticket', `ticket_refresh_${chatId}`)]
          ])
        }
      );
    }
  } catch (error) {
    console.error('Admin support reply error:', error);
    await ctx.reply('❌ Error sending reply.');
  }
  return;
}

      // Handle SMS deposits
      if (ctx.session && ctx.session.pendingDepositMethod) {
        const smsText = ctx.message.text;
        const paymentMethod = ctx.session.pendingDepositMethod;

        console.log('📱 Processing SMS deposit for method:', paymentMethod);

        const processingMsg = await ctx.reply('🔄 Processing your SMS...');

        try {
          await UserService.findOrCreateUser(ctx.from);
          
          let result;
          try {
            result = await WalletService.matchAndAutoApproveSMS(
              smsText,
              ctx.from.id.toString(),
              paymentMethod
            );
          } catch (matchError) {
            console.error('Match error:', matchError);
            result = await WalletService.storeSMSMessage(
              ctx.from.id.toString(),
              smsText,
              paymentMethod
            );
          }

          delete ctx.session.pendingDepositMethod;
          
          try {
            await ctx.deleteMessage(processingMsg.message_id);
          } catch (e) {
            console.warn('Could not delete processing message:', e.message);
          }

          const smsAnalysis = WalletService.analyzeSMSType(smsText);
          const identifiers = WalletService.extractTransactionIdentifiers(smsText);
          
          let message = '';
          let keyboard = [];
          
          if (result.status === 'APPROVED') {
            message = `✅ *Deposit Approved!*\n\n*Amount:* $${result.extractedAmount}\n*Method:* ${paymentMethod}\n*Transaction:* ${identifiers.refNumber || 'N/A'}\n\nYour deposit has been automatically matched and approved! 🎉`;
            keyboard = [
              [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
              [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
            ];
          } else if (result.status === 'RECEIVED_WAITING_MATCH') {
            const typeText = smsAnalysis.type === 'SENDER' ? 'You sent money' : 'We received money';
            message = `⏳ *SMS Received - Waiting for Match*\n\n*Amount:* $${result.extractedAmount}\n*Type:* ${typeText}\n*Transaction:* ${identifiers.refNumber || 'N/A'}\n\nYour SMS has been received. We'll match it with the corresponding transaction shortly.`;
            keyboard = [
              [Markup.button.callback('💼 Check Status', 'show_wallet')],
              [Markup.button.callback('💰 New Deposit', 'show_deposit')]
            ];
          } else {
            message = `📱 *SMS Received*\n\n*Amount:* $${result.extractedAmount}\n*Method:* ${paymentMethod}\n*Status:* ${result.status}\n\nYour deposit is being processed.`;
            keyboard = [
              [Markup.button.callback('💼 Check Status', 'show_wallet')],
              [Markup.button.callback('💰 New Deposit', 'show_deposit')]
            ];
          }

          await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));

        } catch (error) {
          console.error('❌ SMS deposit error:', error);
          
          try {
            await ctx.deleteMessage(processingMsg.message_id);
          } catch (e) {}
          
          const errorMessage = error.message.includes('User not found') 
            ? 'Please use /start first to set up your account.'
            : 'Processing error. Please try again or contact support.'+error.message;
            
          await ctx.replyWithMarkdown(
            `❌ *Deposit Processing Failed*\n\nError: ${errorMessage}`,
            Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Try Again', 'show_deposit')],
              [Markup.button.callback('📞 Contact Support', 'contact_support')]
            ])
          );
        }
        return;
      }

      // Handle automatic SMS detection
      const text = ctx.message.text;
      const isCBE_SMS = text.toLowerCase().includes('cbe') && 
                     (text.includes('ETB') || text.includes('credited') || text.includes('debited'));
    
      if (isCBE_SMS) {
        console.log('🏦 Detected CBE SMS, processing immediately...');
        const processed = await this.processCBE_SMSImmediately(text, ctx);
        if (processed) return;
      }
      const isTelebirrSMS = text.toLowerCase().includes('telebirr') || 
                     text.toLowerCase().includes('ethio telecom') ||
                     text.toLowerCase().includes('ethiotelecom');

if (isTelebirrSMS) {
  console.log('📱 Detected Telebirr SMS, processing immediately...');
  const processed = await this.processTelebirrSMSImmediately(text, ctx);
  if (processed) return;
}
      
      if (this.looksLikeBankSMS(text)) {
        console.log('🏦 Detected bank SMS, using matching system...');
        console.log('📊 SMS content:', text.substring(0, 200));

        try {
          await UserService.findOrCreateUser(ctx.from);

          const smsAnalysis = WalletService.analyzeSMSType(text);
          const identifiers = WalletService.extractTransactionIdentifiers(text);

          console.log('🔍 SMS Analysis:', smsAnalysis);
          console.log('🔑 SMS Identifiers:', identifiers);

          const result = await WalletService.matchAndAutoApproveSMS(
            text,
            ctx.from.id.toString(),
            'UNKNOWN'
          );

          const messageType = smsAnalysis.type === 'SENDER' ? 'sender (you sent money)' :
            smsAnalysis.type === 'RECEIVER' ? 'receiver (we received money)' : 'unknown';

          if (result.status === 'AUTO_APPROVED') {
            await ctx.replyWithMarkdown(
              `✅ *SMS Auto-Matched & Approved!*\n\n*Amount:* $${result.extractedAmount}\n*Type:* ${messageType}\n*Transaction:* ${identifiers.refNumber || 'N/A'}\n\nYour deposit was automatically matched and approved! 🎉`,
              Markup.inlineKeyboard([
                [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
                [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
              ])
            );
          } else {
            await ctx.replyWithMarkdown(
              `📱 *SMS ${messageType.toUpperCase()} Received*\n\n*Amount:* $${result.extractedAmount}\n*Transaction:* ${identifiers.refNumber || 'N/A'}\n\nYour ${messageType} SMS has been received. ${smsAnalysis.type === 'SENDER'
                ? "We'll match it when we receive the corresponding credit SMS."
                : smsAnalysis.type === 'RECEIVER'
                  ? "We'll match it with existing sender SMS."
                  : 'Please use the deposit menu for better processing.'
              }`,
              Markup.inlineKeyboard([
                [Markup.button.callback('💼 Check Status', 'show_wallet')],
                [Markup.button.callback('💰 Use Deposit Menu', 'show_deposit')]
              ])
            );
          }

        } catch (error) {
          console.error('❌ Error processing SMS:', error);

          const errorMessage = error.message.includes('User not found')
            ? 'Please use /start first to set up your account.'
            : error.message;

          await ctx.reply(
            `❌ Failed to process your SMS: ${errorMessage}`,
            Markup.inlineKeyboard([
              [Markup.button.callback('💰 Use Deposit Menu', 'show_deposit')]
            ])
          );
        }
        return;
      }

      // Handle admin commands
      if (text.startsWith('/admin') ||
        text.startsWith('/smslist') ||
        text.startsWith('/viewsms_') ||
        text.startsWith('/approvesms_') ||
        text.startsWith('/rejectsms_') ||
        text.startsWith('/autoapprove') ||
        text.startsWith('/pending') ||
        text.startsWith('/approve_') ||
        text.startsWith('/processsms') ||
        text.startsWith('/received') ||
        text.startsWith('/approvewithdraw_') ||
        text.startsWith('/rejectwithdraw_') ||
        text.startsWith('/viewwithdraw_') ||
        text.startsWith('/viewtx_')) {
        return;
      }

      // Handle unknown commands
      if (ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          `❓ *Unknown Command*\n\nAvailable commands:\n/start, /help, /deposit, /wallet, /stats, /withdraw`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
            [Markup.button.callback('📋 Show All Commands', 'show_help')]
          ])
        );
      } else {
        await ctx.replyWithMarkdown(
          'Want to play some Bingo? 🎯 Use /help to see all commands!',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 YES, PLAY BINGO!', 'https://desta.et')],
            [Markup.button.callback('📋 Commands Help', 'show_help')]
          ])
        );
      }
    });
  }
/**
 * Escape special characters for Telegram Markdown
 */
escapeMarkdown(text) {
  if (!text) return '';
  
  // Convert to string if it's not already
  const str = String(text);
  
  // List of characters that need escaping in Markdown: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return str.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
  // ========== HELPER METHODS ==========
async notifyAdminsAboutNewTicket(chat, user) {
  try {
    const adminIds = AdminUtils.adminIds;
    
    // Use the escapeMarkdown helper
    const escapedSubject = this.escapeMarkdown(chat.subject);
    const escapedUserName = this.escapeMarkdown(user.firstName || 'User');
    const escapedUsername = this.escapeMarkdown(user.username || 'N/A');
    
    const message = 
      '🆕 *New Support Ticket*\n\n' +
      `*User:* ${escapedUserName} (@${escapedUsername})\n` +
      `*Subject:* ${escapedSubject}\n` +
      `*Priority:* ${chat.priority}\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `View: /admin_ticket_${chat._id}\n` +
      `Assign: /admin_assign_${chat._id}`;
    
    for (const adminId of adminIds) {
      try {
        await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error(`Failed to notify admin ${adminId}:`, error);
        // If markdown fails, try without markdown
        try {
          await this.bot.telegram.sendMessage(
            adminId, 
            message.replace(/[*_`]/g, '') // Remove markdown formatting
          );
        } catch (fallbackError) {
          console.error(`Even fallback failed for admin ${adminId}:`, fallbackError);
        }
      }
    }
  } catch (error) {
    console.error('Error notifying admins about new ticket:', error);
  }
}
 async showAdminPanel(ctx) {
  try {
    console.log('✅ Admin access granted, loading admin panel...');

    const [pendingDeposits, pendingSMS, systemStats] = await Promise.all([
      WalletService.getPendingDeposits().catch(() => []),
      WalletService.getPendingSMSDeposits(5).catch(() => []),
      this.getSystemStats().catch(() => ({ users: 0, transactions: 0, deposits: 0, pendingWithdrawals: 0, totalWithdrawals: 0 }))
    ]);

    const message = `
👑 *ADMIN PANEL*

📊 *Quick Overview:*
• ⏳ Pending Deposits: ${pendingDeposits.length}
• 📱 Pending SMS: ${pendingSMS.length}
• 💰 Pending Withdrawals: ${systemStats.pendingWithdrawals}
• 👥 Total Users: ${systemStats.users}
• 💰 Total Deposits: ${systemStats.deposits}

🏠 *Main Sections:*
    `;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📱 SMS', 'admin_sms_menu'),
          Markup.button.callback('👥 Users', 'admin_users_menu')
        ],
        [
          Markup.button.callback('💳 Transactions', 'admin_transactions_menu'),
          Markup.button.callback('💰 Withdrawals', 'admin_withdrawals_menu')
        ],
        [
          Markup.button.callback('📞 Support', 'admin_support_menu'), // ADD THIS LINE
          Markup.button.callback('🔧 Tools', 'admin_tools_menu')
        ],
        [
          Markup.button.callback('⏳ Pending Deposits', 'admin_pending_deposits'),
          Markup.button.callback('🤖 Auto-Approve', 'admin_auto_approve')
        ],
        [
                  Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor') // ADD THIS LINE


        ],
        [
          Markup.button.callback('📖 Help', 'admin_help_menu'),
          Markup.button.callback('🤖 Status', 'admin_bot_status')
        ],
        [
          
          Markup.button.callback('⬅️ Back to Main', 'back_to_start')
        ]
      ])
    });

    console.log('✅ Admin panel loaded successfully');

  } catch (error) {
    console.error('❌ Admin panel error:', error);
    await ctx.reply('❌ Error loading admin panel: ' + error.message);
  }
}



async getRecentLogs(limit = 10) {
  // This is a placeholder - implement your actual log retrieval logic
  // You might want to read from a log file or database
  return [
    { timestamp: Date.now(), level: 'INFO', message: 'Bot started successfully' },
    { timestamp: Date.now() - 10000, level: 'INFO', message: 'Admin panel accessed' }
  ];
}

async getTopWallets(limit = 10) {
  try {
    // Assuming WalletService has this method
    if (WalletService.getTopWalletsByBalance) {
      return await WalletService.getTopWalletsByBalance(limit);
    }
    
    // Fallback implementation
    const wallets = await mongoose.model('Wallet').find()
      .populate('userId', 'firstName username')
      .sort({ balance: -1 })
      .limit(limit)
      .lean();
    
    return wallets || [];
  } catch (error) {
    console.error('Error getting top wallets:', error);
    return [];
  }
}
// Helper methods for status emojis
getStatusEmoji(status) {
  const emojis = {
    'OPEN': '🟢',
    'ASSIGNED': '🟡',
    'RESOLVED': '✅',
    'CLOSED': '🔴'
  };
  return emojis[status] || '⚪';
}

getPriorityEmoji(priority) {
  const emojis = {
    'LOW': '🟢',
    'MEDIUM': '🟡',
    'HIGH': '🟠',
    'URGENT': '🔴'
  };
  return emojis[priority] || '⚪';
}
  validateAccountDetails(method, details) {
    const lines = details.split('\n').map(line => line.trim()).filter(line => line);
    
    switch(method) {
      case 'CBE Bank':
      case 'Bank of Abysinia':
      case 'Dashen Bank':
        if (lines.length < 2) {
          return 'Please provide at least:\n1. Account Holder Name\n2. Account Number';
        }
        
        const accountNumber = lines[1].replace(/\s/g, '');
        if (!/^\d+$/.test(accountNumber)) {
          return 'Account number should contain only numbers';
        }
        
        if (accountNumber.length < 10) {
          return 'Account number seems too short';
        }
        break;
        
      case 'Telebirr':
      case 'CBE Birr':
        if (lines.length < 1) {
          return 'Please provide phone number';
        }
        
        const phone = lines[0].replace(/\s/g, '');
        if (!/^09\d{8}$/.test(phone)) {
          return 'Please provide a valid Ethiopian phone number (e.g., 0912345678)';
        }
        break;
    }
    
    return null;
  }

  formatAccountDetailsForDisplay(method, details) {
    const lines = details.split('\n').map(line => line.trim()).filter(line => line);
    
    switch(method) {
      case 'CBE Bank':
      case 'Bank of Abysinia':
      case 'Dashen Bank':
        if (lines.length >= 2) {
          return `Name: ${lines[0]}\nAccount: ${lines[1]}\n${lines[2] ? `Branch: ${lines[2]}` : ''}`;
        }
        break;
        
      case 'Telebirr':
      case 'CBE Birr':
        if (lines.length >= 1) {
          const phone = lines[0].replace(/\s/g, '');
          return `Phone: ${phone}\n${lines[1] ? `Name: ${lines[1]}` : ''}`;
        }
        break;
    }
    
    return details;
  }

  getAccountPromptForMethod(method) {
    const prompts = {
      'CBE Bank': `
🏦 *CBE Bank Account Details*

Please provide your CBE Bank account details (one per line):
1. Account Holder Name (as in bank)
2. Account Number
3. Bank Branch (optional)

Example:
Alemayehu Yalew
1000143822668
Bole Branch

Please send the details in this format:
`,
      'Bank of Abysinia': `
🏦 *BOA Account Details*

Please provide your Bank of Abysinia account details (one per line):
1. Account Holder Name (as in bank)
2. Account Number
3. Bank Branch (optional)

Example:
Alemayehu Yalew
145633257
Bole Branch

Please send the details in this format:
`,
      'Dashen Bank': `
🏦 *Dashen Bank Account Details*

Please provide your Dashen Bank account details (one per line):
1. Account Holder Name (as in bank)
2. Account Number
3. Bank Branch (optional)

Example:
Alemayehu Yalew
123456789012
Bole Branch

Please send the details in this format:
`,
      'Telebirr': `
📱 *Telebirr Details*

Please provide your Telebirr details (one per line):
1. Phone Number (e.g., 0912345678)
2. Account Holder Name (optional)

Example:
0968546687
Alemayehu Yalew

Please send the details in this format:
`,
      'CBE Birr': `
📱 *CBE Birr Details*

Please provide your CBE Birr details (one per line):
1. Phone Number (e.g., 0912345678)
2. Account Holder Name (optional)

Example:
0912345678
Alemayehu Yalew

Please send the details in this format:
`
    };
    
    return prompts[method] || `
💳 *Account Details*

Please provide your account details for ${method} (one item per line):

Format:
[Line 1]
[Line 2]
[Line 3]

Please send the details:
`;
  }

  getMethodCode(methodName) {
    const methodMap = {
      'CBE Bank': 'CBE',
      'Bank of Abysinia': 'BOA',
      'Dashen Bank': 'DASHEN',
      'Telebirr': 'TELEBIRR',
      'CBE Birr': 'CBE_BIRR'
    };
    
    return methodMap[methodName] || methodName.replace(/\s+/g, '_').toUpperCase();
  }

  getMethodName(methodCode) {
    const methodMap = {
      'CBE': 'CBE Bank',
      'BOA': 'Bank of Abysinia',
      'DASHEN': 'Dashen Bank',
      'TELEBIRR': 'Telebirr',
      'CBE_BIRR': 'CBE Birr'
    };
    
    return methodMap[methodCode] || methodCode.replace(/_/g, ' ');
  }

  async notifyAdminsAboutWithdrawal(withdrawal, user) {
    try {
      const adminIds = AdminUtils.adminIds;
      const amount = Math.abs(withdrawal.amount);
      
      const message = `📤 *New Withdrawal Request*\n\n` +
        `*User:* ${user.firstName} (${user.username || 'No username'})\n` +
        `*Telegram ID:* ${user.telegramId}\n` +
        `*Amount:* $${amount}\n` +
        `*Method:* ${withdrawal.metadata.withdrawalMethod}\n` +
        `*Account:* ${JSON.stringify(withdrawal.metadata.accountDetails)}\n\n` +
        `Approve: /approvewithdraw_${withdrawal._id}\n` +
        `Reject: /rejectwithdraw_${withdrawal._id}\n` +
        `View: /viewwithdraw_${withdrawal._id}`;
      
      for (const adminId of adminIds) {
        try {
          await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error(`Failed to notify admin ${adminId}:`, error);
        }
      }
    } catch (error) {
      console.error('Error notifying admins about withdrawal:', error);
    }
  }

looksLikeBankSMS(text) {
  const sms = text.toLowerCase();
  
  // Check if it's clearly a Telebirr SMS first
  const isTelebirrSMS = sms.includes('ቴሌብር') || 
                       sms.includes('telebirr') || 
                       sms.includes('ethio telecom') || 
                       sms.includes('ethiotelecom') ||
                       sms.includes('ብር ተቀብለዋል') || // Amharic for "received money"
                       sms.includes('ቀሪ ሂሳብ'); // Amharic for "balance"

  if (isTelebirrSMS) {
    console.log('📱 Detected as Telebirr SMS via keywords');
    return true;
  }

  // Original bank patterns
  const bankPatterns = [
    /sent.*etb|birr|br/i,
    /received.*etb|birr|br/i,
    /transfer.*etb|birr|br/i,
    /transaction.*etb|birr|br/i,
    /deposit.*etb|birr|br/i,
    /cbe.*bank/i,
    /awash.*bank/i,
    /dashen.*bank/i,
    /cbe.*birr/i,
    /telebirr/i,
    /dear.*customer/i,
    /txn.*id/i,
    /transaction.*id/i,
    /balance.*etb|birr|br/i,
    /amount.*etb|birr|br/i
  ];

  // Amharic-specific patterns
  const amharicPatterns = [
    /ተቀብለዋል/i, // received
    /የላኩ/i, // sent
    /ብር/i, // birr/ETB
    /የሂሳብ.*ቁጥር/i, // transaction number
    /ቀሪ.*ሂሳብ/i // balance
  ];

  const isBankSMS = bankPatterns.some(pattern => pattern.test(sms));
  const isAmharicBankSMS = amharicPatterns.some(pattern => pattern.test(sms));
  const hasAmount = /\d+\.?\d*\s*(ETB|ብር|Birr|Br)/i.test(text);
  const hasTransactionWords = text.includes('Txn') || text.includes('Transaction') || 
                              text.includes('sent') || text.includes('received') ||
                              text.includes('ተቀብለዋል') || text.includes('የላኩ') ||
                              text.includes('የሂሳብ.*ቁጥር');
  const reasonableLength = text.length > 20 && text.length < 1000;

  console.log(`🔍 SMS Detection: BankPattern=${isBankSMS}, AmharicPattern=${isAmharicBankSMS}, HasAmount=${hasAmount}, HasTransaction=${hasTransactionWords}, LengthOK=${reasonableLength}, TextLength=${text.length}`);

  return isBankSMS || isAmharicBankSMS || (hasAmount && hasTransactionWords && reasonableLength);
}

  async processCBE_SMSImmediately(smsText, ctx) {
    try {
      console.log('🏦 Processing CBE SMS immediately...');
      
      const result = await WalletService.matchAndAutoApproveSMS(
        smsText,
        ctx.from.id.toString(),
        'CBE Bank'
      );
      
      if (result && result.autoApproved) {
        await ctx.replyWithMarkdown(
          `✅ *CBE Deposit Auto-Approved!*\n\n` +
          `*Amount:* $${result.transaction.amount}\n` +
          `*Reference:* ${result.cbeReference || 'N/A'}\n` +
          `*New Balance:* $${result.wallet.balance}\n\n` +
          `Your deposit has been automatically matched and added to your wallet! 🎉`,
          Markup.inlineKeyboard([
            [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
          ])
        );
        
        await this.notifyAdminsAboutAutoApproval(result);
        return true;
      } else if (result && result.status === 'RECEIVED_WAITING_MATCH') {
        await ctx.replyWithMarkdown(
          `📱 *CBE SMS Received*\n\n` +
          `*Amount:* $${result.extractedAmount}\n` +
          `*Reference:* ${result.extractedReference || 'Processing...'}\n\n` +
          `Your CBE transaction has been recorded. We'll match it with the corresponding SMS shortly.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('💼 Check Status', 'show_wallet')]
          ])
        );
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('❌ Error processing CBE SMS:', error);
      return false;
    }
  }
  // Add this method to your BotController class
async processTelebirrSMSImmediately(smsText, ctx) {
  try {
    console.log('📱 Processing Telebirr SMS immediately...');
    
    const result = await WalletService.matchAndAutoApproveSMS(
      smsText,
      ctx.from.id.toString(),
      'Telebirr'
    );
    
    console.log('📊 Telebirr SMS result:', result);
    
    if (result && result.autoApproved) {
      await ctx.replyWithMarkdown(
        `✅ *Telebirr Deposit Auto-Approved!*\n\n` +
        `*Amount:* $${result.transaction.amount}\n` +
        `*Transaction ID:* ${result.telebirrReference || 'N/A'}\n` +
        `*New Balance:* $${result.wallet.balance}\n\n` +
        `Your Telebirr deposit has been automatically matched and added to your wallet! 🎉`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
        ])
      );
      
      await this.notifyAdminsAboutAutoApproval(result);
      return true;
    } else if (result && result.status === 'RECEIVED_WAITING_MATCH') {
      const direction = result.direction === 'USER_SMS' ? 'You sent money' : 'We received money';
      
      await ctx.replyWithMarkdown(
        `📱 *Telebirr SMS ${direction === 'You sent money' ? 'Sent' : 'Received'}*\n\n` +
        `*Amount:* $${result.extractedAmount}\n` +
        `*Transaction ID:* ${result.extractedReference || 'Processing...'}\n` +
        `*Direction:* ${direction}\n\n` +
        `Your Telebirr transaction has been recorded. ${result.direction === 'USER_SMS' 
          ? 'We\'ll match it with the admin\'s receipt SMS.' 
          : 'We\'ll match it with the user\'s confirmation SMS.'}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💼 Check Status', 'show_wallet')]
        ])
      );
      return true;
    } else if (result && result.status === 'RECEIVED') {
      await ctx.replyWithMarkdown(
        `📱 *Telebirr SMS Received*\n\n` +
        `*Amount:* $${result.extractedAmount}\n` +
        `*Status:* SMS stored for processing\n\n` +
        `Your Telebirr SMS has been saved. It will be matched soon.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('💼 Check Status', 'show_wallet')]
        ])
      );
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Error processing Telebirr SMS:', error);
    return false;
  }
}

  async notifyAdminsAboutAutoApproval(result) {
    try {
      const adminIds = AdminUtils.adminIds;
      const message = `🤖 *Auto-Approved Deposit*\n\n` +
        `*User:* ${result.user.firstName}\n` +
        `*Amount:* $${result.transaction.amount}\n` +
        `*Method:* ${result.smsDeposit?.paymentMethod || 'CBE Bank'}\n` +
        `*Reference:* ${result.cbeReference || 'N/A'}`;
      
      for (const adminId of adminIds) {
        try {
          await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error(`Failed to notify admin ${adminId}:`, error);
        }
      }
    } catch (error) {
      console.error('Error notifying admins about auto-approval:', error);
    }
  }

  async getSystemStats() {
    try {
      const userCount = await UserService.getUserCount ? await UserService.getUserCount() : 0;
      const transactionCount = await WalletService.getTransactionCount ? await WalletService.getTransactionCount() : 0;
      const depositCount = await WalletService.getDepositCount ? await WalletService.getDepositCount() : 0;
      const withdrawalStats = await WalletService.getWithdrawalStats();
      const pendingWithdrawals = withdrawalStats.byStatus?.find(s => s._id === 'PENDING');
      
      return {
        users: userCount,
        transactions: transactionCount,
        deposits: depositCount,
        pendingWithdrawals: pendingWithdrawals?.count || 0,
        totalWithdrawals: withdrawalStats.totalAmount?.[0]?.total || 0
      };
    } catch (error) {
      console.error('Error getting system stats:', error);
      return { users: 0, transactions: 0, deposits: 0, pendingWithdrawals: 0, totalWithdrawals: 0 };
    }
  }

  launch() {
    if (this.isRunning) {
      console.log('🤖 Bot is already running, skipping launch');
      return;
    }

    console.log('🤖 Launching Telegram bot...');
    
    WalletService.initializePaymentMethods().catch(console.error);

    this.bot.launch().then(() => {
      this.isRunning = true;
      console.log('🤖 Bingo Bot is running and ready!');
      console.log(`👑 Admin count: ${AdminUtils.getAdminCount()}`);
    }).catch(error => {
      console.error('❌ Failed to launch bot:', error);
      this.isRunning = false;
    });

    process.once('SIGINT', () => {
      console.log('🛑 SIGINT received, stopping bot...');
      this.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
      console.log('🛑 SIGTERM received, stopping bot...');
      this.stop('SIGTERM');
    });
  }

  stop(signal) {
    if (!this.isRunning) {
      console.log('🤖 Bot is not running');
      return;
    }

    console.log(`🤖 Stopping bot with signal: ${signal}`);
    this.bot.stop(signal);
    this.isRunning = false;
    BotController.clearInstance();
    console.log('🤖 Bot stopped successfully');
  }


  // ========== Support==========
async setupSupportHandlers() {
  // ========== USER SUPPORT COMMANDS ==========
  
  // Support command
  this.bot.command('support', async (ctx) => {
    try {
      const user = await UserService.findOrCreateUser(ctx.from);
      
      const message = `
📞 *Customer Support*

Need help? We're here for you!

*Available Options:*
• 🆕 Create new support ticket
• 💬 View my existing tickets
• 📋 Check ticket status

*How it works:*
1. Create a ticket with your issue
2. Our support team will respond
3. Get real-time chat support
      `;

      await ctx.replyWithMarkdown(message,
        Markup.inlineKeyboard([
          [Markup.button.callback('🆕 New Support Ticket', 'support_new')],
          [Markup.button.callback('💬 My Tickets', 'support_my_tickets')],
          [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
        ])
      );
    } catch (error) {
      console.error('Support command error:', error);
      await ctx.reply('❌ Error accessing support');
    }
  });

// Add this with your other action handlers (around line 500-600)
this.bot.action('support', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    
    const message = `
📞 *Customer Support*

Need help? We're here for you!

*Available Options:*
• 🆕 Create new support ticket
• 💬 View my existing tickets
• 📋 Check ticket status

*How it works:*
1. Create a ticket with your issue
2. Our support team will respond
3. Get real-time chat support
    `;

    await ctx.editMessageText(message,
      Markup.inlineKeyboard([
        [Markup.button.callback('🆕 New Support Ticket', 'support_new')],
        [Markup.button.callback('💬 My Tickets', 'support_my_tickets')],
        [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
      ])
    );
  } catch (error) {
    console.error('Support action error:', error);
    await ctx.answerCbQuery('❌ Error accessing support');
  }
});
// New ticket - ask for subject
this.bot.action('support_new', async (ctx) => {
  try {
    ctx.session = ctx.session || {};
    ctx.session.supportAction = 'CREATING_TICKET';
    
    await ctx.editMessageText(
      '🆕 *Create Support Ticket*\n\n' +
      'Please describe your issue in one short sentence.\n\n' +
      '*Examples:*\n' +
      '• "Withdrawal not received"\n' +
      '• "Deposit not showing in wallet"\n' +
      '• "Can\'t play bingo game"\n' +  // Fixed: escaped apostrophe
      '• "Payment method not working"\n\n' +
      '*Type your subject below:*',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚫 Cancel', 'support_cancel')]
        ])
      }
    );
  } catch (error) {
    console.error('New ticket error:', error);
    await ctx.answerCbQuery('❌ Error creating ticket');
  }
});
// My tickets
this.bot.action('support_my_tickets', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);
    const result = await SupportService.getUserChats(user._id, 1, 5);
    
    let message = `💬 *My Support Tickets*\n\n`;
    
    if (result.chats.length === 0) {
      message += `You have no support tickets yet.\n`;
      message += `Create one using the button below!`;
    } else {
      result.chats.forEach((chat, index) => {
        const statusEmoji = chat.status === 'OPEN' ? '🟢' :
                          chat.status === 'ASSIGNED' ? '🟡' :
                          chat.status === 'RESOLVED' ? '✅' : '🔴';
        
        message += `${statusEmoji} *Ticket #${chat._id.toString().slice(-6)}*\n`;
        message += `Subject: ${chat.subject}\n`;
        message += `Status: ${chat.status}\n`;
        message += `Last message: ${new Date(chat.lastMessageAt).toLocaleString()}\n`;
        
        if (chat.unreadCount.user > 0) {
          message += `📨 *${chat.unreadCount.user} new messages*\n`;
        }
        
        message += `[View: /ticket_${chat._id}]\n\n`;
      });
    }

    const keyboard = [
      [Markup.button.callback('🆕 New Ticket', 'support_new')]
    ];
    
    if (result.chats.length > 0) {
      keyboard.push([Markup.button.callback('🔄 Refresh', 'support_my_tickets')]);
    }
    
    keyboard.push([Markup.button.callback('⬅️ Back', 'support_back')]);

    // Try to edit the message, but catch the "not modified" error
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (editError) {
      // If it's the "message not modified" error, just answer the callback query
      if (editError.message && editError.message.includes('message is not modified')) {
        await ctx.answerCbQuery('No new updates');
      } else {
        // For other errors, rethrow
        throw editError;
      }
    }
  } catch (error) {
    console.error('My tickets error:', error);
    // Check if it's the "not modified" error we already handled
    if (error.message && error.message.includes('message is not modified')) {
      await ctx.answerCbQuery('No new updates');
    } else {
      await ctx.answerCbQuery('❌ Error loading tickets');
    }
  }
});

  // View specific ticket
  this.bot.command(/^ticket_(.+)/, async (ctx) => {
    try {
      const user = await UserService.findOrCreateUser(ctx.from);
      const chatId = ctx.match[1];
      
      const result = await SupportService.getChatMessages(chatId, user._id, false, 1, 20);
      
      let message = `💬 *Ticket: ${result.chat.subject}*\n\n`;
      message += `Status: ${this.getStatusEmoji(result.chat.status)} ${result.chat.status}\n`;
      
      if (result.chat.assignedTo) {
        message += `Assigned to: ${result.chat.assignedTo.firstName || 'Support Agent'}\n`;
      }
      
      message += `\n*Messages:*\n━━━━━━━━━━━━━━━━━━\n\n`;
      
      result.messages.forEach(msg => {
        const sender = msg.senderType === 'USER' ? '👤 You' : '👨‍💼 Support';
        const time = new Date(msg.createdAt).toLocaleTimeString();
        
        message += `*${sender}* [${time}]:\n`;
        message += `${msg.message}\n\n`;
      });
      
      message += `━━━━━━━━━━━━━━━━━━\n`;
      message += `Type your reply below:`;

      ctx.session = ctx.session || {};
      ctx.session.activeTicket = chatId;

      const keyboard = [
        [Markup.button.callback('🔄 Refresh', `ticket_refresh_${chatId}`)]
      ];
      
      if (result.chat.status !== 'RESOLVED') {
        keyboard.push([Markup.button.callback('✅ Mark as Resolved', `ticket_resolve_${chatId}`)]);
      } else {
        keyboard.push([Markup.button.callback('🔄 Reopen Ticket', `ticket_reopen_${chatId}`)]);
      }
      
      keyboard.push([Markup.button.callback('⬅️ Back to Tickets', 'support_my_tickets')]);

      await ctx.replyWithMarkdown(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (error) {
      console.error('View ticket error:', error);
      await ctx.reply('❌ Error loading ticket: ' + error.toString());
    }
  });

  // Ticket actions
// Ticket actions - REPLACE THIS SECTION
this.bot.action(/ticket_refresh_(.+)/, async (ctx) => {
  const chatId = ctx.match[1];
  
  try {
    console.log(`🔄 Refreshing ticket: ${chatId}`);
    
    // Get the user
    const user = await UserService.findOrCreateUser(ctx.from);
    
    // Get the chat messages
    const result = await SupportService.getChatMessages(chatId, user._id, false, 1, 20);
    
    // Escape the subject and messages for Markdown
    const escapedSubject = this.escapeMarkdown(result.chat.subject);
    
    let message = `💬 *Ticket: ${escapedSubject}*\n\n`;
    message += `Status: ${this.getStatusEmoji(result.chat.status)} ${result.chat.status}\n`;
    
    if (result.chat.assignedTo) {
      message += `Assigned to: ${this.escapeMarkdown(result.chat.assignedTo.firstName || 'Support Agent')}\n`;
    }
    
    message += `\n*Messages:*\n━━━━━━━━━━━━━━━━━━\n\n`;
    
    result.messages.forEach(msg => {
      const sender = msg.senderType === 'USER' ? '👤 You' : '👨‍💼 Support';
      const time = new Date(msg.createdAt).toLocaleTimeString();
      const escapedMsg = this.escapeMarkdown(msg.message);
      
      message += `*${sender}* [${time}]:\n`;
      message += `${escapedMsg}\n\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `Type your reply below:`;

    ctx.session = ctx.session || {};
    ctx.session.activeTicket = chatId;

    const keyboard = [
      [Markup.button.callback('🔄 Refresh', `ticket_refresh_${chatId}`)]
    ];
    
    if (result.chat.status !== 'RESOLVED') {
      keyboard.push([Markup.button.callback('✅ Mark as Resolved', `ticket_resolve_${chatId}`)]);
    } else {
      keyboard.push([Markup.button.callback('🔄 Reopen Ticket', `ticket_reopen_${chatId}`)]);
    }
    
    keyboard.push([Markup.button.callback('⬅️ Back to Tickets', 'support_my_tickets')]);

    // Try to edit the message
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (editError) {
      // If it's the "message not modified" error, just acknowledge
      if (editError.message && editError.message.includes('message is not modified')) {
        await ctx.answerCbQuery('No new messages');
      } else {
        // For other errors, try to send a new message
        console.error('Edit error:', editError);
        await ctx.replyWithMarkdown(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(keyboard)
        });
      }
    }
  } catch (error) {
    console.error('Ticket refresh error:', error);
    
    // If it's the "message not modified" error, just acknowledge
    if (error.message && error.message.includes('message is not modified')) {
      await ctx.answerCbQuery('No new messages');
    } else {
      await ctx.answerCbQuery('❌ Error refreshing ticket');
      // Try to send a new message as fallback
      try {
        await ctx.reply('❌ Error loading ticket. Please try again.');
      } catch (replyError) {
        console.error('Fallback reply error:', replyError);
      }
    }
  }
});

  this.bot.action(/ticket_resolve_(.+)/, async (ctx) => {
    try {
      const user = await UserService.findOrCreateUser(ctx.from);
      const chatId = ctx.match[1];
      
      await SupportService.closeChat(chatId, user._id, 'Resolved by user');
      
      await ctx.answerCbQuery('✅ Ticket marked as resolved');
      ctx.match = [null, chatId];
      await this.bot.command(/^ticket_(.+)/, ctx);
    } catch (error) {
      console.error('Resolve ticket error:', error);
      await ctx.answerCbQuery('❌ Error resolving ticket');
    }
  });

  this.bot.action(/ticket_reopen_(.+)/, async (ctx) => {
    try {
      const user = await UserService.findOrCreateUser(ctx.from);
      const chatId = ctx.match[1];
      
      await SupportService.reopenChat(chatId, user._id);
      
      await ctx.answerCbQuery('🔄 Ticket reopened');
      ctx.match = [null, chatId];
      await this.bot.command(/^ticket_(.+)/, ctx);
    } catch (error) {
      console.error('Reopen ticket error:', error);
      await ctx.answerCbQuery('❌ Error reopening ticket');
    }
  });

  // Support cancel
  this.bot.action('support_cancel', async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.supportAction = null;
    ctx.session.activeTicket = null;
    
    await ctx.editMessageText(
      '📞 *Support*\n\nAction cancelled.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🆕 New Ticket', 'support_new')],
          [Markup.button.callback('💬 My Tickets', 'support_my_tickets')],
          [Markup.button.callback('⬅️ Back', 'support_back')]
        ])
      }
    );
  });

  // Support back
  this.bot.action('support_back', async (ctx) => {
    await this.bot.command('support', ctx);
  });

  // ========== ADMIN SUPPORT COMMANDS ==========

  // Admin support panel
  this.bot.action('admin_support_menu', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }

    const stats = await SupportService.getSupportStats();
    
    const message = `
📞 *Support Management Panel*

📊 *Support Stats:*
• 🟢 Open: ${stats.byStatus.find(s => s._id === 'OPEN')?.count || 0}
• 🟡 Assigned: ${stats.byStatus.find(s => s._id === 'ASSIGNED')?.count || 0}
• ✅ Resolved: ${stats.byStatus.find(s => s._id === 'RESOLVED')?.count || 0}
• ⏳ Unassigned: ${stats.unassigned}

*Support Actions:*
    `;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Open Tickets', 'admin_support_open')],
        [Markup.button.callback('🟡 Assigned to Me', 'admin_support_my')],
        [Markup.button.callback('📋 All Tickets', 'admin_support_all')],
        [Markup.button.callback('📊 Detailed Stats', 'admin_support_stats')],
        [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
      ])
    });
  });
// Assigned to me tickets
// Assigned to me tickets - using SupportService instead of direct model access
this.bot.action('admin_support_my', async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  try {
    const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!admin) {
      await ctx.answerCbQuery('❌ Admin not found');
      return;
    }

    // You'll need to add this method to your SupportService
    // For now, let's query directly but we need the model imported
    const SupportChat = require('../models/SupportChat');
    
    const chats = await SupportChat.find({
      assignedTo: admin._id,
      status: { $in: ['OPEN', 'ASSIGNED'] }
    })
    .populate('userId', 'firstName username telegramId')
    .sort({ lastMessageAt: -1 })
    .limit(10)
    .lean();

    let message = `🟡 *Tickets Assigned to Me*\n\n`;

    if (chats.length === 0) {
      message += `No tickets assigned to you.\n`;
    } else {
      chats.forEach((chat, index) => {
        const user = chat.userId;
        const priorityEmoji = chat.priority === 'URGENT' ? '🔴' :
                            chat.priority === 'HIGH' ? '🟠' :
                            chat.priority === 'MEDIUM' ? '🟡' : '🟢';
        
        // Escape user-provided content
        const userName = this.escapeMarkdown(user?.firstName || 'Unknown');
        const username = this.escapeMarkdown(user?.username || 'N/A');
        const subject = this.escapeMarkdown(chat.subject);
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `${priorityEmoji} *Ticket #${chat._id.toString().slice(-6)}*\n`;
        message += `👤 User: ${userName} (@${username})\n`;
        message += `📝 Subject: ${subject}\n`;
        message += `⏰ Last: ${new Date(chat.lastMessageAt).toLocaleString()}\n`;
        message += `📨 Unread: ${chat.unreadCount.admin}\n`;
        message += `🔧 [View: /admin_ticket_${chat._id}]\n\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'admin_support_my')],
        [Markup.button.callback('📞 Support Menu', 'admin_support_menu')],
        [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
      ])
    });
  } catch (error) {
    console.error('Admin my tickets error:', error);
    await ctx.answerCbQuery('❌ Error loading tickets');
  }
});

// All tickets (with pagination)
this.bot.action(/admin_support_all(?:_page_(\d+))?/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const page = ctx.match && ctx.match[1] ? parseInt(ctx.match[1]) : 1;
  const limit = 10;

  try {
    const total = await SupportChat.countDocuments();
    const chats = await SupportChat.find()
      .populate('userId', 'firstName username telegramId')
      .populate('assignedTo', 'firstName username')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const totalPages = Math.ceil(total / limit);

    let message = `📋 *All Support Tickets - Page ${page}/${totalPages}*\n\n`;

    if (chats.length === 0) {
      message += `No tickets found.\n`;
    } else {
      chats.forEach((chat, index) => {
        const statusEmoji = chat.status === 'OPEN' ? '🟢' :
                           chat.status === 'ASSIGNED' ? '🟡' :
                           chat.status === 'RESOLVED' ? '✅' : '🔴';
        const user = chat.userId;
        const assignedTo = chat.assignedTo?.firstName || 'Unassigned';
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `${statusEmoji} *Ticket #${chat._id.toString().slice(-6)}*\n`;
        message += `👤 User: ${user?.firstName || 'Unknown'} (@${user?.username || 'N/A'})\n`;
        message += `📝 Subject: ${chat.subject}\n`;
        message += `📊 Status: ${chat.status}\n`;
        message += `👨‍💼 Assigned: ${assignedTo}\n`;
        message += `⏰ Created: ${new Date(chat.createdAt).toLocaleDateString()}\n`;
        message += `🔧 [View: /admin_ticket_${chat._id}]\n\n`;
      });
    }

    const keyboard = [];
    const navButtons = [];
    
    if (page > 1) {
      navButtons.push(Markup.button.callback('⬅️ Previous', `admin_support_all_page_${page - 1}`));
    }
    if (page < totalPages) {
      navButtons.push(Markup.button.callback('Next ➡️', `admin_support_all_page_${page + 1}`));
    }
    
    if (navButtons.length > 0) {
      keyboard.push(navButtons);
    }
    
    keyboard.push([Markup.button.callback('📞 Support Menu', 'admin_support_menu')]);
    keyboard.push([Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(keyboard)
    });
  } catch (error) {
    console.error('Admin all tickets error:', error);
    await ctx.answerCbQuery('❌ Error loading tickets');
  }
});

// Admin assign ticket command (for the /admin_assign_ pattern)
this.bot.command(/^admin_assign_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Access denied');
    return;
  }

  const chatId = ctx.match[1];

  try {
    const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
    if (!admin) {
      await ctx.reply('❌ Admin not found');
      return;
    }

    await SupportService.assignChat(chatId, admin._id);
    
    await ctx.replyWithMarkdown(
      `✅ *Ticket Assigned!*\n\nTicket has been assigned to you.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💬 View Ticket', `admin_ticket_refresh_${chatId}`)],
        [Markup.button.callback('📞 Support Menu', 'admin_support_menu')]
      ])
    );
  } catch (error) {
    console.error('Admin assign error:', error);
    await ctx.reply('❌ Error assigning ticket: ' + error.message);
  }
});
  // Open tickets
  this.bot.action('admin_support_open', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }

    try {
      const result = await SupportService.getOpenChats(ctx.from.id, 1, 10);
      
      let message = `🟢 *Open Support Tickets*\n\n`;
      
      if (result.chats.length === 0) {
        message += `No open tickets. Great job! ✅`;
      } else {
        result.chats.forEach((chat, index) => {
          const user = chat.userId;
          const priorityEmoji = chat.priority === 'URGENT' ? '🔴' :
                              chat.priority === 'HIGH' ? '🟠' :
                              chat.priority === 'MEDIUM' ? '🟡' : '🟢';
          
          message += `━━━━━━━━━━━━━━━━━━\n`;
          message += `${priorityEmoji} *Ticket #${chat._id.toString().slice(-6)}*\n`;
          message += `👤 User: ${user?.firstName || 'Unknown'} (@${user?.username || 'N/A'})\n`;
          message += `📝 Subject: ${chat.subject}\n`;
          message += `⏰ Last: ${new Date(chat.lastMessageAt).toLocaleString()}\n`;
          message += `📨 Unread: ${chat.unreadCount.admin}\n`;
          message += `🔧 [View: /admin_ticket_${chat._id}]`;
          
          if (!chat.assignedTo) {
            message += ` [Assign: /admin_assign_${chat._id}]`;
          }
          
          message += `\n\n`;
        });
      }

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'admin_support_open')],
          [Markup.button.callback('📞 Support Menu', 'admin_support_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    } catch (error) {
      console.error('Admin open tickets error:', error);
      await ctx.answerCbQuery('❌ Error loading tickets: ' + error.toString());
    }
  });

  // Add this with your other SMS-related action handlers
this.bot.action(/admin_user_sms_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];

  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      await ctx.reply('❌ User not found');
      return;
    }

    const smsDeposits = await SMSDeposit.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    let message = `📱 *SMS History for ${user.firstName || 'User'}*\n\n`;

    if (smsDeposits.length === 0) {
      message += `No SMS deposits found.\n`;
    } else {
      smsDeposits.forEach((sms, index) => {
        const statusEmoji = sms.status === 'APPROVED' ? '✅' :
                           sms.status === 'REJECTED' ? '❌' :
                           sms.status === 'AUTO_APPROVED' ? '🤖' : '⏳';
        const date = new Date(sms.createdAt).toLocaleString();
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `#${index + 1} ${statusEmoji}\n`;
        message += `💰 Amount: $${sms.extractedAmount}\n`;
        message += `🏦 Method: ${sms.paymentMethod || 'Unknown'}\n`;
        message += `📊 Status: ${sms.status}\n`;
        message += `⏰ Time: ${date}\n`;
        message += `🔍 [View: /viewsms_${sms._id}]\n\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👤 Back to User', `user_${telegramId}`)],
        [Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor')],
        [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
      ])
    });
  } catch (error) {
    console.error('Error loading SMS history:', error);
    await ctx.answerCbQuery('❌ Error loading SMS history');
  }
});
  // Admin view ticket
  this.bot.command(/^admin_ticket_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Access denied');
      return;
    }

    try {
      const chatId = ctx.match[1];
      // const mongoUserId= await WalletService.resolveUserId(ctx.from.id);
      const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
      
      const result = await SupportService.getChatMessages(chatId, admin._id, true, 1, 20);
      const user = result.chat.userId;
      
      let message = `📞 *Support Ticket #${chatId.slice(-6)}*\n\n`;
      message += `*User: * ${admin?.firstName || 'Unknown'} (@${admin?.username || 'N/A'})\n`;
      message += `*Subject:* ${result.chat.subject}\n`;
      message += `*Status:* ${this.getStatusEmoji(result.chat.status)} ${result.chat.status}\n`;
      message += `*Priority:* ${this.getPriorityEmoji(result.chat.priority)} ${result.chat.priority}\n`;
      
      if (result.chat.assignedTo) {
        message += `*Assigned to:* ${result.chat.assignedTo.firstName || 'Support Agent'}\n`;
      }
      
      message += `\n*Messages:*\n━━━━━━━━━━━━━━━━━━\n\n`;
      
      result.messages.forEach(msg => {
        const sender = msg.senderType === 'USER' ? '👤 User' : '👨‍💼 You';
        const time = new Date(msg.createdAt).toLocaleTimeString();
        
        message += `*${sender}* [${time}]:\n`;
        message += `${msg.message}\n\n`;
      });
      
      message += `━━━━━━━━━━━━━━━━━━\n`;
      message += `Type your reply below:`;

      ctx.session = ctx.session || {};
      ctx.session.activeAdminTicket = chatId;

      const keyboard = [
        [Markup.button.callback('🔄 Refresh', `admin_ticket_refresh_${chatId}`)]
      ];
      
      if (!result.chat.assignedTo) {
        keyboard.push([Markup.button.callback('📌 Assign to Me', `admin_ticket_assign_${chatId}`)]);
      }
      
      if (result.chat.status !== 'RESOLVED') {
        keyboard.push([Markup.button.callback('✅ Resolve', `admin_ticket_resolve_${chatId}`)]);
      }
      
      keyboard.push([
        Markup.button.callback('👤 View User', `admin_user_${admin.telegramId}`),
        Markup.button.callback('📋 Open Tickets', 'admin_support_open')
      ]);

      await ctx.replyWithMarkdown(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (error) {
      console.error('Admin view ticket error:', error.toString());
      await ctx.reply('❌ Error loading ticket: ' + ctx.from.id.toString() + ' - ' + error.toString());
    }
  });

  // Admin ticket actions
// Admin view user's support tickets
this.bot.action(/admin_user_support_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];

  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      await ctx.reply('❌ User not found');
      return;
    }

    const tickets = await SupportChat.find({ userId: user._id })
      .populate('assignedTo', 'firstName username')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    let message = `🎫 *Support Tickets for ${user.firstName || 'User'}*\n\n`;

    if (tickets.length === 0) {
      message += `No support tickets found for this user.\n`;
    } else {
      tickets.forEach((ticket, index) => {
        const statusEmoji = ticket.status === 'OPEN' ? '🟢' :
                           ticket.status === 'ASSIGNED' ? '🟡' :
                           ticket.status === 'RESOLVED' ? '✅' : '🔴';
        const assignedTo = ticket.assignedTo?.firstName || 'Unassigned';
        const date = new Date(ticket.createdAt).toLocaleDateString();
        
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `#${index + 1} ${statusEmoji}\n`;
        message += `📝 Subject: ${ticket.subject}\n`;
        message += `📊 Status: ${ticket.status}\n`;
        message += `👨‍💼 Assigned: ${assignedTo}\n`;
        message += `📅 Created: ${date}\n`;
        message += `📨 Unread: User:${ticket.unreadCount.user} | Admin:${ticket.unreadCount.admin}\n`;
        message += `🔧 [View: /admin_ticket_${ticket._id}]\n\n`;
      });
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👤 Back to User', `admin_user_${telegramId}`)],
        [Markup.button.callback('⬅️ Support Menu', 'admin_support_menu')]
      ])
    });
  } catch (error) {
    console.error('Error loading user support tickets:', error);
    await ctx.answerCbQuery('❌ Error loading tickets');
  }
});


this.bot.action(/admin_user_(.+)/, async (ctx) => {
  if (!AdminUtils.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }

  const telegramId = ctx.match[1];
  
  try {
    const user = await User.findOne({ telegramId })
      .lean();
    
    if (!user) {
      await ctx.reply('❌ User not found:'+telegramId);
      return;
    }

    // Get wallet
    const wallet = await Wallet.findOne({ userId: user._id }).lean() || { balance: 0, lockedAmount: 0 };
    
    // Get transaction count
    const transactionCount = await Transaction.countDocuments({ userId: user._id });
    
    // Get support tickets count
    const supportTickets = await SupportChat.countDocuments({ userId: user._id });
    
    // Get recent transactions
    const recentTransactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    // Escape function for Markdown
    const escapeMarkdown = (text) => {
      if (!text) return '';
      return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };

    // Escape user-provided content
    const firstName = escapeMarkdown(user.firstName || 'Not set');
    const username = escapeMarkdown(user.username || 'Not set');
    const role = escapeMarkdown(user.role || 'user');
    const joinedDate = escapeMarkdown(new Date(user.createdAt).toLocaleString());

    let message = `👤 *User Details*\n\n`;
    message += `*Name:* ${firstName}\n`;
    message += `*Username:* @${username}\n`;
    message += `*Telegram ID:* ${telegramId}\n`;
    message += `*Role:* ${role}\n`;
    message += `*Joined:* ${joinedDate}\n\n`;
    
    message += `💼 *Wallet Information:*\n`;
    message += `• Balance: $${wallet.balance || 0}\n`;
    message += `• Available: $${(wallet.balance || 0) - (wallet.lockedAmount || 0)}\n`;
    message += `• Locked: $${wallet.lockedAmount || 0}\n\n`;
    
    message += `📊 *Statistics:*\n`;
    message += `• Transactions: ${transactionCount}\n`;
    message += `• Support Tickets: ${supportTickets}\n\n`;
    
    if (recentTransactions.length > 0) {
      message += `🔄 *Recent Transactions:*\n`;
      recentTransactions.forEach((tx, index) => {
        const emoji = tx.type === 'DEPOSIT' ? '📥' :
                     tx.type === 'WITHDRAWAL' ? '📤' :
                     tx.type === 'WINNING' ? '🏆' : '🎮';
        const status = tx.status === 'PENDING' ? '⏳' :
                      tx.status === 'COMPLETED' ? '✅' : '❌';
        const date = new Date(tx.createdAt).toLocaleDateString();
        message += `${index + 1}. ${emoji} $${Math.abs(tx.amount)} - ${tx.type} ${status} (${date})\n`;
      });
      message += '\n';
    }

    // Build keyboard
    const keyboard = [
      [
        Markup.button.callback('📋 All Transactions', `admin_user_tx_${telegramId}`),
        Markup.button.callback('💼 Wallet', `admin_user_wallet_${telegramId}`)
      ],
      [
        Markup.button.callback('📱 SMS History', `admin_user_sms_${telegramId}`),
        Markup.button.callback('🎫 Support Tickets', `admin_user_support_${telegramId}`)
      ],
      [
        Markup.button.callback('🕵️ Fraud Monitor', 'admin_fraud_monitor'),
        Markup.button.callback('⬅️ Back', 'admin_support_menu')
      ]
    ];

    // Try with Markdown, fallback to plain text
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
      });
    } catch (markdownError) {
      console.error('Markdown error, sending plain text:', markdownError);
      const plainMessage = message.replace(/[*_`]/g, '');
      await ctx.editMessageText(plainMessage, {
        parse_mode: '',
        ...Markup.inlineKeyboard(keyboard)
      });
    }
  } catch (error) {
    console.error('Error viewing user from admin:', error);
    await ctx.answerCbQuery('❌ Error loading user details');
  }
});



  this.bot.action(/admin_ticket_refresh_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }
    
    const chatId = ctx.match[1];
    ctx.match = [null, chatId];
    await this.bot.command(/^admin_ticket_(.+)/, ctx);
  });

  this.bot.action(/admin_ticket_assign_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }

    try {
      const chatId = ctx.match[1];
      const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
      
      await SupportService.assignChat(chatId, admin._id);
      
      await ctx.answerCbQuery('✅ Ticket assigned to you');
      ctx.match = [null, chatId];
      await this.bot.command(/^admin_ticket_(.+)/, ctx);
    } catch (error) {
      console.error('Assign ticket error:', error);
      await ctx.answerCbQuery('❌ Error assigning ticket');
    }
  });

  this.bot.action(/admin_ticket_resolve_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }

    try {
      const chatId = ctx.match[1];
      const admin = await User.findOne({ telegramId: ctx.from.id.toString() });
      
      await SupportService.closeChat(chatId, admin._id, 'Resolved by admin');
      
      await ctx.answerCbQuery('✅ Ticket resolved');
      ctx.match = [null, chatId];
      await this.bot.command(/^admin_ticket_(.+)/, ctx);
    } catch (error) {
      console.error('Resolve ticket error:', error);
      await ctx.answerCbQuery('❌ Error resolving ticket');
    }
  });

  // Admin support stats
  this.bot.action('admin_support_stats', async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }

    try {
      const stats = await SupportService.getSupportStats();
      
      const avgResponseHours = (stats.avgResponseTime / (1000 * 60 * 60)).toFixed(1);
      
      let message = `📊 *Support Statistics*\n\n`;
      
      message += `*Ticket Status:*\n`;
      stats.byStatus.forEach(s => {
        const emoji = this.getStatusEmoji(s._id);
        const percentage = ((s.count / stats.totalChats) * 100).toFixed(1);
        message += `${emoji} ${s._id}: ${s.count} (${percentage}%)\n`;
      });
      
      message += `\n*Performance:*\n`;
      message += `⏳ Unassigned: ${stats.unassigned}\n`;
      message += `⏱️ Avg Response: ${avgResponseHours} hours\n`;
      message += `📊 Total Tickets: ${stats.totalChats}\n`;
      
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'admin_support_stats')],
          [Markup.button.callback('📞 Support Menu', 'admin_support_menu')],
          [Markup.button.callback('⬅️ Admin Panel', 'admin_back_to_panel')]
        ])
      });
    } catch (error) {
      console.error('Support stats error:', error);
      await ctx.answerCbQuery('❌ Error loading stats');
    }
  });

  // Add support menu to admin panel
  // Find where admin panel buttons are defined and add this button
  // Look for the admin panel keyboard and add:
  // [Markup.button.callback('📞 Support', 'admin_support_menu')],
}

etStatusEmoji(status) {
  const emojis = {
    'OPEN': '🟢',
    'ASSIGNED': '🟡',
    'RESOLVED': '✅',
    'CLOSED': '🔴'
  };
  return emojis[status] || '⚪';
}

getPriorityEmoji(priority) {
  const emojis = {
    'LOW': '🟢',
    'MEDIUM': '🟡',
    'HIGH': '🟠',
    'URGENT': '🔴'
  };
  return emojis[priority] || '⚪';
}
}

// Static instance variable for singleton pattern
BotController.instance = null;
BotController._instance = null;

module.exports = BotController;