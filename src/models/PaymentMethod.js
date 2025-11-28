// models/PaymentMethod.js
const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['BANK', 'MOBILE_MONEY'],
    required: true
  },
  accountName: String,
  accountNumber: String,
  instructions: {
    type: String,
    required: true
  },
  smsFormat: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);