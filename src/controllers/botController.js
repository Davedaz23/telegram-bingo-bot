// botController.js
const { Telegraf, Markup } = require('telegraf');
const UserService = require('../services/userService');

class BotController {
  constructor(botToken) {
    this.bot = new Telegraf(botToken);
    this.setupHandlers();
  }

  setupHandlers() {
    // Start command with inline keyboard
    this.bot.start(async (ctx) => {
      const user = await UserService.findOrCreateUser(ctx.from);
      
      const welcomeMessage = `
🎯 *Welcome to Bingo Bot, ${user.firstName || user.username}!*

*Features:*
• 🎮 Play real-time Bingo with friends
• 👥 Create private or public games  
• 🏆 Track your stats and wins
• ⚡ Fast and smooth gameplay

*How to play:*
1. Click "Play Bingo" below
2. Create a game or join existing one
3. Mark numbers as they're called
4. Shout BINGO when you win!
      `;

      await ctx.replyWithMarkdown(welcomeMessage, 
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Play Bingo Now', `${process.env.WEB_APP_URL}`)],
          [Markup.button.callback('📊 My Stats', 'show_stats')],
          [Markup.button.callback('❓ How to Play', 'show_help')]
        ])
      );
    });

    // Handle inline button callbacks
    this.bot.action('show_stats', async (ctx) => {
      const stats = await UserService.getUserStats(ctx.from.id);
      
      let statsMessage = `📊 *Your Bingo Stats:*\n\n`;
      if (stats) {
        statsMessage += `Games Played: ${stats.gamesPlayed}\n`;
        statsMessage += `Games Won: ${stats.gamesWon}\n`;
        statsMessage += `Win Rate: ${stats.gamesPlayed > 0 ? ((stats.gamesWon / stats.gamesPlayed) * 100).toFixed(1) : 0}%\n`;
        statsMessage += `Total Score: ${stats.totalScore}\n\n`;
        statsMessage += `Keep playing to improve your stats! 🏆`;
      } else {
        statsMessage += `No games played yet. Start your first game!`;
      }
      
      await ctx.editMessageText(statsMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Play Now', `${process.env.WEB_APP_URL}`)],
          [Markup.button.callback('⬅️ Back', 'back_to_start')]
        ])
      });
    });

    this.bot.action('show_help', async (ctx) => {
      const helpMessage = `
🎯 *How to Play Bingo:*

*1. Starting a Game*
• Click "Play Bingo" to open the game
• Create a new game or join existing one
• Wait for players to join (2+ needed)

*2. During the Game*
• Numbers are called automatically
• Tap numbers on your card when called
• Center space is FREE! 🎁

*3. Winning*
• Complete a line (row, column, diagonal)
• Shout BINGO! (app does it automatically)
• Win points and climb the leaderboard!

*4. Game Types*
• 🎯 Classic - Standard 5x5 bingo
• 👥 Multiplayer - Play with friends
• ⚡ Quick Play - Fast games
      `;
      
      await ctx.editMessageText(helpMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Try It Now', `${process.env.WEB_APP_URL}`)],
          [Markup.button.callback('⬅️ Back', 'back_to_start')]
        ])
      });
    });

    this.bot.action('back_to_start', async (ctx) => {
      // Return to start message
      await ctx.deleteMessage();
      await this.bot.telegram.sendMessage(ctx.chat.id, 'Welcome back! Use the buttons below to play:', 
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Play Bingo', `${process.env.WEB_APP_URL}`)],
          [Markup.button.callback('📊 My Stats', 'show_stats')],
          [Markup.button.callback('❓ How to Play', 'show_help')]
        ])
      );
    });

    // Handle direct messages with the game link
    this.bot.hears(['play', 'game', 'bingo'], async (ctx) => {
      await ctx.reply(
        'Ready to play some Bingo? 🎯\n\nClick the button below to start!',
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Launch Bingo Game', `${process.env.WEB_APP_URL}`)]
        ])
      );
    });

    // Handle web app data (if you want to receive data from web app)
    this.bot.on('web_app_data', async (ctx) => {
      const data = ctx.webAppData.data.json();
      console.log('Data from Web App:', data);
      
      // You can process data from the web app here
      // For example: game results, user actions, etc.
    });
  }

  launch() {
    this.bot.launch();
    console.log('🤖 Bingo Bot is running and ready!');
    
    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;