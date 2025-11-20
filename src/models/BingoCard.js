const mongoose = require('mongoose');

const bingoCardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  numbers: {
    type: [[Number]], // 5x5 grid
    required: true
  },
  markedPositions: {
    type: [Number],
    default: [12] // FREE space (center position in 5x5 grid)
  },
  isWinner: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

// Compound unique index - one card per user per game
bingoCardSchema.index({ userId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model('BingoCard', bingoCardSchema);