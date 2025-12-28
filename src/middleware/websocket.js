// middleware/websocket.js
const SocketService = require('../services/SocketService');

let socketService = null;

const initializeWebSocket = (server) => {
  socketService = new SocketService(server);
  
  // Inject socket service into GameService
  const GameService = require('../services/gameService');
  GameService.setSocketService(socketService);
  
  return socketService;
};

const getSocketService = () => socketService;

const socketMiddleware = (req, res, next) => {
  req.socketService = socketService;
  next();
};

module.exports = {
  initializeWebSocket,
  getSocketService,
  socketMiddleware
};