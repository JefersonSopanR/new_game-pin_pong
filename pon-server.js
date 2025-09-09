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

// Create initial game state for a room (paddles now have vy & speed)
function createGameState() {
    return {
        ball: { x: 400, y: 200, vx: 2, vy: 2, radius: 10 },
        player1: { x: 10, y: 150, width: 10, height: 100, score: 0, vy: 0, speed: 5 },
        player2: { x: 780, y: 150, width: 10, height: 100, score: 0, vy: 0, speed: 5 }
    };
}

// Find available room or create new one
function findAvailableRoom() {
    // Look for existing room with space for a real player (count only real human players)
    for (let roomId in gameRooms) {
        if (gameRooms[roomId].humanCount < 2) {
            return roomId;
        }
    }
    
    // Create new room if none available
    const newRoomId = `room${nextRoomId++}`;
    gameRooms[newRoomId] = {
        players: [],       // all players (human and possibly AI)
        humanCount: 0,     // number of real human sockets
        gameState: createGameState(),
        ai: null           // will hold AI agent if created
    };
    return newRoomId;
}

// ----------------------
// Keyboard input helpers
// ----------------------
// We will handle both 'keyPress' and 'keyRelease' events to set paddle vy.
// key argument is 'up' or 'down'. playerIndex = 1 or 2.

function handleKeyPress(room, playerIndex, key) {
    const gs = room.gameState;
    const player = (playerIndex === 1) ? gs.player1 : gs.player2;
    if (key === 'up') {
        player.vy = -player.speed;
    } else if (key === 'down') {
        player.vy = player.speed;
    }
}

function handleKeyRelease(room, playerIndex, key) {
    const gs = room.gameState;
    const player = (playerIndex === 1) ? gs.player1 : gs.player2;
    // Only stop movement if the release matches the moving direction (simple logic)
    if (key === 'up' && player.vy < 0) player.vy = 0;
    if (key === 'down' && player.vy > 0) player.vy = 0;
}

// ----------------------
// AI Implementation
// ----------------------

