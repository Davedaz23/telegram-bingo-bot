const mongoose = require('mongoose');
// Your MongoDB URI - in production, use environment variables
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// ✅ ADD THIS: Initialize and launch the bot with admin ID
