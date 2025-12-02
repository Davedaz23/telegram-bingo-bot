// models/Game.js - UPDATED WITH NEW GAME LIFECYCLE
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['WAITING_FOR_PLAYERS', 'CARD_SELECTION', 'ACTIVE', 'FINISHED', 'CANCELLED', 'COOLDOWN'],
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
  // CARD SELECTION TIMING
  cardSelectionStartTime: {
    type: Date
  },
  cardSelectionEndTime: {
    type: Date
  },
  // AUTO-START TIMING
  autoStartEndTime: {
    type: Date
  },
  // COOLDOWN TIMING
  cooldownEndTime: {
    type: Date
  },
  // Legacy field for backward compatibility
  selectedCards: {
    type: Map,
    of: mongoose.Schema.Types.ObjectId,
    default: new Map()
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      const now = new Date();
      
      // Convert Map to Object for JSON serialization
      if (ret.selectedCards instanceof Map) {
        ret.selectedCards = Object.fromEntries(ret.selectedCards);
      } else if (ret.selectedCards && typeof ret.selectedCards === 'object') {
        // Already an object, no transformation needed
      } else {
        ret.selectedCards = {};
      }
      
      // Add virtual fields for timing
      
      // Auto-start timer
      if (ret.autoStartEndTime && ret.autoStartEndTime > now) {
        ret.autoStartTimeRemaining = ret.autoStartEndTime - now;
        ret.hasAutoStartTimer = true;
      } else {
        ret.autoStartTimeRemaining = 0;
        ret.hasAutoStartTimer = false;
      }
      
      // Card selection timer
      if (ret.cardSelectionEndTime && ret.cardSelectionEndTime > now) {
        ret.cardSelectionTimeRemaining = ret.cardSelectionEndTime - now;
        ret.isCardSelectionActive = true;
      } else {
        ret.cardSelectionTimeRemaining = 0;
        ret.isCardSelectionActive = false;
      }
      
      // Cooldown timer
      if (ret.cooldownEndTime && ret.cooldownEndTime > now) {
        ret.cooldownTimeRemaining = ret.cooldownEndTime - now;
      } else {
        ret.cooldownTimeRemaining = 0;
      }
      
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Virtual for canJoin - users can only join during WAITING_FOR_PLAYERS phase
gameSchema.virtual('canJoin').get(function() {
  const now = new Date();
  
  // Can only join during WAITING_FOR_PLAYERS phase
  // NOT during CARD_SELECTION or ACTIVE phases
  return this.status === 'WAITING_FOR_PLAYERS' && 
         (!this.cardSelectionEndTime || now < this.cardSelectionEndTime);
});

// Virtual for canSelectCard - users can select cards during specific phases
gameSchema.virtual('canSelectCard').get(function() {
  const now = new Date();
  
  // Can select card during WAITING_FOR_PLAYERS or CARD_SELECTION phases
  // But only before card selection ends
  return (this.status === 'WAITING_FOR_PLAYERS' || this.status === 'CARD_SELECTION') &&
         (!this.cardSelectionEndTime || now < this.cardSelectionEndTime);
});

// Virtual for isGameActive
gameSchema.virtual('isGameActive').get(function() {
  return this.status === 'ACTIVE';
});

// Virtual for isGameFinished
gameSchema.virtual('isGameFinished').get(function() {
  return this.status === 'FINISHED' || this.status === 'COOLDOWN';
});

// Virtual for isCardSelectionActive (alternative calculation)
gameSchema.virtual('isCardSelectionActiveAlt').get(function() {
  const now = new Date();
  return (this.status === 'WAITING_FOR_PLAYERS' || this.status === 'CARD_SELECTION') &&
         this.cardSelectionEndTime && now < this.cardSelectionEndTime;
});

// Virtual for autoStartTimeRemaining (alternative calculation)
gameSchema.virtual('autoStartTimeRemainingAlt').get(function() {
  if (this.autoStartEndTime && this.autoStartEndTime > new Date()) {
    return this.autoStartEndTime - new Date();
  }
  return 0;
});

// Virtual for cardSelectionTimeRemaining
gameSchema.virtual('cardSelectionTimeRemaining').get(function() {
  if (this.cardSelectionEndTime && this.cardSelectionEndTime > new Date()) {
    return this.cardSelectionEndTime - new Date();
  }
  return 0;
});

// Virtual for cooldownTimeRemaining
gameSchema.virtual('cooldownTimeRemaining').get(function() {
  if (this.cooldownEndTime && this.cooldownEndTime > new Date()) {
    return this.cooldownEndTime - new Date();
  }
  return 0;
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
gameSchema.index({ autoStartEndTime: 1 });
gameSchema.index({ cardSelectionEndTime: 1 });
gameSchema.index({ cooldownEndTime: 1 });
gameSchema.index({ status: 1, cardSelectionEndTime: 1 });

// Pre-save middleware to ensure consistency
gameSchema.pre('save', function(next) {
  const now = new Date();
  
  // Clear timing fields based on status
  switch (this.status) {
    case 'WAITING_FOR_PLAYERS':
      // Keep autoStartEndTime if set, clear others
      this.cardSelectionStartTime = null;
      this.cardSelectionEndTime = null;
      this.cooldownEndTime = null;
      break;
      
    case 'CARD_SELECTION':
      // Ensure we have card selection timing
      if (!this.cardSelectionStartTime) {
        this.cardSelectionStartTime = now;
      }
      if (!this.cardSelectionEndTime) {
        this.cardSelectionEndTime = new Date(now.getTime() + (30 * 1000)); // 30 seconds default
      }
      this.autoStartEndTime = null;
      this.cooldownEndTime = null;
      break;
      
    case 'ACTIVE':
      // Clear all timing fields except startedAt
      this.autoStartEndTime = null;
      this.cardSelectionStartTime = null;
      this.cardSelectionEndTime = null;
      this.cooldownEndTime = null;
      break;
      
    case 'COOLDOWN':
      // Set cooldown timing
      if (!this.cooldownEndTime) {
        this.cooldownEndTime = new Date(now.getTime() + (60 * 1000)); // 60 seconds default
      }
      this.autoStartEndTime = null;
      this.cardSelectionStartTime = null;
      this.cardSelectionEndTime = null;
      break;
      
    case 'FINISHED':
    case 'CANCELLED':
      // Clear all timing fields
      this.autoStartEndTime = null;
      this.cardSelectionStartTime = null;
      this.cardSelectionEndTime = null;
      this.cooldownEndTime = null;
      break;
  }
  
  // Update hasAutoStartTimer based on autoStartEndTime
  if (this.autoStartEndTime && this.autoStartEndTime > now) {
    this.hasAutoStartTimer = true;
  } else {
    this.hasAutoStartTimer = false;
  }
  
  next();
});

module.exports = mongoose.model('Game', gameSchema);