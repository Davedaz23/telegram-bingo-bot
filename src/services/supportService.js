const SupportChat = require('../models/SupportChat');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const mongoose = require('mongoose');

class SupportService {
  
  /**
   * Create a new support chat
   */
  async createSupportChat(userId, subject, priority = 'MEDIUM') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Check if user already has an open chat
      const existingChat = await SupportChat.findOne({
        userId,
        status: { $in: ['OPEN', 'ASSIGNED'] }
      }).session(session);

      if (existingChat) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: 'You already have an open support ticket',
          chat: existingChat
        };
      }

      // Create new chat
      const chat = new SupportChat({
        userId,
        subject,
        priority,
        status: 'OPEN',
        lastMessageAt: new Date()
      });

      await chat.save({ session });

      // Create system message
      const systemMessage = new SupportMessage({
        chatId: chat._id,
        senderId: userId,
        senderType: 'USER',
        message: `Support ticket created: ${subject}`,
        messageType: 'SYSTEM'
      });

      await systemMessage.save({ session });

      await session.commitTransaction();
      session.endSession();

      return {
        success: true,
        chat
      };

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Send a message in a support chat
   */
  async sendMessage(chatId, senderId, senderType, message, attachments = []) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const chat = await SupportChat.findById(chatId).session(session);
      if (!chat) {
        throw new Error('Chat not found');
      }

      // Verify sender has permission
      if (senderType === 'USER' && chat.userId.toString() !== senderId.toString()) {
        throw new Error('Unauthorized to send message in this chat');
      }

      // Create message
      const supportMessage = new SupportMessage({
        chatId,
        senderId,
        senderType,
        message,
        messageType: attachments.length > 0 ? 'FILE' : 'TEXT',
        attachments,
        'metadata.deliveredAt': new Date()
      });

      await supportMessage.save({ session });

      // Update chat
      chat.lastMessageAt = new Date();
      
      // Update unread count
      if (senderType === 'USER') {
        chat.unreadCount.admin += 1;
        chat.unreadCount.user = 0; // Reset user unread when they send
      } else {
        chat.unreadCount.user += 1;
        chat.unreadCount.admin = 0; // Reset admin unread when they send
      }

      // Auto-assign to admin if not assigned
      if (senderType === 'USER' && !chat.assignedTo && chat.status === 'OPEN') {
        // Logic to assign to available admin can be added here
        chat.status = 'ASSIGNED';
      }

      await chat.save({ session });

      await session.commitTransaction();
      session.endSession();

      return {
        success: true,
        message: supportMessage,
        chat
      };

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Get chat history for a user
   */
  async getUserChats(userId, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const chats = await SupportChat.find({ userId })
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedTo', 'firstName username')
      .lean();

    const total = await SupportChat.countDocuments({ userId });

    // Get last message for each chat
    for (let chat of chats) {
      const lastMessage = await SupportMessage.findOne({ chatId: chat._id })
        .sort({ createdAt: -1 })
        .lean();
      chat.lastMessage = lastMessage;
    }

    return {
      chats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get chat messages
   */
  async getChatMessages(chatId, userId, isAdmin = false, page = 1, limit = 50) {
    const chat = await SupportChat.findById(chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }

    // Verify access
    if (!isAdmin && chat.userId.toString() !== userId.toString()) {
      throw new Error('Access denied');
    }

    const skip = (page - 1) * limit;

    const messages = await SupportMessage.find({ 
      chatId,
      'metadata.deleted': false 
    })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId', 'firstName username')
      .lean();

    const total = await SupportMessage.countDocuments({ 
      chatId,
      'metadata.deleted': false 
    });

    // Mark messages as read
    if (isAdmin) {
      await SupportChat.findByIdAndUpdate(chatId, { 'unreadCount.admin': 0 });
      await SupportMessage.updateMany(
        { 
          chatId, 
          senderType: 'USER',
          'metadata.readAt': null 
        },
        { 'metadata.readAt': new Date() }
      );
    } else {
      await SupportChat.findByIdAndUpdate(chatId, { 'unreadCount.user': 0 });
      await SupportMessage.updateMany(
        { 
          chatId, 
          senderType: 'ADMIN',
          'metadata.readAt': null 
        },
        { 'metadata.readAt': new Date() }
      );
    }

    return {
      chat,
      messages,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get all open chats (admin)
   */
  async getOpenChats(adminId, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const chats = await SupportChat.find({
      status: { $in: ['OPEN', 'ASSIGNED'] }
    })
      .sort({ priority: -1, lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'firstName username telegramId')
      .populate('assignedTo', 'firstName username')
      .lean();

    const total = await SupportChat.countDocuments({
      status: { $in: ['OPEN', 'ASSIGNED'] }
    });

    // Get unread counts
    for (let chat of chats) {
      const lastMessage = await SupportMessage.findOne({ chatId: chat._id })
        .sort({ createdAt: -1 })
        .lean();
      chat.lastMessage = lastMessage;
    }

    return {
      chats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Assign chat to admin
   */
  async assignChat(chatId, adminId) {
    const chat = await SupportChat.findByIdAndUpdate(
      chatId,
      {
        assignedTo: adminId,
        status: 'ASSIGNED'
      },
      { new: true }
    );

    // Create system message
    const admin = await User.findById(adminId);
    await SupportMessage.create({
      chatId,
      senderId: adminId,
      senderType: 'ADMIN',
      message: `Chat assigned to ${admin.firstName || 'Admin'}`,
      messageType: 'SYSTEM'
    });

    return chat;
  }

  /**
   * Resolve/close chat
   */
  async closeChat(chatId, closedBy, reason = 'Resolved') {
    const chat = await SupportChat.findByIdAndUpdate(
      chatId,
      {
        status: 'RESOLVED',
        'metadata.closedBy': closedBy,
        'metadata.closedAt': new Date(),
        'metadata.closureReason': reason
      },
      { new: true }
    );

    // Create system message
    const closer = await User.findById(closedBy);
    await SupportMessage.create({
      chatId,
      senderId: closedBy,
      senderType: closer.isAdmin ? 'ADMIN' : 'USER',
      message: `Chat closed: ${reason}`,
      messageType: 'SYSTEM'
    });

    return chat;
  }

  /**
   * Reopen closed chat
   */
  async reopenChat(chatId, userId) {
    const chat = await SupportChat.findOneAndUpdate(
      {
        _id: chatId,
        userId,
        status: 'RESOLVED'
      },
      {
        status: 'OPEN',
        'metadata.closedBy': null,
        'metadata.closedAt': null,
        'metadata.closureReason': null
      },
      { new: true }
    );

    if (chat) {
      await SupportMessage.create({
        chatId,
        senderId: userId,
        senderType: 'USER',
        message: 'Chat reopened',
        messageType: 'SYSTEM'
      });
    }

    return chat;
  }

  /**
   * Get support statistics
   */
  async getSupportStats() {
    const stats = await SupportChat.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          chats: { $push: '$$ROOT' }
        }
      }
    ]);

    const unassigned = await SupportChat.countDocuments({
      status: 'OPEN',
      assignedTo: null
    });

    const avgResponseTime = await SupportMessage.aggregate([
      {
        $match: { senderType: 'ADMIN' }
      },
      {
        $lookup: {
          from: 'supportmessages',
          let: { chatId: '$chatId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$chatId', '$$chatId'] },
                    { $eq: ['$senderType', 'USER'] }
                  ]
                }
              }
            },
            { $sort: { createdAt: 1 } },
            { $limit: 1 }
          ],
          as: 'userMessage'
        }
      },
      {
        $match: { 'userMessage.0': { $exists: true } }
      },
      {
        $project: {
          responseTime: {
            $subtract: ['$createdAt', { $arrayElemAt: ['$userMessage.createdAt', 0] }]
          }
        }
      },
      {
        $group: {
          _id: null,
          avgResponseTime: { $avg: '$responseTime' }
        }
      }
    ]);

    return {
      byStatus: stats,
      unassigned,
      avgResponseTime: avgResponseTime[0]?.avgResponseTime || 0,
      totalChats: await SupportChat.countDocuments()
    };
  }
}

module.exports = new SupportService();