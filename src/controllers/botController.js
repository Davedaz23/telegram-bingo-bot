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
      try {
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
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('📊 My Stats', 'show_stats')],
            [Markup.button.callback('❓ How to Play', 'show_help')]
          ])
        );
      } catch (error) {
        console.error('Error in start command:', error);
        // Fallback if database fails
        await ctx.replyWithMarkdown(
          `🎯 *Welcome to Bingo Bot!*\n\nClick below to play:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Handle inline button callbacks
    this.bot.action('show_stats', async (ctx) => {
      try {
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
            [Markup.button.webApp('🎮 Play Now', 'https://bingominiapp.vercel.app')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error showing stats:', error);
        await ctx.answerCbQuery('Error loading stats. Please try again.');
      }
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

*Ready to play? Click the button below!*
      `;
      
      await ctx.editMessageText(helpMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Try It Now', 'https://bingominiapp.vercel.app')],
          [Markup.button.callback('⬅️ Back', 'back_to_start')]
        ])
      });
    });

    this.bot.action('back_to_start', async (ctx) => {
      try {
        // Return to start message
        await ctx.editMessageText(
          '🎯 *Welcome back to Bingo Bot!*\n\nReady to play some Bingo?',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')],
              [Markup.button.callback('📊 My Stats', 'show_stats')],
              [Markup.button.callback('❓ How to Play', 'show_help')]
            ])
          }
        );
      } catch (error) {
        console.error('Error in back action:', error);
        // If edit fails, send new message
        await ctx.replyWithMarkdown(
          '🎯 *Welcome back!*\n\nClick below to play:',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Handle any message that might indicate wanting to play
    this.bot.hears(['play', 'game', 'bingo', 'start', '🎮', '🎯'], async (ctx) => {
      await ctx.replyWithMarkdown(
        '🎯 *Ready to play Bingo?*\n\nClick the button below to start!',
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Launch Bingo Game', 'https://bingominiapp.vercel.app')]
        ])
      );
    });

    // Simple play command
    this.bot.command('play', async (ctx) => {
      await ctx.replyWithMarkdown(
        '🎮 *Opening Bingo Game...*\n\nGet ready to play!',
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎯 PLAY NOW', 'https://bingominiapp.vercel.app')]
        ])
      );
    });

    // Help command
    this.bot.help(async (ctx) => {
      await ctx.replyWithMarkdown(
        `🤖 *Bingo Bot Help*\n\n*Quick Commands:*\n/play - Start playing Bingo\n\n*Just click the button below to begin!*`,
        Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 PLAY BINGO', 'https://bingominiapp.vercel.app')]
        ])
      );
    });

    // Handle web app data
    this.bot.on('web_app_data', async (ctx) => {
      try {
        const data = ctx.webAppData.data.json();
        console.log('Data from Web App:', data);
        
        // You can process data from the web app here
        // For example: game results, user actions, etc.
        if (data.action === 'game_won') {
          await ctx.reply(`🎉 Congratulations! You won a Bingo game! 🏆\n\nWant to play again?`);
        }
      } catch (error) {
        console.error('Error processing web app data:', error);
      }
    });

    // Handle any other text message
    this.bot.on('text', async (ctx) => {
      // If not a command, suggest playing
      if (!ctx.message.text.startsWith('/')) {
        await ctx.replyWithMarkdown(
          'Want to play some Bingo? 🎯',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 YES, PLAY BINGO!', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });
     // Handle game creation from web app
    this.bot.on('web_app_data', async (ctx) => {
      try {
        const data = JSON.parse(ctx.webAppData?.data?.json() || '{}');
        console.log('Data from Web App:', data);

        const user = await UserService.findOrCreateUser(ctx.from);
        
        switch (data.action) {
          case 'create_game':
            const game = await GameService.createGame(user._id, data.maxPlayers, data.isPrivate);
            await ctx.reply(`🎮 Game created!\n\nCode: ${game.code}\nPlayers: ${game.currentPlayers}/${game.maxPlayers}\n\nShare the code with friends!`);
            break;
            
          case 'join_game':
            const joinedGame = await GameService.joinGame(data.gameCode, user._id);
            await ctx.reply(`✅ Joined game ${data.gameCode}!\n\nHost: ${joinedGame.host.firstName}\nPlayers: ${joinedGame.currentPlayers}/${joinedGame.maxPlayers}`);
            break;
            
          case 'game_won':
            await ctx.reply(`🎉 Congratulations! You won a Bingo game! 🏆\n\nYour stats have been updated. Want to play again?`,
              Markup.inlineKeyboard([
                [Markup.button.webApp('🎮 PLAY AGAIN', 'https://bingominiapp.vercel.app')]
              ])
            );
            break;
            
          case 'game_started':
            await ctx.reply(`🚀 Game ${data.gameCode} has started! Good luck! 🍀`);
            break;
        }
      } catch (error) {
        console.error('Error processing web app data:', error);
        await ctx.reply(`❌ Error: ${error.message}`);
      }
    });

    // Add game management commands
    this.bot.command('mygames', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const games = await Game.find({ 
          $or: [
            { hostId: user._id },
            { 'players.userId': user._id }
          ],
          status: { $in: ['WAITING', 'ACTIVE'] }
        }).populate('host', 'firstName').sort({ createdAt: -1 }).limit(5);

        if (games.length === 0) {
          await ctx.reply('You have no active games. Create one!',
            Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 CREATE GAME', 'https://bingominiapp.vercel.app')]
            ])
          );
          return;
        }

        let message = `🎮 Your Active Games:\n\n`;
        games.forEach(game => {
          message += `Code: ${game.code}\n`;
          message += `Host: ${game.host.firstName}\n`;
          message += `Players: ${game.currentPlayers}/${game.maxPlayers}\n`;
          message += `Status: ${game.status}\n`;
          message += `---\n`;
        });

        await ctx.reply(message,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 PLAY NOW', 'https://bingominiapp.vercel.app')]
          ])
        );
      } catch (error) {
        console.error('Error in mygames command:', error);
        await ctx.reply('Error loading your games');
      }
    });
  
  }

  launch() {
    this.bot.launch();
    console.log('🤖 Bingo Bot is running and ready!');
    console.log('🎯 WebApp URL: https://bingominiapp.vercel.app');
    
    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = BotController;