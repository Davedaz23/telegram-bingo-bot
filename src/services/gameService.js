// services/gameService.js
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // SINGLE GAME MANAGEMENT SYSTEM - NO HOST CONCEPT
  static async getMainGame() {
    try {
      // First, check for any finished games that can be restarted
      await this.autoRestartFinishedGames();
      
      // Then look for active/waiting games
      let game = await Game.findOne({ 
        status: { $in: ['WAITING', 'ACTIVE'] } 
      })
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });

      if (!game) {
        // No active games, create one automatically
        console.log('🎮 No active games found. Creating automatic game...');
        game = await this.createAutoGame();
      }

      return this.formatGameForFrontend(game);
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    }
  }

  static async createAutoGame() {
    try {
      const gameCode = GameUtils.generateGameCode();
      
      const game = new Game({
        code: gameCode,
        maxPlayers: 10,
        isPrivate: false,
        numbersCalled: [],
        status: 'WAITING',
        currentPlayers: 0,
        isAutoCreated: true
      });

      await game.save();
      console.log(`🎯 Auto-created game: ${gameCode}`);
      
      return this.getGameWithDetails(game._id);
    } catch (error) {
      console.error('❌ Error creating auto game:', error);
      throw error;
    }
  }

  static async autoRestartFinishedGames() {
    try {
      // Find games that finished more than 10 seconds ago
      const finishedGames = await Game.find({
        status: 'FINISHED',
        endedAt: { $lt: new Date(Date.now() - 10000) } // 10 seconds ago
      });

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
      }
      
      return finishedGames.length;
    } catch (error) {
      console.error('❌ Error auto-restarting games:', error);
      return 0;
    }
  }

  // Auto-call numbers for active games - NO HOST REQUIRED
static async startAutoNumberCalling(gameId) {
  const game = await Game.findById(gameId);
  
  if (!game || game.status !== 'ACTIVE') return;

  console.log(`🔢 Starting auto-number calling for game ${game.code}`);

  // Call first number immediately
  setTimeout(async () => {
    try {
      await this.callNumber(gameId);
    } catch (error) {
      console.error('❌ Auto-call error:', error);
    }
  }, 3000); // Increased to 3 seconds for better UX

  // Then call numbers every 8-12 seconds (randomized for better feel)
  const interval = setInterval(async () => {
    try {
      const currentGame = await Game.findById(gameId);
      if (!currentGame || currentGame.status !== 'ACTIVE') {
        clearInterval(interval);
        console.log(`🛑 Stopping auto-calling for game ${gameId}`);
        return;
      }

      await this.callNumber(gameId);
      
      // Check if all numbers have been called
      if (currentGame.numbersCalled.length >= 75) {
        clearInterval(interval);
        console.log('🎯 All numbers called, ending game');
        // End game if no winner after all numbers
        if (!currentGame.winnerId) {
          await this.endGame(gameId);
        }
      }
    } catch (error) {
      console.error('❌ Auto-call error:', error);
    }
  }, 8000 + Math.random() * 4000); // Random between 8-12 seconds

  // Store interval reference for cleanup
  this.activeIntervals = this.activeIntervals || new Map();
  this.activeIntervals.set(gameId.toString(), interval);

  return interval;
}

