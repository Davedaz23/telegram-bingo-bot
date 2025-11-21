// services/gameService.js
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // AUTO-GAME MANAGEMENT SYSTEM
  static async ensureActiveGame() {
    try {
      // Check if there are any active games
      const activeGames = await Game.find({ 
        status: { $in: ['WAITING', 'ACTIVE'] } 
      }).limit(1);

      if (activeGames.length === 0) {
        // No active games, create one automatically
        console.log('🎮 No active games found. Creating automatic game...');
        
        // Use a system user or the first available user as host
        const systemUser = await User.findOne().sort({ createdAt: 1 });
        
        if (!systemUser) {
          // Create a system user if none exists
          const systemUser = new User({
            username: 'system_bot',
            firstName: 'System',
            telegramId: 'system_auto_creator',
            gamesPlayed: 0,
            gamesWon: 0,
            totalScore: 0
          });
          await systemUser.save();
        }

        const gameCode = GameUtils.generateGameCode();
        
        const game = new Game({
          code: gameCode,
          hostId: systemUser._id,
          maxPlayers: 10,
          isPrivate: false,
          numbersCalled: [],
          status: 'WAITING',
          currentPlayers: 0,
          isAutoCreated: true // Flag to identify auto-created games
        });

        await game.save();
        console.log(`🎯 Auto-created game: ${gameCode}`);
        
        return this.getGameWithDetails(game._id);
      }

      return activeGames[0];
    } catch (error) {
      console.error('❌ Error ensuring active game:', error);
      throw error;
    }
  }

  static async autoRestartFinishedGames() {
    try {
      // Find games that finished more than 30 seconds ago
      const finishedGames = await Game.find({
        status: 'FINISHED',
        endedAt: { $lt: new Date(Date.now() - 30000) } // 30 seconds ago
      });

      let restartedCount = 0;

      for (const game of finishedGames) {
        console.log(`🔄 Auto-restarting finished game ${game.code}`);
        
        // Reset game state
        game.status = 'WAITING';
        game.numbersCalled = [];
        game.winnerId = null;
        game.startedAt = null;
        game.endedAt = null;
        game.currentPlayers = 0;
        
        await game.save();
        
        // Clear old players and bingo cards
        await GamePlayer.deleteMany({ gameId: game._id });
        await BingoCard.deleteMany({ gameId: game._id });
        
        console.log(`✅ Game ${game.code} reset and ready for new players`);
        restartedCount++;
      }
      
      return restartedCount;
    } catch (error) {
      console.error('❌ Error auto-restarting games:', error);
      return 0;
    }
  }

  static async getOrCreateActiveGame() {
    try {
      // First, restart any finished games
      await this.autoRestartFinishedGames();
      
      // Then ensure there's at least one active game
      return await this.ensureActiveGame();
    } catch (error) {
      console.error('❌ Error in getOrCreateActiveGame:', error);
      throw error;
    }
  }

  // Start the auto-restart service when the server starts
  static startAutoGameService() {
    // Check for active games every minute
    const interval = setInterval(async () => {
      try {
        await this.getOrCreateActiveGame();
      } catch (error) {
        console.error('❌ Auto-game service error:', error);
      }
    }, 60000); // Check every minute

    console.log('🚀 Auto-game service started - Games will be automatically created and managed');
    
    // Also run immediately on startup
    setTimeout(async () => {
      try {
        await this.getOrCreateActiveGame();
      } catch (error) {
        console.error('❌ Initial auto-game creation failed:', error);
      }
    }, 5000);

    return interval;
  }

  // MODIFIED: Get active games - now ensures there's always at least one
  static async getActiveGames() {
    try {
      // First ensure there's at least one active game
      await this.getOrCreateActiveGame();
      
      // Then return all waiting games
      const games = await Game.find({ status: 'WAITING' })
        .populate('hostId', 'username firstName telegramId')
        .populate({
          path: 'players',
          populate: {
            path: 'userId',
            select: 'username firstName telegramId'
          }
        })
        .sort({ createdAt: -1 })
        .limit(50);

      // Map fields for frontend compatibility
      return games.map(game => {
        const gameObj = game.toObject();
        
        // Map hostId to host
        if (gameObj.hostId) {
          gameObj.host = gameObj.hostId;
          delete gameObj.hostId;
        }
        
        return gameObj;
      });
    } catch (error) {
      console.error('❌ Error in getActiveGames:', error);
      // Fallback to original behavior if auto-creation fails
      const games = await Game.find({ status: 'WAITING' })
        .populate('hostId', 'username firstName telegramId')
        .populate({
          path: 'players',
          populate: {
            path: 'userId',
            select: 'username firstName telegramId'
          }
        })
        .sort({ createdAt: -1 })
        .limit(50);

      return games.map(game => {
        const gameObj = game.toObject();
        if (gameObj.hostId) {
          gameObj.host = gameObj.hostId;
          delete gameObj.hostId;
        }
        return gameObj;
      });
    }
  }

  // MODIFIED: Get waiting games - same as getActiveGames but ensures game exists
  static async getWaitingGames() {
    try {
      // Ensure there's at least one game
      await this.getOrCreateActiveGame();
      
      const games = await Game.find({ 
        status: 'WAITING',
        isPrivate: false 
      })
        .populate('hostId', 'username firstName telegramId')
        .populate({
          path: 'players',
          populate: {
            path: 'userId',
            select: 'username firstName telegramId'
          }
        })
        .sort({ createdAt: -1 })
        .limit(50);

      return games.map(game => {
        const gameObj = game.toObject();
        if (gameObj.hostId) {
          gameObj.host = gameObj.hostId;
          delete gameObj.hostId;
        }
        return gameObj;
      });
    } catch (error) {
      console.error('❌ Error in getWaitingGames:', error);
      // Fallback
      const games = await Game.find({ 
        status: 'WAITING',
        isPrivate: false 
      })
        .populate('hostId', 'username firstName telegramId')
        .populate({
          path: 'players',
          populate: {
            path: 'userId',
            select: 'username firstName telegramId'
          }
        })
        .sort({ createdAt: -1 })
        .limit(50);

      return games.map(game => {
        const gameObj = game.toObject();
        if (gameObj.hostId) {
          gameObj.host = gameObj.hostId;
          delete gameObj.hostId;
        }
        return gameObj;
      });
    }
  }

  // MODIFIED: Join game - automatically uses the main available game
  static async joinGame(gameCode, userId) {
    try {
      // If no specific game code provided, use the main available game
      if (!gameCode || gameCode === 'auto') {
        const mainGame = await this.getOrCreateActiveGame();
        gameCode = mainGame.code;
      }

      const game = await Game.findOne({ code: gameCode, status: 'WAITING' });

      if (!game) {
        throw new Error('Game not found or already started');
      }

      if (game.currentPlayers >= game.maxPlayers) {
        throw new Error('Game is full');
      }

      // Check if user already joined
      const existingPlayer = await GamePlayer.findOne({ 
        userId, 
        gameId: game._id 
      });
      
      if (existingPlayer) {
        return this.getGameWithDetails(game._id);
      }

      // Add player to game
      await GamePlayer.create({
        userId,
        gameId: game._id,
        isReady: false
      });

      // Generate bingo card for player
      const bingoCardNumbers = GameUtils.generateBingoCard();
      await BingoCard.create({
        userId,
        gameId: game._id,
        numbers: bingoCardNumbers,
        markedPositions: [12], // FREE space
      });

      // Update player count
      game.currentPlayers += 1;
      await game.save();

      // Auto-start game if enough players joined
      if (game.currentPlayers >= 2 && game.currentPlayers === game.maxPlayers) {
        console.log(`🚀 Auto-starting game ${game.code} with ${game.currentPlayers} players`);
        game.status = 'ACTIVE';
        game.startedAt = new Date();
        await game.save();
      }

      return this.getGameWithDetails(game._id);
    } catch (error) {
      console.error('❌ Join game error:', error);
      throw error;
    }
  }

  // MODIFIED: Start game - with auto-start conditions
  static async startGame(gameId, hostId) {
    const game = await Game.findById(gameId);

    if (!game || game.hostId.toString() !== hostId.toString()) {
      throw new Error('Game not found or unauthorized');
    }

    if (game.status !== 'WAITING') {
      throw new Error('Game already started');
    }

    if (game.currentPlayers < 2) {
      throw new Error('Need at least 2 players to start');
    }

    game.status = 'ACTIVE';
    game.startedAt = new Date();
    await game.save();

    return this.getGameWithDetails(game._id);
  }

  // KEEP ALL YOUR EXISTING METHODS BELOW - THEY STAY THE SAME
  static async createGame(hostId, maxPlayers = 10, isPrivate = false) {
    const gameCode = GameUtils.generateGameCode();

    const game = new Game({
      code: gameCode,
      hostId,
      maxPlayers,
      isPrivate,
      numbersCalled: [],
      status: 'WAITING',
      currentPlayers: 1
    });

    await game.save();
    
    // Add host as first player
    await GamePlayer.create({
      userId: hostId,
      gameId: game._id,
      isReady: true
    });

    // Generate bingo card for host
    const bingoCardNumbers = GameUtils.generateBingoCard();
    await BingoCard.create({
      userId: hostId,
      gameId: game._id,
      numbers: bingoCardNumbers,
      markedPositions: [12], // FREE space
    });

    return this.getGameWithDetails(game._id);
  }

  static async callNumber(gameId, callerId) {
    const game = await Game.findById(gameId);

    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    const calledNumbers = game.numbersCalled || [];
    
    if (calledNumbers.length >= 75) {
      throw new Error('All numbers have been called');
    }

    let newNumber;
    do {
      newNumber = Math.floor(Math.random() * 75) + 1;
    } while (calledNumbers.includes(newNumber));

    calledNumbers.push(newNumber);
    game.numbersCalled = calledNumbers;
    await game.save();

    // Check for automatic wins
    await this.checkForWinners(gameId, newNumber);

    return { 
      number: newNumber, 
      letter: GameUtils.getNumberLetter(newNumber),
      calledNumbers,
      totalCalled: calledNumbers.length 
    };
  }

  static async checkForWinners(gameId, lastCalledNumber) {
    const game = await Game.findById(gameId);
    if (game.status !== 'ACTIVE') return;

    const bingoCards = await BingoCard.find({ gameId });
    
    for (const card of bingoCards) {
      const numbers = card.numbers.flat();
      const position = numbers.indexOf(lastCalledNumber);
      
      if (position !== -1 && !card.markedPositions.includes(position)) {
        card.markedPositions.push(position);
        
        const isWinner = GameUtils.checkWinCondition(numbers, card.markedPositions);
        card.isWinner = isWinner;
        await card.save();

        if (isWinner) {
          // Update game winner and status
          game.status = 'FINISHED';
          game.winnerId = card.userId;
          game.endedAt = new Date();
          await game.save();

          // Update user stats
          const UserService = require('./userService');
          await UserService.updateUserStats(card.userId, true);

          // Update other players' stats (they lost)
          const losingPlayers = bingoCards.filter(c => c.userId.toString() !== card.userId.toString());
          for (const losingCard of losingPlayers) {
            await UserService.updateUserStats(losingCard.userId, false);
          }

          break;
        }
      }
    }
  }

  static async markNumber(gameId, userId, number) {
    const bingoCard = await BingoCard.findOne({ gameId, userId });
    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    if (number === 'FREE') {
      throw new Error('Cannot mark FREE space');
    }

    const numbers = bingoCard.numbers.flat();
    const position = numbers.indexOf(number);

    if (position === -1) {
      throw new Error('Number not found in your card');
    }

    if (bingoCard.markedPositions.includes(position)) {
      throw new Error('Number already marked');
    }

    bingoCard.markedPositions.push(position);
    
    const isWinner = GameUtils.checkWinCondition(numbers, bingoCard.markedPositions);
    bingoCard.isWinner = isWinner;
    await bingoCard.save();

    if (isWinner) {
      const game = await Game.findById(gameId);
      game.status = 'FINISHED';
      game.winnerId = userId;
      game.endedAt = new Date();
      await game.save();

      const UserService = require('./userService');
      await UserService.updateUserStats(userId, true);
    }

    return { bingoCard, isWinner };
  }

  static async getGameWithDetails(gameId) {
    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      throw new Error('Invalid game ID');
    }

    const game = await Game.findById(gameId)
      .populate('hostId', 'username firstName telegramId')
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });

    if (!game) {
      return null;
    }

    const gameObj = game.toObject();
    
    if (gameObj.hostId) {
      gameObj.host = gameObj.hostId;
      delete gameObj.hostId;
    }
    
    if (gameObj.winnerId) {
      gameObj.winner = gameObj.winnerId;
      delete gameObj.winnerId;
    }

    return gameObj;
  }

  static async getUserBingoCard(gameId, userId) {
    return await BingoCard.findOne({ gameId, userId })
      .populate('userId', 'username firstName');
  }

  static async findByCode(code) {
    const game = await Game.findOne({ code })
      .populate('hostId', 'username firstName telegramId')
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });

    if (!game) {
      return null;
    }

    const gameObj = game.toObject();
    
    if (gameObj.hostId) {
      gameObj.host = gameObj.hostId;
      delete gameObj.hostId;
    }
    
    if (gameObj.winnerId) {
      gameObj.winner = gameObj.winnerId;
      delete gameObj.winnerId;
    }

    return gameObj;
  }

  static async leaveGame(gameId, userId) {
    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    await GamePlayer.deleteOne({ gameId, userId });
    await BingoCard.deleteOne({ gameId, userId });

    game.currentPlayers = Math.max(0, game.currentPlayers - 1);
    
    if (game.currentPlayers === 0 || game.hostId.toString() === userId.toString()) {
      game.status = 'CANCELLED';
      game.endedAt = new Date();
    }
    
    await game.save();
    return this.getGameWithDetails(game._id);
  }

  static async getUserActiveGames(userId) {
    return await Game.find({
      'players.userId': userId,
      status: { $in: ['WAITING', 'ACTIVE'] }
    })
      .populate('hostId', 'username firstName telegramId')
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      })
      .sort({ createdAt: -1 })
      .limit(20);
  }

  static async getUserGameHistory(userId, limit = 10, page = 1) {
    const skip = (page - 1) * limit;
    
    const games = await Game.find({
      'players.userId': userId,
      status: { $in: ['FINISHED', 'CANCELLED'] }
    })
      .populate('hostId', 'username firstName telegramId')
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const total = await Game.countDocuments({
      'players.userId': userId,
      status: { $in: ['FINISHED', 'CANCELLED'] }
    });
    
    return {
      games,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  static async checkForWin(gameId, userId) {
    const bingoCard = await BingoCard.findOne({ gameId, userId });
    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    const numbers = bingoCard.numbers.flat();
    const isWinner = GameUtils.checkWinCondition(numbers, bingoCard.markedPositions);
    
    if (isWinner && !bingoCard.isWinner) {
      bingoCard.isWinner = true;
      await bingoCard.save();

      if (game.status === 'ACTIVE') {
        game.status = 'FINISHED';
        game.winnerId = userId;
        game.endedAt = new Date();
        await game.save();

        const UserService = require('./userService');
        await UserService.updateUserStats(userId, true);
      }
    }

    return {
      isWinner,
      bingoCard,
      winningPattern: isWinner ? GameUtils.getWinningPattern(bingoCard.markedPositions) : null
    };
  }

  static async endGame(gameId, hostId) {
    const game = await Game.findById(gameId);
    
    if (!game) {
      throw new Error('Game not found');
    }

    if (game.hostId.toString() !== hostId.toString()) {
      throw new Error('Only host can end the game');
    }

    if (game.status === 'FINISHED' || game.status === 'CANCELLED') {
      throw new Error('Game already ended');
    }

    game.status = 'FINISHED';
    game.endedAt = new Date();
    
    if (!game.winnerId) {
      game.winnerId = null;
    }
    
    await game.save();

    const UserService = require('./userService');
    const players = await GamePlayer.find({ gameId });
    
    for (const player of players) {
      const isWinner = player.userId.toString() === game.winnerId?.toString();
      await UserService.updateUserStats(player.userId, isWinner);
    }

    return this.getGameWithDetails(gameId);
  }

  static async getGameStats(gameId) {
    const game = await this.getGameWithDetails(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    const bingoCards = await BingoCard.find({ gameId });
    const calledNumbers = game.numbersCalled || [];
    
    let totalMarked = 0;
    let cardsWithBingo = 0;
    
    for (const card of bingoCards) {
      totalMarked += card.markedPositions.length;
      if (card.isWinner) {
        cardsWithBingo++;
      }
    }

    const averageMarked = bingoCards.length > 0 ? totalMarked / bingoCards.length : 0;

    return {
      gameId,
      totalPlayers: game.currentPlayers,
      totalNumbersCalled: calledNumbers.length,
      averageMarkedPerPlayer: Math.round(averageMarked * 100) / 100,
      cardsWithBingo,
      gameDuration: game.startedAt ? Math.floor((new Date() - game.startedAt) / 60000) : 0,
      numbersByLetter: this._getNumbersByLetter(calledNumbers)
    };
  }

  static _getNumbersByLetter(calledNumbers) {
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const result = {};
    
    letters.forEach(letter => {
      result[letter] = calledNumbers.filter(num => 
        GameUtils.getNumberLetter(num) === letter
      ).length;
    });
    
    return result;
  }

  static async updateGameSettings(gameId, hostId, settings) {
    const game = await Game.findById(gameId);
    
    if (!game) {
      throw new Error('Game not found');
    }

    if (game.hostId.toString() !== hostId.toString()) {
      throw new Error('Only host can update game settings');
    }

    if (game.status !== 'WAITING') {
      throw new Error('Cannot update settings after game has started');
    }

    if (settings.maxPlayers !== undefined) {
      if (settings.maxPlayers < game.currentPlayers) {
        throw new Error(`Cannot set max players lower than current player count (${game.currentPlayers})`);
      }
      if (settings.maxPlayers < 2 || settings.maxPlayers > 50) {
        throw new Error('Max players must be between 2 and 50');
      }
      game.maxPlayers = settings.maxPlayers;
    }

    if (settings.isPrivate !== undefined) {
      game.isPrivate = settings.isPrivate;
    }

    await game.save();
    return this.getGameWithDetails(gameId);
  }

  static async getGameById(gameId) {
    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      throw new Error('Invalid game ID');
    }

    return await this.getGameWithDetails(gameId);
  }
}

module.exports = GameService;