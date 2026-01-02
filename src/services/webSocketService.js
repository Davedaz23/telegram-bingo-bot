const WebSocket = require('ws');
const GameService = require('./gameService'); // Make sure to import GameService

class WebSocketService {
  constructor(server) {
    if (WebSocketService.instance) {
      return WebSocketService.instance;
    }
    
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws', // Add path to avoid conflicts
      verifyClient: (info, cb) => {
        console.log('🔗 WebSocket connection attempt:', info.req.url);
        cb(true);
      }
    });
    
    this.clients = new Map();
    this.gameRooms = new Map();
    
    this.setupWebSocket();
    console.log('✅ WebSocket server started on /ws path');
    
    WebSocketService.instance = this;
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      console.log('🔗 New WebSocket connection:', req.url);
      
      // Extract userId and gameId from query params
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = url.searchParams.get('userId');
      const gameId = url.searchParams.get('gameId');
      
      if (userId) {
        this.clients.set(userId, ws);
        console.log(`👤 User ${userId} connected to WebSocket`);
      }
      
      if (gameId) {
        this.joinGameRoom(gameId, ws, userId);
        
        // Send initial taken cards when user joins
        this.sendInitialTakenCards(gameId, userId, ws);
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
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'CONNECTED',
        userId,
        gameId,
        timestamp: new Date().toISOString(),
        message: 'Connected to Bingo WebSocket server'
      }));
    });
  }

  async sendInitialTakenCards(gameId, userId, ws) {
    try {
      // Get taken cards from GameService
      const databaseTakenCards = await GameService.getTakenCards(gameId);
      const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
      const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
      const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
        index === self.findIndex(c => c.cardNumber === card.cardNumber)
      );
      
      // Get available cards
      const availableCards = await GameService.getAvailableCards(gameId, userId, 400);
      
      // Send to the connecting user
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CARD_AVAILABILITY_UPDATE',
          takenCards: uniqueTakenCards,
          availableCards: availableCards.map(card => card.cardIndex || card.cardNumber),
          totalTakenCards: uniqueTakenCards.length,
          totalAvailableCards: availableCards.length,
          timestamp: new Date().toISOString()
        }));
      }
      
      // Broadcast to all users in the room
      this.broadcastToGame(gameId, {
        type: 'TAKEN_CARDS_UPDATE',
        takenCards: uniqueTakenCards,
        totalTakenCards: uniqueTakenCards.length,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error sending initial taken cards:', error);
    }
  }

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
          
        case 'GET_CARD_AVAILABILITY':
          this.handleGetCardAvailability(data, ws);
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
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  async handleCardSelected(data) {
    try {
      const { gameId, userId, cardNumber } = data;
      console.log(`🎯 Card selected: User ${userId} selected card ${cardNumber} in game ${gameId}`);
      
      // Get updated taken cards from GameService
      const databaseTakenCards = await GameService.getTakenCards(gameId);
      const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
      const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
      const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
        index === self.findIndex(c => c.cardNumber === card.cardNumber)
      );
      
      // Broadcast to ALL users in the game room
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTED',
        userId,
        cardNumber,
        takenCards: uniqueTakenCards,
        totalTakenCards: uniqueTakenCards.length,
        timestamp: new Date().toISOString(),
        message: `Card ${cardNumber} has been selected by user ${userId}`
      });
      
      // Also send individual card selection event
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTED_WITH_NUMBER',
        userId,
        cardNumber,
        timestamp: new Date().toISOString()
      });
      
      // Update taken cards for all users
      this.broadcastToGame(gameId, {
        type: 'TAKEN_CARDS_UPDATE',
        takenCards: uniqueTakenCards,
        totalTakenCards: uniqueTakenCards.length,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error handling card selected:', error);
    }
  }

  async handleGetCardAvailability(data, ws) {
    try {
      const { gameId, userId } = data;
      
      if (!gameId) return;
      
      const databaseTakenCards = await GameService.getTakenCards(gameId);
      const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
      const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
      const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
        index === self.findIndex(c => c.cardNumber === card.cardNumber)
      );
      
      // Get available cards
      const availableCards = await GameService.getAvailableCards(gameId, userId || 'unknown', 400);
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CARD_AVAILABILITY_UPDATE',
          takenCards: uniqueTakenCards,
          availableCards: availableCards.map(card => card.cardIndex || card.cardNumber),
          totalTakenCards: uniqueTakenCards.length,
          totalAvailableCards: availableCards.length,
          timestamp: new Date().toISOString()
        }));
      }
      
    } catch (error) {
      console.error('Error getting card availability:', error);
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
    let sentCount = 0;
    
    room.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
        sentCount++;
      }
    });
    
    console.log(`📤 Broadcast to game ${gameId}: ${message.type} sent to ${sentCount} clients`);
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

  // Helper methods for debugging
  getConnectionCount() {
    return this.clients.size;
  }

  getGameRoomCount() {
    return this.gameRooms.size;
  }

  getTotalConnections() {
    let count = 0;
    this.wss.clients.forEach(() => count++);
    return count;
  }

  cleanupStaleConnections() {
    let cleaned = 0;
    this.clients.forEach((ws, userId) => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.clients.delete(userId);
        cleaned++;
      }
    });
    return cleaned;
  }
}

module.exports = WebSocketService;