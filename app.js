// F1 Line Racer Sim - Fully Integrated State & UI Layout Shell
// Coupled with RWID Vehicle Physics Engine and Telemetry Hooks.

// Core State variables
let activeTrack = 'monaco';
let targetSpeed = 120; // km/h (Scales perfectly up to 350 km/h now)
let steeringAngle = 0.0; // steering angle (degrees)
let drivingMode = 'safe'; // 'fast' | 'safe' | 'stable'
let tireFriction = 0.80; // coefficient from 0.0 to 1.0
let tireType = 'medium'; // 'soft' | 'medium' | 'hard' | 'wet'
let trackTemperature = 35; // degrees Celsius (10 to 60)

// Physics Engine Instance
let carPhysics = null;
let lastTime = performance.now();
let simTime = 0; // Elapsed simulation time

// Track Configuration Metadata
const tracksConfig = {
  monaco: {
    name: "Monaco GP",
    location: "Monte Carlo, Monaco",
    lengthStr: "3.337 km",
    curveIntensity: 0.45,
    frequency: 0.8
  },
  monza: {
    name: "Monza GP",
    location: "Monza, Italy",
    lengthStr: "5.793 km",
    curveIntensity: 0.12,
    frequency: 0.3
  },
  spa: {
    name: "Spa-Francorchamps",
    location: "Stavelot, Belgium",
    lengthStr: "7.004 km",
    curveIntensity: 0.28,
    frequency: 0.5
  },
  suzuka: {
    name: "Suzuka GP",
    location: "Suzuka, Japan",
    lengthStr: "5.807 km",
    curveIntensity: 0.35,
    frequency: 0.6
  }
};

// Initialize Event Listeners on DOM Load
window.addEventListener('DOMContentLoaded', () => {
  // Instantiate the physics engine core
  if (typeof RWIDVehiclePhysics !== 'undefined') {
    carPhysics = new RWIDVehiclePhysics();
    // Set factory motor power to true F1 specifications to support 350 km/h stability
    carPhysics.DEFAULTS.P_max = 800000.0;
  } else {
    console.error("[PHYSICS ERROR] RWIDVehiclePhysics class not found. Ensure physics.js is loaded first.");
  }

  setupTabs();
  setupControls();
  setupTrackSelector();

  // Apply initial track state
  selectTrack(activeTrack);
  updateDrivingModeGains();

  // Start the main real-time rendering and computation loop
  requestAnimationFrame(simulationLoop);
  console.log("F1 Line Racer Sim UI/UX Environment Ready.");
});

// Main Real-Time Simulation Loop (~60 FPS)
function simulationLoop(currentTime) {
  let dt = (currentTime - lastTime) / 1000.0; // Convert to seconds
  lastTime = currentTime;

  // Cap delta time to prevent physics explosions on background tab focus shifts
  if (dt > 0.1) dt = 0.1;

  if (carPhysics) {
    // ANTI-WINDUP FIX: Strict clamping of the cumulative PID speed error integral register.
    // This stops the controller memory from creating chaotic feedback loops at high speeds (200+ km/h).
    if (carPhysics.speedErrorIntegral > 300.0) carPhysics.speedErrorIntegral = 300.0;
    if (carPhysics.speedErrorIntegral < -300.0) carPhysics.speedErrorIntegral = -300.0;

    // Convert current manual steering angle slider value (in degrees) to radians for physics engine
    let steeringAngleRad = (steeringAngle * Math.PI) / 180.0;

    // Format tire type string to match expected physics dictionary mapping ('Soft', 'Medium', 'Hard')
    let formattedTireType = tireType.charAt(0).toUpperCase() + tireType.slice(1).toLowerCase();
    if (formattedTireType === 'Wet') formattedTireType = 'Soft'; // Map wet compound to soft grip characteristics

    // Fallback safe DOM elements checking for toggle flags
    const customToggle = document.getElementById('custom-settings-toggle');
    let useCustom = customToggle ? customToggle.checked : false;

    // Build centralized state control wrapper object
    let controlsInput = {
      steeringAngle: steeringAngleRad,
      targetSpeed: targetSpeed / 3.6, // Critical: Convert km/h slider value to m/s for physics loops
      trackTemp: trackTemperature,
      baseFriction: tireFriction,
      tireType: formattedTireType,
      useCustomSettings: useCustom,
      customParams: useCustom ? readCustomParamsFromUI() : null
    };

    // Execute physical dynamics differential equations solver step
    let state = carPhysics.update(controlsInput, dt);

    // Push state metrics into the Live HUD/Telemetry UI components
    updateTelemetryUI(state, steeringAngleRad);

    // Render the dynamic load balance graph
    updateWeightTransferChart(state);
  }

  requestAnimationFrame(simulationLoop);
}

