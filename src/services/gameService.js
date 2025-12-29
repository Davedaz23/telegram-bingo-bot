// services/gameService.js - COMPLETE REWRITE
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const Reconciliation = require('../models/Reconciliation');
const Transaction = require('../models/Transaction');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // In-memory state management
  static activeIntervals = new Map();
  static winnerDeclared = new Set();
  static processingGames = new Set();
  static selectedCards = new Map();
  static autoStartTimers = new Map();
  static gameCreationLock = new Map();
  
  // Constants
  static MIN_PLAYERS_TO_START = 2;
  static CARD_SELECTION_DURATION = 30000;
  static AUTO_START_DELAY = 30000;
  static NUMBER_CALL_INTERVAL = 5000;
  static GAME_RESTART_COOLDOWN = 60000;
  static ENTRY_FEE = 10;
  
  // ==================== CORE GAME LIFECYCLE ====================

  static async getMainGame() {
    const lockKey = 'get_main_game';
    
    // Prevent concurrent calls
    if (this.processingGames.has(lockKey)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.getMainGame();
    }

    try {
      this.processingGames.add(lockKey);
      
      console.log('🎮 getMainGame() - Checking game state...');
      
      // STEP 1: Clean up any duplicate/conflicting games FIRST
      await this.cleanupDuplicateGames();
      
      // STEP 2: Get current game state
      const game = await this.getCurrentGameState();
      
      console.log(`✅ Main game: ${game.code} (Status: ${game.status})`);
      return this.formatGameForFrontend(game);
      
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    } finally {
      this.processingGames.delete(lockKey);
    }
  }

  static async getCurrentGameState() {
    // Always check for active game first
    let game = await this.findActiveGame();
    
    if (game) {
      console.log(`✅ Found active game: ${game.code}`);
      return game;
    }
    
    // Check for waiting or card selection games
    game = await this.findWaitingOrCardSelectionGame();
    
    if (game) {
      console.log(`✅ Found game in progress: ${game.code} (${game.status})`);
      return game;
    }
    
    // Check for cooldown games that need new game
    game = await this.findCooldownGameForRestart();
    
    if (game) {
      console.log(`🔄 Creating new game from cooldown: ${game.code}`);
      return await this.createNewGameAfterCooldown(game._id);
    }
    
    // No game exists - create brand new one
    console.log('🎮 Creating brand new game...');
    return await this.createNewGame();
  }

  static async findActiveGame() {
    const game = await Game.findOne({
      status: 'ACTIVE',
      archived: { $ne: true }
    }).sort({ createdAt: -1 });
    
    if (game) {
      // Check if game has all numbers but still active
      if (game.numbersCalled && game.numbersCalled.length >= 75) {
        console.log(`⚠️ Game ${game.code} has all 75 numbers. Ending...`);
        await this.endGameDueToNoWinner(game._id);
        
        // Re-fetch after ending
        const updatedGame = await Game.findById(game._id);
        if (updatedGame.status === 'ACTIVE') {
          return updatedGame;
        }
        return null;
      }
      
      // Ensure auto-calling is running
      if (!this.activeIntervals.has(game._id.toString())) {
        console.log(`🔄 Restarting auto-calling for ${game.code}`);
        this.startAutoNumberCalling(game._id);
      }
      
      return game;
    }
    
    return null;
  }

  static async findWaitingOrCardSelectionGame() {
    const game = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION'] },
      archived: { $ne: true }
    }).sort({ createdAt: -1 });
    
    if (game) {
      // Ensure only ONE game exists in these states
      await this.ensureSingleWaitingGame();
      return game;
    }
    
    return null;
  }

  static async findCooldownGameForRestart() {
    const game = await Game.findOne({
      status: { $in: ['FINISHED', 'NO_WINNER', 'COOLDOWN'] },
      cooldownEndTime: { $lte: new Date() },
      archived: { $ne: true }
    }).sort({ createdAt: -1 });
    
    return game;
  }

  // ==================== GAME CREATION & CLEANUP ====================

  static async createNewGame() {
    const lockKey = 'game_creation';
    
    if (this.gameCreationLock.has(lockKey)) {
      console.log('⏳ Game creation in progress, waiting...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.getCurrentGameState();
    }

    try {
      this.gameCreationLock.set(lockKey, true);
      
      // CRITICAL: Ensure no other games exist first
      await this.ensureNoActiveGames();
      
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
        autoStartEndTime: new Date(now.getTime() + this.AUTO_START_DELAY)
      });

      await game.save();
      console.log(`🎯 Created new game: ${gameCode}`);
      
      // Schedule auto-start check
      setTimeout(() => {
        this.scheduleAutoStartCheck(game._id);
      }, this.AUTO_START_DELAY);
      
      return game;
      
    } catch (error) {
      console.error('❌ Error creating new game:', error);
      throw error;
    } finally {
      this.gameCreationLock.delete(lockKey);
    }
  }

  static async createNewGameAfterCooldown(previousGameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Archive the old game
      const oldGame = await Game.findById(previousGameId).session(session);
      if (oldGame) {
        oldGame.archived = true;
        oldGame.archivedAt = new Date();
        await oldGame.save({ session });
        console.log(`📦 Archived game ${oldGame.code}`);
      }

      // Create new game
      const gameCode = GameUtils.generateGameCode();
      const now = new Date();
      
      const newGame = new Game({
        code: gameCode,
        maxPlayers: 10,
        isPrivate: false,
        numbersCalled: [],
        status: 'WAITING_FOR_PLAYERS',
        currentPlayers: 0,
        isAutoCreated: true,
        autoStartEndTime: new Date(now.getTime() + this.AUTO_START_DELAY),
        previousGameId: previousGameId
      });

      await newGame.save({ session });
      await session.commitTransaction();
      
      console.log(`🎯 Created new game from cooldown: ${gameCode}`);
      
      // Schedule auto-start check
      setTimeout(() => {
        this.scheduleAutoStartCheck(newGame._id);
      }, this.AUTO_START_DELAY);
      
      return newGame;
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error creating new game after cooldown:', error);
      
      // Fallback
      try {
        return await this.createNewGame();
      } catch (fallbackError) {
        console.error('❌ Fallback game creation failed:', fallbackError);
        throw fallbackError;
      }
    } finally {
      session.endSession();
    }
  }

  static async cleanupDuplicateGames() {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Find ALL active/waiting/card selection games
      const activeGames = await Game.find({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      }).session(session).sort({ createdAt: -1 });

      if (activeGames.length <= 1) {
        await session.abortTransaction();
        return false;
      }

      console.warn(`⚠️ Found ${activeGames.length} active games - cleaning duplicates`);
      
      // Keep only the newest game
      const newestGame = activeGames[0];
      console.log(`✅ Keeping newest game: ${newestGame.code}`);

      // Archive all older games
      for (let i = 1; i < activeGames.length; i++) {
        const oldGame = activeGames[i];
        console.log(`🗑️ Archiving duplicate: ${oldGame.code}`);
        
        oldGame.archived = true;
        oldGame.archivedAt = new Date();
        oldGame.archivedReason = 'Duplicate game detected during cleanup';
        await oldGame.save({ session });
      }

      await session.commitTransaction();
      console.log('✅ Duplicate games cleaned up');
      return true;
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error cleaning duplicate games:', error);
      return false;
    } finally {
      session.endSession();
    }
  }

  static async ensureSingleWaitingGame() {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const waitingGames = await Game.find({
        status: 'WAITING_FOR_PLAYERS',
        archived: { $ne: true }
      }).session(session).sort({ createdAt: -1 });

      if (waitingGames.length <= 1) {
        await session.abortTransaction();
        return;
      }

      console.warn(`⚠️ Found ${waitingGames.length} waiting games`);
      
      // Keep only the newest
      const newestGame = waitingGames[0];
      
      for (let i = 1; i < waitingGames.length; i++) {
        const oldGame = waitingGames[i];
        oldGame.archived = true;
        oldGame.archivedAt = new Date();
        await oldGame.save({ session });
      }

      await session.commitTransaction();
      console.log('✅ Ensured single waiting game');
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error ensuring single waiting game:', error);
    } finally {
      session.endSession();
    }
  }

  static async ensureNoActiveGames() {
    const activeGame = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true }
    });

    if (activeGame) {
      throw new Error(`Cannot create new game: Game ${activeGame.code} (${activeGame.status}) already exists`);
    }
  }

  // ==================== GAME START & CARD SELECTION ====================

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
      
      console.log(`🎲 Card selection started for game ${game.code}`);
      
      // Schedule end check
      setTimeout(async () => {
        await this.checkCardSelectionEnd(gameId);
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

  static async checkCardSelectionEnd(gameId) {
    try {
      const game = await Game.findById(gameId);
      
      if (!game || game.status !== 'CARD_SELECTION') {
        return;
      }
      
      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`✅ Starting game ${game.code} with ${playersWithCards} players`);
        await this.startGame(gameId);
      } else {
        console.log(`❌ Not enough players (${playersWithCards}/${this.MIN_PLAYERS_TO_START})`);
        
        // Go back to waiting
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
        game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
        await game.save();
        
        console.log(`⏳ Game ${game.code} back to waiting state`);
      }
    } catch (error) {
      console.error('❌ Error checking card selection end:', error);
    }
  }

 static async startGame(gameId) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const game = await Game.findById(gameId).session(session);
    
    if (!game) {
      throw new Error('Game not found');
    }
    
    console.log(`📊 Game ${game.code} status: ${game.status}`);
    
    // Only allow starting from correct states
    if (game.status !== 'CARD_SELECTION' && game.status !== 'WAITING_FOR_PLAYERS') {
      throw new Error(`Game ${game.code} not in correct state to start: ${game.status}`);
    }
    
    const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
    
    if (playersWithCards < this.MIN_PLAYERS_TO_START) {
      console.log(`❌ Not enough players to start: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      // Go back to waiting
      game.status = 'WAITING_FOR_PLAYERS';
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
      game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
      await game.save({ session });
      
      await session.commitTransaction();
      
      console.log(`⏳ Rescheduling auto-start for ${game.code}`);
      
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, this.AUTO_START_DELAY);
      
      return;
    }
    
    // Process entry fees (with duplicate prevention)
    const feeResult = await this.processEntryFees(gameId);
    
    if (feeResult.alreadyProcessed) {
      console.log(`⚠️ Entry fees already processed for ${game.code}`);
      await session.abortTransaction();
      return;
    }
    
    // SUCCESS - Start the game!
    const now = new Date();
    game.status = 'ACTIVE';
    game.startedAt = now;
    game.cardSelectionStartTime = null;
    game.cardSelectionEndTime = null;
    game.autoStartEndTime = null;
    game.currentPlayers = playersWithCards;
    
    await game.save({ session });
    await session.commitTransaction();
    
    console.log(`🎮 Game ${game.code} started with ${game.currentPlayers} player(s)`);
    
    // ✅ FIX: Add 5-second delay before starting auto-calling
    console.log(`⏱️ Game ${game.code} will start calling numbers in 5 seconds...`);
    setTimeout(() => {
      this.startAutoNumberCalling(gameId);
    }, 5000);
    
    return game;
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Start game error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

  // ==================== ENTRY FEE PROCESSING (DUPLICATE PREVENTION) ====================

  static async processEntryFees(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game) {
        throw new Error('Game not found');
      }

      // 1. Check if reconciliation already exists
      const existingReconciliation = await Reconciliation.findOne({ 
        gameId, 
        status: 'DEDUCTED'
      }).session(session);

      if (existingReconciliation) {
        console.log(`⚠️ Entry fees already processed for ${game.code}`);
        await session.abortTransaction();
        return { alreadyProcessed: true };
      }

      const bingoCards = await BingoCard.find({ gameId }).session(session);
      const WalletService = require('./walletService');
      
      const reconciliation = new Reconciliation({
        gameId: game._id,
        status: 'DEDUCTED',
        totalPot: 0,
        platformFee: 0,
        winnerAmount: 0,
        debitTotal: 0,
        creditTotal: 0
      });

      // 2. Group cards by unique user (telegramId)
      const userCardsMap = new Map();
      
      for (const card of bingoCards) {
        const user = await User.findById(card.userId).session(session);
        if (!user || !user.telegramId) continue;
        
        const telegramId = user.telegramId;
        
        if (!userCardsMap.has(telegramId)) {
          userCardsMap.set(telegramId, {
            userId: user._id,
            telegramId: telegramId,
            cards: [],
            totalAmount: 0
          });
        }
        
        const userData = userCardsMap.get(telegramId);
        userData.cards.push(card.cardNumber);
      }

      // 3. Process each UNIQUE user ONLY ONCE
      let successfullyCharged = 0;
      
      for (const [telegramId, userData] of userCardsMap.entries()) {
        // CRITICAL: Check if user already paid for THIS game
        const existingPayment = await Transaction.findOne({
          userId: userData.userId,
          gameId: gameId,
          type: 'GAME_ENTRY',
          status: 'COMPLETED'
        }).session(session);
        
        if (existingPayment) {
          console.log(`✅ User ${telegramId} already paid for ${game.code}`);
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: 0,
            status: 'ALREADY_PAID',
            transactionId: existingPayment._id,
            cardNumbers: userData.cards
          });
          continue;
        }
        
        // Check if user has sufficient balance
        const balance = await WalletService.getBalance(telegramId);
        
        if (balance < this.ENTRY_FEE) {
          console.log(`❌ User ${telegramId} insufficient balance: $${balance}`);
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: -this.ENTRY_FEE,
            status: 'FAILED_INSUFFICIENT_BALANCE',
            error: `Balance: $${balance}, Required: $${this.ENTRY_FEE}`,
            cardNumbers: userData.cards
          });
          continue;
        }
        
        // Process the single $10 entry fee
        try {
          const result = await WalletService.deductGameEntry(
            telegramId,
            gameId,
            this.ENTRY_FEE,
            `Entry fee for game ${game.code}`
          );
          
          successfullyCharged++;
          userData.totalAmount += this.ENTRY_FEE;
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: -this.ENTRY_FEE,
            status: 'COMPLETED',
            transactionId: result.transaction._id,
            cardNumbers: userData.cards
          });
          
          console.log(`✅ Charged $${this.ENTRY_FEE} to ${telegramId} for ${game.code}`);
          
        } catch (error) {
          console.error(`❌ Failed to charge ${telegramId}:`, error.message);
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: -this.ENTRY_FEE,
            status: 'FAILED',
            error: error.message,
            cardNumbers: userData.cards
          });
        }
      }

      // 4. Calculate totals
      reconciliation.totalPot = successfullyCharged * this.ENTRY_FEE;
      reconciliation.debitTotal = reconciliation.totalPot;
      
      reconciliation.addAudit('ENTRY_FEES_PROCESSED', {
        gameCode: game.code,
        uniqueUsersAttempted: userCardsMap.size,
        successfullyCharged: successfullyCharged,
        totalPot: reconciliation.totalPot,
        timestamp: new Date()
      });
      
      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`💰 Entry fees for ${game.code}: ${successfullyCharged}/${userCardsMap.size} users charged. Total: $${reconciliation.totalPot}`);
      
      return { success: true, reconciliation };
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing entry fees:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ==================== AUTO-CALLING SYSTEM ====================

  static async startAutoNumberCalling(gameId) {
    if (this.activeIntervals.has(gameId.toString())) {
      this.stopAutoNumberCalling(gameId);
    }

    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'ACTIVE') {
      console.log(`❌ Cannot start auto-calling: Game ${gameId} not active`);
      return;
    }

    this.winnerDeclared.delete(gameId.toString());

    console.log(`🔢 Starting auto-number calling for ${game.code}`);

    const interval = setInterval(async () => {
      try {
        const currentGame = await Game.findById(gameId);
        
        if (!currentGame || currentGame.status !== 'ACTIVE') {
          this.stopAutoNumberCalling(gameId);
          return;
        }

        if (this.winnerDeclared.has(gameId.toString())) {
          this.stopAutoNumberCalling(gameId);
          return;
        }

        if (currentGame.numbersCalled.length >= 75) {
          console.log(`🎯 All numbers called for ${currentGame.code}`);
          this.stopAutoNumberCalling(gameId);
          await this.endGameDueToNoWinner(gameId);
          return;
        }

        await this.callNumber(gameId);
        
      } catch (error) {
        console.error('❌ Auto-call error:', error);
      }
    }, this.NUMBER_CALL_INTERVAL);

    this.activeIntervals.set(gameId.toString(), interval);
    console.log(`✅ Auto-calling started for ${game.code}`);

    return interval;
  }

  static async stopAutoNumberCalling(gameId) {
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
        return;
      }

      const calledNumbers = game.numbersCalled || [];
      
      if (calledNumbers.length >= 75) {
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

      console.log(`🔢 Called number: ${newNumber} for ${game.code}. Total: ${calledNumbers.length}`);
      
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

  // ==================== WINNER DECLARATION ====================

  static async declareWinnerWithRetry(gameId, winningUserId, winningCard, winningPositions) {
    const session = await mongoose.startSession();
    let transactionInProgress = false;
    
    try {
      session.startTransaction();
      transactionInProgress = true;
      
      console.log(`🎉 Declaring winner for game ${gameId}: ${winningUserId}`);
      
      const game = await Game.findById(gameId).session(session);
      const card = await BingoCard.findById(winningCard._id).session(session);
      const bingoCards = await BingoCard.find({ gameId }).session(session);
      
      if (!game || game.status !== 'ACTIVE') {
        throw new Error('Game no longer active');
      }
      
      if (this.winnerDeclared.has(gameId.toString())) {
        throw new Error('Winner already declared');
      }
      
      // Get unique users count
      const uniqueUsers = new Set();
      bingoCards.forEach(card => uniqueUsers.add(card.userId.toString()));
      const totalUniquePlayers = uniqueUsers.size;
      
      // Calculate winnings
      const totalPot = totalUniquePlayers * this.ENTRY_FEE;
      const platformFee = totalPot * 0.2;
      const winnerPrize = totalPot - platformFee;
      
      // Mark card as winner
      card.isWinner = true;
      card.winningPatternPositions = winningPositions;
      card.winningPatternType = winningCard.winningPatternType || 'BINGO';
      await card.save({ session });
      
      // Create reconciliation
      const reconciliation = new Reconciliation({
        gameId: game._id,
        status: 'WINNER_DECLARED',
        totalPot: totalPot,
        platformFee: platformFee,
        winnerAmount: winnerPrize,
        winnerId: winningUserId,
        debitTotal: totalPot,
        creditTotal: winnerPrize + platformFee,
        completedAt: new Date()
      });
      
      // Update game
      const now = new Date();
      game.status = 'FINISHED';
      game.winnerId = winningUserId;
      game.endedAt = now;
      game.winningAmount = winnerPrize;
      
      await game.save({ session });
      await reconciliation.save({ session });
      
      // Distribute winnings
      const WalletService = require('./walletService');
      await WalletService.addWinning(
        winningUserId,
        gameId,
        winnerPrize,
        `Winner prize for game ${game.code} (${totalUniquePlayers} players)`
      );
      
      this.winnerDeclared.add(gameId.toString());
      
      await session.commitTransaction();
      transactionInProgress = false;
      
      console.log(`🎊 Game ${game.code} ENDED - Winner: ${winningUserId} won $${winnerPrize}`);
      
      this.stopAutoNumberCalling(gameId);
      
      // Set countdown for next game
      await this.setNextGameCountdown(gameId);
      
      return reconciliation;
      
    } catch (error) {
      if (transactionInProgress && session.inTransaction()) {
        await session.abortTransaction();
      }
      console.error('❌ Failed to declare winner:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ==================== NO WINNER & REFUNDS (DUPLICATE PREVENTION) ====================

  static async endGameDueToNoWinner(gameId) {
    const lockKey = `no_winner_${gameId}`;
    
    if (this.processingGames.has(lockKey)) {
      console.log(`⏳ Game ${gameId} already being processed for no-winner ending`);
      return;
    }

    try {
      this.processingGames.add(lockKey);
      
      const game = await Game.findById(gameId);
      
      if (!game) {
        console.log(`⚠️ Game ${gameId} not found`);
        return;
      }

      // Check if already has winner
      if (game.winnerId) {
        console.log(`✅ Game ${game.code} already has winner ${game.winnerId}`);
        
        if (game.status !== 'FINISHED') {
          game.status = 'FINISHED';
          game.endedAt = game.endedAt || new Date();
          await game.save();
        }
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        await this.setNextGameCountdown(gameId);
        return;
      }

      if (game.status !== 'ACTIVE') {
        console.log(`⚠️ Game ${gameId} is not active (${game.status})`);
        return;
      }

      // Check numbers
      if (game.numbersCalled.length < 75) {
        console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers`);
        return;
      }

      console.log(`🏁 Ending game ${game.code} - no winner after ALL 75 numbers`);
      
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const gameInSession = await Game.findById(gameId).session(session);
        
        if (!gameInSession) {
          await session.abortTransaction();
          return;
        }

        // Double check winner
        if (gameInSession.winnerId) {
          gameInSession.status = 'FINISHED';
          gameInSession.endedAt = gameInSession.endedAt || new Date();
          await gameInSession.save({ session });
          
          await session.commitTransaction();
          
          this.winnerDeclared.add(gameId.toString());
          this.stopAutoNumberCalling(gameId);
          await this.setNextGameCountdown(gameId);
          return;
        }

        // Check if refunds already processed
        const existingReconciliation = await Reconciliation.findOne({ 
          gameId: gameInSession._id,
          status: 'NO_WINNER_REFUNDED'
        }).session(session);
        
        if (existingReconciliation) {
          console.log(`✅ Refunds already processed for ${gameInSession.code}`);
          
          if (gameInSession.status !== 'NO_WINNER') {
            gameInSession.status = 'NO_WINNER';
            gameInSession.endedAt = gameInSession.endedAt || new Date();
            await gameInSession.save({ session });
          }
          
          await session.commitTransaction();
          return;
        }

        const bingoCards = await BingoCard.find({ gameId: gameInSession._id }).session(session);
        
        // Check for winning card
        const winningCard = await BingoCard.findOne({ 
          gameId: gameInSession._id, 
          isWinner: true 
        }).session(session);
        
        if (winningCard) {
          console.log(`✅ Found winning card for ${gameInSession.code}`);
          
          gameInSession.status = 'FINISHED';
          gameInSession.winnerId = winningCard.userId;
          gameInSession.endedAt = gameInSession.endedAt || new Date();
          await gameInSession.save({ session });
          
          await session.commitTransaction();
          
          this.winnerDeclared.add(gameId.toString());
          this.stopAutoNumberCalling(gameId);
          await this.setNextGameCountdown(gameId);
          return;
        }

        console.log(`💰 Processing refunds for ${bingoCards.length} cards...`);
        
        const WalletService = require('./walletService');
        
        // Group by unique users
        const userCardsMap = new Map();
        let refundTransactions = [];
        
        // First pass: Group cards by user
        for (const card of bingoCards) {
          const user = await User.findById(card.userId).session(session);
          if (!user || !user.telegramId) continue;
          
          const telegramId = user.telegramId;
          
          if (!userCardsMap.has(telegramId)) {
            userCardsMap.set(telegramId, {
              userId: user._id,
              telegramId: telegramId,
              cards: [],
              totalRefund: 0
            });
          }
          
          const userData = userCardsMap.get(telegramId);
          userData.cards.push(card.cardNumber);
        }

        // Second pass: Process refunds for unique users
        for (const [telegramId, userData] of userCardsMap.entries()) {
          // CRITICAL: Check if user already refunded for this game
          const existingRefund = await Transaction.findOne({
            userId: userData.userId,
            gameId: gameInSession._id,
            type: 'WINNING',
            description: { $regex: `Refund.*game.*${gameInSession.code}` },
            status: 'COMPLETED'
          }).session(session);
          
          if (existingRefund) {
            console.log(`✅ User ${telegramId} already refunded for ${gameInSession.code}`);
            continue;
          }
          
          // Calculate refund amount (always $10 per user, regardless of cards)
          const refundAmount = this.ENTRY_FEE;
          
          try {
            await WalletService.addWinning(
              telegramId,
              gameInSession._id,
              refundAmount,
              `Refund - No winner in game ${gameInSession.code}`
            );
            
            userData.totalRefund = refundAmount;
            
            refundTransactions.push({
              userId: userData.userId,
              type: 'REFUND',
              amount: refundAmount,
              status: 'COMPLETED',
              telegramId: telegramId
            });
            
            console.log(`✅ Refunded $${refundAmount} to ${telegramId}`);
            
          } catch (error) {
            console.error(`❌ Failed to refund ${telegramId}:`, error.message);
            
            refundTransactions.push({
              userId: userData.userId,
              type: 'REFUND',
              amount: refundAmount,
              status: 'FAILED',
              error: error.message,
              telegramId: telegramId
            });
          }
        }

        const now = new Date();
        
        // Update game
        gameInSession.status = 'NO_WINNER';
        gameInSession.endedAt = now;
        gameInSession.refunded = true;
        gameInSession.refundedAt = now;
        gameInSession.totalRefunded = Array.from(userCardsMap.values())
          .reduce((sum, user) => sum + user.totalRefund, 0);
        gameInSession.uniquePlayersRefunded = userCardsMap.size;
        
        await gameInSession.save({ session });
        
        // Create reconciliation
        const reconciliation = new Reconciliation({
          gameId: gameInSession._id,
          status: 'NO_WINNER_REFUNDED',
          totalPot: gameInSession.totalRefunded,
          platformFee: 0,
          winnerAmount: 0,
          debitTotal: gameInSession.totalRefunded,
          creditTotal: gameInSession.totalRefunded,
          completedAt: now,
          transactions: refundTransactions
        });
        
        await reconciliation.save({ session });
        await session.commitTransaction();
        
        console.log(`✅ Game ${gameInSession.code} ended as NO_WINNER. Refunded ${userCardsMap.size} users, total: $${gameInSession.totalRefunded}`);
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        await this.setNextGameCountdown(gameId);

      } catch (error) {
        console.error('❌ Transaction error in endGameDueToNoWinner:', error);
        if (session && session.inTransaction()) {
          await session.abortTransaction();
        }
        throw error;
      } finally {
        if (session) {
          session.endSession();
        }
      }

    } catch (error) {
      console.error('❌ Error in endGameDueToNoWinner:', error);
      throw error;
    } finally {
      this.processingGames.delete(lockKey);
    }
  }

  // ==================== NEXT GAME COUNTDOWN ====================

  static async setNextGameCountdown(gameId) {
    // Wait a moment to ensure all transactions are complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if active game already exists
    const activeGameExists = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true },
      _id: { $ne: gameId }
    });
    
    if (activeGameExists) {
      console.log(`⚠️ Active game already exists (${activeGameExists.code}), skipping countdown`);
      return;
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      // Only proceed if game is finished
      if (game.status !== 'FINISHED' && game.status !== 'NO_WINNER') {
        console.log(`⚠️ Game ${game.code} not finished (${game.status}), skipping countdown`);
        await session.abortTransaction();
        return;
      }

      const now = new Date();
      const cooldownDuration = 30000; // 30 seconds
      game.cooldownEndTime = new Date(now.getTime() + cooldownDuration);
      
      await game.save({ session });
      await session.commitTransaction();
      
      console.log(`⏰ Next game countdown set for ${game.code}. New game in ${cooldownDuration/1000}s`);
      
      // Schedule new game creation
      setTimeout(async () => {
        try {
          await this.createNewGameAfterCooldown(gameId);
        } catch (error) {
          console.error('❌ Failed to create new game after countdown:', error);
        }
      }, cooldownDuration);
      
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      console.error('❌ Error setting next game countdown:', error);
    } finally {
      session.endSession();
    }
  }

  // ==================== CARD MANAGEMENT ====================

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
        throw new Error('Cannot select card - game not accepting players');
      }

      // Check if card number is taken by another player
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
        user = await User.create([{
          telegramId: userId,
          firstName: `Player_${userId.slice(0, 8)}`,
          username: `player_${userId}`,
          role: 'user'
        }], { session });
        user = user[0];
      }

      const mongoUserId = user._id;

      // Auto-join player to game
      const existingPlayer = await GamePlayer.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (!existingPlayer) {
        await GamePlayer.create([{
          userId: mongoUserId,
          gameId: gameId,
          isReady: true,
          playerType: 'PLAYER',
          joinedAt: new Date()
        }], { session });
        
        game.currentPlayers += 1;
        await game.save({ session });
        
        console.log(`✅ User ${userId} joined ${game.code}. Total: ${game.currentPlayers}`);
      }

      // Check if user already has a card
      const existingCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (existingCard) {
        if (existingCard.cardNumber === cardNumber) {
          console.log(`✅ User ${userId} already has card #${cardNumber}`);
          
          await session.commitTransaction();
          
          return { 
            success: true, 
            message: 'Card already selected',
            action: 'ALREADY_SELECTED',
            cardId: existingCard._id,
            cardNumber: cardNumber
          };
        }
        
        // Replace existing card
        console.log(`🔄 User ${userId} replacing card #${existingCard.cardNumber} with #${cardNumber}`);
        
        await BingoCard.deleteOne({ 
          _id: existingCard._id 
        }).session(session);
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
      
      console.log(`✅ User ${user._id} selected card #${cardNumber} for ${game.code}`);
      
      // Update in-memory tracking
      this.updateCardSelection(gameId, cardNumber, mongoUserId);
      
      // Schedule auto-start check if needed
      if (game.status === 'WAITING_FOR_PLAYERS') {
        this.scheduleAutoStartCheck(gameId);
      }

      return { 
        success: true, 
        message: 'Card selected successfully',
        action: existingCard ? 'REPLACED' : 'CREATED',
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

  static updateCardSelection(gameId, cardNumber, userId) {
    const gameIdStr = gameId.toString();
    
    if (!this.selectedCards.has(gameIdStr)) {
      this.selectedCards.set(gameIdStr, new Map());
    }
    
    const gameCards = this.selectedCards.get(gameIdStr);
    
    // Remove any previous card for this user
    for (const [existingCardNumber, data] of gameCards.entries()) {
      if (data.userId.toString() === userId.toString()) {
        gameCards.delete(existingCardNumber);
      }
    }
    
    // Add new card
    gameCards.set(cardNumber, {
      userId: userId,
      selectedAt: new Date()
    });
  }

  // ==================== GAME QUERIES & UTILITIES ====================

  static async getActiveGames() {
    try {
      const game = await this.findActiveGame();
      
      if (game) {
        const formattedGame = await this.formatGameForFrontend(game);
        return [formattedGame];
      }
      
      return [];
    } catch (error) {
      console.error('❌ Error in getActiveGames:', error);
      return [];
    }
  }

  static async getWaitingGames() {
    try {
      const games = await Game.find({
        status: 'WAITING_FOR_PLAYERS',
        archived: { $ne: true }
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
      
      console.log(`✅ Found ${games.length} waiting games`);
      
      const now = new Date();
      const formattedGames = games.map(game => {
        const gameObj = {
          ...game,
          _id: game._id.toString(),
          message: 'Waiting for players to join...'
        };
        
        if (game.autoStartEndTime && game.autoStartEndTime > now) {
          gameObj.autoStartTimeRemaining = game.autoStartEndTime - now;
          gameObj.hasAutoStartTimer = true;
        }
        
        return gameObj;
      });
      
      return formattedGames;
      
    } catch (error) {
      console.error('❌ Error in getWaitingGames:', error);
      return [];
    }
  }

  static async formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    const now = new Date();
    
    // Status consistency
    if (gameObj.status === 'WAITING') {
      gameObj.status = 'WAITING_FOR_PLAYERS';
    }
    
    // Status-specific info
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
        if (gameObj.cardSelectionEndTime) {
          gameObj.cardSelectionTimeRemaining = Math.max(0, gameObj.cardSelectionEndTime - now);
          gameObj.hasCardSelectionTimer = true;
        }
        break;
        
      case 'ACTIVE':
        gameObj.message = 'Game in progress!';
        if (!gameObj.startedAt) {
          gameObj.startedAt = new Date();
        }
        break;
        
      case 'FINISHED':
        gameObj.message = gameObj.noWinner ? 'Game ended - No winner (All refunded)' : 'Game finished!';
        break;
        
      case 'NO_WINNER':
        gameObj.message = 'Next game starting soon...';
        if (gameObj.cooldownEndTime && gameObj.cooldownEndTime > now) {
          gameObj.cooldownTimeRemaining = gameObj.cooldownEndTime - now;
        }
        break;
    }
    
    // Get players with cards
    const bingoCards = await BingoCard.find({ gameId: gameObj._id });
    const playersWithCards = bingoCards.length;
    
    gameObj.playersWithCards = playersWithCards;
    gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
    
    // Permissions
    gameObj.canSelectCard = gameObj.status === 'WAITING_FOR_PLAYERS' || 
                          gameObj.status === 'CARD_SELECTION';
    gameObj.canJoin = gameObj.status === 'WAITING_FOR_PLAYERS';
    
    return gameObj;
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

  static async getTakenCards(gameId) {
    try {
      const bingoCards = await BingoCard.find({ gameId });
      const takenCards = bingoCards.map(card => ({
        cardNumber: card.cardNumber,
        userId: card.userId
      }));
      
      console.log(`📊 Taken cards: ${takenCards.length}`);
      
      return takenCards;
    } catch (error) {
      console.error('❌ Get taken cards error:', error);
      return [];
    }
  }

  // ==================== AUTO-START MANAGEMENT ====================

  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Conditions met for auto-start: ${playersWithCards} players`);
      await this.beginCardSelection(gameId);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      // Check again in 5 seconds
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
  }

  static clearAutoStartTimer(gameId) {
    const gameIdStr = gameId.toString();
    
    if (this.autoStartTimers.has(gameIdStr)) {
      const timerInfo = this.autoStartTimers.get(gameIdStr);
      clearTimeout(timerInfo.timer);
      this.autoStartTimers.delete(gameIdStr);
    }
  }

  // ==================== SERVICE MANAGEMENT ====================

  static startAutoGameService() {
    // Clean up existing intervals
    this.cleanupAllIntervals();
    
    // Start main game management
    const interval = setInterval(async () => {
      try {
        await this.manageGameLifecycle();
      } catch (error) {
        console.error('❌ Game service error:', error);
      }
    }, 30000);

    console.log('🚀 Game Service Started');
    
    // Initial setup
    setTimeout(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Initial game setup failed:', error);
      }
    }, 5000);

    return interval;
  }

  static async manageGameLifecycle() {
    try {
      const now = new Date();
      
      // Card selection → Active
      const cardSelectionGames = await Game.find({
        status: 'CARD_SELECTION',
        cardSelectionEndTime: { $lte: now }
      });
      
      for (const game of cardSelectionGames) {
        console.log(`⏰ Card selection ended for ${game.code}`);
        await this.checkCardSelectionEnd(game._id);
      }
      
      // Cooldown management (handled in getMainGame)
      const expiredCooldownGames = await Game.find({
        status: 'COOLDOWN',
        cooldownEndTime: { $lte: now },
        archived: { $ne: true }
      });
      
      if (expiredCooldownGames.length > 0) {
        console.log(`🔄 ${expiredCooldownGames.length} cooldown games expired`);
      }
      
    } catch (error) {
      console.error('❌ Error managing game lifecycle:', error);
    }
  }

  static cleanupAllIntervals() {
    console.log(`🧹 Cleaning up ${this.activeIntervals.size} active intervals`);
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
      console.log(`🛑 Stopped interval for game ${gameId}`);
    }
    this.activeIntervals.clear();
    this.winnerDeclared.clear();
    this.processingGames.clear();
    this.selectedCards.clear();
    this.autoStartTimers.clear();
    this.gameCreationLock.clear();
  }

  // ==================== OTHER ESSENTIAL METHODS ====================

  static async joinGame(gameCode, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findOne({ code: gameCode, archived: { $ne: true } }).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      if (game.status !== 'WAITING_FOR_PLAYERS') {
        throw new Error('Game is not accepting new players');
      }

      // Find or create user
      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ telegramId: userId }).session(session);
      }

      if (!user) {
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
      
      // Schedule auto-start check
      if (game.currentPlayers >= this.MIN_PLAYERS_TO_START) {
        this.scheduleAutoStartCheck(game._id);
      }
      
      await game.save({ session });
      await session.commitTransaction();

      console.log(`✅ User ${userId} joined ${game.code}. Total: ${game.currentPlayers}`);

      return this.getGameWithDetails(game._id);
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Join game error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

static async claimBingo(gameId, userId, patternType = 'BINGO') {
  const session = await mongoose.startSession();
  
  try {
    console.log(`🏆 BINGO CLAIM attempt by ${userId} for game ${gameId}`);
    
    if (this.winnerDeclared.has(gameId.toString())) {
      throw new Error('Winner already declared for this game');
    }

    const game = await Game.findById(gameId).session(session);
    if (!game || game.status !== 'ACTIVE') {
      throw new Error('Game not active');
    }

    // Find user
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
      throw new Error('No bingo card found');
    }

    // Get all called numbers
    const calledNumbers = game.numbersCalled || [];
    
    // Get user's card numbers (flattened array)
    const cardNumbers = bingoCard.numbers.flat();
    
    // Get manually marked positions
    const manuallyMarkedPositions = bingoCard.markedPositions || [];
    
    // Always include FREE space
    const effectiveMarkedPositions = [...new Set([...manuallyMarkedPositions, 12])];
    
    console.log(`📊 User ${userId} has ${manuallyMarkedPositions.length} manually marked positions`);
    console.log(`🔢 Total called numbers: ${calledNumbers.length}`);
    
    // Check for "one away" scenarios where user has 3 marked and 4th is already called
    const winResult = this.checkEnhancedWinConditionWithAutoMark(
      cardNumbers, 
      effectiveMarkedPositions, 
      calledNumbers
    );
    
    if (!winResult.isWinner) {
      throw new Error('Invalid claim - no winning pattern found');
    }

    console.log(`✅ VALID BINGO CLAIM by ${userId} with ${winResult.patternType}`);
    console.log(`🔄 Auto-marked positions: ${winResult.autoMarkedPositions?.length || 0}`);
    
    // Update the card with auto-marked positions if any
    if (winResult.autoMarkedPositions && winResult.autoMarkedPositions.length > 0) {
      const newMarkedPositions = [...new Set([
        ...bingoCard.markedPositions,
        ...winResult.autoMarkedPositions
      ])];
      
      bingoCard.markedPositions = newMarkedPositions;
      await bingoCard.save({ session });
      
      console.log(`✅ Updated card with auto-marked positions: ${winResult.autoMarkedPositions}`);
    }
    
    // Declare winner
    await this.declareWinnerWithRetry(
      gameId, 
      mongoUserId, 
      { 
        ...bingoCard.toObject(), 
        winningPatternType: winResult.patternType,
        autoMarkedPositions: winResult.autoMarkedPositions || []
      }, 
      winResult.winningPositions
    );
    
    return {
      success: true,
      message: 'Bingo claim successful! You are the winner!',
      patternType: winResult.patternType,
      winningPositions: winResult.winningPositions,
      autoMarkedPositions: winResult.autoMarkedPositions || [],
      manuallyMarked: manuallyMarkedPositions.length
    };
    
  } catch (error) {
    console.error('❌ Bingo claim error:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

  static checkEnhancedWinCondition(cardNumbers, markedPositions) {
    if (!cardNumbers || !markedPositions) {
      return { isWinner: false, patternType: null, winningPositions: [] };
    }

    const effectiveMarked = [...markedPositions];
    
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
      { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] },
      { type: 'FOUR_CORNERS', positions: [0, 4, 20, 24] }
    ];

    for (const pattern of winningPatterns) {
      const isComplete = pattern.positions.every(pos => effectiveMarked.includes(pos));
      
      if (isComplete) {
        return {
          isWinner: true,
          patternType: pattern.type,
          winningPositions: pattern.positions
        };
      }
    }

    return { isWinner: false, patternType: null, winningPositions: [] };
  }
  static checkEnhancedWinConditionWithAutoMark(cardNumbers, markedPositions, calledNumbers) {
  if (!cardNumbers || !markedPositions) {
    return { isWinner: false, patternType: null, winningPositions: [], autoMarkedPositions: [] };
  }

  const effectiveMarked = [...markedPositions];
  
  const winningPatterns = [
    // Rows
    { type: 'ROW', positions: [0, 1, 2, 3, 4] },
    { type: 'ROW', positions: [5, 6, 7, 8, 9] },
    { type: 'ROW', positions: [10, 11, 12, 13, 14] },
    { type: 'ROW', positions: [15, 16, 17, 18, 19] },
    { type: 'ROW', positions: [20, 21, 22, 23, 24] },
    
    // Columns
    { type: 'COLUMN', positions: [0, 5, 10, 15, 20] },
    { type: 'COLUMN', positions: [1, 6, 11, 16, 21] },
    { type: 'COLUMN', positions: [2, 7, 12, 17, 22] },
    { type: 'COLUMN', positions: [3, 8, 13, 18, 23] },
    { type: 'COLUMN', positions: [4, 9, 14, 19, 24] },
    
    // Diagonals
    { type: 'DIAGONAL', positions: [0, 6, 12, 18, 24] },
    { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] },
    
    // Four Corners (special pattern)
    { type: 'FOUR_CORNERS', positions: [0, 4, 20, 24] }
  ];

  for (const pattern of winningPatterns) {
    // Count how many positions are already marked
    const markedInPattern = pattern.positions.filter(pos => effectiveMarked.includes(pos));
    
    // If all 5 are marked, it's a regular win
    if (markedInPattern.length === pattern.positions.length) {
      return {
        isWinner: true,
        patternType: pattern.type,
        winningPositions: pattern.positions,
        autoMarkedPositions: []
      };
    }
    
    // Check for "one away" scenario: 3 marked, 4th is called but not marked
    if (markedInPattern.length === 3) {
      // Find the unmarked position in the pattern
      const unmarkedPositions = pattern.positions.filter(pos => !effectiveMarked.includes(pos));
      
      // For a pattern of 5, we should have 2 unmarked positions
      if (unmarkedPositions.length === 2) {
        // Check if one of the unmarked numbers is in called numbers
        const autoMarkablePositions = [];
        
        for (const unmarkedPos of unmarkedPositions) {
          const unmarkedNumber = cardNumbers[unmarkedPos];
          
          // Skip FREE space (already included)
          if (unmarkedNumber === 'FREE') continue;
          
          // Check if this number has been called
          if (calledNumbers.includes(unmarkedNumber)) {
            autoMarkablePositions.push(unmarkedPos);
          }
        }
        
        // If we found 1 auto-markable position and user has 3 marked,
        // then with the auto-mark we'll have 4 marked, leaving only 1 unmarked
        // This meets your requirement for faster claiming
        if (autoMarkablePositions.length === 1) {
          const finalMarkedPositions = [...effectiveMarked, ...autoMarkablePositions];
          
          // Check if this now completes the pattern
          const isComplete = pattern.positions.every(pos => finalMarkedPositions.includes(pos));
          
          if (isComplete) {
            return {
              isWinner: true,
              patternType: pattern.type,
              winningPositions: pattern.positions,
              autoMarkedPositions: autoMarkablePositions
            };
          }
        }
      }
    }
    
    // Also check for "two away" scenario: 2 marked, 3rd and 4th are called but not marked
    // This is even faster claiming
    if (markedInPattern.length === 2) {
      const unmarkedPositions = pattern.positions.filter(pos => !effectiveMarked.includes(pos));
      
      if (unmarkedPositions.length === 3) {
        const autoMarkablePositions = [];
        
        for (const unmarkedPos of unmarkedPositions) {
          const unmarkedNumber = cardNumbers[unmarkedPos];
          
          if (unmarkedNumber === 'FREE') continue;
          
          if (calledNumbers.includes(unmarkedNumber)) {
            autoMarkablePositions.push(unmarkedPos);
          }
        }
        
        // If we found 2 auto-markable positions
        if (autoMarkablePositions.length >= 2) {
          const finalMarkedPositions = [...effectiveMarked, ...autoMarkablePositions];
          
          const isComplete = pattern.positions.every(pos => finalMarkedPositions.includes(pos));
          
          if (isComplete) {
            return {
              isWinner: true,
              patternType: pattern.type,
              winningPositions: pattern.positions,
              autoMarkedPositions: autoMarkablePositions.slice(0, 2) // Take first 2
            };
          }
        }
      }
    }
  }

  return { isWinner: false, patternType: null, winningPositions: [], autoMarkedPositions: [] };
}

  static async getUniquePlayersCount(gameId) {
    try {
      const bingoCards = await BingoCard.find({ gameId });
      const uniqueUsers = new Set();
      
      bingoCards.forEach(card => {
        if (card.userId) {
          uniqueUsers.add(card.userId.toString());
        }
      });
      
      return uniqueUsers.size;
    } catch (error) {
      console.error('❌ Error getting unique players count:', error);
      return 0;
    }
  }

// Add these methods to the GameService class in your COMPLETE REWRITE version:

// ==================== MISSING METHODS FROM ORIGINAL ====================

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

static async getUserBingoCard(gameId, userId) {
  try {
    let user;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId);
    } else {
      user = await User.findOne({ telegramId: userId });
    }
    
    if (!user) {
      return null;
    }
    
    const query = { gameId, userId: user._id };
    
    const bingoCard = await BingoCard.findOne(query)
      .populate('userId', 'username firstName telegramId');
    
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

static async joinGameWithWallet(gameCode, userId, entryFee = 10) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const WalletService = require('./walletService');
    const balance = await WalletService.getBalance(userId);
    
    if (balance < entryFee) {
      throw new Error(`Insufficient balance. Required: $${entryFee}, Available: $${balance}`);
    }

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
  // First find the user
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
  
  // Find the bingo card
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

  console.log(`✅ User ${userId} marked number ${number} on card`);

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
  
  // Use only manually marked positions
  let effectiveMarkedPositions = bingoCard.markedPositions || [];
  
  // Always include FREE space
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
      
      console.log(`🎉 Manual win check: Winner found for user ${userId}`);
      
      this.stopAutoNumberCalling(gameId);
      await this.setNextGameCountdown(gameId);
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
    
    const WalletService = require('./walletService');
    
    for (const card of bingoCards) {
      try {
        const user = await User.findById(card.userId).session(session);
        
        if (user && user.telegramId) {
          await WalletService.addWinning(
            user.telegramId,
            gameId,
            this.ENTRY_FEE,
            `Refund - Game ${game.code} cancelled`
          );
          console.log(`✅ Refunded $${this.ENTRY_FEE} to ${user.telegramId}`);
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
        await this.setNextGameCountdown(gameId);
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

static scheduleAutoStart(gameId, delay = 10000) {
  this.clearAutoStartTimer(gameId);
  
  console.log(`⏰ Scheduling auto-start for game ${gameId} in ${delay}ms`);
  
  const timer = setTimeout(async () => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'WAITING_FOR_PLAYERS') {
        this.clearAutoStartTimer(gameId);
        return;
      }

      const playersWithCards = await BingoCard.countDocuments({ gameId });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`🎯 Auto-start conditions met for game ${game.code}: ${playersWithCards} players with cards`);
        await this.beginCardSelection(gameId);
      } else {
        console.log(`❌ Auto-start cancelled - only ${playersWithCards} players with cards`);
      }
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

static async getGameParticipants(gameId) {
  try {
    // Get all players registered in the game
    const gamePlayers = await GamePlayer.find({ gameId })
      .populate('userId', 'username firstName telegramId');
    
    // Get all card holders
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
    
    // Add card holders
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
          winningPatternPositions: bingoCard.winningPatternPositions || [],
          winningPatternType: bingoCard.winningPatternType || null
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
    game.autoStartEndTime = null;
    
    await game.save();
    
    await BingoCard.deleteMany({ gameId });
    
    console.log(`✅ Game ${game.code} restarted - waiting for players to select cards`);
    
  } catch (error) {
    console.error('❌ Auto-restart error:', error);
  }
}

static async checkAndAutoStartGame(gameId) {
  try {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') {
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

static async checkAndPreventDuplicateReconciliation(gameId, userId) {
  try {
    // Check if user already has a reconciliation transaction for this game
    const existingReconciliation = await Reconciliation.findOne({
      gameId: gameId,
      'transactions.userId': userId,
      status: { $in: ['DEDUCTED', 'WINNER_DECLARED', 'NO_WINNER_REFUNDED'] }
    });

    if (existingReconciliation) {
      // Check if this specific user already has a completed transaction
      const userTransaction = existingReconciliation.transactions.find(
        tx => tx.userId.toString() === userId.toString() && tx.status === 'COMPLETED'
      );
      
      if (userTransaction) {
        console.log(`⚠️ User ${userId} already has reconciliation for game ${gameId}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('❌ Error checking duplicate reconciliation:', error);
    return false;
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
      await this.beginCardSelection(gameId);
    } else {
      console.log(`❌ Auto-start cancelled - only ${playersWithCards} players with cards`);
      
      // Schedule another check
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 10000);
    }
    
  } catch (error) {
    console.error('❌ Auto-start game error:', error);
    this.clearAutoStartTimer(gameId);
  }
}

