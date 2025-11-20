// services/gameService.js
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // Update other methods that return games...
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

  return this.getGameWithDetails(game._id); // This now returns mapped fields
}

  
static async joinGame(gameCode, userId) {
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
    return this.getGameWithDetails(game._id); // This now returns mapped fields
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

  return this.getGameWithDetails(game._id); // This now returns mapped fields
}

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

  return this.getGameWithDetails(game._id); // This now returns mapped fields
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

          break; // First winner wins
        }
      }
    }
  }

  static async markNumber(gameId, userId, number) {
    const bingoCard = await BingoCard.findOne({ gameId, userId });
    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    // Don't allow marking the FREE space
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
  // Validate gameId is a valid ObjectId
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

  // Convert to plain object and map fields for frontend
  const gameObj = game.toObject();
  
  // Map hostId to host for frontend compatibility
  if (gameObj.hostId) {
    gameObj.host = gameObj.hostId;
    delete gameObj.hostId;
  }
  
  // Map winnerId to winner for frontend compatibility
  if (gameObj.winnerId) {
    gameObj.winner = gameObj.winnerId;
    delete gameObj.winnerId;
  }

  return gameObj;
}

  static async getUserBingoCard(gameId, userId) {
    return await BingoCard.findOne({ gameId, userId })
      .populate('userId', 'username firstName'); // Fixed: populate userId, not user
  }

  static async getActiveGames() {
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

  // Convert to plain object and map fields for frontend
  const gameObj = game.toObject();
  
  // Map hostId to host for frontend compatibility
  if (gameObj.hostId) {
    gameObj.host = gameObj.hostId;
    delete gameObj.hostId;
  }
  
  // Map winnerId to winner for frontend compatibility
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

  // Remove player
  await GamePlayer.deleteOne({ gameId, userId });
  await BingoCard.deleteOne({ gameId, userId });

  // Update player count
  game.currentPlayers = Math.max(0, game.currentPlayers - 1);
  
  // If no players left or host left, end game
  if (game.currentPlayers === 0 || game.hostId.toString() === userId.toString()) {
    game.status = 'CANCELLED';
    game.endedAt = new Date();
  }
  
  await game.save();
  return this.getGameWithDetails(game._id); // This now returns mapped fields
}

  // NEW METHODS - ADDED BASED ON API REQUIREMENTS

  static async getWaitingGames() {
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
}


  static async getUserActiveGames(userId) {
    return await Game.find({
      'players.userId': userId,
      status: { $in: ['WAITING', 'ACTIVE'] }
    })
      .populate('hostId', 'username firstName telegramId') // Fixed: populate hostId, not host
      .populate('winnerId', 'username firstName') // Fixed: populate winnerId, not winner
      .populate({
        path: 'players',
        populate: {
          path: 'userId', // Fixed: populate userId, not user
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
      .populate('hostId', 'username firstName telegramId') // Fixed: populate hostId, not host
      .populate('winnerId', 'username firstName') // Fixed: populate winnerId, not winner
      .populate({
        path: 'players',
        populate: {
          path: 'userId', // Fixed: populate userId, not user
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
    
    // Update card if winner
    if (isWinner && !bingoCard.isWinner) {
      bingoCard.isWinner = true;
      await bingoCard.save();

      // Update game if active
      if (game.status === 'ACTIVE') {
        game.status = 'FINISHED';
        game.winnerId = userId;
        game.endedAt = new Date();
        await game.save();

        // Update stats
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

    // Update game status
    game.status = 'FINISHED';
    game.endedAt = new Date();
    
    // If no winner, mark as completed without winner
    if (!game.winnerId) {
      game.winnerId = null;
    }
    
    await game.save();

    // Update player stats for all participants
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
    
    // Calculate average marked numbers per player
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
      gameDuration: game.startedAt ? Math.floor((new Date() - game.startedAt) / 60000) : 0, // in minutes
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

    // Validate maxPlayers
    if (settings.maxPlayers !== undefined) {
      if (settings.maxPlayers < game.currentPlayers) {
        throw new Error(`Cannot set max players lower than current player count (${game.currentPlayers})`);
      }
      if (settings.maxPlayers < 2 || settings.maxPlayers > 50) {
        throw new Error('Max players must be between 2 and 50');
      }
      game.maxPlayers = settings.maxPlayers;
    }

    // Update isPrivate if provided
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