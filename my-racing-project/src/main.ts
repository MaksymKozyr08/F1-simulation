import * as THREE from 'three';
import { Car } from './visual/car';
import { createTrack } from './visual/track';
import { scene } from './visual/scene';

// @ts-ignore
import physicsCode from './physics/physics.js?raw';

// 1. Inject the physics engine class into the global scope
(0, eval)(physicsCode);

// Wrap the global physics class to capture its instance when app.js creates it
const OriginalPhysics = (window as any).RWIDVehiclePhysics;
let activePhysicsInstance: any = null;
(window as any).RWIDVehiclePhysics = class extends OriginalPhysics {
    constructor(...args: any[]) {
        super(...args);
        activePhysicsInstance = this;
    }
};

// 2. Dynamically import app.js and render.ts to ensure they execute after physics is globally available
// @ts-ignore
const { appInitialized, simulation } = await import('./app');
// @ts-ignore
const { setupRender, runRender, cycleCamera, setRenderCurve } = await import('./visual/render');

// Capturing state and instances
let activeCurve: THREE.CatmullRomCurve3 | null = null;
let activeCarInstance: Car | null = null;

// Active curve is captured from setupRender output or rebuildTrack

// Active car instance and curve are captured directly from setupRender output or rebuildTrack

// Simulation state variables
let lastTime = performance.now();
let progressT = 0;
let distance = 0;
let cte = 0;
let cteIntegral = 0;
let prevCte = 0;

// Lap tracking variables
let lapNumber = 1;
let lapTime = 0;
let maxSpeedInLap = 0;
let cteSumInLap = 0;
let cteCountInLap = 0;
let prevTForLap = 0;

// Keyboard state for manual driving
let isManual = false;
const keys: { [key: string]: boolean } = {};
let lastTrack = '';
let shouldAlignHeading = true;

// Live CTE chart history
const cteHistory: number[] = [];

// Track point generator for Monaco, Monza, Spa, and Suzuka GP
function generateTrackPoints(trackId: string): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    if (trackId === 'monaco') {
        const numPoints = 16;
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const r = 25 + Math.sin(angle * 3) * 6 + Math.cos(angle * 5) * 2;
            points.push(new THREE.Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r));
        }
    } else if (trackId === 'monza') {
        const numPoints = 12;
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const x = Math.cos(angle) * 55;
            let z = Math.sin(angle) * 22;
            if (angle > Math.PI * 0.45 && angle < Math.PI * 0.55) {
                z += Math.sin(angle * 12) * 3; // chicane
            }
            points.push(new THREE.Vector3(x, 0, z));
        }
    } else if (trackId === 'spa') {
        const numPoints = 18;
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const r = 40 + Math.sin(angle * 2) * 10 + Math.cos(angle * 4) * 4;
            const y = Math.sin(angle * 2) * 5 + Math.cos(angle * 3) * 2; // elevation changes
            points.push(new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r));
        }
    } else if (trackId === 'suzuka') {
        const numPoints = 32;
        for (let i = 0; i < numPoints; i++) {
            const t_param = (i / numPoints) * Math.PI * 2;
            const scale = 40;
            const x = Math.sin(t_param) * scale;
            const z = Math.sin(t_param) * Math.cos(t_param) * scale * 0.8;
            
            // Bridge cross-over height difference
            let y = 0;
            if (t_param > 0 && t_param < Math.PI) {
                y = Math.sin(t_param) * 4.5;
            }
            points.push(new THREE.Vector3(x, y, z));
        }
    } else {
        // Fallback random track
        for (let i = 0; i < 10; i++) {
            points.push(new THREE.Vector3((Math.random() - 0.5) * 60, 0, (Math.random() - 0.5) * 60));
        }
    }
    return points;
}

// Find track group inside Three.js scene
function findTrackGroup(): THREE.Group | null {
    for (const child of scene.children) {
        if (child instanceof THREE.Group && child !== activeCarInstance?.mesh) {
            const hasLines = child.children.some(c => c instanceof THREE.Line);
            if (hasLines) {
                return child as THREE.Group;
            }
        }
    }
    return null;
}

