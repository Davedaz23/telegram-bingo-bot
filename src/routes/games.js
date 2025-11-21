// services/gameService.js
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // FIXED: Initialize static properties at the top of the class
  static activeIntervals = new Map();
  static isAutoCallingActive = false;

  // SINGLE GAME MANAGEMENT SYSTEM - NO HOST CONCEPT
  static async getMainGame() {
    try {
      // FIXED: Ensure activeIntervals is initialized
      if (!this.activeIntervals) {
        this.activeIntervals = new Map();
      }

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
      } else if (game.status === 'ACTIVE' && this.activeIntervals && !this.activeIntervals.has(game._id.toString())) {
        // Game is active but no auto-calling interval - restart it
        console.log(`🔄 Restarting auto-calling for active game ${game.code}`);
        this.startAutoNumberCalling(game._id);
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
      // FIXED: Ensure activeIntervals is initialized
      if (!this.activeIntervals) {
        this.activeIntervals = new Map();
      }

      // Find games that finished more than 10 seconds ago
      const finishedGames = await Game.find({
        status: 'FINISHED',
        endedAt: { $lt: new Date(Date.now() - 10000) } // 10 seconds ago
      });

      for (const game of finishedGames) {
        console.log(`🔄 Auto-restarting finished game ${game.code}`);
        
        // Stop any existing interval for this game
        this.stopAutoNumberCalling(game._id);
        
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
    // FIXED: Ensure activeIntervals is initialized
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
    }

    // Stop any existing interval for this game first
    this.stopAutoNumberCalling(gameId);

    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'ACTIVE') {
      console.log(`❌ Cannot start auto-calling: Game ${gameId} not active`);
      return;
    }

    console.log(`🔢 Starting auto-number calling for game ${game.code}`);

    // Call first number immediately
    setTimeout(async () => {
      try {
        await this.callNumber(gameId);
      } catch (error) {
        console.error('❌ Auto-call error:', error);
      }
    }, 3000);

    // Then call numbers every 8-12 seconds (randomized for better feel)
    const interval = setInterval(async () => {
      try {
        const currentGame = await Game.findById(gameId);
        
        // Check if game is still active and valid
        if (!currentGame || currentGame.status !== 'ACTIVE') {
          console.log(`🛑 Stopping auto-calling: Game ${gameId} no longer active`);
          this.stopAutoNumberCalling(gameId);
          return;
        }

        // Check if all numbers have been called
        if (currentGame.numbersCalled.length >= 75) {
          console.log(`🎯 All numbers called for game ${currentGame.code}, ending game`);
          this.stopAutoNumberCalling(gameId);
          await this.endGame(gameId);
          return;
        }

        await this.callNumber(gameId);
        
      } catch (error) {
        console.error('❌ Auto-call error:', error);
        // Don't stop on single error, but log it
      }
    }, 8000 + Math.random() * 4000); // Random between 8-12 seconds

    // Store interval reference for cleanup
    this.activeIntervals.set(gameId.toString(), interval);
    console.log(`✅ Auto-calling started for game ${game.code}. Active intervals: ${this.activeIntervals.size}`);

    return interval;
  }

  // Stop auto-calling when game ends
  static async stopAutoNumberCalling(gameId) {
    // FIXED: Ensure activeIntervals is initialized
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
      return;
    }

    const gameIdStr = gameId.toString();
    
    if (this.activeIntervals.has(gameIdStr)) {
      const interval = this.activeIntervals.get(gameIdStr);
      clearInterval(interval);
      this.activeIntervals.delete(gameIdStr);
      console.log(`🛑 Stopped auto-calling for game ${gameId}. Remaining intervals: ${this.activeIntervals.size}`);
    }
  }

  // Clean up all intervals
  static cleanupAllIntervals() {
    // FIXED: Ensure activeIntervals is initialized
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
      return;
    }

    console.log(`🧹 Cleaning up ${this.activeIntervals.size} active intervals`);
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
      console.log(`🛑 Stopped interval for game ${gameId}`);
    }
    this.activeIntervals.clear();
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
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Always use the main game
      const mainGame = await this.getMainGame();
      
      if (!mainGame) {
        throw new Error('No game available');
      }

      const game = await Game.findById(mainGame._id).session(session);

      // Check if user already joined
      const existingPlayer = await GamePlayer.findOne({ 
        userId, 
        gameId: game._id 
      }).session(session);
      
      if (existingPlayer) {
        await session.commitTransaction();
        return this.getGameWithDetails(game._id);
      }

      // Allow joining in both WAITING and ACTIVE states as PLAYER
      if (game.status === 'WAITING' || game.status === 'ACTIVE') {
        if (game.currentPlayers >= game.maxPlayers) {
          await session.abortTransaction();
          throw new Error('Game is full');
        }

        // Determine if this is a late joiner
        const isLateJoiner = game.status === 'ACTIVE';
        const numbersCalledAtJoin = game.numbersCalled || [];

        // Create GamePlayer entry
        await GamePlayer.create([{
          userId,
          gameId: game._id,
          isReady: true,
          playerType: 'PLAYER',
          joinedAt: new Date()
        }], { session });

        // Generate bingo card for player
        const bingoCardNumbers = GameUtils.generateBingoCard();
        await BingoCard.create([{
          userId,
          gameId: game._id,
          numbers: bingoCardNumbers,
          markedPositions: [12], // FREE space
          isLateJoiner: isLateJoiner,
          joinedAt: new Date(),
          numbersCalledAtJoin: numbersCalledAtJoin
        }], { session });

        // Atomic update of player count
        game.currentPlayers += 1;
        game.updatedAt = new Date();
        await game.save();

        await session.commitTransaction();

        console.log(`✅ User ${userId} joined as ${isLateJoiner ? 'LATE PLAYER' : 'PLAYER'}. Total players: ${game.currentPlayers}`);

        // Auto-start game if it's WAITING and we have players
        if (game.status === 'WAITING' && game.currentPlayers >= 1) {
          console.log(`🚀 Auto-starting game ${game.code} with ${game.currentPlayers} player(s)`);
          await this.startGame(game._id);
        }

        return this.getGameWithDetails(game._id);
      } 
      // If game is FINISHED, show results but don't allow joining
      else if (game.status === 'FINISHED') {
        await session.abortTransaction();
        throw new Error('Game has already finished. A new game will start soon.');
      }

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Join game error:', error);
      
      if (error.code === 11000) {
        throw new Error('You have already joined this game');
      }
      
      throw error;
    } finally {
      session.endSession();
    }
  }

  // MODIFIED: Start game - no host required for auto-games
  static async startGame(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);

      if (!game) {
        throw new Error('Game not found');
      }

      if (game.status !== 'WAITING') {
        throw new Error('Game already started');
      }

      game.status = 'ACTIVE';
      game.startedAt = new Date();
      await game.save();

      await session.commitTransaction();

      console.log(`🚀 Game ${game.code} started with ${game.currentPlayers} player(s)`);

      // Start auto-calling numbers
      this.startAutoNumberCalling(gameId);

      return this.getGameWithDetails(game._id);
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Start game error:', error);
      throw error;
    } finally {
      session.endSession();
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

    // Calculate active players vs spectators vs late joiners
    if (gameObj.players) {
      const activePlayers = gameObj.players.filter(p => p.playerType === 'PLAYER' || !p.playerType);
      const spectators = gameObj.players.filter(p => p.playerType === 'SPECTATOR');
      
      gameObj.activePlayers = activePlayers.length;
      gameObj.spectators = spectators.length;
      gameObj.totalParticipants = gameObj.players.length;
      
      gameObj.acceptsLateJoiners = gameObj.status === 'ACTIVE' && gameObj.currentPlayers < gameObj.maxPlayers;
      gameObj.numbersCalledCount = gameObj.numbersCalled?.length || 0;
    }

    return gameObj;
  }

  // Start the auto-game service when server starts
  static startAutoGameService() {
    // FIXED: Ensure activeIntervals is initialized before cleanup
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
    }

    // Clean up any existing intervals first
    this.cleanupAllIntervals();

    // Check and maintain the main game every 30 seconds
    const interval = setInterval(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Auto-game service error:', error);
      }
    }, 30000);

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
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);

      if (!game || game.status !== 'ACTIVE') {
        await session.abortTransaction();
        throw new Error('Game not active');
      }

      const calledNumbers = game.numbersCalled || [];
      
      if (calledNumbers.length >= 75) {
        await session.abortTransaction();
        console.log(`🎯 All numbers called for game ${game.code}`);
        await this.endGame(gameId);
        return;
      }

      let newNumber;
      let attempts = 0;
      do {
        newNumber = Math.floor(Math.random() * 75) + 1;
        attempts++;
        if (attempts > 100) {
          await session.abortTransaction();
          throw new Error('Could not find unused number after 100 attempts');
        }
      } while (calledNumbers.includes(newNumber));

      calledNumbers.push(newNumber);
      game.numbersCalled = calledNumbers;
      game.updatedAt = new Date();
      await game.save();

      console.log(`🔢 Called number: ${newNumber} for game ${game.code}. Total called: ${calledNumbers.length}`);

      // Check for automatic wins
      await this.checkForWinners(gameId, newNumber);

      await session.commitTransaction();

      return { 
        number: newNumber, 
        letter: GameUtils.getNumberLetter(newNumber),
        calledNumbers,
        totalCalled: calledNumbers.length 
      };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Call number error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async checkForWinners(gameId, lastCalledNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game || game.status !== 'ACTIVE') {
        await session.abortTransaction();
        return;
      }

      const bingoCards = await BingoCard.find({ gameId }).session(session);
      let winnerFound = false;
      
      for (const card of bingoCards) {
        const numbers = card.numbers.flat();
        const position = numbers.indexOf(lastCalledNumber);
        
        if (position !== -1 && !card.markedPositions.includes(position)) {
          card.markedPositions.push(position);
          
          const isWinner = GameUtils.checkWinCondition(numbers, card.markedPositions);
          card.isWinner = isWinner;
          await card.save();

          if (isWinner && !winnerFound) {
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

            winnerFound = true;
            
            // Stop auto-calling since we have a winner
            this.stopAutoNumberCalling(gameId);
          }
        }
      }

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Check winners error:', error);
    } finally {
      session.endSession();
    }
  }

  // Update the markNumber method to handle late joiners
  static async markNumber(gameId, userId, number) {
    const bingoCard = await BingoCard.findOne({ gameId, userId });
    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    // Get the game to check current state
    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    // For late joiners: check if this number was called before they joined
    if (bingoCard.isLateJoiner && number !== 'FREE') {
      const numbersCalledAtJoin = bingoCard.numbersCalledAtJoin || [];
      if (!numbersCalledAtJoin.includes(number)) {
        throw new Error('This number was called before you joined. You can only mark numbers called after you joined.');
      }
    }

    // For all players: check if this number has been called in the game
    const calledNumbers = game.numbersCalled || [];
    if (!calledNumbers.includes(number) && number !== 'FREE') {
      throw new Error('This number has not been called yet');
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
    
    // Check if user is a player (not spectator)
    const player = await GamePlayer.findOne({ gameId, userId });
    const isSpectator = player?.playerType === 'SPECTATOR';
    
    let isWinner = false;
    if (!isSpectator) {
      isWinner = GameUtils.checkWinCondition(numbers, bingoCard.markedPositions);
      bingoCard.isWinner = isWinner;
    }
    
    await bingoCard.save();

    if (isWinner && !isSpectator) {
      game.status = 'FINISHED';
      game.winnerId = userId;
      game.endedAt = new Date();
      await game.save();

      const UserService = require('./userService');
      await UserService.updateUserStats(userId, true);
    }

    return { bingoCard, isWinner, isSpectator };
  }

  // services/gameService.js - Update getGameWithDetails
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
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Stop auto-calling first
      this.stopAutoNumberCalling(gameId);

      const game = await Game.findById(gameId).session(session);
      
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
      const players = await GamePlayer.find({ gameId }).session(session);
      
      for (const player of players) {
        const isWinner = player.userId.toString() === game.winnerId?.toString();
        await UserService.updateUserStats(player.userId, isWinner);
      }

      await session.commitTransaction();

      console.log(`🏁 Game ${game.code} ended`);

      return this.getGameWithDetails(gameId);
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ End game error:', error);
      throw error;
    } finally {
      session.endSession();
    }
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

// Add cleanup on process termination
process.on('SIGINT', () => {
  console.log('🛑 Server shutting down...');
  GameService.cleanupAllIntervals();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Server terminating...');
  GameService.cleanupAllIntervals();
  process.exit(0);
});

module.exports = GameService;