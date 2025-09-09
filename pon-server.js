import fastify from 'fastify';
import { Server } from 'socket.io';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = fastify({ logger: true });
const io = new Server(app.server);

app.register(fastifyStatic, {
    root: path.join(__dirname, 'public')
});

app.get('/', async (request, reply) => {
    return reply.sendFile('index.html');
});

// Game rooms
var gameRooms = {};
var nextRoomId = 1;

function createGameState() {
    return {
        ball: { x: 400, y: 200, vx: 2, vy: 2, radius: 10 },
        player1: { x: 10, y: 150, width: 10, height: 100, score: 0 },
        player2: { x: 780, y: 150, width: 10, height: 100, score: 0, targetY: 150 }
    };
}

function findAvailableRoom() {
    for (let roomId in gameRooms) {
        if (gameRooms[roomId].players.length < 2 && !gameRooms[roomId].aiEnabled) {
            return roomId;
        }
    }
    const newRoomId = `room${nextRoomId++}`;
    gameRooms[newRoomId] = {
        players: [],
        gameState: createGameState(),
        aiEnabled: false,
        ready: false,   // new flag
        aiDifficulty: "medium"
    };
    return newRoomId;
}


//AI Logic with Difficulty
const DIFFICULTY_SETTINGS = {
    easy:    { paddleSpeed: 3, errorRange: 40, refreshRate: 1500 }, // slow + big errors
    medium:  { paddleSpeed: 5, errorRange: 20, refreshRate: 1000 }, // balanced
    hard:    { paddleSpeed: 8, errorRange: 5,  refreshRate: 500 }   // fast + precise
};

// ---------------- AI Logic ----------------
function refreshAILogic(room) {
    const { paddleSpeed, errorRange } = DIFFICULTY_SETTINGS[room.aiDifficulty];
    const ball = room.gameState.ball;
    const paddle = room.gameState.player2;

    if (ball.vx > 0) { 
        const timeToReach = (paddle.x - ball.x) / ball.vx;
        let predictedY = ball.y + ball.vy * timeToReach;

        predictedY = Math.max(0, Math.min(400 - paddle.height, predictedY));
        const error = Math.random() * errorRange - errorRange / 2;
        paddle.targetY = predictedY + error;
    } else {
        paddle.targetY = 200 - paddle.height / 2;
    }
}

function updateAIPaddle(paddle, difficulty) {
    const { paddleSpeed } = DIFFICULTY_SETTINGS[difficulty];
    if (paddle.y < paddle.targetY) {
        paddle.y += Math.min(paddleSpeed, paddle.targetY - paddle.y);
    } else if (paddle.y > paddle.targetY) {
        paddle.y -= Math.min(paddleSpeed, paddle.y - paddle.targetY);
    }
}

// Game loop (60 FPS)
setInterval(() => {
    for (let roomId in gameRooms) {
        const room = gameRooms[roomId];

        // skip updating until game is ready
        if (!room.ready) continue;

        if (room.players.length > 0) {
            // Run AI if enabled
            if (room.aiEnabled) {
                updateAIPaddle(room.gameState.player2, room.aiDifficulty);
            }

            updateGame(room.gameState);
            io.to(roomId).emit('gameUpdate', room.gameState);
        }

        if (room.players.length === 0) {
            delete gameRooms[roomId];
            console.log(`🗑️ Cleaned up empty room: ${roomId}`);
        }
    }
}, 1000/60);

function startAIInterval(roomId) {
    const room = gameRooms[roomId];
    if (!room || !room.aiEnabled) return;

    const { refreshRate } = DIFFICULTY_SETTINGS[room.aiDifficulty];

    // Clear old timer if exists
    if (room.aiTimer) clearInterval(room.aiTimer);

    room.aiTimer = setInterval(() => {
        refreshAILogic(room);
    }, refreshRate);
}

