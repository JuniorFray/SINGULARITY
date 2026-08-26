// snake.js — Snake Game Logic

class SnakeGame {
  constructor() {
    this.canvas = document.getElementById('snake-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.GRID = 20;
    this.CELL = 0;
    this.speed = 200;
    this.snake = [];
    this.direction = { x: 1, y: 0 };
    this.moveQueue = [];
    this.food = null;
    this.score = 0;
    this.highScore = parseInt(localStorage.getItem('snake_hs') || '0');
    this.isRunning = false;
    this.isPaused = false;
    this.loop = null;
    this.lastTime = 0;
    this.lag = 0;

    this.overlayStart = document.getElementById('overlay-snake-start');
    this.overlayGameover = document.getElementById('overlay-snake-gameover');
    this.pauseIndicator = document.getElementById('snake-pause-indicator');

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    this.bindEvents();
    this.updateHighScore();
  }

  resizeCanvas() {
    const wrapper = this.canvas.parentElement;
    const size = Math.min(wrapper.clientWidth, wrapper.clientHeight);
    this.canvas.width = size;
    this.canvas.height = size;
    this.CELL = Math.floor(size / this.GRID);
    if (this.isRunning && !this.isPaused) this.draw();
  }

  bindEvents() {
    // Difficulty
    document.querySelectorAll('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.speed = parseInt(btn.dataset.speed);
      });
    });

    document.getElementById('btn-start-snake').addEventListener('click', () => {
      this.overlayStart.classList.add('hidden');
      this.startGame();
    });

    document.getElementById('btn-snake-retry').addEventListener('click', () => {
      this.overlayGameover.classList.add('hidden');
      this.startGame();
    });

    document.getElementById('nav-back-snake').addEventListener('click', (e) => {
      e.preventDefault();
      this.stopLoop();
      document.body.style.transition = 'opacity 0.25s ease';
      document.body.style.opacity = '0';
      setTimeout(() => { window.location.href = '../index.html'; }, 250);
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      const map = {
        'ArrowUp': { x: 0, y: -1 }, 'w': { x: 0, y: -1 },
        'ArrowDown': { x: 0, y: 1 }, 's': { x: 0, y: 1 },
        'ArrowLeft': { x: -1, y: 0 }, 'a': { x: -1, y: 0 },
        'ArrowRight': { x: 1, y: 0 }, 'd': { x: 1, y: 0 }
      };

      if (map[e.key] && this.isRunning && !this.isPaused) {
        e.preventDefault();
        const d = map[e.key];
        const lastMove = this.moveQueue.length > 0 ? this.moveQueue[this.moveQueue.length - 1] : this.direction;
        if (d.x !== -lastMove.x || d.y !== -lastMove.y) {
          if (this.moveQueue.length < 3) this.moveQueue.push(d);
        }
      }

      if ((e.key === 'p' || e.key === 'P') && this.isRunning) {
        e.preventDefault();
        this.togglePause();
      }
    });

    // Touch Controls
    const touchMap = {
      'touch-up': { x: 0, y: -1 },
      'touch-down': { x: 0, y: 1 },
      'touch-left': { x: -1, y: 0 },
      'touch-right': { x: 1, y: 0 }
    };

    Object.entries(touchMap).forEach(([id, dir]) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('click', () => {
          if (!this.isRunning || this.isPaused) return;
          const lastMove = this.moveQueue.length > 0 ? this.moveQueue[this.moveQueue.length - 1] : this.direction;
          if (dir.x !== -lastMove.x || dir.y !== -lastMove.y) {
            if (this.moveQueue.length < 3) this.moveQueue.push(dir);
          }
        });
      }
    });

    document.getElementById('touch-pause').addEventListener('click', () => {
      if (this.isRunning) this.togglePause();
    });

    // Swipe support
    let touchStartX = 0, touchStartY = 0;
    this.canvas.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    this.canvas.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (!this.isRunning || this.isPaused) return;
      const lastMove = this.moveQueue.length > 0 ? this.moveQueue[this.moveQueue.length - 1] : this.direction;
      if (Math.abs(dx) > Math.abs(dy)) {
        const d = dx > 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
        if (d.x !== -lastMove.x) { if (this.moveQueue.length < 3) this.moveQueue.push(d); }
      } else {
        const d = dy > 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
        if (d.y !== -lastMove.y) { if (this.moveQueue.length < 3) this.moveQueue.push(d); }
      }
    }, { passive: true });
  }

  startGame() {
    this.snake = [
      { x: Math.floor(this.GRID / 2), y: Math.floor(this.GRID / 2) },
      { x: Math.floor(this.GRID / 2) - 1, y: Math.floor(this.GRID / 2) }
    ];
    this.direction = { x: 1, y: 0 };
    this.moveQueue = [];
    this.score = 0;
    this.isRunning = true;
    this.isPaused = false;
    this.pauseIndicator.classList.remove('visible');
    this.placeFood();
    this.updateScoreDisplay();
    this.stopLoop();
    this.lastTime = 0;
    this.lag = 0;
    this.loop = requestAnimationFrame((t) => this.gameLoop(t));
  }

  gameLoop(timestamp) {
    if (!this.isRunning || this.isPaused) return;

    const delta = this.lastTime ? timestamp - this.lastTime : 0;
    this.lastTime = timestamp;
    this.lag += delta;

    while (this.lag >= this.speed) {
      this.update();
      this.lag -= this.speed;
    }

    this.draw();
    this.loop = requestAnimationFrame((t) => this.gameLoop(t));
  }

  stopLoop() {
    if (this.loop) {
      cancelAnimationFrame(this.loop);
      this.loop = null;
    }
  }

  update() {
    if (this.moveQueue.length > 0) {
      this.direction = this.moveQueue.shift();
    }
    const head = {
      x: this.snake[0].x + this.direction.x,
      y: this.snake[0].y + this.direction.y
    };

    // Wall collision
    if (head.x < 0 || head.x >= this.GRID || head.y < 0 || head.y >= this.GRID) {
      return this.endGame('A cobra bateu na parede!');
    }

    // Self collision
    if (this.snake.some(s => s.x === head.x && s.y === head.y)) {
      return this.endGame('A cobra comeu a si mesma!');
    }

    this.snake.unshift(head);

    // Eat food
    if (head.x === this.food.x && head.y === this.food.y) {
      this.score += 10;
      this.updateScoreDisplay();
      this.placeFood();
    } else {
      this.snake.pop();
    }

    document.getElementById('snake-length').textContent = this.snake.length;
  }

  draw() {
    const ctx = this.ctx;
    const cell = this.CELL;
    const size = this.canvas.width;

    // Background
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--clr-bg').trim() || '#f4f4f4';
    ctx.fillRect(0, 0, size, size);

    // Grid lines (subtle)
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--clr-border').trim() || '#ddd';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= this.GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * cell);
      ctx.lineTo(size, i * cell);
      ctx.stroke();
    }

    // Food
    if (this.food) {
      const fx = this.food.x * cell + cell / 2;
      const fy = this.food.y * cell + cell / 2;
      const r = cell * 0.42;

      ctx.save();
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(fx - r * 0.2, fy - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Snake
    this.snake.forEach((seg, i) => {
      const x = seg.x * cell;
      const y = seg.y * cell;
      const padding = i === 0 ? 1 : 2;
      const segSize = cell - padding * 2;
      const radius = i === 0 ? 6 : 4;

      const t = i / this.snake.length;
      const r = Math.round(34 * (1 - t) + 16 * t);
      const g = Math.round(197 * (1 - t) + 120 * t);
      const b = Math.round(94 * (1 - t) + 40 * t);

      ctx.save();
      if (i === 0) {
        ctx.shadowColor = 'rgba(34,197,94,0.6)';
        ctx.shadowBlur = 10;
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      this.roundRect(ctx, x + padding, y + padding, segSize, segSize, radius);
      ctx.fill();
      ctx.restore();

      // Eyes on head
      if (i === 0) {
        ctx.fillStyle = '#fff';
        const eyeOffset = cell * 0.22;
        const eyeR = cell * 0.1;
        const eyeX1 = x + cell / 2 - eyeOffset * (this.direction.y !== 0 ? 1 : 0);
        const eyeY1 = y + cell / 2 - eyeOffset * (this.direction.x !== 0 ? 1 : 0);
        ctx.beginPath();
        ctx.arc(eyeX1 - this.direction.y * eyeOffset, eyeY1 - this.direction.x * eyeOffset, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eyeX1 + this.direction.y * eyeOffset, eyeY1 + this.direction.x * eyeOffset, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  roundRect(ctx, x, y, w, h, r) {
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

  placeFood() {
    let pos;
    do {
      pos = {
        x: Math.floor(Math.random() * this.GRID),
        y: Math.floor(Math.random() * this.GRID)
      };
    } while (this.snake.some(s => s.x === pos.x && s.y === pos.y));
    this.food = pos;
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    this.pauseIndicator.classList.toggle('visible', this.isPaused);
    if (!this.isPaused) {
      this.lastTime = 0;
      this.lag = 0;
      this.loop = requestAnimationFrame((t) => this.gameLoop(t));
    }
  }

  updateScoreDisplay() {
    document.getElementById('snake-score').textContent = this.score;
    document.getElementById('snake-score-display').textContent = `${this.score} pts`;
  }

  updateHighScore() {
    const hsEl = document.getElementById('highscore');
    if (hsEl) hsEl.textContent = this.highScore;
  }

  endGame(msg) {
    this.stopLoop();
    this.isRunning = false;
    this.pauseIndicator.classList.remove('visible');

    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem('snake_hs', this.highScore);
    }

    const goMessage = document.getElementById('go-message');
    if (goMessage) goMessage.textContent = `${msg} | Sua pontuação: ${this.score} pts | Recorde: ${this.highScore}`;
    
    this.updateHighScore();
    this.overlayGameover.classList.remove('hidden');
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  document.body.style.opacity = '0';
  requestAnimationFrame(() => {
    document.body.style.transition = 'opacity 0.3s ease';
    document.body.style.opacity = '1';
  });
  new SnakeGame();
});
