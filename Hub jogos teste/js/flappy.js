// flappy.js — Flappy Bird Game Logic

(function() {
  const canvas = document.getElementById('flappy-canvas');
  const ctx = canvas.getContext('2d');

  // Game state
  let gameRunning = false;
  let gameOver = false;
  let score = 0;
  let highScore = parseInt(localStorage.getItem('flappy_hs') || '0', 10);

  // Bird
  const bird = {
    x: 80,
    y: 200,
    radius: 14,
    velocity: 0,
    jumpForce: -7,
    gravity: 0.5
  };

  // Pipes
  const pipes = [];
  const pipeWidth = 60;
  const pipeGap = 150;
  const pipeSpeed = 2;
  let pipeSpawnTimer = 0;
  const pipeSpawnInterval = 90; // frames

  // Canvas dimensions
  const canvasWidth = 400;
  const canvasHeight = 700;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  // DOM elements
  const scoreDisplay = document.getElementById('flappy-score');
  const bestDisplay = document.getElementById('flappy-best');
  const navScore = document.getElementById('flappy-nav-score');
  const startOverlay = document.getElementById('overlay-flappy-start');
  const gameOverOverlay = document.getElementById('overlay-flappy-gameover');
  const finalScore = document.getElementById('flappy-go-score');
  const highScoreDisplay = document.getElementById('flappy-highscore-display');
  const startBtn = document.getElementById('btn-start-flappy');
  const retryBtn = document.getElementById('btn-flappy-retry');
  const flapBtn = document.getElementById('flappy-flap-btn');

  // Update high score display
  function updateHighScore() {
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('flappy_hs', highScore.toString());
    }
    if (bestDisplay) bestDisplay.textContent = highScore;
    if (navScore) navScore.textContent = highScore + ' pts';
  }

  // Reset game state
  function resetGame() {
    bird.y = 200;
    bird.velocity = 0;
    pipes.length = 0;
    score = 0;
    pipeSpawnTimer = 0;
    gameOver = false;
    gameRunning = true;
    updateScoreDisplay();
  }

  // Update score display
  function updateScoreDisplay() {
    if (scoreDisplay) scoreDisplay.textContent = score;
    if (navScore) navScore.textContent = score + ' pts';
  }

  // Flap action
  function flap() {
    if (!gameRunning || gameOver) return;
    bird.velocity = bird.jumpForce;
  }

  // Spawn a pipe
  function spawnPipe() {
    const gapY = Math.random() * (canvasHeight - pipeGap - 100) + 50;
    pipes.push({
      x: canvasWidth,
      gapY: gapY,
      gapHeight: pipeGap,
      width: pipeWidth
    });
  }

  // Collision detection
  function checkCollision() {
    // Ground / ceiling
    if (bird.y + bird.radius > canvasHeight || bird.y - bird.radius < 0) {
      return true;
    }

    // Pipes
    for (let pipe of pipes) {
      if (bird.x + bird.radius > pipe.x && bird.x - bird.radius < pipe.x + pipe.width) {
        if (bird.y - bird.radius < pipe.gapY || bird.y + bird.radius > pipe.gapY + pipe.gapHeight) {
          return true;
        }
      }
    }
    return false;
  }

  // Update game state
  function update() {
    if (!gameRunning || gameOver) return;

    // Bird physics
    bird.velocity += bird.gravity;
    bird.y += bird.velocity;

    // Move pipes
    for (let i = pipes.length - 1; i >= 0; i--) {
      pipes[i].x -= pipeSpeed;

      // Score when pipe passes bird
      if (!pipes[i].scored && pipes[i].x + pipes[i].width < bird.x) {
        pipes[i].scored = true;
        score++;
        updateScoreDisplay();
        updateHighScore();
      }

      // Remove off-screen pipes
      if (pipes[i].x + pipes[i].width < 0) {
        pipes.splice(i, 1);
      }
    }

    // Spawn new pipes
    pipeSpawnTimer++;
    if (pipeSpawnTimer >= pipeSpawnInterval) {
      spawnPipe();
      pipeSpawnTimer = 0;
    }

    // Collision check
    if (checkCollision()) {
      gameOver = true;
      gameRunning = false;
      updateHighScore();
      showGameOver();
    }
  }

  // Draw everything
  function draw() {
    // Clear canvas with dark gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
    gradient.addColorStop(0, '#0a0a14');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw pipes
    for (let pipe of pipes) {
      ctx.shadowColor = 'var(--clr-teal)';
      ctx.shadowBlur = 15;
      ctx.fillStyle = 'var(--clr-teal)';
      ctx.fillRect(pipe.x, 0, pipe.width, pipe.gapY);
      ctx.fillRect(pipe.x, pipe.gapY + pipe.gapHeight, pipe.width, canvasHeight - pipe.gapY - pipe.gapHeight);
    }

    // Draw bird
    ctx.shadowColor = 'var(--clr-amber)';
    ctx.shadowBlur = 20;
    ctx.fillStyle = 'var(--clr-amber)';
    ctx.beginPath();
    ctx.arc(bird.x, bird.y, bird.radius, 0, Math.PI * 2);
    ctx.fill();

    // Reset shadow
    ctx.shadowBlur = 0;
  }

  // Game loop
  function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
  }

  // Show game over overlay
  function showGameOver() {
    if (finalScore) finalScore.textContent = score + ' pts';
    if (highScoreDisplay) highScoreDisplay.textContent = '🏆 Recorde: ' + highScore;
    if (gameOverOverlay) gameOverOverlay.classList.remove('hidden');
  }

  // Start game
  function startGame() {
    if (startOverlay) startOverlay.classList.add('hidden');
    if (gameOverOverlay) gameOverOverlay.classList.add('hidden');
    resetGame();
  }

  // Event listeners
  if (startBtn) startBtn.addEventListener('click', startGame);
  if (retryBtn) retryBtn.addEventListener('click', startGame);
  if (flapBtn) {
    flapBtn.addEventListener('click', flap);
    flapBtn.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      flap();
    }
  });

  canvas.addEventListener('click', flap);

  // Start the loop
  gameLoop();
})();
