// botController.js - UPDATED WITH WALLET FEATURES
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

    // Show deposit options
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

    // Deposit method selection
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

    // Waiting for SMS input
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

    // Handle SMS text input
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

      // Existing text handler for other messages
      if (!ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          'Want to play some Bingo? 🎯',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 YES, PLAY BINGO!', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

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

    // Approve deposit command
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

    // Existing handlers (keep your existing show_stats, show_help, back_to_start, etc.)
    // ... [Your existing handlers remain the same]

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
    console.log('🤖 Bingo Bot with Wallet System is running!');
    
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;