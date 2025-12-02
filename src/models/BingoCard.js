// models/Game.js - UPDATED WITH PROPER TIMING FIELDS
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE', 'FINISHED', 'COOLDOWN'],
    default: 'WAITING_FOR_PLAYERS'
  },
  maxPlayers: {
    type: Number,
    default: 10
  },
  currentPlayers: {
    type: Number,
    default: 0
  },
  numbersCalled: {
    type: [Number],
    default: []
  },
  winnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  isAutoCreated: {
    type: Boolean,
    default: false
  },
  startedAt: {
    type: Date
  },
  endedAt: {
    type: Date
  },
  
  // Game Lifecycle Timers
  cardSelectionStartTime: {
    type: Date
  },
  cardSelectionEndTime: {
    type: Date
  },
  gameStartTime: {
    type: Date
  },
  cooldownEndTime: {
    type: Date
  },
  
  // Auto-start timing
  autoStartEndTime: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      // Add timing-related virtuals
      const now = new Date();
      
      if (ret.status === 'CARD_SELECTION' && ret.cardSelectionEndTime) {
        ret.cardSelectionTimeRemaining = Math.max(0, ret.cardSelectionEndTime - now);
      }
      
      if (ret.status === 'COOLDOWN' && ret.cooldownEndTime) {
        ret.cooldownTimeRemaining = Math.max(0, ret.cooldownEndTime - now);
      }
      
      if (ret.status === 'WAITING_FOR_PLAYERS' && ret.autoStartEndTime) {
        ret.autoStartTimeRemaining = Math.max(0, ret.autoStartEndTime - now);
      }
      
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Virtuals for status checks
gameSchema.virtual('canJoin').get(function() {
  return this.status === 'WAITING_FOR_PLAYERS' || this.status === 'CARD_SELECTION';
});

gameSchema.virtual('canSelectCard').get(function() {
  return this.status === 'CARD_SELECTION';
});

gameSchema.virtual('isGameActive').get(function() {
  return this.status === 'ACTIVE';
});

gameSchema.virtual('isGameFinished').get(function() {
  return this.status === 'FINISHED' || this.status === 'COOLDOWN';
});

module.exports = mongoose.model('Game', gameSchema);