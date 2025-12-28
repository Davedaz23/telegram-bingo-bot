const mongoose = require('mongoose');

class Database {
  constructor() {
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.reconnectInterval = null;
  }

  async connect() {
    try {
      const MONGODB_URI = process.env.MONGODB_URI;
      
      if (!MONGODB_URI) {
        console.log('⚠️  MONGODB_URI not set - running without database');
        return;
      }

      console.log('🔗 Connecting to MongoDB Atlas...');

      // Optimized connection settings for timeout prevention
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 15000, // Reduced from 25000
        socketTimeoutMS: 20000,          // Reduced from 30000
        connectTimeoutMS: 10000,         // Added connect timeout
        maxPoolSize: 10,                 // Increased from 5 for better concurrency
        minPoolSize: 2,
        maxIdleTimeMS: 10000,
        waitQueueTimeoutMS: 5000,
        retryWrites: true,
        retryReads: true,
        w: 'majority'
      });

      this.isConnected = true;
      this.connectionAttempts = 0;
      
      console.log(`✅ MongoDB Atlas connected to: ${mongoose.connection.db.databaseName}`);

      // Event handlers
      mongoose.connection.on('error', (error) => {
        console.error('❌ MongoDB connection error:', error.message);
        this.isConnected = false;
        this.attemptReconnect();
      });

      mongoose.connection.on('disconnected', () => {
        console.log('🔌 MongoDB disconnected');
        this.isConnected = false;
        this.attemptReconnect();
      });

      mongoose.connection.on('connected', () => {
        console.log('✅ MongoDB reconnected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

    } catch (error) {
      this.connectionAttempts++;
      
      console.error(`❌ MongoDB connection failed (attempt ${this.connectionAttempts}):`, error.message);
      
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        const delay = Math.min(5000 * this.connectionAttempts, 15000);
        console.log(`🔄 Retrying in ${delay/1000} seconds...`);
        setTimeout(() => this.connect(), delay);
      } else {
        console.log('⚠️  MongoDB not connected - running in degraded mode');
        console.log('💡 Some features will not work until database is connected');
        this.attemptReconnect();
      }
    }
  }

  attemptReconnect() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
    }
    
    this.reconnectInterval = setInterval(() => {
      if (!this.isConnected && this.connectionAttempts < 10) {
        console.log('🔄 Attempting to reconnect to MongoDB...');
        this.connect();
      }
    }, 30000); // Try every 30 seconds
  }

  async disconnect() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
    }
    
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
      // Fast ping with timeout
      const pingPromise = mongoose.connection.db.admin().ping();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), 3000)
      );
      
      await Promise.race([pingPromise, timeoutPromise]);
      
      return { 
        status: 'healthy', 
        connected: true,
        database: mongoose.connection.db.databaseName,
        poolSize: mongoose.connection.poolSize,
        readyState: mongoose.connection.readyState
      };
    } catch (error) {
      this.isConnected = false;
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