// services/gameService.js - COMPLETE REWRITE WITH SINGLE GAME STATE MANAGEMENT
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const Reconciliation = require('../models/Reconciliation');
const Transaction = require('../models/Transaction');
const GameUtils = require('../utils/gameUtils');

class GameService {
  // In-memory state trackers
  static activeIntervals = new Map();
  static winnerDeclared = new Set();
  static processingGames = new Set();
  static selectedCards = new Map();
  static autoStartTimers = new Map();
  
  // Constants
  static MIN_PLAYERS_TO_START = 2;
  static CARD_SELECTION_DURATION = 30000; // 30 seconds
  static AUTO_START_DELAY = 30000; // 30 seconds
  static NEXT_GAME_COOLDOWN = 30000; // 30 seconds
  static NUMBER_CALL_INTERVAL = 5000; // 5 seconds
  static ENTRY_FEE = 10;
  
  // Game state lock to prevent concurrent modifications
  static gameStateLock = new Set();

  // ==================== CORE GAME STATE MANAGEMENT ====================

  /**
   * ENFORCE SINGLE GAME PRINCIPLE:
   * Only ONE game can be in WAITING_FOR_PLAYERS, CARD_SELECTION, or ACTIVE state at any time
   */
  static async enforceSingleGameRule() {
    const lockKey = 'single_game_rule';
    if (this.gameStateLock.has(lockKey)) {
      return;
    }

    try {
      this.gameStateLock.add(lockKey);
      
      console.log('🔒 Enforcing single game rule...');
      
      // Find ALL games that are in active states
      const activeGames = await Game.find({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      }).sort({ createdAt: -1 });

      if (activeGames.length <= 1) {
        console.log('✅ Single game rule satisfied');
        return;
      }

      console.warn(`⚠️ Found ${activeGames.length} active games - need to merge/cleanup`);
      
      // Keep the NEWEST game as the active one
      const mainGame = activeGames[0];
      console.log(`🎮 Keeping main game: ${mainGame.code} (created: ${mainGame.createdAt})`);

      // Process and archive all other games
      for (let i = 1; i < activeGames.length; i++) {
        const duplicateGame = activeGames[i];
        console.log(`🔄 Processing duplicate game: ${duplicateGame.code} (${duplicateGame.status})`);
        
        await this.mergeGameIntoMain(duplicateGame, mainGame);
      }

      console.log('✅ Single game enforcement complete');
    } catch (error) {
      console.error('❌ Error enforcing single game rule:', error);
    } finally {
      this.gameStateLock.delete(lockKey);
    }
  }

  /**
   * Merge a duplicate game into the main game
   */
  static async mergeGameIntoMain(duplicateGame, mainGame) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log(`🔄 Merging game ${duplicateGame.code} into ${mainGame.code}...`);

      // 1. Get all players from duplicate game
      const duplicatePlayers = await GamePlayer.find({ 
        gameId: duplicateGame._id 
      }).session(session);
      
      const duplicateCards = await BingoCard.find({ 
        gameId: duplicateGame._id 
      }).session(session);

      // 2. Move players to main game (if not already there)
      for (const player of duplicatePlayers) {
        const existingPlayer = await GamePlayer.findOne({
          gameId: mainGame._id,
          userId: player.userId
        }).session(session);

        if (!existingPlayer) {
          await GamePlayer.create([{
            userId: player.userId,
            gameId: mainGame._id,
            isReady: player.isReady,
            playerType: player.playerType,
            joinedAt: new Date()
          }], { session });
        }
      }

