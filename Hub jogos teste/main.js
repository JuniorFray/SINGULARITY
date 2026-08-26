const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const ui = document.getElementById('ui');

canvas.width = 800;
canvas.height = 450;

const logicWorker = new Worker('logicWorker.js');
const physicsWorker = new Worker('physicsWorker.js');

let gameState = {};

// Teclado
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.key] = true;
    logicWorker.postMessage({ type: 'INPUT', keys });
});
window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
    logicWorker.postMessage({ type: 'INPUT', keys });
});

let workersReady = 0;
const checkReady = () => {
    workersReady++;
    if(workersReady === 2) {
        ui.innerText = "Pronto. Use as setas/WASD.";
        requestAnimationFrame(gameLoop);
    }
};

logicWorker.onmessage = (e) => {
    if (e.data.type === 'READY') checkReady();
    if (e.data.type === 'LOGIC_UPDATE') {
        physicsWorker.postMessage({ type: 'PROCESS_PHYSICS', state: e.data.state });
    }
};

physicsWorker.onmessage = (e) => {
    if (e.data.type === 'READY') checkReady();
    if (e.data.type === 'PHYSICS_UPDATE') {
        gameState = e.data.state; // Juntando tudo
    }
};

function gameLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if(gameState.player) {
        ctx.fillStyle = '#007BFF';
        ctx.fillRect(gameState.player.x, gameState.player.y, 30, 30);
    }
    requestAnimationFrame(gameLoop);
}
