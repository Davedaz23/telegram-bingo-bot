const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws' 
});

wss.on('connection', (ws, req) => {
  console.log('✅ WebSocket connected!', req.url);
  
  ws.send(JSON.stringify({ 
    type: 'CONNECTED', 
    message: 'Connected to test WebSocket server' 
  }));
  
  ws.on('message', (message) => {
    console.log('📨 Received:', message.toString());
    ws.send(JSON.stringify({ type: 'ECHO', data: message.toString() }));
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Test server running', websocket: 'ws://localhost:5001/ws' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = 5001;
server.listen(PORT, () => {
  console.log(`🚀 Test server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
});