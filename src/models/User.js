const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true  // This automatically creates a unique index
  },
  username: String,  // REMOVED sparse: true - let it be optional naturally
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
  }
}, {
  timestamps: true
});


module.exports = mongoose.model('User', userSchema);