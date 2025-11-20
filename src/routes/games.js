const express = require('express');
const router = express.Router();
const GameService = require('../services/gameService');

// Create new game
router.post('/', async (req, res) => {
  try {
    const { hostId, maxPlayers = 10, isPrivate = false } = req.body;
    
    if (!hostId) {
      return res.status(400).json({
        success: false,
        error: 'hostId is required',
      });
    }

    const game = await GameService.createGame(hostId, maxPlayers, isPrivate);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Join game by code
router.post('/:code/join', async (req, res) => {
  try {
    const { code } = req.params;
    const { userId } = req.body;
    
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
    console.error('Join game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Start game
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { hostId } = req.body;
    
    if (!hostId) {
      return res.status(400).json({
        success: false,
        error: 'hostId is required',
      });
    }

    const game = await GameService.startGame(id, hostId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Start game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Call number
router.post('/:id/call-number', async (req, res) => {
  try {
    const { id } = req.params;
    const { callerId } = req.body; // Added callerId for validation
    
    const result = await GameService.callNumber(id, callerId);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Call number error:', error);
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
    console.error('Mark number error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Get game by code
router.get('/code/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
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
    console.error('Get game by code error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ADD THESE ROUTES BEFORE THE /:id ROUTE
// Get active games - simple endpoint
router.get('/active', async (req, res) => {
  try {
    console.log('GET /api/games/active called');
    const games = await GameService.getActiveGames();
    console.log(`Found ${games.length} active games`);
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('Get active games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get waiting games - simple endpoint (MISSING ROUTE)
router.get('/waiting', async (req, res) => {
  try {
    console.log('GET /api/games/waiting called');
    const games = await GameService.getWaitingGames();
    console.log(`Found ${games.length} waiting games`);
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('Get waiting games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get game by ID - THIS SHOULD BE AFTER SPECIFIC ROUTES
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
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
    console.error('Get game error:', error);
    
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

// Get user's bingo card for a game
router.get('/:gameId/card/:userId', async (req, res) => {
  try {
    const { gameId, userId } = req.params;
    
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
    console.error('Get bingo card error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get active games (list endpoint)
router.get('/list/active', async (req, res) => {
  try {
    const games = await GameService.getActiveGames();
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('Get active games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Leave game
router.post('/:id/leave', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
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
    console.error('Leave game error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Get waiting games (public games that haven't started) - list endpoint
router.get('/list/waiting', async (req, res) => {
  try {
    const games = await GameService.getWaitingGames();
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    console.error('Get waiting games error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get user's active games
router.get('/user/:userId/active', async (req, res) => {
  try {
    const { userId } = req.params;
    
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
    console.error('Get user active games error:', error);
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
    console.error('Get user game history error:', error);
    res.status(500).json({
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
    console.error('Check win error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// End game (host only)
router.post('/:id/end', async (req, res) => {
  try {
    const { id } = req.params;
    const { hostId } = req.body;
    
    if (!hostId) {
      return res.status(400).json({
        success: false,
        error: 'hostId is required',
      });
    }

    const game = await GameService.endGame(id, hostId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('End game error:', error);
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
    
    const stats = await GameService.getGameStats(id);
    
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('Get game stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Update game settings
router.put('/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { hostId, maxPlayers, isPrivate } = req.body;
    
    if (!hostId) {
      return res.status(400).json({
        success: false,
        error: 'hostId is required',
      });
    }

    const game = await GameService.updateGameSettings(id, hostId, { maxPlayers, isPrivate });
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    console.error('Update game settings error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;