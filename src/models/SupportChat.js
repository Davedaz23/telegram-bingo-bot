const mongoose = require('mongoose');

const supportChatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  status: {
    type: String,
    enum: ['OPEN', 'ASSIGNED', 'RESOLVED', 'CLOSED'],
    default: 'OPEN'
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  unreadCount: {
    user: { type: Number, default: 0 },
    admin: { type: Number, default: 0 }
  },
  metadata: {
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: Date,
    closureReason: String,
    rating: { type: Number, min: 1, max: 5 },
    feedback: String
  },
  tags: [String],
  priority: {
    type: String,
    enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
    default: 'MEDIUM'
  }
}, {
  timestamps: true
});

// Indexes for better query performance
supportChatSchema.index({ userId: 1, status: 1 });
supportChatSchema.index({ assignedTo: 1, status: 1 });
supportChatSchema.index({ lastMessageAt: -1 });
supportChatSchema.index({ status: 1, priority: 1 });

const SupportChat = mongoose.model('SupportChat', supportChatSchema);
module.exports = SupportChat;