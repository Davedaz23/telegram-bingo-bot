// models/SMSDeposit.js
const mongoose = require('mongoose');

const smsDepositSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  telegramId: {
    type: String,
    required: true
  },
  originalSMS: {
    type: String,
    required: true
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['CBE Bank', 'Awash Bank', 'Dashen Bank', 'CBE Birr', 'Telebirr']
  },
  extractedAmount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'],
    default: 'PENDING'
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // Admin who processed it
  },
  processedAt: {
    type: Date
  },
  autoApproved: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes
smsDepositSchema.index({ telegramId: 1, status: 1 });
smsDepositSchema.index({ status: 1, createdAt: 1 });
smsDepositSchema.index({ autoApproved: 1 });

module.exports = mongoose.model('SMSDeposit', smsDepositSchema);