// services/gameService.js - UPDATED VERSION
const mongoose = require('mongoose');
const Game = require('../models/Game');
const User = require('../models/User');
const GamePlayer = require('../models/GamePlayer');
const BingoCard = require('../models/BingoCard');
const Reconciliation = require('../models/Reconciliation');
const Transaction = require('../models/Transaction');
const GameUtils = require('../utils/gameUtils');

class GameService {
  static activeIntervals = new Map();
  static winnerDeclared = new Set();
  static processingGames = new Set();
  static MIN_PLAYERS_TO_START = 2;
  static selectedCards = new Map();
  static autoStartTimers = new Map();
  static CARD_SELECTION_DURATION = 30000;
  static alreadyScheduledForAutoStart = new Map();
  static NEXT_GAME_COUNTDOWN = 30000;
  
  // Constants for timing
  static AUTO_START_DELAY = 30000;
  static GAME_RESTART_COOLDOWN = 60000;
  static NUMBER_CALL_INTERVAL = 5000;
  
  // ==================== CORE GAME MANAGEMENT ====================
  
static async getMainGame() {
  try {
    console.log('🎮 getMainGame() called - Checking game state...');
    
    // FIRST: Find ALL games that are in active states
    const activeGames = await Game.find({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true }
    })
    .sort({ createdAt: -1 }) // Get newest first
    .populate('winnerId', 'username firstName')
    .populate({
      path: 'players',
      populate: {
        path: 'userId',
        select: 'username firstName telegramId'
      }
    });
    
    console.log(`📊 Found ${activeGames.length} active/waiting games in database`);
    
    // CRITICAL FIX: If we have multiple active games, we need to:
    // 1. Return the newest one
    // 2. Archive/clean up the older ones
    if (activeGames.length > 1) {
      console.warn(`⚠️ MULTIPLE ACTIVE GAMES DETECTED (${activeGames.length})! This is a bug.`);
      console.warn('📋 Games found:');
      activeGames.forEach((game, index) => {
        console.warn(`  ${index + 1}. ${game.code} - ${game.status} (created: ${game.createdAt})`);
      });
      
      // Return the newest game (first in array due to sort)
      const newestGame = activeGames[0];
      console.log(`✅ Returning newest game: ${newestGame.code} (created: ${newestGame.createdAt})`);
      
      // Archive all older games to clean up the mess
      for (let i = 1; i < activeGames.length; i++) {
        const oldGame = activeGames[i];
        console.warn(`🗑️ Archiving duplicate game: ${oldGame.code} (${oldGame.status})`);
        
        // Archive the duplicate game
        oldGame.archived = true;
        oldGame.archivedAt = new Date();
        oldGame.archivedReason = 'Duplicate active game detected by getMainGame()';
        await oldGame.save();
        
        // Also clean up any players/cards for the archived game
        await GamePlayer.deleteMany({ gameId: oldGame._id });
        await BingoCard.deleteMany({ gameId: oldGame._id });
      }
      
      // Check if the newest game is ACTIVE with all numbers
      if (newestGame.status === 'ACTIVE' && newestGame.numbersCalled && newestGame.numbersCalled.length >= 75) {
        console.log(`⚠️ Game ${newestGame.code} has all 75 numbers but still ACTIVE. Forcing end...`);
        await this.endGameDueToNoWinner(newestGame._id);
        
        // Get the updated game after ending
        const updatedGame = await Game.findById(newestGame._id).populate('winnerId').populate({
          path: 'players',
          populate: { path: 'userId' }
        });
        
        // If game is now finished, continue to check for new game
        if (updatedGame && (updatedGame.status === 'FINISHED' || updatedGame.status === 'NO_WINNER')) {
          console.log(`✅ Game ${updatedGame.code} is now finished. Will create new game...`);
          // Continue to the new game creation logic below
        } else {
          // Game is still active/waiting, return it
          if (updatedGame.status === 'ACTIVE' && !this.activeIntervals.has(updatedGame._id.toString())) {
            console.log(`🔄 Restarting auto-calling for active game ${updatedGame.code}`);
            this.startAutoNumberCalling(updatedGame._id);
          }
          return this.formatGameForFrontend(updatedGame || newestGame);
        }
      } else {
        // Game is valid and active/waiting, return it
        if (newestGame.status === 'ACTIVE' && !this.activeIntervals.has(newestGame._id.toString())) {
          console.log(`🔄 Restarting auto-calling for active game ${newestGame.code}`);
          this.startAutoNumberCalling(newestGame._id);
        }
        return this.formatGameForFrontend(newestGame);
      }
    }
    
    // If we have exactly one active game
    if (activeGames.length === 1) {
      const activeGame = activeGames[0];
      console.log(`🎮 Found single existing game: ${activeGame.code} (Status: ${activeGame.status})`);
      
      // Check if active game has all 75 numbers but still ACTIVE
      if (activeGame.status === 'ACTIVE' && activeGame.numbersCalled && activeGame.numbersCalled.length >= 75) {
        console.log(`⚠️ Game ${activeGame.code} has all 75 numbers but still ACTIVE. Forcing end...`);
        await this.endGameDueToNoWinner(activeGame._id);
        
        // Get the updated game after ending
        const updatedGame = await Game.findById(activeGame._id).populate('winnerId').populate({
          path: 'players',
          populate: { path: 'userId' }
        });
        
        // If game is now finished, continue to check for new game
        if (updatedGame && (updatedGame.status === 'FINISHED' || updatedGame.status === 'NO_WINNER')) {
          console.log(`✅ Game ${updatedGame.code} is now finished. Will create new game...`);
        } else {
          // Game is still active/waiting, return it
          return this.formatGameForFrontend(updatedGame || activeGame);
        }
      } else {
        // Game is valid and active/waiting, return it
        if (activeGame.status === 'ACTIVE' && !this.activeIntervals.has(activeGame._id.toString())) {
          console.log(`🔄 Restarting auto-calling for active game ${activeGame.code}`);
          this.startAutoNumberCalling(activeGame._id);
        }
        return this.formatGameForFrontend(activeGame);
      }
    }
    
    // ==================== NO ACTIVE/WAITING/CARD_SELECTION GAME FOUND ====================
    // Only create a new game if NO active/waiting games exist
    
    console.log('📭 No active/waiting games found. Checking for finished games to create new one...');
    
    // Check for COOLDOWN games that need new game creation
    const cooldownGame = await Game.findOne({
      status: { $in: ['FINISHED', 'NO_WINNER', 'COOLDOWN'] },
      cooldownEndTime: { $lte: new Date() },
      archived: { $ne: true }
    }).sort({ createdAt: -1 });
    
    let game;
    
    if (cooldownGame) {
      // Create new game from expired cooldown game
      console.log(`🔄 Creating new game from expired game ${cooldownGame.code}`);
      game = await this.createNewGameAfterCooldown(cooldownGame._id);
    } else {
      // Create a brand new game ONLY if truly no game exists
      const allGamesCount = await Game.countDocuments({
        archived: { $ne: true },
        status: { $nin: ['FINISHED', 'NO_WINNER', 'CANCELLED'] }
      });
      
      if (allGamesCount === 0) {
        console.log('🎮 Creating brand new game...');
        game = await this.createNewGame();
      } else {
        // There are some games that aren't finished yet, find the most recent one
        const mostRecentGame = await Game.findOne({
          archived: { $ne: true }
        }).sort({ createdAt: -1 });
        
        console.log(`⚠️ Found existing game ${mostRecentGame.code} (Status: ${mostRecentGame.status}), returning it instead of creating new.`);
        return this.formatGameForFrontend(mostRecentGame);
      }
    }
    
    return this.formatGameForFrontend(game);
    
  } catch (error) {
    console.error('❌ Error in getMainGame:', error);
    throw error;
  }
}
 static async manageGameLifecycle() {
  try {
    const now = new Date();
    
    // 1. CARD_SELECTION → ACTIVE
    const cardSelectionGames = await Game.find({
      status: 'CARD_SELECTION',
      cardSelectionEndTime: { $lte: now }
    });
    
    for (const game of cardSelectionGames) {
      console.log(`⏰ Card selection ended for game ${game.code}`);
      await this.checkCardSelectionEnd(game._id);
    }
    
    // 2. COOLDOWN → Create new game (handled in getMainGame now)
    const expiredCooldownGames = await Game.find({
      status: 'COOLDOWN',
      cooldownEndTime: { $lte: now },
      archived: { $ne: true }
    });
    
    for (const game of expiredCooldownGames) {
      console.log(`🔄 Cooldown expired for game ${game.code}`);
      // This will be picked up by getMainGame
    }
    
    // 3. FINISHED/NO_WINNER → Set countdown
    const finishedGames = await Game.find({
      status: { $in: ['FINISHED', 'NO_WINNER'] },
      endedAt: { $lt: new Date(now.getTime() - 10000) },
      archived: { $ne: true },
      cooldownEndTime: null // Only if countdown hasn't been set yet
    });
    
    for (const game of finishedGames) {
      // Check if there's already an active/waiting game before setting countdown
      const activeGameExists = await Game.findOne({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      });
      
      if (!activeGameExists) {
        console.log(`🏁 Setting countdown for finished game ${game.code}`);
        await this.setNextGameCountdown(game._id);
      }
    }
    
  } catch (error) {
    console.error('❌ Error managing game lifecycle:', error);
  }
}

 static async createNewGame() {
  try {
    // CRITICAL: Double-check that no active/waiting games exist
    const existingActiveGame = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true }
    });
    
    if (existingActiveGame) {
      console.log(`❌ Cannot create new game: Game ${existingActiveGame.code} already exists (Status: ${existingActiveGame.status})`);
      throw new Error(`Cannot create new game while game ${existingActiveGame.code} is ${existingActiveGame.status}`);
    }
    
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
    console.log(`🎯 Created new game: ${gameCode} - Waiting for players`);
    
    // Schedule auto-start check
    setTimeout(() => {
      this.scheduleAutoStartCheck(game._id);
    }, this.AUTO_START_DELAY);
    
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
      
      console.log(`🎲 Card selection started for game ${game.code}. Ends in ${this.CARD_SELECTION_DURATION/1000} seconds`);
      
      // Schedule check for when card selection ends
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
    
    // Calculate winnings based on unique players
    const entryFee = 10;
    const totalPot = totalUniquePlayers * entryFee;
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
    
    console.log(`🎊 Game ${game.code} ENDED - Winner: ${winningUserId} won $${winnerPrize} from ${totalUniquePlayers} unique players`);
    
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
  
