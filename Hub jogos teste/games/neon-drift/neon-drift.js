// =====================================================
// NEON DRIFT — Pseudo-3D Arcade Racing
// =====================================================

const canvas = document.getElementById('neon-drift-canvas');
const ctx = canvas.getContext('2d');

// ---------- State ----------
let player = { x: 0, speed: 0, score: 0, alive: true };
let roadOffset = 0;
let obstacles = [];
let particles = [];
let highScore = parseInt(localStorage.getItem('neon_drift_hs') || '0', 10);
let animationId = null;
let keys = { left: false, right: false, up: false, down: false };
let driftAngle = 0;
let driftTrail = [];
let driftIntensity = 0;

// ---------- Constants ----------
const ROAD_WIDTH = 0.6; // fraction of canvas width
const CURVE_AMPLITUDE = 0.15; // max road curve offset (fraction of width)
const CURVE_FREQUENCY = 0.002; // curve frequency
let curveOffset = 0; // current curve offset for road rendering
const PLAYER_WIDTH = 0.08;
const PLAYER_HEIGHT = 0.14;
const MAX_SPEED = 300;
const ACCEL = 1.5;
const BRAKE = 2.5;
const FRICTION = 0.98;
const OBSTACLE_SPAWN_INTERVAL = 60; // frames
let frameCount = 0;

// ---------- Resize ----------
function resize() {
  const wrapper = canvas.parentElement;
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
}
window.addEventListener('resize', resize);
resize();

// ---------- Helpers ----------
function resetGame() {
  player = { x: 0, speed: 0, score: 0, alive: true };
  roadOffset = 0;
  obstacles = [];
  particles = [];
  frameCount = 0;
}

function updateHighScore() {
  if (player.score > highScore) {
    highScore = Math.floor(player.score);
    localStorage.setItem('neon_drift_hs', highScore.toString());
  }
}

function spawnObstacle() {
  const side = Math.random() < 0.5 ? -1 : 1;
  const lane = Math.random() * 0.3; // offset within lane
  obstacles.push({
    x: side * (0.2 + lane),
    z: 1, // 1 = far, 0 = near
    width: 0.1,
    height: 0.12,
    color: Math.random() < 0.5 ? '#ff0055' : '#00ffcc'
  });
}

// ---------- Input ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') keys.left = true;
  if (e.key === 'ArrowRight') keys.right = true;
  if (e.key === 'ArrowUp') keys.up = true;
  if (e.key === 'ArrowDown') keys.down = true;
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft') keys.left = false;
  if (e.key === 'ArrowRight') keys.right = false;
  if (e.key === 'ArrowUp') keys.up = false;
  if (e.key === 'ArrowDown') keys.down = false;
});

// ---------- Physics & Update ----------
function update() {
  if (!player.alive) return;

  // Speed control
  if (keys.up) player.speed = Math.min(player.speed + ACCEL, MAX_SPEED);
  if (keys.down) player.speed = Math.max(player.speed - BRAKE, 0);
  player.speed *= FRICTION;

  // Horizontal movement
  const moveSpeed = 0.02;
  if (keys.left) player.x -= moveSpeed;
  if (keys.right) player.x += moveSpeed;
  player.x = Math.max(-0.4, Math.min(0.4, player.x));

  // Drift physics
  const targetDrift = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
  driftAngle += (targetDrift * 0.3 - driftAngle) * 0.1;
  driftIntensity = Math.min(1, Math.abs(player.speed) / MAX_SPEED * 1.5);
  if (Math.abs(driftAngle) > 0.05 && player.speed > 30) {
    driftTrail.push({
      x: player.x - Math.sin(driftAngle) * 0.05,
      y: 0.8 + Math.random() * 0.05,
      life: 1,
      color: '#ff00ff'
    });
  }
  if (driftTrail.length > 50) driftTrail.shift();

  // Road scroll
  roadOffset += player.speed * 0.01;

  // Update curve offset (dynamic curves)
  curveOffset = Math.sin(roadOffset * CURVE_FREQUENCY) * CURVE_AMPLITUDE * canvas.width;

  // Score
  player.score += player.speed * 0.01;

  // Spawn obstacles (time-based, always spawn)
  frameCount++;
  if (frameCount % OBSTACLE_SPAWN_INTERVAL === 0) {
    spawnObstacle();
  }

  // Update obstacles (move toward player)
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const obs = obstacles[i];
    obs.z -= player.speed * 0.0005;
    if (obs.z <= 0) {
      obstacles.splice(i, 1);
      continue;
    }

    // Collision detection (AABB in screen space)
    const screenX = obs.x * canvas.width * 0.5 + canvas.width / 2;
    const screenY = canvas.height * (0.3 + (1 - obs.z) * 0.7);
    const obsW = obs.width * canvas.width * (1 - obs.z + 0.2);
    const obsH = obs.height * canvas.height * (1 - obs.z + 0.2);

    const playerX = player.x * canvas.width * 0.5 + canvas.width / 2;
    const playerY = canvas.height * 0.8;
    const playerW = PLAYER_WIDTH * canvas.width;
    const playerH = PLAYER_HEIGHT * canvas.height;

    if (
      screenX - obsW / 2 < playerX + playerW / 2 &&
      screenX + obsW / 2 > playerX - playerW / 2 &&
      screenY - obsH / 2 < playerY + playerH / 2 &&
      screenY + obsH / 2 > playerY - playerH / 2
    ) {
      player.alive = false;
      updateHighScore();
      showGameOver();
      return;
    }
  }

  // Particles (neon trail)
  if (player.speed > 10 && Math.random() < 0.3) {
    particles.push({
      x: player.x + (Math.random() - 0.5) * 0.1,
      y: 0.8 + Math.random() * 0.1,
      life: 1,
      color: Math.random() < 0.5 ? '#ff0055' : '#00ffcc'
    });
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].life -= 0.02;
    if (particles[i].life <= 0) particles.splice(i, 1);
  }

  // Drift trail particles
  for (let i = driftTrail.length - 1; i >= 0; i--) {
    driftTrail[i].life -= 0.03;
    if (driftTrail[i].life <= 0) driftTrail.splice(i, 1);
  }
}