// Read custom parameters layout safely from advanced configuration panels if active
function readCustomParamsFromUI() {
  const getVal = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) : fallback;
  };

  return {
    m: getVal('input-mass', 1300.0),
    rw: getVal('input-radius', 0.285),
    B: getVal('input-track', 1.4375),
    lf: getVal('input-lf', 1.4373),
    lr: getVal('input-lr', 1.2247),
    Iz: getVal('input-iz', 1808.0),
    Iw: getVal('input-iw', 1.85),
    h: getVal('input-height', 0.3),
    P_max: getVal('input-power', 800000.0), // Synced to F1 standard
    s_thresh: getVal('input-asr-thresh', 0.15),
    Kp: getVal('input-kp', 400.0),
    Ki: getVal('input-ki', 15.0),
    Kd: getVal('input-kd', 5.0)
  };
}

// Dynamically adjust baseline PID tuning parameters to adapt to driving modes
function updateDrivingModeGains() {
  if (!carPhysics) return;

  // Keep upgraded high power scaling across factory profile modes
  carPhysics.DEFAULTS.P_max = 800000.0;

  if (drivingMode === 'safe') {
    carPhysics.DEFAULTS.Kp = 250.0;  // Smooth acceleration curve profile
    carPhysics.DEFAULTS.Ki = 5.0;    // Lowered to prevent accumulation spikes at 300+ km/h
    carPhysics.DEFAULTS.Kd = 12.0;   // High damping factor to eliminate speed overshoots
    carPhysics.DEFAULTS.s_thresh = 0.10; // Highly sensitive traction control limits
  } else if (drivingMode === 'stable') {
    carPhysics.DEFAULTS.Kp = 400.0;  // Standard balanced configurations
    carPhysics.DEFAULTS.Ki = 10.0;
    carPhysics.DEFAULTS.Kd = 5.0;
    carPhysics.DEFAULTS.s_thresh = 0.15;
  } else if (drivingMode === 'fast') {
    carPhysics.DEFAULTS.Kp = 650.0;  // Aggressive racing power deployment rates
    carPhysics.DEFAULTS.Ki = 15.0;   // Rapid recovery of systemic line speed errors
    carPhysics.DEFAULTS.Kd = 2.0;    // Minimal transient damping for maximum engine responses
    carPhysics.DEFAULTS.s_thresh = 0.22; // Loosened safety margins to permit mild exit slips
  }
}