// Rebuild track dynamically when active circuit is updated
function rebuildTrack(trackId: string) {
    const points = generateTrackPoints(trackId);
    const newTrack = createTrack(points);
    
    const oldTrackGroup = findTrackGroup();
    if (oldTrackGroup) {
        scene.remove(oldTrackGroup);
    }
    
    scene.add(newTrack.trackGroup);
    activeCurve = newTrack.curve;
    
    // Update render module's curve
    setRenderCurve(newTrack.curve);
    
    // Reset vehicle variables
    distance = 0;
    cte = 0;
    cteIntegral = 0;
    prevCte = 0;
    
    if (activePhysicsInstance) {
        activePhysicsInstance.reset();
    }
    shouldAlignHeading = true;
    
    // Reset lap records UI
    lapNumber = 1;
    lapTime = 0;
    maxSpeedInLap = 0;
    cteSumInLap = 0;
    cteCountInLap = 0;
    prevTForLap = 0;
    
    const tableBody = document.getElementById('lap-records-body');
    if (tableBody) {
        tableBody.innerHTML = `
            <tr class="empty-row">
                <td colspan="4">No lap data recorded yet</td>
            </tr>
        `;
    }
    cteHistory.length = 0;
    console.log(`Dynamic track switch executed: ${trackId}`);
}

// Extract currently selected track from UI state cards
function getActiveTrackFromDOM(): string {
    const activeCard = document.querySelector('.track-card.active');
    return activeCard ? (activeCard as HTMLElement).dataset.track || 'monaco' : 'monaco';
}

// Extract current driving mode configuration from DOM
function getDrivingModeFromDOM(): string {
    const activeBtn = document.querySelector('#driving-mode-group .mode-btn.active');
    return activeBtn ? (activeBtn as HTMLElement).dataset.mode || 'safe' : 'safe';
}

// Render real-time CTE error deviation chart (SVG)
function updateCTEChart(currentCte: number) {
    const chartPlaceholder = document.getElementById('chart-placeholder');
    if (!chartPlaceholder) return;
    
    cteHistory.push(currentCte);
    if (cteHistory.length > 60) {
        cteHistory.shift();
    }
    
    const width = 250;
    const height = 80;
    const centerY = height / 2;
    
    let maxAbsCte = 0.5;
    for (const val of cteHistory) {
        if (Math.abs(val) > maxAbsCte) {
            maxAbsCte = Math.abs(val);
        }
    }
    
    let pathD = '';
    const stepX = width / Math.max(1, cteHistory.length - 1);
    for (let i = 0; i < cteHistory.length; i++) {
        const x = i * stepX;
        const y = centerY - (cteHistory[i] / maxAbsCte) * (height / 2 - 10);
        if (i === 0) {
            pathD += `M ${x} ${y}`;
        } else {
            pathD += ` L ${x} ${y}`;
        }
    }
    
    chartPlaceholder.innerHTML = `
        <div class="chart-inner-placeholder" style="border: none; background: transparent; padding: 0;">
            <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}">
                <path d="M 0 ${centerY} L ${width} ${centerY}" stroke="#27283b" stroke-width="1.5" stroke-dasharray="4,4" />
                <path d="${pathD}" fill="none" stroke="#ff1801" stroke-width="2" />
                <text x="5" y="12" fill="#8892b0" font-size="8" font-family="monospace">CTE Range: ±${maxAbsCte.toFixed(2)}m</text>
            </svg>
        </div>
    `;
}

// Log lap records in HUD panel
function recordCompletedLap(lapNum: number, time: number, maxSpeed: number, avgCte: number) {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    const ms = Math.floor((time * 100) % 100);
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    
    const tableBody = document.getElementById('lap-records-body');
    if (!tableBody) return;
    
    const emptyRow = tableBody.querySelector('.empty-row');
    if (emptyRow) {
        tableBody.removeChild(emptyRow);
    }
    
    const row = document.createElement('tr');
    row.innerHTML = `
        <td>${lapNum}</td>
        <td>${timeStr}</td>
        <td>${maxSpeed.toFixed(1)} km/h</td>
        <td>${avgCte.toFixed(3)} m</td>
    `;
    tableBody.appendChild(row);
}

// Update telemetry status pill (Autonomous / Manual Drive)
function updateStatusPill() {
    const statusPill = document.querySelector('.status-pill');
    if (statusPill) {
        if (isManual) {
            statusPill.textContent = 'MANUAL DRIVE';
            (statusPill as HTMLElement).style.backgroundColor = '#ff9f1c';
            (statusPill as HTMLElement).style.color = '#12131c';
        } else {
            statusPill.textContent = 'AUTONOMOUS';
            (statusPill as HTMLElement).style.backgroundColor = '#00ff88';
            (statusPill as HTMLElement).style.color = '#12131c';
        }
    }
}

