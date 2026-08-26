self.onmessage = (e) => {
    if (e.data.type === 'PROCESS_PHYSICS') {
        let state = e.data.state;
        
        state.player.x += state.player.vx;
        state.player.y += state.player.vy;

        // Colisões básicas (limites)
        if(state.player.x < 0) state.player.x = 0;
        if(state.player.x > 800 - 30) state.player.x = 800 - 30;
        if(state.player.y < 0) state.player.y = 0;
        if(state.player.y > 450 - 30) state.player.y = 450 - 30;

        self.postMessage({ type: 'PHYSICS_UPDATE', state });
    }
};

self.postMessage({ type: 'READY' });
