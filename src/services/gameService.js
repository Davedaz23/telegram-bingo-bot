// services/gameService.js - SIMPLIFIED VERSION (ALWAYS CREATE NEW GAME)
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
  static MIN_PLAYERS_TO_START = 2;
  static selectedCards = new Map();
  
  // Timing constants
  static CARD_SELECTION_DURATION = 30000; // 30 seconds
  static NUMBER_CALL_INTERVAL = 5000; // 5 seconds
  static AUTO_START_DELAY = 30000; // 30 seconds after game ends
  
  // SINGLE GAME MANAGEMENT SYSTEM - SIMPLIFIED
  static async getMainGame() {
    try {
      // Always get the latest game in CARD_SELECTION or WAITING_FOR_PLAYERS
      let game = await Game.findOne({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      })
      .sort({ createdAt: -1 }) // Get the newest game
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
      
      // Manage game state transitions
      await this.manageGameLifecycle();
      
      return this.formatGameForFrontend(game);
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    }
  }
  
  static async manageGameLifecycle() {
    try {
      const now = new Date();
      
      // 1. Check CARD_SELECTION → ACTIVE transition
      const cardSelectionGames = await Game.find({
        status: 'CARD_SELECTION',
        cardSelectionEndTime: { $lte: now }
      });
      
      for (const game of cardSelectionGames) {
        console.log(`⏰ Card selection period ended for game ${game.code}`);
        
        const playersWithCards = await BingoCard.countDocuments({ gameId: game._id });
        
        if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
          console.log(`✅ Starting game ${game.code} with ${playersWithCards} players`);
          await this.startGame(game._id);
        } else {
          console.log(`❌ Not enough players for game ${game.code}: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
          
          // Archive this game and create a new one
          await this.archiveGame(game._id);
          await this.createNewGame();
        }
      }
      
      // 2. Clean up old finished games (archive them)
      const finishedGames = await Game.find({
        status: { $in: ['FINISHED', 'NO_WINNER'] },
        endedAt: { $lt: new Date(now.getTime() - 60000) }, // Ended > 1 minute ago
        archived: { $ne: true }
      });
      
      for (const game of finishedGames) {
        console.log(`📦 Archiving old game ${game.code}`);
        await this.archiveGame(game._id);
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
        console.log(`❌ Not enough players (${playersWithCards}/${this.MIN_PLAYERS_TO_START})`);
        
        // Archive this game and create new one
        await this.archiveGame(gameId);
        await this.createNewGame();
      }
    } catch (error) {
      console.error('❌ Error checking card selection end:', error);
    }
  }
  
  // SIMPLIFIED: Start auto-number calling
  static async startAutoNumberCalling(gameId) {
    if (this.activeIntervals.has(gameId.toString())) {
      this.stopAutoNumberCalling(gameId);
    }

    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'ACTIVE') {
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
  
  // SIMPLIFIED: Declare winner
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
      
      // Mark card as winner
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
        `Winner prize for game ${game.code}`
      );
      
      this.winnerDeclared.add(gameId.toString());
      
      await session.commitTransaction();
      transactionInProgress = false;
      
      console.log(`🎊 Game ${game.code} ENDED - Winner: ${winningUserId} won $${winnerPrize}`);
      
      this.stopAutoNumberCalling(gameId);
      
      // SIMPLIFIED: Create new game after winner
      setTimeout(async () => {
        await this.archiveGame(gameId);
        await this.createNewGame();
      }, 5000); // Wait 5 seconds before creating new game
      
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
  
  // SIMPLIFIED: End game due to no winner
  static async endGameDueToNoWinner(gameId) {
    try {
      const game = await Game.findById(gameId);
      
      if (!game || game.status !== 'ACTIVE') {
        return;
      }

      if (game.numbersCalled.length < 75) {
        console.log(`⏳ Game ${game.code} has ${game.numbersCalled.length}/75 numbers called. Not ending yet.`);
        return;
      }

      console.log(`🏁 Ending game ${game.code} - no winner after ALL 75 numbers`);
      
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const bingoCards = await BingoCard.find({ gameId }).session(session);
        
        // Refund all players
        console.log(`💰 Refunding ${bingoCards.length} players due to no winner...`);
        
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
        game.noWinner = true;
        game.refunded = true;
        
        await game.save({ session });
        
        // Create reconciliation
        const reconciliation = new Reconciliation({
          gameId: game._id,
          status: 'NO_WINNER_REFUNDED',
          totalPot: bingoCards.length * entryFee,
          platformFee: 0,
          winnerAmount: 0,
          debitTotal: bingoCards.length * entryFee,
          creditTotal: bingoCards.length * entryFee,
          completedAt: now
        });
        
        await reconciliation.save({ session });
        await session.commitTransaction();
        
        console.log(`✅ All refunds processed for game ${game.code}`);
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        
        // SIMPLIFIED: Create new game after no winner
        setTimeout(async () => {
          await this.archiveGame(gameId);
          await this.createNewGame();
        }, 5000); // Wait 5 seconds before creating new game

      } catch (error) {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        console.error('❌ Error ending game due to no winner:', error);
        throw error;
      } finally {
        session.endSession();
      }

    } catch (error) {
      console.error('❌ Error in endGameDueToNoWinner:', error);
      throw error;
    }
  }
  
  // SIMPLIFIED: Process entry fees
  static async processEntryFees(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game) {
        throw new Error('Game not found');
      }

      // Check if already processed
      const existingReconciliation = await Reconciliation.findOne({ 
        gameId, 
        status: { $in: ['DEDUCTED', 'WINNER_DECLARED'] } 
      }).session(session);

      if (existingReconciliation) {
        console.log(`⚠️ Entry fees already processed for game ${game.code}`);
        await session.abortTransaction();
        return { alreadyProcessed: true };
      }

      const bingoCards = await BingoCard.find({ gameId }).session(session);
      const WalletService = require('./walletService');
      const entryFee = 10;
      
      // Create reconciliation
      const reconciliation = new Reconciliation({
        gameId: game._id,
        status: 'DEDUCTED',
        totalPot: bingoCards.length * entryFee,
        platformFee: 0,
        winnerAmount: 0,
        debitTotal: bingoCards.length * entryFee,
        creditTotal: 0
      });

      // Deduct entry fees
      for (const card of bingoCards) {
        const user = await User.findById(card.userId).session(session);
        
        if (user && user.telegramId) {
          try {
            const result = await WalletService.deductGameEntry(
              user.telegramId,
              gameId,
              entryFee,
              `Entry fee for game ${game.code}`
            );
            
            reconciliation.transactions.push({
              userId: card.userId,
              type: 'ENTRY_FEE',
              amount: -entryFee,
              status: 'COMPLETED',
              transactionId: result.transaction._id
            });
            
            console.log(`✅ Deducted $${entryFee} from ${user.telegramId}`);
          } catch (error) {
            console.error(`❌ Failed to deduct from user ${user.telegramId}:`, error.message);
            reconciliation.transactions.push({
              userId: card.userId,
              type: 'ENTRY_FEE',
              amount: -entryFee,
              status: 'FAILED',
              error: error.message
            });
          }
        }
      }

      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`💰 Entry fees processed for game ${game.code}`);
      
      return { success: true, reconciliation };
      
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Error processing entry fees:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
  
  // SIMPLIFIED: Start game
  static async startGame(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game || (game.status !== 'CARD_SELECTION' && game.status !== 'WAITING_FOR_PLAYERS')) {
        console.log(`⚠️ Game not in correct state to start: ${game?.status}`);
        await session.abortTransaction();
        return;
      }
      
      const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
      
      if (playersWithCards < this.MIN_PLAYERS_TO_START) {
        console.log(`❌ Not enough players to start game ${game.code}: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
        await session.abortTransaction();
        
        // Archive and create new game
        await this.archiveGame(gameId);
        await this.createNewGame();
        return;
      }
      
      // Process entry fees
      const feeResult = await this.processEntryFees(gameId);
      
      if (feeResult.alreadyProcessed) {
        console.log(`⚠️ Entry fees already processed for game ${game.code}`);
        await session.abortTransaction();
        return;
      }
      
      // Start the game!
      const now = new Date();
      game.status = 'ACTIVE';
      game.startedAt = now;
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
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
  
  // SIMPLIFIED: Archive game
  static async archiveGame(gameId) {
    try {
      const game = await Game.findById(gameId);
      if (!game) return;
      
      game.archived = true;
      game.archivedAt = new Date();
      await game.save();
      
      console.log(`📦 Game ${game.code} archived`);
      
      return game;
    } catch (error) {
      console.error('❌ Error archiving game:', error);
      throw error;
    }
  }
  
  // SIMPLIFIED: Schedule auto-start check
  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Auto-start: ${playersWithCards} players with cards`);
      await this.beginCardSelection(gameId);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      // Check again in 5 seconds
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
  }
  
  // SIMPLIFIED: Format game for frontend
  static async formatGameForFrontend(game) {
    if (!game) return null;
    
    const gameObj = game.toObject ? game.toObject() : { ...game };
    const now = new Date();
    
    // Add status-specific information
    switch (gameObj.status) {
      case 'WAITING_FOR_PLAYERS':
        gameObj.message = 'Waiting for players to join...';
        if (gameObj.autoStartEndTime && gameObj.autoStartEndTime > now) {
          const timeRemaining = gameObj.autoStartEndTime - now;
          gameObj.autoStartTimeRemaining = Math.max(0, timeRemaining);
        }
        break;
        
      case 'CARD_SELECTION':
        gameObj.message = 'Select your bingo card!';
        if (gameObj.cardSelectionEndTime && gameObj.cardSelectionEndTime > now) {
          const timeRemaining = gameObj.cardSelectionEndTime - now;
          gameObj.cardSelectionTimeRemaining = Math.max(0, timeRemaining);
        }
        break;
        
      case 'ACTIVE':
        gameObj.message = 'Game in progress!';
        break;
        
      case 'FINISHED':
        gameObj.message = `Game finished! Winner: ${gameObj.winnerId?.username || 'Unknown'}`;
        break;
        
      case 'NO_WINNER':
        gameObj.message = 'Game ended with no winner - All players refunded';
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
    
    return gameObj;
  }
  
  // SIMPLIFIED: Select card
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

      // Check if card number is taken
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

      // Check if user already has a card
      const existingCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);
      
      if (existingCard) {
        // Update existing card
        existingCard.numbers = cardNumbers;
        existingCard.cardNumber = cardNumber;
        existingCard.markedPositions = [12];
        existingCard.updatedAt = new Date();
        
        await existingCard.save({ session });
        
        await session.commitTransaction();
        
        console.log(`✅ User updated card #${cardNumber} for game ${game.code}`);
        
        return { 
          success: true, 
          message: 'Card updated successfully',
          action: 'UPDATED',
          cardId: existingCard._id
        };
      }

      // Validate card format
      if (!cardNumbers || !Array.isArray(cardNumbers) || cardNumbers.length !== 5) {
        throw new Error('Invalid card format');
      }

      // Create new card
      const newCard = await BingoCard.create([{
        userId: mongoUserId,
        gameId,
        cardNumber: cardNumber,
        numbers: cardNumbers,
        markedPositions: [12],
        joinedAt: new Date()
      }], { session });

      await session.commitTransaction();
      
      console.log(`✅ User created new card #${cardNumber} for game ${game.code}`);
      
      // Check if we should schedule auto-start
      if (game.status === 'WAITING_FOR_PLAYERS') {
        this.scheduleAutoStartCheck(gameId);
      }

      return { 
        success: true, 
        message: 'Card selected successfully',
        action: 'CREATED',
        cardId: newCard[0]._id
      };
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Select card error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }
  
  // SIMPLIFIED: Join game
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
  
  // SIMPLIFIED: Get game with details
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
  
  // SIMPLIFIED: Get available cards
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
  
  // SIMPLIFIED: Claim bingo
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
      const effectiveMarkedPositions = [...bingoCard.markedPositions];
      
      // Always include FREE space
      if (!effectiveMarkedPositions.includes(12)) {
        effectiveMarkedPositions.push(12);
      }

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
  
  // Keep the win condition check
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
      { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] }
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
  
  // Start auto game service
  static startAutoGameService() {
    // Clean up any existing intervals
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
    }
    this.activeIntervals.clear();
    
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
  
  // Cleanup on shutdown
  static cleanupAllIntervals() {
    console.log(`🧹 Cleaning up ${this.activeIntervals.size} active intervals`);
    for (const [gameId, interval] of this.activeIntervals) {
      clearInterval(interval);
    }
    this.activeIntervals.clear();
    this.winnerDeclared.clear();
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