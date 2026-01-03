const WebSocket = require('ws');
const GameService = require('./gameService');

class WebSocketService {
  constructor(server) {
    if (WebSocketService.instance) {
      return WebSocketService.instance;
    }
    
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws',
      verifyClient: (info, cb) => {
        console.log('🔗 WebSocket connection attempt:', info.req.url);
        cb(true);
      }
    });
    
    this.clients = new Map();
    this.gameRooms = new Map();
    this.clientStates = new Map();
    
    this.setupWebSocket();
    console.log('✅ WebSocket server started on /ws path');
    
    WebSocketService.instance = this;
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      console.log('🔗 New WebSocket connection:', req.url);
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      const userId = url.searchParams.get('userId');
      const gameId = url.searchParams.get('gameId');
      
      if (userId) {
        this.clients.set(userId, ws);
        console.log(`👤 User ${userId} connected to WebSocket`);
      }
      
      if (gameId) {
        this.joinGameRoom(gameId, ws, userId);
        
        // Send initial game state and taken cards
        this.sendInitialGameState(gameId, userId, ws);
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

  // NEW: Send initial game state
  async sendInitialGameState(gameId, userId, ws) {
    try {
      // Get game data from GameService
      const game = await GameService.getGameWithDetails(gameId);
      
      if (game) {
        // Send game status
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'GAME_STATUS_UPDATE',
            gameId: game._id,
            status: game.status,
            currentNumber: game.currentNumber || null,
            calledNumbers: game.numbersCalled || [],
            totalCalled: (game.numbersCalled || []).length,
            currentPlayers: game.currentPlayers || 0,
            timestamp: new Date().toISOString()
          }));
        }
      }
      
      // Send initial taken cards
      await this.sendInitialTakenCards(gameId, userId, ws);
      
    } catch (error) {
      console.error('Error sending initial game state:', error);
    }
  }

  async sendInitialTakenCards(gameId, userId, ws) {
    try {
      const databaseTakenCards = await GameService.getTakenCards(gameId);
      const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
      const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
      const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
        index === self.findIndex(c => c.cardNumber === card.cardNumber)
      );
      
      const availableCards = await GameService.getAvailableCards(gameId, userId, 400);
      
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
    }, ws);
  }

  handleMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      console.log('📨 WebSocket message:', data.type);
      
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
          
        case 'GET_GAME_STATUS':
          this.handleGetGameStatus(data, ws);
          break;
          
        case 'NUMBER_CALLED':
          this.broadcastToGame(data.gameId, {
            type: 'NUMBER_CALLED',
            number: data.number,
            sequence: data.sequence,
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
          ws.send(JSON.stringify({ 
            type: 'PONG', 
            timestamp: new Date().toISOString(),
            serverTime: Date.now()
          }));
          break;
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  // NEW: Handle game status requests
  async handleGetGameStatus(data, ws) {
    try {
      const { gameId } = data;
      
      if (!gameId) return;
      
      const game = await GameService.getGameWithDetails(gameId);
      
      if (game && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'GAME_STATUS_UPDATE',
          gameId: game._id,
          status: game.status,
          currentNumber: game.currentNumber || null,
          calledNumbers: game.numbersCalled || [],
          totalCalled: (game.numbersCalled || []).length,
          currentPlayers: game.currentPlayers || 0,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.error('Error getting game status:', error);
    }
  }

  async handleCardSelected(data) {
    try {
      const { gameId, userId, cardNumber } = data;
      console.log(`🎯 Card selected: User ${userId} selected card ${cardNumber} in game ${gameId}`);
      
      const databaseTakenCards = await GameService.getTakenCards(gameId);
      const realTimeTakenCards = GameService.getRealTimeTakenCards(gameId);
      const allTakenCards = [...databaseTakenCards, ...realTimeTakenCards];
      const uniqueTakenCards = allTakenCards.filter((card, index, self) => 
        index === self.findIndex(c => c.cardNumber === card.cardNumber)
      );
      
      // Broadcast card selection
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
      
      // Check if game should start after card selection
      const game = await GameService.getGameWithDetails(gameId);
      if (game && game.status === 'CARD_SELECTION') {
        await GameService.checkCardSelectionEnd(gameId);
      }
      
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

  // NEW: External method to broadcast game status (called by GameService)
  broadcastGameStatusUpdate(gameId, gameData) {
    console.log(`📤 WebSocket: Broadcasting game status for ${gameId}: ${gameData.status}`);
    
    this.broadcastToGame(gameId, {
      type: 'GAME_STATUS_UPDATE',
      gameId: gameData._id,
      status: gameData.status,
      currentNumber: gameData.currentNumber || null,
      calledNumbers: gameData.numbersCalled || [],
      totalCalled: (gameData.numbersCalled || []).length,
      currentPlayers: gameData.currentPlayers || 0,
      timestamp: new Date().toISOString()
    });
    
    // Special broadcasts for important status changes
    if (gameData.status === 'ACTIVE') {
      console.log(`🚀 WebSocket: Game ${gameData.code} is now ACTIVE - broadcasting to all users`);
      
      this.broadcastToGame(gameId, {
        type: 'GAME_STARTED',
        gameId: gameData._id,
        gameCode: gameData.code,
        startedAt: gameData.startedAt || new Date().toISOString(),
        playerCount: gameData.currentPlayers || 0,
        timestamp: new Date().toISOString()
      });
    } else if (gameData.status === 'CARD_SELECTION') {
      this.broadcastToGame(gameId, {
        type: 'CARD_SELECTION_STARTED',
        gameId: gameData._id,
        endTime: gameData.cardSelectionEndTime?.toISOString() || new Date(Date.now() + 30000).toISOString(),
        duration: 30000,
        timestamp: new Date().toISOString()
      });
    }
  }

  // NEW: Broadcast to all users in a game
  broadcastToGame(gameId, message, excludeWs = null) {
    const room = this.gameRooms.get(gameId);
    if (!room) {
      console.log(`⚠️ No room found for game ${gameId}`);
      return;
    }
    
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    
    room.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
        sentCount++;
        
        // Update client state
        if (message.sequence) {
          const clientKey = `${gameId}_${client.userId || 'anonymous'}`;
          this.clientStates.set(clientKey, {
            lastSequence: message.sequence,
            lastSync: Date.now()
          });
        }
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