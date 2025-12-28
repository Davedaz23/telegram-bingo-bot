// services/socketService.js
const socketIO = require('socket.io');
const GameService = require('./gameService');

class SocketService {
  constructor(server) {
    this.io = socketIO(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });
    
    this.connectedUsers = new Map(); // userId -> socketId
    this.gameRooms = new Map(); // gameId -> Set of socketIds
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`🔌 New socket connection: ${socket.id}`);
      
      // User authentication/identification
      socket.on('register', async (data) => {
        const { userId, telegramId } = data;
        
        if (userId || telegramId) {
          const identifier = userId || telegramId;
          this.connectedUsers.set(identifier.toString(), socket.id);
          socket.userId = identifier;
          
          console.log(`👤 User registered: ${identifier} (socket: ${socket.id})`);
          
          // Join user's personal room for direct messages
          socket.join(`user:${identifier}`);
        }
      });
      
      // Join game room
      socket.on('join_game', async (gameId) => {
        socket.gameId = gameId;
        socket.join(`game:${gameId}`);
        
        // Track game room participants
        if (!this.gameRooms.has(gameId)) {
          this.gameRooms.set(gameId, new Set());
        }
        this.gameRooms.get(gameId).add(socket.id);
        
        console.log(`🎮 Socket ${socket.id} joined game: ${gameId}`);
        
        // Send current game state
        const game = await GameService.getGameWithDetails(gameId);
        socket.emit('game_state_update', {
          type: 'INITIAL_STATE',
          game,
          timestamp: new Date().toISOString()
        });
      });
      
      // Leave game room
      socket.on('leave_game', (gameId) => {
        socket.leave(`game:${gameId}`);
        if (this.gameRooms.has(gameId)) {
          this.gameRooms.get(gameId).delete(socket.id);
        }
        console.log(`🚪 Socket ${socket.id} left game: ${gameId}`);
      });
      
      // Heartbeat
      socket.on('heartbeat', () => {
        socket.emit('heartbeat_response', { timestamp: Date.now() });
      });
      
      // Get real-time updates
      socket.on('subscribe_updates', (data) => {
        const { gameId, types = ['all'] } = data;
        
        if (types.includes('numbers') || types.includes('all')) {
          socket.join(`game:${gameId}:numbers`);
        }
        if (types.includes('players') || types.includes('all')) {
          socket.join(`game:${gameId}:players`);
        }
        if (types.includes('cards') || types.includes('all')) {
          socket.join(`game:${gameId}:cards`);
        }
        if (types.includes('status') || types.includes('all')) {
          socket.join(`game:${gameId}:status`);
        }
      });
      
      // Disconnect
      socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
        
        // Clean up user mapping
        if (socket.userId) {
          this.connectedUsers.delete(socket.userId.toString());
        }
        
        // Clean up game rooms
        if (socket.gameId) {
          const room = this.gameRooms.get(socket.gameId);
          if (room) {
            room.delete(socket.id);
            if (room.size === 0) {
              this.gameRooms.delete(socket.gameId);
            }
          }
        }
      });
    });
  }

  // ==================== EMITTER METHODS ====================

  // Emit to specific user
  emitToUser(userId, event, data) {
    const socketId = this.connectedUsers.get(userId.toString());
    if (socketId) {
      this.io.to(socketId).emit(event, data);
    }
  }

  // Emit to all users in a game
  emitToGame(gameId, event, data) {
    this.io.to(`game:${gameId}`).emit(event, {
      ...data,
      gameId,
      timestamp: new Date().toISOString()
    });
  }

  // Emit to specific room within game
  emitToGameRoom(gameId, roomType, event, data) {
    this.io.to(`game:${gameId}:${roomType}`).emit(event, {
      ...data,
      gameId,
      roomType,
      timestamp: new Date().toISOString()
    });
  }

  // Emit to specific channel (numbers, cards, etc)
  emitToChannel(channel, event, data) {
    this.io.to(channel).emit(event, {
      ...data,
      channel,
      timestamp: new Date().toISOString()
    });
  }

  // Broadcast to all connected clients
  broadcast(event, data) {
    this.io.emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // ==================== GAME-SPECIFIC EVENTS ====================

  // New number called
  async emitNumberCalled(gameId, numberData) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.emitToGameRoom(gameId, 'numbers', 'number_called', {
      number: numberData.number,
      letter: numberData.letter,
      calledNumbers: numberData.calledNumbers,
      totalCalled: numberData.totalCalled,
      gameCode: game.code
    });
    
    // Also update full game state
    this.emitToGame(gameId, 'game_state_update', {
      type: 'NUMBER_CALLED',
      game,
      number: numberData.number,
      letter: numberData.letter
    });
  }

  // Card selection/change
  async emitCardSelected(gameId, cardData) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.emitToGameRoom(gameId, 'cards', 'card_selected', {
      cardNumber: cardData.cardNumber,
      userId: cardData.userId,
      takenCards: await GameService.getTakenCards(gameId),
      totalPlayers: game.currentPlayers
    });
    
    this.emitToGame(gameId, 'game_state_update', {
      type: 'CARD_SELECTED',
      game,
      cardNumber: cardData.cardNumber
    });
  }

  // Game status change
  async emitGameStatusChange(gameId, oldStatus, newStatus) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.emitToGameRoom(gameId, 'status', 'status_changed', {
      oldStatus,
      newStatus,
      game,
      message: this.getStatusMessage(newStatus, game)
    });
    
    this.emitToGame(gameId, 'game_state_update', {
      type: 'STATUS_CHANGED',
      game,
      oldStatus,
      newStatus
    });
  }

  // Player joined/left
  async emitPlayerChange(gameId, changeType, playerData) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.emitToGameRoom(gameId, 'players', 'player_changed', {
      changeType, // 'joined', 'left', 'ready'
      player: playerData,
      totalPlayers: game.currentPlayers,
      playersNeeded: Math.max(0, GameService.MIN_PLAYERS_TO_START - game.currentPlayers)
    });
    
    this.emitToGame(gameId, 'game_state_update', {
      type: 'PLAYER_CHANGED',
      game,
      changeType,
      player: playerData
    });
  }

  // Winner declared
  async emitWinnerDeclared(gameId, winnerData) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.broadcast('winner_declared', {
      gameId,
      gameCode: game.code,
      winner: winnerData.winner,
      prizeAmount: winnerData.prizeAmount,
      winningPattern: winnerData.winningPattern,
      cardNumber: winnerData.cardNumber
    });
    
    this.emitToGame(gameId, 'game_state_update', {
      type: 'WINNER_DECLARED',
      game,
      winner: winnerData.winner,
      prizeAmount: winnerData.prizeAmount
    });
  }

  // Game ended (no winner)
  async emitGameEnded(gameId, endData) {
    const game = await GameService.getGameWithDetails(gameId);
    
    this.emitToGame(gameId, 'game_state_update', {
      type: 'GAME_ENDED',
      game,
      reason: endData.reason,
      refundsProcessed: endData.refundsProcessed,
      nextGameCountdown: endData.nextGameCountdown
    });
  }

  // New game created
  async emitNewGameCreated(gameData) {
    this.broadcast('new_game_available', {
      game: gameData,
      message: 'New bingo game is available! Join now!'
    });
  }

  // Countdown updates
  emitCountdownUpdate(gameId, countdownType, timeRemaining) {
    this.emitToGame(gameId, 'countdown_update', {
      countdownType, // 'auto_start', 'card_selection', 'next_game'
      timeRemaining,
      formattedTime: this.formatTime(timeRemaining)
    });
  }

  // ==================== UTILITY METHODS ====================

  getStatusMessage(status, game) {
    const messages = {
      'WAITING_FOR_PLAYERS': `Waiting for players... (${game.currentPlayers}/${GameService.MIN_PLAYERS_TO_START})`,
      'CARD_SELECTION': 'Select your bingo card!',
      'ACTIVE': 'Game in progress!',
      'FINISHED': `Game finished! Winner: ${game.winnerId ? 'Player' : 'None'}`,
      'NO_WINNER': 'Game ended - No winner',
      'COOLDOWN': 'Next game starting soon...'
    };
    
    return messages[status] || status;
  }

  formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }

  // Get connected users count for a game
  getGameConnectionsCount(gameId) {
    const room = this.gameRooms.get(gameId);
    return room ? room.size : 0;
  }

  // Get all connected users
  getConnectedUsers() {
    return Array.from(this.connectedUsers.entries()).map(([userId, socketId]) => ({
      userId,
      socketId
    }));
  }

  // Force disconnect user
  disconnectUser(userId) {
    const socketId = this.connectedUsers.get(userId.toString());
    if (socketId) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
    }
  }
}

module.exports = SocketService;