static async calculatePrize(gameId) {
  const uniquePlayers = await this.getUniquePlayersCount(gameId);
  const entryFee = 10;
  const totalPot = uniquePlayers * entryFee;
  const platformFee = totalPot * 0.2;
  const winnerPrize = totalPot - platformFee;
  
  return {
    uniquePlayers,
    totalPot,
    platformFee,
    winnerPrize
  };
}

static async getGameById(gameId) {
  if (!mongoose.Types.ObjectId.isValid(gameId)) {
    throw new Error('Invalid game ID');
  }

  return await this.getGameWithDetails(gameId);
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

static async autoRestartFinishedGames() {
  try {
    const finishedGames = await Game.find({
      status: 'FINISHED',
      endedAt: { $lt: new Date(Date.now() - 10000) }
    });

    for (const game of finishedGames) {
      console.log(`🔄 Auto-setting countdown for finished game ${game.code}`);
      await this.setNextGameCountdown(game._id);
    }
    
    return finishedGames.length;
  } catch (error) {
    console.error('❌ Error auto-restarting games:', error);
    return 0;
  }
}

static async haveRefundsBeenProcessed(gameId) {
  try {
    const reconciliation = await Reconciliation.findOne({ gameId });
    if (!reconciliation) return false;
    
    if (reconciliation.status === 'NO_WINNER_REFUNDED') {
      return true;
    }
    
    const refundTransactions = reconciliation.transactions.filter(tx => 
      tx.type === 'REFUND' && tx.status === 'COMPLETED'
    );
    
    return refundTransactions.length > 0;
  } catch (error) {
    console.error('Error checking refunds:', error);
    return false;
  }
}

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
    const platformFee = totalPot * 0.2;
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

}

// Handle process shutdown
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