// models/GamePlayer.js
const mongoose = require('mongoose');

const gamePlayerSchema = new mongoose.Schema({
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
  isReady: {
    type: Boolean,
    default: false
  },
  playerType: {
    type: String,
    enum: ['PLAYER', 'SPECTATOR'],
    default: 'PLAYER'
  }
}, {
  timestamps: { createdAt: 'joinedAt', updatedAt: false }
});

// Compound unique index to prevent duplicate joins
gamePlayerSchema.index({ userId: 1, gameId: 1 }, { unique: true });

module.exports = mongoose.model('GamePlayer', gamePlayerSchema);