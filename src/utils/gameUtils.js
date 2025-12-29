// utils/gameUtils.js - CONSTANT BINGO CARDS ONLY
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
  // Same card number will always produce the same bingo card
  static generateBingoCard(cardNumber = 1) {
    // Define the ranges for each column (B, I, N, G, O)
    const ranges = [
      { min: 1, max: 15, count: 5 },    // B
      { min: 16, max: 30, count: 5 },   // I
      { min: 31, max: 45, count: 5 },   // N
      { min: 46, max: 60, count: 5 },   // G
      { min: 61, max: 75, count: 5 }    // O
    ];

    // Initialize empty card (5x5 grid)
    const card = [];

    // For each column, generate 5 unique numbers
    for (let col = 0; col < 5; col++) {
      const range = ranges[col];
      const numbers = [];
      
      // Create a seeded random generator for this column
      const seed = cardNumber * 100 + col;
      
      // Generate 5 unique numbers for this column
      for (let i = 0; i < 5; i++) {
        let num;
        let attempts = 0;
        
        do {
          // Use deterministic "random" based on seed
          const pseudoRandom = Math.sin(seed + i + attempts * 100) * 10000;
          const offset = Math.floor((pseudoRandom - Math.floor(pseudoRandom)) * (range.max - range.min + 1));
          num = range.min + offset;
          attempts++;
          
          if (attempts > 100) {
            // Fallback: sequential numbers
            num = range.min + i * 3;
          }
        } while (numbers.includes(num));
        
        numbers.push(num);
      }
      
      // Sort the numbers ascending
      numbers.sort((a, b) => a - b);
      card.push(numbers);
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

  // Helper to get card numbers as flat array for win checking
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
    if (!cardNumbers || !markedPositions) {
      return false;
    }

    // Always count FREE space as marked
    const effectiveMarked = [...new Set([...markedPositions, 12])];
    
    const winningPatterns = [
      // Rows
      [0, 1, 2, 3, 4],      // Row 1
      [5, 6, 7, 8, 9],      // Row 2
      [10, 11, 12, 13, 14], // Row 3 (includes FREE)
      [15, 16, 17, 18, 19], // Row 4
      [20, 21, 22, 23, 24], // Row 5
      
      // Columns
      [0, 5, 10, 15, 20],   // Col 1 (B)
      [1, 6, 11, 16, 21],   // Col 2 (I)
      [2, 7, 12, 17, 22],   // Col 3 (N)
      [3, 8, 13, 18, 23],   // Col 4 (G)
      [4, 9, 14, 19, 24],   // Col 5 (O)
      
      // Diagonals
      [0, 6, 12, 18, 24],   // Diagonal top-left to bottom-right
      [4, 8, 12, 16, 20]    // Diagonal top-right to bottom-left
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

  // Validate bingo card structure
  static validateBingoCard(card) {
    if (!Array.isArray(card) || card.length !== 5) return false;
    
    for (let i = 0; i < 5; i++) {
      if (!Array.isArray(card[i]) || card[i].length !== 5) return false;
    }
    
    // Check FREE space
    if (card[2][2] !== 'FREE') return false;
    
    return true;
  }

  // Print card for debugging
  static printCard(card) {
    console.log('\n🎯 Bingo Card:');
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
    console.log('-------------------\n');
  }
  
  // Get multiple constant cards
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

  // Test function to verify card generation
  static testCardGeneration() {
    console.log('\n🧪 Testing Bingo Card Generation...');
    
    for (let cardNum = 1; cardNum <= 3; cardNum++) {
      console.log(`\n📋 Card #${cardNum}:`);
      const card = this.generateBingoCard(cardNum);
      this.printCard(card);
      
      // Validate no duplicates in columns
      for (let col = 0; col < 5; col++) {
        const columnNumbers = [];
        for (let row = 0; row < 5; row++) {
          if (card[row][col] !== 'FREE') {
            columnNumbers.push(card[row][col]);
          }
        }
        
        const uniqueNumbers = [...new Set(columnNumbers)];
        if (uniqueNumbers.length !== columnNumbers.length) {
          console.log(`❌ Card #${cardNum} has duplicates in column ${col}`);
        } else {
          console.log(`✅ Card #${cardNum} column ${col}: ${columnNumbers.sort((a,b)=>a-b).join(', ')}`);
        }
      }
    }
  }
}

module.exports = GameUtils;