      // 3. Move cards to main game (handle card number conflicts)
      for (const card of duplicateCards) {
        // Check if card number is available in main game
        const cardExists = await BingoCard.findOne({
          gameId: mainGame._id,
          cardNumber: card.cardNumber
        }).session(session);

        if (!cardExists) {
          // Move the card directly
          await BingoCard.create([{
            userId: card.userId,
            gameId: mainGame._id,
            cardNumber: card.cardNumber,
            numbers: card.numbers,
            markedPositions: card.markedPositions,
            isLateJoiner: mainGame.status !== 'WAITING_FOR_PLAYERS',
            joinedAt: new Date(),
            numbersCalledAtJoin: mainGame.numbersCalled || []
          }], { session });
        } else {
          // Find next available card number
          const takenCardNumbers = await BingoCard.distinct('cardNumber', {
            gameId: mainGame._id
          }).session(session);
          
          let newCardNumber = 1;
          while (takenCardNumbers.includes(newCardNumber)) {
            newCardNumber++;
          }

          // Create card with new number
          await BingoCard.create([{
            userId: card.userId,
            gameId: mainGame._id,
            cardNumber: newCardNumber,
            numbers: card.numbers,
            markedPositions: card.markedPositions,
            isLateJoiner: mainGame.status !== 'WAITING_FOR_PLAYERS',
            joinedAt: new Date(),
            numbersCalledAtJoin: mainGame.numbersCalled || []
          }], { session });
        }
      }

      // 4. Archive the duplicate game
      duplicateGame.archived = true;
      duplicateGame.archivedAt = new Date();
      duplicateGame.archivedReason = `Merged into game ${mainGame.code} during single game enforcement`;
      await duplicateGame.save({ session });

      // 5. Update main game player count
      const uniquePlayers = await GamePlayer.distinct('userId', {
        gameId: mainGame._id
      }).session(session);
      
      mainGame.currentPlayers = uniquePlayers.length;
      await mainGame.save({ session });

      await session.commitTransaction();
      
      console.log(`✅ Merged ${duplicatePlayers.length} players and ${duplicateCards.length} cards from ${duplicateGame.code} to ${mainGame.code}`);
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error merging games:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ==================== MAIN GAME MANAGEMENT ====================

  static async getMainGame() {
    try {
      console.log('🎮 getMainGame() called');
      
      // 1. First enforce single game rule
      await this.enforceSingleGameRule();
      
      // 2. Find the current main game
      const mainGame = await Game.findOne({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      })
      .sort({ createdAt: -1 })
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });

      // 3. If we have a main game, return it
      if (mainGame) {
        console.log(`✅ Found main game: ${mainGame.code} (Status: ${mainGame.status})`);
        
        // Handle active game without interval
        if (mainGame.status === 'ACTIVE' && !this.activeIntervals.has(mainGame._id.toString())) {
          console.log(`🔄 Restarting auto-calling for active game ${mainGame.code}`);
          this.startAutoNumberCalling(mainGame._id);
        }
        
        // Handle game with all numbers called
        if (mainGame.status === 'ACTIVE' && mainGame.numbersCalled && mainGame.numbersCalled.length >= 75) {
          console.log(`⚠️ Game ${mainGame.code} has all 75 numbers - ending game`);
          await this.endGameDueToNoWinner(mainGame._id);
          return await this.getMainGame(); // Recursively get new game
        }
        
        return this.formatGameForFrontend(mainGame);
      }

      // 4. No main game found - create new one from finished game or brand new
      console.log('📭 No active game found - creating new game...');
      
      // Check for recently finished game
      const finishedGame = await Game.findOne({
        status: { $in: ['FINISHED', 'NO_WINNER'] },
        archived: { $ne: true },
        endedAt: { $gte: new Date(Date.now() - 60000) } // Within last minute
      }).sort({ endedAt: -1 });

      if (finishedGame) {
        console.log(`🔄 Creating new game from finished game ${finishedGame.code}`);
        return await this.createNewGameAfterCooldown(finishedGame._id);
      }

