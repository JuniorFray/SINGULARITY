// Racing Game — endless lane dodger. IDs alinhados ao racing.html.
(function () {
  const canvas = document.getElementById('racing-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const wrapper = canvas.parentElement;

  // Elementos da UI (IDs exatos do racing.html)
  const startOverlay = document.getElementById('overlay-racing-start');
  const overOverlay = document.getElementById('overlay-racing-gameover');
  const btnStart = document.getElementById('btn-start-racing');
  const btnRetry = document.getElementById('btn-racing-retry');
  const pauseInd = document.getElementById('racing-pause-indicator');
  const elScoreNav = document.getElementById('racing-score-display');
  const elDist = document.getElementById('racing-distance');
  const elSpeed = document.getElementById('racing-speed');
  const elBest = document.getElementById('racing-best');
  const elGoScore = document.getElementById('racing-go-score');
  const elHsDisplay = document.getElementById('racing-highscore-display');
  const diffBtns = Array.from(document.querySelectorAll('.diff-btn'));

  let W = 0, H = 0, laneCount = 4, laneW = 0;
  let player, obstacles, running, paused, over, score, dist, baseSpeed, spawnT, raf, last;
  let highScore = parseInt(localStorage.getItem('racing_hs') || '0', 10) || 0;
  let chosenSpeed = 3; // dificuldade (data-speed)
  const keys = {};

  function fit() {
    // dimensiona o buffer do canvas ao tamanho real do wrapper (aspect 16/9 no CSS)
    const r = wrapper.getBoundingClientRect();
    W = Math.max(240, Math.floor(r.width));
    H = Math.max(240, Math.floor(r.height || r.width * 0.5625));
    canvas.width = W;
    canvas.height = H;
    laneW = W / laneCount;
    if (player) {
      player.w = Math.min(48, laneW * 0.6);
      player.h = player.w * 1.7;
      player.x = Math.min(Math.max(player.x, 0), W - player.w);
      player.y = H - player.h - 16;
    }
  }

  function reset() {
    player = { w: Math.min(48, laneW * 0.6), h: 0, x: 0, y: 0, lane: 1 };
    player.h = player.w * 1.7;
    player.x = W / 2 - player.w / 2;
    player.y = H - player.h - 16;
    obstacles = [];
    running = true; paused = false; over = false;
    score = 0; dist = 0; baseSpeed = 140 + chosenSpeed * 30; spawnT = 0;
    last = performance.now();
    if (elBest) elBest.textContent = highScore + ' m';
  }

  function spawn() {
    const lane = Math.floor(Math.random() * laneCount);
    const w = Math.min(48, laneW * 0.6);
    obstacles.push({
      x: lane * laneW + (laneW - w) / 2,
      y: -w * 1.7,
      w: w, h: w * 1.7,
      color: ['#ff3333', '#33ff33', '#ffff33', '#ff33ff'][Math.floor(Math.random()*4)]
    });
  }

  function changeLane(dir) { if (!running || paused) return; player.lane = Math.max(0, Math.min(laneCount - 1, player.lane + dir)); player.x = player.lane * laneW + (laneW - player.w) / 2; }

  function hit(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function update(dt) {
    const move = 320 * dt;
    // Movimento por snap de faixa removido, agora controlado por changeLane()

    dist += (baseSpeed * dt) / 10;
    score = Math.floor(dist);
    baseSpeed += dt * 4; // acelera com o tempo

    spawnT -= dt;
    if (spawnT <= 0) {
      spawn();
      spawnT = Math.max(0.45, 1.1 - dist / 4000);
    }
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.y += baseSpeed * dt;
      if (o.y > H + o.h) { obstacles.splice(i, 1); continue; }
      if (hit(player, o)) { gameOver(); return; }
    }

    if (elScoreNav) elScoreNav.textContent = score + ' pts';
    if (elDist) elDist.textContent = score + ' m';
    if (elSpeed) elSpeed.textContent = Math.round(baseSpeed) + ' km/h';
  }

  function draw() {
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, W, H);
    // faixas
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([18, 18]);
    ctx.lineDashOffset = -((dist * 6) % 36);
    for (let i = 1; i < laneCount; i++) {
      ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, H); ctx.stroke();
    }
    ctx.setLineDash([]);
    // bordas neon
    ctx.strokeStyle = '#ffa500';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 0, W - 4, H);
    // obstáculos
    for (const o of obstacles) { drawCar(o.x, o.y, o.w, o.h, o.color); }
    // player
    drawCar(player.x, player.y, player.w, player.h, '#00e5ff');
  }

  function drawCar(x, y, w, h, color) { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.beginPath(); ctx.moveTo(x + w*0.2, y); ctx.lineTo(x + w*0.8, y); ctx.lineTo(x + w, y + h*0.3); ctx.lineTo(x + w, y + h*0.7); ctx.lineTo(x + w*0.8, y + h); ctx.lineTo(x + w*0.2, y + h); ctx.lineTo(x, y + h*0.7); ctx.lineTo(x, y + h*0.3); ctx.closePath(); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x + w*0.15, y + h*0.2, w*0.7, h*0.6); ctx.shadowBlur = 0; }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (paused) { last = t; return; }
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    update(dt);
    if (!over) draw();
  }

  function start() {
    fit();
    reset();
    if (startOverlay) startOverlay.classList.add('hidden');
    if (overOverlay) overOverlay.classList.add('hidden');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function gameOver() {
    over = true; running = false;
    cancelAnimationFrame(raf);
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('racing_hs', String(highScore));
    }
    if (elGoScore) elGoScore.textContent = score + ' pts';
    if (elHsDisplay) elHsDisplay.textContent = '🏆 Recorde: ' + highScore;
    if (elBest) elBest.textContent = highScore + ' m';
    if (overOverlay) overOverlay.classList.remove('hidden');
  }

  function togglePause() {
    if (!running || over) return;
    paused = !paused;
    if (pauseInd) pauseInd.classList.toggle('visible', paused);
  }

  // ---- controles ----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') changeLane(-1);
    if (e.key === 'ArrowRight') changeLane(1);
    if (e.key.toLowerCase() === 'p') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft') keys.left = false;
    if (e.key === 'ArrowRight') keys.right = false;
  });

  function bindHold(id, prop) {
    const el = document.getElementById(id);
    if (!el) return;
    const on = (e) => { e.preventDefault(); keys[prop] = true; };
    const off = (e) => { e.preventDefault(); keys[prop] = false; };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
  }
  document.getElementById('racing-touch-left').addEventListener('click', () => changeLane(-1));
  document.getElementById('racing-touch-right').addEventListener('click', () => changeLane(1));
  const tp = document.getElementById('racing-touch-pause');
  if (tp) tp.addEventListener('click', togglePause);

  diffBtns.forEach((b) => b.addEventListener('click', () => {
    diffBtns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    chosenSpeed = parseInt(b.dataset.speed || '3', 10);
  }));

  if (btnStart) btnStart.addEventListener('click', start);
  if (btnRetry) btnRetry.addEventListener('click', start);
  window.addEventListener('resize', () => { if (running) fit(); });

  // dimensiona já na carga p/ o canvas não abrir em branco
  fit();
  if (elBest) elBest.textContent = highScore + ' m';
})();
