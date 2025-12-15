const mongoose = require('mongoose');

class Database {
  constructor() {
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 2;
  }

  async connect() {
    try {
      const MONGODB_URI = process.env.MONGODB_URI;
      
      if (!MONGODB_URI) {
        console.log('⚠️  MONGODB_URI not set - running without database');
        return;
      }

      console.log('🔗 Connecting to MongoDB Atlas...');

      // REMOVED DNS CHECK - let mongoose handle connection directly
      
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 25000, // Increased timeout
        socketTimeoutMS: 30000,
        maxPoolSize: 5,
        retryWrites: true,
        w: 'majority'
      });

      this.isConnected = true;
      this.connectionAttempts = 0;
      
      console.log(`✅ MongoDB Atlas connected to: ${mongoose.connection.db.databaseName}`);

      mongoose.connection.on('error', (error) => {
        console.error('❌ MongoDB connection error:', error.message);
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        console.log('🔌 MongoDB disconnected');
        this.isConnected = false;
      });

    } catch (error) {
      this.connectionAttempts++;
      
      console.error(`❌ MongoDB connection failed (attempt ${this.connectionAttempts}):`, error.message);
      
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        console.log(`🔄 Retrying in 5 seconds...`);
        setTimeout(() => this.connect(), 5000);
      } else {
        console.log('⚠️  MongoDB not connected - running in offline mode');
        console.log('💡 Some features will not work until database is connected');
      }
    }
  }

  async disconnect() {
    if (this.isConnected) {
      await mongoose.disconnect();
      console.log('✅ MongoDB disconnected');
      this.isConnected = false;
    }
  }

  async healthCheck() {
    if (!this.isConnected) {
      return { 
        status: 'disconnected', 
        connected: false,
        message: 'MongoDB not connected'
      };
    }
    
    try {
      await mongoose.connection.db.admin().ping();
      return { 
        status: 'healthy', 
        connected: true,
        database: mongoose.connection.db.databaseName
      };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        connected: false, 
        error: error.message 
      };
    }
  }
}

const database = new Database();
module.exports = database;