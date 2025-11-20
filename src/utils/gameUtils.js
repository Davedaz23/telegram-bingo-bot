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
    const card = [];
    const ranges = [
      { min: 1, max: 15 },   // B
      { min: 16, max: 30 },  // I
      { min: 31, max: 45 },  // N
      { min: 46, max: 60 },  // G
      { min: 61, max: 75 }   // O
    ];

    for (let col = 0; col < 5; col++) {
      const column = [];
      const numbers = new Set();
      
      // Generate 5 unique numbers for this column
      while (numbers.size < 5) {
        const num = Math.floor(Math.random() * (ranges[col].max - ranges[col].min + 1)) + ranges[col].min;
        numbers.add(num);
      }
      
      // Convert to array and add to card
      column.push(...Array.from(numbers));
      card.push(column);
    }

    // Transpose to get rows instead of columns
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const row = [];
      for (let j = 0; j < 5; j++) {
        row.push(card[j][i]);
      }
      rows.push(row);
    }

    // FREE space in the center (position 2,2)
    rows[2][2] = 'FREE';
    
    return rows;
  }

  static checkWinCondition(numbers, markedPositions) {
    if (markedPositions.length < 5) return false;

    const winPatterns = [
      // Rows
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14],
      [15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24],
      // Columns
      [0, 5, 10, 15, 20],
      [1, 6, 11, 16, 21],
      [2, 7, 12, 17, 22],
      [3, 8, 13, 18, 23],
      [4, 9, 14, 19, 24],
      // Diagonals
      [0, 6, 12, 18, 24],
      [4, 8, 12, 16, 20]
    ];

    return winPatterns.some(pattern => 
      pattern.every(position => 
        markedPositions.includes(position) || position === 12 // FREE space always counts
      )
    );
  }

  static getNumberLetter(number) {
    if (number === 'FREE') return 'FREE';
    if (number >= 1 && number <= 15) return 'B';
    if (number >= 16 && number <= 30) return 'I';
    if (number >= 31 && number <= 45) return 'N';
    if (number >= 46 && number <= 60) return 'G';
    if (number >= 61 && number <= 75) return 'O';
    return '';
  }

  static getWinningPattern(numbers, markedPositions) {
    const winningPatterns = [
      // Rows
      [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
      // Columns
      [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
      // Diagonals
      [0,6,12,18,24], [4,8,12,16,20]
    ];

    for (const pattern of winningPatterns) {
      if (pattern.every(pos => markedPositions.includes(pos))) {
        return {
          type: this.getPatternType(pattern),
          positions: pattern
        };
      }
    }

    return null;
  }

  static getPatternType(positions) {
    // Check if it's a row
    const rows = [[0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24]];
    if (rows.some(row => JSON.stringify(row) === JSON.stringify(positions))) {
      return 'ROW';
    }

    // Check if it's a column
    const cols = [[0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24]];
    if (cols.some(col => JSON.stringify(col) === JSON.stringify(positions))) {
      return 'COLUMN';
    }

    // Check if it's a diagonal
    const diags = [[0,6,12,18,24], [4,8,12,16,20]];
    if (diags.some(diag => JSON.stringify(diag) === JSON.stringify(positions))) {
      return 'DIAGONAL';
    }

    return 'CUSTOM';
  }
}

module.exports = GameUtils;