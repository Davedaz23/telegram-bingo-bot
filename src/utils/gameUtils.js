// utils/gameUtils.js - CONSTANT BINGO CARDS ONLY (FIXED)
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
    // Ensure cardNumber is within valid range
    if (cardNumber < 1) cardNumber = 1;
    if (cardNumber > 400) cardNumber = 400;
    
    // Use a deterministic algorithm to shuffle numbers
    const seed = cardNumber; // Use cardNumber as seed
    
    const ranges = [
      { min: 1, max: 15, letter: 'B' },    // B
      { min: 16, max: 30, letter: 'I' },   // I
      { min: 31, max: 45, letter: 'N' },   // N
      { min: 46, max: 60, letter: 'G' },   // G
      { min: 61, max: 75, letter: 'O' }    // O
    ];

    const card = [];
    
    // Generate numbers for each column
    for (let col = 0; col < 5; col++) {
      const range = ranges[col];
      
      // Create a list of all numbers in this column's range
      const allNumbers = [];
      for (let num = range.min; num <= range.max; num++) {
        allNumbers.push(num);
      }
      
      // Deterministic shuffle based on cardNumber and column
      const shuffledNumbers = this.deterministicShuffle([...allNumbers], seed + col * 1000);
      
      // Take first 5 unique numbers from the shuffled list
      const columnNumbers = shuffledNumbers.slice(0, 5);
      
      // Sort the selected numbers (ascending)
      columnNumbers.sort((a, b) => a - b);
      card.push(columnNumbers);
    }

    // Convert column-major to row-major format
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

  // Deterministic shuffle function
  static deterministicShuffle(array, seed) {
    const result = [...array];
    let currentSeed = seed;
    
    // Simple deterministic PRNG
    function deterministicRandom() {
      const x = Math.sin(currentSeed++) * 10000;
      return x - Math.floor(x);
    }
    
    // Fisher-Yates shuffle with deterministic random
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(deterministicRandom() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    
    return result;
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

  // Pre-generate all 400 cards for better performance
  static generateAllCards() {
    const allCards = new Map();
    
    for (let cardNumber = 1; cardNumber <= 400; cardNumber++) {
      const card = this.generateBingoCard(cardNumber);
      allCards.set(cardNumber, card);
    }
    
    return allCards;
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
    
    // Check for duplicate numbers (excluding FREE space)
    const allNumbers = new Set();
    for (let i = 0; i < 5; i++) {
      if (!Array.isArray(card[i]) || card[i].length !== 5) return false;
      
      for (let j = 0; j < 5; j++) {
        const value = card[i][j];
        if (i === 2 && j === 2) {
          if (value !== 'FREE') return false;
        } else {
          if (typeof value !== 'number' || value < 1 || value > 75) return false;
          
          // Check for duplicates
          if (allNumbers.has(value)) {
            console.warn(`Duplicate number detected: ${value} at position (${i},${j})`);
            return false;
          }
          allNumbers.add(value);
        }
      }
    }
    
    // Verify each column has numbers within correct range
    for (let col = 0; col < 5; col++) {
      const column = [];
      for (let row = 0; row < 5; row++) {
        if (row === 2 && col === 2) continue; // Skip FREE space
        column.push(card[row][col]);
      }
      
      // Sort column for range checking
      column.sort((a, b) => a - b);
      
      // Check B column (1-15)
      if (col === 0 && (column.some(n => n < 1 || n > 15))) return false;
      // Check I column (16-30)
      if (col === 1 && (column.some(n => n < 16 || n > 30))) return false;
      // Check N column (31-45)
      if (col === 2 && (column[column.length-1] < 31 || column[0] > 45)) return false;
      // Check G column (46-60)
      if (col === 3 && (column.some(n => n < 46 || n > 60))) return false;
      // Check O column (61-75)
      if (col === 4 && (column.some(n => n < 61 || n > 75))) return false;
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
  
  // Get a list of pre-defined constant cards
  static getConstantCards(count = 400) {
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
  
  // Test function to verify all cards are valid and unique
  static testCardGeneration() {
    console.log('🧪 Testing card generation...');
    const cards = new Map();
    const allNumbers = new Set();
    let duplicates = 0;
    
    for (let i = 1; i <= 400; i++) {
      const card = this.generateBingoCard(i);
      
      // Check if card is valid
      if (!this.validateBingoCard(card)) {
        console.error(`❌ Card ${i} failed validation`);
        return false;
      }
      
      // Check for duplicate cards
      const cardKey = JSON.stringify(card);
      if (cards.has(cardKey)) {
        duplicates++;
        console.warn(`⚠️ Card ${i} is duplicate of card ${cards.get(cardKey)}`);
      } else {
        cards.set(cardKey, i);
      }
      
      // Track all numbers for uniqueness check
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          if (row === 2 && col === 2) continue;
          allNumbers.add(card[row][col]);
        }
      }
    }
    
    console.log(`✅ Generated ${cards.size} unique cards`);
    console.log(`✅ Used ${allNumbers.size} unique numbers (max possible: 75)`);
    console.log(`✅ ${duplicates} duplicate cards found`);
    
    // Display sample card
    console.log('\n📋 Sample card #1:');
    this.debugCard(this.getCardNumbersArray(this.generateBingoCard(1)), []);
    
    console.log('\n📋 Sample card #100:');
    this.debugCard(this.getCardNumbersArray(this.generateBingoCard(100)), []);
    
    return duplicates === 0;
  }
}

module.exports = GameUtils;