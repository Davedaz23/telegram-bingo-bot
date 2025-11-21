// utils/gameUtils.js
class GameUtils {
  static generateGameCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  static generateBingoCard() {
    // Standard Bingo: 5 columns B-I-N-G-O with numbers 1-75
    const ranges = [
      { min: 1, max: 15 },   // B
      { min: 16, max: 30 },  // I
      { min: 31, max: 45 },  // N
      { min: 46, max: 60 },  // G
      { min: 61, max: 75 }   // O
    ];

    const card = [];
    
    // Generate each column
    for (let col = 0; col < 5; col++) {
      const numbers = new Set();
      
      // Generate 5 unique numbers for this column
      while (numbers.size < 5) {
        const num = Math.floor(Math.random() * (ranges[col].max - ranges[col].min + 1)) + ranges[col].min;
        numbers.add(num);
      }
      
      // Convert to sorted array
      const sortedNumbers = Array.from(numbers).sort((a, b) => a - b);
      card.push(sortedNumbers);
    }

    // Transpose columns to rows to create the final card
    const rows = [];
    for (let row = 0; row < 5; row++) {
      const currentRow = [];
      for (let col = 0; col < 5; col++) {
        currentRow.push(card[col][row]);
      }
      rows.push(currentRow);
    }

    // Set the center position (2,2) as FREE
    rows[2][2] = 'FREE';
    
    return rows;
  }

 static async checkForWinners(gameId, lastCalledNumber) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const game = await Game.findById(gameId).session(session);
      if (!game || game.status !== 'ACTIVE') {
        await session.abortTransaction();
        return;
      }

      const bingoCards = await BingoCard.find({ gameId }).session(session);
      let winnerFound = false;
      
      for (const card of bingoCards) {
        const numbers = card.numbers.flat();
        const position = numbers.indexOf(lastCalledNumber);
        
        // If this number is in the player's card, mark it
        if (position !== -1 && !card.markedPositions.includes(position)) {
          card.markedPositions.push(position);
          await card.save();
        }

        // FIXED: For late joiners, we need to check ALL numbers that match their card
        // not just the ones called after they joined
        let effectiveMarkedPositions = [...card.markedPositions];
        
        if (card.isLateJoiner) {
          // For late joiners, also mark any numbers that were called before they joined
          const numbersCalledAtJoin = card.numbersCalledAtJoin || [];
          const allCalledNumbers = game.numbersCalled || [];
          
          // Find all numbers in the player's card that were called in the game
          for (let i = 0; i < numbers.length; i++) {
            const cardNumber = numbers[i];
            // If this number was called in the game AND it's not already marked
            if (allCalledNumbers.includes(cardNumber) && !effectiveMarkedPositions.includes(i)) {
              effectiveMarkedPositions.push(i);
            }
          }
        }

        // Check win condition with all marked positions (including pre-join numbers for late joiners)
        const isWinner = GameUtils.checkWinCondition(numbers, effectiveMarkedPositions);
        
        if (isWinner && !card.isWinner) {
          card.isWinner = true;
          // Also update the actual marked positions to include all winning numbers
          card.markedPositions = effectiveMarkedPositions;
          await card.save();

          if (!winnerFound) {
            // Update game winner and status
            game.status = 'FINISHED';
            game.winnerId = card.userId;
            game.endedAt = new Date();
            await game.save();

            console.log(`🎉 Winner found: ${card.userId} in game ${game.code}`);
            console.log(`🏆 Late joiner won: ${card.isLateJoiner ? 'YES' : 'NO'}`);

            // Update user stats
            const UserService = require('./userService');
            await UserService.updateUserStats(card.userId, true);

            // Update other players' stats (they lost)
            const losingPlayers = bingoCards.filter(c => c.userId.toString() !== card.userId.toString());
            for (const losingCard of losingPlayers) {
              await UserService.updateUserStats(losingCard.userId, false);
            }

            winnerFound = true;
            
            // Stop auto-calling since we have a winner
            this.stopAutoNumberCalling(gameId);
          }
        }
      }

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Check winners error:', error);
    } finally {
      session.endSession();
    }
  }

  static getNumberLetter(number) {
    if (number === 'FREE') return 'FREE';
    const num = parseInt(number);
    if (isNaN(num)) return '';
    
    if (num >= 1 && num <= 15) return 'B';
    if (num >= 16 && num <= 30) return 'I';
    if (num >= 31 && num <= 45) return 'N';
    if (num >= 46 && num <= 60) return 'G';
    if (num >= 61 && num <= 75) return 'O';
    return '';
  }

  static getWinningPattern(markedPositions) {
    // Always include the FREE space (position 12) in marked positions
    const effectiveMarked = [...new Set([...markedPositions, 12])];

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
      if (pattern.positions.every(pos => effectiveMarked.includes(pos))) {
        return pattern;
      }
    }

    return null;
  }

  static getPatternType(positions) {
    const rowPatterns = [
      [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], 
      [15, 16, 17, 18, 19], [20, 21, 22, 23, 24]
    ];
    const colPatterns = [
      [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22],
      [3, 8, 13, 18, 23], [4, 9, 14, 19, 24]
    ];
    const diagPatterns = [
      [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]
    ];

    const posStr = JSON.stringify(positions);
    
    if (rowPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'ROW';
    if (colPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'COLUMN';
    if (diagPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'DIAGONAL';
    
    return 'CUSTOM';
  }

  // Helper method to validate a bingo card
  static validateBingoCard(card) {
    if (!Array.isArray(card) || card.length !== 5) return false;
    
    for (let i = 0; i < 5; i++) {
      if (!Array.isArray(card[i]) || card[i].length !== 5) return false;
      
      for (let j = 0; j < 5; j++) {
        const value = card[i][j];
        // Center should be FREE
        if (i === 2 && j === 2) {
          if (value !== 'FREE') return false;
        } else {
          // Other positions should be numbers
          if (typeof value !== 'number' || value < 1 || value > 75) return false;
        }
      }
    }
    
    return true;
  }

  // Helper method to get card position from row and column
  static getCardPosition(row, col) {
    return row * 5 + col;
  }

  // Helper method to get row and column from position
  static getRowColFromPosition(position) {
    return {
      row: Math.floor(position / 5),
      col: position % 5
    };
  }
}

module.exports = GameUtils;