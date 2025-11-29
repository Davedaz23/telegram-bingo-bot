// models/User.js - UPDATED WITH ROLE SUPPORT
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    sparse: true
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String
  },
  telegramUsername: {
    type: String
  },
  photoUrl: {
    type: String
  },
  authDate: {
    type: Date,
    required: true
  },
  hash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['user', 'moderator', 'admin'],
    default: 'user'
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  isModerator: {
    type: Boolean,
    default: false
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  gamesPlayed: {
    type: Number,
    default: 0,
    min: 0
  },
  gamesWon: {
    type: Number,
    default: 0,
    min: 0
  },
  totalWinnings: {
    type: Number,
    default: 0,
    min: 0
  },
  walletBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for better performance
userSchema.index({ telegramId: 1 });
userSchema.index({ role: 1 });
userSchema.index({ isAdmin: 1 });
userSchema.index({ isModerator: 1 });
userSchema.index({ lastLogin: -1 });

// Static method to check if user is admin
userSchema.statics.isAdmin = function(telegramId) {
  return this.findOne({
    telegramId,
    $or: [
      { role: 'admin' },
      { isAdmin: true }
    ]
  });
};

// Static method to check if user is moderator
userSchema.statics.isModerator = function(telegramId) {
  return this.findOne({
    telegramId,
    $or: [
      { role: 'moderator' },
      { isModerator: true }
    ]
  });
};

// Instance method to check if user is admin
userSchema.methods.isAdminUser = function() {
  return this.role === 'admin' || this.isAdmin === true;
};

// Instance method to check if user is moderator
userSchema.methods.isModeratorUser = function() {
  return this.role === 'moderator' || this.isModerator === true;
};

// Instance method to get user role
userSchema.methods.getRole = function() {
  if (this.role === 'admin' || this.isAdmin) return 'admin';
  if (this.role === 'moderator' || this.isModerator) return 'moderator';
  return 'user';
};

// Update user stats when they win a game
userSchema.methods.updateWinStats = function(prizeAmount = 0) {
  this.gamesPlayed += 1;
  this.gamesWon += 1;
  this.totalWinnings += prizeAmount;
  return this.save();
};

// Update user stats when they lose a game
userSchema.methods.updateLossStats = function() {
  this.gamesPlayed += 1;
  return this.save();
};

module.exports = mongoose.model('User', userSchema);