// services/gameService.js - FIXED VERSION (DUPLICATES REMOVED)
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const GameUtils = require('../utils/gameUtils');

class GameService {
  static activeIntervals = new Map();
  static isAutoCallingActive = false;
  static winnerDeclared = new Set();
  static processingGames = new Set();
  static MIN_PLAYERS_TO_START = 2;
  static selectedCards = new Map();
  static autoStartTimers = new Map();
  static CARD_SELECTION_DURATION = 30000;
static alreadyScheduledForAutoStart = new Map();

  // SINGLE GAME MANAGEMENT SYSTEM
  static async getMainGame() {
    try {
      if (!this.activeIntervals) {
        this.activeIntervals = new Map();
      }

      await this.autoRestartFinishedGames();
      
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
        console.log('🎮 No active games found. Creating automatic game...');
        game = await this.createAutoGame();
      } else if (game.status === 'ACTIVE' && this.activeIntervals && !this.activeIntervals.has(game._id.toString())) {
        console.log(`🔄 Restarting auto-calling for active game ${game.code}`);
        this.startAutoNumberCalling(game._id);
      }

      return this.formatGameForFrontend(game);
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    }
  }

  static async autoRestartFinishedGames() {
  try {
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
    }

    // Change from 10000 (10 seconds) to 60000 (60 seconds)
    const finishedGames = await Game.find({
      status: 'FINISHED',
      endedAt: { $lt: new Date(Date.now() - 60000) } // 60 seconds
    });

    for (const game of finishedGames) {
      console.log(`🔄 Auto-restarting finished game ${game.code} (60s delay)`);
      
      // ... rest of the method remains the same ...
    }
  } catch (error) {
    console.error('❌ Error auto-restarting games:', error);
    return 0;
  }
}


  // ENHANCED AUTO-CALLING WITH WIN DETECTION
  static async startAutoNumberCalling(gameId) {
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
    }

    this.stopAutoNumberCalling(gameId);

    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'ACTIVE') {
      console.log(`❌ Cannot start auto-calling: Game ${gameId} not active`);
      return;
    }

    this.winnerDeclared.delete(gameId.toString());
    this.processingGames.delete(gameId.toString());

    console.log(`🔢 Starting auto-number calling for game ${game.code}`);

    setTimeout(async () => {
      try {
        await this.callNumber(gameId);
      } catch (error) {
        console.error('❌ Auto-call error:', error);
      }
    }, 1000);

    const interval = setInterval(async () => {
      try {
        const currentGame = await Game.findById(gameId);
        
        if (!currentGame || currentGame.status !== 'ACTIVE') {
          console.log(`🛑 Stopping auto-calling: Game ${gameId} no longer active`);
          this.stopAutoNumberCalling(gameId);
          return;
        }

        if (this.winnerDeclared.has(gameId.toString())) {
          console.log(`✅ Winner declared, stopping auto-calling for game ${gameId}`);
          this.stopAutoNumberCalling(gameId);
          return;
        }

        if (currentGame.numbersCalled.length >= 75) {
          console.log(`🎯 All numbers called for game ${currentGame.code}, ending game`);
          this.stopAutoNumberCalling(gameId);
          await this.endGameDueToNoWinner(gameId);
          return;
        }

        await this.callNumber(gameId);
        
      } catch (error) {
        console.error('❌ Auto-call error:', error);
      }
    }, 5000 + Math.random() * 3000);

    this.activeIntervals.set(gameId.toString(), interval);
    console.log(`✅ Auto-calling started for game ${game.code}`);

    return interval;
  }

  static cleanupAllIntervals() {
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
      console.log('🧹 No active intervals to clean up');
      return;
    }

    console.log(`🧹 Cleaning up ${this.activeIntervals.size} active intervals`);
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
      console.log(`🛑 Stopped interval for game ${gameId}`);
    }
    this.activeIntervals.clear();
    this.winnerDeclared.clear();
    this.processingGames.clear();
  }

  static async stopAutoNumberCalling(gameId) {
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
      return;
    }

    const gameIdStr = gameId.toString();
    
    if (this.activeIntervals.has(gameIdStr)) {
      const interval = this.activeIntervals.get(gameIdStr);
      clearInterval(interval);
      this.activeIntervals.delete(gameIdStr);
      console.log(`🛑 Stopped auto-calling for game ${gameId}`);
    }
  }

  static async callNumber(gameId) {
  try {
    const game = await Game.findById(gameId);

    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    if (this.winnerDeclared.has(gameId.toString())) {
      console.log(`✅ Winner already declared for game ${game.code}, stopping calls`);
      return;
    }

    const calledNumbers = game.numbersCalled || [];
    
    if (calledNumbers.length >= 75) {
      console.log(`🎯 All numbers called for game ${game.code}, ending game`);
      await this.endGameDueToNoWinner(gameId);
      return;
    }

    let newNumber;
    let attempts = 0;
    do {
      newNumber = Math.floor(Math.random() * 75) + 1;
      attempts++;
      if (attempts > 100) {
        throw new Error('Could not find unused number after 100 attempts');
      }
    } while (calledNumbers.includes(newNumber));

    calledNumbers.push(newNumber);
    game.numbersCalled = calledNumbers;
    game.updatedAt = new Date();
    await game.save();

    console.log(`🔢 Called number: ${newNumber} for game ${game.code}. Total called: ${calledNumbers.length}`);
    
    // REMOVED automatic win check here - users must manually claim
    
    return { 
      number: newNumber, 
      letter: GameUtils.getNumberLetter(newNumber),
      calledNumbers,
      totalCalled: calledNumbers.length 
    };
  } catch (error) {
    console.error('❌ Call number error:', error);
    throw error;
  }
}

 static async checkForWinners(gameId, lastCalledNumber) {
  // REMOVE automatic win detection - only process manual claims
  console.log(`🔍 Win detection disabled - only manual claims accepted for game ${gameId}`);
  
  // Still check if all numbers are called to end game
  const game = await Game.findById(gameId);
  if (!game || game.status !== 'ACTIVE') {
    return; 
  }

  if (game.numbersCalled.length >= 75) {
    console.log(`🎯 All 75 numbers called for game ${game.code}, ending game`);
    await this.endGameDueToNoWinner(gameId);
  }
}