// Create and attach an AI agent to a room (fills second slot)
function attachAIAgentToRoom(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;
    if (room.ai) return; // already has one

    // AI config
    const ai = {
        id: `AI-${roomId}`,
        playerIndex: 2,        // AI will be player 2 (right) by default
        perceptionInterval: 1000, // AI perceives state only once per second
        lastPerception: 0,
        targetY: 200,         // where AI wants its paddle center
        pressing: null,       // currently pressed key: 'up','down', or null
        reactionJitter: 0.12, // randomness to make it imperfect (0..1)
        intervalHandle: null
    };

    // AI action function: called once per second to "refresh view"
    function aiPerceiveAndAct() {
        const now = Date.now();
        ai.lastPerception = now;

        // Copy current game state snapshot for calculation (read-only)
        const s = JSON.parse(JSON.stringify(room.gameState));

        // Predict where the ball will be when it reaches AI paddle X
        const aiPaddleX = s.player2.x; // typically 780
        let ballX = s.ball.x;
        let ballY = s.ball.y;
        let vx = s.ball.vx;
        let vy = s.ball.vy;
        const radius = s.ball.radius;
        const topY = 0;
        const bottomY = 400;

        // If ball is moving away, AI should move toward center (anticipation) —
        // but still simulate a predicted intercept in case of rebound later.
        // We'll simulate forward until ball.x reaches aiPaddleX or until a max steps.
        const maxSteps = 5000; // safety cap
        const dt = 1; // treat each loop as 1 tick with same velocity units we use in updateGame
        let predictedY = ballY;
        let predictedX = ballX;
        let steps = 0;
        // To avoid infinite loop if vx === 0, add fallback
        if (vx === 0) vx = (Math.random() > 0.5 ? 2 : -2);

        while (steps < maxSteps) {
            predictedX += vx * dt;
            predictedY += vy * dt;

            // bounce top/bottom
            if (predictedY - radius <= topY) {
                predictedY = topY + radius;
                vy = -vy;
            } else if (predictedY + radius >= bottomY) {
                predictedY = bottomY - radius;
                vy = -vy;
            }

            // if ball reaches or passes AI paddle X (we consider direction)
            if ((s.ball.vx > 0 && predictedX >= aiPaddleX - s.player2.width) ||
                (s.ball.vx < 0 && predictedX <= aiPaddleX + s.player2.width)) {
                break;
            }
            steps++;
        }

        // predictedY is the intercept Y
        predictedY = Math.max(0, Math.min(400, predictedY));

        // Add some imperfection / prediction error proportional to speed and jitter
        const error = Math.random() * 50 * ai.reactionJitter; // up to ~50px error
        const pickSign = Math.random() > 0.5 ? 1 : -1;
        predictedY += pickSign * error;

        ai.targetY = predictedY;

        // Decide which keys to press: we compare paddle center to target
        const paddleCenterY = room.gameState.player2.y + (room.gameState.player2.height / 2);
        const delta = ai.targetY - paddleCenterY;
        const threshold = 8; // dead zone to avoid jitter

        // Simulate key presses/releases: we call the same handlers the sockets call
        if (delta < -threshold) {
            // need to go up
            if (ai.pressing !== 'up') {
                // release down if any
                if (ai.pressing === 'down') {
                    handleKeyRelease(room, ai.playerIndex, 'down');
                }
                handleKeyPress(room, ai.playerIndex, 'up');
                ai.pressing = 'up';
            }
        } else if (delta > threshold) {
            // need to go down
            if (ai.pressing !== 'down') {
                if (ai.pressing === 'up') {
                    handleKeyRelease(room, ai.playerIndex, 'up');
                }
                handleKeyPress(room, ai.playerIndex, 'down');
                ai.pressing = 'down';
            }
        } else {
            // close enough -> release any key
            if (ai.pressing === 'up' || ai.pressing === 'down') {
                handleKeyRelease(room, ai.playerIndex, ai.pressing);
                ai.pressing = null;
            }
        }

        // Add a chance to "mistime" a movement: release key early randomly
        if (Math.random() < 0.05) {
            if (ai.pressing) {
                handleKeyRelease(room, ai.playerIndex, ai.pressing);
                ai.pressing = null;
            }
        }
    }

    // Start periodic perception/decision timer
    ai.intervalHandle = setInterval(aiPerceiveAndAct, ai.perceptionInterval);

    room.ai = ai;

    console.log(`🤖 Attached AI to ${roomId}`);
}

// Remove AI agent from room (stop its timer)
function detachAIAgentFromRoom(roomId) {
    const room = gameRooms[roomId];
    if (!room || !room.ai) return;
    clearInterval(room.ai.intervalHandle);
    room.ai = null;
    console.log(`❌ Removed AI from ${roomId}`);
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
        
        // Clean up empty rooms (also remove AI timers)
        if (room.players.length === 0) {
            if (room.ai) {
                clearInterval(room.ai.intervalHandle);
                room.ai = null;
            }
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
        isPlayer1: isPlayer1,
        isAI: false
    });
    room.humanCount++;

    // Store room info on socket for easy access
    socket.roomId = roomId;
    socket.isPlayer1 = isPlayer1;
    
    // If there's now exactly 1 human and no other human, attach AI to play against them
    if (room.humanCount === 1 && room.players.length < 2 && !room.ai) {
        // attach AI (fills second slot logically)
        attachAIAgentToRoom(roomId);

        // Register AI as a "player" in players array (so counts remain consistent)
        const aiPlayer = {
            id: room.ai.id,
            isPlayer1: false,
            isAI: true
        };
        room.players.push(aiPlayer);
    }

    // If second human connects and there is an AI, remove AI
    if (room.humanCount === 2 && room.ai) {
        // remove AI from players
        room.players = room.players.filter(p => !p.isAI);
        detachAIAgentFromRoom(roomId);
    }
    
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
    if (room.humanCount + (room.ai ? 1 : 0) === 2) {
        io.to(roomId).emit('gameReady', {
            message: `Game ready in ${roomId}! ${room.ai ? 'AI opponent active.' : 'Both players connected.'}`
        });
    }
    
    // Listen for paddle movement (from mouse)
    socket.on('paddleMove', function (data) {
        const room = gameRooms[socket.roomId];
        if (!room) return;
                
        if (socket.isPlayer1) {
            room.gameState.player1.y = Math.max(0, Math.min(300, data.y));
        } else {
            room.gameState.player2.y = Math.max(0, Math.min(300, data.y));
        }
    });

    // Listen for keyboard-like events simulated by clients or AI
    socket.on('keyPress', function (data) {
        const room = gameRooms[socket.roomId];
        if (!room) return;
        // map socket to player index
        const playerIndex = socket.isPlayer1 ? 1 : 2;
        if (data && data.key) {
            handleKeyPress(room, playerIndex, data.key);
        }
    });

    socket.on('keyRelease', function (data) {
        const room = gameRooms[socket.roomId];
        if (!room) return;
        const playerIndex = socket.isPlayer1 ? 1 : 2;
        if (data && data.key) {
            handleKeyRelease(room, playerIndex, data.key);
        }
    });
    
    // Handle disconnect
    socket.on('disconnect', function () {
        console.log('👋 Player disconnected:', socket.id);
        
        const room = gameRooms[socket.roomId];
        if (room) {
            // Remove player from room
            room.players = room.players.filter(p => p.id !== socket.id);
            room.humanCount = Math.max(0, room.humanCount - 1);
            console.log(`📊 Room ${socket.roomId} now has ${room.humanCount}/2 human players (total players: ${room.players.length})`);
            
            // If there are still humans and AI was removed earlier, maybe attach AI again
            if (room.humanCount === 1 && !room.ai) {
                attachAIAgentToRoom(socket.roomId);
                room.players.push({
                    id: room.ai.id,
                    isPlayer1: false,
                    isAI: true
                });
            }

            // Notify remaining players
            if (room.players.length > 0) {
                io.to(socket.roomId).emit('playerDisconnected', {
                    message: `A player disconnected. Waiting for new player or AI joining...`
                });
            }
        }
    });
});

