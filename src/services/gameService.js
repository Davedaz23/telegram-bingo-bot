// services/gameService.js
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
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
    
    // Populate host information
    await game.populate('host', 'username firstName');
    
    return game;
  }

  static async joinGame(gameCode, userId) {
    const game = await Game.findOne({ code: gameCode })
      .populate('host', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName'
        }
      });

    if (!game || game.status !== 'WAITING') {
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
      throw new Error('Already joined this game');
    }

    // Add player to game
    await GamePlayer.create({
      userId,
      gameId: game._id,
    });

    // Generate bingo card for player
    const bingoCardNumbers = GameUtils.generateBingoCard();
    await BingoCard.create({
      userId,
      gameId: game._id,
      numbers: bingoCardNumbers,
      markedPositions: [12], // FREE space (center position in 5x5 grid)
    });

    // Update player count
    game.currentPlayers += 1;
    await game.save();

    return this.getGameWithDetails(game._id);
  }

  static async startGame(gameId, hostId) {
    const game = await Game.findById(gameId);

    if (!game || game.hostId.toString() !== hostId) {
      throw new Error('Game not found or unauthorized');
    }

    if (game.status !== 'WAITING') {
      throw new Error('Game already started');
    }

    game.status = 'ACTIVE';
    await game.save();

    // Populate the game with player details
    await game.populate({
      path: 'players',
      populate: {
        path: 'user',
        select: 'username firstName'
      }
    });

    return game;
  }

  static async callNumber(gameId) {
    const game = await Game.findById(gameId);

    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    const calledNumbers = game.numbersCalled || [];
    let newNumber;

    // Generate unique number (1-75 for standard Bingo)
    do {
      newNumber = Math.floor(Math.random() * 75) + 1;
    } while (calledNumbers.includes(newNumber));

    calledNumbers.push(newNumber);
    game.numbersCalled = calledNumbers;
    await game.save();

    return { number: newNumber, calledNumbers };
  }

  static async markNumber(gameId, userId, number) {
    const bingoCard = await BingoCard.findOne({ 
      gameId, 
      userId 
    });

    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    const numbers = bingoCard.numbers;
    const markedPositions = bingoCard.markedPositions || [];
    let position = -1;

    // Find number position in card (5x5 grid)
    for (let i = 0; i < numbers.length; i++) {
      for (let j = 0; j < numbers[i].length; j++) {
        const idx = i * 5 + j;
        if (numbers[i][j] === number && !markedPositions.includes(idx)) {
          position = idx;
          break;
        }
      }
      if (position !== -1) break;
    }

    if (position === -1) {
      throw new Error('Number not found in card or already marked');
    }

    markedPositions.push(position);

    // Check for win
    const isWinner = GameUtils.checkWinCondition(numbers, markedPositions);

    bingoCard.markedPositions = markedPositions;
    bingoCard.isWinner = isWinner;
    await bingoCard.save();

    if (isWinner) {
      // Update game winner and status
      await Game.findByIdAndUpdate(gameId, {
        status: 'FINISHED',
        winnerId: userId,
      });

      // Update user stats
      const UserService = require('./userService');
      await UserService.updateUserStats(userId, true);
    }

    return { bingoCard, isWinner };
  }

  static async getGameWithDetails(gameId) {
    return await Game.findById(gameId)
      .populate('host', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName'
        }
      })
      .populate('bingoCards');
  }

  static async getActiveGames() {
    return await Game.find({ status: 'WAITING' })
      .populate('host', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName'
        }
      })
      .sort({ createdAt: -1 })
      .limit(50);
  }

  // Helper method to find game by code
  static async findByCode(code) {
    return await Game.findOne({ code })
      .populate('host', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName'
        }
      });
  }
}

module.exports = GameService;