static async endGameDueToNoWinner(gameId) {
  // LOCK: Prevent concurrent execution for the same game
  const lockKey = `no_winner_lock_${gameId}`;
  
  if (this.processingGames.has(lockKey)) {
    console.log(`⏳ Game ${gameId} is already being processed for no-winner ending`);
    return;
  }

  try {
    this.processingGames.add(lockKey);
    
    const game = await Game.findById(gameId);
    
    if (!game) {
      console.log(`⚠️ Game ${gameId} not found`);
      return;
    }

    // CRITICAL CHECK: If game already has a winner, DO NOT process as NO_WINNER
    if (game.winnerId) {
      console.log(`✅ Game ${game.code} already has a winner ${game.winnerId}. Setting status to FINISHED instead of NO_WINNER.`);
      
      // Update game to FINISHED state if it's not already
      if (game.status !== 'FINISHED') {
        game.status = 'FINISHED';
        game.endedAt = game.endedAt || new Date();
        await game.save();
        console.log(`✅ Updated game ${game.code} to FINISHED status`);
      }
      
      this.winnerDeclared.add(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // Set countdown for next game
      await this.setNextGameCountdown(gameId);
      return;
    }

    if (game.status !== 'ACTIVE') {
      console.log(`⚠️ Game ${gameId} is not active (status: ${game.status})`);
      return;
    }

    // Check if we have ALL 75 numbers
    if (game.numbersCalled.length < 75) {
      console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers called. Not ending yet.`);
      return;
    }

    console.log(`🏁 Ending game ${game.code} - no winner after ALL 75 numbers`);
    
    // Check if already processed as NO_WINNER
    const alreadyNoWinner = await Game.findOne({
      _id: gameId,
      status: 'NO_WINNER',
      refunded: true
    });
    
    if (alreadyNoWinner) {
      console.log(`⚠️ Game ${game.code} already marked as NO_WINNER with refunds`);
      return;
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // IMPORTANT: Re-fetch the game within the transaction WITH lock
      const gameInSession = await Game.findById(gameId).session(session);
      
      if (!gameInSession) {
        console.log(`⚠️ Game ${gameId} not found in session`);
        await session.abortTransaction();
        return;
      }

      // DOUBLE CRITICAL CHECK: Verify no winner exists within transaction
      if (gameInSession.winnerId) {
        console.log(`✅ Game ${gameInSession.code} has winner ${gameInSession.winnerId} in transaction. Setting to FINISHED.`);
        
        if (gameInSession.status !== 'FINISHED') {
          gameInSession.status = 'FINISHED';
          gameInSession.endedAt = gameInSession.endedAt || new Date();
          await gameInSession.save({ session });
        }
        
        await session.commitTransaction();
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        await this.setNextGameCountdown(gameId);
        return;
      }

      if (gameInSession.status !== 'ACTIVE') {
        console.log(`⚠️ Game ${gameId} no longer active (status: ${gameInSession.status}), aborting`);
        await session.abortTransaction();
        return;
      }

      // DOUBLE CHECK: Verify numbers called count within transaction
      if (gameInSession.numbersCalled.length < 75) {
        console.log(`⏳ Game ${gameInSession.code} has ${gameInSession.numbersCalled.length}/75 numbers in transaction. Aborting.`);
        await session.abortTransaction();
        return;
      }

      // Check if reconciliation already exists for this game
      const existingReconciliation = await Reconciliation.findOne({ 
        gameId: gameInSession._id,
        status: 'NO_WINNER_REFUNDED'
      }).session(session);
      
      if (existingReconciliation) {
        console.log(`✅ Refunds already processed for game ${gameInSession.code}`);
        
        // Update game status if needed
        if (gameInSession.status !== 'NO_WINNER') {
          gameInSession.status = 'NO_WINNER';
          gameInSession.endedAt = gameInSession.endedAt || new Date();
          await gameInSession.save({ session });
        }
        
        await session.commitTransaction();
        return;
      }

      const bingoCards = await BingoCard.find({ gameId: gameInSession._id }).session(session);
      
      // Check if any card is marked as winner
      const winningCard = await BingoCard.findOne({ 
        gameId: gameInSession._id, 
        isWinner: true 
      }).session(session);
      
      if (winningCard) {
        console.log(`✅ Found winning card for game ${gameInSession.code} (Card #${winningCard.cardNumber}). Game should be FINISHED, not NO_WINNER.`);
        
        // Update game to FINISHED state with winner
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
      
      const entryFee = 10;
      const WalletService = require('./walletService');
      
      // Create a Map to track unique users by telegramId
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
            userData.totalRefund += entryFee;
          }
        } catch (error) {
          console.error(`❌ Error processing card ${card._id}:`, error.message);
        }
      }

      // Second pass: Process refunds for unique users
      for (const [telegramId, userData] of uniqueUsers.entries()) {
        try {
          // Check if user already has a refund transaction for this game
          const existingRefund = await Transaction.findOne({
            userId: userData.userId,
            gameId: gameInSession._id,
            type: 'WINNING',
            description: { $regex: `Refund.*game.*${gameInSession.code}` },
            status: 'COMPLETED'
          }).session(session);
          
          if (existingRefund) {
            console.log(`✅ User ${telegramId} already refunded for game ${gameInSession.code}, skipping`);
            refundTransactions.push({
              userId: userData.userId,
              type: 'REFUND',
              amount: entryFee * userData.cards.length,
              status: 'ALREADY_PROCESSED',
              transactionId: existingRefund._id,
              cardNumbers: userData.cards
            });
            continue;
          }
          
          // Process refund
          const refundAmount = entryFee * userData.cards.length;
          await WalletService.addWinning(
            userData.telegramId,
            gameInSession._id,
            refundAmount,
            `Refund - No winner in game ${gameInSession.code} (Cards: ${userData.cards.join(', ')})`,
            session
          );
          
          console.log(`✅ Refunded $${refundAmount} to ${telegramId} for cards: ${userData.cards.join(', ')}`);
          
          refundTransactions.push({
            userId: userData.userId,
            type: 'REFUND',
            amount: refundAmount,
            status: 'COMPLETED',
            cardNumbers: userData.cards
          });
          
        } catch (error) {
          console.error(`❌ Failed to refund user ${telegramId}:`, error.message);
          refundTransactions.push({
            userId: userData.userId,
            type: 'REFUND',
            amount: entryFee * userData.cards.length,
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
            totalRefunded: gameInSession.totalRefunded,
            timestamp: now
          }
        }]
      });
      
      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`✅ Game ${gameInSession.code} ended as NO_WINNER. ` +
                 `Refunded ${uniqueUsers.size} unique players (${bingoCards.length} cards), ` +
                 `total: $${gameInSession.totalRefunded}`);
      
      // Update in-memory state
      this.winnerDeclared.add(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // Set countdown for next game
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
    console.error('❌ Error in endGameDueNoWinner:', error);
    throw error;
  } finally {
    // Release lock
    this.processingGames.delete(lockKey);
  }
}
  
