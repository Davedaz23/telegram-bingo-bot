  // services/gameService.js - FIXED VERSION (DUPLICATES REMOVED)
  const mongoose = require('mongoose');
  const Game = require('../models/Game');
  const User = require('../models/User');
  const GamePlayer = require('../models/GamePlayer');
  const BingoCard = require('../models/BingoCard');
  const Reconciliation = require('../models/Reconciliation'); // ADD THIS LINE

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

  static NEXT_GAME_COUNTDOWN = 30000; // ADD THIS: 30 seconds countdown between games


    
    // Constants for timing (all in milliseconds)
    static AUTO_START_DELAY = 30000; // 30 seconds for auto-start after conditions met
    static GAME_RESTART_COOLDOWN = 60000; // 60 seconds between games
static NUMBER_CALL_INTERVAL = 8000; // 8 seconds between calls
    // SINGLE GAME MANAGEMENT SYSTEM
 static async getMainGame() {
    try {
      // First, check if there's an active game
      let game = await Game.findOne({ 
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE', 'COOLDOWN','NO_WINNER'] },
        archived: { $ne: true }
      })
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });
      
      // If no active game, create a new one
      if (!game) {
        console.log('🎮 No active games found. Creating new game...');
        game = await this.createNewGame();
      } else if (game.status === 'ACTIVE' && !this.activeIntervals.has(game._id.toString())) {
        console.log(`🔄 Restarting auto-calling for active game ${game.code}`);
        this.startAutoNumberCalling(game._id);
      }
      
      // Manage game lifecycle transitions
      await this.manageGameLifecycle();
      
      return this.formatGameForFrontend(game);
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    }
  }
  

  static async manageGameLifecycle() {
    try {
      // Check for games that need state transitions
       const now = new Date();
    
    // 1. Check CARD_SELECTION → ACTIVE transition
    const cardSelectionGames = await Game.find({
      status: 'CARD_SELECTION',
      cardSelectionEndTime: { $lte: now }
    });
      
       for (const game of cardSelectionGames) {
      console.log(`⏰ Card selection period ended for game ${game.code} at ${game.cardSelectionEndTime}`);
      
      // Check players with cards
      const playersWithCards = await BingoCard.countDocuments({ gameId: game._id });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`✅ Starting game ${game.code} with ${playersWithCards} players`);
        await this.startGame(game._id);
      } else {
        console.log(`❌ Not enough players for game ${game.code}: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
        // Put back to waiting
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
        game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
        await game.save();
      }
    }
      
      // 2. Check COOLDOWN → WAITING_FOR_PLAYERS transition
      const cooldownGames = await Game.find({
        status: 'COOLDOWN',
        cooldownEndTime: { $lte: now }
      });
      
      for (const game of cooldownGames) {
        console.log(`🔄 Cooldown ended for game ${game.code}, resetting to waiting...`);
        await this.resetGameForNewSession(game._id);
      }
      
      // 3. Check WAITING_FOR_PLAYERS → CARD_SELECTION transition (when enough players)
      const waitingGames = await Game.find({
        status: 'WAITING_FOR_PLAYERS',
        autoStartEndTime: { $lte: now }
      });
      
      for (const game of waitingGames) {
        const playersWithCards = await BingoCard.countDocuments({ gameId: game._id });
        if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
          console.log(`🎯 Enough players with cards for game ${game.code}, starting card selection...`);
          await this.beginCardSelection(game._id);
        }
      }
      
    } catch (error) {
      console.error('❌ Error managing game lifecycle:', error);
    }
  }
  
  static async createNewGame() {
    try {
      const gameCode = GameUtils.generateGameCode();
      const now = new Date();
      
      const game = new Game({
        code: gameCode,
        maxPlayers: 10,
        isPrivate: false,
        numbersCalled: [],
        status: 'WAITING_FOR_PLAYERS',
        currentPlayers: 0,
        isAutoCreated: true,
        autoStartEndTime: new Date(now.getTime() + this.AUTO_START_DELAY) // Set initial auto-start timer
      });

      await game.save();
      console.log(`🎯 Created new game: ${gameCode} - Waiting for players`);
      
      return this.getGameWithDetails(game._id);
    } catch (error) {
      console.error('❌ Error creating new game:', error);
      throw error;
    }
  }

static async beginCardSelection(gameId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const game = await Game.findById(gameId).session(session);
    
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') {
      throw new Error('Game not in waiting state');
    }

    const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
    
    if (playersWithCards < this.MIN_PLAYERS_TO_START) {
      throw new Error(`Not enough players with cards. Need ${this.MIN_PLAYERS_TO_START}, have ${playersWithCards}`);
    }

    const now = new Date();
    const cardSelectionEndTime = new Date(now.getTime() + this.CARD_SELECTION_DURATION);
    
    game.status = 'CARD_SELECTION';
    game.cardSelectionStartTime = now;
    game.cardSelectionEndTime = cardSelectionEndTime;
    game.autoStartEndTime = null;
    
    await game.save({ session });
    await session.commitTransaction();
    
    console.log(`🎲 Card selection started for game ${game.code}. Ends at: ${cardSelectionEndTime} (in ${this.CARD_SELECTION_DURATION/1000} seconds)`);
    
    // Schedule a check for when card selection ends
    setTimeout(async () => {
      try {
        await this.checkCardSelectionEnd(gameId);
      } catch (error) {
        console.error('❌ Failed to check card selection end:', error);
      }
    }, this.CARD_SELECTION_DURATION);
    
    return game;
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Error beginning card selection:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

// NEW: Check if card selection period has ended and start game
static async checkCardSelectionEnd(gameId) {
  try {
    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'CARD_SELECTION') {
      console.log(`⚠️ Game ${gameId} is not in CARD_SELECTION state`);
      return;
    }
    
    const now = new Date();
    
    // Check if card selection time has ended
    if (game.cardSelectionEndTime && game.cardSelectionEndTime <= now) {
      console.log(`⏰ Card selection period has ended for game ${game.code}`);
      
      // Check if we have enough players with cards
      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`✅ Enough players (${playersWithCards}) to start game ${game.code}`);
        await this.startGame(gameId);
      } else {
        console.log(`❌ Not enough players (${playersWithCards}/${this.MIN_PLAYERS_TO_START}) to start game ${game.code}`);
        
        // Fall back to waiting
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
        game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
        await game.save();
        
        console.log(`⏳ Game ${game.code} back to waiting state`);
      }
    } else {
      console.log(`⏳ Card selection still ongoing for game ${game.code}`);
    }
  } catch (error) {
    console.error('❌ Error checking card selection end:', error);
  }
}

   static async autoRestartFinishedGames() {
    try {
      if (!this.activeIntervals) {
        this.activeIntervals = new Map();
      }

      const finishedGames = await Game.find({
        status: 'FINISHED',
        endedAt: { $lt: new Date(Date.now() - 10000) } // 10 seconds
      });

      for (const game of finishedGames) {
        console.log(`🔄 Auto-setting countdown for finished game ${game.code}`);
        
        // Set 30 second countdown for games that are stuck in FINISHED state
        await this.setNextGameCountdown(game._id);
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
        const bingoCards = await BingoCard.find({ gameId }).session(session);
        
        if (!game || game.status !== 'ACTIVE') {
          console.log('❌ Game no longer active, aborting winner declaration');
          throw new Error('Game no longer active');
        }
        
        if (this.winnerDeclared.has(gameId.toString())) {
          console.log('✅ Winner already declared, aborting');
          throw new Error('Winner already declared');
        }
        
        // Get or create reconciliation
        let reconciliation = await Reconciliation.findOne({ gameId }).session(session);
        if (!reconciliation) {
          reconciliation = await this.createReconciliation(gameId);
        }
        
        // Set winner flag on card
        card.isWinner = true;
        card.winningPatternPositions = winningPositions;
        card.winningPatternType = winningCard.winningPatternType || 'BINGO';
        await card.save({ session });
        
        // Calculate winnings
        const totalPlayers = bingoCards.length;
        const entryFee = 10;
        const totalPot = totalPlayers * entryFee;
        const platformFee = totalPot * 0.1;
        const winnerPrize = totalPot - platformFee;
        
        // Update reconciliation
        reconciliation.status = 'WINNER_DECLARED';
        reconciliation.winnerId = winningUserId;
        reconciliation.winnerAmount = winnerPrize;
        reconciliation.platformFee = platformFee;
        
        // Add winning transaction
        const WalletService = require('./walletService');
        const winningResult = await WalletService.addWinning(
          winningUserId,
          gameId,
          winnerPrize,
          `Winner prize for game ${game.code}`
        );
        
        reconciliation.transactions.push({
          userId: winningUserId,
          type: 'WINNING',
          amount: winnerPrize,
          transactionId: winningResult.transaction._id,
          status: 'COMPLETED'
        });
        
        reconciliation.creditTotal += winnerPrize;
        
        // Add platform fee transaction (to system/admin account)
        reconciliation.transactions.push({
          userId: new mongoose.Types.ObjectId(), // System account ID
          type: 'PLATFORM_FEE',
          amount: platformFee,
          status: 'COMPLETED',
          metadata: { description: 'Platform fee' }
        });
        
        reconciliation.creditTotal += platformFee;
        
        // Update game
        const now = new Date();
        game.status = 'FINISHED';
        game.winnerId = winningUserId;
        game.endedAt = now;
        game.cooldownEndTime = null;
        game.winningAmount = winnerPrize;
        
        await game.save({ session });
        
        // Update reconciliation
        reconciliation.completedAt = now;
        reconciliation.addAudit('WINNER_DECLARED', {
          gameCode: game.code,
          winnerId: winningUserId,
          winnerPrize,
          platformFee,
          totalPot,
          totalPlayers
        });
        
        await reconciliation.save({ session });
        
        this.winnerDeclared.add(gameId.toString());
        
        const UserService = require('./userService');
        await UserService.updateUserStats(winningUserId, true);
        
        const losingPlayers = bingoCards.filter(c => c.userId.toString() !== winningUserId.toString());
        for (const losingCard of losingPlayers) {
          await UserService.updateUserStats(losingCard.userId, false);
        }
        
        await session.commitTransaction();
        transactionInProgress = false;
        
        console.log(`🎊 Game ${game.code} ENDED - Winner: ${winningUserId} won $${winnerPrize}`);
        
        this.stopAutoNumberCalling(gameId);
        
        // Create new game for next session
        await this.createNewGameForNextSession(gameId);
        
        return reconciliation;
      } catch (error) {
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
  static async setNextGameCountdown(gameId) {
  // Wait a moment to ensure all previous transactions are complete
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const game = await Game.findById(gameId).session(session);
    
    if (!game) {
      throw new Error('Game not found');
    }

    // Only proceed if game is in FINISHED state (not already reset)
    if (game.status !== 'FINISHED') {
      console.log(`⚠️ Game ${game.code} is not in FINISHED state (${game.status}), skipping countdown`);
      await session.abortTransaction();
      return;
    }

    const now = new Date();
    
    // Set game to COOLDOWN state with 30 second timer
    game.status = 'COOLDOWN';
    game.cooldownEndTime = new Date(now.getTime() + this.NEXT_GAME_COUNTDOWN);
    game.autoStartEndTime = new Date(now.getTime() + this.NEXT_GAME_COUNTDOWN);
    
    // Keep other game data for reference (don't clear winnerId if there is one)
    await game.save({ session });
    
    await session.commitTransaction();
    
    console.log(`⏰ Next game countdown set for game ${game.code}. Next game starts in 30 seconds at: ${game.cooldownEndTime}`);
    
    // Schedule automatic reset after countdown
    setTimeout(async () => {
      try {
        await this.resetGameForNewSession(gameId);
      } catch (error) {
        console.error('❌ Failed to reset game after countdown:', error);
      }
    }, this.NEXT_GAME_COUNTDOWN);
    
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('❌ Error setting next game countdown:', error);
  } finally {
    session.endSession();
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
    if (!game || game.status !== 'ACTIVE') {
      return;
    }

    // CRITICAL: Only end if ALL 75 numbers have been called
    if (game.numbersCalled.length < 75) {
      console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers called. Not ending yet.`);
      return;
    }

    console.log(`🏁 Ending game ${game.code} - no winner after ALL 75 numbers`);
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get all players with cards
      const bingoCards = await BingoCard.find({ gameId }).session(session);
      
      // Check if refunds have already been processed
      const reconciliation = await Reconciliation.findOne({ gameId }).session(session);
      
      if (reconciliation && reconciliation.status === 'NO_WINNER_REFUNDED') {
        console.log(`⚠️ Refunds already processed for game ${game.code}. Skipping.`);
        await session.abortTransaction();
        return;
      }

      // Refund all players
      console.log(`💰 Refunding ${bingoCards.length} players due to no winner...`);
      
      const entryFee = 10;
      const WalletService = require('./walletService');
      
      for (const card of bingoCards) {
        try {
          const user = await User.findById(card.userId).session(session);
          
          if (user && user.telegramId) {
            // Check if this player has already been refunded
            if (reconciliation) {
              const alreadyRefunded = reconciliation.transactions.some(tx => 
                tx.userId.toString() === card.userId.toString() && 
                tx.type === 'REFUND' && 
                tx.status === 'COMPLETED'
              );
              
              if (alreadyRefunded) {
                console.log(`⚠️ User ${user.telegramId} already refunded. Skipping.`);
                continue;
              }
            }
            
            // Refund the entry fee
            await WalletService.addWinning(
              user.telegramId,
              gameId,
              entryFee,
              `Refund - No winner in game ${game.code}`
            );
            
            console.log(`✅ Refunded $${entryFee} to ${user.telegramId}`);
          }
        } catch (error) {
          console.error(`❌ Failed to refund user ${card.userId}:`, error.message);
        }
      }

      // Update game status
      const now = new Date();
      game.status = 'NO_WINNER';
      game.endedAt = now;
      game.winnerId = null;
      game.cooldownEndTime = null;
      game.noWinner = true;
      game.refunded = true;
      
      await game.save({ session });
      
      // Update reconciliation
      let finalReconciliation = reconciliation;
      if (!finalReconciliation) {
        finalReconciliation = await this.createReconciliation(gameId);
      }
      
      finalReconciliation.status = 'NO_WINNER_REFUNDED';
      finalReconciliation.completedAt = now;
      finalReconciliation.addAudit('GAME_ENDED_NO_WINNER', {
        gameCode: game.code,
        totalPlayers: bingoCards.length,
        totalRefunded: bingoCards.length * entryFee,
        endedAt: now
      });
      
      await finalReconciliation.save({ session });
      
      await session.commitTransaction();
      
      console.log(`✅ All refunds processed for game ${game.code}`);
      
      this.winnerDeclared.add(gameId.toString());
      this.processingGames.delete(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // Set next game countdown
      await this.setNextGameCountdown(gameId);

    } catch (error) {
      console.error('❌ Error ending game due to no winner:', error);
      
      if (session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch (abortError) {
          console.warn('⚠️ Error aborting transaction:', abortError.message);
        }
      }
      
      throw error;
    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('❌ Error in endGameDueToNoWinner:', error);
    throw error;
  }
}