// ---------- Render ----------
function render() {
  const w = canvas.width;
  const h = canvas.height;

  // Clear
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);

  // Horizon glow
  const grad = ctx.createLinearGradient(0, 0, 0, h * 0.5);
  grad.addColorStop(0, '#1a0033');
  grad.addColorStop(1, '#050505');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h * 0.5);

  // Road (pseudo-3D perspective with curves)
  const horizonY = h * 0.3;
  const bottomY = h;
  const curve = curveOffset;

  // Road surface with curve
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.moveTo(w * (0.5 - ROAD_WIDTH / 2) + curve, bottomY);
  ctx.lineTo(w * 0.5 - 0.02 * w + curve * 0.3, horizonY);
  ctx.lineTo(w * 0.5 + 0.02 * w + curve * 0.3, horizonY);
  ctx.lineTo(w * (0.5 + ROAD_WIDTH / 2) + curve, bottomY);
  ctx.closePath();
  ctx.fill();

  // Road edge lines (curbs)
  ctx.strokeStyle = '#ff0055';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ff0055';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(w * (0.5 - ROAD_WIDTH / 2) + curve, bottomY);
  ctx.lineTo(w * 0.5 - 0.02 * w + curve * 0.3, horizonY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * (0.5 + ROAD_WIDTH / 2) + curve, bottomY);
  ctx.lineTo(w * 0.5 + 0.02 * w + curve * 0.3, horizonY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Road texture (dashes)
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 20; i++) {
    const y = horizonY + (i / 20) * (bottomY - horizonY);
    const t = (y - horizonY) / (bottomY - horizonY);
    const xOffset = curve * (1 - t * 0.7);
    const roadW = ROAD_WIDTH * w * t;
    ctx.fillRect(w * 0.5 - roadW / 2 + xOffset, y, roadW, 2);
  }

  // Lane lines (moving with curve)
  const lineCount = 8;
  const lineSpacing = h * 0.1;
  const offset = (roadOffset * 0.05) % lineSpacing;
  for (let i = 0; i < lineCount; i++) {
    const y = horizonY + i * lineSpacing + offset;
    if (y > bottomY) continue;
    const t = (y - horizonY) / (bottomY - horizonY);
    const lineWidth = 0.02 * w * t;
    const xCenter = w * 0.5 + curve * (1 - t * 0.7);
    ctx.fillStyle = '#00ffcc';
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur = 10;
    ctx.fillRect(xCenter - lineWidth / 2, y, lineWidth, 4);
    ctx.shadowBlur = 0;
  }

  // Obstacles
  for (const obs of obstacles) {
    const t = 1 - obs.z; // 0 far, 1 near
    const screenX = obs.x * w * 0.5 + w / 2 + curve * (1 - t * 0.7);
    const screenY = horizonY + t * (bottomY - horizonY);
    const size = (obs.width * w) * (0.3 + t);
    const height = (obs.height * h) * (0.3 + t);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(screenX - size / 2 + 4, screenY - height / 2 + 4, size, height);

    // Body
    ctx.fillStyle = obs.color;
    ctx.shadowColor = obs.color;
    ctx.shadowBlur = 15;
    ctx.fillRect(screenX - size / 2, screenY - height / 2, size, height);
    ctx.shadowBlur = 0;

    // Windshield
    ctx.fillStyle = '#222';
    ctx.fillRect(screenX - size / 2 + size * 0.2, screenY - height / 2 + height * 0.2, size * 0.6, height * 0.3);

    // Wheels
    ctx.fillStyle = '#111';
    ctx.fillRect(screenX - size / 2 - size * 0.05, screenY - height / 2 + height * 0.1, size * 0.1, height * 0.2);
    ctx.fillRect(screenX + size / 2 - size * 0.05, screenY - height / 2 + height * 0.1, size * 0.1, height * 0.2);
    ctx.fillRect(screenX - size / 2 - size * 0.05, screenY + height / 2 - height * 0.3, size * 0.1, height * 0.2);
    ctx.fillRect(screenX + size / 2 - size * 0.05, screenY + height / 2 - height * 0.3, size * 0.1, height * 0.2);
  }

  // Player car
  const playerX = player.x * w * 0.5 + w / 2 + curve * 0.3;
  const playerY = h * 0.8;
  const pw = PLAYER_WIDTH * w;
  const ph = PLAYER_HEIGHT * h;

  // Trail particles
  for (const p of particles) {
    const px = p.x * w * 0.5 + w / 2;
    const py = p.y * h;
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(px, py, 5 * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // Drift trail
  for (const t of driftTrail) {
    const tx = t.x * w * 0.5 + w / 2;
    const ty = t.y * h;
    ctx.globalAlpha = t.life * 0.5;
    ctx.fillStyle = t.color;
    ctx.shadowColor = t.color;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(tx, ty, 8 * t.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // Car body with realistic shape
  ctx.save();
  ctx.translate(playerX, playerY);
  ctx.rotate(driftAngle * 0.2);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(-pw / 2 + 4, -ph / 2 + 6, pw, ph);

  // Body
  ctx.fillStyle = '#ff0055';
  ctx.shadowColor = '#ff0055';
  ctx.shadowBlur = 25;
  ctx.beginPath();
  ctx.moveTo(-pw / 2, -ph / 2);
  ctx.lineTo(pw / 2, -ph / 2);
  ctx.lineTo(pw / 2 + pw * 0.1, -ph * 0.3);
  ctx.lineTo(pw / 2, ph / 2);
  ctx.lineTo(-pw / 2, ph / 2);
  ctx.lineTo(-pw / 2 - pw * 0.1, -ph * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // Windshield
  ctx.fillStyle = '#00ffcc';
  ctx.shadowColor = '#00ffcc';
  ctx.shadowBlur = 10;
  ctx.fillRect(-pw * 0.3, -ph * 0.35, pw * 0.6, ph * 0.2);
  ctx.shadowBlur = 0;

  // Headlights
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 15;
  ctx.fillRect(-pw * 0.35, -ph * 0.45, pw * 0.15, ph * 0.05);
  ctx.fillRect(pw * 0.2, -ph * 0.45, pw * 0.15, ph * 0.05);
  ctx.shadowBlur = 0;

  // Taillights
  ctx.fillStyle = '#ff0000';
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 15;
  ctx.fillRect(-pw * 0.35, ph * 0.4, pw * 0.15, ph * 0.05);
  ctx.fillRect(pw * 0.2, ph * 0.4, pw * 0.15, ph * 0.05);
  ctx.shadowBlur = 0;

  // Wheels
  ctx.fillStyle = '#222';
  ctx.fillRect(-pw * 0.45, -ph * 0.4, pw * 0.12, ph * 0.15);
  ctx.fillRect(pw * 0.33, -ph * 0.4, pw * 0.12, ph * 0.15);
  ctx.fillRect(-pw * 0.45, ph * 0.25, pw * 0.12, ph * 0.15);
  ctx.fillRect(pw * 0.33, ph * 0.25, pw * 0.12, ph * 0.15);

  ctx.restore();

  // HUD
  document.getElementById('nd-speed').textContent = Math.floor(player.speed) + ' km/h';
  document.getElementById('nd-current-score').textContent = Math.floor(player.score);
  document.getElementById('nd-score-display').textContent = Math.floor(player.score);
}

// ---------- Game Loop ----------
function gameLoop() {
  update();
  render();
  if (player.alive) {
    animationId = requestAnimationFrame(gameLoop);
  }
}

// ---------- Overlay Control ----------
function showGameOver() {
  document.getElementById('nd-overlay-gameover').classList.remove('hidden');
  document.getElementById('nd-final-score').textContent = Math.floor(player.score);
  document.getElementById('nd-high-score').textContent = highScore;
}

function startGame() {
  document.getElementById('nd-overlay-start').classList.add('hidden');
  document.getElementById('nd-overlay-gameover').classList.add('hidden');
  resetGame();
  if (animationId) cancelAnimationFrame(animationId);
  animationId = requestAnimationFrame(gameLoop);
}

// ---------- Event Listeners ----------
document.getElementById('nd-btn-start').addEventListener('click', startGame);
document.getElementById('nd-btn-retry').addEventListener('click', startGame);

// Initial render
render();