// Stop auto-calling when game ends
static async stopAutoNumberCalling(gameId) {
  if (this.activeIntervals && this.activeIntervals.has(gameId.toString())) {
    const interval = this.activeIntervals.get(gameId.toString());
    clearInterval(interval);
    this.activeIntervals.delete(gameId.toString());
    console.log(`🛑 Stopped auto-calling for game ${gameId}`);
  }
}

  // MODIFIED: Get active games - always returns the main game
  static async getActiveGames() {
    try {
      const mainGame = await this.getMainGame();
      return [mainGame].filter(game => game !== null);
    } catch (error) {
      console.error('❌ Error in getActiveGames:', error);
      return [];
    }
  }

  // MODIFIED: Get waiting games - same as getActiveGames
  static async getWaitingGames() {
    try {
      const mainGame = await this.getMainGame();
      return [mainGame].filter(game => game !== null && game.status === 'WAITING');
    } catch (error) {
      console.error('❌ Error in getWaitingGames:', error);
      return [];
    }
  }

  // MODIFIED: Join game - automatically joins the main game
  static async joinGame(gameCode, userId) {
    try {
      // Always use the main game, ignore provided code for auto-created system
      const mainGame = await this.getMainGame();
      
      if (!mainGame) {
        throw new Error('No game available');
      }

      const game = await Game.findById(mainGame._id);

      // Check if user already joined
      const existingPlayer = await GamePlayer.findOne({ 
        userId, 
        gameId: game._id 
      });
      
      if (existingPlayer) {
        return this.getGameWithDetails(game._id);
      }

      // If game is WAITING, join as active player
      if (game.status === 'WAITING') {
        if (game.currentPlayers >= game.maxPlayers) {
          throw new Error('Game is full');
        }

        // Add player to game
        await GamePlayer.create({
          userId,
          gameId: game._id,
          isReady: true,
          playerType: 'PLAYER'
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

        // Auto-start game if enough players joined (2 or more)
        if (game.currentPlayers >= 2 && game.status === 'WAITING') {
          console.log(`🚀 Auto-starting game ${game.code} with ${game.currentPlayers} players`);
          game.status = 'ACTIVE';
          game.startedAt = new Date();
          await game.save();
          
          // Start auto-calling numbers
          this.startAutoNumberCalling(game._id);
        }

      } 
      // If game is ACTIVE, join as SPECTATOR
      else if (game.status === 'ACTIVE') {
        console.log(`👀 User ${userId} joining game ${game.code} as spectator`);
        
        // Add user as spectator
        await GamePlayer.create({
          userId,
          gameId: game._id,
          isReady: false,
          playerType: 'SPECTATOR'
        });

        // Generate bingo card for spectator (they can still play along)
        const bingoCardNumbers = GameUtils.generateBingoCard();
        await BingoCard.create({
          userId,
          gameId: game._id,
          numbers: bingoCardNumbers,
          markedPositions: [12], // FREE space
          isSpectator: true
        });

        // Don't increment currentPlayers for spectators
        console.log(`✅ User ${userId} joined as spectator`);
      }
      // If game is FINISHED, show results but don't allow joining
      else if (game.status === 'FINISHED') {
        throw new Error('Game has already finished. A new game will start soon.');
      }

      return this.getGameWithDetails(game._id);
    } catch (error) {
      console.error('❌ Join game error:', error);
      throw error;
    }
  }

  // MODIFIED: Start game - no host required for auto-games
// services/gameService.js - UPDATED startGame method
// MODIFIED: Start game - no host required for auto-games, works with any number of players
static async startGame(gameId) {
  const game = await Game.findById(gameId);

  if (!game) {
    throw new Error('Game not found');
  }

  if (game.status !== 'WAITING') {
    throw new Error('Game already started');
  }

  // REMOVED: Minimum player check - now starts with any number of players
  // if (game.currentPlayers < 2) {
  //   throw new Error('Need at least 2 players to start');
  // }

  game.status = 'ACTIVE';
  game.startedAt = new Date();
  await game.save();

  console.log(`🚀 Game ${game.code} started with ${game.currentPlayers} player(s)`);

  // Start auto-calling numbers regardless of player count
  this.startAutoNumberCalling(gameId);

  return this.getGameWithDetails(game._id);
}

// Also update the auto-start logic in joinGame to work with 1 player
static async joinGame(gameCode, userId) {
  try {
    // Always use the main game, ignore provided code for auto-created system
    const mainGame = await this.getMainGame();
    
    if (!mainGame) {
      throw new Error('No game available');
    }

    const game = await Game.findById(mainGame._id);

    // Check if user already joined
    const existingPlayer = await GamePlayer.findOne({ 
      userId, 
      gameId: game._id 
    });
    
    if (existingPlayer) {
      return this.getGameWithDetails(game._id);
    }

    // If game is WAITING, join as active player
    if (game.status === 'WAITING') {
      if (game.currentPlayers >= game.maxPlayers) {
        throw new Error('Game is full');
      }

      // Add player to game
      await GamePlayer.create({
        userId,
        gameId: game._id,
        isReady: true,
        playerType: 'PLAYER'
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

      // MODIFIED: Auto-start game if ANY players joined (even just 1)
      if (game.currentPlayers >= 1 && game.status === 'WAITING') {
        console.log(`🚀 Auto-starting game ${game.code} with ${game.currentPlayers} player(s)`);
        game.status = 'ACTIVE';
        game.startedAt = new Date();
        await game.save();
        
        // Start auto-calling numbers
        this.startAutoNumberCalling(game._id);
      }

    } 
    // If game is ACTIVE, join as SPECTATOR
    else if (game.status === 'ACTIVE') {
      console.log(`👀 User ${userId} joining game ${game.code} as spectator`);
      
      // Add user as spectator
      await GamePlayer.create({
        userId,
        gameId: game._id,
        isReady: false,
        playerType: 'SPECTATOR'
      });

      // Generate bingo card for spectator (they can still play along)
      const bingoCardNumbers = GameUtils.generateBingoCard();
      await BingoCard.create({
        userId,
        gameId: game._id,
        numbers: bingoCardNumbers,
        markedPositions: [12], // FREE space
        isSpectator: true
      });

      // Don't increment currentPlayers for spectators
      console.log(`✅ User ${userId} joined as spectator`);
    }
    // If game is FINISHED, show results but don't allow joining
    else if (game.status === 'FINISHED') {
      throw new Error('Game has already finished. A new game will start soon.');
    }

    return this.getGameWithDetails(game._id);
  } catch (error) {
    console.error('❌ Join game error:', error);
    throw error;
  }
}

  // Format game for frontend compatibility - REMOVE HOST REFERENCES
  static formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    
    // Remove host mapping since we don't have hosts
    if (gameObj.hostId) {
      delete gameObj.hostId;
    }
    
    // Map winnerId to winner
    if (gameObj.winnerId) {
      gameObj.winner = gameObj.winnerId;
      delete gameObj.winnerId;
    }

    // Calculate active players vs spectators
    if (gameObj.players) {
      const activePlayers = gameObj.players.filter(p => p.playerType === 'PLAYER' || !p.playerType);
      const spectators = gameObj.players.filter(p => p.playerType === 'SPECTATOR');
      
      gameObj.activePlayers = activePlayers.length;
      gameObj.spectators = spectators.length;
      gameObj.totalParticipants = gameObj.players.length;
    }

    return gameObj;
  }

  // Start the auto-game service when server starts
  static startAutoGameService() {
    // Check and maintain the main game every 30 seconds
    const interval = setInterval(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Auto-game service error:', error);
      }
    }, 30000); // Check every 30 seconds

    console.log('🚀 Single Game Service Started - One game always available');
    
    // Run immediately on startup
    setTimeout(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Initial game setup failed:', error);
      }
    }, 5000);

    return interval;
  }

  // MODIFIED: Call number - no callerId required
  static async callNumber(gameId) {
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

    console.log(`🔢 Called number: ${newNumber} for game ${game.code}`);

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

          console.log(`🎉 Winner found: ${card.userId} in game ${game.code}`);

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
    
    // Only check for win if user is an actual player (not spectator)
    const player = await GamePlayer.findOne({ gameId, userId });
    const isSpectator = player?.playerType === 'SPECTATOR';
    
    let isWinner = false;
    if (!isSpectator) {
      isWinner = GameUtils.checkWinCondition(numbers, bingoCard.markedPositions);
      bingoCard.isWinner = isWinner;
    }
    
    await bingoCard.save();

    if (isWinner && !isSpectator) {
      const game = await Game.findById(gameId);
      game.status = 'FINISHED';
      game.winnerId = userId;
      game.endedAt = new Date();
      await game.save();

      const UserService = require('./userService');
      await UserService.updateUserStats(userId, true);
    }

    return { bingoCard, isWinner, isSpectator };
  }

  static async getGameWithDetails(gameId) {
    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      throw new Error('Invalid game ID');
    }

    const game = await Game.findById(gameId)
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

    return this.formatGameForFrontend(game);
  }

  static async getUserBingoCard(gameId, userId) {
    return await BingoCard.findOne({ gameId, userId })
      .populate('userId', 'username firstName');
  }

  static async findByCode(code) {
    const game = await Game.findOne({ code })
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

    return this.formatGameForFrontend(game);
  }

  static async leaveGame(gameId, userId) {
    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    await GamePlayer.deleteOne({ gameId, userId });
    await BingoCard.deleteOne({ gameId, userId });

    game.currentPlayers = Math.max(0, game.currentPlayers - 1);
    
    if (game.currentPlayers === 0) {
      game.status = 'CANCELLED';
      game.endedAt = new Date();
    }
    
    await game.save();
    return this.getGameWithDetails(game._id);
  }

  static async getUserActiveGames(userId) {
    const games = await Game.find({
      'players.userId': userId,
      status: { $in: ['WAITING', 'ACTIVE'] }
    })
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

    return games.map(game => this.formatGameForFrontend(game));
  }

  static async getUserGameRole(gameId, userId) {
    const player = await GamePlayer.findOne({ gameId, userId });
    if (!player) return null;
    
    return {
      playerType: player.playerType || 'PLAYER',
      isReady: player.isReady,
      joinedAt: player.joinedAt
    };
  }

  static async getUserGameHistory(userId, limit = 10, page = 1) {
    const skip = (page - 1) * limit;
    
    const games = await Game.find({
      'players.userId': userId,
      status: { $in: ['FINISHED', 'CANCELLED'] }
    })
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
      games: games.map(game => this.formatGameForFrontend(game)),
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

  // MODIFIED: End game - no host required
  static async endGame(gameId) {
    const game = await Game.findById(gameId);
    
    if (!game) {
      throw new Error('Game not found');
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

  // REMOVED: updateGameSettings since no hosts can update settings

  static async getGameById(gameId) {
    if (!mongoose.Types.ObjectId.isValid(gameId)) {
      throw new Error('Invalid game ID');
    }

    return await this.getGameWithDetails(gameId);
  }

  // NEW: Get winner information for popup
  static async getWinnerInfo(gameId) {
    const game = await Game.findById(gameId)
      .populate('winnerId', 'username firstName telegramId');
    
    if (!game || !game.winnerId) {
      return null;
    }

    return {
      winner: game.winnerId,
      gameCode: game.code,
      endedAt: game.endedAt,
      totalPlayers: game.currentPlayers,
      numbersCalled: game.numbersCalled?.length || 0
    };
  }
}

module.exports = GameService;