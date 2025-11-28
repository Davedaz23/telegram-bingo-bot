// models/User.js - UPDATED
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true
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

// Remove any additional index definitions
module.exports = mongoose.model('User', userSchema);