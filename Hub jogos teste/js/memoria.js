// memoria.js — Memory Game Logic

const EMOJI_POOL = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼',
  '🐨','🐯','🦁','🐮','🐸','🐵','🦄','🐔',
  '🦋','🐙','🦀','🐠','🦞','🦜','🦩','🦕',
  '🌸','🌻','🍎','🍕','🎸','⚽','🚀','💎'
];

class MemoryGame {
  constructor() {
    this.pairs = 8;
    this.timeLimit = 120;
    this.cards = [];
    this.flipped = [];
    this.matched = 0;
    this.moves = 0;
    this.score = 0;
    this.timer = null;
    this.timeLeft = 0;
    this.isLocked = false;
    this.isRunning = false;

    this.grid = document.getElementById('memory-grid');
    this.timerDisplay = document.getElementById('timer-display');
    this.movesDisplay = document.getElementById('moves-display');
    this.pairsDisplay = document.getElementById('pairs-display');
    this.scoreDisplay = document.getElementById('score-display');

    this.overlayStart = document.getElementById('overlay-start');
    this.overlayGameover = document.getElementById('overlay-gameover');

    this.bindEvents();
  }

  bindEvents() {
    // Difficulty buttons
    document.querySelectorAll('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.pairs = parseInt(btn.dataset.pairs);
        this.timeLimit = parseInt(btn.dataset.time);
      });
    });

    document.getElementById('btn-start-memoria').addEventListener('click', () => {
      this.overlayStart.classList.add('hidden');
      this.startGame();
    });

    document.getElementById('btn-retry').addEventListener('click', () => {
      this.overlayGameover.classList.add('hidden');
      this.startGame();
    });

    document.getElementById('nav-back-memoria').addEventListener('click', (e) => {
      e.preventDefault();
      this.clearTimer();
      document.body.style.transition = 'opacity 0.25s ease';
      document.body.style.opacity = '0';
      setTimeout(() => { window.location.href = '../index.html'; }, 250);
    });
  }

  startGame() {
    this.cards = [];
    this.flipped = [];
    this.matched = 0;
    this.moves = 0;
    this.score = 0;
    this.isLocked = false;
    this.isRunning = true;
    this.timeLeft = this.timeLimit;

    this.updateStatus();
    this.buildGrid();
    this.startTimer();
  }

  buildGrid() {
    const cols = this.pairs <= 8 ? 4 : 6;
    this.grid.setAttribute('data-cols', cols);
    this.grid.innerHTML = '';

    const emojis = EMOJI_POOL.slice(0, this.pairs);
    const deck = [...emojis, ...emojis]
      .map((emoji, i) => ({ emoji, id: i }))
      .sort(() => Math.random() - 0.5);

    deck.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'memory-card';
      card.dataset.emoji = item.emoji;
      card.dataset.index = index;
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'gridcell');
      card.setAttribute('aria-label', `Carta ${index + 1}`);

      card.innerHTML = `
        <div class="card-inner-3d">
          <div class="card-face card-back" aria-hidden="true">
            <span class="card-back-icon">✦</span>
          </div>
          <div class="card-face card-front" aria-hidden="true">
            <span>${item.emoji}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => this.handleCardClick(card));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.handleCardClick(card);
        } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();
          const cols = parseInt(this.grid.getAttribute('data-cols'));
          let nextIndex = index;
          if (e.key === 'ArrowRight') nextIndex++;
          else if (e.key === 'ArrowLeft') nextIndex--;
          else if (e.key === 'ArrowDown') nextIndex += cols;
          else if (e.key === 'ArrowUp') nextIndex -= cols;
          
          if (nextIndex >= 0 && nextIndex < deck.length) {
            this.cards[nextIndex].focus();
          }
        }
      });

      this.grid.appendChild(card);
      this.cards.push(card);
    });
  }

  handleCardClick(card) {
    if (!this.isRunning) return;
    if (this.isLocked) return;
    if (card.classList.contains('flipped') || card.classList.contains('matched')) return;

    card.classList.add('flipped');
    this.flipped.push(card);

    if (this.flipped.length === 2) {
      this.moves++;
      this.movesDisplay.textContent = this.moves;
      this.checkMatch();
    }
  }

  checkMatch() {
    const [a, b] = this.flipped;
    const match = a.dataset.emoji === b.dataset.emoji;

    if (match) {
      const bonus = Math.max(10, 50 - this.moves);
      this.score += bonus + Math.floor(this.timeLeft * 0.5);
      a.classList.add('matched');
      b.classList.add('matched');
      a.querySelector('.card-front').classList.add('matched');
      b.querySelector('.card-front').classList.add('matched');
      this.matched++;
      this.flipped = [];
      this.updateStatus();

      if (this.matched === this.pairs) {
        setTimeout(() => this.endGame(true), 500);
      }
    } else {
      this.isLocked = true;
      a.classList.add('wrong');
      b.classList.add('wrong');

      setTimeout(() => {
        a.classList.remove('flipped', 'wrong');
        b.classList.remove('flipped', 'wrong');
        this.flipped = [];
        this.isLocked = false;
      }, 900);
    }

    this.scoreDisplay.textContent = `${this.score} pts`;
  }

  startTimer() {
    this.clearTimer();
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.updateTimerDisplay();

      if (this.timeLeft <= 0) {
        this.clearTimer();
        this.endGame(false);
      }
    }, 1000);
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateTimerDisplay() {
    const m = Math.floor(this.timeLeft / 60);
    const s = this.timeLeft % 60;
    this.timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.timerDisplay.classList.remove('warning', 'danger');
    if (this.timeLeft <= 10) this.timerDisplay.classList.add('danger');
    else if (this.timeLeft <= 30) this.timerDisplay.classList.add('warning');
  }

  updateStatus() {
    const m = Math.floor(this.timeLeft / 60);
    const s = this.timeLeft % 60;
    this.timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.movesDisplay.textContent = this.moves;
    this.pairsDisplay.textContent = `${this.matched}/${this.pairs}`;
    this.scoreDisplay.textContent = `${this.score} pts`;
  }

  endGame(won) {
    this.clearTimer();
    this.isRunning = false;

    const icon = document.getElementById('go-icon');
    const title = document.getElementById('go-title');
    const subtitle = document.getElementById('go-subtitle');
    const scoreEl = document.getElementById('go-score');

    if (won) {
      const timeBonus = this.timeLeft * 2;
      const finalScore = this.score + timeBonus;
      const highScore = parseInt(localStorage.getItem('memoria_hs') || '0');
      const isNewRecord = finalScore > highScore;
      if (isNewRecord) localStorage.setItem('memoria_hs', finalScore);

      icon.textContent = '🏆';
      title.textContent = 'Parabéns!';
      subtitle.textContent = `Você completou em ${this.moves} jogadas! Bônus de tempo: +${timeBonus} pts` + (isNewRecord ? ' (Novo Recorde!)' : '');
      scoreEl.textContent = `${finalScore} pts`;
    } else {
      const highScore = parseInt(localStorage.getItem('memoria_hs') || '0');
      const isNewRecord = this.score > highScore;
      if (isNewRecord) localStorage.setItem('memoria_hs', this.score);

      icon.textContent = '⏰';
      title.textContent = 'Tempo Esgotado!';
      subtitle.textContent = `Você encontrou ${this.matched} de ${this.pairs} pares. Tente novamente!` + (isNewRecord ? ' (Novo Recorde!)' : '');
      scoreEl.textContent = `${this.score} pts`;
    }

    this.overlayGameover.classList.remove('hidden');
  }
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  document.body.style.opacity = '0';
  requestAnimationFrame(() => {
    document.body.style.transition = 'opacity 0.3s ease';
    document.body.style.opacity = '1';
  });
  new MemoryGame();
});
