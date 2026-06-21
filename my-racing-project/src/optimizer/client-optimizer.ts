import * as THREE from 'three';

/**
 * Core Algorithm: Elastic Line Optimizer (QP via Gradient Descent)
 * Shifts track waypoints along their normal vector to minimize curve index (total curvature).
 */
export function optimizeTrajectory(
    centerline: THREE.Vector3[], 
    roadWidth: number = 1.0, 
    carWidth: number = 0.25, 
    iterations: number = 600,
    learningRate: number = 0.02
): THREE.Vector3[] {
    const N = centerline.length;
    if (N < 4) return centerline.map(p => p.clone());

    // Maximum lateral shift (bounds limit)
    const maxShift = roadWidth - (carWidth / 2.0); 
    
    // Initialize offset shifts to zero (representing centerline tracking)
    const alpha = new Float32Array(N);

    // Precalculate unit normals for each centerline point
    const normals: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
        const prev = centerline[(i - 1 + N) % N];
        const next = centerline[(i + 1) % N];
        const tangent = next.clone().sub(prev).normalize();
        // Normal in horizontal X-Z plane
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        normals.push(normal);
    }

    // Regularization parameter lambda (tethers path back to centerline to avoid extreme shortcuts)
    const lambda = 0.05;

    // Helper function to build actual coordinates from lateral shifts
    const getPoint = (idx: number, shift: number) => {
        const c = centerline[idx];
        const n = normals[idx];
        return c.clone().add(n.clone().multiplyScalar(shift));
    };

    // Iterative Gradient Descent Solver
    for (let iter = 0; iter < iterations; iter++) {
        const nextAlpha = new Float32Array(N);

        for (let i = 0; i < N; i++) {
            const prevIdx = (i - 1 + N) % N;
            const nextIdx = (i + 1) % N;

            // Shifted points
            const p_curr = getPoint(i, alpha[i]);
            const p_prev = getPoint(prevIdx, alpha[prevIdx]);
            const p_next = getPoint(nextIdx, alpha[nextIdx]);

            // Double differences (approximates curvature/acceleration)
            // d_i = p_{i+1} - 2*p_i + p_{i-1}
            const d_curr = p_next.clone().sub(p_curr.clone().multiplyScalar(2)).add(p_prev);

            // d_{i-1} = p_i - 2*p_{i-1} + p_{i-2}
            const p_prev2 = getPoint((prevIdx - 1 + N) % N, alpha[(prevIdx - 1 + N) % N]);
            const d_prev = p_curr.clone().sub(p_prev.clone().multiplyScalar(2)).add(p_prev2);

            // d_{i+1} = p_{i+2} - 2*p_{i+1} + p_i
            const p_next2 = getPoint((nextIdx + 1) % N, alpha[(nextIdx + 1) % N]);
            const d_next = p_next2.clone().sub(p_next.clone().multiplyScalar(2)).add(p_curr);

            // Compute derivative components w.r.t alpha_i:
            // grad = (2 * d_{i-1} - 4 * d_i + 2 * d_{i+1}) . n_i + 2 * lambda * alpha_i
            const normal_i = normals[i];
            const gradVec = d_prev.clone().multiplyScalar(2)
                                  .sub(d_curr.clone().multiplyScalar(4))
                                  .add(d_next.clone().multiplyScalar(2));
            
            const gradVal = gradVec.dot(normal_i) + 2.0 * lambda * alpha[i];

            // Take step and clamp within track boundaries
            let newAlpha = alpha[i] - learningRate * gradVal;
            newAlpha = Math.max(-maxShift, Math.min(maxShift, newAlpha));
            nextAlpha[i] = newAlpha;
        }

        // Copy next values back into active shift array
        alpha.set(nextAlpha);
    }

    // Generate optimized coordinate trajectory
    return centerline.map((_, idx) => getPoint(idx, alpha[idx]));
}

/**
 * Compute optimized speed profile for a given path trajectory.
 * Implements Curvature limits, Friction limits, and forward/backward passes.
 */
export function generateSpeedProfile(
    path: THREE.Vector3[], 
    mu: number = 0.8, 
    baseMaxSpeedKMH: number = 320,
    a_accel: number = 8.5, // m/s^2 acceleration limit (Formula 1 engine scale)
    a_decel: number = 22.0 // m/s^2 braking deceleration limit (Formula 1 carbon brakes)
): number[] {
    const N = path.length;
    const velocities = new Float64Array(N);
    const maxV = baseMaxSpeedKMH / 3.6; // convert max target to m/s
    const g = 9.81;

    // 1. Calculate local curvature and friction velocity limits for each point
    const rawLimits = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const prev = path[(i - 1 + N) % N];
        const curr = path[i];
        const next = path[(i + 1) % N];

        const d1 = curr.distanceTo(prev);
        const d2 = next.distanceTo(curr);
        const d_tot = next.distanceTo(prev);

        let curvature = 0.0001; // baseline tiny curvature for straight lines
        if (d1 > 0 && d2 > 0 && d_tot > 0) {
            // 3-point curvature calculation
            const area = 0.5 * Math.abs(
                (curr.x - prev.x) * (next.z - curr.z) - 
                (curr.z - prev.z) * (next.x - curr.x)
            );
            curvature = (4.0 * area) / (d1 * d2 * d_tot);
        }

        // Target velocity limited by lateral tire load capacity
        const vLimit = Math.sqrt((mu * g) / Math.max(curvature, 0.0001));
        rawLimits[i] = Math.min(vLimit, maxV);
    }

    // Initialize target speed buffer with friction speed limits
    velocities.set(rawLimits);

    // 2. Backward Pass: Corner braking boundary constraints
    for (let iter = 0; iter < 2; iter++) {
        for (let i = N - 1; i >= 0; i--) {
            const nextIdx = (i + 1) % N;
            const dist = path[i].distanceTo(path[nextIdx]);
            const brakeCap = Math.sqrt(velocities[nextIdx] * velocities[nextIdx] + 2.0 * a_decel * dist);
            velocities[i] = Math.min(velocities[i], brakeCap);
        }
    }

    // 3. Forward Pass: Engine acceleration capabilities
    for (let iter = 0; iter < 2; iter++) {
        for (let i = 0; i < N; i++) {
            const nextIdx = (i + 1) % N;
            const dist = path[i].distanceTo(path[nextIdx]);
            const accelCap = Math.sqrt(velocities[i] * velocities[i] + 2.0 * a_accel * dist);
            velocities[nextIdx] = Math.min(velocities[nextIdx], accelCap);
        }
    }

    return Array.from(velocities);
}
