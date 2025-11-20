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

// Get game by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const game = await GameService.getGameWithDetails(id);
    
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
    console.error('Get game error:', error);
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

// Get active games
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

module.exports = router;