// ---------------- Socket.IO ----------------
io.on('connection', function (socket) {
    console.log('🎮 Player connected:', socket.id);

    // Wait for the player to choose
    socket.on("joinGame", ({ mode }) => {
        let roomId;

        if (mode === "AI") {
            // Always create a fresh room for AI games
            roomId = `room${nextRoomId++}`;
            gameRooms[roomId] = {
                players: [],
                gameState: createGameState(),
                aiEnabled: true,
                ready: false,
                aiDifficulty: "medium" // default difficulty
            };
        } else {
            // PvP mode → find or create a room with space
            roomId = findAvailableRoom();
            gameRooms[roomId].aiEnabled = false;
        }

        const room = gameRooms[roomId];
        socket.join(roomId);

        const isPlayer1 = room.players.length === 0;
        room.players.push({ id: socket.id, isPlayer1 });

        socket.roomId = roomId;
        socket.isPlayer1 = isPlayer1;

        // Initial assignment
        socket.emit("gameUpdate", room.gameState);
        socket.emit("playerAssignment", {
            isPlayer1,
            roomId,
            playersInRoom: room.players.length,
            message: `Room ${roomId} - You are Player ${isPlayer1 ? "1 (left paddle)" : "2 (right paddle)"}`
        });

        if (room.aiEnabled) {
            room.ready = true;
            startAIInterval(roomId);
            io.to(roomId).emit("gameReady", {
                message: `Game ready in ${roomId}! You're playing against AI 🤖`
            });
        } else if (room.players.length === 2) {
            room.ready = true; // PvP starts only when 2 players are present
            io.to(roomId).emit("gameReady", {
                message: `Game ready in ${roomId}! Both players connected 👥`
            });
        } else {
            // Only one player in PvP → waiting screen
            room.ready = false;
            socket.emit("waitingForPlayer", {
                message: `Waiting for an opponent to join room ${roomId}...`
            });
        }
    });

    socket.on('setDifficulty', (data) => {
        const room = gameRooms[socket.roomId];
        if (room && ["easy", "medium", "hard"].includes(data.level)) {
            room.aiDifficulty = data.level;
            console.log(`🎚️ Difficulty for ${socket.roomId} set to ${data.level}`);
            startAIInterval(socket.roomId); // restart with new refreshRate
        }
    });

    socket.on('paddleMove', function (data) {
        const room = gameRooms[socket.roomId];
        if (!room) return;

        if (socket.isPlayer1) {
            room.gameState.player1.y = Math.max(0, Math.min(300, data.y));
        } else if (!room.aiEnabled) {
            room.gameState.player2.y = Math.max(0, Math.min(300, data.y));
        }
    });

    socket.on('disconnect', function () {
        console.log('👋 Player disconnected:', socket.id);
        const room = gameRooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            console.log(`📊 Room ${socket.roomId} now has ${room.players.length}/2 players`);

            if (room.players.length === 1) {
                room.aiEnabled = true;
                console.log(`🤖 AI re-enabled in ${socket.roomId}`);
            }

            if (room.players.length > 0) {
                io.to(socket.roomId).emit('playerDisconnected', {
                    message: `Player ${socket.isPlayer1 ? '1' : '2'} disconnected. Waiting for new player...`
                });
            }
        }
    });
});
// -------------------------------------------

function updateGame(gameState) {
    gameState.ball.x += gameState.ball.vx;
    gameState.ball.y += gameState.ball.vy;

    if (gameState.ball.y <= 0 || gameState.ball.y >= 400) {
        gameState.ball.vy = -gameState.ball.vy;
    }

    if (gameState.ball.x === 20 &&
        gameState.ball.y >= gameState.player1.y && 
        gameState.ball.y <= gameState.player1.y + 100) {
        gameState.ball.vx = -gameState.ball.vx;
    }

    if (gameState.ball.x === 780 &&
        gameState.ball.y >= gameState.player2.y && 
        gameState.ball.y <= gameState.player2.y + 100) {
        gameState.ball.vx = -gameState.ball.vx;
    }

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
    gameState.ball.vx = gameState.ball.vx > 0 ? -2 : 2;
    gameState.ball.vy = Math.random() > 0.5 ? 2 : -2;
}

const start = async () => {
    try {
        await app.listen({ port: 3000, host: '0.0.0.0' });
        console.log('🚀 Pong server running on http://localhost:3000');
        console.log('🎮 Open 1 tab to play vs AI, or 2 tabs to play PvP!');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
