const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  lockedAmount: { // ✅ ADD THIS FIELD for tracking pending withdrawals
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'USD'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  metadata: { // ✅ Optional: Add metadata for additional tracking
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

// Index for faster queries
walletSchema.index({ userId: 1 });

// Virtual for available balance
walletSchema.virtual('availableBalance').get(function() {
  return Math.max(0, this.balance - (this.lockedAmount || 0));
});

// Virtual for total balance (available + locked)
walletSchema.virtual('totalBalance').get(function() {
  return this.balance;
});

module.exports = mongoose.model('Wallet', walletSchema);