// =====================================================
// Jogo da Memoria — memory.js
// =====================================================

const EMOJIS = ['🌙','🔥','💎','🎸','🍀','⚡','🦋','🎯'];

let cards = [];
let flipped = [];
let matched = 0;
let moves = 0;
let locked = false;

const board      = document.getElementById('memory-board');
const movesEl    = document.getElementById('moves-count');
const pairsEl    = document.getElementById('pairs-count');
const winModal   = document.getElementById('win-modal');
const btnRestart = document.getElementById('btn-restart');
const btnAgain   = document.getElementById('btn-play-again');
const winMsg     = document.getElementById('win-message');

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function createCardEl(emoji, index) {
  const card = document.createElement('div');
  card.className = 'mem-card';
  card.dataset.index = index;
  card.dataset.emoji = emoji;
  card.setAttribute('role', 'gridcell');
  card.setAttribute('aria-label', 'Carta oculta');
  card.innerHTML = `
    <div class="mem-card-inner">
      <div class="mem-card-front" aria-hidden="true">?</div>
      <div class="mem-card-back" aria-hidden="true">${emoji}</div>
    </div>`;
  card.addEventListener('click', onCardClick);
  return card;
}

function initGame() {
  board.innerHTML = '';
  cards = [];
  flipped = [];
  matched = 0;
  moves = 0;
  locked = false;
  updateStats();
  winModal.classList.remove('active');

  const deck = shuffle([...EMOJIS, ...EMOJIS]);
  deck.forEach((emoji, i) => {
    const el = createCardEl(emoji, i);
    cards.push(el);
    board.appendChild(el);
  });
}

function updateStats() {
  movesEl.textContent = moves;
  pairsEl.textContent = `${matched}/${EMOJIS.length}`;
}

function onCardClick(e) {
  const card = e.currentTarget;
  if (locked || card.classList.contains('flipped') || card.classList.contains('matched')) return;

  card.classList.add('flipped');
  card.setAttribute('aria-label', `Carta: ${card.dataset.emoji}`);
  flipped.push(card);

  if (flipped.length === 2) {
    locked = true;
    moves++;
    updateStats();
    checkMatch();
  }
}

function checkMatch() {
  const [a, b] = flipped;
  if (a.dataset.emoji === b.dataset.emoji) {
    a.classList.add('matched');
    b.classList.add('matched');
    a.setAttribute('aria-label', `Par encontrado: ${a.dataset.emoji}`);
    b.setAttribute('aria-label', `Par encontrado: ${b.dataset.emoji}`);
    matched++;
    updateStats();
    flipped = [];
    locked = false;
    if (matched === EMOJIS.length) setTimeout(showWin, 500);
  } else {
    setTimeout(() => {
      a.classList.remove('flipped');
      b.classList.remove('flipped');
      a.setAttribute('aria-label', 'Carta oculta');
      b.setAttribute('aria-label', 'Carta oculta');
      flipped = [];
      locked = false;
    }, 900);
  }
}

function showWin() {
  const rating = moves <= 14 ? '⭐⭐⭐ Incrivel!' : moves <= 20 ? '⭐⭐ Muito bom!' : '⭐ Bem feito!';
  winMsg.textContent = `${EMOJIS.length} pares em ${moves} movimentos. ${rating}`;
  winModal.classList.add('active');
}

btnRestart.addEventListener('click', initGame);
btnAgain.addEventListener('click', initGame);

// Init
initGame();