static async setNextGameCountdown(gameId) {
  // Wait a moment to ensure all previous transactions are complete
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Check if there's already an active/waiting/card selection game
  const activeGameExists = await Game.findOne({
    status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
    archived: { $ne: true },
    _id: { $ne: gameId } // Exclude current game
  });
  
  if (activeGameExists) {
    console.log(`⚠️ Active game already exists (${activeGameExists.code}), skipping countdown for game ${gameId}`);
    return;
  }
  
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const game = await Game.findById(gameId).session(session);
    
    if (!game) {
      throw new Error('Game not found');
    }

    // Only proceed if game IS in FINISHED or NO_WINNER state
    if (game.status !== 'FINISHED' && game.status !== 'NO_WINNER') {
      console.log(`⚠️ Game ${game.code} is not in FINISHED/NO_WINNER state (${game.status}), skipping countdown`);
      await session.abortTransaction();
      return;
    }

    const now = new Date();
    
    // If game is FINISHED (has winner), don't set to NO_WINNER
    if (game.status === 'FINISHED' && game.winnerId) {
      console.log(`✅ Game ${game.code} already FINISHED with winner ${game.winnerId}. Setting cooldown.`);
      game.cooldownEndTime = new Date(now.getTime() + this.NEXT_GAME_COUNTDOWN);
    } else {
      // For NO_WINNER games, ensure they're marked correctly
      game.status = 'NO_WINNER';
      game.cooldownEndTime = new Date(now.getTime() + this.NEXT_GAME_COUNTDOWN);
    }
    
    await game.save({ session });
    await session.commitTransaction();
    
    console.log(`⏰ Next game countdown set for game ${game.code}. New game starts in ${this.NEXT_GAME_COUNTDOWN/1000} seconds`);
    
    // Schedule NEW game creation after countdown
    setTimeout(async () => {
      try {
        await this.createNewGameAfterCooldown(gameId);
      } catch (error) {
        console.error('❌ Failed to create new game after countdown:', error);
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
      previousGameId: previousGameId // Optional: track game lineage
    });

    await newGame.save({ session });
    await session.commitTransaction();
    
    console.log(`🎯 Created new game: ${gameCode} - Waiting for players (Auto-start in ${this.AUTO_START_DELAY/1000}s)`);
    
    // Schedule auto-start check
    setTimeout(() => {
      this.scheduleAutoStartCheck(newGame._id);
    }, this.AUTO_START_DELAY);
    
    return this.getGameWithDetails(newGame._id);
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Error creating new game after cooldown:', error);
    
    // Fallback: try to create game without transaction
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
  // static async resetGameForNewSession(gameId) {
  //   const session = await mongoose.startSession();
  //   session.startTransaction();

  //   try {
  //     const game = await Game.findById(gameId).session(session);
      
  //     if (!game || game.status !== 'COOLDOWN') {
  //       console.log('Game not in cooldown state, skipping reset');
  //       await session.abortTransaction();
  //       return;
  //     }

  //     const now = new Date();
      
  //     // Reset game for new session
  //     game.status = 'WAITING_FOR_PLAYERS';
  //     game.numbersCalled = [];
  //     game.winnerId = null;
  //     game.startedAt = null;
  //     game.endedAt = null;
  //     game.cardSelectionStartTime = null;
  //     game.cardSelectionEndTime = null;
  //     game.cooldownEndTime = null;
  //     game.autoStartEndTime = new Date(now.getTime() + this.AUTO_START_DELAY);
  //     game.currentPlayers = 0;
      
  //     await game.save({ session });
      
  //     // Clear player data
  //     await GamePlayer.deleteMany({ gameId }).session(session);
  //     await BingoCard.deleteMany({ gameId }).session(session);
      
  //     await session.commitTransaction();
      
  //     console.log(`🔄 Game ${game.code} reset for new session. Next auto-start in 30 seconds`);
      
  //     // Schedule auto-start check
  //     setTimeout(() => {
  //       this.scheduleAutoStartCheck(gameId);
  //     }, this.AUTO_START_DELAY);
      
  //   } catch (error) {
  //     await session.abortTransaction();
  //     console.error('❌ Error resetting game:', error);
  //     throw error;
  //   } finally {
  //     session.endSession();
  //   }
  // }
  
  // ==================== ENTRY FEES & RECONCILIATION ====================
  
static async processEntryFees(gameId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const game = await Game.findById(gameId).session(session);
    if (!game) {
      throw new Error('Game not found');
    }

    // 1. FIRST: Check if a DEDUCTED reconciliation already exists.
    const existingReconciliation = await Reconciliation.findOne({ 
      gameId, 
      status: 'DEDUCTED'
    }).session(session);

    if (existingReconciliation) {
      console.log(`⚠️ Entry fees already processed for game ${game.code}. Reconciliation ID: ${existingReconciliation._id}`);
      await session.abortTransaction();
      return { alreadyProcessed: true };
    }

    const bingoCards = await BingoCard.find({ gameId }).session(session);
    const WalletService = require('./walletService');
    const entryFee = 10;
    
    const reconciliation = new Reconciliation({
      gameId: game._id,
      status: 'DEDUCTED',
      totalPot: 0,
      platformFee: 0,
      winnerAmount: 0,
      debitTotal: 0,
      creditTotal: 0
    });

    // 2. CRITICAL: Build a CORRECT map of unique users.
    // Map Key: User's MongoDB _id (as string)
    const userCardsMap = new Map(); 
    
    for (const card of bingoCards) {
      // Use the userId already stored on the bingo card
      const userIdStr = card.userId.toString();
      
      if (!userCardsMap.has(userIdStr)) {
        userCardsMap.set(userIdStr, {
          userId: card.userId, // The actual ObjectId
          cards: []
        });
      }
      
      const userData = userCardsMap.get(userIdStr);
      userData.cards.push(card.cardNumber);
    }

    // 3. Process each UNIQUE user (by MongoDB _id)
    for (const [userIdStr, userData] of userCardsMap.entries()) {
      // FIXED CHECK: Look for ANY existing GAME_ENTRY for this user/game, NOT just in the last minute.
      const alreadyDeducted = await Transaction.findOne({
        userId: userData.userId,
        gameId: gameId,
        type: 'GAME_ENTRY',
        status: 'COMPLETED'
        // REMOVED the incorrect 1-minute time filter
      }).session(session);
      
      if (alreadyDeducted) {
        console.log(`✅ User ${userIdStr} already paid for game ${game.code}. Skipping charge.`);
        
        reconciliation.transactions.push({
          userId: userData.userId,
          type: 'ENTRY_FEE',
          amount: 0, // Amount is 0 because they already paid
          status: 'ALREADY_PROCESSED',
          transactionId: alreadyDeducted._id,
          cardNumbers: userData.cards
        });
        continue; // SKIP the charge for this user entirely
      }
      
      // 4. Deduct the single $10 entry fee for this unique user.
      try {
        // Get the user's telegramId to pass to WalletService
        const user = await User.findById(userData.userId).session(session);
        if (!user || !user.telegramId) {
          throw new Error(`User ${userIdStr} or their telegramId not found`);
        }

        const result = await WalletService.deductGameEntry(
          user.telegramId, // Pass telegramId for the wallet service
          gameId,
          entryFee, // Charge the single $10 fee
          `Entry fee for game ${game.code} (Cards: ${userData.cards.join(', ')})`
        );
        
        reconciliation.transactions.push({
          userId: userData.userId,
          type: 'ENTRY_FEE',
          amount: -entryFee,
          status: 'COMPLETED',
          transactionId: result.transaction._id,
          cardNumbers: userData.cards
        });
        
        console.log(`✅ Correctly deducted $${entryFee} from user ${userIdStr} for game ${game.code}`);
        
      } catch (error) {
        console.error(`❌ Failed to deduct from user ${userIdStr}:`, error.message);
        reconciliation.transactions.push({
          userId: userData.userId,
          type: 'ENTRY_FEE',
          amount: -entryFee,
          status: 'FAILED',
          error: error.message,
          cardNumbers: userData.cards
        });
      }
    }

    // 5. Calculate the total pot correctly: only from SUCCESSFUL charges in this run.
    const successfulCharges = reconciliation.transactions.filter(tx => 
      tx.status === 'COMPLETED'
    ).length;
    
    reconciliation.totalPot = successfulCharges * entryFee;
    reconciliation.debitTotal = successfulCharges * entryFee;
    
    // Add audit trail
    reconciliation.addAudit('ENTRY_FEES_DEDUCTED', {
      gameCode: game.code,
      uniqueUsersAttempted: userCardsMap.size,
      successfullyCharged: successfulCharges,
      totalCards: bingoCards.length,
      entryFee,
      totalPot: reconciliation.totalPot,
      timestamp: new Date()
    });
    
    await reconciliation.save({ session });
    await session.commitTransaction();
    
    console.log(`💰 Entry fees FINAL for game ${game.code}: Attempted ${userCardsMap.size} users, successfully charged ${successfulCharges}. Total pot: $${reconciliation.totalPot}`);
    
    return { success: true, reconciliation };
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ ERROR in processEntryFees:', error);
    throw error;
  } finally {
    session.endSession();
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
        
        console.log(`⏳ Rescheduling auto-start for game ${game.code}`);
        
        setTimeout(() => {
          this.scheduleAutoStartCheck(gameId);
        }, this.AUTO_START_DELAY);
        
        return;
      }
      
      // Process entry fees
      const feeResult = await this.processEntryFees(gameId);
      
      if (feeResult.alreadyProcessed) {
        console.log(`⚠️ Entry fees already processed for game ${game.code}`);
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
      
      console.log(`🎮 Game ${game.code} started with ${game.currentPlayers} player(s).`);
      
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
        throw new Error('Cannot select card - game is not accepting players');
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

      // AUTO-JOIN: First, ensure user is added as a game player
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
        
        console.log(`✅ User ${userId} auto-joined game ${game.code}. Total players: ${game.currentPlayers}`);
      }

      // Check if user already has a card IN THIS GAME
      const existingCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (existingCard) {
        const previousCardNumber = existingCard.cardNumber;
        
        // If user is selecting the SAME card number, just return success
        if (previousCardNumber === cardNumber) {
          console.log(`✅ User ${userId} already has card #${cardNumber} for game ${game.code}`);
          
          await session.commitTransaction();
          
          return { 
            success: true, 
            message: 'Card already selected',
            action: 'ALREADY_SELECTED',
            cardId: existingCard._id,
            cardNumber: cardNumber,
            gameJoined: true
          };
        }
        
        console.log(`🔄 User ${userId} has card #${previousCardNumber}. Replacing with card #${cardNumber}...`);
        
        // 1. DELETE the old card completely
        await BingoCard.deleteOne({ 
          _id: existingCard._id 
        }).session(session);
        
        console.log(`🗑️ Deleted previous card #${previousCardNumber} for user ${userId}`);
        
        // 2. Release the previous card number
        this.updateCardSelection(gameId, previousCardNumber, mongoUserId, 'RELEASED');
        
        // 3. Create NEW card with the new card number
        const newCard = await BingoCard.create([{
          userId: mongoUserId,
          gameId,
          cardNumber: cardNumber, // NEW card number
          numbers: cardNumbers,   // NEW card numbers
          markedPositions: [12],
          isLateJoiner: game.status === 'CARD_SELECTION' || game.status === 'ACTIVE',
          joinedAt: new Date(),
          numbersCalledAtJoin: game.status === 'CARD_SELECTION' || game.status === 'ACTIVE' ? (game.numbersCalled || []) : []
        }], { session });
        
        await session.commitTransaction();
        
        console.log(`✅ User ${user._id} (Telegram: ${user.telegramId}) REPLACED card #${previousCardNumber} with NEW card #${cardNumber} for game ${game.code}`);
        
        this.updateCardSelection(gameId, cardNumber, mongoUserId, 'REPLACED');
        
        return { 
          success: true, 
          message: 'Card replaced successfully',
          action: 'REPLACED',
          cardId: newCard[0]._id,
          cardNumber: cardNumber,
          previousCardNumber: previousCardNumber,
          gameJoined: true
        };
      }

      // Validate card format
      if (!cardNumbers || !Array.isArray(cardNumbers) || cardNumbers.length !== 5) {
        throw new Error('Invalid card format');
      }

      // User doesn't have any card yet - CREATE NEW CARD
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
      if (game.status === 'WAITING_FOR_PLAYERS') {
        this.scheduleAutoStartCheck(gameId);
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
  
  // ==================== GAME QUERIES ====================
  //
static async getActiveGames() {
  try {
    // Check if we have any active game in the database
    let activeGame = await Game.findOne({
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

    console.log(`🔍 Initial active game check: ${activeGame ? activeGame.code : 'No active game found'}`);
    
    // If we found an active game in database
    if (activeGame) {
      // Check if active game has all 75 numbers but still ACTIVE
      if (activeGame.numbersCalled && activeGame.numbersCalled.length >= 75) {
        console.log(`⚠️ Game ${activeGame.code} has all 75 numbers but still ACTIVE. Forcing end...`);
        await this.endGameDueToNoWinner(activeGame._id);
        
        // Re-fetch the game after ending it
        activeGame = await Game.findById(activeGame._id).populate('winnerId').populate({
          path: 'players',
          populate: { path: 'userId' }
        });
        
        // If game is now not ACTIVE, return empty array
        if (!activeGame || activeGame.status !== 'ACTIVE') {
          console.log(`✅ Game ${activeGame?.code} is no longer ACTIVE`);
          return [];
        }
      }
      
      // If game is ACTIVE but no auto-calling, restart it
      if (activeGame.status === 'ACTIVE' && !this.activeIntervals.has(activeGame._id.toString())) {
        console.log(`🔄 Restarting auto-calling for active game ${activeGame.code}`);
        this.startAutoNumberCalling(activeGame._id);
      }
      
      // Format and return the active game
      const formattedGame = await this.formatGameForFrontend(activeGame);
      console.log(`✅ Returning active game: ${formattedGame.code} with ${formattedGame.numbersCalled?.length || 0} numbers called`);
      return [formattedGame];
    }
    
    // ==================== NO ACTIVE GAME FOUND ====================
    // Check if there are any games that should be active but aren't
    // This could happen if server restarted and lost in-memory state
    
    // Check for games in CARD_SELECTION that should have started
    const cardSelectionGame = await Game.findOne({
      status: 'CARD_SELECTION',
      archived: { $ne: true },
      cardSelectionEndTime: { $lte: new Date() }
    }).sort({ createdAt: -1 });
    
    if (cardSelectionGame) {
      console.log(`🔄 Card selection ended for game ${cardSelectionGame.code}, checking if it should start...`);
      
      const playersWithCards = await BingoCard.countDocuments({ gameId: cardSelectionGame._id });
      
      if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
        console.log(`✅ Starting game ${cardSelectionGame.code} with ${playersWithCards} players`);
        await this.startGame(cardSelectionGame._id);
        
        // Get the newly started game
        activeGame = await Game.findById(cardSelectionGame._id)
          .populate('winnerId', 'username firstName')
          .populate({
            path: 'players',
            populate: {
              path: 'userId',
              select: 'username firstName telegramId'
            }
          });
        
        if (activeGame && activeGame.status === 'ACTIVE') {
          this.startAutoNumberCalling(activeGame._id);
          const formattedGame = await this.formatGameForFrontend(activeGame);
          return [formattedGame];
        }
      }
    }
    
    // Check if there's an active game in our intervals but not in database (shouldn't happen, but just in case)
    for (const [gameId] of this.activeIntervals) {
      if (mongoose.Types.ObjectId.isValid(gameId)) {
        const game = await Game.findById(gameId)
          .populate('winnerId', 'username firstName')
          .populate({
            path: 'players',
            populate: {
              path: 'userId',
              select: 'username firstName telegramId'
            }
          });
        
        if (game && game.status === 'ACTIVE') {
          console.log(`🔄 Found active game ${game.code} from intervals cache`);
          const formattedGame = await this.formatGameForFrontend(game);
          return [formattedGame];
        }
      }
    }
    
    console.log(`❌ No active games found at this time`);
    return [];
    
  } catch (error) {
    console.error('❌ Error in getActiveGames:', error);
    return [];
  }
}

// In GameService.js - Replace the getWaitingGames method

static async getWaitingGames() {
  try {
    console.log('🔍 getWaitingGames called - Querying database...');
    
    // First, let's debug what games exist in the system
    const allGames = await Game.find({ archived: { $ne: true } })
      .select('code status maxPlayers currentPlayers createdAt autoStartEndTime')
      .sort({ createdAt: -1 })
      .lean();
    
    console.log('📊 ALL GAMES IN SYSTEM:');
    allGames.forEach(game => {
      console.log(`  - ${game.code}: ${game.status} (created: ${game.createdAt})`);
    });
    
    // Now query specifically for waiting games
    const waitingGames = await Game.find({
      status: 'WAITING_FOR_PLAYERS',
      archived: { $ne: true }
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .select('code status maxPlayers currentPlayers createdAt autoStartEndTime cardSelectionStartTime cardSelectionEndTime')
    .lean();
    
    console.log(`✅ Found ${waitingGames.length} waiting games in database query`);
    
    // Add detailed debugging for each waiting game found
    if (waitingGames.length > 0) {
      console.log('📋 WAITING GAMES DETAILS:');
      waitingGames.forEach((game, index) => {
        console.log(`  Game ${index + 1}:`);
        console.log(`    Code: ${game.code}`);
        console.log(`    Status: ${game.status}`);
        console.log(`    Current Players: ${game.currentPlayers}`);
        console.log(`    Auto-start Time: ${game.autoStartEndTime}`);
        console.log(`    Card Selection: ${game.cardSelectionStartTime ? 'Started' : 'Not started'}`);
        if (game.cardSelectionEndTime) {
          console.log(`    Card Selection Ends: ${game.cardSelectionEndTime}`);
        }
      });
    } else {
      console.log('❌ No waiting games found in database.');
      
      // Check if games exist but with different status
      const gamesWithDifferentStatus = await Game.find({
        archived: { $ne: true },
        status: { $nin: ['FINISHED', 'NO_WINNER', 'CANCELLED'] }
      }).lean();
      
      if (gamesWithDifferentStatus.length > 0) {
        console.log('⚠️ Games with non-finished status:');
        gamesWithDifferentStatus.forEach(game => {
          console.log(`  - ${game.code}: ${game.status}`);
        });
      }
    }
    
    // Add auto-start timer info
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
    
    console.log(`🎯 Returning ${formattedGames.length} formatted waiting games`);
    return formattedGames;
    
  } catch (error) {
    console.error('❌ Error in getWaitingGames:', error);
    console.error('Stack trace:', error.stack);
    return [];
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
      } else {
        // Set default auto-start timer if missing
        gameObj.autoStartEndTime = new Date(now.getTime() + this.AUTO_START_DELAY);
        gameObj.autoStartTimeRemaining = this.AUTO_START_DELAY;
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
      // Ensure startedAt exists
      if (!gameObj.startedAt) {
        gameObj.startedAt = new Date();
        console.log(`🕒 Set missing startedAt for game ${gameObj.code}`);
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
      
    case 'COOLDOWN':
      gameObj.message = 'Next game starting soon...';
      if (gameObj.cooldownEndTime && gameObj.cooldownEndTime > now) {
        gameObj.cooldownTimeRemaining = gameObj.cooldownEndTime - now;
      }
      break;
  }
  
  // Get players with cards
  const bingoCards = await BingoCard.find({ gameId: gameObj._id }).populate('userId');
  const playersWithCards = bingoCards.length;
  
  gameObj.playersWithCards = playersWithCards;
  gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
  
  // Can select card during waiting or card selection phases
  gameObj.canSelectCard = gameObj.status === 'WAITING_FOR_PLAYERS' || 
                        gameObj.status === 'CARD_SELECTION';
  
  // Can join only during waiting phase
  gameObj.canJoin = gameObj.status === 'WAITING_FOR_PLAYERS';
  
  // Add timestamp info
  gameObj.serverTime = now;
  gameObj.isValidActiveGame = gameObj.status === 'ACTIVE' && gameObj.startedAt && gameObj.numbersCalled;
  
  return gameObj;
}
  
  // ==================== OTHER METHODS ====================
  
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
  
  static async joinGame(gameCode, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findOne({ code: gameCode, archived: { $ne: true } }).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      if (game.status !== 'WAITING_FOR_PLAYERS') {
        throw new Error('Game is not accepting new players at this time');
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
      
      // Schedule auto-start check if we have enough players
      if (game.currentPlayers >= this.MIN_PLAYERS_TO_START) {
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
      
      const entryFee = 10;
      const WalletService = require('./walletService');
      
      for (const card of bingoCards) {
        try {
          const user = await User.findById(card.userId).session(session);
          
          if (user && user.telegramId) {
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
          await this.setNextGameCountdown(gameId);;
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
      
      console.log(`📊 Taken cards: ${finalTakenCards.length} unique cards`);
      
      return finalTakenCards;
    } catch (error) {
      console.error('❌ Get taken cards error:', error);
      return [];
    }
  }
  
  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Conditions met for auto-start: ${playersWithCards} players with cards`);
      await this.beginCardSelection(gameId);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START} with cards`);
      
      // Check again in 5 seconds
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
  }
  
  static async claimBingo(gameId, userId, patternType = 'BINGO') {
    const session = await mongoose.startSession();
    
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
      
      // Declare winner
      await this.declareWinnerWithRetry(
        gameId, 
        mongoUserId, 
        { ...bingoCard.toObject(), winningPatternType: winResult.patternType }, 
        winResult.winningPositions
      );
      
      return {
        success: true,
        message: 'Bingo claim successful! You are the winner!',
        patternType: winResult.patternType,
        winningPositions: winResult.winningPositions
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
  
  // ==================== AUTO-START TIMER MANAGEMENT ====================
  
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
  
  static clearAutoStartTimer(gameId) {
    const gameIdStr = gameId.toString();
    
    if (this.autoStartTimers.has(gameIdStr)) {
      const timerInfo = this.autoStartTimers.get(gameIdStr);
      clearTimeout(timerInfo.timer);
      this.autoStartTimers.delete(gameIdStr);
      console.log(`🛑 Cleared auto-start timer for game ${gameId}`);
    }
    
    if (this.alreadyScheduledForAutoStart.has(gameIdStr)) {
      this.alreadyScheduledForAutoStart.delete(gameIdStr);
      console.log(`🛑 Cleared scheduled flag for game ${gameId}`);
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
      console.log(`🛑 Stopped interval for game ${gameId}`);
    }
    this.activeIntervals.clear();
    this.winnerDeclared.clear();
    this.processingGames.clear();
  }
  
  // ==================== ADDITIONAL METHODS FOR ROUTES ====================
  
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
  // Add this method to GameService.js
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

// Update the startGame method to use this check
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
      
      console.log(`⏳ Rescheduling auto-start for game ${game.code}`);
      
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, this.AUTO_START_DELAY);
      
      return;
    }
    
    // Process entry fees
    const feeResult = await this.processEntryFees(gameId);
    
    if (feeResult.alreadyProcessed) {
      console.log(`⚠️ Entry fees already processed for game ${game.code}`);
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
    
    console.log(`🎮 Game ${game.code} started with ${game.currentPlayers} player(s).`);
    
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