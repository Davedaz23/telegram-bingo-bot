const express = require('express');
const router = express.Router();
const GameService = require('../services/gameService');

// Create new game
router.post('/', async (req, res) => {
  try {
    const { hostId, maxPlayers, isPrivate } = req.body;
    const game = await GameService.createGame(hostId, maxPlayers, isPrivate);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Join game
router.post('/:code/join', async (req, res) => {
  try {
    const { code } = req.params;
    const { userId } = req.body;
    
    const game = await GameService.joinGame(code, userId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
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
    
    const game = await GameService.startGame(id, hostId);
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
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
    
    const result = await GameService.callNumber(id);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Mark number
router.post('/:id/mark-number', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, number } = req.body;
    
    const result = await GameService.markNumber(id, userId, number);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Get active games
router.get('/active', async (req, res) => {
  try {
    const games = await GameService.getActiveGames();
    
    res.json({
      success: true,
      games,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;