import * as THREE from 'three';
import { Car } from './visual/car';
import { createTrack } from './visual/track';
import { scene } from './visual/scene';
import { optimizeTrajectory, generateSpeedProfile } from './optimizer/client-optimizer';

export interface TelemetryPoint {
    pointIndex: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    curvature: number;
}

export interface OptimizedPoint {
    pointIndex: number;
    x: number;
    y: number;
    z: number;
    targetSpeed: number;
}

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
    update(controlsInput: any, dt: number) {
        if (isOptimizerMode && optimizedSpeeds && optimizedSpeeds.length > 0) {
            const idx = Math.max(0, Math.min(optimizedSpeeds.length - 1, Math.floor(progressT * (optimizedSpeeds.length - 1))));
            controlsInput.targetSpeed = optimizedSpeeds[idx];
        }
        return super.update(controlsInput, dt);
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
let baselineCurve: THREE.CatmullRomCurve3 | null = null;
let optimizedCurve: THREE.CatmullRomCurve3 | null = null;

// AI Optimizer Mode state
let simState: any = null;
let isOptimizerMode = false;
let optimizedSpeeds: number[] | null = null;

interface PointTelemetry {
    pointIndex: number;
    x: number;
    z: number;
    actualSpeed: number;
    lateralG: number;
    tireSlip: number;
    lapNumber: number;
}

let lapTelemetry: PointTelemetry[] = [];
let isCalibrating = false;

const state = {
    get lapTelemetry() { return lapTelemetry; },
    set lapTelemetry(val) { lapTelemetry = val; },
    get isProcessingLap() { return isCalibrating; },
    set isProcessingLap(val) { isCalibrating = val; },
    get optimizedCurve() {
        if (!optimizedCurve) return { length: 0 } as any;
        (optimizedCurve as any).length = optimizedCurve.points.length;
        return optimizedCurve;
    },
    set optimizedCurve(val) { optimizedCurve = val; },
    get optimizedSpeeds() { return optimizedSpeeds; },
    set optimizedSpeeds(val) { optimizedSpeeds = val; },
    get currentLapNumber() { return lapNumber; },
    set currentLapNumber(val) { lapNumber = val; },
    isFlipped: false,
    currentPointIndex: 0,
    hasTraversed: false,
    hasTriggeredLapEnd: false,
    carVelocity: 0
};

function initLapTelemetry(N: number) {
    lapTelemetry = [];
    for (let i = 0; i < N; i++) {
        lapTelemetry.push({
            pointIndex: i,
            x: 0,
            z: 0,
            actualSpeed: 0,
            lateralG: 0,
            tireSlip: 0,
            lapNumber: lapNumber
        });
    }
}

// Tyre pressure and temperature simulation states
const wheelTemps = { fl: 35, fr: 35, rl: 35, rr: 35 };
const wheelPressures = { fl: 1.40, fr: 1.40, rl: 1.40, rr: 1.40 }; // bar
const pressureHistory: { fl: number; fr: number; rl: number; rr: number; }[] = [];

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
    
    // Scale up the entire track layout geometry (1.66x scale horizontally, 1.0x vertically)
    const scaleFactor = 1.66;
    points.forEach(p => {
        p.x *= scaleFactor;
        p.z *= scaleFactor;
        p.y *= 1.0;
    });
    
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
    
    optimizedSpeeds = null;
    
    const oldTrackGroup = findTrackGroup();
    if (oldTrackGroup) {
        scene.remove(oldTrackGroup);
    }
    
    scene.add(newTrack.trackGroup);
    baselineCurve = newTrack.curve;
    optimizedCurve = null;
    if (isOptimizerMode && optimizedCurve) {
        activeCurve = optimizedCurve;
        setRenderCurve(optimizedCurve);
    } else {
        activeCurve = baselineCurve;
        setRenderCurve(baselineCurve);
    }
    
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
    const statusPill = document.getElementById('drive-status-pill');
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

    // View switching navigation handlers
    const navVisualizer = document.getElementById('visualizer-tab');
    const navOptimizer = document.getElementById('optimizer-tab');
    const appEl = document.getElementById('app');

    const setSidebarManualControlsLocked = (locked: boolean) => {
        const speedInput = document.getElementById('slider-speed') as HTMLInputElement;
        const steeringInput = document.getElementById('slider-steering') as HTMLInputElement;
        if (speedInput) speedInput.disabled = locked;
        if (steeringInput) steeringInput.disabled = locked;
    };

    if (navVisualizer && navOptimizer && appEl) {
        navVisualizer.addEventListener('click', (e) => {
            e.preventDefault();
            navOptimizer.classList.remove('active');
            navVisualizer.classList.add('active');
            
            appEl.setAttribute('data-view', 'visualizer');
            isOptimizerMode = false;
            setSidebarManualControlsLocked(false);
            
            lapTelemetry = [];
            
            if (baselineCurve) {
                activeCurve = baselineCurve;
                setRenderCurve(baselineCurve);
            }
            
            if (activePhysicsInstance) {
                activePhysicsInstance.reset();
            }
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
            state.currentPointIndex = 0;
            state.hasTraversed = false;
        });

        navOptimizer.addEventListener('click', (e) => {
            e.preventDefault();
            navVisualizer.classList.remove('active');
            navOptimizer.classList.add('active');
            
            appEl.setAttribute('data-view', 'optimizer');
            isOptimizerMode = true;
            setSidebarManualControlsLocked(true);
            
            if (activePhysicsInstance) {
                activePhysicsInstance.reset();
            }
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
            state.currentPointIndex = 0;
            state.hasTraversed = false;
 
            const currentTrack = getActiveTrackFromDOM();
            const centerline = generateTrackPoints(currentTrack);
            const payload = {
                trackId: currentTrack,
                lap_number: 1,
                car_coordinates: centerline.map(p => ({ x: p.x, z: p.z })),
                velocity_profile: centerline.map(() => 0),
                timestamp: new Date().toISOString()
            };

            fetch('http://localhost:3001/api/optimize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => {
                if (data && data.success && data.points) {
                    const optProfile: OptimizedPoint[] = data.points;
                    const optPoints = optProfile.map(p => new THREE.Vector3(p.x, p.y, p.z));
                    const speedProfile = optProfile.map(p => p.targetSpeed);

                    const newTrack = createTrack(optPoints);
                    optimizedCurve = newTrack.curve;
                    activeCurve = optimizedCurve;
                    setRenderCurve(optimizedCurve);

                    for (const child of scene.children) {
                        if (child instanceof THREE.Group && child !== activeCarInstance?.mesh) {
                            const hasLines = child.children.some(c => c instanceof THREE.Line);
                            if (hasLines) {
                                scene.remove(child);
                                break;
                            }
                        }
                    }
                    scene.add(newTrack.trackGroup);

                    optimizedSpeeds = speedProfile;
                    initLapTelemetry(optimizedSpeeds.length);
                    console.log("[TAB SWITCH] Reloaded latest profile from backend.");
                }
            })
            .catch(err => {
                console.error("[TAB SWITCH] Failed to reload profile from backend:", err);
                const optPointsLocal = optimizeTrajectory(centerline, 1.0, 0.20, 600, 0.02);
                const frictionSlider = document.getElementById('slider-friction') as HTMLInputElement;
                const tireFriction = frictionSlider ? parseFloat(frictionSlider.value) : 0.80;
                optimizedSpeeds = generateSpeedProfile(optPointsLocal, tireFriction, 320, 8.5, 22.0);
                
                const newTrack = createTrack(optPointsLocal);
                optimizedCurve = newTrack.curve;
                activeCurve = optimizedCurve;
                setRenderCurve(optimizedCurve);
                initLapTelemetry(optimizedSpeeds.length);
            });
            
            setTimeout(drawTyrePressureChart, 50);
        });
    }

    // Optimization execution listener
    const btnRunOpt = document.getElementById('btn-run-optimization');
    const optStatusPill = document.getElementById('opt-status-pill');

    if (btnRunOpt) {
        btnRunOpt.addEventListener('click', async () => {
            if (optStatusPill) {
                optStatusPill.textContent = 'OPTIMIZING...';
                optStatusPill.style.backgroundColor = '#ff9f1c';
                optStatusPill.style.color = '#12131c';
            }

            setTimeout(async () => {
                try {
                    const currentTrack = getActiveTrackFromDOM();
                    const centerline = generateTrackPoints(currentTrack);
                    


                    let optPoints: THREE.Vector3[] = [];
                    let speedProfile: number[] = [];
                    let useBackend = false;

                    try {
                        const payload = {
                            trackId: currentTrack,
                            lap_number: 1,
                            car_coordinates: centerline.map(p => ({ x: p.x, z: p.z })),
                            velocity_profile: centerline.map(() => 0),
                            timestamp: new Date().toISOString()
                        };
                        console.log("[DISPATCH] Dispatching telemetry payload to backend:", payload);
                        console.log("Sending payload to backend...");

                        // 1. Send exploratory centerline lap telemetry to database
                        const telResponse = await fetch('http://localhost:3001/api/telemetry', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        if (!telResponse.ok) {
                            throw new Error(`Telemetry POST failed with HTTP status ${telResponse.status}`);
                        }

                        // 2. Fetch optimized trajectory and speed profile from API
                        console.log('[API BRIDGE] Fetching optimized race profile from database server...');
                        const response = await fetch('http://localhost:3001/api/optimize', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        if (!response.ok) {
                            throw new Error(`Optimization POST failed with HTTP status ${response.status}`);
                        }
                        const data = await response.json();
                        
                        if (data && data.success && data.points) {
                            console.log("SUCCESS: Track profiles written to PostgreSQL:", data);
                            console.log("SUCCESS: Optimization data saved to PostgreSQL!", data);
                            const optProfile: OptimizedPoint[] = data.points;
                            optPoints = optProfile.map(p => new THREE.Vector3(p.x, p.y, p.z));
                            speedProfile = optProfile.map(p => p.targetSpeed);
                            useBackend = true;
                        }
                    } catch (connectionError: any) {
                        console.error("FAIL: Server/DB unreachable. RAM Fallback active. Error:", connectionError);
                    }

                    if (!useBackend) {
                        // Local RAM Fallback: Run the pure client-side mathematical array operations in local RAM
                        console.log('[RAM FALLBACK] Running local Elastic Line path optimizer and velocity profiling.');
                        const optPointsLocal = optimizeTrajectory(centerline, 1.0, 0.20, 600, 0.02);
                        
                        const frictionSlider = document.getElementById('slider-friction') as HTMLInputElement;
                        const tireFriction = frictionSlider ? parseFloat(frictionSlider.value) : 0.80;
                        
                        speedProfile = generateSpeedProfile(optPointsLocal, tireFriction, 320, 8.5, 22.0);
                        optPoints = optPointsLocal.map(p => new THREE.Vector3(p.x, p.y, p.z));
                    }

                    const newTrack = createTrack(optPoints);
                    optimizedCurve = newTrack.curve;
                    
                    activeCurve = optimizedCurve;
                    setRenderCurve(optimizedCurve);
                    
                    for (const child of scene.children) {
                        if (child instanceof THREE.Group && child !== activeCarInstance?.mesh) {
                            const hasLines = child.children.some(c => c instanceof THREE.Line);
                            if (hasLines) {
                                scene.remove(child);
                                break;
                            }
                        }
                    }
                    scene.add(newTrack.trackGroup);

                    optimizedSpeeds = speedProfile;

                    if (optStatusPill) {
                        optStatusPill.textContent = 'ACTIVE';
                        optStatusPill.style.backgroundColor = '#00ff88';
                        optStatusPill.style.color = '#12131c';
                    }
                    
                    console.log(`[OPTIMIZATION COMPLETE] Swapped tracking spline for ${currentTrack}. Total optimized speed profile points: ${optimizedSpeeds.length}`);
                } catch (err) {
                    console.error('[OPTIMIZATION FAILED]', err);
                    if (optStatusPill) {
                        optStatusPill.textContent = 'FAILED';
                        optStatusPill.style.backgroundColor = '#ff1801';
                        optStatusPill.style.color = '#fff';
                    }
                }
            }, 100);
        });
    }

    animate(lastTime);
    console.log("F1 Connection & Orchestration Layer Initialized.");
}
// Trigger calibration API and process optimization feedback
function triggerCalibration(wasCrash?: boolean) {
    if (wasCrash) {
        console.log("[CALIBRATION] Crash recovery initiated.");
    }
    state.isProcessingLap = true;

    const overlay = document.getElementById('calibration-overlay');
    const overlayMsg = document.getElementById('calibration-overlay-message');
    if (overlay && overlayMsg) {
        overlayMsg.textContent = "Calibrating Lap " + state.currentLapNumber + "... Optimizing Weights";
        overlay.classList.remove('calibration-hidden');
    }

    state.carVelocity = 0;
    if (activePhysicsInstance && activePhysicsInstance.state) {
        activePhysicsInstance.state.vx = 0;
    }

    const currentTrack = getActiveTrackFromDOM();
    const payload = {
        trackId: currentTrack,
        lap_number: state.currentLapNumber,
        lapNumber: state.currentLapNumber,
        telemetry: state.lapTelemetry,
        lapTime: lapTime,
        wasCrash: !!wasCrash
    };

    setTimeout(() => {
        fetch('http://localhost:3001/api/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (data && data.success && data.points) {
                const optProfile: OptimizedPoint[] = data.points;
                const optPoints = optProfile.map(p => new THREE.Vector3(p.x, p.y, p.z));
                const speedProfile = optProfile.map(p => p.targetSpeed);

                const newTrack = createTrack(optPoints);
                state.optimizedCurve = newTrack.curve;
                activeCurve = state.optimizedCurve;
                setRenderCurve(state.optimizedCurve);

                for (const child of scene.children) {
                    if (child instanceof THREE.Group && child !== activeCarInstance?.mesh) {
                        const hasLines = child.children.some(c => c instanceof THREE.Line);
                        if (hasLines) {
                            scene.remove(child);
                            break;
                        }
                    }
                }
                scene.add(newTrack.trackGroup);

                state.optimizedSpeeds = speedProfile;
                state.isFlipped = false;
                if (simState) {
                    simState.isFlipped = false;
                }
                state.carVelocity = 0;
                if (activePhysicsInstance && activePhysicsInstance.state) {
                    activePhysicsInstance.state.vx = 0;
                }
                state.currentPointIndex = 0;
                if (activeCarInstance && activeCarInstance.mesh) {
                    activeCarInstance.mesh.rotation.set(0, 0, 0);
                    activeCarInstance.mesh.quaternion.set(0, 0, 0, 1);
                }
                console.log(`[CALIBRATION COMPLETE] Lap ${state.currentLapNumber} completed. Calibrated profile loaded.`);
            }

            if (activePhysicsInstance) {
                activePhysicsInstance.reset();
            }
            distance = 0;
            cte = 0;
            cteIntegral = 0;
            prevCte = 0;
            progressT = 0;
            shouldAlignHeading = true;
            prevTForLap = 0;
            state.currentPointIndex = 0;
            state.hasTraversed = false;

            const avgCte = cteCountInLap > 0 ? (cteSumInLap / cteCountInLap) : 0;
            recordCompletedLap(state.currentLapNumber, lapTime, maxSpeedInLap, avgCte);

            state.currentLapNumber = data.nextLap !== undefined ? data.nextLap : (state.currentLapNumber + 1);
            lapTime = 0;
            maxSpeedInLap = 0;
            cteSumInLap = 0;
            cteCountInLap = 0;

            const nextN = state.optimizedSpeeds ? state.optimizedSpeeds.length : generateTrackPoints(getActiveTrackFromDOM()).length;
            initLapTelemetry(nextN);

            if (overlay) {
                overlay.classList.add('calibration-hidden');
            }
            state.isProcessingLap = false;
        })
        .catch(err => {
            console.error('[CALIBRATION FAILED] Error:', err);
            if (activePhysicsInstance) {
                activePhysicsInstance.reset();
            }
            distance = 0;
            cte = 0;
            cteIntegral = 0;
            prevCte = 0;
            progressT = 0;
            shouldAlignHeading = true;
            prevTForLap = 0;
            state.currentPointIndex = 0;
            state.hasTraversed = false;
            if (overlay) {
                overlay.classList.add('calibration-hidden');
            }
            state.isProcessingLap = false;
        });
    }, 1000);
}

