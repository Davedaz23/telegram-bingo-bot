// utils/gameUtils.js - COMPLETE FIXED VERSION
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
    const ranges = [
      { min: 1, max: 15 },   // B
      { min: 16, max: 30 },  // I
      { min: 31, max: 45 },  // N
      { min: 46, max: 60 },  // G
      { min: 61, max: 75 }   // O
    ];

    const card = [];
    
    for (let col = 0; col < 5; col++) {
      const numbers = new Set();
      
      while (numbers.size < 5) {
        const num = Math.floor(Math.random() * (ranges[col].max - ranges[col].min + 1)) + ranges[col].min;
        numbers.add(num);
      }
      
      const sortedNumbers = Array.from(numbers).sort((a, b) => a - b);
      card.push(sortedNumbers);
    }

    const rows = [];
    for (let row = 0; row < 5; row++) {
      const currentRow = [];
      for (let col = 0; col < 5; col++) {
        currentRow.push(card[col][row]);
      }
      rows.push(currentRow);
    }

    rows[2][2] = 'FREE';
    
    return rows;
  }

  static checkWinCondition(cardNumbers, markedPositions) {
    if (!cardNumbers || !markedPositions) {
      console.log('❌ checkWinCondition: Missing cardNumbers or markedPositions');
      return false;
    }

    const effectiveMarked = [...new Set([...markedPositions, 12])];
    
    console.log(`🔍 Checking win condition: ${effectiveMarked.length} marked positions`);

    const winningPatterns = [
      // Rows
      { type: 'ROW', positions: [0, 1, 2, 3, 4] },
      { type: 'ROW', positions: [5, 6, 7, 8, 9] },
      { type: 'ROW', positions: [10, 11, 12, 13, 14] },
      { type: 'ROW', positions: [15, 16, 17, 18, 19] },
      { type: 'ROW', positions: [20, 21, 22, 23, 24] },
      
      // Columns
      { type: 'COLUMN', positions: [0, 5, 10, 15, 20] },
      { type: 'COLUMN', positions: [1, 6, 11, 16, 21] },
      { type: 'COLUMN', positions: [2, 7, 12, 17, 22] },
      { type: 'COLUMN', positions: [3, 8, 13, 18, 23] },
      { type: 'COLUMN', positions: [4, 9, 14, 19, 24] },
      
      // Diagonals
      { type: 'DIAGONAL', positions: [0, 6, 12, 18, 24] },
      { type: 'DIAGONAL', positions: [4, 8, 12, 16, 20] }
    ];

    for (const pattern of winningPatterns) {
      const isComplete = pattern.positions.every(pos => effectiveMarked.includes(pos));
      
      if (isComplete) {
        console.log(`🎯 WINNING ${pattern.type} PATTERN DETECTED!`);
        console.log(`🏆 Winning positions: [${pattern.positions.join(', ')}]`);
        
        const winningNumbers = pattern.positions.map(pos => {
          const number = cardNumbers[pos];
          const row = Math.floor(pos / 5);
          const col = pos % 5;
          return `${number} (${row},${col})`;
        });
        console.log(`🔢 Winning numbers: ${winningNumbers.join(' → ')}`);
        
        return true;
      }
    }

    console.log('❌ No winning pattern found');
    return false;
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

    const posStr = JSON.stringify(positions.sort((a, b) => a - b));
    
    if (rowPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'ROW';
    if (colPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'COLUMN';
    if (diagPatterns.some(pattern => JSON.stringify(pattern) === posStr)) return 'DIAGONAL';
    
    return 'CUSTOM';
  }

  static validateBingoCard(card) {
    if (!Array.isArray(card) || card.length !== 5) return false;
    
    for (let i = 0; i < 5; i++) {
      if (!Array.isArray(card[i]) || card[i].length !== 5) return false;
      
      for (let j = 0; j < 5; j++) {
        const value = card[i][j];
        if (i === 2 && j === 2) {
          if (value !== 'FREE') return false;
        } else {
          if (typeof value !== 'number' || value < 1 || value > 75) return false;
        }
      }
    }
    
    return true;
  }

  static getCardPosition(row, col) {
    return row * 5 + col;
  }

  static getRowColFromPosition(position) {
    return {
      row: Math.floor(position / 5),
      col: position % 5
    };
  }

  static debugCard(cardNumbers, markedPositions, title = "Bingo Card") {
    console.log(`\n🎯 ${title}`);
    console.log('B   I   N   G   O');
    console.log('-----------------');
    
    for (let row = 0; row < 5; row++) {
      let rowStr = '';
      for (let col = 0; col < 5; col++) {
        const position = row * 5 + col;
        const number = cardNumbers[position];
        const isMarked = markedPositions.includes(position);
        const isFree = number === 'FREE';
        
        let display = number.toString().padStart(2);
        if (isMarked) display = `[${display}]`;
        if (isFree) display = 'FREE';
        
        rowStr += display.padEnd(6);
      }
      console.log(rowStr);
    }
    
    console.log(`Marked: ${markedPositions.length}/25 positions`);
    console.log('-----------------\n');
  }
}

module.exports = GameUtils;