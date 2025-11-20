require('dotenv').config();
const database = require('.//src/config/database');

async function testConnection() {
  try {
    console.log('🧪 Testing MongoDB Connection...');
    console.log('🔗 Connection URL:', process.env.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@'));
    
    // Test connection
    await database.connect();
    
    // Test database operations
    const mongoose = require('mongoose');
    
    // List all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('✅ Connected successfully!');
    console.log('📁 Database:', mongoose.connection.db.databaseName);
    console.log('📊 Collections:', collections.map(c => c.name));
    
    // Test CRUD operations
    const User = require('./src/models/User');
    
    // Create a test user
    const testUser = await User.create({
      telegramId: '123456789',
      firstName: 'Test User',
      username: 'testuser'
    });
    console.log('✅ Create test - User created:', testUser._id);
    
    // Read test
    const foundUser = await User.findOne({ telegramId: '123456789' });
    console.log('✅ Read test - User found:', foundUser ? 'Yes' : 'No');
    
    // Update test
    const updatedUser = await User.findByIdAndUpdate(
      testUser._id,
      { firstName: 'Updated Test User' },
      { new: true }
    );
    console.log('✅ Update test - User updated:', updatedUser.firstName);
    
    // Delete test
    await User.deleteOne({ _id: testUser._id });
    console.log('✅ Delete test - User deleted');
    
    // Health check
    const health = await database.healthCheck();
    console.log('🏥 Health Check:', health);
    
    await database.disconnect();
    console.log('🎉 All tests passed! MongoDB Atlas is working correctly.');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('💡 Troubleshooting tips:');
    console.log('   1. Check your MONGODB_URI in .env file');
    console.log('   2. Verify MongoDB Atlas cluster is running');
    console.log('   3. Check network access in MongoDB Atlas dashboard');
    console.log('   4. Verify database user credentials');
    process.exit(1);
  }
}

testConnection();