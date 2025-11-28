// models/Game.js - UPDATED VERSION
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['WAITING', 'ACTIVE', 'FINISHED', 'CANCELLED'],
    default: 'WAITING'
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
  // ADD THESE FIELDS FOR CARD SELECTION
  selectedCards: {
    type: Map,
    of: mongoose.Schema.Types.ObjectId,
    default: new Map()
  },
  cardSelectionEndTime: {
    type: Date,
    default: function() {
      return new Date(Date.now() + 30 * 1000); // 30 seconds from creation
    }
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      // Convert Map to Object for JSON serialization
      if (ret.selectedCards instanceof Map) {
        ret.selectedCards = Object.fromEntries(ret.selectedCards);
      } else if (ret.selectedCards && typeof ret.selectedCards === 'object') {
        // Already an object, no transformation needed
      } else {
        ret.selectedCards = {};
      }
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Add virtual for card selection status
gameSchema.virtual('isCardSelectionActive').get(function() {
  return new Date() < this.cardSelectionEndTime && this.status === 'WAITING';
});

// Virtual for players
gameSchema.virtual('players', {
  ref: 'GamePlayer',
  localField: '_id',
  foreignField: 'gameId'
});

// Virtual for host (for backward compatibility - returns null)
gameSchema.virtual('host').get(function() {
  return null;
});

// Indexes for better performance
gameSchema.index({ code: 1 });
gameSchema.index({ status: 1 });
gameSchema.index({ isAutoCreated: 1 });
gameSchema.index({ status: 1, isAutoCreated: 1 });

module.exports = mongoose.model('Game', gameSchema);