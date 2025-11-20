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

    return this.getGameWithDetails(game._id);
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
    await game.save();

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
      await game.save();

      const UserService = require('./userService');
      await UserService.updateUserStats(userId, true);
    }

    return { bingoCard, isWinner };
  }

  static async getGameWithDetails(gameId) {
    return await Game.findById(gameId)
      .populate('host', 'username firstName telegramId')
      .populate('winner', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName telegramId'
        }
      });
  }

  static async getUserBingoCard(gameId, userId) {
    return await BingoCard.findOne({ gameId, userId })
      .populate('user', 'username firstName');
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

  static async findByCode(code) {
    return await Game.findOne({ code })
      .populate('host', 'username firstName telegramId')
      .populate('winner', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'user',
          select: 'username firstName telegramId'
        }
      });
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
    }
    
    await game.save();
    return game;
  }
}

module.exports = GameService;