//Reconcilatio  Reconcilation

 static async createReconciliation(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const game = await Game.findById(gameId).session(session);
      const bingoCards = await BingoCard.find({ gameId }).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }
      
      const totalPlayers = bingoCards.length;
      const entryFee = 10;
      const totalPot = totalPlayers * entryFee;
      const platformFee = totalPot * 0.1;
      const winnerPrize = totalPot - platformFee;
      
      const reconciliation = new Reconciliation({
        gameId: game._id,
        status: 'PENDING',
        totalPot: totalPot,
        platformFee: platformFee,
        winnerAmount: winnerPrize,
        winnerId: null,
        debitTotal: totalPot,
        creditTotal: 0
      });
      
      // Add entry fee transactions
      for (const card of bingoCards) {
        reconciliation.transactions.push({
          userId: card.userId,
          type: 'ENTRY_FEE',
          amount: -entryFee,
          status: 'PENDING'
        });
      }
      
      reconciliation.addAudit('RECONCILIATION_CREATED', {
        gameCode: game.code,
        totalPlayers,
        entryFee,
        totalPot,
        platformFee,
        winnerPrize
      });
      
      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`💰 Reconciliation created for game ${game.code}: $${totalPot} pot from ${totalPlayers} players`);
      
      return reconciliation;
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error creating reconciliation:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
  // Add this method to check if refunds have already been processed
