// botController.js - COMPLETE WORKING VERSION WITH ADMIN
const { Telegraf, Markup } = require('telegraf');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');
const SMSDeposit = require('../models/SMSDeposit');

class BotController {
  constructor(botToken, adminId) {
    this.bot = new Telegraf(botToken);
    this.adminId = adminId.toString(); // Ensure string comparison
    this.setupHandlers();
  }

  setupHandlers() {
    // Start command - ensures user is created
    this.bot.start(async (ctx) => {
      try {
        console.log('🚀 Start command received from:', ctx.from.id, ctx.from.first_name);
        
        // Create or find user
        const user = await UserService.findOrCreateUser(ctx.from);
        console.log('✅ User processed:', user.telegramId, user._id);
        
        // Initialize wallet if needed
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
        
        const welcomeMessage = `
🎯 *Welcome to Bingo Bot, ${user.firstName || user.username}!*

*Your Wallet Balance:* $${balance}

*Features:*
• 🎮 Play real-time Bingo with friends
• 💰 Easy deposits via Ethiopian banks & mobile money
• 👥 Create private or public games  
• 🏆 Track your stats and wins

*Quick Actions:*
        `;

        await ctx.replyWithMarkdown(welcomeMessage, 
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
            [Markup.button.callback('📊 My Stats & History', 'show_stats')],
            [Markup.button.callback('💼 My Wallet', 'show_wallet')]
          ])
        );
        
        console.log('✅ Start command completed successfully');
        
      } catch (error) {
        console.error('❌ Error in start command:', error);
        
        // Fallback message if everything fails
        await ctx.replyWithMarkdown(
          `🎯 *Welcome to Bingo Bot!*\n\nWe're setting up your account...\n\nClick below to play:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Help command
    this.bot.help(async (ctx) => {
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
🏦 Banks: CBE, Awash, Dashen
📱 Mobile Money: CBE Birr, Telebirr
      `;

      await ctx.replyWithMarkdown(helpMessage,
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
          [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
          [Markup.button.callback('📊 My Stats', 'show_stats')]
        ])
      );
    });