// Main initialization function
async function init() {
    const [renderResult] = await Promise.all([setupRender(), appInitialized]);
    if (renderResult) {
        activeCurve = (renderResult as any).track.curve;
        activeCarInstance = (renderResult as any).car;
    }
    shouldAlignHeading = true;
    
    // Set up helper tip in footer
    const footer = document.querySelector('.sidebar-footer');
    if (footer) {
        const tip = document.createElement('p');
        tip.style.color = '#ff9f1c';
        tip.style.fontSize = '0.75rem';
        tip.style.marginTop = '0.6rem';
        tip.style.lineHeight = '1.3';
        tip.innerHTML = '💡 Drive: <b>WASD / Arrow Keys</b> (switches to Manual).<br>Toggle: <b>Space Bar</b> to return to Autonomous PID.';
        footer.appendChild(tip);
    }
    
    // Bind reset action listener
    const resetBtn = document.getElementById('btn-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            distance = 0;
            cte = 0;
            cteIntegral = 0;
            prevCte = 0;
            progressT = 0;
            shouldAlignHeading = true;
            lapNumber = 1;
            lapTime = 0;
            maxSpeedInLap = 0;
            cteSumInLap = 0;
            cteCountInLap = 0;
            prevTForLap = 0;
            cteHistory.length = 0;
            const tableBody = document.getElementById('lap-records-body');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr class="empty-row">
                        <td colspan="4">No lap data recorded yet</td>
                    </tr>
                `;
            }
        });
    }
    const cycleCameraBtn = document.getElementById('btn-cycle-camera');
    if (cycleCameraBtn) {
        cycleCameraBtn.addEventListener('click', () => {
            cycleCamera();
        });
    }
    animate(lastTime);
    console.log("F1 Connection & Orchestration Layer Initialized.");
}

// Loop execution frame
function animate(currentTime: number) {
    requestAnimationFrame(animate);
    let dt = (currentTime - lastTime) / 1000.0;
    lastTime = currentTime;
    
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;

    // Detect circuit change card clicks
    const currentTrack = getActiveTrackFromDOM();
    if (currentTrack !== lastTrack) {
        lastTrack = currentTrack;
        rebuildTrack(currentTrack);
    }

    // Keyboard and user-slider interface syncing
    // @ts-ignore
    const speedSlider = document.getElementById('slider-speed') as HTMLInputElement;
    // @ts-ignore
    const steerSlider = document.getElementById('slider-steering') as HTMLInputElement;

    // Extract raw variables from sliders/modes
    let currentTargetSpeed = speedSlider ? parseInt(speedSlider.value, 10) : 120;
    let currentSteerAngle = steerSlider ? parseFloat(steerSlider.value) : 0;
    const mode = getDrivingModeFromDOM();

    // If manual keys are pressed, update controls
    if (isManual) {
        let steerChanged = false;
        let speedChanged = false;
        
        if (keys['ArrowLeft'] || keys['KeyA']) {
            currentSteerAngle = Math.max(-30, currentSteerAngle - 1.5);
            steerChanged = true;
        } else if (keys['ArrowRight'] || keys['KeyD']) {
            currentSteerAngle = Math.min(30, currentSteerAngle + 1.5);
            steerChanged = true;
        } else {
            // Smoothly auto-center
            if (currentSteerAngle > 0) currentSteerAngle = Math.max(0, currentSteerAngle - 2.0);
            if (currentSteerAngle < 0) currentSteerAngle = Math.min(0, currentSteerAngle + 2.0);
            steerChanged = true;
        }
        
        if (keys['ArrowUp'] || keys['KeyW']) {
            currentTargetSpeed = Math.min(350, currentTargetSpeed + 2);
            speedChanged = true;
        } else if (keys['ArrowDown'] || keys['KeyS']) {
            currentTargetSpeed = Math.max(30, currentTargetSpeed - 3);
            speedChanged = true;
        }
        
        if (steerSlider && steerChanged) {
            steerSlider.value = currentSteerAngle.toString();
            steerSlider.dispatchEvent(new Event('input'));
        }
        if (speedSlider && speedChanged) {
            speedSlider.value = currentTargetSpeed.toString();
            speedSlider.dispatchEvent(new Event('input'));
        }
    }

    // Execute physics module integration
    const state = simulation(dt);

    // Align heading with track tangent on first frame, track switch, or reset
    if (shouldAlignHeading && state && activeCurve) {
        const initialTangent = activeCurve.getTangentAt(0);
        state.heading = Math.atan2(initialTangent.x, initialTangent.z);
        console.log(`[ALIGN HEADING] Aligned vehicle heading to track tangent: ${state.heading.toFixed(4)} rad`);
        shouldAlignHeading = false;
    }

    // Debug logging for the first 20 frames
    if ((window as any).debugFrameCount === undefined) {
        (window as any).debugFrameCount = 0;
    }
    if ((window as any).debugFrameCount < 20) {
        (window as any).debugFrameCount++;
        if (state && activeCurve) {
            const tangent = activeCurve.getTangentAt(progressT);
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
            const carDir = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
            const trackHeading = Math.atan2(tangent.x, tangent.z);
            console.log(`[FRAME ${(window as any).debugFrameCount}] progressT: ${progressT.toFixed(4)}, vx: ${state.vx.toFixed(4)}, heading: ${state.heading.toFixed(4)}, trackHeading: ${trackHeading.toFixed(4)}, carDir: (${carDir.x.toFixed(4)}, ${carDir.z.toFixed(4)}), tangent: (${tangent.x.toFixed(4)}, ${tangent.z.toFixed(4)}), normal: (${normal.x.toFixed(4)}, ${normal.z.toFixed(4)}), dot_tangent: ${carDir.dot(tangent).toFixed(4)}, dot_normal: ${carDir.dot(normal).toFixed(4)}, cte: ${cte.toFixed(4)}`);
        }
    }

    if (state && activeCurve && activeCarInstance) {
        const curveLength = activeCurve.getLength();
        
        // Signed CTE calculations & longitudinal progression
        const tangent = activeCurve.getTangentAt(progressT);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        const carDir = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
        
        const v_long = state.vx * carDir.dot(tangent);
        const v_lat = state.vx * carDir.dot(normal);
        
        distance += v_long * dt;
        cte += v_lat * dt;
        
        // Find closest curve parameter using local optimization
        let estT = (distance / curveLength) % 1.0;
        if (estT < 0) estT += 1.0;
        
        let bestT = estT;
        let minDistanceSq = Infinity;
        const searchPoints = 15;
        const searchRange = 0.01;
        
        const centerPos = activeCurve.getPointAt(estT);
        const physicalPos = centerPos.clone().add(normal.clone().multiplyScalar(cte));
        
        for (let i = -searchPoints; i <= searchPoints; i++) {
            const testT = (estT + (i / searchPoints) * searchRange + 1.0) % 1.0;
            const pt = activeCurve.getPointAt(testT);
            const distSq = pt.distanceToSquared(physicalPos);
            if (distSq < minDistanceSq) {
                minDistanceSq = distSq;
                bestT = testT;
            }
        }
        
        progressT = bestT;
        
        const closestCenter = activeCurve.getPointAt(progressT);
        const closestTangent = activeCurve.getTangentAt(progressT);
        const closestNormal = new THREE.Vector3(-closestTangent.z, 0, closestTangent.x).normalize();
        const errVec = physicalPos.clone().sub(closestCenter);
        cte = errVec.dot(closestNormal);
        
        distance = progressT * curveLength;
        
        // Autonomous PID steering controller execution
        if (!isManual) {
            // Predict path heading 9 meters ahead
            const lookaheadDist = 9.0;
            const lookaheadStep = lookaheadDist / curveLength;
            const t_lookahead = (progressT + lookaheadStep) % 1.0;
            const pos_lookahead = activeCurve.getPointAt(t_lookahead);
            
            const targetVec = pos_lookahead.clone().sub(physicalPos).normalize();
            const targetAngle = Math.atan2(targetVec.x, targetVec.z);
            
            let angleError = targetAngle - state.heading;
            while (angleError > Math.PI) angleError -= 2 * Math.PI;
            while (angleError < -Math.PI) angleError += 2 * Math.PI;
            
            cteIntegral += cte * dt;
            cteIntegral = Math.max(-10, Math.min(10, cteIntegral));
            const cteDerivative = (cte - prevCte) / dt;
            prevCte = cte;
            
            // Extract PID steering parameters
            const customToggle = document.getElementById('custom-settings-toggle') as HTMLInputElement;
            let Kp = 400.0, Ki = 10.0, Kd = 5.0;
            if (customToggle && customToggle.checked) {
                const kpInput = document.getElementById('input-kp') as HTMLInputElement;
                const kiInput = document.getElementById('input-ki') as HTMLInputElement;
                const kdInput = document.getElementById('input-kd') as HTMLInputElement;
                if (kpInput) Kp = parseFloat(kpInput.value);
                if (kiInput) Ki = parseFloat(kiInput.value);
                if (kdInput) Kd = parseFloat(kdInput.value);
            } else {
                if (mode === 'safe') {
                    Kp = 250; Ki = 5; Kd = 12;
                } else if (mode === 'stable') {
                    Kp = 400; Ki = 10; Kd = 5;
                } else if (mode === 'fast') {
                    Kp = 650; Ki = 15; Kd = 2;
                }
            }
            
            const steerPID = (Kp / 12000) * cte + (Ki / 45000) * cteIntegral + (Kd / 200) * cteDerivative;
            let targetSteeringRad = angleError * 0.85 - steerPID;
            let targetSteeringDeg = targetSteeringRad * (180.0 / Math.PI);
            
            currentSteerAngle = Math.max(-30, Math.min(30, targetSteeringDeg));
            if (steerSlider) {
                steerSlider.value = currentSteerAngle.toString();
                steerSlider.dispatchEvent(new Event('input'));
            }
        }
        
        // Execute graphics rendering loop
        runRender(progressT);
        
        // Override car position and orientation using physical state vector
        const finalPosition = closestCenter.clone().add(closestNormal.clone().multiplyScalar(cte));
        activeCarInstance.mesh.position.copy(finalPosition);
        
        // Tilting along track slope pitch (3D)
        const cos_pitch = Math.sqrt(1 - closestTangent.y * closestTangent.y);
        const carHeading3D = new THREE.Vector3(
            Math.sin(state.heading) * cos_pitch,
            closestTangent.y,
            Math.cos(state.heading) * cos_pitch
        );
        activeCarInstance.mesh.lookAt(finalPosition.clone().add(carHeading3D));
        
        // Rollover visual representation
        if (state.isFlipped) {
            activeCarInstance.mesh.rotation.z = Math.PI; // Flip upside down!
        }
        
        // Lap timing and metrics tracking
        lapTime += dt;
        if (state.vx * 3.6 > maxSpeedInLap) {
            maxSpeedInLap = state.vx * 3.6;
        }
        cteSumInLap += Math.abs(cte);
        cteCountInLap++;
        
        // Detect lap wrap-around
        if (prevTForLap > 0.85 && progressT < 0.15) {
            const avgCte = cteCountInLap > 0 ? (cteSumInLap / cteCountInLap) : 0;
            recordCompletedLap(lapNumber, lapTime, maxSpeedInLap, avgCte);
            
            lapNumber++;
            lapTime = 0;
            maxSpeedInLap = 0;
            cteSumInLap = 0;
            cteCountInLap = 0;
        }
        prevTForLap = progressT;
        
        // Update live HUD components
        const telCte = document.getElementById('tel-cte');
        if (telCte) {
            telCte.innerHTML = `${cte.toFixed(3)} <span class="unit">m</span>`;
        }
        
        updateLapTimeHUD(lapTime);
        updateCTEChart(cte);
    }
    
    updateStatusPill();
}

function updateLapTimeHUD(time: number) {
    const telTime = document.getElementById('tel-time');
    if (telTime) {
        const mins = Math.floor(time / 60);
        const secs = Math.floor(time % 60);
        const ms = Math.floor((time * 100) % 100);
        telTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
}

// Bind keyboard listeners
window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS'].includes(e.code)) {
        isManual = true;
    }
    if (e.code === 'Space') {
        e.preventDefault();
        isManual = !isManual;
        // Reset manual steering on return to PID
        if (!isManual) {
            cteIntegral = 0;
        }
    }
    keys[e.code] = true;
    updateStatusPill();
});

window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
});

init();
