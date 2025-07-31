import fastify from 'fastify';
import { Server } from 'socket.io';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Fastify server
const app = fastify({ logger: true });

// Create Socket.IO server
const io = new Server(app.server);

// Serve static files
app.register(fastifyStatic, {
    root: path.join(__dirname, 'public')
});

// Main route
app.get('/', async (request, reply) => {
    return reply.sendFile('index.html');
});

// Game rooms - each room has its own game state and players
var gameRooms = {};
var nextRoomId = 1;

// Create initial game state for a room
function createGameState() {
    return {
        ball: { x: 400, y: 200, vx: 2, vy: 2, radius: 10 },
        player1: { x: 10, y: 150, width: 10, height: 100, score: 0 },
        player2: { x: 780, y: 150, width: 10, height: 100, score: 0 }
    };
}

// Find available room or create new one
function findAvailableRoom() {
    // Look for existing room with space
    for (let roomId in gameRooms) {
        if (gameRooms[roomId].players.length < 2) {
            return roomId;
        }
    }
    
    // Create new room if none available
    const newRoomId = `room${nextRoomId++}`;
    gameRooms[newRoomId] = {
        players: [],
        gameState: createGameState()
    };
    return newRoomId;
}

// Game loop - runs 60 times per second for all rooms
setInterval(() => {
    // Update each room's game
    for (let roomId in gameRooms) {
        const room = gameRooms[roomId];
        
        // Only update games with players
        if (room.players.length > 0) {
            updateGame(room.gameState);
            // Send game state to players in this room
            io.to(roomId).emit('gameUpdate', room.gameState);
        }
        
        // Clean up empty rooms
        if (room.players.length === 0) {
            delete gameRooms[roomId];
            console.log(`🗑️ Cleaned up empty room: ${roomId}`);
        }
    }
}, 1000/60); // 60 FPS

// Socket.IO connection handling
io.on('connection', function (socket) {
    console.log('🎮 Player connected:', socket.id);
    
    // Find available room and join it
    const roomId = findAvailableRoom();
    const room = gameRooms[roomId];
    
    // Join the Socket.IO room
    socket.join(roomId);
    
    // Add player to room
    const isPlayer1 = room.players.length === 0;
    room.players.push({
        id: socket.id,
        isPlayer1: isPlayer1
    });
    
    // Store room info on socket for easy access
    socket.roomId = roomId;
    socket.isPlayer1 = isPlayer1;
    
    // Send initial game state
    socket.emit('gameUpdate', room.gameState);
    
    // Tell player which paddle they control and room info
    socket.emit('playerAssignment', { 
        isPlayer1: isPlayer1,
        roomId: roomId,
        playersInRoom: room.players.length,
        message: `Room ${roomId} - You are Player ${isPlayer1 ? '1 (left paddle)' : '2 (right paddle)'}`
    });
    
    // Notify room when game can start
    if (room.players.length === 2) {
        io.to(roomId).emit('gameReady', {
            message: `Game ready in ${roomId}! Both players connected.`
        });
    }
    
    // Listen for paddle movement
    socket.on('paddleMove', function (data) {
        const room = gameRooms[socket.roomId];
        if (!room) return;
                
        if (socket.isPlayer1) {
            room.gameState.player1.y = Math.max(0, Math.min(300, data.y)); // Keep paddle in bounds
        } else {
            room.gameState.player2.y = Math.max(0, Math.min(300, data.y)); // Keep paddle in bounds
        }
    });
    
    // Handle disconnect
    socket.on('disconnect', function () {
        console.log('👋 Player disconnected:', socket.id);
        
        const room = gameRooms[socket.roomId];
        if (room) {
            // Remove player from room
            room.players = room.players.filter(p => p.id !== socket.id);
            console.log(`📊 Room ${socket.roomId} now has ${room.players.length}/2 players`);
            
            // Notify remaining players
            if (room.players.length > 0) {
                io.to(socket.roomId).emit('playerDisconnected', {
                    message: `Player ${socket.isPlayer1 ? '1' : '2'} disconnected. Waiting for new player...`
                });
            }
        }
    });
});

// Simple game physics
function updateGame(gameState) {
    // Move ball
    gameState.ball.x += gameState.ball.vx;
    gameState.ball.y += gameState.ball.vy;
    
    // Ball collision with top/bottom walls
    if (gameState.ball.y <= 0 || gameState.ball.y >= 400) {
        gameState.ball.vy = -gameState.ball.vy;
    }
    
    // Ball collision with paddles
    // Player 1 paddle
    if (gameState.ball.x === 20 && 
        gameState.ball.y >= gameState.player1.y && 
        gameState.ball.y <= gameState.player1.y + 100) {
        gameState.ball.vx = -gameState.ball.vx;
    }
    
    // Player 2 paddle
    if (gameState.ball.x === 780 && 
        gameState.ball.y >= gameState.player2.y && 
        gameState.ball.y <= gameState.player2.y + 100) {
        gameState.ball.vx = -gameState.ball.vx;
    }
    
    // Scoring - ball goes off screen
    if (gameState.ball.x < 0) {
        gameState.player2.score++;
        resetBall(gameState);
    } else if (gameState.ball.x > 800) {
        gameState.player1.score++;
        resetBall(gameState);
    }
}

function resetBall(gameState) {
    gameState.ball.x = 400;
    gameState.ball.y = 200;
    gameState.ball.vx = gameState.ball.vx > 0 ? -2 : 2; // Reverse direction
    gameState.ball.vy = Math.random() > 0.5 ? 2 : -2;
}

// Start server
const start = async () => {
    try {
        await app.listen({ port: 3000, host: '0.0.0.0' });
        console.log('🚀 Pong server running on http://localhost:3000');
        console.log('🎮 Open 2 browser tabs to play against each other!');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();