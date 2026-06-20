import { setupRender, runRender } from './visual/render';
import { appInitialized, simulation } from './app';

let lastTime = performance.now();

async function init() {
    // Waiting for intitialization
    await Promise.all([setupRender(), appInitialized]);
    // Run the loop
    console.log("Initilized...");

    requestAnimationFrame(animate);
}

let totalDistance = 0; 
const TRACK_LENGTH = 3337;

function animate(currentTime: number) {
    requestAnimationFrame(animate);
    let dt = (currentTime - lastTime) / 1000.0; // Convert to seconds
    lastTime = currentTime;
    // Cap delta time to prevent physics explosions on background tab focus shifts
    if (dt > 0.1) dt = 0.1;

    const state = simulation(dt);

    if (state) {

    totalDistance += state.vx * dt; 
    // t (from 0 to 1)
    const t = (totalDistance % TRACK_LENGTH) / TRACK_LENGTH; 
        runRender(t, state); 
    }

}

init();
