// services/cardSelectionService.js - FIXED VERSION
const mongoose = require('mongoose');
const Game = require('../models/Game');

class CardSelectionService {
  static async selectCard(gameId, userId, cardNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Validate gameId
      if (!mongoose.Types.ObjectId.isValid(gameId)) {
        throw new Error('Invalid game ID');
      }

      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      // Check if card selection period is active
      const isSelectionActive = new Date() < game.cardSelectionEndTime && game.status === 'WAITING';
      if (!isSelectionActive) {
        throw new Error('Card selection period has ended or game is not waiting');
      }

      // Check if card number is valid
      if (cardNumber < 1 || cardNumber > 400) {
        throw new Error('Invalid card number. Must be between 1-400');
      }

      // Convert selectedCards to Map for checking
      let selectedCards = new Map();
      if (game.selectedCards) {
        if (game.selectedCards instanceof Map) {
          selectedCards = game.selectedCards;
        } else {
          selectedCards = new Map(Object.entries(game.selectedCards));
        }
      }

      // Check if card is already taken
      if (selectedCards.has(cardNumber.toString())) {
        throw new Error(`Card #${cardNumber} is already selected by another player`);
      }

      // Check if user already selected a card
      for (let [cardNum, cardUserId] of selectedCards) {
        if (cardUserId.toString() === userId.toString()) {
          throw new Error('You have already selected a card');
        }
      }

      // Reserve the card
      selectedCards.set(cardNumber.toString(), userId);
      game.selectedCards = selectedCards;
      game.markModified('selectedCards');
      
      await game.save({ session });
      await session.commitTransaction();

      console.log(`✅ User ${userId} selected card #${cardNumber} in game ${game.code}`);

      return {
        success: true,
        cardNumber,
        gameId,
        userId,
        selectionEndTime: game.cardSelectionEndTime
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Card selection error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getAvailableCards(gameId) {
    try {
      // Validate gameId
      if (!mongoose.Types.ObjectId.isValid(gameId)) {
        throw new Error('Invalid game ID');
      }

      const game = await Game.findById(gameId);
      if (!game) {
        throw new Error('Game not found');
      }

      // Convert selectedCards to Map
      let selectedCards = new Map();
      if (game.selectedCards) {
        if (game.selectedCards instanceof Map) {
          selectedCards = game.selectedCards;
        } else {
          selectedCards = new Map(Object.entries(game.selectedCards));
        }
      }

      const takenCards = Array.from(selectedCards.keys()).map(Number);
      const availableCards = [];
      
      for (let i = 1; i <= 400; i++) {
        if (!takenCards.includes(i)) {
          availableCards.push(i);
        }
      }

      const isSelectionActive = new Date() < game.cardSelectionEndTime && game.status === 'WAITING';

      return {
        availableCards,
        takenCards: Array.from(selectedCards.entries()).map(([cardNumber, userId]) => ({
          cardNumber: parseInt(cardNumber),
          userId: userId
        })),
        isSelectionActive,
        selectionEndTime: game.cardSelectionEndTime,
        timeRemaining: Math.max(0, game.cardSelectionEndTime - new Date())
      };
    } catch (error) {
      console.error('❌ Get available cards error:', error);
      throw error;
    }
  }

  static async releaseCard(gameId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Validate gameId
      if (!mongoose.Types.ObjectId.isValid(gameId)) {
        throw new Error('Invalid game ID');
      }

      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      // Convert selectedCards to Map
      let selectedCards = new Map();
      if (game.selectedCards) {
        if (game.selectedCards instanceof Map) {
          selectedCards = game.selectedCards;
        } else {
          selectedCards = new Map(Object.entries(game.selectedCards));
        }
      }

      let released = false;
      for (let [cardNumber, cardUserId] of selectedCards) {
        if (cardUserId.toString() === userId.toString()) {
          selectedCards.delete(cardNumber);
          released = true;
          break;
        }
      }

      if (released) {
        game.selectedCards = selectedCards;
        game.markModified('selectedCards');
        await game.save({ session });
      }

      await session.commitTransaction();
      
      if (released) {
        console.log(`🔄 Released card for user ${userId} in game ${game.code}`);
      }

      return { success: true, released };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Card release error:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async checkCardSelectionStatus(gameId) {
    try {
      // Validate gameId
      if (!mongoose.Types.ObjectId.isValid(gameId)) {
        throw new Error('Invalid game ID');
      }

      const game = await Game.findById(gameId);
      if (!game) {
        throw new Error('Game not found');
      }

      const isSelectionActive = new Date() < game.cardSelectionEndTime && game.status === 'WAITING';
      
      let totalCardsSelected = 0;
      if (game.selectedCards) {
        if (game.selectedCards instanceof Map) {
          totalCardsSelected = game.selectedCards.size;
        } else {
          totalCardsSelected = Object.keys(game.selectedCards).length;
        }
      }

      return {
        isSelectionActive,
        selectionEndTime: game.cardSelectionEndTime,
        timeRemaining: Math.max(0, game.cardSelectionEndTime - new Date()),
        totalCardsSelected
      };
    } catch (error) {
      console.error('❌ Check card selection status error:', error);
      throw error;
    }
  }
}

module.exports = CardSelectionService;