static async declareWinnerWithRetry(gameId, winningUserId, winningCard, winningPositions) {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const session = await mongoose.startSession();
    let transactionInProgress = false;
    
    try {
      session.startTransaction();
      transactionInProgress = true;
      
      console.log(`🔄 Attempt ${retryCount + 1} to declare winner for game ${gameId}`);

      const game = await Game.findById(gameId).session(session);
      const card = await BingoCard.findById(winningCard._id).session(session);

      if (!game || game.status !== 'ACTIVE') {
        console.log('❌ Game no longer active, aborting winner declaration');
        throw new Error('Game no longer active');
      }

      if (this.winnerDeclared.has(gameId.toString())) {
        console.log('✅ Winner already declared, aborting');
        throw new Error('Winner already declared');
      }

      // ONLY set winner flag, don't auto-add winning positions to marked positions
      card.isWinner = true;
      // REMOVED: card.markedPositions = [...new Set([...card.markedPositions, ...winningPositions])];
      await card.save({ session });

      game.status = 'FINISHED';
      game.winnerId = winningUserId;
      game.endedAt = new Date();
      await game.save({ session });

      const totalPlayers = game.currentPlayers;
      const entryFee = 10;
      const totalPot = totalPlayers * entryFee;
      const platformFee = totalPot * 0.1;
      const winnerPrize = totalPot - platformFee;

      const WalletService = require('./walletService');
      await WalletService.addWinning(winningUserId, gameId, winnerPrize, `Winner prize for game ${game.code}`);

      this.winnerDeclared.add(gameId.toString());

      await session.commitTransaction();
      transactionInProgress = false;
      
      console.log(`🎊 Game ${game.code} ENDED - Winner: ${winningUserId} won $${winnerPrize}`);

      const UserService = require('./userService');
      await UserService.updateUserStats(winningUserId, true);

      const bingoCards = await BingoCard.find({ gameId });
      const losingPlayers = bingoCards.filter(c => c.userId.toString() !== winningUserId.toString());
      for (const losingCard of losingPlayers) {
        await UserService.updateUserStats(losingCard.userId, false);
      }

      this.stopAutoNumberCalling(gameId);
      setTimeout(() => {
        this.autoRestartGame(gameId);
      }, 60000);

      return;

    } catch (error) {
      // Only abort transaction if it's in progress
      if (transactionInProgress && session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch (abortError) {
          console.warn('⚠️ Error aborting transaction in declareWinnerWithRetry:', abortError.message);
        }
      }
      
      if (error.code === 112) {
        retryCount++;
        console.log(`🔄 Write conflict detected, retrying... (${retryCount}/${maxRetries})`);
        
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
          continue;
        }
      }
      
      console.error('❌ Failed to declare winner after retries:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
}

static checkEnhancedWinCondition(cardNumbers, markedPositions) {
  if (!cardNumbers || !markedPositions) {
    return { isWinner: false, patternType: null, winningPositions: [] };
  }

  // DO NOT automatically add FREE space or other numbers
  const effectiveMarked = [...markedPositions];
  
  console.log(`🔍 Enhanced win check: ${effectiveMarked.length} manually marked positions`);

  const winningPatterns = [
    { type: 'ROW', positions: [0, 1, 2, 3, 4] },
    { type: 'ROW', positions: [5, 6, 7, 8, 9] },
    { type: 'ROW', positions: [10, 11, 12, 13, 14] },
    { type: 'ROW', positions: [15, 16, 17, 18, 19] },
    { type: 'ROW', positions: [20, 21, 22, 23, 24] },
    { type: 'COLUMN', positions: [0, 5, 10, 15, 20] },
    { type: 'COLUMN', positions: [1, 6, 11, 16, 21] },
    { type: 'COLUMN', positions: [2, 7, 12, 17, 22] },
    { type: 'COLUMN', positions: [3, 8, 13, 18, 23] },
    { type: 'COLUMN', positions: [4, 9, 14, 19, 24] },
    { type: 'DIAGONAL', positions: [0, 6, 12, 18, 24] },
    { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] }
  ];

  for (const pattern of winningPatterns) {
    const isComplete = pattern.positions.every(pos => effectiveMarked.includes(pos));
    
    if (isComplete) {
      console.log(`🎯 WINNING ${pattern.type} PATTERN DETECTED!`);
      
      const winningNumbers = pattern.positions.map(pos => {
        const number = cardNumbers[pos];
        const row = Math.floor(pos / 5);
        const col = pos % 5;
        return `${number} (${row},${col})`;
      });
      console.log(`🔢 Winning numbers: ${winningNumbers.join(' → ')}`);
      
      return {
        isWinner: true,
        patternType: pattern.type,
        winningPositions: pattern.positions
      };
    }
  }

  return { isWinner: false, patternType: null, winningPositions: [] };
}

  static async endGameDueToNoWinner(gameId) {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'ACTIVE') return;

      console.log(`🏁 Ending game ${game.code} - no winner after 75 numbers`);
      
      game.status = 'FINISHED';
      game.endedAt = new Date();
      game.winnerId = null;
      await game.save();

      this.winnerDeclared.add(gameId.toString());
      this.processingGames.delete(gameId.toString());
      
      this.stopAutoNumberCalling(gameId);
      
      setTimeout(() => {
        this.autoRestartGame(gameId);
      }, 30000);

    } catch (error) {
      console.error('❌ Error ending game due to no winner:', error);
    }
  }

  // GAME MANAGEMENT METHODS
  static async getActiveGames() {
    try {
      const mainGame = await this.getMainGame();
      return [mainGame].filter(game => game !== null);
    } catch (error) {
      console.error('❌ Error in getActiveGames:', error);
      return [];
    }
  }

  static async getWaitingGames() {
    try {
      const mainGame = await this.getMainGame();
      return [mainGame].filter(game => game !== null && game.status === 'WAITING');
    } catch (error) {
      console.error('❌ Error in getWaitingGames:', error);
      return [];
    }
  }

  // FIXED JOIN GAME METHOD (REMOVED DUPLICATE)
  static async joinGame(gameCode, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const mainGame = await this.getMainGame();
      
      if (!mainGame) {
        throw new Error('No game available');
      }

      const game = await Game.findById(mainGame._id).session(session);

      // Find user by Telegram ID first, then use MongoDB _id
      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ telegramId: userId }).session(session);
      }

      if (!user) {
        throw new Error('User not found');
      }

      // Use the MongoDB _id for GamePlayer
      const mongoUserId = user._id;

      const existingPlayer = await GamePlayer.findOne({ 
        userId: mongoUserId, 
        gameId: game._id 
      }).session(session);
      
      if (existingPlayer) {
        await session.commitTransaction();
        return this.getGameWithDetails(game._id);
      }

      if (game.status === 'WAITING' || game.status === 'ACTIVE') {
        if (game.currentPlayers >= game.maxPlayers) {
          await session.abortTransaction();
          throw new Error('Game is full');
        }

        const isLateJoiner = game.status === 'ACTIVE';

        await GamePlayer.create([{
          userId: mongoUserId,
          gameId: game._id,
          isReady: true,
          playerType: 'PLAYER',
          joinedAt: new Date()
        }], { session });

        game.currentPlayers += 1;
        game.updatedAt = new Date();
        await game.save();

        await session.commitTransaction();

        console.log(`✅ User ${userId} (Telegram) joined as ${isLateJoiner ? 'LATE PLAYER' : 'PLAYER'}. Total players: ${game.currentPlayers}`);

        if (game.status === 'WAITING') {
          console.log(`⏳ Player joined. Game ${game.code} waiting for manual start. Current: ${game.currentPlayers}/${game.maxPlayers} players`);
        }

        return this.getGameWithDetails(game._id);
      } 
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

 static async joinGameWithWallet(gameCode, userId, entryFee = 10) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const WalletService = require('./walletService');
    const balance = await WalletService.getBalance(userId);
    
    if (balance < entryFee) {
      throw new Error(`Insufficient balance. Required: $${entryFee}, Available: $${balance}`);
    }

    // DON'T deduct here - just check balance
    console.log(`✅ User ${userId} has sufficient balance: $${balance}`);

    const game = await this.joinGame(gameCode, userId);

    await session.commitTransaction();
    return game;

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Join game with wallet error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

  // CARD SELECTION METHODS
  static async selectCard(gameId, userId, cardNumbers, cardNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      if (game.status !== 'WAITING' && game.status !== 'ACTIVE') {
        throw new Error('Cannot select card - game is not active');
      }

      const existingCardWithNumber = await BingoCard.findOne({ 
        gameId, 
        cardNumber 
      }).session(session);
      
      if (existingCardWithNumber && existingCardWithNumber.userId.toString() !== userId.toString()) {
        throw new Error(`Card #${cardNumber} is already taken by another player`);
      }

      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ telegramId: userId }).session(session);
      }

      if (!user) {
        throw new Error('User not found');
      }

      const mongoUserId = user._id;

      const existingCard = await BingoCard.findOne({ gameId, userId: mongoUserId }).session(session);
      
      if (existingCard) {
        console.log(`🔄 User ${userId} already has a card. Updating card instead of creating new one.`);
        
        const previousCardNumber = existingCard.cardNumber;
        
        existingCard.numbers = cardNumbers;
        existingCard.cardNumber = cardNumber;
        existingCard.markedPositions = [12];
        existingCard.isWinner = false;
        existingCard.updatedAt = new Date();
        
        await existingCard.save({ session });
        
        if (previousCardNumber && previousCardNumber !== cardNumber) {
          console.log(`🔄 Releasing previous card #${previousCardNumber} for user ${userId}`);
          this.updateCardSelection(gameId, previousCardNumber, mongoUserId, 'RELEASED');
        }
        
        await session.commitTransaction();
        
        console.log(`✅ User ${user._id} (Telegram: ${user.telegramId}) UPDATED card #${cardNumber} for game ${game.code}`);
        
        this.updateCardSelection(gameId, cardNumber, mongoUserId, 'UPDATED');
        
        if (game.status === 'WAITING') {
          setTimeout(async () => {
            try {
              await this.scheduleAutoStartCheck(gameId);
            } catch (error) {
              console.error('❌ Auto-start check failed:', error);
            }
          }, 1000);
        }

        return { 
          success: true, 
          message: 'Card updated successfully',
          action: 'UPDATED',
          cardId: existingCard._id,
          cardNumber: cardNumber,
          previousCardNumber: previousCardNumber
        };
      }

      if (!cardNumbers || !Array.isArray(cardNumbers) || cardNumbers.length !== 5) {
        throw new Error('Invalid card format');
      }

      for (let i = 0; i < 5; i++) {
        if (!Array.isArray(cardNumbers[i]) || cardNumbers[i].length !== 5) {
          throw new Error('Invalid card format');
        }
      }

      const newCard = await BingoCard.create([{
        userId: mongoUserId,
        gameId,
        cardNumber: cardNumber,
        numbers: cardNumbers,
        markedPositions: [12],
        isLateJoiner: game.status === 'ACTIVE',
        joinedAt: new Date(),
        numbersCalledAtJoin: game.status === 'ACTIVE' ? (game.numbersCalled || []) : []
      }], { session });

      await session.commitTransaction();
      
      console.log(`✅ User ${user._id} (Telegram: ${user.telegramId}) CREATED new card #${cardNumber} for game ${game.code}`);
      
      this.updateCardSelection(gameId, cardNumber, mongoUserId, 'CREATED');
      
      if (game.status === 'WAITING') {
        setTimeout(async () => {
          try {
            await this.checkAndAutoStartGame(gameId);
          } catch (error) {
            console.error('❌ Auto-start after card selection failed:', error);
          }
        }, 1500);
      }

      return { 
        success: true, 
        message: 'Card selected successfully',
        action: 'CREATED',
        cardId: newCard[0]._id,
        cardNumber: cardNumber
      };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Select card error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static updateCardSelection(gameId, cardNumber, userId, action) {
    const gameIdStr = gameId.toString();
    
    if (!this.selectedCards.has(gameIdStr)) {
      this.selectedCards.set(gameIdStr, new Map());
    }
    
    const gameCards = this.selectedCards.get(gameIdStr);
    
    for (const [existingCardNumber, data] of gameCards.entries()) {
      if (data.userId.toString() === userId.toString()) {
        gameCards.delete(existingCardNumber);
        console.log(`🔄 Removed previous card #${existingCardNumber} for user ${userId}`);
      }
    }
    
    if (action === 'CREATED' || action === 'UPDATED') {
      gameCards.set(cardNumber, {
        userId: userId,
        selectedAt: new Date(),
        action: action
      });
      console.log(`✅ Card #${cardNumber} ${action} by user ${userId}`);
    }
  }

  static getRealTimeTakenCards(gameId) {
    const gameIdStr = gameId.toString();
    
    if (!this.selectedCards.has(gameIdStr)) {
      return [];
    }
    
    const gameCards = this.selectedCards.get(gameIdStr);
    const takenCards = [];
    
    for (const [cardNumber, data] of gameCards.entries()) {
      takenCards.push({
        cardNumber: parseInt(cardNumber),
        userId: data.userId
      });
    }
    
    return takenCards;
  }

  static async getAvailableCards(gameId, userId, count = 400) {
    const cards = [];
    
    for (let i = 0; i < count; i++) {
      const cardNumbers = GameUtils.generateBingoCard();
      cards.push({
        cardIndex: i + 1,
        numbers: cardNumbers,
        preview: this.formatCardForPreview(cardNumbers)
      });
    }
    
    return cards;
  }

  static formatCardForPreview(cardNumbers) {
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const preview = {};
    
    for (let i = 0; i < 5; i++) {
      preview[letters[i]] = cardNumbers[i];
    }
    
    return preview;
  }

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

    const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
    
    if (playersWithCards < this.MIN_PLAYERS_TO_START) {
      throw new Error(`Need at least ${this.MIN_PLAYERS_TO_START} players with selected cards to start the game. Current: ${playersWithCards}`);
    }

    // Get all players with cards
    const playerCards = await BingoCard.find({ gameId }).session(session);
    
    // Deduct entry fee from all players
    const WalletService = require('./walletService');
    const entryFee = 10;
    
    console.log(`💰 Deducting entry fees from ${playerCards.length} players...`);
    
    for (const card of playerCards) {
      try {
        const User = require('../models/User');
        const user = await User.findById(card.userId).session(session);
        
        if (user && user.telegramId) {
          await WalletService.deductGameEntry(
            user.telegramId, 
            gameId, 
            entryFee, 
            `Entry fee for game ${game.code}`
          );
          console.log(`✅ Deducted $${entryFee} from ${user.telegramId}`);
        } else {
          console.warn(`⚠️ Could not deduct from user ${card.userId} - user not found`);
        }
      } catch (error) {
        console.error(`❌ Failed to deduct from user ${card.userId}:`, error.message);
      }
    }

    game.status = 'ACTIVE';
    game.startedAt = new Date();
    game.autoStartEndTime = null;
    await game.save();

    await session.commitTransaction();

    console.log(`🚀 Game ${game.code} started with ${playersWithCards} player(s). Entry fees deducted.`);

    // Clear auto-start timer and flag
    this.clearAutoStartTimer(gameId);
    const gameIdStr = gameId.toString();
    this.alreadyScheduledForAutoStart.delete(gameIdStr);
    
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




