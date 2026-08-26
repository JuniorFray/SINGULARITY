// main.js — Hub page scripts

// --- Starfield Generator ---
(function generateStars() {
  const container = document.getElementById('stars-layer');
  if (!container) return;

  const count = Math.min(120, Math.floor(window.innerWidth * 0.08));
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    const size = Math.random() * 2.5 + 0.5;
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const dur = (Math.random() * 4 + 2).toFixed(1) + 's';
    const delay = (Math.random() * 6).toFixed(1) + 's';
    const bright = (Math.random() * 0.5 + 0.3).toFixed(2);

    star.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      left: ${x}%;
      top: ${y}%;
      --dur: ${dur};
      --delay: -${delay};
      --bright: ${bright};
    `;
    fragment.appendChild(star);
  }

  container.appendChild(fragment);
})();

// --- Footer Year ---
(function setYear() {
  const el = document.getElementById('footer-year');
  if (el) el.textContent = new Date().getFullYear();
})();

// --- Card click ripple (accessibility + UX) ---
document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', function (e) {
    const link = this.querySelector('.btn-play');
    if (link && !e.target.closest('.btn-play')) {
      link.click();
    }
  });

  // Keyboard navigation
  card.setAttribute('tabindex', '0');
  card.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const link = this.querySelector('.btn-play');
      if (link) link.click();
    }
  });
});

// --- Smooth page transition ---
document.querySelectorAll('.btn-play').forEach(btn => {
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    const href = this.getAttribute('href');
    document.body.style.transition = 'opacity 0.25s ease';
    document.body.style.opacity = '0';
    setTimeout(() => { window.location.href = href; }, 250);
  });
});

// --- Load High Scores from LocalStorage ---
(function loadScores() {
  const memScore = localStorage.getItem('memoria_hs') || '0';
  const snakeScore = localStorage.getItem('snake_hs') || '0';
  const racingScore = localStorage.getItem('racing_hs') || '0';
  const neonDriftScore = localStorage.getItem('neon_drift_hs') || '0';
  const breakoutScore = localStorage.getItem('breakout_hs') || '0';
  const flappyScore = localStorage.getItem('flappy_hs') || '0';
  const fpsScore = localStorage.getItem('fps_hs') || '0';
  
  const elMem = document.getElementById('score-memoria');
  const elSnake = document.getElementById('score-snake');
  const elRacing = document.getElementById('score-racing');
  const elNeonDrift = document.getElementById('score-neon-drift');
  const elBreakout = document.getElementById('score-breakout');
  const elFlappy = document.getElementById('score-flappy');
  const elFps = document.getElementById('score-fps');
  
  if (elMem) elMem.textContent = `${memScore} pts`;
  if (elSnake) elSnake.textContent = `${snakeScore} pts`;
  if (elRacing) elRacing.textContent = `${racingScore} pts`;
  if (elNeonDrift) elNeonDrift.textContent = `${neonDriftScore} pts`;
  if (elBreakout) elBreakout.textContent = `${breakoutScore} pts`;
  if (elFlappy) elFlappy.textContent = `${flappyScore} pts`;
  if (elFps) elFps.textContent = `${fpsScore} pts`;
})();
