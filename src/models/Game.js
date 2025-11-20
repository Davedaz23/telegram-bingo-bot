// models/Game.js
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
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
  startedAt: {
    type: Date
  },
  endedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes for better performance
gameSchema.index({ code: 1 });
gameSchema.index({ status: 1 });
gameSchema.index({ hostId: 1 });

module.exports = mongoose.model('Game', gameSchema);