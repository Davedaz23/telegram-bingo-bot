// models/Game.js
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },
  // REMOVED: hostId field since we don't have hosts anymore
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
  // ADDED: Field to identify auto-created system games
  isAutoCreated: {
    type: Boolean,
    default: false
  },
  startedAt: {
    type: Date
  },
  endedAt: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
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