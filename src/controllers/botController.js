// botController.js - COMPLETE WORKING VERSION
const { Telegraf, Markup } = require('telegraf');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');

class BotController {
  constructor(botToken, adminId) {
    this.bot = new Telegraf(botToken);
    this.adminId = adminId;
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

    // ... [Keep all other action handlers the same as previous version]
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

    this.bot.on('text', async (ctx) => {
      if (ctx.session && ctx.session.pendingDepositMethod) {
        const smsText = ctx.message.text;
        const paymentMethod = ctx.session.pendingDepositMethod;

        try {
          await UserService.findOrCreateUser(ctx.from);
          const transaction = await WalletService.createDepositFromSMS(
            ctx.from.id,
            paymentMethod,
            smsText
          );

          delete ctx.session.pendingDepositMethod;

          await ctx.replyWithMarkdown(
            `✅ *Deposit Request Submitted!*\n\n*Amount:* $${transaction.amount}\n*Method:* ${paymentMethod}\n*Status:* ⏳ Pending Approval\n\nYour deposit is under review. You will be notified once approved.`,
            Markup.inlineKeyboard([
              [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
              [Markup.button.callback('🎮 Play Bingo', 'back_to_start')]
            ])
          );

          await this.notifyAdminAboutDeposit(transaction, ctx.from);

        } catch (error) {
          await ctx.replyWithMarkdown(
            `❌ *Deposit Failed*\n\nError: ${error.message}\n\nPlease try again or contact support.`,
            Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Try Again', 'show_deposit')]
            ])
          );
        }
        return;
      }

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

    // Admin commands
    this.bot.command('admin', async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId.toString()) {
        await ctx.reply('❌ Access denied');
        return;
      }

      const pendingDeposits = await WalletService.getPendingDeposits();
      
      let message = `👑 *Admin Panel*\n\n`;
      message += `⏳ *Pending Deposits:* ${pendingDeposits.length}\n\n`;

      if (pendingDeposits.length > 0) {
        message += `*Recent Pending Deposits:*\n`;
        pendingDeposits.slice(0, 5).forEach(deposit => {
          message += `\n📥 $${deposit.amount} - ${deposit.userId.firstName || deposit.userId.username}\n`;
          message += `   Method: ${deposit.metadata.paymentMethod}\n`;
          message += `   SMS: ${deposit.metadata.smsText.substring(0, 50)}...\n`;
          message += `   [Approve: /approve_${deposit._id}]`;
        });
      }

      await ctx.replyWithMarkdown(message);
    });

    this.bot.command(/approve_(.+)/, async (ctx) => {
      if (ctx.from.id.toString() !== this.adminId.toString()) {
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
  }

  async notifyAdminAboutDeposit(transaction, user) {
    try {
      const message = `📥 *New Deposit Request*\n\n` +
        `*User:* ${user.first_name} (${user.username || 'No username'})\n` +
        `*Amount:* $${transaction.amount}\n` +
        `*Method:* ${transaction.metadata.paymentMethod}\n` +
        `*SMS:* ${transaction.metadata.smsText}\n\n` +
        `Approve with: /approve_${transaction._id}`;

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
    
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;