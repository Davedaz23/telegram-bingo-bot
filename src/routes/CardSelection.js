// routes/cardSelection.js
const express = require('express');
const router = express.Router();
const CardSelectionService = require('../services/cardSelectionService');
const GameService = require('../services/gameService');

// Select a card number
router.post('/select', async (req, res) => {
  try {
    const { gameId, userId, cardNumber } = req.body;
    
    if (!gameId || !userId || !cardNumber) {
      return res.status(400).json({
        success: false,
        error: 'gameId, userId, and cardNumber are required'
      });
    }

    const result = await CardSelectionService.selectCard(gameId, userId, cardNumber);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Card selection error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get available cards for a game
router.get('/:gameId/available-cards', async (req, res) => {
  try {
    const { gameId } = req.params;
    
    const result = await CardSelectionService.getAvailableCards(gameId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Get available cards error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Release selected card
router.post('/release', async (req, res) => {
  try {
    const { gameId, userId } = req.body;
    
    if (!gameId || !userId) {
      return res.status(400).json({
        success: false,
        error: 'gameId and userId are required'
      });
    }

    const result = await CardSelectionService.releaseCard(gameId, userId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Card release error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Check card selection status
router.get('/:gameId/status', async (req, res) => {
  try {
    const { gameId } = req.params;
    
    const result = await CardSelectionService.checkCardSelectionStatus(gameId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Card status error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;