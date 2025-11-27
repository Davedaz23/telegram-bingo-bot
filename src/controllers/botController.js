// botController.js - CORRECTED VERSION
const { Telegraf, Markup } = require('telegraf');
const UserService = require('../services/userService');
const GameService = require('../services/gameService');
const Game = require('../models/Game');

class BotController {
  constructor(botToken) {
    this.bot = new Telegraf(botToken);
    this.setupHandlers();
  }

  // Generate mini app URL with user context - MOVED TO TOP LEVEL
  generateMiniAppUrl(telegramId) {
    return `https://bingominiapp.vercel.app?tg=${telegramId}&ref=bot`;
  }

  // Auto-join user to available game - MOVED TO TOP LEVEL
  async autoJoinUserToGame(userId) {
    try {
      const waitingGames = await GameService.getWaitingGames();
      
      if (waitingGames.length > 0) {
        const game = waitingGames[0];
        console.log(`🤖 Auto-joining user ${userId} to game ${game.code}`);
        
        // Join the first available waiting game
        await GameService.joinGame(game.code, userId);
        return true;
      }
      
      console.log('No waiting games available for auto-join');
      return false;
    } catch (error) {
      console.error('Auto-join error:', error);
      return false;
    }
  }

  setupHandlers() {
    // Start command with enhanced mini app integration
    this.bot.start(async (ctx) => {
      try {
        // Always create/update user when they interact with bot
        const user = await UserService.findOrCreateUser(ctx.from);
        
        console.log(`👋 User ${user.telegramId} started bot`);

        const welcomeMessage = `
🎯 *Welcome to Bingo Bot, ${user.firstName || user.username}!*

*Features:*
• 🎮 Play real-time Bingo instantly
• 👥 Auto-match with other players  
• 🏆 Win prizes and climb leaderboard
• ⚡ Fast and smooth gameplay

*Ready to play? Click below to launch the game!*
        `;

        // Generate mini app URL with user context
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.replyWithMarkdown(welcomeMessage, 
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', miniAppUrl)],
            [Markup.button.callback('📊 My Stats', 'show_stats')],
            [Markup.button.callback('❓ How to Play', 'show_help')]
          ])
        );

      } catch (error) {
        console.error('Error in start command:', error);
        // Fallback with basic mini app URL
        const miniAppUrl = 'https://bingominiapp.vercel.app';
        await ctx.replyWithMarkdown(
          `🎯 *Welcome to Bingo Bot!*\n\nClick below to play:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo Now', miniAppUrl)]
          ])
        );
      }
    });

    // Handle direct mini app opening
    this.bot.command('play', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.replyWithMarkdown(
          '🎮 *Opening Bingo Game...*\n\nGet ready to play! The game will automatically find opponents for you.',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎯 LAUNCH GAME', miniAppUrl)]
          ])
        );

        // Auto-join user to waiting game
        setTimeout(async () => {
          try {
            await this.autoJoinUserToGame(user._id);
          } catch (error) {
            console.log('Auto-join not available:', error.message);
          }
        }, 2000);

      } catch (error) {
        console.error('Error in play command:', error);
        await ctx.replyWithMarkdown(
          '🎮 *Opening Bingo Game...*',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎯 PLAY NOW', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Enhanced stats with game information
    this.bot.action('show_stats', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const stats = await UserService.getUserStats(user.telegramId);
        
        // Get user's active games
        const activeGames = await GameService.getUserActiveGames(user._id);
        
        let statsMessage = `📊 *Your Bingo Stats:*\n\n`;
        if (stats) {
          statsMessage += `🎮 Games Played: ${stats.gamesPlayed || 0}\n`;
          statsMessage += `🏆 Games Won: ${stats.gamesWon || 0}\n`;
          statsMessage += `📈 Win Rate: ${stats.gamesPlayed > 0 ? ((stats.gamesWon / stats.gamesPlayed) * 100).toFixed(1) : 0}%\n`;
          statsMessage += `⭐ Total Score: ${stats.totalScore || 0}\n\n`;
        } else {
          statsMessage += `No games played yet. Start your first game!\n\n`;
        }
        
        if (activeGames.length > 0) {
          statsMessage += `🎯 Active Games: ${activeGames.length}\n`;
          activeGames.forEach(game => {
            statsMessage += `• Game ${game.code} (${game.status})\n`;
          });
          statsMessage += `\n`;
        }
        
        statsMessage += `Keep playing to improve your stats! 🏆`;
        
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.editMessageText(statsMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Now', miniAppUrl)],
            [Markup.button.callback('🔄 Refresh', 'show_stats')],
            [Markup.button.callback('⬅️ Back', 'back_to_start')]
          ])
        });
      } catch (error) {
        console.error('Error showing stats:', error);
        await ctx.answerCbQuery('Error loading stats. Please try again.');
      }
    });

    // Enhanced help with mini app focus
    this.bot.action('show_help', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        const helpMessage = `
🎯 *How to Play Bingo:*

*1. Quick Start*
• Click "Play Bingo Now" below
• The app opens instantly
• You're automatically matched with players

*2. During the Game*
• Numbers are called automatically every few seconds
• Tap numbers on your card when they're called
• Center space is FREE! 🎁

*3. Winning*
• Complete any line (row, column, diagonal)
• Win automatically when you get BINGO!
• Earn points and climb the leaderboard

*4. Game Features*
• Auto-restart: Games restart automatically
• Live opponents: Play with real people
• No waiting: Always a game available

*Ready to play? Click the button below!*
      `;
      
      await ctx.editMessageText(helpMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎮 Try It Now', miniAppUrl)],
          [Markup.button.callback('⬅️ Back', 'back_to_start')]
        ])
      });
      } catch (error) {
        console.error('Error in help:', error);
        await ctx.editMessageText(
          '🎯 *Quick Start:*\n\n1. Click Play Bingo\n2. Game opens instantly\n3. Start playing!\n\n*That\'s it!*',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 PLAY NOW', 'https://bingominiapp.vercel.app')],
              [Markup.button.callback('⬅️ Back', 'back_to_start')]
            ])
          }
        );
      }
    });

    // Handle back to start
    this.bot.action('back_to_start', async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.editMessageText(
          '🎯 *Welcome back to Bingo Bot!*\n\nReady to play some Bingo?',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 Play Bingo', miniAppUrl)],
              [Markup.button.callback('📊 My Stats', 'show_stats')],
              [Markup.button.callback('❓ How to Play', 'show_help')]
            ])
          }
        );
      } catch (error) {
        console.error('Error in back action:', error);
        await ctx.replyWithMarkdown(
          '🎯 *Welcome back!*\n\nClick below to play:',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Play Bingo', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Handle any play-related messages
    this.bot.hears(['play', 'game', 'bingo', 'start', '🎮', '🎯', 'join'], async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.replyWithMarkdown(
          '🎯 *Ready to play Bingo?*\n\nClick the button below to start playing instantly!',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 Launch Bingo Game', miniAppUrl)]
          ])
        );
      } catch (error) {
        console.error('Error in play hears:', error);
        await ctx.replyWithMarkdown(
          '🎯 *Ready to play Bingo?*',
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 PLAY NOW', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Enhanced help command
    this.bot.help(async (ctx) => {
      try {
        const user = await UserService.findOrCreateUser(ctx.from);
        const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
        
        await ctx.replyWithMarkdown(
          `🤖 *Bingo Bot Help*\n\n*Quick Commands:*\n/play - Start playing Bingo instantly\n\n*Features:*\n• Auto-matchmaking\n• Live multiplayer\n• Instant gameplay\n\n*Just click the button below to begin!*`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 PLAY BINGO', miniAppUrl)]
          ])
        );
      } catch (error) {
        console.error('Error in help command:', error);
        await ctx.replyWithMarkdown(
          `🤖 *Bingo Bot Help*\n\nClick below to start playing:`,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 PLAY BINGO', 'https://bingominiapp.vercel.app')]
          ])
        );
      }
    });

    // Handle web app data for game integration
    this.bot.on('web_app_data', async (ctx) => {
      try {
        const data = ctx.webAppData?.data?.json();
        console.log('📱 Data from Web App:', data);

        const user = await UserService.findOrCreateUser(ctx.from);
        
        if (data && data.action) {
          switch (data.action) {
            case 'game_joined':
              await ctx.reply(`✅ You joined a Bingo game! Good luck! 🍀\n\nGame will start automatically when ready.`);
              break;
              
            case 'game_won':
              await ctx.reply(`🎉 Congratulations! You won a Bingo game! 🏆\n\nYour stats have been updated. Want to play again?`,
                Markup.inlineKeyboard([
                  [Markup.button.webApp('🎮 PLAY AGAIN', this.generateMiniAppUrl(user.telegramId))]
                ])
              );
              break;
              
            case 'game_created':
              await ctx.reply(`🎮 New game created!\n\nWaiting for players to join...`);
              break;
              
            default:
              console.log('Unknown web app action:', data.action);
          }
        }
      } catch (error) {
        console.error('Error processing web app data:', error);
      }
    });

    // Handle any other text message - suggest playing
    this.bot.on('text', async (ctx) => {
      if (!ctx.message.text.startsWith('/')) {
        try {
          const user = await UserService.findOrCreateUser(ctx.from);
          const miniAppUrl = this.generateMiniAppUrl(user.telegramId);
          
          await ctx.replyWithMarkdown(
            'Want to play some Bingo? 🎯\n\nClick below to start playing instantly!',
            Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 YES, PLAY BINGO!', miniAppUrl)]
            ])
          );
        } catch (error) {
          console.error('Error in text handler:', error);
          await ctx.replyWithMarkdown(
            'Want to play some Bingo? 🎯',
            Markup.inlineKeyboard([
              [Markup.button.webApp('🎮 PLAY BINGO', 'https://bingominiapp.vercel.app')]
            ])
          );
        }
      }
    });

    // Game management commands
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
              [Markup.button.webApp('🎮 CREATE GAME', this.generateMiniAppUrl(user.telegramId))]
            ])
          );
          return;
        }

        let message = `🎮 Your Active Games:\n\n`;
        games.forEach(game => {
          message += `Code: ${game.code}\n`;
          message += `Host: ${game.host?.firstName || 'System'}\n`;
          message += `Players: ${game.currentPlayers}/${game.maxPlayers}\n`;
          message += `Status: ${game.status}\n`;
          message += `---\n`;
        });

        await ctx.reply(message,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 PLAY NOW', this.generateMiniAppUrl(user.telegramId))]
          ])
        );
      } catch (error) {
        console.error('Error in mygames command:', error);
        await ctx.reply('Error loading your games');
      }
    });

    // Quick game status command
    this.bot.command('status', async (ctx) => {
      try {
        const waitingGames = await GameService.getWaitingGames();
        const activeGames = await GameService.getActiveGames();
        
        let statusMessage = `🎯 *Bingo Game Status*\n\n`;
        statusMessage += `🕒 Waiting Games: ${waitingGames.length}\n`;
        statusMessage += `🎮 Active Games: ${activeGames.length}\n\n`;
        
        if (waitingGames.length > 0) {
          statusMessage += `*Waiting Games:*\n`;
          waitingGames.forEach(game => {
            statusMessage += `• ${game.code} (${game.currentPlayers}/${game.maxPlayers} players)\n`;
          });
          statusMessage += `\n`;
        }
        
        statusMessage += `Join a game now!`;
        
        const user = await UserService.findOrCreateUser(ctx.from);
        
        await ctx.replyWithMarkdown(statusMessage,
          Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 JOIN GAME', this.generateMiniAppUrl(user.telegramId))]
          ])
        );
      } catch (error) {
        console.error('Error in status command:', error);
        await ctx.reply('Error getting game status');
      }
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      console.error(`❌ Bot error for ${ctx.updateType}:`, err);
      ctx.reply('❌ Something went wrong. Please try again.');
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