static async formatGameForFrontend(game) {
  if (!game) return null;
  
  const gameObj = game.toObject ? game.toObject() : { ...game };
  
  // Remove unnecessary fields
  if (gameObj.hostId) {
    delete gameObj.hostId;
  }
  
  // Handle winner field
  if (gameObj.winnerId) {
    gameObj.winner = gameObj.winnerId;
    delete gameObj.winnerId;
  }

  if (gameObj.players) {
    const activePlayers = gameObj.players.filter(p => p.playerType === 'PLAYER' || !p.playerType);
    const spectators = gameObj.players.filter(p => p.playerType === 'SPECTATOR');
    
    gameObj.activePlayers = activePlayers.length;
    gameObj.spectators = spectators.length;
    gameObj.totalParticipants = gameObj.players.length;
    
    gameObj.minPlayersRequired = this.MIN_PLAYERS_TO_START;
    
    // FIX: Count players with cards from BingoCard collection
    let playersWithCards = 0;
    if (gameObj._id && gameObj.players.length > 0) {
      try {
        // Count BingoCards for this game
        playersWithCards = await BingoCard.countDocuments({ 
          gameId: gameObj._id 
        });
      } catch (error) {
        console.error('❌ Error counting bingo cards:', error);
        playersWithCards = 0;
      }
    }
    
    gameObj.playersWithCards = playersWithCards;
    gameObj.canStart = gameObj.status === 'WAITING' && 
                      playersWithCards >= this.MIN_PLAYERS_TO_START;
    gameObj.playersNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - gameObj.activePlayers);
    gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
    
    gameObj.acceptsLateJoiners = gameObj.status === 'ACTIVE' && gameObj.currentPlayers < gameObj.maxPlayers;
    gameObj.numbersCalledCount = gameObj.numbersCalled?.length || 0;
  }

  // AUTO-START LOGIC - MODIFIED TO RESPECT 60-SECOND RESTART DELAY
  if (gameObj.status === 'WAITING') {
    const now = new Date();
    
    // Check if we have enough players with cards
    if (gameObj.playersWithCards >= this.MIN_PLAYERS_TO_START) {
      // Check if this game was recently finished (within last 60 seconds)
      const isRecentlyFinished = gameObj.endedAt && 
                               (now - new Date(gameObj.endedAt)) < 60000; // 60 seconds
      
      if (isRecentlyFinished) {
        // Calculate remaining restart cooldown
        const timeSinceEnded = now - new Date(gameObj.endedAt);
        const restartCooldownRemaining = 60000 - timeSinceEnded;
        
        gameObj.restartCooldownRemaining = restartCooldownRemaining;
        gameObj.hasRestartCooldown = true;
        gameObj.hasAutoStartTimer = false;
        gameObj.autoStartTimeRemaining = 0;
        
        console.log(`⏳ Game ${gameObj.code} in restart cooldown: ${Math.ceil(restartCooldownRemaining/1000)}s remaining`);
        
        // Schedule auto-start check after cooldown ends
        if (!this.alreadyScheduledForAutoStart.has(gameObj._id.toString())) {
          console.log(`⏰ Scheduling post-cooldown auto-start check for game ${gameObj.code} in ${restartCooldownRemaining}ms`);
          this.alreadyScheduledForAutoStart.set(gameObj._id.toString(), true);
          
          setTimeout(() => {
            this.alreadyScheduledForAutoStart.delete(gameObj._id.toString());
            console.log(`🔄 Cooldown ended for game ${gameObj.code}, checking auto-start conditions`);
            this.scheduleAutoStartCheck(gameObj._id);
          }, restartCooldownRemaining);
        }
      } else {
        // Game is not in cooldown - proceed with normal auto-start
        if (!gameObj.autoStartEndTime) {
          const autoStartEndTime = new Date(now.getTime() + 10000);
          gameObj.autoStartEndTime = autoStartEndTime;
          gameObj.autoStartTimeRemaining = 10000;
          gameObj.hasAutoStartTimer = true;
          gameObj.hasRestartCooldown = false;
          
          // Only schedule auto-start if we haven't already scheduled it
          const gameIdStr = gameObj._id.toString();
          if (!this.alreadyScheduledForAutoStart.has(gameIdStr)) {
            console.log(`⏰ Scheduling auto-start for game ${gameObj.code} in 10000ms`);
            this.alreadyScheduledForAutoStart.set(gameIdStr, true);
            this.scheduleAutoStart(gameObj._id, 10000);
          }
        } else if (gameObj.autoStartEndTime <= now) {
          // Auto-start time has passed - START THE GAME IMMEDIATELY
          console.log(`🚀 AUTO-START TIME PASSED - Starting game ${gameObj.code} immediately`);
          
          // Clear the scheduled flag
          const gameIdStr = gameObj._id.toString();
          this.alreadyScheduledForAutoStart.delete(gameIdStr);
          
          this.autoStartGame(gameObj._id);
        } else {
          gameObj.autoStartTimeRemaining = gameObj.autoStartEndTime - now;
          gameObj.hasAutoStartTimer = true;
          gameObj.hasRestartCooldown = false;
        }
      }
    } else {
      gameObj.autoStartTimeRemaining = 0;
      gameObj.hasAutoStartTimer = false;
      gameObj.hasRestartCooldown = false;
      
      // If we don't have enough players, clear any existing schedule
      const gameIdStr = gameObj._id.toString();
      this.alreadyScheduledForAutoStart.delete(gameIdStr);
    }
  } else {
    gameObj.autoStartTimeRemaining = 0;
    gameObj.hasAutoStartTimer = false;
    gameObj.hasRestartCooldown = false;
  }

  return gameObj;
}

  static scheduleAutoStart(gameId, delay = 10000) {
    this.clearAutoStartTimer(gameId);
    
    console.log(`⏰ Scheduling auto-start for game ${gameId} in ${delay}ms`);
    
    const timer = setTimeout(async () => {
      try {
        await this.autoStartGame(gameId);
      } catch (error) {
        console.error('❌ Auto-start timer failed:', error);
      }
    }, delay);
    
    this.autoStartTimers.set(gameId.toString(), {
      timer,
      scheduledAt: new Date(),
      endsAt: new Date(Date.now() + delay)
    });
  }

  static startAutoGameService() {
    if (!this.activeIntervals) {
      this.activeIntervals = new Map();
    }

    this.cleanupAllIntervals();

    const interval = setInterval(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Auto-game service error:', error);
      }
    }, 30000);

    console.log('🚀 Single Game Service Started - One game always available');
    
    setTimeout(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Initial game setup failed:', error);
      }
    }, 5000);

    return interval;
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
  try {
    console.log(`🔍 getUserBingoCard called with:`, { gameId, userId });
    
    let user;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId);
    } else {
      user = await User.findOne({ telegramId: userId });
    }
    
    if (!user) {
      console.log(`❌ User not found with ID: ${userId}`);
      return null;
    }
    
    const query = { gameId, userId: user._id };
    
    const bingoCard = await BingoCard.findOne(query)
      .populate('userId', 'username firstName telegramId');
    
    if (bingoCard) {
      console.log(`✅ Found bingo card for user ${userId} (MongoDB: ${user._id})`);
    } else {
      console.log(`❌ No bingo card found for user ${userId} (MongoDB: ${user._id})`);
    }
    
    return bingoCard;
  } catch (error) {
    console.error('❌ Error in getUserBingoCard:', error);
    throw error;
  }
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
  // Find user first
  let user;
  if (mongoose.Types.ObjectId.isValid(userId)) {
    user = await User.findById(userId);
  } else {
    user = await User.findOne({ telegramId: userId });
  }

  if (!user) {
    throw new Error('User not found');
  }

  const mongoUserId = user._id;
  
  const game = await Game.findById(gameId);
  if (!game) {
    throw new Error('Game not found');
  }

  await GamePlayer.deleteOne({ gameId, userId: mongoUserId });
  await BingoCard.deleteOne({ gameId, userId: mongoUserId });

  game.currentPlayers = Math.max(0, game.currentPlayers - 1);
  
  if (game.currentPlayers === 0) {
    game.status = 'CANCELLED';
    game.endedAt = new Date();
  }
  
  await game.save();
  return this.getGameWithDetails(game._id);
}

