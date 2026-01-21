// models/BingoCard.js - UPDATED with late joiner support
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
  // ✅ ADD THIS FIELD for card number
  cardNumber: {
    type: Number,
    required: true,
    min: 1,
    max: 400 // or whatever your max cards are
  },
  numbers: {
    type: [[mongoose.Schema.Types.Mixed]],
    required: true
  },
  markedPositions: {
    type: [Number],
    default: [12] // FREE space
  },
  isWinner: {
    type: Boolean,
    default: false
  },
  isSpectator: {
    type: Boolean,
    default: false
  },
  isLateJoiner: {
    type: Boolean,
    default: false
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  isDisqualified: {
    type: Boolean,
    default: false
  },
  disqualifiedAt: {
    type: Date
  },
  disqualificationReason: {
    type: String
  },
  winningPatternType: {
    type: String,
    enum: ['BINGO', 'ROW', 'COLUMN', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_CARD'],
    default: null
  },
  winningPositionIndex: {
    type: Number,
    default: null
  },
  winningPatternPositions: {
    type: [Number],
    default: []
  },
  numbersCalledAtJoin: {
    type: [Number],
    default: []
  }
}, {
  timestamps: true
});

// ✅ Update the index to include cardNumber uniqueness within a game
bingoCardSchema.index({ gameId: 1, cardNumber: 1 }, { unique: true });
bingoCardSchema.index({ userId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model('BingoCard', bingoCardSchema);