// Push operational state variables updates to the view layers
function updateTelemetryUI(state, steeringAngle) {
  // 1. Live Speed Indicator Module
  const telSpeed = document.getElementById('tel-speed');
  if (telSpeed) {
    telSpeed.innerHTML = `${(state.vx * 3.6).toFixed(1)} <span class="unit">km/h</span>`;
  }

  // 2. Slip Energy Dissipation Telemetry Block
  const telLoss = document.getElementById('tel-ploss') || document.getElementById('tel-loss');
  if (telLoss) {
    telLoss.innerHTML = `${state.pLoss.toFixed(0)} <span class="unit">W</span>`;
  }

  // 3. Differential Vectoring Balance Unit
  const telDeltaT = document.getElementById('tel-deltat') || document.getElementById('tel-delta-t');
  if (telDeltaT) {
    telDeltaT.innerHTML = `${state.deltaT.toFixed(1)} <span class="unit">Nm</span>`;
  }

  // 4. Critical Slip Ratio Telemetry Fields
  const telSlipL = document.getElementById('tel-slip-left');
  const telSlipR = document.getElementById('tel-slip-right');
  if (telSlipL) telSlipL.textContent = `${(state.sLeft * 100).toFixed(2)} %`;
  if (telSlipR) telSlipR.textContent = `${(state.sRight * 100).toFixed(2)} %`;

  // 5. Dynamic Steering Heading Interface Indicators
  const telSteer = document.getElementById('tel-steering') || document.getElementById('tel-steer');
  if (telSteer) {
    const steeringAngleDeg = steeringAngle * (180.0 / Math.PI);
    telSteer.textContent = `${steeringAngleDeg.toFixed(1)}°`;
  }

  // 6. Anti-lock Slip Regulation Security Alert Module (ASR Indicator HUD)
  const asrIndicator = document.getElementById('asr-indicator') || document.getElementById('tel-asr');
  if (asrIndicator) {
    if (state.asrActive) {
      asrIndicator.classList.add('active');
      asrIndicator.textContent = "ASR ACTIVE";
    } else {
      asrIndicator.classList.remove('active');
      asrIndicator.textContent = "STABLE";
    }
  }
}

// Sidebar Tab Switcher
// Sidebar Tab Switcher
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs and panels
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      // Activate selected tab and panel
      tab.classList.add('active');
      const panelId = `panel-${tab.dataset.tab}`;
      const panel = document.getElementById(panelId);
      if (panel) {
        panel.classList.add('active');
      }
    });
  });
}

// Sidebar Controls Integration
function setupControls() {
  // 1. Target Speed Control
  const speedSlider = document.getElementById('slider-speed');
  const speedVal = document.getElementById('speed-val');
  if (speedSlider && speedVal) {
    speedSlider.addEventListener('input', (e) => {
      targetSpeed = parseInt(e.target.value, 10);
      speedVal.textContent = `${targetSpeed} km/h`;
      console.log(`[STATE UPDATE] targetSpeed = ${targetSpeed}`);
    });
  }

  // 1.5. Steering Angle Control
  const steerSlider = document.getElementById('slider-steering');
  const steerVal = document.getElementById('steering-val');
  if (steerSlider && steerVal) {
    steerSlider.addEventListener('input', (e) => {
      steeringAngle = parseFloat(e.target.value);
      steerVal.textContent = `${steeringAngle.toFixed(1)}°`;
      console.log(`[STATE UPDATE] steeringAngle = ${steeringAngle}°`);
    });
  }

  // 2. Driving Modes Button Group
  const modeButtons = document.querySelectorAll('#driving-mode-group .mode-btn');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Toggle button active classes
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      drivingMode = btn.dataset.mode;
      console.log(`[STATE UPDATE] drivingMode = "${drivingMode}"`);
      updateDrivingModeGains(); // Dynamically update PID parameters instantly
    });
  });

  // 3. Tire Friction Slider
  const frictionSlider = document.getElementById('slider-friction');
  const frictionVal = document.getElementById('friction-val');
  if (frictionSlider && frictionVal) {
    frictionSlider.addEventListener('input', (e) => {
      tireFriction = parseFloat(e.target.value);
      frictionVal.textContent = tireFriction.toFixed(2);
      console.log(`[STATE UPDATE] tireFriction = ${tireFriction}`);
    });
  }

  // 4. Tire Types Selector
  const tireTypeSelect = document.getElementById('select-tire-type');
  if (tireTypeSelect) {
    tireTypeSelect.addEventListener('change', (e) => {
      tireType = e.target.value;
      console.log(`[STATE UPDATE] tireType = "${tireType}"`);
    });
  }

  // 5. Track Temperature Slider
  const tempSlider = document.getElementById('slider-temperature');
  const tempVal = document.getElementById('temp-val');
  if (tempSlider && tempVal) {
    tempSlider.addEventListener('input', (e) => {
      trackTemperature = parseInt(e.target.value, 10);
      tempVal.textContent = `${trackTemperature}°C`;
      console.log(`[STATE UPDATE] trackTemperature = ${trackTemperature}`);
    });
  }

  // 6. Custom Setup Toggle
  const customToggle = document.getElementById('custom-settings-toggle');
  const paramIds = [
    'input-mass', 'input-radius', 'input-track', 'input-lf', 'input-lr',
    'input-iz', 'input-iw', 'input-height', 'input-power', 'input-asr-thresh',
    'input-kp', 'input-ki', 'input-kd'
  ];

  function updateCustomInputsState() {
    const isEnabled = customToggle ? customToggle.checked : false;
    paramIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !isEnabled;
      }
    });
  }

  if (customToggle) {
    customToggle.addEventListener('change', (e) => {
      console.log(`[STATE UPDATE] useCustomSettings = ${e.target.checked}`);
      updateCustomInputsState();
    });
  }
  // Initialize inputs enabled/disabled state based on current toggle value
  updateCustomInputsState();

  // 7. Chassis Parameters Listeners (Log changes)
  paramIds.forEach(id => {
    const inputEl = document.getElementById(id);
    if (inputEl) {
      inputEl.addEventListener('input', (e) => {
        console.log(`[STATE UPDATE] customParam ${id} = ${e.target.value}`);
      });
    }
  });

  // 8. Reset Simulation Control
  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      console.log("[ACTION] Resetting Simulation...");
      if (carPhysics) {
        carPhysics.reset();
      }
      steeringAngle = 0.0;
      targetSpeed = 120;

      // Update speed controls DOM
      const speedSlider = document.getElementById('slider-speed');
      const speedVal = document.getElementById('speed-val');
      if (speedSlider) speedSlider.value = 120;
      if (speedVal) speedVal.textContent = "120 km/h";

      // Update steering controls DOM
      const steerSlider = document.getElementById('slider-steering');
      const steerVal = document.getElementById('steering-val');
      if (steerSlider) steerSlider.value = 0;
      if (steerVal) steerVal.textContent = "0.0°";

      console.log("[STATE UPDATE] Simulation reset to baseline targetSpeed = 120 km/h, steeringAngle = 0.0°");
    });
  }
}

