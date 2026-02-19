const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SupportChat',
    required: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  senderType: {
    type: String,
    enum: ['USER', 'ADMIN'],
    required: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  messageType: {
    type: String,
    enum: ['TEXT', 'IMAGE', 'FILE', 'SYSTEM'],
    default: 'TEXT'
  },
  attachments: [{
    fileId: String,
    fileName: String,
    fileSize: Number,
    mimeType: String,
    url: String
  }],
  metadata: {
    edited: { type: Boolean, default: false },
    editedAt: Date,
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deleted: { type: Boolean, default: false },
    deletedAt: Date,
    deliveredAt: Date,
    readAt: Date
  }
}, {
  timestamps: true
});

// Indexes
supportMessageSchema.index({ chatId: 1, createdAt: 1 });
supportMessageSchema.index({ senderId: 1, createdAt: -1 });

const SupportMessage = mongoose.model('SupportMessage', supportMessageSchema);
module.exports = SupportMessage;