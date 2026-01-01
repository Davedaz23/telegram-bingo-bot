const WebSocket = require('ws');
// OR for Socket.io
// const { Server } = require('socket.io');

class WebSocketService {
  constructor(server) {
    // Using native WebSocket
    this.wss = new WebSocket.Server({ server });
    this.clients = new Map(); // userId -> WebSocket
    this.gameRooms = new Map(); // gameId -> Set of user WebSockets
    
    this.setupWebSocket();
    
    console.log('✅ WebSocket server started');
  }

  // For Socket.io alternative (uncomment if using Socket.io)
  /*
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    this.setupSocketIO();
  }
  */

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      console.log('🔗 New WebSocket connection');
      
      // Extract userId from query params
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = url.searchParams.get('userId');
      const gameId = url.searchParams.get('gameId');
      
      if (userId) {
        this.clients.set(userId, ws);
        console.log(`👤 User ${userId} connected to WebSocket`);
      }
      
      if (gameId) {
        this.joinGameRoom(gameId, ws, userId);
      }
      
      ws.on('message', (message) => {
        this.handleMessage(ws, message);
      });
      
      ws.on('close', () => {
        this.handleDisconnection(ws, userId, gameId);
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }

  // For Socket.io setup (alternative)
  /*
  setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log('🔗 New Socket.io connection:', socket.id);
      
      const { userId, gameId } = socket.handshake.query;
      
      socket.join(`user:${userId}`);
      if (gameId) {
        socket.join(`game:${gameId}`);
        console.log(`🎮 User ${userId} joined game ${gameId}`);
      }
      
      socket.on('join-game', ({ gameId, userId }) => {
        socket.join(`game:${gameId}`);
        console.log(`🎮 User ${userId} joined game ${gameId} via event`);
      });
      
      socket.on('leave-game', ({ gameId, userId }) => {
        socket.leave(`game:${gameId}`);
        console.log(`🎮 User ${userId} left game ${gameId}`);
      });
      
      socket.on('disconnect', () => {
        console.log('🔌 Socket disconnected:', socket.id);
      });
    });
  }
  */

  joinGameRoom(gameId, ws, userId) {
    if (!this.gameRooms.has(gameId)) {
      this.gameRooms.set(gameId, new Set());
    }
    
    const room = this.gameRooms.get(gameId);
    ws.gameId = gameId;
    ws.userId = userId;
    room.add(ws);
    
    console.log(`🎮 User ${userId} joined game room: ${gameId}`);
    
    // Notify others in the room
    this.broadcastToGame(gameId, {
      type: 'USER_JOINED',
      userId,
      timestamp: new Date().toISOString(),
      message: `User ${userId} joined the game`
    }, ws); // Exclude self
  }

  handleMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      console.log('📨 WebSocket message:', data);
      
      switch (data.type) {
        case 'JOIN_GAME':
          this.joinGameRoom(data.gameId, ws, data.userId);
          break;
          
        case 'LEAVE_GAME':
          this.leaveGameRoom(data.gameId, ws);
          break;
          
        case 'CARD_SELECTED':
          this.handleCardSelected(data);
          break;
          
        case 'NUMBER_CALLED':
          this.broadcastToGame(data.gameId, {
            type: 'NUMBER_CALLED',
            number: data.number,
            callerId: data.callerId,
            timestamp: new Date().toISOString()
          });
          break;
          
        case 'MARK_NUMBER':
          this.broadcastToGame(data.gameId, {
            type: 'NUMBER_MARKED',
            userId: data.userId,
            number: data.number,
            timestamp: new Date().toISOString()
          });
          break;
          
        case 'BINGO_CLAIMED':
          this.broadcastToGame(data.gameId, {
            type: 'BINGO_CLAIMED',
            userId: data.userId,
            pattern: data.pattern,
            timestamp: new Date().toISOString()
          });
          break;
          
        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  handleDisconnection(ws, userId, gameId) {
    console.log(`🔌 WebSocket disconnected: ${userId || 'unknown'}`);
    
    if (userId) {
      this.clients.delete(userId);
    }
    
    if (gameId && ws.gameId) {
      this.leaveGameRoom(gameId, ws);
    }
  }

  leaveGameRoom(gameId, ws) {
    const room = this.gameRooms.get(gameId);
    if (room) {
      room.delete(ws);
      
      // Notify others
      this.broadcastToGame(gameId, {
        type: 'USER_LEFT',
        userId: ws.userId,
        timestamp: new Date().toISOString()
      });
      
      // Clean up empty room
      if (room.size === 0) {
        this.gameRooms.delete(gameId);
      }
    }
  }

  // Broadcast to all users in a game room
  broadcastToGame(gameId, message, excludeWs = null) {
    const room = this.gameRooms.get(gameId);
    if (!room) return;
    
    const messageStr = JSON.stringify(message);
    
    room.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }

  // Send to specific user
  sendToUser(userId, message) {
    const ws = this.clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // Broadcast taken cards update
  broadcastTakenCards(gameId, takenCards) {
    this.broadcastToGame(gameId, {
      type: 'TAKEN_CARDS_UPDATE',
      takenCards,
      count: takenCards.length,
      timestamp: new Date().toISOString()
    });
  }

  // Broadcast game status update
  broadcastGameStatus(gameId, gameStatus) {
    this.broadcastToGame(gameId, {
      type: 'GAME_STATUS_UPDATE',
      gameId,
      status: gameStatus.status,
      currentNumber: gameStatus.currentNumber,
      calledNumbers: gameStatus.calledNumbers,
      timestamp: new Date().toISOString()
    });
  }

  // Broadcast to all connected users
  broadcastToAll(message) {
    const messageStr = JSON.stringify(message);
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }
}

module.exports = WebSocketService;