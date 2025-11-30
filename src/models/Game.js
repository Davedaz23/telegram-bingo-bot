// models/Game.js - CORRECTED VERSION
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
  // CARD SELECTION FIELDS
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
  },
  // AUTO-START TIMER FIELD (REMOVED hasAutoStartTimer as database field)
  autoStartEndTime: {
    type: Date
  }
  // REMOVED: hasAutoStartTimer database field
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

// Virtual for card selection status
gameSchema.virtual('isCardSelectionActive').get(function() {
  return new Date() < this.cardSelectionEndTime && this.status === 'WAITING';
});

// Virtual for auto-start timer status
gameSchema.virtual('autoStartTimeRemaining').get(function() {
  if (this.autoStartEndTime && this.autoStartEndTime > new Date()) {
    return this.autoStartEndTime - new Date();
  }
  return 0;
});

// Virtual for auto-start timer active status
gameSchema.virtual('hasAutoStartTimer').get(function() {
  return !!(this.autoStartEndTime && this.autoStartEndTime > new Date());
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
gameSchema.index({ autoStartEndTime: 1 }); // New index for auto-start timer

// REMOVED: Pre-save middleware for hasAutoStartTimer since it's now virtual

module.exports = mongoose.model('Game', gameSchema);