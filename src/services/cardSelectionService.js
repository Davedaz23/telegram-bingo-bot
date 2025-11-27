// services/cardSelectionService.js
const Game = require('../models/Game');
const User = require('../models/User');

class CardSelectionService {
  static async selectCard(gameId, userId, cardNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      // Check if card selection period is active
      if (!game.isCardSelectionActive) {
        throw new Error('Card selection period has ended');
      }

      // Check if card number is valid
      if (cardNumber < 1 || cardNumber > 400) {
        throw new Error('Invalid card number. Must be between 1-400');
      }

      // Convert Map for checking
      const selectedCards = game.selectedCards instanceof Map ? 
        game.selectedCards : new Map(Object.entries(game.selectedCards || {}));

      // Check if card is already taken
      if (selectedCards.has(cardNumber.toString())) {
        throw new Error(`Card #${cardNumber} is already selected by another player`);
      }

      // Check if user already selected a card
      for (let [cardNum, userId] of selectedCards) {
        if (userId.toString() === userId.toString()) {
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
    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    const selectedCards = game.selectedCards instanceof Map ? 
      game.selectedCards : new Map(Object.entries(game.selectedCards || {}));

    const takenCards = Array.from(selectedCards.keys()).map(Number);
    const availableCards = [];
    
    for (let i = 1; i <= 400; i++) {
      if (!takenCards.includes(i)) {
        availableCards.push(i);
      }
    }

    return {
      availableCards,
      takenCards: takenCards.map(cardNum => ({
        cardNumber: cardNum,
        userId: selectedCards.get(cardNum.toString())
      })),
      isSelectionActive: game.isCardSelectionActive,
      selectionEndTime: game.cardSelectionEndTime
    };
  }

  static async releaseCard(gameId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      
      if (!game) {
        throw new Error('Game not found');
      }

      const selectedCards = game.selectedCards instanceof Map ? 
        game.selectedCards : new Map(Object.entries(game.selectedCards || {}));

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
    const game = await Game.findById(gameId);
    if (!game) {
      throw new Error('Game not found');
    }

    return {
      isSelectionActive: game.isCardSelectionActive,
      selectionEndTime: game.cardSelectionEndTime,
      timeRemaining: Math.max(0, game.cardSelectionEndTime - new Date()),
      totalCardsSelected: (game.selectedCards instanceof Map ? 
        game.selectedCards.size : Object.keys(game.selectedCards || {}).length)
    };
  }
}

module.exports = CardSelectionService;