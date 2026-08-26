/* ── app.js — NEXUS GAMES ────────────────────────────────── */
'use strict';

/* ════════════════════════════════════════════════
   STORAGE HELPERS
════════════════════════════════════════════════ */
const Store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
};

/* ════════════════════════════════════════════════
   AUDIO ENGINE (Web Audio API)
════════════════════════════════════════════════ */
const Audio = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function play(freq, type = 'sine', dur = 0.12, vol = 0.18, freqEnd = null) {
    try {
      const ac = getCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ac.currentTime);
      if (freqEnd) osc.frequency.linearRampToValueAtTime(freqEnd, ac.currentTime + dur);
      gain.gain.setValueAtTime(vol, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + dur);
    } catch {}
  }

  return {
    flip:    () => play(880, 'sine', 0.08, 0.12),
    match:   () => { play(660, 'sine', 0.1, 0.15); setTimeout(() => play(880, 'sine', 0.1, 0.15), 80); },
    fail:    () => play(200, 'sawtooth', 0.18, 0.12, 100),
    win:     () => { [523,659,784,1047].forEach((f,i) => setTimeout(() => play(f,'sine',0.18,0.2), i*100)); },
    hit:     () => play(600 + Math.random()*200, 'sine', 0.08, 0.2),
    miss:    () => play(150, 'sawtooth', 0.1, 0.1, 80),
    jump:    () => play(300, 'sine', 0.12, 0.15, 500),
    dblJump: () => play(500, 'sine', 0.1, 0.15, 900),
    die:     () => { play(300, 'sawtooth', 0.08, 0.2); setTimeout(() => play(150, 'sawtooth', 0.3, 0.25, 60), 80); },
    beep:    (f) => play(f, 'sine', 0.15, 0.22),
  };
})();