// Simple game physics + paddle movement per tick
function updateGame(gameState) {
    // Move ball
    gameState.ball.x += gameState.ball.vx;
    gameState.ball.y += gameState.ball.vy;
    
    // Ball collision with top/bottom walls
    if (gameState.ball.y - gameState.ball.radius <= 0 || gameState.ball.y + gameState.ball.radius >= 400) {
        gameState.ball.vy = -gameState.ball.vy;
    }
    
    // Move paddles according to vy (keyboard)
    // Keep paddles within bounds (0..300 for top-left y because paddle height=100)
    gameState.player1.y = Math.max(0, Math.min(300, gameState.player1.y + gameState.player1.vy));
    gameState.player2.y = Math.max(0, Math.min(300, gameState.player2.y + gameState.player2.vy));
    
    // Ball collision with paddles (range check, not exact equality)
    // Player 1 paddle
    if (
        gameState.ball.x - gameState.ball.radius <= gameState.player1.x + gameState.player1.width &&
        gameState.ball.x - gameState.ball.radius >= gameState.player1.x && // approaching zone
        gameState.ball.y >= gameState.player1.y &&
        gameState.ball.y <= gameState.player1.y + gameState.player1.height
    ) {
        gameState.ball.vx = Math.abs(gameState.ball.vx); // ensure it goes right
        // add small random vertical tweak to make gameplay dynamic
        gameState.ball.vy += (Math.random() - 0.5) * 0.5;
    }
    
    // Player 2 paddle
    if (
        gameState.ball.x + gameState.ball.radius >= gameState.player2.x &&
        gameState.ball.x + gameState.ball.radius <= gameState.player2.x + gameState.player2.width &&
        gameState.ball.y >= gameState.player2.y &&
        gameState.ball.y <= gameState.player2.y + gameState.player2.height
    ) {
        gameState.ball.vx = -Math.abs(gameState.ball.vx); // ensure it goes left
        gameState.ball.vy += (Math.random() - 0.5) * 0.5;
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
    // randomize initial direction a bit
    gameState.ball.vx = Math.random() > 0.5 ? 2 : -2;
    gameState.ball.vy = Math.random() > 0.5 ? 2 : -2;
}

// Start server
const start = async () => {
    try {
        await app.listen({ port: 3000, host: '0.0.0.0' });
        console.log('🚀 Pong server running on http://localhost:3000');
        console.log('🎮 Open 2 browser tabs to play against each other, or play alone vs AI!');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
