// models/PaymentRecord.js
const mongoose = require('mongoose');

const paymentRecordSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    required: true
  },
  type: {
    type: String,
    enum: ['WITHDRAWAL', 'REFUND', 'PAYOUT'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  method: {
    type: String,
    required: true
  },
  accountDetails: {
    type: Object,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'PAID', 'FAILED'],
    default: 'PENDING'
  },
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paidAt: Date,
  failureReason: String,
  reference: String
}, {
  timestamps: true
});

module.exports = mongoose.model('PaymentRecord', paymentRecordSchema);