// Track Selector Interaction (Cards)
function setupTrackSelector() {
  const cards = document.querySelectorAll('.track-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const trackId = card.dataset.track;
      if (trackId && tracksConfig[trackId]) {
        selectTrack(trackId);
      }
    });
  });
}

// Central Track Switch Action
function selectTrack(trackId) {
  activeTrack = trackId;
  const config = tracksConfig[trackId];

  console.log(`[STATE UPDATE] activeTrack = "${activeTrack}" (${config.name})`);

  // FIXED: carPhysics.reset() and simTime lines are removed here to prevent telemetry drops/spikes 
  // when clicking track card profiles since execution runs entirely on sliders.

  // 1. Update viewer text placeholders
  const displayTitle = document.getElementById('active-track-display');
  const displayDetails = document.getElementById('active-track-details');
  if (displayTitle) {
    displayTitle.textContent = `${config.name}`;
  }
  if (displayDetails) {
    displayDetails.textContent = `${config.location} • Length: ${config.lengthStr}`;
  }

  // 2. Update active states on track cards
  const cards = document.querySelectorAll('.track-card');
  cards.forEach(card => {
    const actionLabel = card.querySelector('.card-action');
    if (card.dataset.track === trackId) {
      card.classList.add('active');
      if (actionLabel) actionLabel.textContent = "Active";
    } else {
      card.classList.remove('active');
      if (actionLabel) actionLabel.textContent = "Select";
    }
  });
}