    // Deposit command
    this.bot.command('deposit', async (ctx) => {
      try {
        // Ensure user exists
        await UserService.findOrCreateUser(ctx.from);
        
        const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, Awash, Dashen
📱 *Mobile Money:* CBE Birr, Telebirr

*How to Deposit:*
1. Select payment method below
2. Send money to the provided account
3. Forward/paste the confirmation SMS
4. Admin will verify and approve

*Minimum Deposit:* $1 (≈ 50 ETB)
        `;
        
        await ctx.replyWithMarkdown(depositMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🏦 CBE Bank', 'deposit_cbe')],
            [Markup.button.callback('🏦 Awash Bank', 'deposit_awash')],
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
    this.bot.command('wallet', async (ctx) => {
      try {
        // Ensure user exists
        const user = await UserService.findOrCreateUser(ctx.from);
        
        let balance = 0;
        let transactions = [];
        
        try {
          balance = await WalletService.getBalanceByTelegramId(user.telegramId);
          transactions = await WalletService.getUserTransactions(user.telegramId);
        } catch (error) {
          console.log('⚠️ Wallet not initialized, creating now...');
          await WalletService.initializeWallet(user.telegramId);
          balance = 0;
        }
        
        let message = `💼 *Your Wallet*\n\n*Current Balance:* $${balance}\n\n`;
        message += `📊 *Recent Transactions:*\n`;
        
        if (transactions.length > 0) {
          transactions.slice(0, 5).forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' : 
                         tx.type === 'WINNING' ? '🏆' : '🎮';
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
        // Ensure user exists
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
            [Markup.button.webApp('🎮 Play More Games', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('⬅️ Back to Main', 'back_to_start')]
          ])
        );
      } catch (error) {
        console.error('Error in stats command:', error);
        await ctx.replyWithMarkdown(
          `📊 *Your Bingo Stats*\n\n*Games Played:* 0\n*Games Won:* 0\n*Win Rate:* 0%\n\nStart playing to see your stats! 🎯`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // ========== ADMIN COMMANDS ==========
    
    // Main admin command - MUST BE DEFINED BEFORE TEXT HANDLER
    this.bot.command('admin', async (ctx) => {
      console.log('🔐 Admin command received from:', ctx.from.id, 'Expected admin:', this.adminId);
      
      if (ctx.from.id.toString() !== this.adminId) {
        console.log('❌ Access denied for user:', ctx.from.id);
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        console.log('✅ Admin access granted, loading admin panel...');
        
        const [pendingDeposits, pendingSMS, recentSMS] = await Promise.all([
          WalletService.getPendingDeposits().catch(err => { console.error('Error getting pending deposits:', err); return []; }),
          WalletService.getPendingSMSDeposits(5).catch(err => { console.error('Error getting pending SMS:', err); return []; }),
          WalletService.getSMSDeposits(1, 5).catch(err => { console.error('Error getting SMS deposits:', err); return { deposits: [] }; })
        ]);

        let message = `👑 *Admin Panel*\n\n`;
        message += `📊 *Statistics:*\n`;
        message += `⏳ Pending Deposits: ${pendingDeposits?.length || 0}\n`;
        message += `📱 Pending SMS: ${pendingSMS?.length || 0}\n\n`;

        if (pendingSMS && pendingSMS.length > 0) {
          message += `*Recent Pending SMS Deposits:*\n`;
          pendingSMS.forEach((sms, index) => {
            const userName = sms.userId?.firstName || sms.userId?.username || 'Unknown User';
            message += `\n${index + 1}. $${sms.extractedAmount} - ${userName}\n`;
            message += `   Method: ${sms.paymentMethod}\n`;
            message += `   Time: ${new Date(sms.createdAt).toLocaleDateString()}\n`;
            message += `   [View: /viewsms_${sms._id}] [Approve: /approvesms_${sms._id}] [Reject: /rejectsms_${sms._id}]\n`;
          });
        } else {
          message += `*No pending SMS deposits.*\n\n`;
        }

        message += `\n*Admin Commands:*\n`;
        message += `/smslist - View all SMS deposits\n`;
        message += `/pending - Pending deposits\n`;
        message += `/autoapprove - Auto-approve small deposits\n`;
        message += `/stats - System statistics`;

        await ctx.replyWithMarkdown(message);
        console.log('✅ Admin panel loaded successfully');
        
      } catch (error) {
        console.error('❌ Admin command error:', error);
        await ctx.reply('❌ Error loading admin panel: ' + error.message);
      }
    });

    // SMS List command
    this.bot.command('smslist', async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const page = parseInt(ctx.message.text.split(' ')[1]) || 1;
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

        // Pagination buttons
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

    // View SMS detail
    this.bot.command(/^viewsms_(.+)/, async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
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
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.reply('❌ Access denied');
        return;
      }

      try {
        const result = await WalletService.processAutoApproveDeposits(100); // Auto-approve up to $100
        
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
      if (ctx.from.id.toString() !== this.adminId) {
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
      if (ctx.from.id.toString() !== this.adminId) {
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
              [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')]
            ])
          }
        );

      } catch (error) {
        await ctx.reply(`❌ Error approving deposit: ${error.message}`);
      }
    });

    // Approve SMS command
    this.bot.command(/^approvesms_(.+)/, async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
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
              [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')]
            ])
          }
        );

      } catch (error) {
        await ctx.reply(`❌ Error approving SMS deposit: ${error.message}`);
      }
    });

    // Reject SMS command
    this.bot.command(/^rejectsms_(.+)/, async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
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

    // ========== ACTION HANDLERS ==========

    this.bot.action('show_deposit', async (ctx) => {
      const depositMessage = `
💳 *Deposit Money to Your Wallet*

*Supported Methods:*
🏦 *Banks:* CBE, Awash, Dashen
📱 *Mobile Money:* CBE Birr, Telebirr

*How to Deposit:*
1. Select payment method below
2. Send money to the provided account
3. Forward/paste the confirmation SMS
4. Admin will verify and approve

*Minimum Deposit:* $1 (≈ 50 ETB)
      `;
      
      await ctx.editMessageText(depositMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏦 CBE Bank', 'deposit_cbe')],
          [Markup.button.callback('🏦 Awash Bank', 'deposit_awash')],
          [Markup.button.callback('🏦 Dashen Bank', 'deposit_dashen')],
          [Markup.button.callback('📱 CBE Birr', 'deposit_cbebirr')],
          [Markup.button.callback('📱 Telebirr', 'deposit_telebirr')],
          [Markup.button.callback('⬅️ Back', 'back_to_start')]
        ])
      });
    });

    this.bot.action(/deposit_(.+)/, async (ctx) => {
      const methodMap = {
        'cbe': 'CBE Bank',
        'awash': 'Awash Bank', 
        'dashen': 'Dashen Bank',
        'cbebirr': 'CBE Birr',
        'telebirr': 'Telebirr'
      };

      const methodKey = ctx.match[1];
      const methodName = methodMap[methodKey];

      if (methodName) {
        ctx.session = ctx.session || {};
        ctx.session.pendingDepositMethod = methodName;
        
        const methods = {
          'CBE Bank': {
            account: '1000200030004000',
            instructions: 'Send money to CBE account 1000200030004000 via CBE Birr app or bank transfer'
          },
          'Awash Bank': {
            account: '2000300040005000', 
            instructions: 'Send money to Awash Bank account 2000300040005000'
          },
          'Dashen Bank': {
            account: '3000400050006000',
            instructions: 'Send money to Dashen Bank account 3000400050006000'
          },
          'CBE Birr': {
            account: '0911000000',
            instructions: 'Send money to CBE Birr 0911000000 via CBE Birr app'
          },
          'Telebirr': {
            account: '0912000000',
            instructions: 'Send money to Telebirr 0912000000 via Telebirr app'
          }
        };

        const method = methods[methodName];
        const message = `
💳 *Deposit via ${methodName}*

*Account Details:*
📞 Account: ${method.account}
🏦 Name: Bingo Game

*Instructions:*
${method.instructions}

*After sending money:*
1. You will receive an SMS confirmation
2. Forward that SMS here or copy-paste the text
3. We will verify and add funds to your wallet

⚠️ *Only send from your registered accounts*
        `;

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📤 I have sent money', 'waiting_sms')],
            [Markup.button.callback('⬅️ Back to Methods', 'show_deposit')]
          ])
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
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
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
              [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
            ])
          }
        );
      }
    });

    this.bot.action('show_wallet', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        let balance = 0;
        let transactions = [];
        
        try {
          balance = await WalletService.getBalanceByTelegramId(user.telegramId);
          transactions = await WalletService.getUserTransactions(user.telegramId);
        } catch (error) {
          await WalletService.initializeWallet(user.telegramId);
          balance = 0;
        }
        
        let message = `💼 *Your Wallet*\n\n*Current Balance:* $${balance}\n\n`;
        message += `📊 *Recent Transactions:*\n`;
        
        if (transactions.length > 0) {
          transactions.slice(0, 5).forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' : 
                         tx.type === 'WINNING' ? '🏆' : '🎮';
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
            [Markup.button.webApp('🎮 Play More Games', 'https://bingominiapp.vercel.app')],
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
              [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
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
          [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
          [Markup.button.callback('💰 Deposit Money', 'show_deposit')],
          [Markup.button.callback('💼 My Wallet', 'show_wallet')],
          [Markup.button.callback('📊 My Stats', 'show_stats')]
        ])
      });
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
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      const smsId = ctx.match[1];
      
      try {
        const result = await WalletService.approveSMSDeposit(smsId, ctx.from.id);
        
        await ctx.editMessageText(
          `✅ *SMS Deposit Approved!*\n\n*User:* ${result.smsDeposit.userId.firstName}\n*Amount:* $${result.transaction.amount}\n*New Balance:* $${result.wallet.balance}`,
          { parse_mode: 'Markdown' }
        );

        // Notify user
        await this.bot.telegram.sendMessage(
          result.smsDeposit.userId.telegramId,
          `🎉 *Deposit Approved!*\n\nYour deposit of $${result.transaction.amount} has been approved!\n*New Balance:* $${result.wallet.balance}\n\nReady to play some Bingo? 🎯`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')]
            ])
          }
        );

      } catch (error) {
        await ctx.answerCbQuery(`❌ Error: ${error.message}`);
      }
    });

    this.bot.action(/admin_reject_sms_(.+)/, async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId) {
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

        // Notify user
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
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.answerCbQuery('❌ Access denied');
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
      if (ctx.from.id.toString() !== this.adminId) {
        await ctx.answerCbQuery('❌ Access denied');
        return;
      }

      try {
        const result = await WalletService.getSMSDeposits(1, 10);

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
        });
      } catch (error) {
        console.error('Admin SMS list error:', error);
        await ctx.answerCbQuery('Error loading list');
      }
    });

    // ========== TEXT HANDLER (MUST BE LAST) ==========

    this.bot.on('text', async (ctx) => {
      console.log('📝 Text received:', ctx.message.text.substring(0, 100));
      
      // Handle SMS deposits
      if (ctx.session && ctx.session.pendingDepositMethod) {
        const smsText = ctx.message.text;
        const paymentMethod = ctx.session.pendingDepositMethod;

        console.log('📱 Processing SMS deposit for method:', paymentMethod);

        try {
          await UserService.findOrCreateUser(ctx.from);
          
          // Process SMS with auto-approval for small amounts (<= $50)
          const result = await WalletService.processSMSDeposit(
            ctx.from.id, 
            paymentMethod, 
            smsText,
            true // Enable auto-approval for small amounts
          );

          delete ctx.session.pendingDepositMethod;

          if (result.autoApproved) {
            await ctx.replyWithMarkdown(
              `✅ *Deposit Auto-Approved!*\n\n*Amount:* $${result.transaction.amount}\n*Method:* ${paymentMethod}\n*New Balance:* $${result.wallet.balance}\n\nYour deposit was automatically approved and added to your wallet! 🎉`,
              Markup.inlineKeyboard([
                [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
                [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
              ])
            );
          } else {
            await ctx.replyWithMarkdown(
              `✅ *Deposit Request Submitted!*\n\n*Amount:* $${result.smsDeposit.extractedAmount}\n*Method:* ${paymentMethod}\n*Status:* ⏳ Pending Approval\n\nYour deposit is under review. You will be notified once approved.`,
              Markup.inlineKeyboard([
                [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
                [Markup.button.callback('🎮 Play Bingo', 'back_to_start')]
              ])
            );

            await this.notifyAdminAboutDeposit(result.smsDeposit, ctx.from);
          }

        } catch (error) {
          console.error('❌ SMS deposit error:', error);
          await ctx.replyWithMarkdown(
            `❌ *Deposit Failed*\n\nError: ${error.message}\n\nPlease check:\n• SMS is from ${paymentMethod}\n• Amount is clearly mentioned\n• Transaction details are included\n\n*Example SMS format:*\n"You have sent 100.00 ETB to Bingo Game. Transaction ID: XYZ123"`,
            Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Try Again', 'show_deposit')],
              [Markup.button.callback('📞 Contact Support', 'contact_support')]
            ])
          );
        }
        return;
      }

      // Handle admin commands that might have been missed
      const text = ctx.message.text;
      if (text.startsWith('/admin') || 
          text.startsWith('/smslist') || 
          text.startsWith('/viewsms_') || 
          text.startsWith('/approvesms_') || 
          text.startsWith('/rejectsms_') || 
          text.startsWith('/autoapprove') || 
          text.startsWith('/pending') || 
          text.startsWith('/approve_')) {
        // Let the command handlers handle these
        return;
      }

      // Handle unknown commands
      if (ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          `❓ *Unknown Command*\n\nAvailable commands:\n/start, /help, /deposit, /wallet, /stats`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('📋 Show All Commands', 'show_help')]
          ])
        );
      } else {
        await ctx.replyWithMarkdown(
          'Want to play some Bingo? 🎯 Use /help to see all commands!',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 YES, PLAY BINGO!', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('📋 Commands Help', 'show_help')]
          ])
        );
      }
    });
  }

  async notifyAdminAboutDeposit(smsDeposit, user) {
    try {
      const message = `📥 *New SMS Deposit Request*\n\n` +
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
    // Initialize payment methods on startup
    WalletService.initializePaymentMethods().catch(console.error);
    
    this.bot.launch();
    console.log('🤖 Bingo Bot is running and ready!');
    console.log('👑 Admin ID:', this.adminId);
    
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;