// utils/gameUtils.js - FIXED VERSION
class GameUtils {
  static generateGameCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // Generate a fixed bingo card based on card number
  static generateBingoCard(cardNumber = 1) {
    // Ranges for B, I, N, G, O columns
    const ranges = [
      { min: 1, max: 15, letter: 'B' },    // B: 1-15
      { min: 16, max: 30, letter: 'I' },   // I: 16-30
      { min: 31, max: 45, letter: 'N' },   // N: 31-45
      { min: 46, max: 60, letter: 'G' },   // G: 46-60
      { min: 61, max: 75, letter: 'O' }    // O: 61-75
    ];

    // Initialize card as 5x5 grid
    const card = [];
    
    // For each column (B, I, N, G, O)
    for (let col = 0; col < 5; col++) {
      const range = ranges[col];
      const numbers = new Set(); // Use Set to ensure uniqueness
      
      // Create a pseudo-random number generator seeded with cardNumber
      let seed = cardNumber * 100 + col;
      
      // Generate 5 unique numbers for this column
      while (numbers.size < 5) {
        // Simple deterministic hash function
        seed = (seed * 9301 + 49297) % 233280;
        const rand = seed / 233280;
        
        // Calculate number within range
        const num = range.min + Math.floor(rand * (range.max - range.min + 1));
        
        numbers.add(num);
        
        // Prevent infinite loop
        if (numbers.size >= (range.max - range.min + 1)) {
          break;
        }
      }
      
      // Convert Set to Array and sort
      const sortedNumbers = Array.from(numbers).sort((a, b) => a - b);
      card.push(sortedNumbers);
    }

    // Convert from column-major to row-major (5 rows)
    const rows = [];
    for (let row = 0; row < 5; row++) {
      const currentRow = [];
      for (let col = 0; col < 5; col++) {
        currentRow.push(card[col][row]);
      }
      rows.push(currentRow);
    }

    // Set the free space (center)
    rows[2][2] = 'FREE';
    
    return rows;
  }

  // Helper to get card numbers as flat array
  static getCardNumbersArray(card) {
    const numbers = [];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        numbers.push(card[row][col]);
      }
    }
    return numbers;
  }

  static checkWinCondition(cardNumbers, markedPositions) {
    if (!cardNumbers || !markedPositions) return false;

    // Always count FREE space as marked (position 12)
    const effectiveMarked = [...new Set([...markedPositions, 12])];
    
    const winningPatterns = [
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

    for (const pattern of winningPatterns) {
      if (pattern.every(pos => effectiveMarked.includes(pos))) {
        return true;
      }
    }

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

  // Print card for debugging
  static printCard(card, cardNumber = 1) {
    console.log(`\n🎯 Card #${cardNumber}:`);
    console.log(' B   I   N   G   O');
    console.log('-------------------');
    
    for (let row = 0; row < 5; row++) {
      let rowStr = '';
      for (let col = 0; col < 5; col++) {
        const value = card[row][col];
        const display = value === 'FREE' ? 'FREE' : value.toString().padStart(2);
        rowStr += display.padEnd(5);
      }
      console.log(rowStr);
    }
    
    // Validate each column
    for (let col = 0; col < 5; col++) {
      const columnNumbers = [];
      for (let row = 0; row < 5; row++) {
        if (card[row][col] !== 'FREE') {
          columnNumbers.push(card[row][col]);
        }
      }
      const uniqueCount = new Set(columnNumbers).size;
      console.log(`Column ${['B','I','N','G','O'][col]}: ${columnNumbers.join(', ')} ${uniqueCount === 5 ? '✓' : '✗ (duplicates!)'}`);
    }
    console.log('-------------------\n');
  }

  // Test function
  static testCardGeneration(count = 5) {
    console.log(`🧪 Testing ${count} bingo cards...\n`);
    
    for (let i = 1; i <= count; i++) {
      const card = this.generateBingoCard(i);
      this.printCard(card, i);
    }
  }

  // Get multiple unique cards
  static getConstantCards(count = 100) {
    const cards = [];
    for (let i = 1; i <= count; i++) {
      const card = this.generateBingoCard(i);
      cards.push({
        id: i,
        card: card,
        numbers: this.getCardNumbersArray(card)
      });
    }
    return cards;
  }
}

module.exports = GameUtils;