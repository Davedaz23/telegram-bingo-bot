// botController.js - UPDATED VERSION WITH SINGLETON PATTERN
const { Telegraf, Markup, session } = require('telegraf'); // ADD session import
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');
const SMSDeposit = require('../models/SMSDeposit');
// ✅ NEW: AdminUtils for multiple admin support
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User'); 
const AdminUtils = {
  adminIds: [],
  
  initialize() {
    // Get admin IDs from environment variables
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
      console.log('🤖 Bot instance already exists, returning existing instance');
      return BotController.instance;
    }
    
    this.bot = new Telegraf(botToken);
    this.isRunning = false;
    
    // ✅ Initialize AdminUtils
    AdminUtils.initialize();
     this.bot.use(session({
      defaultSession: () => ({
        // Default session structure
        pendingDepositMethod: null,
        withdrawalMethod: null,
        withdrawalAmount: null,
        withdrawalAccount: null,
        pendingWithdrawalRejection: null
      })
    }));
    this.setupHandlers();
    
    BotController.instance = this;
    console.log('🤖 New BotController instance created');
  }

  static getInstance(botToken, adminId) {
    if (!BotController.instance) {
      BotController.instance = new BotController(botToken, adminId);
    }
    return BotController.instance;
  }

  static clearInstance() {
    BotController.instance = null;
  }

  // ✅ Use AdminUtils for all admin checks
  isUserAdmin(userId) {
    return AdminUtils.isAdmin(userId);
  }

  setupHandlers() {
    // Start command - ensures user is created
     this.bot.start(async (ctx) => {
      try {
        console.log('🚀 Start command received from:', ctx.from.id, ctx.from.first_name);

        // Check if user is admin - FIXED: ADD THIS LINE
       const isAdmin = AdminUtils.isAdmin(ctx.from.id);
        
        const user = await UserService.findOrCreateUser(ctx.from);
        console.log('✅ User processed:', user.telegramId, user._id);

        let balance = 0;
        try {
          balance = await WalletService.getBalanceByTelegramId(user.telegramId);
          console.log('✅ Wallet balance retrieved:', balance);
        } catch (walletError) {
          console.log('⚠️ Wallet not initialized, creating now...');
          try {
            await WalletService.initializeWallet(user.telegramId);
            balance = 0;
            console.log('✅ Wallet initialized successfully');
          } catch (initError) {
            console.error('❌ Failed to initialize wallet:', initError);
            balance = user.walletBalance || 0;
          }
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

        // Add admin badge if user is admin
        if (isAdmin) {
          welcomeMessage = `👑 *ADMIN MODE*\n\n${welcomeMessage}`;
        }

        // ALL BUTTONS FOR REGULAR USERS
        const keyboardButtons = [
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
          [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
            [Markup.button.callback('📤 Withdraw Funds', 'withdraw')],
          [Markup.button.callback('📊 My Stats & History', 'show_stats')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')]
        ];

        // Add Admin Panel button ONLY for admin users - KEEP OTHER BUTTONS
        if (isAdmin) {
          // Add Admin Panel as the first button, keep all other buttons
          keyboardButtons.unshift([Markup.button.callback('👑 ADMIN PANEL', 'admin_panel')]);
        }

        await ctx.replyWithMarkdown(welcomeMessage,
          Markup.inlineKeyboard(keyboardButtons)
        );

        console.log('✅ Start command completed successfully');

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
      const isAdmin = ctx.from.id.toString() === this.adminId;
      
      const helpMessage = `
🤖 *Bingo Bot Commands*

*Main Commands:*
/start - Start the bot and see main menu
/help - Show this help message  
/deposit - Start deposit process
/wallet - Check your wallet balance
/stats - View your game statistics

*Quick Actions via Buttons:*
🎮 Play Bingo - Open the web app to play
💰 Deposit Money - Add funds to your wallet
📊 My Stats - View your game history
💼 My Wallet - Check balance & transactions

*Deposit Methods:*
🏦 Banks: CBE, BOA
📱 Mobile Money: Telebirr
      `;

      const helpButtons = [
        [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
        [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
        [Markup.button.callback('💼 My Wallet', 'show_wallet')],
        [Markup.button.callback('📊 My Stats', 'show_stats')]
      ];

      // Add admin help button if user is admin
      if (isAdmin) {
        helpButtons.unshift([Markup.button.callback('👑 Admin Help', 'admin_help_menu')]);
      }

      await ctx.replyWithMarkdown(helpMessage,
        Markup.inlineKeyboard(helpButtons)
      );
    });

    this.bot.command('matchsms', async (ctx) => {
     if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const [unmatchedSMS, matchedPairs] = await Promise.all([
          WalletService.getUnmatchedSMS(),
          //WalletService.findRecentlyMatchedSMS()
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
        const result = await WalletService.adminForceMatchSMS(senderSMSId, receiverSMSId, ctx.from.id);

        await ctx.replyWithMarkdown(
          `✅ *Force Match Successful!*\n\n*User:* ${result.senderSMS.userId.firstName}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}\n\nBoth SMS have been matched and the deposit has been approved.`
        );

      } catch (error) {
        console.error('Force match error:', error);
        await ctx.reply('❌ Error force matching: ' + error.message);
      }
    });

    // Deposit command
    this.bot.command('deposit', async (ctx) => {
      try {
        await UserService.findOrCreateUser(ctx.from);

        const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, BOA, 
📱 *Mobile Money:*  Telebirr

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

    // Wallet command
  // Update the wallet command to show proper balance information:
this.bot.command('wallet', async (ctx) => {
  try {
    const user = await UserService.findOrCreateUser(ctx.from);

    let balanceInfo = { totalBalance: 0, availableBalance: 0, lockedAmount: 0 };
    let transactions = [];

    try {
      // Get detailed balance info including locked amounts
      balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
      transactions = await WalletService.getUserTransactions(user.telegramId);
    } catch (error) {
      console.error('Error getting wallet info:', error);
      // Initialize wallet if it doesn't exist
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

    // Stats command
    this.bot.command('stats', async (ctx) => {
      try {
        await UserService.findOrCreateUser(ctx.from);
        const userStats = await UserService.getUserStats(ctx.from.id);

        const statsMessage = `
📊 *Your Bingo Stats*

*Games Played:* ${userStats.gamesPlayed || 0}
*Games Won:* ${userStats.gamesWon || 0}
*Win Rate:* ${userStats.winRate || 0}%
*Total Winnings:* $${userStats.totalWinnings || 0}

*Recent Activity:*
${userStats.recentGames || 'No games played yet'}

Keep playing to improve your stats! 🎯
        `;

        await ctx.replyWithMarkdown(statsMessage,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play More Games', 'https://desta.et')],
            [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
          ])
        );
      } catch (error) {
        console.error('Error in stats command:', error);
        await ctx.replyWithMarkdown(
          `📊 *Your Bingo Stats*\n\n*Games Played:* 0\n*Games Won:* 0\n*Win Rate:* 0%\n\nStart playing to see your stats! 🎯`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
          ])
        );
      }
    });

    // ========== ADMIN COMMANDS ==========

       // Admin command - Shows structured admin menu
    this.bot.command('admin', async (ctx) => {
      console.log('🔐 Admin command received from:', ctx.from.id, 'Expected admin:', this.adminId);

       if (!AdminUtils.isAdmin(ctx.from.id)) {
        console.log('❌ Access denied for user:', ctx.from.id);
        await ctx.reply('❌ Access denied');
        return;
      }

      await this.showAdminPanel(ctx);
    });

// Withdrawal command
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

// Start withdrawal process
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
// Handle withdraw button click

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
// Withdrawal method selection
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
  
  // Store method in session - CRITICAL: ctx.session should already exist
  if (!ctx.session) {
    ctx.session = {};
  }
  
  // Clear any previous withdrawal data
  ctx.session.withdrawalMethod = methodName;
  ctx.session.withdrawalAmount = null;
  ctx.session.withdrawalAccount = null;
  
  console.log(`💰 Withdrawal method set: ${methodName}, Session:`, ctx.session);
  
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

// Withdrawal history
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

*Recent Withdrawals:*
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



    // Admin panel action handler
    this.bot.action('admin_panel', async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }
      await this.showAdminPanel(ctx);
    });

    // Admin back to panel action
    this.bot.action('admin_back_to_panel', async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }
      await this.showAdminPanel(ctx);
    });
 // ========== ADMIN SUB-MENUS ==========

    // SMS Management menu
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
💰 Pending Withdrawals: ${withdrawalStats.pendingAmount}
🔧 *SMS Actions:*
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 View All SMS', 'admin_sms_list')],
            [Markup.button.callback('⏳ Pending Review', 'admin_pending_sms')],
            [Markup.button.callback('🔄 Process Received SMS', 'admin_process_sms')],
            [Markup.button.callback('🤖 Auto-Approve', 'admin_auto_approve')],
            [Markup.button.callback('🔄 Batch Approve', 'admin_batch_approve')],
            [Markup.button.callback('🔍 SMS Matching', 'admin_sms_matching')],
            [Markup.button.callback('📊 SMS Statistics', 'admin_sms_stats')],
            [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_back_to_panel')]
          ])
        });
      } catch (error) {
        console.error('Error in SMS menu:', error);
        await ctx.answerCbQuery('Error loading SMS menu');
      }
    });

    // Pending SMS list
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

    // Process SMS action
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
     // Batch approve action
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

    // SMS Matching menu
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

    // SMS Statistics
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

    // User Management menu
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

    // Transactions menu
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

    // Pending deposits list
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

    // System Tools menu
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
// admin system stats
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
    // Bot Status
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
• Admin ID: ${this.adminId}

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

    // Help menu for admin
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

*Button Navigation:*
👑 ADMIN PANEL - Main admin menu
📱 SMS Menu - Manage SMS deposits
👥 Users - User management
💳 Transactions - Transaction management
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
          [Markup.button.callback('👥 Try Users Menu', 'admin_users_menu')]
        ])
      });
    });

    // ========== HELPER METHOD FOR ADMIN PANEL ==========

 
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

    // View received SMS
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

    // Update approve SMS command to handle RECEIVED status
    this.bot.command(/^approvesms_(.+)/, async (ctx) => {
     if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        // First, get SMS deposit details to show confirmation
        const smsDeposit = await WalletService.getSMSDepositById(smsId);

        if (!smsDeposit) {
          await ctx.reply('❌ SMS deposit not found');
          return;
        }

        const userName = smsDeposit.userId?.firstName || smsDeposit.userId?.username || 'Unknown User';
        const amount = smsDeposit.extractedAmount;

        // Show confirmation
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

    // Add confirmation handler
    this.bot.action(/confirm_approve_(.+)/, async (ctx) => {
    if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
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

        // Notify user
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

    // Add cancel handler
    this.bot.action(/cancel_approve_(.+)/, async (ctx) => {
      await ctx.answerCbQuery('Approval cancelled');
      await ctx.deleteMessage();
    });

    // NEW: Batch approve command
    this.bot.command('batchapprove', async (ctx) => {
       if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        // Get all received SMS deposits
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

    // View SMS detail
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
        if (smsDeposit.status === 'PENDING') {
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

    // Approve SMS command
    this.bot.command(/^approvesms_(.+)/, async (ctx) => {
       if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
        const result = await WalletService.approveSMSDeposit(smsId, ctx.from.id);

        await ctx.replyWithMarkdown(
          `✅ *SMS Deposit Approved!*\n\n*User:* ${result.smsDeposit.userId.firstName}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}`
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
        await ctx.reply(`❌ Error approving SMS deposit: ${error.message}`);
      }
    });

        // Reject SMS command
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



// Admin commands for withdrawal management
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

    // Notify user
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

    // Notify user
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

// View withdrawal details
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


    // ========== ACTION HANDLERS ==========

  this.bot.action('show_deposit', async (ctx) => {
        const isAdmin = AdminUtils.isAdmin(ctx.from.id);
      
      const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, BOA
📱 *Mobile Money:* Telebirr

*How to Deposit:*
1. Select payment method below
2. Send money to the provided account
3. Forward/paste the confirmation SMS
4. We'll automatically process it

*Minimum Deposit:* $1 (≈ 50 ETB)
      `;

      const depositButtons = [
        [Markup.button.callback('🏦 CBE Bank', 'deposit_cbe')],
        [Markup.button.callback('🏦 Bank of Abysinia', 'deposit_boa')],
        [Markup.button.callback('📱 Telebirr', 'deposit_telebirr')],
        [Markup.button.callback('⬅️ Back', 'back_to_start')]
      ];

      // Add admin button if user is admin
      if (isAdmin) {
        depositButtons.unshift([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
      }

      await ctx.editMessageText(depositMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(depositButtons)
      });
    });


    this.bot.action(/deposit_(.+)/, async (ctx) => {
      const isAdmin = ctx.from.id.toString() === this.adminId;
      
      const methodMap = {
        'cbe': 'CBE Bank',
        'boa': 'Bank of Abysinia',
        'telebirr': 'Telebirr'
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
          'BOA': {
            account: '145633257',
            instructions: 'Send money to Bank of Abysinia account 145633257'
          },
          'Telebirr': {
            account: '0968546687',
            instructions: 'Send money to Telebirr 0968546687 via Telebirr app'
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

        // Add admin button if user is admin
        if (isAdmin) {
          methodButtons.unshift([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
        }

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(methodButtons)
        });
      }
    });

    this.bot.action('back_to_start', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        let balance = 0;
        try {
          balance = await WalletService.getBalanceByTelegramId(user.telegramId);
        } catch (error) {
          balance = user.walletBalance || 0;
        }

        const welcomeMessage = `
🎯 *Welcome to Bingo Bot, ${user.firstName || user.username}!*

*Your Wallet Balance:* $${balance}

*Quick Actions:*
        `;

        await ctx.editMessageText(welcomeMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
            [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
            [Markup.button.callback('💰 Withdraw Funds', 'withdraw')],
            [Markup.button.callback('📊 My Stats & History', 'show_stats')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')]
          ])
        });
      } catch (error) {
        console.error('Error in back_to_start:', error);
        await ctx.editMessageText(
          `🎯 *Welcome to Bingo Bot!*\n\nClick below to play:`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')]
            ])
          }
        );
      }
    });

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

    this.bot.action('show_stats', async (ctx) => {
      try {
        await UserService.findOrCreateUser(ctx.from);
        const userStats = await UserService.getUserStats(ctx.from.id);

        const statsMessage = `
📊 *Your Bingo Stats*

*Games Played:* ${userStats.gamesPlayed || 0}
*Games Won:* ${userStats.gamesWon || 0}
*Win Rate:* ${userStats.winRate || 0}%
*Total Winnings:* $${userStats.totalWinnings || 0}

*Recent Activity:*
${userStats.recentGames || 'No games played yet'}

Keep playing to improve your stats! 🎯
        `;

        await ctx.editMessageText(statsMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play More Games', 'https://desta.et')],
            [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error in show_stats:', error);
        await ctx.editMessageText(
          `📊 *Your Bingo Stats*\n\n*Games Played:* 0\n*Games Won:* 0\n*Win Rate:* 0%\n\nStart playing to see your stats! 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
              [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
            ])
          }
        );
      }
    });

    this.bot.action('show_help', async (ctx) => {
      const helpMessage = `
🤖 *Bingo Bot Commands*

*Main Commands:*
/start - Start the bot and see main menu
/help - Show this help message  
/deposit - Start deposit process
/wallet - Check your wallet balance
/stats - View your game statistics
      `;

      await ctx.editMessageText(helpMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://desta.et')],
          [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
          [Markup.button.callback('📊 My Stats', 'show_stats')]
        ])
      }
      );
    });

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

    // Admin action handlers
    this.bot.action(/admin_approve_sms_(.+)/, async (ctx) => {
       if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];

      try {
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
      }
    });

    this.bot.action(/admin_reject_sms_(.+)/, async (ctx) => {
      if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
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

    this.bot.action(/sms_page_(.+)/, async (ctx) => {
       if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const page = parseInt(ctx.match[1]);

      try {
        const result = await WalletService.getSMSDeposits(page, 10);

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

            if (sms.status === 'PENDING') {
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

    this.bot.action('admin_sms_list', async (ctx) => {
        if (!AdminUtils.isAdmin(ctx.from.id)) {
        await ctx.reply('❌ Access denied');
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

            if (sms.status === 'PENDING') {
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
        }
        );
      } catch (error) {
        console.error('Admin SMS list error:', error);
        await ctx.answerCbQuery('Error loading list');
      }
    });


    // Confirm withdrawal action
this.bot.action(/confirm_withdraw_(.+)_(.+)/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const method = ctx.match[2];
  const accountDetails = ctx.session?.withdrawalAccount;
  
  if (!accountDetails) {
    await ctx.answerCbQuery('❌ Account details not found. Please restart the withdrawal process.');
    return;
  }
  
  try {
    await ctx.answerCbQuery('🔄 Processing withdrawal request...');
    
    const result = await WalletService.createWithdrawalRequest(
      ctx.from.id,
      amount,
      method,
      accountDetails
    );
    
    // Clear session
    ctx.session.withdrawalMethod = null;
    ctx.session.withdrawalAmount = null;
    ctx.session.withdrawalAccount = null;
    
    await ctx.editMessageText(
      `✅ *Withdrawal Request Submitted!*

*Amount:* $${amount}
*Method:* ${method}
*Request ID:* ${result.withdrawal._id}

Your withdrawal request has been submitted and the amount has been locked. Our admin team will process it within 24-48 hours.

You will receive a notification when it's processed.`,
      { parse_mode: 'Markdown' }
    );
    
    // Notify admins
    await this.notifyAdminsAboutWithdrawal(result.withdrawal, result.user);
    
  } catch (error) {
    console.error('Error confirming withdrawal:', error);
    await ctx.answerCbQuery('❌ ' + error.message);
    await ctx.editMessageText(`❌ Error: ${error.message}`);
  }
});
// Admin withdrawal menu
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

// Pending withdrawals list
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

// Add a cancel action to clear withdrawal session
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
// Admin approve/reject withdrawal actions
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

    // Notify user
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
    
    // Store withdrawal ID in session for later
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


    // ========== TEXT HANDLER (MUST BE LAST) ==========

    this.bot.on('text', async (ctx) => {
      console.log('📝 Text received:', ctx.message.text.substring(0, 100));
 //  withdrawal amount handling 
 // 1. Handle withdrawal amount input
  if (ctx.session && ctx.session.withdrawalMethod && !ctx.session.withdrawalAmount && !isNaN(parseFloat(ctx.message.text))) {
    const amount = parseFloat(ctx.message.text);
    const method = ctx.session.withdrawalMethod;
    
    console.log(`💰 Processing withdrawal amount: ${amount} for method: ${method}`);
    
    try {
      const balanceInfo = await WalletService.getAvailableBalance(ctx.from.id);
      
      // Validate amount
      if (amount < 10) {
        await ctx.reply('❌ Minimum withdrawal amount is $10');
        return;
      }
      
      if (amount > balanceInfo.availableBalance) {
        await ctx.reply(`❌ Insufficient available balance. Available: $${balanceInfo.availableBalance}`);
        return;
      }
      
      // Store amount in session
      ctx.session.withdrawalAmount = amount;
      console.log(`✅ Amount stored: $${amount}`);
      
      // Ask for account details based on method
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
      // Store account details in session
      ctx.session.withdrawalAccount = accountDetails;
      console.log(`✅ Account details stored for ${method}`);
      
      // Validate account details
      const validationError = this.validateAccountDetails(method, accountDetails);
      if (validationError) {
        await ctx.reply(`❌ ${validationError}\n\nPlease send correct account details:`);
        // Remove invalid account details
        ctx.session.withdrawalAccount = null;
        return;
      }
      
      // Show confirmation
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
            Markup.button.callback('✅ Yes, Confirm', `confirm_withdraw_${amount}_${method}`),
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


      // Handle SMS deposits with payment method selected
      if (ctx.session && ctx.session.pendingDepositMethod) {
        const smsText = ctx.message.text;
        const paymentMethod = ctx.session.pendingDepositMethod;

        console.log('📱 Processing SMS deposit for method:', paymentMethod);

        // Show processing message
        const processingMsg = await ctx.reply('🔄 Processing your SMS...');

        try {
          await UserService.findOrCreateUser(ctx.from);
          
          // Use new matching system with error handling
          let result;
          try {
            result = await WalletService.matchAndAutoApproveSMS(
              smsText,
              ctx.from.id.toString(),
              paymentMethod
            );
          } catch (matchError) {
            console.error('Match error:', matchError);
            // Even if matching fails, store the SMS
            result = await WalletService.storeSMSMessage(
              ctx.from.id.toString(),
              smsText,
              paymentMethod
            );
          }

          delete ctx.session.pendingDepositMethod;
          
          // Delete processing message
          try {
            await ctx.deleteMessage(processingMsg.message_id);
          } catch (e) {
            console.warn('Could not delete processing message:', e.message);
          }

          // Analyze the SMS type for better messaging
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
          
          // Delete processing message
          try {
            await ctx.deleteMessage(processingMsg.message_id);
          } catch (e) {}
          
          const errorMessage = error.message.includes('User not found') 
            ? 'Please use /start first to set up your account.'
            : 'Processing error. Please try again or contact support.';
            
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

      // Handle automatic SMS detection and storage
      const text = ctx.message.text;
      if (this.looksLikeBankSMS(text)) {
        console.log('🏦 Detected bank SMS, using matching system...');
        console.log('📊 SMS content:', text.substring(0, 200));

        try {
          await UserService.findOrCreateUser(ctx.from);

          // Analyze SMS first
          const smsAnalysis = WalletService.analyzeSMSType(text);
          const identifiers = WalletService.extractTransactionIdentifiers(text);

          console.log('🔍 SMS Analysis:', smsAnalysis);
          console.log('🔑 SMS Identifiers:', identifiers);

          // Use matching system
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
        text.startsWith('/received')) {
        return;
      }

      // Handle unknown commands
      if (ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          `❓ *Unknown Command*\n\nAvailable commands:\n/start, /help, /deposit, /wallet, /stats`,
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

  // Helper method for account validation
validateAccountDetails(method, details) {
  const lines = details.split('\n').map(line => line.trim()).filter(line => line);
  
  switch(method) {
    case 'CBE Bank':
    case 'Bank of Abysinia':
    case 'Dashen Bank':
      // For banks: expect at least account holder name and account number
      if (lines.length < 2) {
        return 'Please provide at least:\n1. Account Holder Name\n2. Account Number';
      }
      
      // Check if second line looks like an account number (numbers only)
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
      // For mobile money: expect phone number
      if (lines.length < 1) {
        return 'Please provide phone number';
      }
      
      const phone = lines[0].replace(/\s/g, '');
      if (!/^09\d{8}$/.test(phone)) {
        return 'Please provide a valid Ethiopian phone number (e.g., 0912345678)';
      }
      break;
  }
  
  return null; // No error
}

// Helper method to format account details for display
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

// Update the getAccountPromptForMethod method:
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
  // Admin notification for withdrawal
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
    
    // Notify all admins
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
// Helper method for account prompts
getAccountPromptForMethod(method) {
  const prompts = {
    'CBE Bank': `
🏦 *CBE Bank Account Details*

Please provide your CBE Bank account details:
• Account Holder Name:
• Account Number:
• Bank Branch (optional):

Example:
John Doe
1000123456789
Bole Branch

Please send the details in this format:
    `,
    'Bank of Abysinia': `
🏦 *BOA Account Details*

Please provide your Bank of Abysinia account details:
• Account Holder Name:
• Account Number:
• Bank Branch (optional):

Example:
John Doe
123456789
Bole Branch

Please send the details in this format:
    `,
    'Telebirr': `
📱 *Telebirr Details*

Please provide your Telebirr details:
• Phone Number:
• Account Holder Name:

Example:
0912345678
John Doe

Please send the details in this format:
    `,
    'CBE Birr': `
📱 *CBE Birr Details*

Please provide your CBE Birr details:
• Phone Number:
• Account Holder Name:

Example:
0912345678
John Doe

Please send the details in this format:
    `
  };
  
  return prompts[method] || `
💳 *Account Details*

Please provide your account details for ${method}:

Format:
[Account Information]

Please send the details:
  `;
}
  looksLikeBankSMS(text) {
    const sms = text.toLowerCase();

    // Bank SMS patterns for Ethiopian banks
    const bankPatterns = [
      // Transaction patterns
      /sent.*etb|birr|br/i,
      /received.*etb|birr|br/i,
      /transfer.*etb|birr|br/i,
      /transaction.*etb|birr|br/i,
      /deposit.*etb|birr|br/i,

      // Bank names
      /cbe.*bank/i,
      /awash.*bank/i,
      /dashen.*bank/i,
      /cbe.*birr/i,
      /telebirr/i,

      // Common SMS formats
      /dear.*customer/i,
      /txn.*id/i,
      /transaction.*id/i,
      /balance.*etb|birr|br/i,
      /amount.*etb|birr|br/i
    ];

    // Check if text matches any bank pattern
    const isBankSMS = bankPatterns.some(pattern => pattern.test(sms));

    // Additional checks for common SMS characteristics
    const hasAmount = /\d+\.?\d*\s*(ETB|Birr|Br)/i.test(text);
    const hasTransactionWords = text.includes('Txn') || text.includes('Transaction') || text.includes('sent') || text.includes('received');
    const reasonableLength = text.length > 20 && text.length < 500;

    console.log(`🔍 SMS Detection: BankPattern=${isBankSMS}, HasAmount=${hasAmount}, HasTransaction=${hasTransactionWords}, LengthOK=${reasonableLength}`);

    return isBankSMS || (hasAmount && hasTransactionWords && reasonableLength);
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

    // FIXED KEYBOARD ARRAY - No nested arrays within arrays
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        // First row: Main categories - each button is in its own array
        [
          Markup.button.callback('📱 SMS', 'admin_sms_menu'),
          Markup.button.callback('👥 Users', 'admin_users_menu')
        ],
        [
          Markup.button.callback('💳 Transactions', 'admin_transactions_menu'),
          Markup.button.callback('💰 Withdrawals', 'admin_withdrawals_menu')
        ],
        [
          Markup.button.callback('🔧 Tools', 'admin_tools_menu'),
          Markup.button.callback('📊 Stats', 'admin_system_stats')
        ],
        // Second row: Quick actions
        [
          Markup.button.callback('⏳ Pending Deposits', 'admin_pending_deposits'),
          Markup.button.callback('🤖 Auto-Approve', 'admin_auto_approve')
        ],
        // Third row: Info and back
        [
          Markup.button.callback('📖 Help', 'admin_help_menu'),
          Markup.button.callback('🤖 Status', 'admin_bot_status')
        ],
        // Fourth row: Single button for back
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

     async getSystemStats() {
      try {
        // You'll need to implement these methods in your services
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
        return { users: 0, transactions: 0, deposits: 0,  pendingWithdrawals: 0,
      totalWithdrawals: 0};
      }
    }


  async notifyAdminAboutDeposit(smsDeposit, user) {
    try {
      const message = `📥 *New SMS Deposit Needs Review*\n\n` +
        `*User:* ${user.first_name} (${user.username || 'No username'})\n` +
        `*Telegram ID:* ${user.id}\n` +
        `*Amount:* $${smsDeposit.extractedAmount}\n` +
        `*Method:* ${smsDeposit.paymentMethod}\n` +
        `*SMS Preview:* ${smsDeposit.originalSMS.substring(0, 100)}...\n\n` +
        `View: /viewsms_${smsDeposit._id}\n` +
        `Approve: /approvesms_${smsDeposit._id}\n` +
        `Reject: /rejectsms_${smsDeposit._id}`;

      await this.bot.telegram.sendMessage(this.adminId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error notifying admin:', error);
    }
  }

  launch() {
    // Prevent multiple launches
    if (this.isRunning) {
      console.log('🤖 Bot is already running, skipping launch');
      return;
    }

    console.log('🤖 Launching Telegram bot...');
    
    // Initialize payment methods
    WalletService.initializePaymentMethods().catch(console.error);

    // Launch the bot
    this.bot.launch().then(() => {
      this.isRunning = true;
      console.log('🤖 Bingo Bot is running and ready!');
      console.log('👑 Admin ID:', this.adminId);
    }).catch(error => {
      console.error('❌ Failed to launch bot:', error);
      this.isRunning = false;
    });

    // Setup graceful shutdown
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
}

// Static instance variable for singleton pattern
BotController.instance = null;

module.exports = BotController;