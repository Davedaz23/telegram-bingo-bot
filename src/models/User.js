// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true  // This creates one index - NO additional index definitions
  },
  username: String,
  firstName: String,
  lastName: String,
  languageCode: String,
  isBot: {
    type: Boolean,
    default: false
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
  totalScore: {
    type: Number,
    default: 0,
    min: 0
  },
  walletBalance: {
    type: Number,
    default: 100,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// ⚠️ REMOVE ANY ADDITIONAL INDEX DEFINITIONS LIKE THIS:
// userSchema.index({ telegramId: 1 }); // DELETE THIS LINE IF IT EXISTS
// userSchema.index({ userId: 1 }); // DELETE THIS LINE IF IT EXISTS

module.exports = mongoose.model('User', userSchema);