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
  // ✅ NEW: Track late joiners
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
  // Track which numbers were already called when they joined
  numbersCalledAtJoin: {
    type: [Number],
    default: []
  }
}, {
  timestamps: true
});

// Index for faster queries
bingoCardSchema.index({ userId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model('BingoCard', bingoCardSchema);