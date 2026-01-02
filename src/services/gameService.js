// services/gameService.js - UPDATED FOR AUTO-MARKING SYSTEM WITH WEBSOCKET
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
  
  // Track bingo claims for disqualification
  static bingoClaims = new Map(); // gameId -> { userId, timestamp, isDisqualified }
  
  // WebSocket service reference
  static webSocketService = null;
  
  // Constants
  static MIN_PLAYERS_TO_START = 2;
  static CARD_SELECTION_DURATION = 30000;
  static AUTO_START_DELAY = 30000;
  static NUMBER_CALL_INTERVAL = 5000;
  static GAME_RESTART_COOLDOWN = 60000;
  static ENTRY_FEE = 10;
  
  // ==================== WEBSOCKET INTEGRATION ====================
  
  static setWebSocketService(service) {
    this.webSocketService = service;
    console.log('🔗 WebSocket service injected into GameService');
  }
  
  static broadcastToGame(gameId, message, excludeUserIds = []) {
    if (!this.webSocketService) {
      console.log('⚠️ WebSocket service not available for broadcasting');
      return;
    }
    
    try {
      this.webSocketService.broadcastToGame(gameId.toString(), {
        ...message,
        timestamp: new Date().toISOString()
      }, excludeUserIds);
      
      console.log(`📤 Broadcast to game ${gameId}: ${message.type}`);
    } catch (error) {
      console.error('❌ Error broadcasting to game:', error);
    }
  }
  
  static sendToUser(userId, message) {
    if (!this.webSocketService) {
      console.log('⚠️ WebSocket service not available for user message');
      return false;
    }
    
    try {
      return this.webSocketService.sendToUser(userId, {
        ...message,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error sending to user:', error);
      return false;
    }
  }
  
  static broadcastTakenCardsUpdate(gameId, takenCards) {
    if (!this.webSocketService) return;
    
    try {
      this.webSocketService.broadcastTakenCards(gameId.toString(), takenCards);
      console.log(`📤 Broadcast taken cards update for game ${gameId}: ${takenCards.length} cards`);
    } catch (error) {
      console.error('❌ Error broadcasting taken cards:', error);
    }
  }
  
  static broadcastGameStatus(gameId, gameData) {
    if (!this.webSocketService) return;
    
    try {
      const statusUpdate = {
        type: 'GAME_STATUS_UPDATE',
        gameId: gameId.toString(),
        status: gameData.status,
        currentNumber: gameData.currentNumber || null,
        calledNumbers: gameData.calledNumbers || [],
        totalCalled: (gameData.calledNumbers || []).length,
        message: this.getGameStatusMessage(gameData.status)
      };
      
      this.webSocketService.broadcastGameStatus(gameId.toString(), statusUpdate);
      console.log(`📤 Broadcast game status for ${gameId}: ${gameData.status}`);
    } catch (error) {
      console.error('❌ Error broadcasting game status:', error);
    }
  }
  
  static getGameStatusMessage(status) {
    switch (status) {
      case 'WAITING_FOR_PLAYERS':
        return 'Waiting for players to join...';
      case 'CARD_SELECTION':
        return 'Select your bingo card!';
      case 'ACTIVE':
        return 'Game in progress!';
      case 'FINISHED':
        return 'Game finished!';
      case 'NO_WINNER':
        return 'Next game starting soon...';
      default:
        return 'Game status updated';
    }
  }

  // ==================== CORE GAME LIFECYCLE ====================

  static async getMainGame() {
    const lockKey = 'get_main_game';
    
    if (this.processingGames.has(lockKey)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.getMainGame();
    }

    try {
      this.processingGames.add(lockKey);
      
      console.log('🎮 getMainGame() - Checking game state...');
      
      await this.cleanupDuplicateGames();
      
      const game = await this.getCurrentGameState();
      
      console.log(`✅ Main game: ${game.code} (Status: ${game.status})`);
      
      // Broadcast if WebSocket is available
      if (this.webSocketService && game.status) {
        this.broadcastGameStatus(game._id, game);
      }
      
      return this.formatGameForFrontend(game);
      
    } catch (error) {
      console.error('❌ Error in getMainGame:', error);
      throw error;
    } finally {
      this.processingGames.delete(lockKey);
    }
  }
// ==================== GET CURRENT GAME STATE ====================

 static async getCurrentGameState() {
  try {
    // First, check for active game
    let game = await this.findActiveGame();
    
    if (game) {
      console.log(`✅ Found active game: ${game.code}`);
      return game;
    }
    
    // Check for waiting or card selection game
    game = await this.findWaitingOrCardSelectionGame();
    
    if (game) {
      console.log(`✅ Found game in progress: ${game.code} (${game.status})`);
       // If game is stuck in CARD_SELECTION past its end time, check it
      if (game.status === 'CARD_SELECTION' && game.cardSelectionEndTime) {
        const now = new Date();
        if (game.cardSelectionEndTime <= now) {
          console.log(`🔄 Game ${game.code} stuck in CARD_SELECTION, checking...`);
          await this.checkCardSelectionEnd(game._id);
          
          // Get updated game
          game = await Game.findById(game._id);
        }
      }
      
      return game;
  
    }
    
    // Check for games that need to be restarted (finished games)
    game = await Game.findOne({
      status: { $in: ['FINISHED', 'NO_WINNER'] },
      archived: { $ne: true }
    }).sort({ endedAt: -1 });
    
    if (game) {
      console.log(`🔄 Creating new game after finished game: ${game.code}`);
      return await this.createNewGameAfterCooldown(game._id);
    }
    
    // No game exists at all - create brand new one
    console.log('🎮 Creating brand new game...');
    return await this.createNewGame();
    
  } catch (error) {
    console.error('❌ Error in getCurrentGameState:', error);
    
    // Try to create new game as fallback
    try {
      return await this.createNewGame();
    } catch (createError) {
      console.error('❌ Fallback game creation failed:', createError);
      throw error;
    }
  }
}

// ==================== FIND ACTIVE GAME ====================
static async findActiveGame() {
  const game = await Game.findOne({
    status: 'ACTIVE',
    archived: { $ne: true }
  }).sort({ createdAt: -1 });
  
  if (game) {
    // Check if game should end due to all numbers called
    if (game.numbersCalled && game.numbersCalled.length >= 75) {
      console.log(`⚠️ Game ${game.code} has all 75 numbers. Ending...`);
      
      // End the game and create new one
      await this.endGameDueToNoWinner(game._id);
      
      // Return the newly created game instead
      const newGame = await Game.findOne({
        status: 'WAITING_FOR_PLAYERS',
        archived: { $ne: true }
      }).sort({ createdAt: -1 });
      
      return newGame;
    }
    
    if (!this.activeIntervals.has(game._id.toString())) {
      console.log(`🔄 Restarting auto-calling for ${game.code}`);
      this.startAutoNumberCalling(game._id);
    }
    
    return game;
  }
  
  return null;
}

  // Add method to check if player can join a game
  static async canPlayerJoinGame(gameId, userId) {
    try {
      let user;
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId);
      } else {
        user = await User.findOne({ telegramId: userId });
      }

      if (!user) return true; // New users can always join
      
      // Check if player is disqualified from this specific game
      const existingPlayer = await GamePlayer.findOne({
        gameId,
        userId: user._id,
        disqualified: true
      });
      
      if (existingPlayer) {
        console.log(`⛔ Player ${userId} is disqualified from game ${gameId}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error checking player eligibility:', error);
      return true; // Default to allowing join on error
    }
  }

  // ==================== AUTO-MARKING & WIN VALIDATION ====================

  static async claimBingo(gameId, userId, patternType = 'BINGO') {
    const session = await mongoose.startSession();
    
    try {
      console.log(`🏆 BINGO CLAIM attempt by ${userId} for game ${gameId}`);
      
      // Check if winner already declared
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
      
      // Check if user is already disqualified from this game
      const existingPlayer = await GamePlayer.findOne({
        gameId,
        userId: mongoUserId,
        disqualified: true
      }).session(session);
      
      if (existingPlayer) {
        throw new Error('You have been disqualified from this game');
      }

      // Check previous false claims for this user in this game
      const claimKey = `${gameId}_${mongoUserId}`;
      if (this.bingoClaims.has(claimKey)) {
        const previousClaim = this.bingoClaims.get(claimKey);
        if (previousClaim.isDisqualified) {
          throw new Error('You have been disqualified for a false bingo claim');
        }
      }

      const bingoCard = await BingoCard.findOne({ 
        gameId, 
        userId: mongoUserId 
      }).session(session);

      if (!bingoCard) {
        throw new Error('No bingo card found');
      }

      // Check if card is already disqualified
      if (bingoCard.isDisqualified) {
        throw new Error('Your card has been disqualified');
      }

      // Get all called numbers
      const calledNumbers = game.numbersCalled || [];
      
      // Get user's card numbers
      const cardNumbers = bingoCard.numbers.flat();
      
      // Get manually marked positions
      const manuallyMarkedPositions = bingoCard.markedPositions || [];
      
      // Always include FREE space
      const effectiveMarkedPositions = [...new Set([...manuallyMarkedPositions, 12])];
      
      console.log(`📊 User ${userId} has ${manuallyMarkedPositions.length} manually marked positions`);
      console.log(`🔢 Total called numbers: ${calledNumbers.length}`);
      
      // Check for winning condition with auto-marking logic
      const winResult = this.checkWinningConditionWithAutoMark(
        cardNumbers, 
        effectiveMarkedPositions, 
        calledNumbers
      );
      
      if (!winResult.isWinner) {
        // Player claimed bingo without valid win - DISQUALIFY PERMANENTLY
        console.log(`❌ INVALID BINGO CLAIM by ${userId} - DISQUALIFYING PERMANENTLY`);
        
        // Disqualify the player from the game
        await this.disqualifyPlayer(gameId, mongoUserId, session, {
          reason: 'False bingo claim',
          claimedPattern: patternType,
          markedPositions: manuallyMarkedPositions.length,
          calledNumbersAtClaim: calledNumbers.length
        });
        
        // Record the claim as disqualified
        this.bingoClaims.set(claimKey, {
          userId: mongoUserId,
          timestamp: new Date(),
          isDisqualified: true,
          isWinner: false,
          reason: 'False bingo claim'
        });
        
        // Also mark the card as disqualified
        bingoCard.isDisqualified = true;
        bingoCard.disqualifiedAt = new Date();
        bingoCard.disqualificationReason = 'False bingo claim';
        await bingoCard.save({ session });
        
        // Remove player from active game participants
        const gamePlayer = await GamePlayer.findOne({ 
          gameId, 
          userId: mongoUserId 
        }).session(session);
        
        if (gamePlayer) {
          gamePlayer.disqualified = true;
          gamePlayer.disqualifiedAt = new Date();
          gamePlayer.disqualificationReason = 'False bingo claim';
          await gamePlayer.save({ session });
        }
        
        // Decrement current players count
        game.currentPlayers = Math.max(0, game.currentPlayers - 1);
        await game.save({ session });
        
        // Broadcast disqualification
        this.broadcastToGame(gameId, {
          type: 'PLAYER_DISQUALIFIED',
          userId: mongoUserId,
          reason: 'False bingo claim',
          timestamp: new Date().toISOString()
        }, [mongoUserId.toString()]);
        
        throw new Error('Invalid bingo claim - You have been disqualified from this game');
      }

      console.log(`✅ VALID BINGO CLAIM by ${userId} with ${winResult.patternType}`);
      console.log(`🔄 Auto-marked positions: ${winResult.autoMarkedPositions?.length || 0}`);
      
      // Update the card with auto-marked positions
      if (winResult.autoMarkedPositions && winResult.autoMarkedPositions.length > 0) {
        const newMarkedPositions = [...new Set([
          ...bingoCard.markedPositions,
          ...winResult.autoMarkedPositions
        ])];
        
        bingoCard.markedPositions = newMarkedPositions;
        bingoCard.autoMarkedPositions = winResult.autoMarkedPositions;
        await bingoCard.save({ session });
        
        console.log(`✅ Updated card with auto-marked positions: ${winResult.autoMarkedPositions}`);
      }
      
      // Record valid claim
      this.bingoClaims.set(claimKey, {
        userId: mongoUserId,
        timestamp: new Date(),
        isDisqualified: false,
        isWinner: true,
        patternType: winResult.patternType
      });
      
      // Declare winner
      const result = await this.declareWinnerWithRetry(
        gameId, 
        mongoUserId, 
        { 
          ...bingoCard.toObject(), 
          winningPatternType: winResult.patternType,
          autoMarkedPositions: winResult.autoMarkedPositions || []
        }, 
        winResult.winningPositions
      );
      
      // Broadcast bingo claim success
      this.broadcastToGame(gameId, {
        type: 'BINGO_CLAIMED',
        userId: mongoUserId,
        patternType: winResult.patternType,
        isWinner: true,
        timestamp: new Date().toISOString()
      });
      
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
      
      // Broadcast failed bingo claim
      if (this.webSocketService) {
        try {
          this.sendToUser(userId, {
            type: 'BINGO_CLAIM_FAILED',
            error: error.message,
            timestamp: new Date().toISOString()
          });
        } catch (wsError) {
          console.error('❌ Error sending bingo claim failed message:', wsError);
        }
      }
      
      throw error;
    } finally {
      session.endSession();
    }
  }

  // New method to disqualify a player permanently from a game
  static async disqualifyPlayer(gameId, userId, session, details = {}) {
    try {
      console.log(`⛔ Disqualifying player ${userId} from game ${gameId}`);
      
      // Mark player as disqualified in GamePlayer
      await GamePlayer.findOneAndUpdate(
        { gameId, userId },
        { 
          disqualified: true,
          disqualifiedAt: new Date(),
          disqualificationReason: details.reason || 'False bingo claim',
          disqualificationDetails: details
        },
        { session, upsert: true }
      );
      
      // Mark all cards from this player in this game as disqualified
      await BingoCard.updateMany(
        { gameId, userId },
        {
          isDisqualified: true,
          disqualifiedAt: new Date(),
          disqualificationReason: details.reason || 'False bingo claim'
        },
        { session }
      );
      
      // Add to disqualified claims tracker
      const claimKey = `${gameId}_${userId}`;
      this.bingoClaims.set(claimKey, {
        userId,
        timestamp: new Date(),
        isDisqualified: true,
        details
      });
      
      console.log(`✅ Player ${userId} disqualified from game ${gameId}`);
      
    } catch (error) {
      console.error('❌ Error disqualifying player:', error);
      throw error;
    }
  }

  static checkWinningConditionWithAutoMark(cardNumbers, markedPositions, calledNumbers) {
    if (!cardNumbers || !markedPositions) {
      return { isWinner: false, patternType: null, winningPositions: [], autoMarkedPositions: [] };
    }

    const effectiveMarked = [...markedPositions];
    
    // Define all possible winning patterns
    const winningPatterns = [
      // Rows (5 positions each)
      { type: 'ROW', positions: [0, 1, 2, 3, 4] },
      { type: 'ROW', positions: [5, 6, 7, 8, 9] },
      { type: 'ROW', positions: [10, 11, 12, 13, 14] },
      { type: 'ROW', positions: [15, 16, 17, 18, 19] },
      { type: 'ROW', positions: [20, 21, 22, 23, 24] },
      
      // Columns (5 positions each)
      { type: 'COLUMN', positions: [0, 5, 10, 15, 20] },
      { type: 'COLUMN', positions: [1, 6, 11, 16, 21] },
      { type: 'COLUMN', positions: [2, 7, 12, 17, 22] },
      { type: 'COLUMN', positions: [3, 8, 13, 18, 23] },
      { type: 'COLUMN', positions: [4, 9, 14, 19, 24] },
      
      // Diagonals (5 positions each)
      { type: 'DIAGONAL', positions: [0, 6, 12, 18, 24] },
      { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] },
      
      // Four Corners (special pattern - 4 positions)
      { type: 'FOUR_CORNERS', positions: [0, 4, 20, 24] }
    ];

    // Check each pattern
    for (const pattern of winningPatterns) {
      const patternPositions = pattern.positions;
      
      // Count marked positions in this pattern
      const markedInPattern = patternPositions.filter(pos => effectiveMarked.includes(pos));
      const unmarkedInPattern = patternPositions.filter(pos => !effectiveMarked.includes(pos));
      
      // If all positions are already marked, it's a regular win
      if (markedInPattern.length === patternPositions.length) {
        return {
          isWinner: true,
          patternType: pattern.type,
          winningPositions: patternPositions,
          autoMarkedPositions: []
        };
      }
      
      // Check if we have 4 out of 5 marked (or 3 out of 4 for four corners)
      // and the remaining ones are in called numbers
      const requiredMarked = pattern.type === 'FOUR_CORNERS' ? 3 : 4;
      
      if (markedInPattern.length >= requiredMarked) {
        // Check if unmarked positions have been called
        const autoMarkablePositions = [];
        
        for (const unmarkedPos of unmarkedInPattern) {
          const unmarkedNumber = cardNumbers[unmarkedPos];
          
          // Skip FREE space (already included in marked positions)
          if (unmarkedNumber === 'FREE') continue;
          
          // Check if this number has been called
          if (calledNumbers.includes(unmarkedNumber)) {
            autoMarkablePositions.push(unmarkedPos);
          }
        }
        
        // For regular patterns (5 positions): need 4 marked + 1 auto-markable
        // For four corners (4 positions): need 3 marked + 1 auto-markable
        const requiredAutoMarks = pattern.type === 'FOUR_CORNERS' ? 1 : 1;
        
        if (autoMarkablePositions.length >= requiredAutoMarks) {
          // Take the required number of auto-marks
          const finalAutoMarks = autoMarkablePositions.slice(0, requiredAutoMarks);
          const finalMarkedPositions = [...effectiveMarked, ...finalAutoMarks];
          
          // Verify the pattern is now complete
          const isComplete = patternPositions.every(pos => finalMarkedPositions.includes(pos));
          
          if (isComplete) {
            return {
              isWinner: true,
              patternType: pattern.type,
              winningPositions: patternPositions,
              autoMarkedPositions: finalAutoMarks
            };
          }
        }
      }
    }

    return { isWinner: false, patternType: null, winningPositions: [], autoMarkedPositions: [] };
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
    
    // Don't check for existing games - always create if no active/waiting game exists
    const existingGame = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true }
    });
    
    if (existingGame) {
      console.log(`🎮 Existing game found: ${existingGame.code} (${existingGame.status})`);
      return existingGame;
    }
    
    const gameCode = GameUtils.generateGameCode();
    const now = new Date();
    
    const game = new Game({
      code: gameCode,
      maxPlayers: 400, // Increase max players
      isPrivate: false,
      numbersCalled: [],
      status: 'WAITING_FOR_PLAYERS',
      currentPlayers: 0,
      isAutoCreated: true,
      autoStartEndTime: new Date(now.getTime() + this.AUTO_START_DELAY),
      createdAt: now,
      updatedAt: now
    });

    await game.save();
    console.log(`🎯 Created new game: ${gameCode} (ID: ${game._id})`);
    
    // Broadcast new game created
    this.broadcastToGame(game._id, {
      type: 'NEW_GAME_CREATED',
      gameId: game._id,
      gameCode: game.code,
      status: game.status,
      autoStartTime: game.autoStartEndTime,
      timestamp: new Date().toISOString()
    });
    
    // Schedule auto-start check
    this.scheduleAutoStartCheck(game._id);
    
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
  
  try {
    session.startTransaction();
    
    // Archive the old game
    const oldGame = await Game.findById(previousGameId).session(session);
    if (oldGame) {
      oldGame.archived = true;
      oldGame.archivedAt = new Date();
      oldGame.archivedReason = 'Game ended - replaced by new game';
      await oldGame.save({ session });
      console.log(`📦 Archived game ${oldGame.code}`);
    }

    // Create new game
    const gameCode = GameUtils.generateGameCode();
    const now = new Date();
    
    const newGame = new Game({
      code: gameCode,
      maxPlayers: 400,
      isPrivate: false,
      numbersCalled: [],
      status: 'WAITING_FOR_PLAYERS',
      currentPlayers: 0,
      isAutoCreated: true,
      autoStartEndTime: new Date(now.getTime() + this.AUTO_START_DELAY),
      previousGameId: previousGameId,
      createdAt: now,
      updatedAt: now
    });

    await newGame.save({ session });
    await session.commitTransaction();
    
    console.log(`🎯 Created new game after cooldown: ${gameCode} (ID: ${newGame._id})`);
    
    // Broadcast new game created
    this.broadcastToGame(newGame._id, {
      type: 'NEW_GAME_CREATED',
      gameId: newGame._id,
      gameCode: newGame.code,
      status: newGame.status,
      autoStartTime: newGame.autoStartEndTime,
      timestamp: new Date().toISOString()
    });
    
    // Schedule auto-start check
    this.scheduleAutoStartCheck(newGame._id);
    
    return newGame;
    
  } catch (error) {
    if (session && session.inTransaction()) {
      await session.abortTransaction();
    }
    
    console.error('❌ Error creating new game after cooldown:', error);
    
    // Fallback: try to create a simple new game
    try {
      console.log('🔄 Trying fallback game creation...');
      return await this.createNewGame();
    } catch (fallbackError) {
      console.error('❌ Fallback game creation failed:', fallbackError);
      throw error;
    }
  } finally {
    if (session) {
      session.endSession();
    }
  }
}

  static async cleanupDuplicateGames() {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const activeGames = await Game.find({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true }
      }).session(session).sort({ createdAt: -1 });

      if (activeGames.length <= 1) {
        await session.abortTransaction();
        return false;
      }

      console.warn(`⚠️ Found ${activeGames.length} active games - cleaning duplicates`);
      
      const newestGame = activeGames[0];
      console.log(`✅ Keeping newest game: ${newestGame.code}`);

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
    console.log(`⏰ Card selection ends at: ${cardSelectionEndTime}`);
    
    // Broadcast card selection start
    this.broadcastToGame(gameId, {
      type: 'CARD_SELECTION_STARTED',
      gameId: game._id,
      endTime: cardSelectionEndTime.toISOString(),
      duration: this.CARD_SELECTION_DURATION,
      timestamp: new Date().toISOString()
    });
    
    // Broadcast game status update
    this.broadcastGameStatus(gameId, game);
    
    // IMPORTANT: Set timeout to check card selection end
    setTimeout(async () => {
      await this.checkCardSelectionEnd(gameId);
    }, this.CARD_SELECTION_DURATION + 1000); // +1 second buffer
    
    return game;
    
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Error beginning card selection:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

  // ==================== CARD SELECTION TIMEOUT HANDLER ====================

static async checkCardSelectionEnd(gameId) {
  try {
    console.log(`⏰ Checking card selection end for game ${gameId}`);
    
    const game = await Game.findById(gameId);
    
    if (!game || game.status !== 'CARD_SELECTION') {
      console.log(`⚠️ Game ${gameId} not in CARD_SELECTION state`);
      return;
    }
    
    const now = new Date();
    
    // Check if card selection time has expired
    if (game.cardSelectionEndTime && game.cardSelectionEndTime > now) {
      console.log(`⏳ Card selection not yet ended for ${game.code}`);
      return;
    }
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Starting game ${game.code} with ${playersWithCards} players`);
      
      // Broadcast that card selection ended successfully
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTION_ENDED',
        gameId: game._id,
        status: 'PROCEEDING_TO_GAME',
        playerCount: playersWithCards,
        timestamp: new Date().toISOString()
      });
      
      // Start the game
      await this.startGame(gameId);
    } else {
      console.log(`❌ Not enough players (${playersWithCards}/${this.MIN_PLAYERS_TO_START})`);
      
      // Go back to waiting state
      game.status = 'WAITING_FOR_PLAYERS';
      game.cardSelectionStartTime = null;
      game.cardSelectionEndTime = null;
      game.autoStartEndTime = new Date(Date.now() + this.AUTO_START_DELAY);
      await game.save();
      
      console.log(`⏳ Game ${game.code} back to waiting state`);
      
      // Broadcast card selection failed
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTION_FAILED',
        gameId: game._id,
        reason: 'Not enough players selected cards',
        required: this.MIN_PLAYERS_TO_START,
        current: playersWithCards,
        timestamp: new Date().toISOString()
      });
      
      // Broadcast game status update
      this.broadcastGameStatus(gameId, game);
      
      // Schedule auto-start check again
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
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
      
      if (game.status !== 'CARD_SELECTION' && game.status !== 'WAITING_FOR_PLAYERS') {
        throw new Error(`Game ${game.code} not in correct state to start: ${game.status}`);
      }
      
      const playersWithCards = await BingoCard.countDocuments({ gameId }).session(session);
      
      if (playersWithCards < this.MIN_PLAYERS_TO_START) {
        console.log(`❌ Not enough players to start: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
        
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
      
      const feeResult = await this.processEntryFees(gameId);
      
      if (feeResult.alreadyProcessed) {
        console.log(`⚠️ Entry fees already processed for ${game.code}`);
        await session.abortTransaction();
        return;
      }
      
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
      
      // Clear any previous bingo claims for this game
      this.clearBingoClaimsForGame(gameId);
      
      // Broadcast game started
      this.broadcastToGame(gameId, {
        type: 'GAME_STARTED',
        gameId: game._id,
        gameCode: game.code,
        startedAt: now.toISOString(),
        playerCount: game.currentPlayers,
        timestamp: new Date().toISOString()
      });
      
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
      
      // Broadcast number called
      this.broadcastToGame(gameId, {
        type: 'NUMBER_CALLED',
        gameId: game._id,
        number: newNumber,
        letter: GameUtils.getNumberLetter(newNumber),
        totalCalled: calledNumbers.length,
        calledNumbers: calledNumbers,
        timestamp: new Date().toISOString()
      });
      
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
      
      const uniqueUsers = new Set();
      bingoCards.forEach(card => uniqueUsers.add(card.userId.toString()));
      const totalUniquePlayers = uniqueUsers.size;
      
      const totalPot = totalUniquePlayers * this.ENTRY_FEE;
      const platformFee = totalPot * 0.2;
      const winnerPrize = totalPot - platformFee;
      
      card.isWinner = true;
      card.winningPatternPositions = winningPositions;
      card.winningPatternType = winningCard.winningPatternType || 'BINGO';
      await card.save({ session });
      
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
      
      const now = new Date();
      game.status = 'FINISHED';
      game.winnerId = winningUserId;
      game.endedAt = now;
      game.winningAmount = winnerPrize;
      
      await game.save({ session });
      await reconciliation.save({ session });
      
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
      
      // Broadcast winner declared
      this.broadcastToGame(gameId, {
        type: 'WINNER_DECLARED',
        gameId: game._id,
        gameCode: game.code,
        winnerId: winningUserId,
        winnerPrize: winnerPrize,
        totalPlayers: totalUniquePlayers,
        patternType: winningCard.winningPatternType || 'BINGO',
        endedAt: now.toISOString(),
        timestamp: new Date().toISOString()
      });
      
      this.stopAutoNumberCalling(gameId);
      
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

  // ==================== CARD MANAGEMENT ====================

  static async selectCard(gameId, userId, cardNumbers, cardNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const canJoin = await this.canPlayerJoinGame(gameId, userId);
      if (!canJoin) {
        throw new Error('You are disqualified from this game and cannot select a card');
      }
      
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      if (game.status !== 'WAITING_FOR_PLAYERS' && game.status !== 'CARD_SELECTION') {
        throw new Error('Cannot select card - game not accepting players');
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
        user = await User.create([{
          telegramId: userId,
          firstName: `Player_${userId.slice(0, 8)}`,
          username: `player_${userId}`,
          role: 'user'
        }], { session });
        user = user[0];
      }

      const mongoUserId = user._id;

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
        
        // Broadcast user joined
        this.broadcastToGame(gameId, {
          type: 'USER_JOINED',
          gameId: game._id,
          userId: mongoUserId,
          telegramId: userId,
          currentPlayers: game.currentPlayers,
          timestamp: new Date().toISOString()
        }, [mongoUserId.toString()]);
      }

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
        
        console.log(`🔄 User ${userId} replacing card #${existingCard.cardNumber} with #${cardNumber}`);
        
        await BingoCard.deleteOne({ 
          _id: existingCard._id 
        }).session(session);
      }

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
      
      this.updateCardSelection(gameId, cardNumber, mongoUserId);
      
      // Broadcast card selected
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTED',
        gameId: game._id,
        userId: mongoUserId,
        cardNumber: cardNumber,
        action: existingCard ? 'REPLACED' : 'SELECTED',
        timestamp: new Date().toISOString()
      }, [mongoUserId.toString()]);
      
      // Broadcast taken cards update
      const takenCards = await this.getTakenCards(gameId);
      this.broadcastTakenCardsUpdate(gameId, takenCards);
      
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

  // ==================== HELPER METHODS ====================

  static clearBingoClaimsForGame(gameId) {
    const gameIdStr = gameId.toString();
    const keysToDelete = [];
    
    for (const [key, value] of this.bingoClaims.entries()) {
      if (key.startsWith(gameIdStr + '_')) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.bingoClaims.delete(key));
    console.log(`🧹 Cleared ${keysToDelete.length} bingo claims for game ${gameId}`);
  }

  static updateCardSelection(gameId, cardNumber, userId) {
    const gameIdStr = gameId.toString();
    
    if (!this.selectedCards.has(gameIdStr)) {
      this.selectedCards.set(gameIdStr, new Map());
    }
    
    const gameCards = this.selectedCards.get(gameIdStr);
    
    for (const [existingCardNumber, data] of gameCards.entries()) {
      if (data.userId.toString() === userId.toString()) {
        gameCards.delete(existingCardNumber);
      }
    }
    
    gameCards.set(cardNumber, {
      userId: userId,
      selectedAt: new Date()
    });
  }

  static async scheduleAutoStartCheck(gameId) {
    const game = await Game.findById(gameId);
    if (!game || game.status !== 'WAITING_FOR_PLAYERS') return;
    
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= this.MIN_PLAYERS_TO_START) {
      console.log(`✅ Conditions met for auto-start: ${playersWithCards} players`);
      await this.beginCardSelection(gameId);
    } else {
      console.log(`⏳ Waiting for players: ${playersWithCards}/${this.MIN_PLAYERS_TO_START}`);
      
      setTimeout(() => {
        this.scheduleAutoStartCheck(gameId);
      }, 5000);
    }
  }

  // ==================== ESSENTIAL MISSING METHODS ====================

  static async getAvailableCards(gameId, userId, count = 400) {
    const cards = [];
    
    for (let i = 0; i < count; i++) {
      const cardNumbers = GameUtils.generateBingoCard(i + 1);
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

  static async endGame(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      this.stopAutoNumberCalling(gameId);

      const game = await Game.findById(gameId).session(session);
      
      if (!game || game.status !== 'ACTIVE') {
        throw new Error('Game not active');
      }

      const bingoCards = await BingoCard.find({ gameId }).session(session);
      
      const now = new Date();
      const cooldownEndTime = new Date(now.getTime() + this.GAME_RESTART_COOLDOWN);
      
      game.status = 'COOLDOWN';
      game.endedAt = now;
      game.cooldownEndTime = cooldownEndTime;
      await game.save({ session });

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

      // Broadcast game ended
      this.broadcastToGame(gameId, {
        type: 'GAME_ENDED',
        gameId: game._id,
        gameCode: game.code,
        reason: 'Cancelled by admin',
        endedAt: now.toISOString(),
        cooldownEndTime: cooldownEndTime.toISOString(),
        timestamp: new Date().toISOString()
      });

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

  // ==================== REMAINING ESSENTIAL METHODS ====================

  static async findWaitingOrCardSelectionGame() {
    const game = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION'] },
      archived: { $ne: true }
    }).sort({ createdAt: -1 });
    
    if (game) {
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

  // ==================== ENTRY FEE PROCESSING ====================

  static async processEntryFees(gameId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game) {
        throw new Error('Game not found');
      }

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

      let successfullyCharged = 0;
      
      for (const [telegramId, userData] of userCardsMap.entries()) {
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

  // ==================== NO WINNER & REFUNDS ====================

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

    if (game.winnerId) {
      console.log(`✅ Game ${game.code} already has winner ${game.winnerId}`);
      
      if (game.status !== 'FINISHED') {
        game.status = 'FINISHED';
        game.endedAt = game.endedAt || new Date();
        await game.save();
      }
      
      this.winnerDeclared.add(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // IMPORTANT: Start new game immediately
      await this.createNewGameAfterCooldown(game._id);
      return;
    }

    if (game.status !== 'ACTIVE') {
      console.log(`⚠️ Game ${gameId} is not active (${game.status})`);
      return;
    }

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

      // Check again if winner declared during transaction
      if (gameInSession.winnerId) {
        gameInSession.status = 'FINISHED';
        gameInSession.endedAt = gameInSession.endedAt || new Date();
        await gameInSession.save({ session });
        
        await session.commitTransaction();
        
        this.winnerDeclared.add(gameId.toString());
        this.stopAutoNumberCalling(gameId);
        
        // IMPORTANT: Start new game immediately
        await this.createNewGameAfterCooldown(game._id);
        return;
      }

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
        
        // IMPORTANT: Start new game immediately
        await this.createNewGameAfterCooldown(game._id);
        return;
      }

        const bingoCards = await BingoCard.find({ gameId: gameInSession._id }).session(session);
        
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
        
        const userCardsMap = new Map();
        let refundTransactions = [];
        
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

        for (const [telegramId, userData] of userCardsMap.entries()) {
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
      
      gameInSession.status = 'NO_WINNER';
      gameInSession.endedAt = now;
      gameInSession.refunded = true;
      gameInSession.refundedAt = now;
      
      await gameInSession.save({ session });
      
      // Create reconciliation record
      const reconciliation = new Reconciliation({
        gameId: gameInSession._id,
        status: 'NO_WINNER_REFUNDED',
        totalPot: 0,
        platformFee: 0,
        winnerAmount: 0,
        debitTotal: 0,
        creditTotal: 0,
        completedAt: now
      });
      
      await reconciliation.save({ session });
      await session.commitTransaction();
      
      console.log(`✅ Game ${gameInSession.code} ended as NO_WINNER`);
      
      // Broadcast no winner
      this.broadcastToGame(gameId, {
        type: 'NO_WINNER',
        gameId: gameInSession._id,
        gameCode: gameInSession.code,
        reason: 'All 75 numbers called without winner',
        endedAt: now.toISOString(),
        timestamp: new Date().toISOString()
      });
      
      this.winnerDeclared.add(gameId.toString());
      this.stopAutoNumberCalling(gameId);
      
      // IMPORTANT: Create new game immediately (no cooldown)
      console.log(`🔄 Creating new game after ${gameInSession.code} ended`);
      await this.createNewGameAfterCooldown(game._id);

    } catch (error) {
      console.error('❌ Transaction error in endGameDueToNoWinner:', error);
      if (session && session.inTransaction()) {
        await session.abortTransaction();
      }
      
      // Even on error, try to create new game
      try {
        await this.createNewGameAfterCooldown(game._id);
      } catch (createError) {
        console.error('❌ Failed to create new game after error:', createError);
      }
      
      throw error;
    } finally {
      if (session) {
        session.endSession();
      }
    }

  } catch (error) {
    console.error('❌ Error in endGameDueToNoWinner:', error);
    
    // Try to create new game anyway
    try {
      await this.createNewGameAfterCooldown(gameId);
    } catch (createError) {
      console.error('❌ Failed to create new game after endGameDueToNoWinner error:', createError);
    }
    
    throw error;
  } finally {
    this.processingGames.delete(lockKey);
  }
}

  // ==================== NEXT GAME COUNTDOWN ====================

  static async setNextGameCountdown(gameId) {
  try {
    const game = await Game.findById(gameId);
    
    if (!game) {
      console.log(`⚠️ Game ${gameId} not found, creating new game`);
      return await this.createNewGame();
    }

    if (game.status !== 'FINISHED' && game.status !== 'NO_WINNER') {
      console.log(`⚠️ Game ${game.code} not finished (${game.status}), checking for active game`);
      
      // Check if there's already an active/waiting game
      const activeGame = await Game.findOne({
        status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
        archived: { $ne: true },
        _id: { $ne: gameId }
      });
      
      if (activeGame) {
        console.log(`✅ Active game exists: ${activeGame.code}`);
        return activeGame;
      }
      
      // No active game, create new one
      return await this.createNewGame();
    }

    console.log(`🔄 Setting up next game after ${game.code}...`);
    
    // Archive the finished game immediately
    game.archived = true;
    game.archivedAt = new Date();
    game.archivedReason = 'Game finished - preparing for new game';
    await game.save();
    
    console.log(`📦 Archived finished game ${game.code}`);
    
    // Create new game immediately (no cooldown wait)
    return await this.createNewGameAfterCooldown(gameId);
    
  } catch (error) {
    console.error('❌ Error setting next game countdown:', error);
    
    // Try to create new game anyway
    try {
      return await this.createNewGame();
    } catch (createError) {
      console.error('❌ Failed to create new game after setNextGameCountdown error:', createError);
      throw error;
    }
  }
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
    
    if (gameObj.status === 'WAITING') {
      gameObj.status = 'WAITING_FOR_PLAYERS';
    }
    
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
    
    const bingoCards = await BingoCard.find({ gameId: gameObj._id });
    const playersWithCards = bingoCards.length;
    
    gameObj.playersWithCards = playersWithCards;
    gameObj.cardsNeeded = Math.max(0, this.MIN_PLAYERS_TO_START - playersWithCards);
    
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
  this.cleanupAllIntervals();
  
  // Check for existing game every 10 seconds
  const interval = setInterval(async () => {
    try {
      await this.ensureActiveGameExists();
    } catch (error) {
      console.error('❌ Game service error:', error);
    }
  }, 10000);

  console.log('🚀 Game Service Started');
  
  // Initial game creation
  setTimeout(async () => {
    try {
      await this.ensureActiveGameExists();
    } catch (error) {
      console.error('❌ Initial game setup failed:', error);
    }
  }, 2000);

  return interval;
}

static async ensureActiveGameExists() {
  try {
    const game = await Game.findOne({
      status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
      archived: { $ne: true }
    });
    
    if (!game) {
      console.log('⚠️ No active/waiting game found. Creating new one...');
      await this.createNewGame();
    } else {
      console.log(`✅ Active game exists: ${game.code} (${game.status})`);
    }
  } catch (error) {
    console.error('❌ Error ensuring active game exists:', error);
  }
}
static async ensureNoActiveGames() {
  const activeGame = await Game.findOne({
    status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE'] },
    archived: { $ne: true }
  });

  if (activeGame) {
    console.log(`⚠️ Game ${activeGame.code} (${activeGame.status}) already exists`);
    return false;
  }

  return true;
}

static async findWaitingOrCardSelectionGame() {
  const game = await Game.findOne({
    status: { $in: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION'] },
    archived: { $ne: true }
  }).sort({ createdAt: -1 });
  
  if (game) {
    await this.ensureSingleWaitingGame();
    return game;
  }
  
  return null;
}

static async ensureSingleWaitingGame() {
  const session = await mongoose.startSession();
  
  try {
    session.startTransaction();
    
    const waitingGames = await Game.find({
      status: 'WAITING_FOR_PLAYERS',
      archived: { $ne: true }
    }).session(session).sort({ createdAt: -1 });

    if (waitingGames.length <= 1) {
      await session.abortTransaction();
      return;
    }

    console.warn(`⚠️ Found ${waitingGames.length} waiting games`);
    
    const newestGame = waitingGames[0];
    
    for (let i = 1; i < waitingGames.length; i++) {
      const oldGame = waitingGames[i];
      oldGame.archived = true;
      oldGame.archivedAt = new Date();
      oldGame.archivedReason = 'Duplicate waiting game';
      await oldGame.save({ session });
    }

    await session.commitTransaction();
    console.log('✅ Ensured single waiting game');
    
  } catch (error) {
    if (session && session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('❌ Error ensuring single waiting game:', error);
  } finally {
    if (session) {
      session.endSession();
    }
  }
}
  static async manageGameLifecycle() {
    try {
      const now = new Date();
      
        const expiredCardSelectionGames = await Game.find({
      status: 'CARD_SELECTION',
      cardSelectionEndTime: { $lte: now },
      archived: { $ne: true }
    });
    
    for (const game of expiredCardSelectionGames) {
      console.log(`⏰ Found expired card selection game: ${game.code}`);
      await this.checkCardSelectionEnd(game._id);
    }
      
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
    this.bingoClaims.clear();
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
      
      // Check if player is disqualified from this game
      const canJoin = await this.canPlayerJoinGame(game._id, userId);
      if (!canJoin) {
        throw new Error('You are disqualified from this game and cannot join');
      }

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

      await GamePlayer.create([{
        userId: mongoUserId,
        gameId: game._id,
        isReady: true,
        playerType: 'PLAYER',
        joinedAt: new Date()
      }], { session });

      game.currentPlayers += 1;
      game.updatedAt = new Date();
      
      if (game.currentPlayers >= this.MIN_PLAYERS_TO_START) {
        this.scheduleAutoStartCheck(game._id);
      }
      
      await game.save({ session });
      await session.commitTransaction();

      console.log(`✅ User ${userId} joined ${game.code}. Total: ${game.currentPlayers}`);
      
      // Broadcast user joined
      this.broadcastToGame(game._id, {
        type: 'USER_JOINED',
        gameId: game._id,
        userId: mongoUserId,
        telegramId: userId,
        currentPlayers: game.currentPlayers,
        timestamp: new Date().toISOString()
      }, [mongoUserId.toString()]);

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
    
    // Broadcast user left
    this.broadcastToGame(gameId, {
      type: 'USER_LEFT',
      gameId: game._id,
      userId: mongoUserId,
      telegramId: userId,
      currentPlayers: game.currentPlayers,
      timestamp: new Date().toISOString()
    });
    
    return this.getGameWithDetails(game._id);
  }

  static async markNumber(gameId, userId, number) {
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
    
    // Broadcast number marked
    this.sendToUser(userId, {
      type: 'NUMBER_MARKED',
      gameId: game._id,
      number: number,
      position: position,
      markedCount: bingoCard.markedPositions.length,
      timestamp: new Date().toISOString()
    });

    return { 
      bingoCard, 
      isMarked: true,
      markedCount: bingoCard.markedPositions.length
    };
  }

  static async checkForWin(gameId, userId) {
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
    
    let effectiveMarkedPositions = bingoCard.markedPositions || [];
    
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
      const gamePlayers = await GamePlayer.find({ gameId })
        .populate('userId', 'username firstName telegramId');
      
      const bingoCards = await BingoCard.find({ gameId })
        .populate('userId', 'username firstName telegramId');
      
      const participants = new Map();
      
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
      
      for (const card of bingoCards) {
        if (card.userId) {
          const userIdStr = card.userId._id.toString();
          if (participants.has(userIdStr)) {
            const participant = participants.get(userIdStr);
            participant.hasCard = true;
            participant.cardNumber = card.cardNumber;
          } else {
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
      const existingReconciliation = await Reconciliation.findOne({
        gameId: gameId,
        'transactions.userId': userId,
        status: { $in: ['DEDUCTED', 'WINNER_DECLARED', 'NO_WINNER_REFUNDED'] }
      });

      if (existingReconciliation) {
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
        maxPlayers: 400,
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