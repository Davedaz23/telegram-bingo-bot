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

  static checkWinCondition(numbers, markedPositions) {
    if (!markedPositions || markedPositions.length < 4) return false;

    // Always include the FREE space (position 12) in marked positions
    const effectiveMarked = [...new Set([...markedPositions, 12])];

    const winPatterns = [
      // Rows
      [0, 1, 2, 3, 4],     // Row 1
      [5, 6, 7, 8, 9],     // Row 2
      [10, 11, 12, 13, 14], // Row 3
      [15, 16, 17, 18, 19], // Row 4
      [20, 21, 22, 23, 24], // Row 5
      // Columns
      [0, 5, 10, 15, 20],  // Col 1
      [1, 6, 11, 16, 21],  // Col 2
      [2, 7, 12, 17, 22],  // Col 3
      [3, 8, 13, 18, 23],  // Col 4
      [4, 9, 14, 19, 24],  // Col 5
      // Diagonals
      [0, 6, 12, 18, 24],  // Diagonal \
      [4, 8, 12, 16, 20]   // Diagonal /
    ];

    return winPatterns.some(pattern => 
      pattern.every(position => effectiveMarked.includes(position))
    );
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