/* breakout.js — Brick Breaker Game Logic */

(function () {
  'use strict';

  // ===== DOM Elements =====
  const canvas = document.getElementById('breakout-canvas');
  const ctx = canvas.getContext('2d');

  const scoreEl = document.getElementById('breakout-score');
  const livesEl = document.getElementById('breakout-lives');
  const bestEl = document.getElementById('breakout-best');
  const navScoreEl = document.getElementById('breakout-nav-score');
  const startOverlay = document.getElementById('overlay-breakout-start');
  const gameOverOverlay = document.getElementById('overlay-breakout-gameover');
  const goScoreEl = document.getElementById('breakout-go-score');
  const goMsgEl = document.getElementById('breakout-go-msg');
  const highScoreDisplay = document.getElementById('breakout-highscore-display');
  const btnStart = document.getElementById('btn-start-breakout');
  const btnRetry = document.getElementById('btn-breakout-retry');
  const pauseIndicator = document.getElementById('breakout-pause-indicator');
  const touchLeft = document.getElementById('touch-left');
  const touchRight = document.getElementById('touch-right');
  const touchPause = document.getElementById('touch-pause');

  // ===== Game Constants =====
  const COLS = 8;
  const ROWS = 5;
  const BRICK_WIDTH = 70;
  const BRICK_HEIGHT = 20;
  const BRICK_PADDING = 8;
  const BRICK_OFFSET_TOP = 40;
  const BRICK_OFFSET_LEFT = 20;

  const PADDLE_WIDTH = 100;
  const PADDLE_HEIGHT = 14;
  const PADDLE_SPEED = 7;
  const BALL_RADIUS = 8;
  const BALL_SPEED = 4;

  const BRICK_COLORS = [
    '#ff5e00', // orange
    '#ff2d95', // pink
    '#a855f7', // purple
    '#3b82f6', // blue
    '#22d3ee', // cyan
    '#34d399', // green
    '#facc15', // yellow
    '#f97316'  // orange
  ];

  // ===== Game State =====
  let paddle = { x: 0, w: PADDLE_WIDTH, h: PADDLE_HEIGHT, speed: PADDLE_SPEED };
  let ball = { x: 0, y: 0, dx: BALL_SPEED, dy: -BALL_SPEED, r: BALL_RADIUS };
  let bricks = [];
  let score = 0;
  let lives = 3;
  let highScore = parseInt(localStorage.getItem('breakout_hs') || '0', 10);
  let gameRunning = false;
  let gamePaused = false;
  let animationId = null;
  let keys = {};

  // ===== Utility =====
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  function resetBall() {
    ball.x = canvas.width / 2;
    ball.y = canvas.height - 40;
    ball.dx = BALL_SPEED * (Math.random() > 0.5 ? 1 : -1);
    ball.dy = -BALL_SPEED;
  }

  function resetPaddle() {
    paddle.x = (canvas.width - paddle.w) / 2;
  }

  function createBricks() {
    bricks = [];
    for (let row = 0; row < ROWS; row++) {
      bricks[row] = [];
      for (let col = 0; col < COLS; col++) {
        bricks[row][col] = {
          x: BRICK_OFFSET_LEFT + col * (BRICK_WIDTH + BRICK_PADDING),
          y: BRICK_OFFSET_TOP + row * (BRICK_HEIGHT + BRICK_PADDING),
          w: BRICK_WIDTH,
          h: BRICK_HEIGHT,
          alive: true,
          color: BRICK_COLORS[(row + col) % BRICK_COLORS.length]
        };
      }
    }
  }

  function updateUI() {
    scoreEl.textContent = score;
    livesEl.textContent = lives;
    bestEl.textContent = highScore;
    navScoreEl.textContent = score + ' pts';
  }

  function saveHighScore() {
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('breakout_hs', highScore.toString());
      bestEl.textContent = highScore;
    }
  }

  // ===== Collision Detection =====
  function checkBallWallCollision() {
    // Left / Right walls
    if (ball.x - ball.r < 0) {
      ball.x = ball.r;
      ball.dx = -ball.dx;
    } else if (ball.x + ball.r > canvas.width) {
      ball.x = canvas.width - ball.r;
      ball.dx = -ball.dx;
    }
    // Top wall
    if (ball.y - ball.r < 0) {
      ball.y = ball.r;
      ball.dy = -ball.dy;
    }
  }

  function checkPaddleCollision() {
    if (
      ball.dy > 0 &&
      ball.y + ball.r >= paddle.y &&
      ball.y + ball.r <= paddle.y + paddle.h &&
      ball.x >= paddle.x - ball.r &&
      ball.x <= paddle.x + paddle.w + ball.r
    ) {
      // Reflect and adjust angle based on hit position
      const hitPos = (ball.x - paddle.x) / paddle.w; // 0..1
      const angle = (hitPos - 0.5) * Math.PI / 3; // -30°..+30°
      const speed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
      ball.dx = speed * Math.sin(angle);
      ball.dy = -Math.abs(speed * Math.cos(angle));
      ball.y = paddle.y - ball.r;
    }
  }

  function checkBrickCollision() {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const brick = bricks[row][col];
        if (!brick.alive) continue;

        if (
          ball.x + ball.r > brick.x &&
          ball.x - ball.r < brick.x + brick.w &&
          ball.y + ball.r > brick.y &&
          ball.y - ball.r < brick.y + brick.h
        ) {
          brick.alive = false;
          score += 10;
          updateUI();

          // Determine collision side
          const overlapLeft = ball.x + ball.r - brick.x;
          const overlapRight = brick.x + brick.w - (ball.x - ball.r);
          const overlapTop = ball.y + ball.r - brick.y;
          const overlapBottom = brick.y + brick.h - (ball.y - ball.r);

          const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
          if (minOverlap === overlapLeft || minOverlap === overlapRight) {
            ball.dx = -ball.dx;
          } else {
            ball.dy = -ball.dy;
          }

          // Check win condition
          if (bricks.every(row => row.every(b => !b.alive))) {
            gameWin();
          }
          return;
        }
      }
    }
  }

  function checkBallFall() {
    if (ball.y - ball.r > canvas.height) {
      lives--;
      updateUI();
      if (lives <= 0) {
        gameOver();
      } else {
        resetBall();
        resetPaddle();
      }
    }
  }

  // ===== Game Loop =====
  function update() {
    if (!gameRunning || gamePaused) return;

    // Move paddle with keyboard
    if (keys['ArrowLeft'] || keys['a'] || keys['A']) {
      paddle.x -= paddle.speed;
    }
    if (keys['ArrowRight'] || keys['d'] || keys['D']) {
      paddle.x += paddle.speed;
    }
    paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, paddle.x));

    // Move ball
    ball.x += ball.dx;
    ball.y += ball.dy;

    checkBallWallCollision();
    checkPaddleCollision();
    checkBrickCollision();
    checkBallFall();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw bricks
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const brick = bricks[row][col];
        if (!brick.alive) continue;

        ctx.shadowColor = brick.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = brick.color;
        ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
        ctx.shadowBlur = 0;

        // Brick border
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(brick.x, brick.y, brick.w, brick.h);
      }
    }

    // Draw paddle
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#22d3ee';
    ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
    ctx.shadowBlur = 0;

    // Draw ball
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fillStyle = '#22d3ee';
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function gameLoop() {
    update();
    draw();
    if (gameRunning) {
      animationId = requestAnimationFrame(gameLoop);
    }
  }

  // ===== Game Control =====
  function startGame() {
    score = 0;
    lives = 3;
    createBricks();
    resetPaddle();
    resetBall();
    updateUI();
    gameRunning = true;
    gamePaused = false;
    startOverlay.classList.add('hidden');
    gameOverOverlay.classList.add('hidden');
    pauseIndicator.classList.remove('visible');
    if (animationId) cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(gameLoop);
  }

  function gameOver() {
    gameRunning = false;
    saveHighScore();
    goScoreEl.textContent = score + ' pts';
    goMsgEl.textContent = 'A bola caiu! Tente novamente.';
    highScoreDisplay.textContent = '🏆 Recorde: ' + highScore;
    gameOverOverlay.classList.remove('hidden');
  }

  function gameWin() {
    gameRunning = false;
    saveHighScore();
    goScoreEl.textContent = score + ' pts';
    goMsgEl.textContent = 'Você quebrou todos os tijolos! Vitória!';
    highScoreDisplay.textContent = '🏆 Recorde: ' + highScore;
    gameOverOverlay.classList.remove('hidden');
  }

  function togglePause() {
    if (!gameRunning) return;
    gamePaused = !gamePaused;
    pauseIndicator.classList.toggle('visible', gamePaused);
  }

  // ===== Input Handling =====
  // Keyboard
  document.addEventListener('keydown', (e) => {
    keys[e.key] = true;
    if (e.key === 'p' || e.key === 'P') {
      togglePause();
    }
  });
  document.addEventListener('keyup', (e) => {
    keys[e.key] = false;
  });

  // Mouse
  canvas.addEventListener('mousemove', (e) => {
    if (!gameRunning) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    paddle.x = mouseX - paddle.w / 2;
    paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, paddle.x));
  });

  // Touch controls
  let touchLeftActive = false;
  let touchRightActive = false;

  function setTouchLeft(active) {
    touchLeftActive = active;
  }
  function setTouchRight(active) {
    touchRightActive = active;
  }

  touchLeft.addEventListener('touchstart', (e) => { e.preventDefault(); setTouchLeft(true); });
  touchLeft.addEventListener('touchend', (e) => { e.preventDefault(); setTouchLeft(false); });
  touchLeft.addEventListener('mousedown', (e) => { e.preventDefault(); setTouchLeft(true); });
  touchLeft.addEventListener('mouseup', (e) => { e.preventDefault(); setTouchLeft(false); });
  touchLeft.addEventListener('mouseleave', (e) => { e.preventDefault(); setTouchLeft(false); });

  touchRight.addEventListener('touchstart', (e) => { e.preventDefault(); setTouchRight(true); });
  touchRight.addEventListener('touchend', (e) => { e.preventDefault(); setTouchRight(false); });
  touchRight.addEventListener('mousedown', (e) => { e.preventDefault(); setTouchRight(true); });
  touchRight.addEventListener('mouseup', (e) => { e.preventDefault(); setTouchRight(false); });
  touchRight.addEventListener('mouseleave', (e) => { e.preventDefault(); setTouchRight(false); });

  // Touch move paddle
  function touchMovePaddle() {
    if (!gameRunning) return;
    if (touchLeftActive) paddle.x -= paddle.speed;
    if (touchRightActive) paddle.x += paddle.speed;
    paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, paddle.x));
  }

  // Integrate touch movement into update loop
  const originalUpdate = update;
  update = function () {
    touchMovePaddle();
    originalUpdate();
  };

  touchPause.addEventListener('click', togglePause);

  // ===== Buttons =====
  btnStart.addEventListener('click', startGame);
  btnRetry.addEventListener('click', startGame);

  // ===== Init =====
  window.addEventListener('resize', () => {
    resizeCanvas();
    resetPaddle();
    resetBall();
  });

  resizeCanvas();
  resetPaddle();
  resetBall();
  updateUI();
  bestEl.textContent = highScore;
  navScoreEl.textContent = '0 pts';
})();
