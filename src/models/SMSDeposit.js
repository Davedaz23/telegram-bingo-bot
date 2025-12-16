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
    enum: ['CBE Bank', 'Awash Bank', 'Dashen Bank', 'CBE Birr', 'Telebirr', 'UNKNOWN'],
    default: 'UNKNOWN'
  },
  extractedAmount: {
    type: Number,
    required: true
  },
  extractedReference: {
    type: String,  // NEW: Store extracted reference number
    index: true
  },
  status: {
    type: String,
    enum: [
      'RECEIVED', 
      'RECEIVED_WAITING_MATCH',
      'PENDING', 
      'APPROVED', 
      'REJECTED', 
      'AUTO_APPROVED', 
      'PROCESSING',
      'CONFIRMED',
      'AUTO_MATCHED'
    ],
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
    enum: ['MANUAL_DEPOSIT', 'AUTO_DETECTED', 'BANK_SMS', 'SENDER', 'RECEIVER'],
    default: 'BANK_SMS'
  }
}, {
  timestamps: true
});

// Indexes for better matching performance
smsDepositSchema.index({ telegramId: 1, status: 1 });
smsDepositSchema.index({ status: 1, createdAt: 1 });
smsDepositSchema.index({ autoApproved: 1 });
smsDepositSchema.index({ smsType: 1 });
smsDepositSchema.index({ 'metadata.smsType': 1 });
smsDepositSchema.index({ extractedAmount: 1, createdAt: 1 });
smsDepositSchema.index({ extractedReference: 1, status: 1 }); // NEW: Index for reference matching

module.exports = mongoose.model('SMSDeposit', smsDepositSchema);