static async haveRefundsBeenProcessed(gameId) {
  try {
    const reconciliation = await Reconciliation.findOne({ gameId });
    if (!reconciliation) return false;
    
    // Check if status indicates refunds were processed
    if (reconciliation.status === 'NO_WINNER_REFUNDED') {
      return true;
    }
    
    // Check if any refund transactions exist
    const refundTransactions = reconciliation.transactions.filter(tx => 
      tx.type === 'REFUND' && tx.status === 'COMPLETED'
    );
    
    return refundTransactions.length > 0;
  } catch (error) {
    console.error('Error checking refunds:', error);
    return false;
  }
}
  
  // NEW: Process entry fees with reconciliation
static async processEntryFees(gameId) {
  try {
    const game = await Game.findById(gameId);
    const bingoCards = await BingoCard.find({ gameId });
    const WalletService = require('./walletService');
    
    const entryFee = 10;
    const deductionPromises = [];
    const successfulDeductions = [];
    
    // Deduct entry fees from all players WHO HAVEN'T PAID YET
    for (const card of bingoCards) {
      const user = await User.findById(card.userId);
      if (user && user.telegramId) {
        // Check if payment was already made for this game
        const existingPayment = await Transaction.findOne({
          userId: card.userId,
          gameId: gameId,
          type: 'GAME_ENTRY',
          status: 'COMPLETED'
        });
        
        if (existingPayment) {
          console.log(`✅ User ${user.telegramId} already paid for game ${game.code}`);
          successfulDeductions.push({
            userId: card.userId,
            transactionId: existingPayment._id,
            amount: entryFee,
            alreadyPaid: true
          });
          continue;
        }
        
        try {
          const result = await WalletService.deductGameEntry(
            user.telegramId,
            gameId,
            entryFee,
            `Entry fee for game ${game.code}`
          );
          
          successfulDeductions.push({
            userId: card.userId,
            transactionId: result.transaction._id,
            amount: entryFee,
            alreadyPaid: false
          });
          
          console.log(`✅ Deducted $${entryFee} from ${user.telegramId}`);
        } catch (error) {
          console.error(`❌ Failed to deduct from user ${user.telegramId}:`, error.message);
        }
      }
    }
    
    // Don't create reconciliation if model doesn't exist
    let reconciliation = null;
    try {
      if (Reconciliation) {
        reconciliation = await Reconciliation.findOne({ gameId });
        if (!reconciliation) {
          // Create simple reconciliation without transactions
          reconciliation = new Reconciliation({
            gameId: game._id,
            status: 'DEDUCTED',
            totalPot: successfulDeductions.length * entryFee,
            platformFee: 0,
            winnerAmount: 0,
            debitTotal: successfulDeductions.length * entryFee,
            creditTotal: 0
          });
          await reconciliation.save();
        }
      }
    } catch (error) {
      console.warn('⚠️ Reconciliation not available:', error.message);
    }
    
    return {
      reconciliation,
      successfulDeductions,
      totalPlayers: bingoCards.length,
      paidPlayers: successfulDeductions.length
    };
  } catch (error) {
    console.error('❌ Error processing entry fees:', error);
    throw error;
  }
}
  // NEW: Enhanced endGameDueToNoWinner with reconciliation