static async markNumber(gameId, userId, number) {
  // First find the user by Telegram ID or MongoDB ID
  let user;
  if (mongoose.Types.ObjectId.isValid(userId)) {
    user = await User.findById(userId);
  } else {
    user = await User.findOne({ telegramId: userId });
  }

  if (!user) {
    throw new Error('User not found');
  }

  const mongoUserId = user._id;
  
  // Now find the bingo card using the MongoDB _id
  const bingoCard = await BingoCard.findOne({ gameId, userId: mongoUserId });
  if (!bingoCard) {
    throw new Error('Bingo card not found');
  }

  const game = await Game.findById(gameId);
  if (!game) {
    throw new Error('Game not found');
  }

  // Validate number is in called numbers
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
  await bingoCard.save();

  console.log(`✅ User ${userId} (MongoDB: ${mongoUserId}) marked number ${number} on card`);

  return { 
    bingoCard, 
    isMarked: true,
    markedCount: bingoCard.markedPositions.length
  };
}
 static async checkForWin(gameId, userId) {
  // Find user first
  let user;
  if (mongoose.Types.ObjectId.isValid(userId)) {
    user = await User.findById(userId);
  } else {
    user = await User.findOne({ telegramId: userId });
  }

  if (!user) {
    throw new Error('User not found');
  }

  const mongoUserId = user._id;
  
  const bingoCard = await BingoCard.findOne({ gameId, userId: mongoUserId });
  if (!bingoCard) {
    throw new Error('Bingo card not found');
  }

  const game = await Game.findById(gameId);
  if (!game) {
    throw new Error('Game not found');
  }

  const numbers = bingoCard.numbers.flat();
  
  // Use only manually marked positions (no late joiner auto-marking)
  let effectiveMarkedPositions = bingoCard.markedPositions || [];
  
  // Always include FREE space (position 12)
  if (!effectiveMarkedPositions.includes(12)) {
    effectiveMarkedPositions.push(12);
  }

  const isWinner = GameUtils.checkWinCondition(numbers, effectiveMarkedPositions);
  
  if (isWinner && !bingoCard.isWinner) {
    bingoCard.isWinner = true;
    await bingoCard.save();

    if (game.status === 'ACTIVE') {
      game.status = 'FINISHED';
      game.winnerId = mongoUserId;
      game.endedAt = new Date();
      await game.save();

      const UserService = require('./userService');
      await UserService.updateUserStats(mongoUserId, true);
      
      console.log(`🎉 Manual win check: Winner found for user ${userId} (MongoDB: ${mongoUserId})`);
      
      this.stopAutoNumberCalling(gameId);
      setTimeout(() => {
        this.autoRestartGame(gameId);
      }, 30000);
    }
  }

  return {
    isWinner,
    bingoCard,
    winningPattern: isWinner ? GameUtils.getWinningPattern(effectiveMarkedPositions) : null
  };
}

 static async endGame(gameId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    this.stopAutoNumberCalling(gameId);

    const game = await Game.findById(gameId).session(session);
    
    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status === 'FINISHED' || game.status === 'CANCELLED') {
      throw new Error('Game already ended');
    }

    // NEW: If game is ending without a winner (cancelled), refund players
    if (!game.winnerId && game.status === 'ACTIVE') {
      console.log(`🔄 Game ${game.code} cancelled - refunding players`);
      await this.refundAllPlayers(gameId, session);
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

    setTimeout(() => {
      this.autoRestartGame(gameId);
    }, 60000);

    return this.getGameWithDetails(gameId);
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ End game error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

// NEW: Method to refund all players
static async refundAllPlayers(gameId, session) {
  try {
    const WalletService = require('./walletService');
    const entryFee = 10;
    
    const bingoCards = await BingoCard.find({ gameId }).session(session);
    
    console.log(`💰 Refunding ${bingoCards.length} players...`);
    
    for (const card of bingoCards) {
      try {
        const User = require('../models/User');
        const user = await User.findById(card.userId).session(session);
        
        if (user && user.telegramId) {
          // Refund the entry fee
          await WalletService.addWinning(
            user.telegramId,
            gameId,
            entryFee,
            `Refund for cancelled game`
          );
          console.log(`✅ Refunded $${entryFee} to ${user.telegramId}`);
        }
      } catch (error) {
        console.error(`❌ Failed to refund user ${card.userId}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error in refundAllPlayers:', error);
    throw error;
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

  static async getWinnerInfo(gameId) {
  try {
    const game = await Game.findById(gameId)
      .populate('winnerId', 'username firstName telegramId');
    
    if (!game || !game.winnerId) {
      return null;
    }

    // Get winner's bingo card
    let winningCard = null;
    let winningPattern = null;
    
    if (game.winnerId) {
      const bingoCard = await BingoCard.findOne({ 
        gameId, 
        userId: game.winnerId._id 
      });
      
      if (bingoCard) {
        winningCard = {
          cardNumber: bingoCard.cardNumber || bingoCard.cardIndex || 0,
          numbers: bingoCard.numbers || [],
          markedPositions: bingoCard.markedNumbers || bingoCard.markedPositions || [],
          winningPatternPositions: bingoCard.winningPatternPositions || []
        };
        
        // Determine winning pattern
        const winResult = this.checkEnhancedWinCondition(
          bingoCard.numbers.flat(), 
          bingoCard.markedNumbers || bingoCard.markedPositions || []
        );
        winningPattern = winResult.patternType;
      }
    }

    return {
      winner: game.winnerId,
      gameCode: game.code,
      endedAt: game.endedAt,
      totalPlayers: game.currentPlayers,
      numbersCalled: game.numbersCalled?.length || 0,
      winningPattern: winningPattern,
      winningCard: winningCard
    };
  } catch (error) {
    console.error('Error getting winner info:', error);
    throw error;
  }
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
      console.log(`🎯 Auto-created game: ${gameCode} - Waiting for players and manual start`);
      
      return this.getGameWithDetails(game._id);
    } catch (error) {
      console.error('❌ Error creating auto game:', error);
      throw error;
    }
  }

static async autoRestartGame(gameId) {
  try {
    console.log(`🔄 Auto-restarting game ${gameId}...`);
    
    this.clearAutoStartTimer(gameId);
    
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'FINISHED') {
      console.log('❌ Game not found or not finished, cannot restart');
      return;
    }

    this.winnerDeclared.delete(gameId.toString());
    this.processingGames.delete(gameId.toString());

    game.status = 'WAITING';
    game.numbersCalled = [];
    game.winnerId = null;
    game.startedAt = null;
    // DON'T clear endedAt - we need it to calculate restart cooldown
    // game.endedAt = null; // REMOVE THIS LINE
    game.autoStartEndTime = null;
    
    await game.save();
    
    await BingoCard.deleteMany({ gameId });
    
    console.log(`✅ Game ${game.code} restarted - waiting for players to select cards (60s cooldown before auto-start)`);
    
  } catch (error) {
    console.error('❌ Auto-restart error:', error);
  }
}

  static async getTakenCards(gameId) {
    try {
      const bingoCards = await BingoCard.find({ gameId });
      const dbTakenCards = bingoCards.map(card => ({
        cardNumber: card.cardNumber,
        userId: card.userId
      }));
      
      const realTimeTakenCards = this.getRealTimeTakenCards(gameId);
      
      const userCardMap = new Map();
      
      for (const card of dbTakenCards) {
        if (card.cardNumber && card.userId) {
          userCardMap.set(card.userId.toString(), card);
        }
      }
      
      for (const card of realTimeTakenCards) {
        if (card.cardNumber && card.userId) {
          userCardMap.set(card.userId.toString(), card);
        }
      }
      
      const finalTakenCards = Array.from(userCardMap.values());
      
      console.log(`📊 Taken cards: ${finalTakenCards.length} unique cards (Users: ${userCardMap.size})`);
      
      return finalTakenCards;
    } catch (error) {
      console.error('❌ Get taken cards error:', error);
      return [];
    }
  }

  static async checkAndAutoStartGame(gameId) {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'WAITING') {
        return { started: false, reason: 'Game not in waiting state' };
      }

      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      console.log(`🔍 Auto-start check: ${playersWithCards} players with cards for game ${game.code}`);
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`🚀 AUTO-STARTING game ${game.code} with ${playersWithCards} players`);
        await this.startGame(gameId);
        return { started: true, playersCount: playersWithCards };
      } else {
        console.log(`⏳ Not enough players with cards: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
        return { started: false, playersCount: playersWithCards, reason: 'Not enough players' };
      }
    } catch (error) {
      console.error('❌ Auto-start check error:', error);
      return { started: false, reason: error.message };
    }
  }
static async autoStartGame(gameId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const game = await Game.findById(gameId).session(session);
    if (!game || game.status !== 'WAITING') {
      this.clearAutoStartTimer(gameId);
      await session.abortTransaction();
      return;
    }

    const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`🚀 AUTO-STARTING game ${game.code} with ${playersWithCards} players`);
      
      // Get all players with cards and deduct entry fees
      const playerCards = await BingoCard.find({ gameId }).session(session);
      const WalletService = require('./walletService');
      const entryFee = 10;
      
      console.log(`💰 Deducting entry fees from ${playerCards.length} players...`);
      
      const failedDeductions = [];
      
      for (const card of playerCards) {
        try {
          const User = require('../models/User');
          const user = await User.findById(card.userId).session(session);
          
          if (user && user.telegramId) {
            await WalletService.deductGameEntry(
              user.telegramId, 
              gameId, 
              entryFee, 
              `Entry fee for game ${game.code}`
            );
            console.log(`✅ Deducted $${entryFee} from ${user.telegramId}`);
          } else {
            console.warn(`⚠️ Could not deduct from user ${card.userId} - user not found`);
            failedDeductions.push(card.userId);
          }
        } catch (error) {
          console.error(`❌ Failed to deduct from user ${card.userId}:`, error.message);
          failedDeductions.push(card.userId);
        }
      }
      
      // Only proceed if we have enough players who paid
      const successfulPayments = playerCards.length - failedDeductions.length;
      
      if (successfulPayments < this.MIN_PLAYERS_TO_START) {
        console.log(`❌ Auto-start cancelled - only ${successfulPayments} players could pay (need ${this.MIN_PLAYERS_TO_START})`);
        
        // Refund any successful payments if not enough players
        for (const card of playerCards) {
          try {
            if (!failedDeductions.includes(card.userId.toString())) {
              const User = require('../models/User');
              const user = await User.findById(card.userId).session(session);
              
              if (user && user.telegramId) {
                await WalletService.addWinning(
                  user.telegramId,
                  gameId,
                  entryFee,
                  `Refund - insufficient players`
                );
                console.log(`💰 Refunded $${entryFee} to ${user.telegramId}`);
              }
            }
          } catch (refundError) {
            console.error(`❌ Failed to refund user ${card.userId}:`, refundError.message);
          }
        }
        
        await session.abortTransaction();
        this.clearAutoStartTimer(gameId);
        
        // Clear scheduled flag so we can try again
        const gameIdStr = gameId.toString();
        this.alreadyScheduledForAutoStart.delete(gameIdStr);
        
        return;
      }
      
      // Update game status
      game.status = 'ACTIVE';
      game.startedAt = new Date();
      game.autoStartEndTime = null;
      await game.save();
      
      await session.commitTransaction();
      console.log(`✅ Game ${game.code} auto-started with ${successfulPayments} paid players`);
      
      this.clearAutoStartTimer(gameId);
      this.startAutoNumberCalling(gameId);
      
    } else {
      console.log(`❌ Auto-start cancelled - only ${playersWithCards} players with cards (need ${this.MIN_PLAYERS_TO_START})`);
      
      await session.abortTransaction();
      this.clearAutoStartTimer(gameId);
      
      // Schedule check again
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Auto-start game error:', error);
    this.clearAutoStartTimer(gameId);
  } finally {
    session.endSession();
  }
}
  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Conditions met for auto-start: ${playersWithCards} players with cards`);
      this.scheduleAutoStart(gameId, 3000);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START} with cards`);
      
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 3000);
    }
  }

 static clearAutoStartTimer(gameId) {
  const gameIdStr = gameId.toString();
  
  // Clear from timer map
  if (this.autoStartTimers.has(gameIdStr)) {
    const timerInfo = this.autoStartTimers.get(gameIdStr);
    clearTimeout(timerInfo.timer);
    this.autoStartTimers.delete(gameIdStr);
    console.log(`🛑 Cleared auto-start timer for game ${gameId}`);
  }
  
  // Also clear from scheduled flag map
  if (this.alreadyScheduledForAutoStart.has(gameIdStr)) {
    this.alreadyScheduledForAutoStart.delete(gameIdStr);
    console.log(`🛑 Cleared scheduled flag for game ${gameId}`);
  }
}

