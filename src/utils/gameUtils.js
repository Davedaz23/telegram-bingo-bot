class GameUtils {
  static generateBingoCard() {
    const columns = {
      B: this.generateColumn(1, 15),
      I: this.generateColumn(16, 30),
      N: this.generateColumn(31, 45),
      G: this.generateColumn(46, 60),
      O: this.generateColumn(61, 75)
    };
    
    // Create 5x5 card with FREE space in middle
    const card = [];
    for (let i = 0; i < 5; i++) {
      const row = [
        columns.B[i],
        columns.I[i],
        columns.N[i],
        columns.G[i],
        columns.O[i]
      ];
      card.push(row);
    }
    
    // Middle space is FREE
    card[2][2] = 'FREE';
    
    return card;
  }

  static generateColumn(min, max) {
    const numbers = [];
    while (numbers.length < 5) {
      const num = Math.floor(Math.random() * (max - min + 1)) + min;
      if (!numbers.includes(num)) {
        numbers.push(num);
      }
    }
    return numbers;
  }

  static generateGameCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  static checkWinCondition(card, markedPositions) {
    const lines = [
      // Rows
      [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24],
      // Columns
      [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24],
      // Diagonals
      [0,6,12,18,24], [4,8,12,16,20]
    ];

    for (const line of lines) {
      if (line.every(pos => markedPositions.includes(pos))) {
        return true;
      }
    }
    return false;
  }
}

module.exports = GameUtils;