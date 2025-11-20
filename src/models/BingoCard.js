// models/BingoCard.js
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
    type: [[mongoose.Schema.Types.Mixed]], // Change to Mixed to allow numbers and strings
    required: true
  },
  markedPositions: {
    type: [Number],
    default: [12] // FREE space is always marked
  },
  isWinner: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for faster queries
bingoCardSchema.index({ userId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model('BingoCard', bingoCardSchema);