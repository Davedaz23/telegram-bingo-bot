const express = require('express');
const router = express.Router();
const GameService = require('../services/gameService');

// ==================== CARD SELECTION ROUTES ====================

// Get available cards for user to choose from
router.get('/:gameId/available-cards/:userId', async (req, res) => {
  try {
    const { gameId, userId } = req.params;
    const { count = 3 } = req.query;
    
    console.log(`📋 Get available cards request: gameId=${gameId}, userId=${userId}, count=${count}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const cards = await GameService.getAvailableCards(gameId, userId, parseInt(count));
    
    console.log(`✅ Generated ${cards.length} available cards for user ${userId}`);
    
    res.json({
      success: true,
      cards,
      count: cards.length
    });
  } catch (error) {
    console.error('❌ Get available cards error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});
// Get real-time taken cards
router.get('/:gameId/taken-cards', async (req, res) => {
  try {
    const { gameId } = req.params;
    
    console.log(`📋 Get taken cards request: gameId=${gameId}`);
    
    // Get taken cards from database
    const databaseTakenCards = await GameService.getTakenCards(gameId);
    
    // Get real-time taken cards
    const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
    
    // Merge both sources
    const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
    
    // Remove duplicates
    const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
      index === self.findIndex(c => c.cardNumber === card.cardNumber)
    );
    
    res.json({
      success: true,
      takenCards: uniqueTakenCards,
      count: uniqueTakenCards.length
    });
  } catch (error) {
    console.error('❌ Get taken cards error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Check and auto-start game if conditions are met
// routes/gameRoutes.js - ADD THIS NEW ROUTE
router.post('/:gameId/check-auto-start', async (req, res) => {
  try {
    const { gameId } = req.params;
    
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    if (game.status !== 'WAITING') {
      return res.json({ 
        success: true, 
        gameStarted: false, 
        reason: 'Game not in waiting state',
        game: GameService.formatGameForFrontend(game)
      });
    }

    // Check if we should auto-start
    const playersWithCards = await BingoCard.countDocuments({ gameId });
    
    if (playersWithCards >= GameService.MIN_PLAYERS_TO_START) {
      console.log(`🎯 Auto-start conditions met: ${playersWithCards} players with cards`);
      
      // Check if auto-start timer is already set
      const now = new Date();
      let autoStartEndTime = game.autoStartEndTime;
      
      if (!autoStartEndTime || autoStartEndTime < now) {
        // Set new auto-start timer (10 seconds from now)
        autoStartEndTime = new Date(now.getTime() + 10000);
        game.autoStartEndTime = autoStartEndTime;
        await game.save();
        
        // Schedule auto-start
        GameService.scheduleAutoStart(gameId, 10000);
      }
      
      const timeRemaining = autoStartEndTime - now;
      
      return res.json({
        success: true,
        gameStarted: false,
        game: GameService.formatGameForFrontend(game),
        autoStartInfo: {
          willAutoStart: true,
          timeRemaining: Math.max(0, timeRemaining),
          autoStartEndTime: autoStartEndTime,
          playersWithCards: playersWithCards,
          minPlayersRequired: GameService.MIN_PLAYERS_TO_START
        }
      });
    } else {
      return res.json({
        success: true,
        gameStarted: false,
        game: GameService.formatGameForFrontend(game),
        autoStartInfo: {
          willAutoStart: false,
          playersWithCards: playersWithCards,
          minPlayersRequired: GameService.MIN_PLAYERS_TO_START,
          playersNeeded: GameService.MIN_PLAYERS_TO_START - playersWithCards
        }
      });
    }
  } catch (error) {
    console.error('❌ Check auto-start error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}); 
// Select card with card number
router.post('/:gameId/select-card-with-number', async (req, res) => {
  try {
    const { gameId } = req.params;
    const { userId, cardNumbers, cardNumber } = req.body;
    
    console.log(`🎯 Card selection with number: gameId=${gameId}, userId=${userId}, cardNumber=${cardNumber}`);
    
    if (!userId || !cardNumbers || !cardNumber) {
      return res.status(400).json({
        success: false,
        error: 'userId, cardNumbers, and cardNumber are required'
      });
    }

    const result = await GameService.selectCard(gameId, userId, cardNumbers, cardNumber);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('❌ Card selection with number error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});
// Select a bingo card
router.post('/:gameId/select-card', async (req, res) => {
  try {
    const { gameId } = req.params;
    const { userId, cardNumbers } = req.body;
    
    console.log(`🎯 Card selection request: gameId=${gameId}, userId=${userId}`);
    
    if (!userId || !cardNumbers) {
      return res.status(400).json({
        success: false,
        error: 'userId and cardNumbers are required'
      });
    }

    // Validate card numbers structure
    if (!Array.isArray(cardNumbers) || cardNumbers.length !== 5) {
      return res.status(400).json({
        success: false,
        error: 'Invalid card format: must be a 5x5 array'
      });
    }

    for (let i = 0; i < 5; i++) {
      if (!Array.isArray(cardNumbers[i]) || cardNumbers[i].length !== 5) {
        return res.status(400).json({
          success: false,
          error: 'Invalid card format: each row must have 5 numbers'
        });
      }
    }

    const result = await GameService.selectCard(gameId, userId, cardNumbers);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('❌ Card selection error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Check if user has selected a card
router.get('/:gameId/has-card/:userId', async (req, res) => {
  try {
    const { gameId, userId } = req.params;
    
    console.log(`🔍 Check card selection: gameId=${gameId}, userId=${userId}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const bingoCard = await GameService.getUserBingoCard(gameId, userId);
    const hasCard = !!bingoCard;
    
    res.json({
      success: true,
      hasCard,
      bingoCard: hasCard ? bingoCard : null
    });
  } catch (error) {
    console.error('❌ Check card selection error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get card selection status for the entire game
router.get('/:gameId/card-selection-status', async (req, res) => {
  try {
    const { gameId } = req.params;
    
    const game = await GameService.getGameWithDetails(gameId);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found'
      });
    }

    // Get all players and their card status
    const players = game.players || [];
    const playersWithCards = [];
    const playersWithoutCards = [];

    for (const player of players) {
      const bingoCard = await GameService.getUserBingoCard(gameId, player.userId._id || player.userId);
      if (bingoCard) {
        playersWithCards.push({
          userId: player.userId._id || player.userId,
          username: player.userId.username,
          firstName: player.userId.firstName
        });
      } else {
        playersWithoutCards.push({
          userId: player.userId._id || player.userId,
          username: player.userId.username,
          firstName: player.userId.firstName
        });
      }
    }

    const canStart = playersWithCards.length >= GameService.MIN_PLAYERS_TO_START && 
                    playersWithCards.length === players.length;

    res.json({
      success: true,
      gameId,
      totalPlayers: players.length,
      playersWithCards: playersWithCards.length,
      playersWithoutCards: playersWithoutCards.length,
      canStart,
      minPlayersRequired: GameService.MIN_PLAYERS_TO_START,
      playersWithCardsList: playersWithCards,
      playersWithoutCardsList: playersWithoutCards
    });
  } catch (error) {
    console.error('❌ Card selection status error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== GAME MANAGEMENT ROUTES ====================

// Join game by code
router.post('/:code/join', async (req, res) => {
  try {
    const { code } = req.params;
    const { userId } = req.body;
    
    console.log(`🎮 Join game request: code=${code}, userId=${userId}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const game = await GameService.joinGame(code, userId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ Join game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Join game with wallet (with entry fee)
router.post('/:code/join-with-wallet', async (req, res) => {
  try {
    const { code } = req.params;
    const { userId, entryFee = 10 } = req.body;
    
    console.log(`💰 Join game with wallet: code=${code}, userId=${userId}, entryFee=${entryFee}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const game = await GameService.joinGameWithWallet(code, userId, entryFee);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ Join game with wallet error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Start game - NO HOST REQUIRED
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🚀 Start game request: gameId=${id}`);
    
    const game = await GameService.startGame(id);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ Start game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Call number - NO CALLER ID REQUIRED
router.post('/:id/call-number', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔢 Call number request: gameId=${id}`);
    
    const result = await GameService.callNumber(id);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('❌ Call number error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Mark number (manual marking - for frontend)
router.post('/:id/mark-number', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, number } = req.body;
    
    console.log(`🎯 Mark number request: gameId=${id}, userId=${userId}, number=${number}`);
    
    if (!userId || !number) {
      return res.status(400).json({
        success: false,
        error: 'userId and number are required',
      });
    }

    const result = await GameService.markNumber(id, userId, number);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('❌ Mark number error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GAME QUERY ROUTES ====================

// Get game by code
router.get('/code/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    console.log(`🔍 Get game by code: ${code}`);
    
    const game = await GameService.findByCode(code);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ Get game by code error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get active games - simple endpoint
router.get('/active', async (req, res) => {
  try {
    console.log('🔍 GET /api/games/active called');
    const games = await GameService.getActiveGames();
    console.log(`✅ Found ${games.length} active games`);
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('❌ Get active games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get waiting games - simple endpoint
router.get('/waiting', async (req, res) => {
  try {
    console.log('🔍 GET /api/games/waiting called');
    const games = await GameService.getWaitingGames();
    console.log(`✅ Found ${games.length} waiting games`);
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('❌ Get waiting games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get game by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔍 Get game by ID: ${id}`);
    
    // Validate if it's a valid MongoDB ObjectId
    if (!id || id === 'active' || id === 'waiting') {
      return res.status(400).json({
        success: false,
        error: 'Invalid game ID'
      });
    }

    const game = await GameService.getGameWithDetails(id);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found'
      });
    }

    res.json({
      success: true,
      game
    });
  } catch (error) {
    console.error('❌ Get game error:', error);
    
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid game ID format'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get winner information
router.get('/:id/winner', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🏆 Get winner info: gameId=${id}`);
    
    const winnerInfo = await GameService.getWinnerInfo(id);
    
    if (!winnerInfo) {
      return res.status(404).json({
        success: false,
        error: 'No winner found for this game',
      });
    }

    res.json({
      success: true,
      winnerInfo,
    });
  } catch (error) {
    console.error('❌ Get winner info error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get user's bingo card for a game
router.get('/:gameId/card/:userId', async (req, res) => {
  try {
    const { gameId, userId } = req.params;
    
    console.log(`🎴 Get bingo card: gameId=${gameId}, userId=${userId}`);
    
    const bingoCard = await GameService.getUserBingoCard(gameId, userId);
    
    if (!bingoCard) {
      return res.status(404).json({
        success: false,
        error: 'Bingo card not found',
      });
    }

    res.json({
      success: true,
      bingoCard,
    });
  } catch (error) {
    console.error('❌ Get bingo card error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== USER-SPECIFIC ROUTES ====================

// Get user's active games
router.get('/user/:userId/active', async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`👤 Get user active games: userId=${userId}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const games = await GameService.getUserActiveGames(userId);
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('❌ Get user active games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get user's game history
router.get('/user/:userId/history', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10, page = 1 } = req.query;
    
    console.log(`📚 Get user game history: userId=${userId}, limit=${limit}, page=${page}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const result = await GameService.getUserGameHistory(userId, parseInt(limit), parseInt(page));
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('❌ Get user game history error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get user's game role
router.get('/user/:userId/role/:gameId', async (req, res) => {
  try {
    const { userId, gameId } = req.params;
    
    console.log(`🎭 Get user game role: userId=${userId}, gameId=${gameId}`);
    
    const role = await GameService.getUserGameRole(gameId, userId);
    
    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'User not found in this game',
      });
    }

    res.json({
      success: true,
      role,
    });
  } catch (error) {
    console.error('❌ Get user game role error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== GAME ACTIONS ROUTES ====================

// Leave game
router.post('/:id/leave', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    console.log(`🚪 Leave game request: gameId=${id}, userId=${userId}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const game = await GameService.leaveGame(id, userId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ Leave game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Check for winner (manual verification)
router.post('/:id/check-win', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    console.log(`🏆 Check win request: gameId=${id}, userId=${userId}`);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const result = await GameService.checkForWin(id, userId);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('❌ Check win error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// End game - NO HOST REQUIRED
router.post('/:id/end', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🛑 End game request: gameId=${id}`);
    
    const game = await GameService.endGame(id);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('❌ End game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Get game statistics
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`📊 Get game stats: gameId=${id}`);
    
    const stats = await GameService.getGameStats(id);
    
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('❌ Get game stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==================== DEPRECATED ROUTES (for backward compatibility) ====================

// Get active games (list endpoint) - DEPRECATED, use /active instead
router.get('/list/active', async (req, res) => {
  try {
    console.log('⚠️  Using deprecated /list/active endpoint');
    const games = await GameService.getActiveGames();
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('❌ Get active games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get waiting games (public games that haven't started) - list endpoint - DEPRECATED
router.get('/list/waiting', async (req, res) => {
  try {
    console.log('⚠️  Using deprecated /list/waiting endpoint');
    const games = await GameService.getWaitingGames();
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('❌ Get waiting games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check endpoint for games
router.get('/health/status', async (req, res) => {
  try {
    const activeGames = await GameService.getActiveGames();
    const waitingGames = await GameService.getWaitingGames();
    
    res.json({
      success: true,
      status: 'OK',
      activeGames: activeGames.length,
      waitingGames: waitingGames.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Games health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;