//claim bingo

static async claimBingo(gameId, userId, patternType = 'BINGO') {
  const session = await mongoose.startSession();
  let transactionInProgress = false;

  try {
    console.log(`🏆 BINGO CLAIM attempt by user ${userId} for game ${gameId}`);
    
    if (this.winnerDeclared.has(gameId.toString())) {
      throw new Error('Winner already declared for this game');
    }

    const game = await Game.findById(gameId).session(session);
    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    // Find user's bingo card
    let user;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId).session(session);
    } else {
      user = await User.findOne({ telegramId: userId }).session(session);
    }

    if (!user) {
      throw new Error('User not found');
    }

    const mongoUserId = user._id;
    const bingoCard = await BingoCard.findOne({ 
      gameId, 
      userId: mongoUserId 
    }).session(session);

    if (!bingoCard) {
      throw new Error('No bingo card found for this user');
    }

    // Verify the claim
    const numbers = bingoCard.numbers.flat();
    let effectiveMarkedPositions = [...bingoCard.markedPositions];
    
    // Account for late joiners
    if (bingoCard.isLateJoiner) {
      const numbersCalledAtJoin = bingoCard.numbersCalledAtJoin || [];
      const allCalledNumbers = game.numbersCalled || [];
      
      for (let i = 0; i < numbers.length; i++) {
        const cardNumber = numbers[i];
        if (allCalledNumbers.includes(cardNumber) && !effectiveMarkedPositions.includes(i)) {
          effectiveMarkedPositions.push(i);
        }
      }
    }

    effectiveMarkedPositions = [...new Set([...effectiveMarkedPositions, 12])];
    
    const winResult = this.checkEnhancedWinCondition(numbers, effectiveMarkedPositions);
    
    if (!winResult.isWinner) {
      throw new Error('Invalid claim - no winning pattern found on your card');
    }

    console.log(`✅ VALID BINGO CLAIM by user ${userId} with ${winResult.patternType} pattern`);
    
    // Save winning pattern positions to the card
    bingoCard.winningPatternPositions = winResult.winningPositions;
    bingoCard.winningPatternType = winResult.patternType;
    await bingoCard.save({ session });
    
    // Start transaction
    session.startTransaction();
    transactionInProgress = true;
    
    // Declare this user as winner
    await this.declareWinnerWithRetry(gameId, mongoUserId, bingoCard, winResult.winningPositions);
    
    await session.commitTransaction();
    transactionInProgress = false;
    
    return {
      success: true,
      message: 'Bingo claim successful! You are the winner!',
      patternType: winResult.patternType,
      winningPositions: winResult.winningPositions,
      prizeAmount: await this.calculatePrize(gameId)
    };
    
  } catch (error) {
    // Only abort transaction if it's in progress
    if (transactionInProgress && session.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch (abortError) {
        console.warn('⚠️ Error aborting transaction:', abortError.message);
      }
    }
    console.error('❌ Bingo claim error:', error);
    throw error;
  } finally {
    // Always end the session
    session.endSession();
  }
}
static async calculatePrize(gameId) {
  const game = await Game.findById(gameId);
  if (!game) return 0;
  
  const totalPlayers = game.currentPlayers;
  const entryFee = 10;
  const totalPot = totalPlayers * entryFee;
  const platformFee = totalPot * 0.1;
  const winnerPrize = totalPot - platformFee;
  
  return winnerPrize;
}
//claim

}

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