# F1 LINE RACER SIM - Developer Simulation Environment

An advanced, interactive 3D Formula 1 line-following visualizer designed for autonomous vehicle control simulation. This environment integrates kinematic vehicle physics, a PID-controlled autopilot, real-time telemetry plotting, and a fully interactive Three.js 3D rendering engine.

---

## Project Overview

- **3D Visualizer**: Powered by **Three.js (v0.184.0)**, rendering procedural circuits with curved curbs, center guides, and elevation changes.
- **Physics Engine**: Realistic vehicle dynamics utilizing a 6-DOF kinematic bicycle model (handling mass, yaw rate, wheel radius, load transfers, and traction control).
- **Autonomous Autopilot**: A customizable **PID Feedback Loop** measuring lateral Cross-Track Error (CTE) ahead of the vehicle to govern automated steering.
- **Interactive Console & Telemetry**: Full control panel to tune physics variables (mass, power, tire compounds, temp, gains) and view live SVG error graphs.

---

## Prerequisites & Installation (Windows)

Ensure you have **Node.js** (v18 or higher) installed on your system.

1. Open your terminal of choice (PowerShell, Command Prompt, or Git Bash).
2. Navigate to the project's source directory:
   ```powershell
   cd "c:\Users\maksym.kozyr\Desktop\Git workspace\F1-simulation\my-racing-project"
   ```
3. Install the dependencies:
   ```powershell
   npm install
   ```

### 💡 PowerShell Execution Policy Bypass
If your system blocks the script execution with an execution policy warning (e.g., `npm.ps1 cannot be loaded because running scripts is disabled`), run the Command Prompt batch script instead to bypass the policy:
```powershell
npm.cmd install
```

---

## How to Launch

1. Boot up the Vite local development server:
   ```powershell
   npm run dev
   # If ps1 is blocked:
   npm.cmd run dev
   ```
2. Once the compiler finishes, browse to the visualizer at:
   👉 **[http://localhost:3000/](http://localhost:3000/)**

---

## Technical Upgrades & Custom Features

### 1. Single-Viewport Full-Screen Canvas
The previous 3-viewport split-screen rendering layout (Front, Top, Inside) has been replaced by a single, immersive 3D viewport. The active camera occupies 100% of the display canvas space for cleaner visualization.

### 2. HUD Camera Switching
You can cycle between cameras directly from the UI header using the **CYCLE CAMERA** button next to the Autopilot/Manual status pill.
- **Orbit Camera (`orbit`)**: A free-moving chase camera with fully active OrbitControls (drag to rotate, scroll to zoom, right-click to pan).
- **Cockpit Follow Camera (`cockpit`)**: A chase camera locked behind the F1 car, smoothly tracking its heading, roll, and elevation changes.
- **Top-Down Map Camera (`map`)**: A fixed orthographic-like camera looking straight down at the center coordinates to showcase the entire circuit layout.

### 3. ESM Lifecycle Timing Fixes
- **Race Condition Fix**: The initialization lifecycle in `app.js` checks `document.readyState` directly. If the DOM has already loaded (standard in ESM/Vite async loads), the application initializes immediately instead of deadlocking on a missed `DOMContentLoaded` event.
- **Physics Wrapper Preservation**: Added guard conditions to prevent subsequent ESM module re-execution from overwriting custom global classes (like `window.RWIDVehiclePhysics`) wrapped by orchestrators.
