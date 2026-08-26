// =====================================================
// Snake Game — snake.js
// =====================================================

const canvas   = document.getElementById('snake-canvas');
const ctx      = canvas.getContext('2d');
const scoreEl  = document.getElementById('score');
const hsEl     = document.getElementById('highscore');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const modal    = document.getElementById('gameover-modal');
const btnRetry = document.getElementById('btn-retry');
const goMsg    = document.getElementById('go-message');

// Responsive canvas size
function getCanvasSize() {
  const s = Math.min(window.innerWidth * 0.9, 420);
  return Math.floor(s / CELL) * CELL;
}

const CELL   = 21;
let SIZE     = 420;
let COLS, ROWS;

let snake, dir, nextDir, food, score, highscore, gameLoop, running, paused;

function init() {
  SIZE = getCanvasSize();
  canvas.width  = SIZE;
  canvas.height = SIZE;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  COLS = Math.floor(SIZE / CELL);
  ROWS = Math.floor(SIZE / CELL);
  highscore = parseInt(localStorage.getItem('snake_hs') || '0');
  hsEl.textContent = highscore;
  drawIdle();
}

function startGame() {
  snake   = [{ x: Math.floor(COLS/2), y: Math.floor(ROWS/2) }];
  dir     = { x: 1, y: 0 };
  nextDir = { x: 1, y: 0 };
  score   = 0;
  paused  = false;
  scoreEl.textContent = 0;
  modal.classList.remove('active');
  spawnFood();
  running = true;
  btnStart.disabled = true;
  btnPause.disabled = false;
  clearInterval(gameLoop);
  gameLoop = setInterval(tick, 130);
}

function tick() {
  if (paused) return;
  dir = { ...nextDir };
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  // Wall collision
  if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return endGame();
  // Self collision
  if (snake.some(s => s.x === head.x && s.y === head.y)) return endGame();

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score += 10;
    scoreEl.textContent = score;
    if (score > highscore) {
      highscore = score;
      localStorage.setItem('snake_hs', highscore);
      hsEl.textContent = highscore;
    }
    spawnFood();
  } else {
    snake.pop();
  }
  draw();
}

function spawnFood() {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (snake.some(s => s.x === pos.x && s.y === pos.y));
  food = pos;
}

function draw() {
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Grid
  ctx.strokeStyle = 'hsl(220 20% 13%)';
  ctx.lineWidth = 0.5;
  for (let c = 0; c < COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, SIZE); ctx.stroke();
  }
  for (let r = 0; r < ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(SIZE, r * CELL); ctx.stroke();
  }

  // Food
  ctx.fillStyle = 'hsl(40 95% 55%)';
  ctx.shadowColor = 'hsl(40 95% 55%)';
  ctx.shadowBlur  = 10;
  roundRect(ctx, food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4, 5);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Snake body
  snake.forEach((seg, i) => {
    const alpha = 1 - (i / snake.length) * 0.5;
    ctx.fillStyle = i === 0
      ? 'hsl(174 90% 50%)'
      : `hsl(174 80% 40% / ${alpha})`;
    ctx.shadowColor = i === 0 ? 'hsl(174 90% 50%)' : 'transparent';
    ctx.shadowBlur  = i === 0 ? 8 : 0;
    roundRect(ctx, seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2, i === 0 ? 6 : 4);
    ctx.fill();
  });
  ctx.shadowBlur = 0;
}

function drawIdle() {
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = 'hsl(174 90% 50% / 0.5)';
  ctx.font = `bold ${Math.floor(SIZE * 0.06)}px 'Orbitron', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Pressione Iniciar', SIZE / 2, SIZE / 2);
}

function endGame() {
  clearInterval(gameLoop);
  running = false;
  btnStart.disabled = false;
  btnPause.disabled = true;
  goMsg.textContent = `Sua pontuacao: ${score} pontos. Recorde: ${highscore}`;
  modal.classList.add('active');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Keyboard
document.addEventListener('keydown', e => {
  const map = {
    ArrowUp:    { x:  0, y: -1 }, w: { x:  0, y: -1 },
    ArrowDown:  { x:  0, y:  1 }, s: { x:  0, y:  1 },
    ArrowLeft:  { x: -1, y:  0 }, a: { x: -1, y:  0 },
    ArrowRight: { x:  1, y:  0 }, d: { x:  1, y:  0 },
  };
  const d = map[e.key];
  if (d && !(d.x === -dir.x && d.y === -dir.y)) {
    nextDir = d;
    e.preventDefault();
  }
  if (e.key === ' ') togglePause();
});

// D-Pad
document.getElementById('dpad-up').addEventListener('click', () => { if (dir.y !== 1)  nextDir = { x:  0, y: -1 }; });
document.getElementById('dpad-down').addEventListener('click', () => { if (dir.y !== -1) nextDir = { x:  0, y:  1 }; });
document.getElementById('dpad-left').addEventListener('click', () => { if (dir.x !== 1)  nextDir = { x: -1, y:  0 }; });
document.getElementById('dpad-right').addEventListener('click', () => { if (dir.x !== -1) nextDir = { x:  1, y:  0 }; });

// Swipe support
let touchStart = null;
canvas.addEventListener('touchstart', e => { touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > 20 && dir.x !== -1) nextDir = { x: 1, y: 0 };
    if (dx < -20 && dir.x !== 1) nextDir = { x: -1, y: 0 };
  } else {
    if (dy > 20 && dir.y !== -1) nextDir = { x: 0, y: 1 };
    if (dy < -20 && dir.y !== 1) nextDir = { x: 0, y: -1 };
  }
  touchStart = null;
}, { passive: true });

function togglePause() {
  if (!running) return;
  paused = !paused;
  btnPause.textContent = paused ? '▶ Continuar' : '⏸ Pausar';
}

btnStart.addEventListener('click', startGame);
btnPause.addEventListener('click', togglePause);
btnRetry.addEventListener('click', startGame);

window.addEventListener('resize', () => { init(); if (running) draw(); });

init();