static async endGameDueToNoWinner(gameId) {
  try {
    const game = await Game.findById(gameId);
    
    // First, check if game is already ended
    if (!game || game.status !== 'ACTIVE') {
      console.log(`⚠️ Game ${game?.code} is not active (${game?.status}), skipping no-winner end`);
      return;
    }

    // CRITICAL: Only end if ALL 75 numbers have been called
    if (game.numbersCalled.length < 75) {
      console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers called. Not ending yet.`);
      return;
    }

    console.log(`🏁 Ending game ${game.code} - no winner after ALL 75 numbers`);
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Double-check game status within transaction
      const gameInSession = await Game.findById(gameId).session(session);
      if (!gameInSession || gameInSession.status !== 'ACTIVE') {
        console.log(`🔄 Game ${game?.code} already ended during transaction, skipping`);
        await session.abortTransaction();
        return;
      }

      // Get all players with cards
      const bingoCards = await BingoCard.find({ gameId }).session(session);
      
      // Check if refunds have already been processed
      const reconciliation = await Reconciliation.findOne({ gameId }).session(session);
      
      if (reconciliation && reconciliation.status === 'NO_WINNER_REFUNDED') {
        console.log(`⚠️ Refunds already processed for game ${game.code}. Skipping.`);
        await session.abortTransaction();
        return;
      }

      // Refund all players
      console.log(`💰 Refunding ${bingoCards.length} players due to no winner...`);
      
      const entryFee = 10;
      const WalletService = require('./walletService');
      
      for (const card of bingoCards) {
        try {
          const user = await User.findById(card.userId).session(session);
          
          if (user && user.telegramId) {
            // Check if this player has already been refunded
            if (reconciliation) {
              const alreadyRefunded = reconciliation.transactions.some(tx => 
                tx.userId.toString() === card.userId.toString() && 
                tx.type === 'REFUND' && 
                tx.status === 'COMPLETED'
              );
              
              if (alreadyRefunded) {
                console.log(`⚠️ User ${user.telegramId} already refunded. Skipping.`);
                continue;
              }
            }
            
            // Refund the entry fee
            await WalletService.addWinning(
              user.telegramId,
              gameId,
              entryFee,
              `Refund - No winner in game ${game.code}`
            );
            
            console.log(`✅ Refunded $${entryFee} to ${user.telegramId}`);
          }
        } catch (error) {
          console.error(`❌ Failed to refund user ${card.userId}:`, error.message);
        }
      }

      // Update game status - THIS IS CRITICAL
      const now = new Date();
      gameInSession.status = 'NO_WINNER';
      gameInSession.endedAt = now;
      gameInSession.winnerId = null;
      gameInSession.cooldownEndTime = null;
      gameInSession.noWinner = true;
      gameInSession.refunded = true;
      
      await gameInSession.save({ session });
      
      // Update reconciliation
      let finalReconciliation = reconciliation;
      if (!finalReconciliation) {
        finalReconciliation = await this.createReconciliation(gameId);
      }
      
      finalReconciliation.status = 'NO_WINNER_REFUNDED';
      finalReconciliation.completedAt = now;
      finalReconciliation.addAudit('GAME_ENDED_NO_WINNER', {
        gameCode: game.code,
        totalPlayers: bingoCards.length,
        totalRefunded: bingoCards.length * entryFee,
        endedAt: now
      });
      
      await finalReconciliation.save({ session });
      
      await session.commitTransaction();
      
      console.log(`✅ All refunds processed for game ${game.code}. Status changed to NO_WINNER`);
      
      this.winnerDeclared.add(gameId.toString());
      this.processingGames.delete(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // Set next game countdown
      await this.setNextGameCountdown(gameId);

    } catch (error) {
      console.error('❌ Error ending game due to no winner:', error);
      
      if (session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch (abortError) {
          console.warn('⚠️ Error aborting transaction:', abortError.message);
        }
      }
      
      throw error;
    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('❌ Error in endGameDueToNoWinner:', error);
    throw error;
  }
}
  
  // NEW: Create new game for next session (instead of reusing)
  static async createNewGameForNextSession(previousGameId) {
    try {
      console.log(`🔄 Creating new game after previous game ${previousGameId} ended`);
      
      // Archive the previous game if needed
      await this.archiveGame(previousGameId);
      
      // Create brand new game
      const newGame = await this.createNewGame();
      
      // Clean up old game intervals and data
      this.winnerDeclared.delete(previousGameId.toString());
      this.processingGames.delete(previousGameId.toString());
      this.selectedCards.delete(previousGameId.toString());
      
      console.log(`🎯 New game created: ${newGame.code} - Previous game archived`);
      
      return newGame;
    } catch (error) {
      console.error('❌ Error creating new game for next session:', error);
      throw error;
    }
  }
  
  // NEW: Archive completed game
  static async archiveGame(gameId) {
    try {
      const game = await Game.findById(gameId);
      if (!game) return;
      
      // Mark game as archived
      game.archived = true;
      game.archivedAt = new Date();
      
      // Add metadata for reconciliation reference
      if (game.status === 'NO_WINNER') {
        game.metadata = game.metadata || {};
        game.metadata.noWinnerRefunded = true;
        game.metadata.refundTimestamp = new Date();
      }
      
      await game.save();
      
      console.log(`📦 Game ${game.code} archived`);
      
      return game;
    } catch (error) {
      console.error('❌ Error archiving game:', error);
      throw error;
    }
  }
 // NEW: Get game reconciliation details
  static async getGameReconciliation(gameId) {
    try {
      const reconciliation = await Reconciliation.findOne({ gameId })
        .populate('winnerId', 'username firstName telegramId')
        .populate('transactions.userId', 'username firstName telegramId');
      
      if (!reconciliation) {
        return null;
      }
      
      // Calculate balance
      reconciliation.isBalanced();
      
      return reconciliation;
    } catch (error) {
      console.error('❌ Error getting game reconciliation:', error);
      throw error;
    }
  }
  
  // NEW: Reconcile all games (cron job)
  static async reconcileAllGames() {
    try {
      console.log('🧮 Starting game reconciliation process...');
      
      // Find games that need reconciliation
      const gamesToReconcile = await Game.find({
        status: { $in: ['FINISHED', 'NO_WINNER'] },
        reconciled: { $ne: true },
        endedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } // Ended at least 5 minutes ago
      });
      
      console.log(`📊 Found ${gamesToReconcile.length} games to reconcile`);
      
      const results = {
        total: gamesToReconcile.length,
        reconciled: 0,
        errors: 0,
        details: []
      };
      
      for (const game of gamesToReconcile) {
        try {
          let reconciliation = await Reconciliation.findOne({ gameId: game._id });
          
          if (!reconciliation) {
            // Create reconciliation if doesn't exist
            reconciliation = await this.createReconciliation(game._id);
          }
          
          // Verify reconciliation is complete
          if (reconciliation.status === 'COMPLETED' || reconciliation.status === 'NO_WINNER_REFUNDED') {
            game.reconciled = true;
            game.reconciliationId = reconciliation._id;
            game.reconciledAt = new Date();
            await game.save();
            
            results.reconciled++;
            results.details.push({
              gameId: game._id,
              gameCode: game.code,
              status: game.status,
              reconciliationId: reconciliation._id,
              action: 'RECONCILED'
            });
            
            console.log(`✅ Game ${game.code} reconciled`);
          } else {
            console.log(`⚠️ Game ${game.code} not fully reconciled: ${reconciliation.status}`);
          }
        } catch (error) {
          results.errors++;
          results.details.push({
            gameId: game._id,
            gameCode: game.code,
            error: error.message,
            action: 'FAILED'
          });
          
          console.error(`❌ Failed to reconcile game ${game.code}:`, error.message);
        }
      }
      
      console.log(`✅ Reconciliation complete: ${results.reconciled} reconciled, ${results.errors} errors`);
      
      return results;
    } catch (error) {
      console.error('❌ Error in reconcileAllGames:', error);
      throw error;
    }
  }
  
  // NEW: Get game financial summary
  static async getGameFinancialSummary(gameId) {
    try {
      const game = await Game.findById(gameId);
      const reconciliation = await this.getGameReconciliation(gameId);
      const bingoCards = await BingoCard.find({ gameId }).populate('userId');
      
      if (!game) {
        throw new Error('Game not found');
      }
      
      const players = [];
      for (const card of bingoCards) {
        const user = card.userId;
        players.push({
          userId: user._id,
          telegramId: user.telegramId,
          username: user.username,
          cardNumber: card.cardNumber,
          isWinner: card.isWinner,
          joinedAt: card.joinedAt
        });
      }
      
      const entryFee = 10;
      const totalPot = players.length * entryFee;
      const platformFee = totalPot * 0.1;
      const winnerPrize = totalPot - platformFee;
      
      return {
        game: {
          id: game._id,
          code: game.code,
          status: game.status,
          startedAt: game.startedAt,
          endedAt: game.endedAt,
          winnerId: game.winnerId,
          noWinner: game.noWinner || false,
          refunded: game.refunded || false
        },
        financials: {
          entryFee,
          totalPlayers: players.length,
          totalPot,
          platformFee,
          winnerPrize: game.winnerId ? winnerPrize : 0,
          refundedTotal: game.noWinner ? totalPot : 0
        },
        players,
        reconciliation: reconciliation ? {
          status: reconciliation.status,
          transactions: reconciliation.transactions.length,
          debitTotal: reconciliation.debitTotal,
          creditTotal: reconciliation.creditTotal,
          balance: reconciliation.balance,
          isBalanced: reconciliation.isBalanced()
        } : null
      };
    } catch (error) {
      console.error('❌ Error getting game financial summary:', error);
      throw error;
    }
  }
//Reconcilation
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

      // Check if game allows joining
      if (!game.canJoin || game.status === 'CARD_SELECTION') {
        throw new Error('Game is not accepting new players at this time. Please select a card to join.');
      }

      // Find user
      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ telegramId: userId }).session(session);
      }

      if (!user) {
        // Create user if doesn't exist
        user = await User.create([{
          telegramId: userId,
          firstName: `Player_${userId.slice(0, 8)}`,
          username: `player_${userId}`,
          role: 'user'
        }], { session });
        user = user[0];
      }

      const mongoUserId = user._id;

      // Check if already joined
      const existingPlayer = await GamePlayer.findOne({ 
        userId: mongoUserId, 
        gameId: game._id 
      }).session(session);
      
      if (existingPlayer) {
        await session.commitTransaction();
        return this.getGameWithDetails(game._id);
      }

      if (game.currentPlayers >= game.maxPlayers) {
        await session.abortTransaction();
        throw new Error('Game is full');
      }

      // Add player
      await GamePlayer.create([{
        userId: mongoUserId,
        gameId: game._id,
        isReady: true,
        playerType: 'PLAYER',
        joinedAt: new Date()
      }], { session });

      game.currentPlayers += 1;
      game.updatedAt = new Date();
      
      // If this is the first player or we reach minimum players, schedule auto-start
      if (game.currentPlayers >= this.MIN_PLAYERS_TO_START && game.status === 'WAITING_FOR_PLAYERS') {
        const autoStartTime = new Date(Date.now() + this.AUTO_START_DELAY);
        game.autoStartEndTime = autoStartTime;
        
        console.log(`⏰ Minimum players reached for game ${game.code}. Auto-start scheduled in ${this.AUTO_START_DELAY}ms`);
        
        // Schedule auto-start check
        this.scheduleAutoStartCheck(game._id);
      }
      
      await game.save({ session });
      await session.commitTransaction();

      console.log(`✅ User ${userId} joined game ${game.code}. Total players: ${game.currentPlayers}`);

      return this.getGameWithDetails(game._id);
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Join game error:', error);
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
  // CARD SELECTION METHODS - UPDATED VERSION
  static async selectCard(gameId, userId, cardNumbers, cardNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      // Only allow card selection in waiting or card selection phase
      if (game.status !== 'WAITING_FOR_PLAYERS' && game.status !== 'CARD_SELECTION') {
        throw new Error('Cannot select card - game is not accepting players'+game.id);
      }

      const existingCardWithNumber = await BingoCard.findOne({ 
        gameId, 
        cardNumber 
      }).session(session);
      
      if (existingCardWithNumber && existingCardWithNumber.userId.toString() !== userId.toString()) {
        throw new Error(`Card #${cardNumber} is already taken by another player`);
      }

      // Find or create user
      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ telegramId: userId }).session(session);
      }

      if (!user) {
        // Create user if doesn't exist
        user = await User.create([{
          telegramId: userId,
          firstName: `Player_${userId.slice(0, 8)}`,
          username: `player_${userId}`,
          role: 'user'
        }], { session });
        user = user[0];
      }

      const mongoUserId = user._id;

      // AUTO-JOIN: First, ensure user is added as a game player
      const existingPlayer = await GamePlayer.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (!existingPlayer) {
        // Add user as player
        await GamePlayer.create([{
          userId: mongoUserId,
          gameId: gameId,
          isReady: true,
          playerType: 'PLAYER',
          joinedAt: new Date()
        }], { session });
        
        // Update player count
        game.currentPlayers += 1;
        await game.save({ session });
        
        console.log(`✅ User ${userId} auto-joined game ${game.code} via card selection. Total players: ${game.currentPlayers}`);
      }

      // Check if user already has a card
      const existingCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
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
        
        return { 
          success: true, 
          message: 'Card updated successfully',
          action: 'UPDATED',
          cardId: existingCard._id,
          cardNumber: cardNumber,
          previousCardNumber: previousCardNumber,
          gameJoined: true
        };
      }

      // Validate card format
      if (!cardNumbers || !Array.isArray(cardNumbers) || cardNumbers.length !== 5) {
        throw new Error('Invalid card format');
      }

      for (let i = 0; i < 5; i++) {
        if (!Array.isArray(cardNumbers[i]) || cardNumbers[i].length !== 5) {
          throw new Error('Invalid card format');
        }
      }

      // Create new card
      const newCard = await BingoCard.create([{
        userId: mongoUserId,
        gameId,
        cardNumber: cardNumber,
        numbers: cardNumbers,
        markedPositions: [12],
        isLateJoiner: game.status === 'CARD_SELECTION' || game.status === 'ACTIVE',
        joinedAt: new Date(),
        numbersCalledAtJoin: game.status === 'CARD_SELECTION' || game.status === 'ACTIVE' ? (game.numbersCalled || []) : []
      }], { session });

      await session.commitTransaction();
      
      console.log(`✅ User ${user._id} (Telegram: ${user.telegramId}) CREATED new card #${cardNumber} for game ${game.code}`);
      
      this.updateCardSelection(gameId, cardNumber, mongoUserId, 'CREATED');
      
      // Check if we should schedule auto-start
      if (game.status === 'WAITING_FOR_PLAYERS' || game.status === 'CARD_SELECTION') {
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
        message: 'Card selected successfully',
        action: 'CREATED',
        cardId: newCard[0]._id,
        cardNumber: cardNumber,
        gameJoined: true
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
  console.log(`🚀 START GAME called for game ${gameId}`);
  
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const game = await Game.findById(gameId).session(session);
    
    if (!game) {
      console.log(`❌ Game ${gameId} not found`);
      await session.abortTransaction();
      return;
    }
    
    console.log(`📊 Game ${game.code} status before start: ${game.status}`);
    
    // Only allow starting from CARD_SELECTION or WAITING_FOR_PLAYERS
    if (game.status !== 'CARD_SELECTION' && game.status !== 'WAITING_FOR_PLAYERS') {
      console.log(`⚠️ Game ${gameId} not in correct state to start: ${game.status}`);
      await session.abortTransaction();
      return;
    }
    
    const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
    
    if (playersWithCards < this.MIN_PLAYERS_TO_START) {
      console.log(`❌ Not enough players to start game ${game.code}: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      // If we're in CARD_SELECTION, go back to WAITING
      if (game.status === 'CARD_SELECTION') {
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
      }
      
      const autoStartTime = new Date(Date.now() + this.AUTO_START_DELAY);
      game.autoStartEndTime = autoStartTime;
      await game.save({ session });
      
      await session.commitTransaction();
      
      console.log(`⏳ Rescheduling auto-start for game ${game.code} in ${this.AUTO_START_DELAY}ms`);
      
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, this.AUTO_START_DELAY);
      
      return;
    }

    
    // Process entry fees
    const feeResult = await this.processEntryFees(gameId);
    
    if (feeResult.successfulDeductions.length < this.MIN_PLAYERS_TO_START) {
      console.log(`❌ Not enough players paid entry fee: ${feeResult.successfulDeductions.length}/${this.MIN_PLAYERS_TO_START}`);
      
      // Refund any successful deductions
      await this.refundAllPlayers(gameId, session);
      
      game.status = 'WAITING_FOR_PLAYERS';
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
      const autoStartTime = new Date(Date.now() + this.AUTO_START_DELAY);
      game.autoStartEndTime = autoStartTime;
      await game.save({ session });
      
      await session.commitTransaction();
      
      console.log(`⏳ Not enough paid players, rescheduling game ${game.code}`);
      
      return;
    }
    
    // SUCCESS - Start the game!
    const now = new Date();
    game.status = 'ACTIVE';
    game.startedAt = now;
    game.cardSelectionStartTime = null;
    game.cardSelectionEndTime = null;
    game.autoStartEndTime = null;
    game.currentPlayers = feeResult.successfulDeductions.length;
    
    await game.save({ session });
    await session.commitTransaction();
    
    console.log(`🎮 Game ${game.code} started with ${game.currentPlayers} player(s).`);
    
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


  static async getGameParticipants(gameId) {
    try {
      // Get all players registered in the game
      const gamePlayers = await GamePlayer.find({ gameId })
        .populate('userId', 'username firstName telegramId');
      
      // Get all card holders (even if they're not in GamePlayer yet)
      const bingoCards = await BingoCard.find({ gameId })
        .populate('userId', 'username firstName telegramId');
      
      const participants = new Map();
      
      // Add registered players
      for (const player of gamePlayers) {
        if (player.userId) {
          participants.set(player.userId._id.toString(), {
            userId: player.userId._id,
            telegramId: player.userId.telegramId,
            username: player.userId.username,
            firstName: player.userId.firstName,
            hasCard: false,
            isRegisteredPlayer: true,
            joinedAt: player.joinedAt
          });
        }
      }
      
      // Add card holders (may not be registered players yet)
      for (const card of bingoCards) {
        if (card.userId) {
          const userIdStr = card.userId._id.toString();
          if (participants.has(userIdStr)) {
            // Update existing participant
            const participant = participants.get(userIdStr);
            participant.hasCard = true;
            participant.cardNumber = card.cardNumber;
          } else {
            // Add new participant with card
            participants.set(userIdStr, {
              userId: card.userId._id,
              telegramId: card.userId.telegramId,
              username: card.userId.username,
              firstName: card.userId.firstName,
              hasCard: true,
              cardNumber: card.cardNumber,
              isRegisteredPlayer: false,
              joinedAt: card.joinedAt
            });
          }
        }
      }
      
      return Array.from(participants.values());
    } catch (error) {
      console.error('❌ Error getting game participants:', error);
      return [];
    }
  }
 static async formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    const now = new Date();
    
    // Get reconciliation status if game is finished
    if (gameObj.status === 'FINISHED' || gameObj.status === 'NO_WINNER') {
      const reconciliation = await this.getGameReconciliation(game._id);
      gameObj.reconciliation = reconciliation ? {
        status: reconciliation.status,
        isBalanced: reconciliation.isBalanced(),
        totalPot: reconciliation.totalPot,
        winnerAmount: reconciliation.winnerAmount
      } : null;
    }
    
    // Add status-specific information
    switch (gameObj.status) {
      case 'WAITING_FOR_PLAYERS':
        gameObj.message = 'Waiting for players to join...';
        if (gameObj.autoStartEndTime && gameObj.autoStartEndTime > now) {
          gameObj.autoStartTimeRemaining = gameObj.autoStartEndTime - now;
          gameObj.hasAutoStartTimer = true;
        }
        break;
        
      case 'CARD_SELECTION':
        gameObj.message = 'Select your bingo card!';
        if (gameObj.cardSelectionEndTime && gameObj.cardSelectionEndTime > now) {
          gameObj.cardSelectionTimeRemaining = gameObj.cardSelectionEndTime - now;
        }
        break;
        
      case 'ACTIVE':
        gameObj.message = 'Game in progress - No new players can join!';
        break;
        
      case 'FINISHED':
        gameObj.message = gameObj.noWinner ? 'Game ended - No winner (All refunded)' : 'Game finished!';
        break;
        
      case 'NO_WINNER':
        gameObj.message = 'Game ended with no winner - All players refunded';
        break;
        
      case 'COOLDOWN':
        gameObj.message = 'Next game starting soon...';
        if (gameObj.cooldownEndTime && gameObj.cooldownEndTime > now) {
          gameObj.cooldownTimeRemaining = gameObj.cooldownEndTime - now;
        }
        break;
    }
    
    // Get actual participants with cards
    const participants = await this.getGameParticipants(gameObj._id);
    const playersWithCards = participants.filter(p => p.hasCard).length;
    
    gameObj.participants = participants;
    gameObj.playersWithCards = playersWithCards;
    gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
    
    // Can start if we have enough players with cards AND we're in the right phase
    gameObj.canStart = (gameObj.status === 'CARD_SELECTION' || 
                      gameObj.status === 'WAITING_FOR_PLAYERS') && 
                      playersWithCards >= this.MIN_PLAYERS_TO_START;
    
    // Can join only during waiting phase
    gameObj.canJoin = gameObj.status === 'WAITING_FOR_PLAYERS';
    
    // Can select card during waiting or card selection phases
    gameObj.canSelectCard = gameObj.status === 'WAITING_FOR_PLAYERS' || 
                          gameObj.status === 'CARD_SELECTION';
    
    return gameObj;
  }


    static async scheduleAutoStartCheck(gameId) {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
      
      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`✅ Conditions met for auto-start: ${playersWithCards} players with cards`);
        
        // Begin card selection phase
        await this.beginCardSelection(gameId);
      } else {
        console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START} with cards`);
        
        // Schedule another check
        setTimeout(() => {
          this.scheduleAutoStartCheck(gameId);
        }, 5000);
      }
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
    
    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    // Get all players with cards
    const bingoCards = await BingoCard.find({ gameId }).session(session);
    
    const now = new Date();
    const cooldownEndTime = new Date(now.getTime() + this.GAME_RESTART_COOLDOWN);
    
    game.status = 'COOLDOWN';
    game.endedAt = now;
    game.cooldownEndTime = cooldownEndTime;
    await game.save({ session });

    // REFUND ALL PLAYERS
    console.log(`💰 Refunding ${bingoCards.length} players due to game cancellation...`);
    
    const entryFee = 10;
    for (const card of bingoCards) {
      try {
        const user = await User.findById(card.userId).session(session);
        
        if (user && user.telegramId) {
          const WalletService = require('./walletService');
          await WalletService.addWinning(
            user.telegramId,
            gameId,
            entryFee,
            `Refund - Game ${game.code} cancelled`
          );
          console.log(`✅ Refunded $${entryFee} to ${user.telegramId}`);
        }
      } catch (error) {
        console.error(`❌ Failed to refund user:`, error.message);
      }
    }

    await session.commitTransaction();

    console.log(`🏁 Game ${game.code} ended. Cooldown until: ${cooldownEndTime}`);

    // Schedule game reset after cooldown
    setTimeout(async () => {
      try {
        await this.resetGameForNewSession(gameId);
      } catch (error) {
        console.error('❌ Failed to reset game after cooldown:', error);
      }
    }, this.GAME_RESTART_COOLDOWN);

    return this.getGameWithDetails(gameId);
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ End game error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

    
      static async resetGameForNewSession(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game || game.status !== 'COOLDOWN') {
        console.log('Game not in cooldown state, skipping reset');
        await session.abortTransaction();
        return;
      }

      const now = new Date();
      
      // Reset game for new session
      game.status = 'WAITING_FOR_PLAYERS';
      game.numbersCalled = [];
      game.winnerId = null;
      game.startedAt = null;
      game.endedAt = null;
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
      game.cooldownEndTime = null;
      // Set auto-start timer for 30 seconds from now
      game.autoStartEndTime = new Date(now.getTime() + this.AUTO_START_DELAY);
      game.currentPlayers = 0;
      
      await game.save({ session });
      
      // Clear player data
      await GamePlayer.deleteMany({ gameId }).session(session);
      await BingoCard.deleteMany({ gameId }).session(session);
      
      await session.commitTransaction();
      
      console.log(`🔄 Game ${game.code} reset for new session. Next auto-start in 30 seconds`);
      
      // Schedule auto-start check
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, this.AUTO_START_DELAY);
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error resetting game:', error);
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
          const user = await User.findById(card.userId).session(session);
          
          if (user && user.telegramId) {
            await WalletService.addWinning(
              user.telegramId,
              gameId,
              entryFee,
              `Refund - Game cancelled`
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
          winningPatternPositions: bingoCard.winningPatternPositions || [], // Make sure to include this
          winningPatternType: bingoCard.winningPatternType || null // Include pattern type
        };
      }
    }

    return {
      winner: game.winnerId,
      gameCode: game.code,
      endedAt: game.endedAt,
      totalPlayers: game.currentPlayers,
      numbersCalled: game.numbersCalled?.length || 0,
      winningPattern: winningCard?.winningPatternType,
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
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'WAITING_FOR_PLAYERS') {
        this.clearAutoStartTimer(gameId);
        return;
      }

      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`🎯 Auto-start conditions met for game ${game.code}: ${playersWithCards} players with cards`);
        
        // Begin card selection phase instead of starting directly
        await this.beginCardSelection(gameId);
      } else {
        console.log(`❌ Auto-start cancelled - only ${playersWithCards} players with cards (need ${this.MIN_PLAYERS_TO_START})`);
        
        // Schedule another check with longer delay
        setTimeout(() => {
          this.scheduleAutoStartCheck(gameId);
        }, 10000);
      }
      
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