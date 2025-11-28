// models/SMSDeposit.js - UPDATED
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
    enum: ['CBE Bank', 'Awash Bank', 'Dashen Bank', 'CBE Birr', 'Telebirr', 'UNKNOWN'],
    default: 'UNKNOWN'
  },
  extractedAmount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED', 'RECEIVED'],
    default: 'RECEIVED'
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  processedAt: {
    type: Date
  },
  autoApproved: {
    type: Boolean,
    default: false
  },
  smsType: {
    type: String,
    enum: ['MANUAL_DEPOSIT', 'AUTO_DETECTED', 'BANK_SMS'],
    default: 'BANK_SMS'
  }
}, {
  timestamps: true
});

// Indexes
smsDepositSchema.index({ telegramId: 1, status: 1 });
smsDepositSchema.index({ status: 1, createdAt: 1 });
smsDepositSchema.index({ autoApproved: 1 });
smsDepositSchema.index({ smsType: 1 });

module.exports = mongoose.model('SMSDeposit', smsDepositSchema);