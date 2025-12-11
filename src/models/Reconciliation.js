// models/Reconciliation.js
const mongoose = require('mongoose');

const reconciliationSchema = new mongoose.Schema({
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'DEDUCTED', 'WINNER_DECLARED', 'NO_WINNER_REFUNDED', 'COMPLETED', 'ERROR'],
    default: 'PENDING'
  },
  totalPot: {
    type: Number,
    default: 0,
    min: 0
  },
  platformFee: {
    type: Number,
    default: 0,
    min: 0
  },
  winnerAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  winnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  transactions: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    type: {
      type: String,
      enum: ['ENTRY_FEE', 'WINNING', 'REFUND', 'PLATFORM_FEE'],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction'
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      default: 'PENDING'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  auditTrail: [{
    action: String,
    details: mongoose.Schema.Types.Mixed,
    timestamp: {
      type: Date,
      default: Date.now
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  debitTotal: {
    type: Number,
    default: 0,
    min: 0
  },
  creditTotal: {
    type: Number,
    default: 0,
    min: 0
  },
  balance: {
    type: Number,
    default: 0
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes for performance
reconciliationSchema.index({ gameId: 1, status: 1 });
reconciliationSchema.index({ winnerId: 1 });
reconciliationSchema.index({ 'transactions.userId': 1 });

// Method to add audit trail
reconciliationSchema.methods.addAudit = function(action, details, userId = null) {
  this.auditTrail.push({
    action,
    details,
    performedBy: userId,
    timestamp: new Date()
  });
};

// Method to check if reconciliation is balanced
reconciliationSchema.methods.isBalanced = function() {
  this.balance = this.creditTotal - this.debitTotal;
  return Math.abs(this.balance) < 0.01; // Allow small floating point differences
};

module.exports = mongoose.model('Reconciliation', reconciliationSchema);