      // Create brand new game
      console.log('🎯 Creating brand new game');
      return await this.createNewGame();
      
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    }
  }

  static async createNewGame() {
    const lockKey = 'create_new_game';
    
    if (this.processingGames.has(lockKey)) {
      console.log('⏳ Game creation already in progress');
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await this.getMainGame();
    }

    try {
      this.processingGames.add(lockKey);
      
      // Double-check no active game exists
      await this.enforceSingleGameRule();
      
      const existingGame = await Game.findOne({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      });

      if (existingGame) {
        console.log(`⚠️ Game ${existingGame.code} already exists, not creating new one`);
        return this.formatGameForFrontend(existingGame);
      }

      // Create new game
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
      console.log(`✅ Created new game: ${gameCode}`);
      
      // Schedule auto-start check
      this.scheduleAutoStartCheck(game._id);
      
      return this.getGameWithDetails(game._id);
      
    } catch (error) {
      console.error('❌ Error creating new game:', error);
      throw error;
    } finally {
      this.processingGames.delete(lockKey);
    }
  }

  // ==================== GAME STATE TRANSITIONS ====================

  static async beginCardSelection(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Enforce single game rule first
      await this.enforceSingleGameRule();
      
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
      
      // Schedule card selection end check
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
        console.log(`❌ Not enough players (${playersWithCards}/${this.MIN_PLAYERS_TO_START}) - returning to waiting`);
        
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
        game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
        await game.save();
        
        this.scheduleAutoStartCheck(gameId);
      }
    } catch (error) {
      console.error('❌ Error checking card selection end:', error);
    }
  }

  // ==================== ENTRY FEE MANAGEMENT (NO DUPLICATES) ====================

  static async processEntryFees(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game) {
        throw new Error('Game not found');
      }

      // Check if fees already processed
      const existingReconciliation = await Reconciliation.findOne({ 
        gameId, 
        status: 'DEDUCTED'
      }).session(session);

      if (existingReconciliation) {
        console.log(`✅ Entry fees already processed for game ${game.code}`);
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

      // Track unique users by their MongoDB _id
      const userCardsMap = new Map(); 
      
      for (const card of bingoCards) {
        const userIdStr = card.userId.toString();
        
        if (!userCardsMap.has(userIdStr)) {
          userCardsMap.set(userIdStr, {
            userId: card.userId,
            cards: []
          });
        }
        
        const userData = userCardsMap.get(userIdStr);
        userData.cards.push(card.cardNumber);
      }

      // Process each UNIQUE user only once
      for (const [userIdStr, userData] of userCardsMap.entries()) {
        // CRITICAL: Check if user already paid for ANY card in this game
        const alreadyPaid = await Transaction.findOne({
          userId: userData.userId,
          gameId: gameId,
          type: 'GAME_ENTRY',
          status: 'COMPLETED'
        }).session(session);
        
        if (alreadyPaid) {
          console.log(`✅ User ${userIdStr} already paid for game ${game.code}. Skipping.`);
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: 0,
            status: 'ALREADY_PAID',
            cardNumbers: userData.cards
          });
          continue;
        }
        
        try {
          const user = await User.findById(userData.userId).session(session);
          if (!user || !user.telegramId) {
            throw new Error(`User ${userIdStr} not found`);
          }

          // Deduct single $10 fee regardless of how many cards
          const result = await WalletService.deductGameEntry(
            user.telegramId,
            gameId,
            this.ENTRY_FEE,
            `Entry fee for game ${game.code}`
          );
          
          reconciliation.transactions.push({
            userId: userData.userId,
            type: 'ENTRY_FEE',
            amount: -this.ENTRY_FEE,
            status: 'COMPLETED',
            transactionId: result.transaction._id,
            cardNumbers: userData.cards
          });
          
          console.log(`✅ Charged $${this.ENTRY_FEE} from user ${userIdStr} for game ${game.code}`);
          
        } catch (error) {
          console.error(`❌ Failed to charge user ${userIdStr}:`, error.message);
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

      // Calculate totals
      const successfulCharges = reconciliation.transactions.filter(tx => 
        tx.status === 'COMPLETED'
      ).length;
      
      reconciliation.totalPot = successfulCharges * this.ENTRY_FEE;
      reconciliation.debitTotal = successfulCharges * this.ENTRY_FEE;
      
      reconciliation.addAudit('ENTRY_FEES_DEDUCTED', {
        gameCode: game.code,
        uniqueUsers: userCardsMap.size,
        successfullyCharged: successfulCharges,
        totalCards: bingoCards.length,
        totalPot: reconciliation.totalPot
      });
      
      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`💰 Entry fees processed: ${successfulCharges}/${userCardsMap.size} users charged. Total pot: $${reconciliation.totalPot}`);
      
      return { success: true, reconciliation };
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ ERROR in processEntryFees:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // ==================== GAME START ====================

  static async startGame(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        console.log(`❌ Game ${gameId} not found`);
        await session.abortTransaction();
        return;
      }
      
      console.log(`📊 Starting game ${game.code} from status: ${game.status}`);
      
      if (game.status !== 'CARD_SELECTION' && game.status !== 'WAITING_FOR_PLAYERS') {
        console.log(`⚠️ Game ${gameId} not in startable state: ${game.status}`);
        await session.abortTransaction();
        return;
      }
      
      const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
      
      if (playersWithCards < this.MIN_PLAYERS_TO_START) {
        console.log(`❌ Not enough players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
        
        game.status = 'WAITING_FOR_PLAYERS';
        game.cardSelectionStartTime = null;
        game.cardSelectionEndTime = null;
        game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
        await game.save({ session });
        
        await session.commitTransaction();
        
        this.scheduleAutoStartCheck(gameId);
        return;
      }
      
      // Process entry fees (with duplicate prevention)
      const feeResult = await this.processEntryFees(gameId);
      
      if (feeResult.alreadyProcessed) {
        console.log(`⚠️ Entry fees already processed`);
        await session.abortTransaction();
        return;
      }
      
      // Start the game
      const now = new Date();
      game.status = 'ACTIVE';
      game.startedAt = now;
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
      game.autoStartEndTime = null;
      game.currentPlayers = playersWithCards;
      
      await game.save({ session });
      await session.commitTransaction();
      
      console.log(`🎮 Game ${game.code} started with ${playersWithCards} players`);
      
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

    console.log(`🔢 Starting auto-number calling for game ${game.code}`);

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
          console.log(`🎯 All numbers called for game ${currentGame.code}`);
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
    console.log(`✅ Auto-calling started for game ${game.code}`);

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

      console.log(`🔢 Called number: ${newNumber} for game ${game.code}. Total called: ${calledNumbers.length}`);
      
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

  // ==================== WINNER MANAGEMENT ====================

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
      
      // Schedule next game
      await this.scheduleNextGame(gameId);
      
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

  // ==================== NO WINNER REFUNDS (NO DUPLICATES) ====================

  static async endGameDueToNoWinner(gameId) {
    const lockKey = `no_winner_${gameId}`;
    
    if (this.processingGames.has(lockKey)) {
      console.log(`⏳ Game ${gameId} already being processed for no-winner`);
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
        await this.scheduleNextGame(gameId);
        return;
      }

      if (game.status !== 'ACTIVE') {
        console.log(`⚠️ Game ${gameId} not active (status: ${game.status})`);
        return;
      }

      // Check if we have ALL 75 numbers
      if (game.numbersCalled.length < 75) {
        console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers`);
        return;
      }

      console.log(`🏁 Ending game ${game.code} - no winner after 75 numbers`);
      
      // Check if already processed
      const alreadyNoWinner = await Game.findOne({
        _id: gameId,
        status: 'NO_WINNER',
        refunded: true
      });
      
      if (alreadyNoWinner) {
        console.log(`✅ Game ${game.code} already marked as NO_WINNER with refunds`);
        return;
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const gameInSession = await Game.findById(gameId).session(session);
        
        if (!gameInSession) {
          console.log(`⚠️ Game ${gameId} not found in session`);
          await session.abortTransaction();
          return;
        }

        if (gameInSession.winnerId) {
          console.log(`✅ Game ${gameInSession.code} has winner in transaction`);
          
          if (gameInSession.status !== 'FINISHED') {
            gameInSession.status = 'FINISHED';
            gameInSession.endedAt = gameInSession.endedAt || new Date();
            await gameInSession.save({ session });
          }
          
          await session.commitTransaction();
          
          this.winnerDeclared.add(gameId.toString());
          this.stopAutoNumberCalling(gameId);
          await this.scheduleNextGame(gameId);
          return;
        }

        if (gameInSession.status !== 'ACTIVE') {
          console.log(`⚠️ Game ${gameId} no longer active`);
          await session.abortTransaction();
          return;
        }

        if (gameInSession.numbersCalled.length < 75) {
          console.log(`⏳ Game ${gameInSession.code} has ${gameInSession.numbersCalled.length}/75 numbers`);
          await session.abortTransaction();
          return;
        }

        // Check if reconciliation already exists
        const existingReconciliation = await Reconciliation.findOne({ 
          gameId: gameInSession._id,
          status: 'NO_WINNER_REFUNDED'
        }).session(session);
        
        if (existingReconciliation) {
          console.log(`✅ Refunds already processed for game ${gameInSession.code}`);
          
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
          console.log(`✅ Found winning card for game ${gameInSession.code}`);
          
          gameInSession.status = 'FINISHED';
          gameInSession.winnerId = winningCard.userId;
          gameInSession.endedAt = gameInSession.endedAt || new Date();
          await gameInSession.save({ session });
          
          await session.commitTransaction();
          
          this.winnerDeclared.add(gameId.toString());
          this.stopAutoNumberCalling(gameId);
          await this.scheduleNextGame(gameId);
          return;
        }

        console.log(`💰 Processing refunds for ${bingoCards.length} cards...`);
        
        const WalletService = require('./walletService');
        
        // Track unique users to prevent duplicate refunds
        const uniqueUsers = new Map();
        let refundTransactions = [];
        
        // First pass: Collect unique users
        for (const card of bingoCards) {
          try {
            const user = await User.findById(card.userId).session(session);
            
            if (user && user.telegramId) {
              if (!uniqueUsers.has(user.telegramId)) {
                uniqueUsers.set(user.telegramId, {
                  userId: card.userId,
                  telegramId: user.telegramId,
                  username: user.username,
                  cards: [],
                  totalRefund: 0
                });
              }
              
              const userData = uniqueUsers.get(user.telegramId);
              userData.cards.push(card.cardNumber);
              userData.totalRefund += this.ENTRY_FEE;
            }
          } catch (error) {
            console.error(`❌ Error processing card ${card._id}:`, error.message);
          }
        }

        // Second pass: Process refunds for unique users (one refund per user)
        for (const [telegramId, userData] of uniqueUsers.entries()) {
          try {
            // CRITICAL: Check if user already received refund for this game
            const existingRefund = await Transaction.findOne({
              userId: userData.userId,
              gameId: gameInSession._id,
              type: 'WINNING',
              description: { $regex: `Refund.*game.*${gameInSession.code}` },
              status: 'COMPLETED'
            }).session(session);
            
            if (existingRefund) {
              console.log(`✅ User ${telegramId} already refunded for game ${gameInSession.code}`);
              refundTransactions.push({
                userId: userData.userId,
                type: 'REFUND',
                amount: userData.totalRefund,
                status: 'ALREADY_REFUNDED',
                transactionId: existingRefund._id,
                cardNumbers: userData.cards
              });
              continue;
            }
            
            // Process SINGLE refund per user (not per card)
            await WalletService.addWinning(
              userData.telegramId,
              gameInSession._id,
              userData.totalRefund,
              `Refund - No winner in game ${gameInSession.code}`,
              session
            );
            
            console.log(`✅ Refunded $${userData.totalRefund} to ${telegramId}`);
            
            refundTransactions.push({
              userId: userData.userId,
              type: 'REFUND',
              amount: userData.totalRefund,
              status: 'COMPLETED',
              cardNumbers: userData.cards
            });
            
          } catch (error) {
            console.error(`❌ Failed to refund user ${telegramId}:`, error.message);
            refundTransactions.push({
              userId: userData.userId,
              type: 'REFUND',
              amount: userData.totalRefund,
              status: 'FAILED',
              error: error.message,
              cardNumbers: userData.cards
            });
          }
        }

        const now = new Date();
        
        // Update game status
        gameInSession.status = 'NO_WINNER';
        gameInSession.endedAt = now;
        gameInSession.winnerId = null;
        gameInSession.noWinner = true;
        gameInSession.refunded = true;
        gameInSession.refundedAt = now;
        gameInSession.totalRefunded = Array.from(uniqueUsers.values())
          .reduce((sum, user) => sum + user.totalRefund, 0);
        gameInSession.uniquePlayersRefunded = uniqueUsers.size;
        
        await gameInSession.save({ session });
        
        // Create reconciliation record
        const reconciliation = new Reconciliation({
          gameId: gameInSession._id,
          status: 'NO_WINNER_REFUNDED',
          totalPot: gameInSession.totalRefunded,
          platformFee: 0,
          winnerAmount: 0,
          debitTotal: gameInSession.totalRefunded,
          creditTotal: gameInSession.totalRefunded,
          completedAt: now,
          transactions: refundTransactions,
          auditTrail: [{
            action: 'NO_WINNER_REFUND_PROCESSED',
            details: {
              uniquePlayers: uniqueUsers.size,
              totalCards: bingoCards.length,
              totalRefunded: gameInSession.totalRefunded
            }
          }]
        });
        
        await reconciliation.save({ session });
        await session.commitTransaction();
        
        console.log(`✅ Game ${gameInSession.code} ended as NO_WINNER. Refunded ${uniqueUsers.size} players, total: $${gameInSession.totalRefunded}`);
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        
        await this.scheduleNextGame(gameId);

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
      console.error('❌ Error in endGameDueNoWinner:', error);
      throw error;
    } finally {
      this.processingGames.delete(lockKey);
    }
  }

  // ==================== SCHEDULE NEXT GAME ====================

  static async scheduleNextGame(gameId) {
    // Wait a moment to ensure all previous transactions are complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if there's already an active/waiting game
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

      // Archive the finished game
      game.archived = true;
      game.archivedAt = new Date();
      game.archivedReason = 'Game finished - archived for next game';
      await game.save({ session });
      
      await session.commitTransaction();
      
      console.log(`📦 Archived game ${game.code}`);
      
      // Create new game after cooldown
      setTimeout(async () => {
        try {
          await this.createNewGameAfterCooldown(gameId);
        } catch (error) {
          console.error('❌ Failed to create new game after countdown:', error);
        }
      }, this.NEXT_GAME_COOLDOWN);
      
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      console.error('❌ Error scheduling next game:', error);
    } finally {
      session.endSession();
    }
  }

  static async createNewGameAfterCooldown(previousGameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Ensure the old game is archived
      const oldGame = await Game.findById(previousGameId).session(session);
      if (oldGame && !oldGame.archived) {
        oldGame.archived = true;
        oldGame.archivedAt = new Date();
        oldGame.archivedReason = 'Replaced by new game';
        await oldGame.save({ session });
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
      
      console.log(`🎯 Created new game: ${gameCode}`);
      
      this.scheduleAutoStartCheck(newGame._id);
      
      return this.getGameWithDetails(newGame._id);
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error creating new game after cooldown:', error);
      
      // Fallback
      try {
        return await this.createNewGame();
      } catch (fallbackError) {
        console.error('❌ Fallback game creation also failed:', fallbackError);
        throw fallbackError;
      }
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

      // Check if user already has a card IN THIS GAME
      const existingCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (existingCard) {
        const previousCardNumber = existingCard.cardNumber;
        
        if (previousCardNumber === cardNumber) {
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
        
        // Replace card
        await BingoCard.deleteOne({ 
          _id: existingCard._id 
        }).session(session);
        
        console.log(`🗑️ Deleted previous card #${previousCardNumber}`);
        
        this.updateCardSelection(gameId, previousCardNumber, mongoUserId, 'RELEASED');
      }

      // Create new card
      const newCard = await BingoCard.create([{
        userId: mongoUserId,
        gameId,
        cardNumber: cardNumber,
        numbers: cardNumbers,
        markedPositions: [12],
        isLateJoiner: game.status !== 'WAITING_FOR_PLAYERS',
        joinedAt: new Date(),
        numbersCalledAtJoin: game.numbersCalled || []
      }], { session });

      // Ensure user is a game player
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
        
        console.log(`✅ User ${userId} joined game ${game.code}. Total players: ${game.currentPlayers}`);
      }

      await session.commitTransaction();
      
      console.log(`✅ User ${userId} selected card #${cardNumber} for game ${game.code}`);
      
      this.updateCardSelection(gameId, cardNumber, mongoUserId, 'CREATED');
      
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

  // ==================== AUTO-START MANAGEMENT ====================

  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Auto-start conditions met: ${playersWithCards} players with cards`);
      await this.beginCardSelection(gameId);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      // Check again in 5 seconds
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
  }

  // ==================== UTILITY METHODS ====================

  static updateCardSelection(gameId, cardNumber, userId, action) {
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
    
    if (action === 'CREATED' || action === 'UPDATED') {
      gameCards.set(cardNumber, {
        userId: userId,
        selectedAt: new Date(),
        action: action
      });
    }
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

  static async formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    const now = new Date();
    
    // Ensure status consistency
    if (gameObj.status === 'WAITING') {
      gameObj.status = 'WAITING_FOR_PLAYERS';
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
        if (gameObj.cardSelectionEndTime) {
          gameObj.cardSelectionTimeRemaining = Math.max(0, gameObj.cardSelectionEndTime - now);
          gameObj.cardSelectionTotalDuration = this.CARD_SELECTION_DURATION;
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
        gameObj.message = 'Game finished!';
        break;
        
      case 'NO_WINNER':
        gameObj.message = 'Next game starting soon...';
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

  static async getActiveGames() {
    try {
      const activeGame = await Game.findOne({
        status: 'ACTIVE',
        archived: { $ne: true }
      })
      .sort({ createdAt: -1 })
      .populate('winnerId', 'username firstName')
      .populate({
        path: 'players',
        populate: {
          path: 'userId',
          select: 'username firstName telegramId'
        }
      });

      if (!activeGame) {
        return [];
      }

      // Check if game should end
      if (activeGame.numbersCalled && activeGame.numbersCalled.length >= 75) {
        console.log(`⚠️ Game ${activeGame.code} has all 75 numbers`);
        await this.endGameDueToNoWinner(activeGame._id);
        return [];
      }

      // Ensure auto-calling is running
      if (!this.activeIntervals.has(activeGame._id.toString())) {
        console.log(`🔄 Restarting auto-calling for active game ${activeGame.code}`);
        this.startAutoNumberCalling(activeGame._id);
      }

      const formattedGame = await this.formatGameForFrontend(activeGame);
      return [formattedGame];
      
    } catch (error) {
      console.error('❌ Error in getActiveGames:', error);
      return [];
    }
  }

  static async getWaitingGames() {
    try {
      const waitingGames = await Game.find({
        status: 'WAITING_FOR_PLAYERS',
        archived: { $ne: true }
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

      const now = new Date();
      const formattedGames = waitingGames.map(game => {
        const gameObj = {
          ...game,
          _id: game._id.toString(),
          message: 'Waiting for players to join...'
        };
        
        if (game.autoStartEndTime && game.autoStartEndTime > now) {
          gameObj.autoStartTimeRemaining = game.autoStartEndTime - now;
          gameObj.hasAutoStartTimer = true;
          gameObj.autoStartTimeFormatted = `${Math.floor((gameObj.autoStartTimeRemaining / 1000) / 60)}:${Math.floor((gameObj.autoStartTimeRemaining / 1000) % 60).toString().padStart(2, '0')}`;
        }
        
        return gameObj;
      });
      
      return formattedGames;
      
    } catch (error) {
      console.error('❌ Error in getWaitingGames:', error);
      return [];
    }
  }

  static startAutoGameService() {
    // Clean up any existing intervals
    this.cleanupAllIntervals();
    
    // Check for active game every 30 seconds
    const interval = setInterval(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Auto-game service error:', error);
      }
    }, 30000);

    console.log('🚀 Game Service Started');
    
    // Initial game setup
    setTimeout(async () => {
      try {
        await this.getMainGame();
      } catch (error) {
        console.error('❌ Initial game setup failed:', error);
      }
    }, 5000);

    return interval;
  }

  static cleanupAllIntervals() {
    console.log(`🧹 Cleaning up ${this.activeIntervals.size} active intervals`);
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
    }
    this.activeIntervals.clear();
    this.winnerDeclared.clear();
    this.processingGames.clear();
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