// Loop execution frame
function animate(currentTime: number) {
    requestAnimationFrame(animate);
    if (state.isProcessingLap) {
        lastTime = currentTime;
        return;
    }
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
    if (optimizedSpeeds && optimizedSpeeds.length > 0 && !isManual) {
        const idx = Math.floor(progressT * (optimizedSpeeds.length - 1));
        const targetMPerS = optimizedSpeeds[Math.max(0, Math.min(optimizedSpeeds.length - 1, idx))];
        currentTargetSpeed = targetMPerS * 3.6; // convert back to km/h for the physics engine
    }
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
    simState = simulation(dt);
    if (simState) {
        state.isFlipped = simState.isFlipped;
    }

    // Align heading with track tangent on first frame, track switch, or reset
    if (shouldAlignHeading && simState && activeCurve) {
        const initialTangent = activeCurve.getTangentAt(0);
        simState.heading = Math.atan2(initialTangent.x, initialTangent.z);
        console.log(`[ALIGN HEADING] Aligned vehicle heading to track tangent: ${simState.heading.toFixed(4)} rad`);
        shouldAlignHeading = false;
    }

    // Debug logging for the first 20 frames
    if ((window as any).debugFrameCount === undefined) {
        (window as any).debugFrameCount = 0;
    }
    if ((window as any).debugFrameCount < 20) {
        (window as any).debugFrameCount++;
        if (simState && activeCurve) {
            const tangent = activeCurve.getTangentAt(progressT);
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
            const carDir = new THREE.Vector3(Math.sin(simState.heading), 0, Math.cos(simState.heading));
            const trackHeading = Math.atan2(tangent.x, tangent.z);
            console.log(`[FRAME ${(window as any).debugFrameCount}] progressT: ${progressT.toFixed(4)}, vx: ${simState.vx.toFixed(4)}, heading: ${simState.heading.toFixed(4)}, trackHeading: ${trackHeading.toFixed(4)}, carDir: (${carDir.x.toFixed(4)}, ${carDir.z.toFixed(4)}), tangent: (${tangent.x.toFixed(4)}, ${tangent.z.toFixed(4)}), normal: (${normal.x.toFixed(4)}, ${normal.z.toFixed(4)}), dot_tangent: ${carDir.dot(tangent).toFixed(4)}, dot_normal: ${carDir.dot(normal).toFixed(4)}, cte: ${cte.toFixed(4)}`);
        }
    }

    if (simState && activeCurve && activeCarInstance) {
        const curveLength = activeCurve.getLength();
        
        // Signed CTE calculations & longitudinal progression
        const tangent = activeCurve.getTangentAt(progressT);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        const carDir = new THREE.Vector3(Math.sin(simState.heading), 0, Math.cos(simState.heading));
        
        const v_long = simState.vx * carDir.dot(tangent);
        const v_lat = simState.vx * carDir.dot(normal);
        
        distance += v_long * dt;
        cte += v_lat * dt;
        
        // Find closest curve parameter using local optimization (optimized: 5 search points instead of 15)
        let estT = (distance / curveLength) % 1.0;
        if (estT < 0) estT += 1.0;
        
        let bestT = estT;
        let minDistanceSq = Infinity;
        const searchPoints = 5;
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
        
        if (!isManual) {
            // Predict path heading 15.0 meters ahead (1.66x scaled up from 9m)
            const lookaheadDist = 15.0;
            const lookaheadStep = lookaheadDist / curveLength;
            const t_lookahead = (progressT + lookaheadStep) % 1.0;
            const pos_lookahead = activeCurve.getPointAt(t_lookahead);
            
            const targetVec = pos_lookahead.clone().sub(physicalPos).normalize();
            const targetAngle = Math.atan2(targetVec.x, targetVec.z);
            
            let angleError = targetAngle - simState.heading;
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
        
        // Always execute graphics rendering loop (so 3D viewport stays updated and active)
        runRender(progressT, closestCenter, closestTangent);
        
        if (isOptimizerMode) {
            // Update the dedicated UI static telemetry optimizer dashboard
            updateOptimizerDashboard(simState, dt);
        }
        
        // Override car position and orientation using physical state vector
        const finalPosition = closestCenter.clone().add(closestNormal.clone().multiplyScalar(cte));
        activeCarInstance.mesh.position.copy(finalPosition);
        
        // Tilting along track slope pitch (3D)
        const cos_pitch = Math.sqrt(1 - closestTangent.y * closestTangent.y);
        const carHeading3D = new THREE.Vector3(
            Math.sin(simState.heading) * cos_pitch,
            closestTangent.y,
            Math.cos(simState.heading) * cos_pitch
        );
        activeCarInstance.mesh.lookAt(finalPosition.clone().add(carHeading3D));
        
        // Rollover visual representation
        if (state.isFlipped) {
            activeCarInstance.mesh.rotation.z = Math.PI; // Flip upside down!
        }
        
        // Lap timing and metrics tracking
        lapTime += dt;
        if (simState.vx * 3.6 > maxSpeedInLap) {
            maxSpeedInLap = simState.vx * 3.6;
        }
        cteSumInLap += Math.abs(cte);
        cteCountInLap++;
        
        if (isOptimizerMode) {
            const N_points = state.optimizedSpeeds ? state.optimizedSpeeds.length : generateTrackPoints(getActiveTrackFromDOM()).length;
            if (state.lapTelemetry.length !== N_points) {
                initLapTelemetry(N_points);
            }

            let closestIdx = 0;
            let minDSq = Infinity;
            if (activeCurve && activeCarInstance) {
                const pts = activeCurve.getPoints(N_points - 1);
                for (let i = 0; i < pts.length; i++) {
                    const dSq = pts[i].distanceToSquared(activeCarInstance.mesh.position);
                    if (dSq < minDSq) {
                        minDSq = dSq;
                        closestIdx = i;
                    }
                }
            }
            const idx = closestIdx;
            const prevPointIndex = state.currentPointIndex;
            state.currentPointIndex = idx;

            const pt = activeCurve ? activeCurve.getPointAt(idx / (N_points - 1)) : new THREE.Vector3();
            state.lapTelemetry[idx].x = pt.x;
            state.lapTelemetry[idx].z = pt.z;
            if (state.isFlipped) {
                state.lapTelemetry[idx].actualSpeed = 0;
                state.lapTelemetry[idx].lateralG = 5.0;
                state.lapTelemetry[idx].tireSlip = 1.0;
            } else {
                state.lapTelemetry[idx].actualSpeed = Math.max(state.lapTelemetry[idx].actualSpeed, simState.vx);
                const steeringAngle = activePhysicsInstance?.state?.steeringAngle || 0.0;
                const turnRadius = 2.662 / Math.max(0.0001, Math.abs(steeringAngle));
                const ay = (simState.vx * simState.vx) / turnRadius;
                const currentLateralG = ay / 9.81;
                state.lapTelemetry[idx].lateralG = Math.max(state.lapTelemetry[idx].lateralG, currentLateralG);
                const currentSlip = Math.max(Math.abs(simState.sLeft || 0), Math.abs(simState.sRight || 0));
                state.lapTelemetry[idx].tireSlip = Math.max(state.lapTelemetry[idx].tireSlip, currentSlip);
            }
            state.lapTelemetry[idx].lapNumber = lapNumber;

            if (state.currentPointIndex > N_points * 0.3 && state.currentPointIndex < N_points * 0.7) {
                state.hasTraversed = true;
            }

            const isFinishLine = idx === 0 && prevPointIndex === state.optimizedCurve.length - 1 && state.hasTraversed;
            if ((isFinishLine || state.isFlipped) && !state.isProcessingLap) {
                state.isProcessingLap = true; // Set lock first
                const wasCrash = state.isFlipped;
                state.isFlipped = false; // IMMEDIATELY clear the flag to prevent double execution
                if (simState) simState.isFlipped = false;
                triggerCalibration(wasCrash);
            }
            // Reset the finish line lock once the car leaves the starting zone
            if (idx > 2) {
                state.hasTriggeredLapEnd = false;
            }
        }

        // Detect lap wrap-around or rollover crash
        if (!isOptimizerMode && (prevTForLap > 0.85 && progressT < 0.15)) {
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



function updateOptimizerDashboard(state: any, dt: number) {
    // 1. Text telemetry updates
    const speedKmh = state.vx * 3.6;
    const optTelSpeed = document.getElementById('opt-tel-speed');
    if (optTelSpeed) {
        optTelSpeed.innerHTML = `${speedKmh.toFixed(1)} <span style="font-size: 0.9rem; color: var(--text-light);">km/h</span>`;
    }
    
    const optTelTime = document.getElementById('opt-tel-time');
    if (optTelTime) {
        const mins = Math.floor(lapTime / 60);
        const secs = Math.floor(lapTime % 60);
        const ms = Math.floor((lapTime * 100) % 100);
        optTelTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }

    const optTelDistance = document.getElementById('opt-tel-distance');
    if (optTelDistance) {
        optTelDistance.innerHTML = `${distance.toFixed(1)} <span style="font-size: 0.9rem; color: var(--text-light);">m</span>`;
    }

    // 2. Tyre Pressure & Temperature Simulation
    // Model turning radius from active steering angle
    const steeringAngle = activePhysicsInstance?.state?.steeringAngle || 0.0;
    const turnRadius = 2.662 / Math.max(0.0001, Math.abs(steeringAngle));
    const ay = (state.vx * state.vx) / turnRadius;
    const ax = activePhysicsInstance ? (state.vx - (activePhysicsInstance as any).prevSpeedError) / dt : 0.0;
    
    // Tire load calculation
    const baseLoad = (1300 * 9.81) / 4.0;
    const weightTransferLat = (1300 * ay * 0.3) / 1.4375;
    const weightTransferLong = (1300 * ax * 0.3) / 2.662;

    const loadFL = Math.max(100, baseLoad - 0.5 * weightTransferLat - 0.5 * weightTransferLong);
    const loadFR = Math.max(100, baseLoad + 0.5 * weightTransferLat - 0.5 * weightTransferLong);
    const loadRL = Math.max(100, baseLoad - 0.5 * weightTransferLat + 0.5 * weightTransferLong);
    const loadRR = Math.max(100, baseLoad + 0.5 * weightTransferLat + 0.5 * weightTransferLong);

    // Friction heat generation (slip power loss proxy)
    const slipL = Math.abs(state.sLeft || 0.0);
    const slipR = Math.abs(state.sRight || 0.0);

    const qFL = loadFL * 0.000025 * Math.abs(state.yawRate || 0.0);
    const qFR = loadFR * 0.000025 * Math.abs(state.yawRate || 0.0);
    const qRL = loadRL * 0.000025 * slipL;
    const qRR = loadRR * 0.000025 * slipR;

    const tempSlider = document.getElementById('slider-temperature') as HTMLInputElement;
    const trackTemp = tempSlider ? parseFloat(tempSlider.value) : 35;
    const coolingRate = 0.45;

    // Update wheel temperatures
    wheelTemps.fl += (qFL - coolingRate * (wheelTemps.fl - trackTemp)) * dt;
    wheelTemps.fr += (qFR - coolingRate * (wheelTemps.fr - trackTemp)) * dt;
    wheelTemps.rl += (qRL - coolingRate * (wheelTemps.rl - trackTemp)) * dt;
    wheelTemps.rr += (qRR - coolingRate * (wheelTemps.rr - trackTemp)) * dt;

    // Clamp wheel temperatures to realistic range
    wheelTemps.fl = Math.max(trackTemp, Math.min(140, wheelTemps.fl));
    wheelTemps.fr = Math.max(trackTemp, Math.min(140, wheelTemps.fr));
    wheelTemps.rl = Math.max(trackTemp, Math.min(140, wheelTemps.rl));
    wheelTemps.rr = Math.max(trackTemp, Math.min(140, wheelTemps.rr));

    // Update wheel pressures (cold bar baseline + temperature scaling)
    wheelPressures.fl = 1.40 + 0.0035 * (wheelTemps.fl - trackTemp);
    wheelPressures.fr = 1.40 + 0.0035 * (wheelTemps.fr - trackTemp);
    wheelPressures.rl = 1.40 + 0.0035 * (wheelTemps.rl - trackTemp);
    wheelPressures.rr = 1.40 + 0.0035 * (wheelTemps.rr - trackTemp);

    const psiFL = wheelPressures.fl * 14.5038;
    const psiFR = wheelPressures.fr * 14.5038;
    const psiRL = wheelPressures.rl * 14.5038;
    const psiRR = wheelPressures.rr * 14.5038;

    // Update DOM labels
    const optFL = document.getElementById('opt-tyre-fl');
    const optFR = document.getElementById('opt-tyre-fr');
    const optRL = document.getElementById('opt-tyre-rl');
    const optRR = document.getElementById('opt-tyre-rr');

    if (optFL) optFL.innerHTML = `${wheelPressures.fl.toFixed(2)} <span style="font-size: 0.8rem; color: var(--text-light);">bar</span> <span style="font-size: 0.8rem; color: var(--text-muted);">(${psiFL.toFixed(1)} PSI)</span>`;
    if (optFR) optFR.innerHTML = `${wheelPressures.fr.toFixed(2)} <span style="font-size: 0.8rem; color: var(--text-light);">bar</span> <span style="font-size: 0.8rem; color: var(--text-muted);">(${psiFR.toFixed(1)} PSI)</span>`;
    if (optRL) optRL.innerHTML = `${wheelPressures.rl.toFixed(2)} <span style="font-size: 0.8rem; color: var(--text-light);">bar</span> <span style="font-size: 0.8rem; color: var(--text-muted);">(${psiRL.toFixed(1)} PSI)</span>`;
    if (optRR) optRR.innerHTML = `${wheelPressures.rr.toFixed(2)} <span style="font-size: 0.8rem; color: var(--text-light);">bar</span> <span style="font-size: 0.8rem; color: var(--text-muted);">(${psiRR.toFixed(1)} PSI)</span>`;

    const optTempFL = document.getElementById('opt-temp-fl');
    const optTempFR = document.getElementById('opt-temp-fr');
    const optTempRL = document.getElementById('opt-temp-rl');
    const optTempRR = document.getElementById('opt-temp-rr');

    if (optTempFL) optTempFL.textContent = `${wheelTemps.fl.toFixed(1)} °C`;
    if (optTempFR) optTempFR.textContent = `${wheelTemps.fr.toFixed(1)} °C`;
    if (optTempRL) optTempRL.textContent = `${wheelTemps.rl.toFixed(1)} °C`;
    if (optTempRR) optTempRR.textContent = `${wheelTemps.rr.toFixed(1)} °C`;

    // Add to pressure timeline history
    pressureHistory.push({ fl: psiFL, fr: psiFR, rl: psiRL, rr: psiRR });
    if (pressureHistory.length > 100) {
        pressureHistory.shift();
    }

    drawTyrePressureChart();
}

function drawTyrePressureChart() {
    const canvas = document.getElementById('tyre-pressure-chart') as HTMLCanvasElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    const w = canvas.width;
    const h = canvas.height;

    // Clear background
    ctx.fillStyle = '#171821'; // matching var(--bg-card)
    ctx.fillRect(0, 0, w, h);

    const padL = 35;
    const padR = 15;
    const padT = 30;
    const padB = 20;

    const graphW = w - padL - padR;
    const graphH = h - padT - padB;

    // Grid lines & labels
    ctx.strokeStyle = '#27283b';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#8892b0';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const minPsi = 19.5;
    const maxPsi = 22.5;

    const getY = (val: number) => {
        const pct = (val - minPsi) / (maxPsi - minPsi);
        return h - padB - pct * graphH;
    };

    const getX = (idx: number) => {
        return padL + (idx / 99) * graphW;
    };

    // Draw Y ticks
    for (let i = 0; i <= 3; i++) {
        const val = minPsi + (i / 3) * (maxPsi - minPsi);
        const y = getY(val);
        
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();

        ctx.fillText(`${val.toFixed(1)}`, padL - 6, y);
    }

    if (pressureHistory.length < 2) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '11px var(--font-body)';
        ctx.fillStyle = '#8892b0';
        ctx.fillText('WAITING FOR TELEMETRY DATA...', w / 2, h / 2);
        return;
    }

    const wheels = [
        { key: 'fl', color: '#ff1801', name: 'FL' },
        { key: 'fr', color: '#00ff88', name: 'FR' },
        { key: 'rl', color: '#00e5ff', name: 'RL' },
        { key: 'rr', color: '#ffeb3b', name: 'RR' }
    ] as const;

    // Draw lines
    wheels.forEach(wInfo => {
        ctx.beginPath();
        ctx.strokeStyle = wInfo.color;
        ctx.lineWidth = 1.8;
        
        for (let i = 0; i < pressureHistory.length; i++) {
            const val = pressureHistory[i][wInfo.key];
            const x = getX(i);
            const y = getY(val);
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    });

    // Draw Legend
    ctx.font = '10px var(--font-header)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let legendX = padL + 10;
    wheels.forEach(wInfo => {
        ctx.fillStyle = wInfo.color;
        ctx.fillRect(legendX, 10, 10, 6);
        ctx.fillStyle = '#f3f4f6';
        ctx.fillText(wInfo.name, legendX + 14, 13);
        legendX += 45;
    });
}

init();
