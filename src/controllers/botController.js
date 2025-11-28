// botController.js - UPDATED WITH COMMANDS MENU
const { Telegraf, Markup } = require('telegraf');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');

class BotController {
  constructor(botToken, adminId) {
    this.bot = new Telegraf(botToken);
    this.adminId = adminId; // Telegram ID of admin
    this.setupHandlers();
  }

  setupHandlers() {
    // Start command with wallet options
    this.bot.start(async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const balance = await WalletService.getBalanceByTelegramId(user.telegramId);
        
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
      } catch (error) {
        console.error('Error in start command:', error);
        await ctx.replyWithMarkdown(
          `🎯 *Welcome to Bingo Bot!*\n\nClick below to play:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Help command - shows all available commands
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

*Need Help?*
Just type any command or use the buttons below!
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

    // Deposit command - direct access to deposit
    this.bot.command('deposit', async (ctx) => {
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
    });

    // Wallet command - direct access to wallet
    this.bot.command('wallet', async (ctx) => {
      try {
        const balance = await WalletService.getBalanceByTelegramId(ctx.from.id);
        const transactions = await WalletService.getUserTransactions(ctx.from.id);
        
        let message = `💼 *Your Wallet*\n\n*Current Balance:* $${balance}\n\n`;
        message += `📊 *Recent Transactions:*\n`;
        
        if (transactions.length > 0) {
          transactions.slice(0, 5).forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' : 
                         tx.type === 'WINNING' ? '🏆' : '🎮';
            const sign = tx.amount > 0 ? '+' : '';
            const status = tx.status === 'PENDING' ? '⏳' : 
                          tx.status === 'COMPLETED' ? '✅' : '❌';
            message += `${emoji} ${sign}$${tx.amount} - ${tx.description} ${status}\n`;
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
        await ctx.reply('❌ Error loading wallet information. Please try again.');
      }
    });

    // Stats command
    this.bot.command('stats', async (ctx) => {
      try {
        // This would call your UserService to get user stats
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

    // Show deposit options (existing callback)
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

    // Deposit method selection (existing callback)
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

    // Back to start action
    this.bot.action('back_to_start', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const balance = await WalletService.getBalanceByTelegramId(user.telegramId);
        
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

    // Handle unknown commands
    this.bot.on('text', async (ctx) => {
      // Check if user is in deposit flow
      if (ctx.session && ctx.session.pendingDepositMethod) {
        const smsText = ctx.message.text;
        const paymentMethod = ctx.session.pendingDepositMethod;

        try {
          // Create deposit request
          const transaction = await WalletService.createDepositFromSMS(
            ctx.from.id,
            paymentMethod,
            smsText
          );

          // Clear session
          delete ctx.session.pendingDepositMethod;

          // Notify user
          await ctx.replyWithMarkdown(
            `✅ *Deposit Request Submitted!*\n\n*Amount:* $${transaction.amount}\n*Method:* ${paymentMethod}\n*Status:* ⏳ Pending Approval\n\nYour deposit is under review. You will be notified once approved.`,
            Markup.inlineKeyboard([
              [Markup.button.callback('💼 Check Wallet', 'show_wallet')],
              [Markup.button.callback('🎮 Play Bingo', 'back_to_start')]
            ])
          );

          // Notify admin
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

      // Handle unknown commands
      if (ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          `❓ *Unknown Command*\n\nI don't recognize that command. Here are the available commands:\n\n` +
          `*/start* - Main menu\n` +
          `*/help* - Show all commands\n` +
          `*/deposit* - Add money to wallet\n` +
          `*/wallet* - Check your balance\n` +
          `*/stats* - View your statistics\n\n` +
          `Or use the buttons below:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('📋 Show All Commands', 'show_help')]
          ])
        );
      } else {
        // Regular text messages
        await ctx.replyWithMarkdown(
          'Want to play some Bingo? 🎯 Use /help to see all available commands!',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 YES, PLAY BINGO!', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('📋 Commands Help', 'show_help')]
          ])
        );
      }
    });

    // Show help via callback
    this.bot.action('show_help', async (ctx) => {
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

*Need Help?*
Just type any command or use the buttons below!
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

    // ... [Keep your existing show_wallet, admin commands, etc. unchanged]
    // Show wallet balance and history
    this.bot.action('show_wallet', async (ctx) => {
      try {
        const balance = await WalletService.getBalanceByTelegramId(ctx.from.id);
        const transactions = await WalletService.getUserTransactions(ctx.from.id);
        
        let message = `💼 *Your Wallet*\n\n*Current Balance:* $${balance}\n\n`;
        message += `📊 *Recent Transactions:*\n`;
        
        if (transactions.length > 0) {
          transactions.forEach(tx => {
            const emoji = tx.type === 'DEPOSIT' ? '📥' : 
                         tx.type === 'WINNING' ? '🏆' : '🎮';
            const sign = tx.amount > 0 ? '+' : '';
            const status = tx.status === 'PENDING' ? '⏳' : 
                          tx.status === 'COMPLETED' ? '✅' : '❌';
            message += `${emoji} ${sign}$${tx.amount} - ${tx.description} ${status}\n`;
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

    // Admin commands (keep existing)
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

    // Approve deposit command (keep existing)
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

        // Notify user
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

    // Add show_stats callback if not exists
    this.bot.action('show_stats', async (ctx) => {
      try {
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

  }

  // Notify admin about new deposit
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
    console.log('🤖 Bingo Bot with Commands Menu is running!');
    
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;