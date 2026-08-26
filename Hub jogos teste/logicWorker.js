let state = {
    player: { x: 400, y: 225, vx: 0, vy: 0 }
};

let currentKeys = {};

self.onmessage = (e) => {
    if (e.data.type === 'INPUT') {
        currentKeys = e.data.keys;
    }
};

function updateLogic() {
    state.player.vx = 0;
    state.player.vy = 0;

    if (currentKeys['ArrowUp'] || currentKeys['w']) state.player.vy = -5;
    if (currentKeys['ArrowDown'] || currentKeys['s']) state.player.vy = 5;
    if (currentKeys['ArrowLeft'] || currentKeys['a']) state.player.vx = -5;
    if (currentKeys['ArrowRight'] || currentKeys['d']) state.player.vx = 5;

    self.postMessage({ type: 'LOGIC_UPDATE', state });
    setTimeout(updateLogic, 1000 / 60);
}

self.postMessage({ type: 'READY' });
updateLogic();