// Dynamic Weight Transfer Canvas Rendering
function updateWeightTransferChart(state) {
  const canvas = document.getElementById('weight-transfer-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // Clear background
  ctx.fillStyle = '#12131c'; // matching var(--bg-sidebar)
  ctx.fillRect(0, 0, width, height);

  // If vehicle has flipped/crashed, show the rollover alert screen
  if (state.isFlipped) {
    // Semi-transparent dark red background
    ctx.fillStyle = 'rgba(255, 24, 1, 0.15)';
    ctx.fillRect(0, 0, width, height);

    // Border indicator
    ctx.strokeStyle = '#ff1801';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, width - 8, height - 8);

    // Large Red Title Text
    ctx.fillStyle = '#ff1801';
    ctx.font = 'bold 16px var(--font-header), sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CRASH: ROLLOVER DETECTED', width / 2, height / 2 - 12);

    // Subtitle Text
    ctx.fillStyle = '#f3f4f6';
    ctx.font = '600 11px var(--font-body), sans-serif';
    ctx.fillText('WHEELS SPINNING IN AIR', width / 2, height / 2 + 12);
    return;
  }

  // Compute percentages based on tire stiffness grip parameters (state.kLeft, state.kRight)
  const totalK = state.kLeft + state.kRight;
  const pctLeft = totalK > 0 ? (state.kLeft / totalK) * 100 : 50;
  const pctRight = totalK > 0 ? (state.kRight / totalK) * 100 : 50;

  // Draw grid lines
  ctx.strokeStyle = '#27283b'; // matching var(--border-color)
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Center line
  ctx.moveTo(width / 2, 10);
  ctx.lineTo(width / 2, height - 35);
  // Grid tick marks
  for (let i = 1; i < 5; i++) {
    const x = (width / 5) * i;
    ctx.moveTo(x, 10);
    ctx.lineTo(x, height - 35);
  }
  ctx.stroke();

  // Draw dynamic balance bar (G-force style)
  const barY = height - 25;
  const barHeight = 12;

  // Track slot
  ctx.fillStyle = '#27283b';
  ctx.fillRect(10, barY, width - 20, barHeight);

  // Dynamic slider position based on pctRight
  const sliderX = 10 + ((pctRight / 100) * (width - 20));

  // Draw slider handle
  ctx.fillStyle = '#ff1801'; // F1 Red matching var(--border-dark)
  ctx.beginPath();
  ctx.arc(sliderX, barY + barHeight / 2, 8, 0, Math.PI * 2);
  ctx.fill();

  // Draw two load indicator bars side-by-side (Vertical wheel loads kLeft / kRight)
  const pad = 35;
  const barWidth = 45;
  const maxBarHeight = height - 75; // leave room for labels

  // Determine bar fill colors
  let leftBarColor = '#ff1801'; // Standard F1 red
  let rightBarColor = '#00ff88'; // Neon green
  if (state.asrActive) {
    leftBarColor = '#ff9f1c'; // Alert orange
    rightBarColor = '#ff9f1c'; // Alert orange
  }

  // Left Load Bar
  const leftBarHeight = (pctLeft / 100) * maxBarHeight;
  ctx.fillStyle = leftBarColor;
  ctx.fillRect(pad, height - 45 - leftBarHeight, barWidth, leftBarHeight);

  // Right Load Bar
  const rightBarHeight = (pctRight / 100) * maxBarHeight;
  ctx.fillStyle = rightBarColor;
  ctx.fillRect(width - pad - barWidth, height - 45 - rightBarHeight, barWidth, rightBarHeight);

  // Draw labels
  ctx.fillStyle = '#f3f4f6';
  ctx.font = 'bold 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LEFT LOAD', pad + barWidth / 2, height - 32);
  ctx.fillText('RIGHT LOAD', width - pad - barWidth / 2, height - 32);

  // Draw load percentages inside bars
  ctx.fillStyle = '#f3f4f6';
  ctx.fillText(`${pctLeft.toFixed(0)}%`, pad + barWidth / 2, height - 50 - leftBarHeight);
  ctx.fillText(`${pctRight.toFixed(0)}%`, width - pad - barWidth / 2, height - 50 - rightBarHeight);

  // Title / status (Header metadata and warning flags)
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = '#8892b0';
  ctx.textAlign = 'center';
  ctx.fillText(`TOTAL GRIP LOAD: ${totalK.toFixed(0)} N`, width / 2, 22);

  if (state.asrActive) {
    ctx.fillStyle = '#ff9f1c'; // Orange warning text
    ctx.fillText("SAFETY ACTIVE (ASR/ABS MODULATION)", width / 2, 36);
  } else {
    ctx.fillStyle = '#8892b0'; // Standard text color
    ctx.fillText(`TV BIAS: ${state.deltaT.toFixed(1)} Nm`, width / 2, 36);
  }
}