/* ════════════════════════════════════════════════
   PARTICLE BACKGROUND
════════════════════════════════════════════════ */
const Particles = (() => {
  let canvas, ctx, particles = [], raf;

  function init() {
    canvas = document.getElementById('bg-particles');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    createParticles();
    loop();
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function spawn(randomY = true) {
    return {
      x: Math.random() * (canvas.width || 800),
      y: randomY ? Math.random() * (canvas.height || 600) : canvas.height + 10,
      r: Math.random() * 2 + 0.5,
      vx: (Math.random() - 0.5) * 0.4,
      vy: -(Math.random() * 0.6 + 0.2),
      alpha: Math.random() * 0.6 + 0.2,
      hue: Math.random() < 0.5 ? 180 : 300,
    };
  }

  function createParticles() {
    particles = Array.from({ length: 40 }, () => spawn(true));
  }

  function loop() {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p, i) => {
      p.x += p.vx; p.y += p.vy;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue},100%,70%,${p.alpha})`;
      ctx.fill();
      if (p.x < 0 || p.x > canvas.width || p.y < 0 || p.y > canvas.height) {
        particles[i] = spawn(false);
      }
    });
    raf = requestAnimationFrame(loop);
  }

  return { init };
})();

/* ════════════════════════════════════════════════
   APP NAVIGATION
════════════════════════════════════════════════ */
const App = (() => {
  let current = 'hub';
  const screens = {
    hub:      document.getElementById('screen-hub'),
    memory:   document.getElementById('screen-memory'),
    reflex:   document.getElementById('screen-reflex'),
    runner:   document.getElementById('screen-runner'),
    sequence: document.getElementById('screen-sequence'),
  };

  function navigate(to) {
    if (to === current) return;
    const prev = screens[current];
    const next = screens[to];

    if (!next) return;

    // Exit current
    prev.classList.remove('active');
    prev.classList.add('exit');
    setTimeout(() => prev.classList.remove('exit'), 400);

    // Enter next
    next.style.transform = to === 'hub' ? 'translateX(-40px)' : 'translateX(40px)';
    requestAnimationFrame(() => {
      next.classList.add('active');
      next.style.transform = '';
    });

    current = to;

    // Lifecycle hooks
    if (to === 'hub') { Hub.refresh(); Runner.pause(); Memory.pause(); }
    if (to === 'runner') Runner.resume();
    if (to === 'sequence' && window.Sequence) Sequence.showStart();
    if (to === 'memory') Memory.onEnter();
    if (to === 'reflex') Reflex.onEnter();
  }

  function init() {
    Particles.init();
    Hub.refresh();
  }

  return { navigate, init };
})();

/* ════════════════════════════════════════════════
   HUB
════════════════════════════════════════════════ */
const Hub = (() => {
  function refresh() {
    // Memory best
    const memRecords = Store.get('nexus_memory_records', {});
    const memBest = Object.values(memRecords).reduce((best, r) => r.score > best ? r.score : best, 0);
    document.getElementById('hub-best-memory').textContent = memBest > 0 ? memBest : '—';

    // Reflex best
    const refRanking = Store.get('nexus_reflex_ranking', []);
    document.getElementById('hub-best-reflex').textContent = refRanking.length > 0 ? refRanking[0].score : '—';

    // Runner best
    const runBest = Store.get('nexus_runner_best', 0);
    document.getElementById('hub-best-runner').textContent = runBest > 0 ? runBest : '—';

    // Sequence best
    const seqBest = Store.get('nexus_seq_best', 0);
    const elSeq = document.getElementById('hub-best-sequence');
    if (elSeq) elSeq.textContent = seqBest > 0 ? seqBest : '—';
  }
  return { refresh };
})();

/* ════════════════════════════════════════════════
   CYBER MEMORY GAME
════════════════════════════════════════════════ */
const Memory = (() => {
  const SYMBOLS = ['🔮','⚡','💎','🚀','🎯','🌀','🔥','👾','🤖','🦾','🧬','🌊'];
  const CONFIGS = {
    easy:   { cols: 4, rows: 3, pairs: 6 },
    medium: { cols: 4, rows: 4, pairs: 8 },
    hard:   { cols: 6, rows: 4, pairs: 12 },
  };

  let level = 'easy', cards = [], flipped = [], matched = 0, moves = 0, lock = false;
  let timerID = null, elapsed = 0, running = false, paused = false;

  const board   = () => document.getElementById('mem-board');
  const game    = () => document.getElementById('mem-game');
  const diff    = () => document.getElementById('mem-difficulty');
  const winOvl  = () => document.getElementById('mem-win');
  const elMoves = () => document.getElementById('mem-moves');
  const elTimer = () => document.getElementById('mem-timer');

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  }

  function start(lvl) {
    level = lvl;
    moves = 0; matched = 0; elapsed = 0; lock = false; flipped = [];
    running = true; paused = false;

    elMoves().textContent = 'Moves: 0';
    elTimer().textContent = '00:00';

    diff().classList.add('hidden');
    winOvl().classList.add('hidden');
    game().classList.remove('hidden');

    const cfg = CONFIGS[lvl];
    const b = board();
    b.className = `mem-board cols-${cfg.cols}`;
    b.innerHTML = '';

    const syms = shuffle(SYMBOLS).slice(0, cfg.pairs);
    const deck = shuffle([...syms, ...syms]);

    cards = deck.map((sym, idx) => {
      const card = document.createElement('div');
      card.className = 'mem-card';
      card.dataset.idx = idx;
      card.innerHTML = `
        <div class="mem-card-inner">
          <div class="mem-card-front">◈</div>
          <div class="mem-card-back">${sym}</div>
        </div>`;
      card.addEventListener('click', () => onCardClick(card, sym, idx));
      b.appendChild(card);
      return { el: card, sym, idx, isFlipped: false, isMatched: false };
    });

    clearInterval(timerID);
    timerID = setInterval(() => {
      if (!paused && running) {
        elapsed++;
        elTimer().textContent = formatTime(elapsed);
      }
    }, 1000);
  }

  function onCardClick(cardEl, sym, idx) {
    if (lock || !running || paused) return;
    const c = cards[idx];
    if (c.isFlipped || c.isMatched) return;

    Audio.flip();
    c.isFlipped = true;
    cardEl.classList.add('flipped');
    flipped.push(c);

    if (flipped.length === 2) {
      moves++;
      elMoves().textContent = `Moves: ${moves}`;
      checkMatch();
    }
  }

  function checkMatch() {
    lock = true;
    const [c1, c2] = flipped;
    if (c1.sym === c2.sym) {
      Audio.match();
      c1.isMatched = true; c2.isMatched = true;
      c1.el.classList.add('matched'); c2.el.classList.add('matched');
      matched += 2;
      flipped = [];
      lock = false;
      if (matched === cards.length) setTimeout(win, 400);
    } else {
      Audio.fail();
      setTimeout(() => {
        c1.isFlipped = false; c2.isFlipped = false;
        c1.el.classList.remove('flipped'); c2.el.classList.remove('flipped');
        flipped = [];
        lock = false;
      }, 700);
    }
  }

  function win() {
    running = false;
    clearInterval(timerID);
    Audio.win();

    const score = Math.max(10, 1000 - moves * 15 - elapsed * 5);
    const records = Store.get('nexus_memory_records', {});
    const prevBest = records[level]?.score || 0;
    const isNewBest = score > prevBest;

    if (isNewBest) {
      records[level] = { score, moves, time: formatTime(elapsed) };
      Store.set('nexus_memory_records', records);
    }

    document.getElementById('mem-final-moves').textContent = moves;
    document.getElementById('mem-final-time').textContent = formatTime(elapsed);
    document.getElementById('mem-final-score').textContent = score;
    document.getElementById('mem-new-record').classList.toggle('hidden', !isNewBest);
    document.getElementById('mem-replay-btn').onclick = () => start(level);

    winOvl().classList.remove('hidden');
  }

  function showDifficulty() {
    running = false;
    clearInterval(timerID);
    game().classList.add('hidden');
    winOvl().classList.add('hidden');
    diff().classList.remove('hidden');
    renderRecords();
  }

  function renderRecords() {
    const records = Store.get('nexus_memory_records', {});
    const el = document.getElementById('mem-records');
    if (!el) return;
    el.innerHTML = Object.entries(CONFIGS).map(([lvl]) => {
      const r = records[lvl];
      return `<div class="record-item">
        <span class="record-lvl">${lvl.toUpperCase()}</span>
        <span class="record-val">${r ? `${r.score} pts (${r.moves}m)` : '—'}</span>
      </div>`;
    }).join('');
  }

  function onEnter() { showDifficulty(); }
  function pause() { paused = true; }

  return { start, showDifficulty, onEnter, pause };
})();

/* ════════════════════════════════════════════════
   SPEED REFLEX GAME
════════════════════════════════════════════════ */
const Reflex = (() => {
  let score = 0, hits = 0, misses = 0, times = [], timerID = null, timeLeft = 15;
  let running = false, targetTime = 0;

  function showStart() {
    document.getElementById('ref-start').classList.remove('hidden');
    document.getElementById('ref-arena').classList.add('hidden');
    document.getElementById('ref-result').classList.add('hidden');
    renderRanking();
  }

  function start() {
    score = 0; hits = 0; misses = 0; times = []; timeLeft = 15;
    running = true;

    document.getElementById('ref-start').classList.add('hidden');
    document.getElementById('ref-result').classList.add('hidden');
    document.getElementById('ref-arena').classList.remove('hidden');
    document.getElementById('ref-score-chip').textContent = 'Score: 0';
    document.getElementById('ref-time-chip').textContent = '15s';

    spawnTarget();

    clearInterval(timerID);
    timerID = setInterval(() => {
      timeLeft--;
      document.getElementById('ref-time-chip').textContent = `${timeLeft}s`;
      if (timeLeft <= 0) gameOver();
    }, 1000);
  }

  function spawnTarget() {
    const target = document.getElementById('ref-target');
    const arena = document.getElementById('ref-arena');
    if (!target || !arena) return;

    const w = arena.clientWidth - 70;
    const h = arena.clientHeight - 70;
    const x = Math.max(10, Math.floor(Math.random() * w));
    const y = Math.max(10, Math.floor(Math.random() * h));

    target.style.left = `${x}px`;
    target.style.top = `${y}px`;
    target.classList.remove('hit-anim');

    targetTime = Date.now();
  }

  function hit(e) {
    if (!running) return;
    e.stopPropagation();
    const react = Date.now() - targetTime;
    times.push(react);
    hits++;
    score += Math.max(10, 100 - Math.floor(react / 5));

    Audio.hit();
    document.getElementById('ref-score-chip').textContent = `Score: ${score}`;
    spawnTarget();
  }

  function gameOver() {
    running = false;
    clearInterval(timerID);
    Audio.win();

    const ranking = Store.get('nexus_reflex_ranking', []);
    const avgReact = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const prevBest = ranking.length > 0 ? ranking[0].score : 0;
    const isRecord = score > prevBest && score > 0;

    ranking.push({ score, hits, avgReact, date: new Date().toLocaleDateString() });
    ranking.sort((a, b) => b.score - a.score);
    Store.set('nexus_reflex_ranking', ranking.slice(0, 5));

    document.getElementById('ref-final-score').textContent = score;
    document.getElementById('ref-final-hits').textContent = hits;
    document.getElementById('ref-final-avg').textContent = `${avgReact}ms`;
    document.getElementById('ref-new-record').classList.toggle('hidden', !isRecord);

    document.getElementById('ref-arena').classList.add('hidden');
    document.getElementById('ref-result').classList.remove('hidden');
  }

  function renderRanking() {
    const ranking = Store.get('nexus_reflex_ranking', []);
    const el = document.getElementById('ref-ranking');
    if (!el) return;
    if (ranking.length === 0) {
      el.innerHTML = '<li class="rank-empty">Nenhum recorde ainda</li>';
      return;
    }
    el.innerHTML = ranking.map((r, i) => `
      <li class="rank-item">
        <span class="rank-num">#${i + 1}</span>
        <span class="rank-score">${r.score} pts</span>
        <span class="rank-sub">${r.avgReact}ms</span>
      </li>`).join('');
  }

  function onEnter() { showStart(); }

  return { start, hit, showStart, onEnter };
})();

/* ════════════════════════════════════════════════
   NEON TAP RUNNER GAME
════════════════════════════════════════════════ */
const Runner = (() => {
  let canvas, ctx, raf, running = false, paused = false;
  let player = { x: 50, y: 0, w: 24, h: 32, vy: 0, jumps: 0 };
  let obstacles = [], score = 0, spawnTimer = 0;
  const GRAVITY = 0.65, JUMP_FORCE = -12;

  function init() {
    canvas = document.getElementById('run-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
    canvas.parentElement.addEventListener('click', handleJump);
    canvas.parentElement.addEventListener('touchstart', handleJump, {passive: false});
  }

  function resize() {
    if (!canvas) return;
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  }

  function handleJump(e) {
    if (!running || paused) return;
    if (e.type === 'touchstart') e.preventDefault();
    if (player.jumps < 2) {
      player.vy = JUMP_FORCE;
      player.jumps++;
      if (player.jumps === 1) Audio.jump(); else Audio.dblJump();
    }
  }

  function showStart() {
    paused = true;
    cancelAnimationFrame(raf);
    document.getElementById('run-start').classList.remove('hidden');
    document.getElementById('run-canvas-wrap').classList.add('hidden');
    document.getElementById('run-result').classList.add('hidden');
  }

  function startGame() {
    document.getElementById('run-start').classList.add('hidden');
    document.getElementById('run-result').classList.add('hidden');
    document.getElementById('run-canvas-wrap').classList.remove('hidden');

    resize();
    score = 0; obstacles = []; spawnTimer = 0;
    player.y = canvas.height - 60; player.vy = 0; player.jumps = 0;
    running = true; paused = false;
    loop();
  }

  function loop() {
    if (!running || paused) return;
    update();
    render();
    raf = requestAnimationFrame(loop);
  }

  function update() {
    score += 1;
    document.getElementById('run-live-score').textContent = score;
    document.getElementById('run-score-chip').textContent = `Score: ${score}`;

    const groundY = canvas.height - 40;
    player.vy += GRAVITY;
    player.y += player.vy;

    if (player.y >= groundY - player.h) {
      player.y = groundY - player.h;
      player.vy = 0;
      player.jumps = 0;
    }

    spawnTimer++;
    if (spawnTimer > Math.max(45, 90 - Math.floor(score / 200))) {
      spawnTimer = 0;
      obstacles.push({
        x: canvas.width + 20,
        w: Math.random() * 15 + 18,
        h: Math.random() * 25 + 25,
        speed: Math.random() * 2 + 5 + Math.min(score / 300, 6)
      });
    }

    for (let i = obstacles.length - 1; i >= 0; i--) {
      const obs = obstacles[i];
      obs.x -= obs.speed;

      // Colisão
      if (
        player.x < obs.x + obs.w &&
        player.x + player.w > obs.x &&
        player.y + player.h > groundY - obs.h
      ) {
        gameOver();
        return;
      }

      if (obs.x < -30) obstacles.splice(i, 1);
    }
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const groundY = canvas.height - 40;

    // Chão neon
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(canvas.width, groundY);
    ctx.stroke();

    // Player
    ctx.fillStyle = '#00ff88';
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 12;
    ctx.fillRect(player.x, player.y, player.w, player.h);

    // Obstáculos
    ctx.fillStyle = '#ff0055';
    ctx.shadowColor = '#ff0055';
    ctx.shadowBlur = 15;
    obstacles.forEach(obs => {
      ctx.fillRect(obs.x, groundY - obs.h, obs.w, obs.h);
    });
  }

  function gameOver() {
    running = false;
    Audio.die();

    const prev = Store.get('nexus_runner_best', 0);
    const newBest = Math.max(prev, score);
    Store.set('nexus_runner_best', newBest);

    document.getElementById('run-final-score').textContent = score;
    document.getElementById('run-final-best').textContent = newBest;
    document.getElementById('run-new-record').classList.toggle('hidden', score === 0 || score < newBest);
    document.getElementById('run-result').classList.remove('hidden');
  }

  function pause() { paused = true; cancelAnimationFrame(raf); }
  function resume() {}

  init();
  return { start: startGame, pause, resume, showStart };
})();

/* ════════════════════════════════════════════════
   NEON SEQUENCE GAME (Simon Says Cyberpunk)
════════════════════════════════════════════════ */
const Sequence = (() => {
  let sequence = [], playerIdx = 0, isPlayerTurn = false, score = 0;
  const freqs = [330, 440, 550, 660];

  function showStart() {
    document.getElementById('seq-start').classList.remove('hidden');
    document.getElementById('seq-arena').classList.add('hidden');
    document.getElementById('seq-result').classList.add('hidden');
    const best = Store.get('nexus_seq_best', 0);
    document.getElementById('seq-best-chip').textContent = `Best: ${best}`;
  }

  function start() {
    document.getElementById('seq-start').classList.add('hidden');
    document.getElementById('seq-result').classList.add('hidden');
    document.getElementById('seq-arena').classList.remove('hidden');

    sequence = []; score = 0;
    nextRound();
  }

  function nextRound() {
    playerIdx = 0; isPlayerTurn = false;
    score = sequence.length + 1;
    document.getElementById('seq-score-chip').textContent = `Nível: ${score}`;
    document.getElementById('seq-status').textContent = 'Preste atenção...';

    sequence.push(Math.floor(Math.random() * 4));
    playSequence();
  }

  function playSequence() {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= sequence.length) {
        clearInterval(timer);
        isPlayerTurn = true;
        document.getElementById('seq-status').textContent = 'SUA VEZ!';
        return;
      }
      lightPad(sequence[i]);
      i++;
    }, 600);
  }

  function lightPad(idx) {
    const pad = document.getElementById(`pad-${idx}`);
    if (!pad) return;
    Audio.beep(freqs[idx]);
    pad.classList.add('lit');
    setTimeout(() => pad.classList.remove('lit'), 300);
  }

  function tap(idx) {
    if (!isPlayerTurn) return;
    lightPad(idx);

    if (idx === sequence[playerIdx]) {
      playerIdx++;
      if (playerIdx >= sequence.length) {
        isPlayerTurn = false;
        Audio.match();
        setTimeout(nextRound, 800);
      }
    } else {
      gameOver();
    }
  }

  function gameOver() {
    isPlayerTurn = false;
    Audio.die();
    const finalScore = sequence.length - 1;
    const prev = Store.get('nexus_seq_best', 0);
    const newBest = Math.max(prev, finalScore);
    Store.set('nexus_seq_best', newBest);

    document.getElementById('seq-final-score').textContent = finalScore;
    document.getElementById('seq-final-best').textContent = newBest;
    document.getElementById('seq-new-record').classList.toggle('hidden', finalScore === 0 || finalScore < newBest);
    document.getElementById('seq-result').classList.remove('hidden');
  }

  return { start, showStart, tap };
})();
window.Sequence = Sequence;

/* ════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => App.init());
