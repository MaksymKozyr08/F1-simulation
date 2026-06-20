import { setupRender, runRender } from './visual/render';
import { appInitialized, simulation } from './app';

let lastTime = performance.now();

async function init() {
    // 1. Спочатку чекаємо на ініціалізацію
    await Promise.all([setupRender(), appInitialized]);
    // 2. Потім запускаємо цикл
    animate(lastTime);
    console.log("Initilized...");
}

function animate(currentTime: number) {
    requestAnimationFrame(animate);
    let dt = (currentTime - lastTime) / 1000.0; // Convert to seconds
    lastTime = currentTime;
    
    // Cap delta time to prevent physics explosions on background tab focus shifts
    if (dt > 0.1) dt = 0.1;
    const state = simulation(dt);

    if (state) {
        runRender(state);
    }


}

init();
