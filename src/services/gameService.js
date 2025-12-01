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

      const finishedGames = await Game.find({
        status: 'FINISHED',
        endedAt: { $lt: new Date(Date.now() - 10000) }
      });

      for (const game of finishedGames) {
        console.log(`🔄 Auto-restarting finished game ${game.code}`);
        
        this.stopAutoNumberCalling(game._id);
        this.winnerDeclared.delete(game._id.toString());
        this.processingGames.delete(game._id.toString());
        
        game.status = 'WAITING';
        game.numbersCalled = [];
        game.winnerId = null;
        game.startedAt = null;
        game.endedAt = null;
        game.currentPlayers = 0;
        
        await game.save();
        
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

      setTimeout(async () => {
        await this.checkForWinners(gameId, newNumber);
      }, 100);

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
    if (this.processingGames.has(gameId.toString())) {
      console.log(`⏳ Win check already in progress for game ${gameId}, skipping...`);
      return;
    }

    this.processingGames.add(gameId.toString());

    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'ACTIVE') {
        return;
      }

      if (this.winnerDeclared.has(gameId.toString())) {
        console.log(`✅ Winner already declared for game ${game.code}, skipping check`);
        return;
      }

      const bingoCards = await BingoCard.find({ gameId });
      let winnerFound = false;
      
      console.log(`\n🔍 ENHANCED WIN CHECK for game ${game.code}`);
      console.log(`📊 Total cards: ${bingoCards.length}, Numbers called: ${game.numbersCalled?.length || 0}`);
      
      const potentialWinners = [];

      for (const card of bingoCards) {
        const numbers = card.numbers.flat();
        
        let effectiveMarkedPositions = [...card.markedPositions];
        
        const allCalledNumbers = game.numbersCalled || [];
        for (let i = 0; i < numbers.length; i++) {
          const cardNumber = numbers[i];
          if (allCalledNumbers.includes(cardNumber) && !effectiveMarkedPositions.includes(i)) {
            effectiveMarkedPositions.push(i);
          }
        }

        effectiveMarkedPositions = [...new Set([...effectiveMarkedPositions, 12])];
        
        console.log(`🎯 Player ${card.userId}: ${effectiveMarkedPositions.length} effective marked positions`);

        const winResult = this.checkEnhancedWinCondition(numbers, effectiveMarkedPositions);
        
        if (winResult.isWinner && !card.isWinner) {
          console.log(`🎉🎉🎉 WINNER DETECTED for user ${card.userId}! 🎉🎉🎉`);
          console.log(`🏆 Winning pattern: ${winResult.patternType}`);
          
          potentialWinners.push({
            userId: card.userId,
            card: card,
            patternType: winResult.patternType,
            winningPositions: winResult.winningPositions,
            markedCount: effectiveMarkedPositions.length
          });
        }
      }

      if (potentialWinners.length > 0) {
        const winner = potentialWinners[0];
        const winningUserId = winner.userId;
        
        console.log(`🏁 DECLARING WINNER: ${winningUserId} with ${winner.patternType} pattern`);
        
        await this.declareWinnerWithRetry(gameId, winningUserId, winner.card, winner.winningPositions);
        winnerFound = true;
      }

      if (!winnerFound) {
        console.log(`❌ No winners found in game ${game.code}`);
        
        if (game.numbersCalled.length >= 75) {
          console.log(`🎯 All 75 numbers called for game ${game.code}, ending game`);
          await this.endGameDueToNoWinner(gameId);
        }
      }

    } catch (error) {
      console.error('❌ Enhanced check winners error:', error);
    } finally {
      this.processingGames.delete(gameId.toString());
    }
  }

  static async declareWinnerWithRetry(gameId, winningUserId, winningCard, winningPositions) {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      const session = await mongoose.startSession();
      
      try {
        session.startTransaction();
        
        console.log(`🔄 Attempt ${retryCount + 1} to declare winner for game ${gameId}`);

        const game = await Game.findById(gameId).session(session);
        const card = await BingoCard.findById(winningCard._id).session(session);

        if (!game || game.status !== 'ACTIVE') {
          console.log('❌ Game no longer active, aborting winner declaration');
          await session.abortTransaction();
          return;
        }

        if (this.winnerDeclared.has(gameId.toString())) {
          console.log('✅ Winner already declared, aborting');
          await session.abortTransaction();
          return;
        }

        card.isWinner = true;
        card.markedPositions = [...new Set([...card.markedPositions, ...winningPositions])];
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
        }, 30000);

        return;

      } catch (error) {
        await session.abortTransaction();
        
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

    const effectiveMarked = [...new Set([...markedPositions, 12])];
    
    console.log(`🔍 Enhanced win check: ${effectiveMarked.length} marked positions`);

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

      await WalletService.deductGameEntry(userId, null, entryFee, `Entry fee for game ${gameCode}`);

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

      game.status = 'ACTIVE';
      game.startedAt = new Date();
      game.autoStartEndTime = null;
      await game.save();

      await session.commitTransaction();

      console.log(`🚀 Game ${game.code} started with ${playersWithCards} player(s) with selected cards`);

      this.clearAutoStartTimer(gameId);
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

  static formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    
    if (gameObj.hostId) {
      delete gameObj.hostId;
    }
    
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
      
      const playersWithCards = gameObj.players.filter(player => {
        return true;
      }).length;
      
      gameObj.playersWithCards = playersWithCards;
      gameObj.canStart = gameObj.status === 'WAITING' && 
                        gameObj.activePlayers >= this.MIN_PLAYERS_TO_START && 
                        playersWithCards >= this.MIN_PLAYERS_TO_START;
      gameObj.playersNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - gameObj.activePlayers);
      gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
      
      gameObj.acceptsLateJoiners = gameObj.status === 'ACTIVE' && gameObj.currentPlayers < gameObj.maxPlayers;
      gameObj.numbersCalledCount = gameObj.numbersCalled?.length || 0;
    }

    if (gameObj.status === 'WAITING') {
      const now = new Date();
      const playersWithCards = gameObj.players?.filter(p => p.hasCard)?.length || 0;
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        if (!gameObj.autoStartEndTime) {
          const autoStartEndTime = new Date(now.getTime() + 10000);
          gameObj.autoStartEndTime = autoStartEndTime;
          gameObj.autoStartTimeRemaining = 10000;
          gameObj.hasAutoStartTimer = true;
          
          this.scheduleAutoStart(gameId, 10000);
        } else {
          gameObj.autoStartTimeRemaining = gameObj.autoStartEndTime - now;
          gameObj.hasAutoStartTimer = true;
        }
      } else {
        gameObj.autoStartTimeRemaining = 0;
        gameObj.hasAutoStartTimer = false;
      }
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
      
      let query = {};
      
      if (mongoose.Types.ObjectId.isValid(userId)) {
        query = { gameId, userId: new mongoose.Types.ObjectId(userId) };
      } else {
        const User = require('../models/User');
        const user = await User.findOne({ telegramId: userId });
        
        if (!user) {
          console.log(`❌ User not found with Telegram ID: ${userId}`);
          return null;
        }
        
        console.log(`✅ Found user with Telegram ID ${userId}: MongoDB _id = ${user._id}`);
        query = { gameId, userId: user._id };
      }
      
      const bingoCard = await BingoCard.findOne(query)
        .populate('userId', 'username firstName telegramId');
      
      if (bingoCard) {
        console.log(`✅ Found bingo card for user ${userId}`);
      } else {
        console.log(`❌ No bingo card found for user ${userId}`);
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

  static async markNumber(gameId, userId, number) {
    const bingoCard = await BingoCard.findOne({ gameId, userId });
    if (!bingoCard) {
      throw new Error('Bingo card not found');
    }

    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    if (bingoCard.isLateJoiner && number !== 'FREE') {
      const numbersCalledAtJoin = bingoCard.numbersCalledAtJoin || [];
      const allCalledNumbers = game.numbersCalled || [];
      
      if (!allCalledNumbers.includes(number)) {
        throw new Error('This number has not been called yet in the game');
      }
    } else {
      const calledNumbers = game.numbersCalled || [];
      if (!calledNumbers.includes(number) && number !== 'FREE') {
        throw new Error('This number has not been called yet');
      }
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
    
    const player = await GamePlayer.findOne({ gameId, userId });
    const isSpectator = player?.playerType === 'SPECTATOR';
    
    let isWinner = false;
    if (!isSpectator) {
      let effectiveMarkedPositions = [...bingoCard.markedPositions];
      
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
      
      isWinner = GameUtils.checkWinCondition(numbers, effectiveMarkedPositions);
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
      
      console.log(`🎉 Manual win declared for user ${userId}`);
      
      this.stopAutoNumberCalling(gameId);
      setTimeout(() => {
        this.autoRestartGame(gameId);
      }, 30000);
    }

    return { bingoCard, isWinner, isSpectator };
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
    
    let effectiveMarkedPositions = [...bingoCard.markedPositions];
    
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

    const isWinner = GameUtils.checkWinCondition(numbers, effectiveMarkedPositions);
    
    if (isWinner && !bingoCard.isWinner) {
      bingoCard.isWinner = true;
      bingoCard.markedPositions = effectiveMarkedPositions;
      await bingoCard.save();

      if (game.status === 'ACTIVE') {
        game.status = 'FINISHED';
        game.winnerId = userId;
        game.endedAt = new Date();
        await game.save();

        const UserService = require('./userService');
        await UserService.updateUserStats(userId, true);
        
        console.log(`🎉 Manual win check: Winner found for user ${userId}`);
        
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
      }, 30000);

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
      game.endedAt = null;
      game.autoStartEndTime = null;
      
      await game.save();
      
      await BingoCard.deleteMany({ gameId });
      
      console.log(`✅ Game ${game.code} restarted - waiting for players to select cards`);
      
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
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'WAITING') {
        this.clearAutoStartTimer(gameId);
        return;
      }

      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`🚀 AUTO-STARTING game ${game.code} with ${playersWithCards} players`);
        await this.startGame(gameId);
      } else {
        console.log(`❌ Auto-start cancelled - only ${playersWithCards} players with cards (need ${this.MIN_PLAYERS_TO_START})`);
        
        setTimeout(() => {
          this.scheduleAutoStartCheck(gameId);
        }, 5000);
      }
      
      this.clearAutoStartTimer(gameId);
    } catch (error) {
      console.error('❌ Auto-start game error:', error);
      this.clearAutoStartTimer(gameId);
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
    if (this.autoStartTimers.has(gameIdStr)) {
      const timerInfo = this.autoStartTimers.get(gameIdStr);
      clearTimeout(timerInfo.timer);
      this.autoStartTimers.delete(gameIdStr);
      console.log(`🛑 Cleared auto-start timer for game ${gameId}`);
    }
  }
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