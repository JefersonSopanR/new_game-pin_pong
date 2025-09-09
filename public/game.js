// Get canvas and context
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Connect to server
console.log('🌐 Connecting to game server...');
const socket = io();

let isPlayer1 = false;
let gameState = null;

socket.on("connect", () => {
    const modal = document.getElementById("continueModal");
    const message = document.getElementById("continueMessage");
    const yesBtn = document.getElementById("continueYes");
    const noBtn = document.getElementById("continueNo");

    if (!modal || !message || !yesBtn || !noBtn) return;

    message.textContent = "Who do you want to play against?";
    modal.style.display = "flex";

    yesBtn.onclick = () => {
        socket.emit("joinGame", { mode: "AI" });
        modal.style.display = "none";
    };

    noBtn.onclick = () => {
        socket.emit("joinGame", { mode: "PVP" });
        modal.style.display = "none";
    };
});

socket.on("waitingForPlayer", (data) => {
    document.getElementById("playerInfo").textContent = data.message;
    console.log("⏳", data.message);
});

// When server assigns us a player
socket.on('playerAssignment', function(data) {
    console.log('🎮 Player assignment:', data.message);
    isPlayer1 = data.isPlayer1;
    document.getElementById('playerInfo').textContent = data.message;
});

// When game is ready (both players connected)
socket.on('gameReady', function(data) {
    console.log('✅ Game ready:', data.message);
    document.getElementById('playerInfo').textContent = document.getElementById('playerInfo').textContent + ' - Game Ready!';
});

// When a player disconnects
socket.on('playerDisconnected', function(data) {
    console.log('⚠️ Player disconnected:', data.message);
    document.getElementById('playerInfo').textContent = data.message;
});

// When server sends game updates
socket.on('gameUpdate', function(data) {
    gameState = data;
    draw();
});

// Mouse movement to control paddle
canvas.addEventListener('mousemove', function(e) {
    const rect = canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    
    // Send paddle position to server
    socket.emit('paddleMove', { y: mouseY - 50 }); // -50 to center paddle on mouse
});

// Draw game
function draw() {
    if (!gameState) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw center line
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw paddles
    ctx.fillStyle = 'white';
    
    // Player 1 paddle (left)
    ctx.fillRect(
        gameState.player1.x, 
        gameState.player1.y, 
        gameState.player1.width, 
        gameState.player1.height
    );
    
    // Player 2 paddle (right)
    ctx.fillRect(
        gameState.player2.x, 
        gameState.player2.y, 
        gameState.player2.width, 
        gameState.player2.height
    );
    
    // Draw ball
    ctx.beginPath();
    ctx.arc(gameState.ball.x, gameState.ball.y, gameState.ball.radius, 0, 2 * Math.PI);
    ctx.fillStyle = 'white';
    ctx.fill();
    
    // Update scores
    document.getElementById('score1').textContent = gameState.player1.score;
    document.getElementById('score2').textContent = gameState.player2.score;
}

// When disconnected
socket.on('disconnect', function() {
    console.log('❌ Disconnected from game server');
    document.getElementById('playerInfo').textContent = 'Disconnected';
});