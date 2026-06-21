export interface DatabaseConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
}

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

export interface VehicleTelemetry {
    pointIndex: number;
    x: number;
    z: number;
    actualSpeed: number;
    lateralG: number;
    tireSlip: number;
    lapNumber: number;
}

export interface TrackPoint {
    x: number;
    y: number;
    z: number;
    heading?: number;
    curvature?: number;
    target_speed?: number;
}

const RAM_RAW_TRACK_DB: Record<string, TelemetryPoint[]> = {};
const RAM_OPTIMIZED_PROFILE_DB: Record<string, OptimizedPoint[]> = {};

function dist(p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class TrajectoryOptimizer {
    private pgPool: any = null;
    private useDB: boolean = false;
    private lastSuccessfulSpeeds: Map<string, Float64Array> = new Map();
    private lastSuccessfulAlpha: Map<string, Float32Array> = new Map();
    private bestLapTimes: Map<string, number> = new Map();
    private currentSpeedKMH: Map<string, number> = new Map();
    private lastSuccessfulSpeedKMH: Map<string, number> = new Map();
    private candidateSpeeds: Map<string, Float64Array> = new Map();
    private candidateAlpha: Map<string, Float32Array> = new Map();

    constructor(config?: DatabaseConfig) {
        this.initializeDB(config);
    }

    private async initializeDB(config?: DatabaseConfig) {
        try {
            // @ts-ignore
            const { default: pkg } = await import('pg');
            const Pool = pkg.Pool;

            // Якщо config передано, використовуємо його поля, інакше — чіткі дефолтні параметри
            this.pgPool = new Pool({
                host: config?.host || 'localhost',
                port: config?.port || 5432,
                user: config?.user || 'postgres',
                password: config?.password || 'vfrcbvK1973',
                database: config?.database || 'f1_simulation',
                max: 5,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });

            // Тестовий запит для миттєвої перевірки зв'язку з базою
            await this.pgPool.query('SELECT NOW()');

            this.useDB = true;
            console.log('[DATABASE] PostgreSQL Pool established and verified successfully.');

            try {
                await this.pgPool.query('SELECT lap_number FROM optimized_race_profiles LIMIT 1');
            } catch (e) {
                await this.pgPool.query('DROP TABLE IF EXISTS optimized_race_profiles');
            }

            await this.pgPool.query(`
                CREATE TABLE IF NOT EXISTS raw_track_data (
                    id SERIAL PRIMARY KEY,
                    track_id VARCHAR(50) NOT NULL,
                    lap_number INT NOT NULL,
                    point_index INT NOT NULL,
                    x DOUBLE PRECISION NOT NULL,
                    y DOUBLE PRECISION NOT NULL,
                    z DOUBLE PRECISION NOT NULL,
                    heading DOUBLE PRECISION NOT NULL,
                    curvature DOUBLE PRECISION NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (track_id, lap_number, point_index)
                );

                CREATE TABLE IF NOT EXISTS optimized_race_profiles (
                    id SERIAL PRIMARY KEY,
                    track_id VARCHAR(50) NOT NULL,
                    lap_number INT NOT NULL,
                    point_index INT NOT NULL,
                    x DOUBLE PRECISION NOT NULL,
                    y DOUBLE PRECISION NOT NULL,
                    z DOUBLE PRECISION NOT NULL,
                    target_speed DOUBLE PRECISION NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (track_id, lap_number, point_index)
                );
            `);
        } catch (err) {
            console.error("CRITICAL DATABASE ERROR DURING INITIALIZATION:", err);
            this.useDB = false;
            // @ts-ignore
            process.exit(1);
        }
    }

    public async resetTrackOptimizerState(trackId: string): Promise<void> {
        this.lastSuccessfulSpeeds.delete(trackId);
        this.lastSuccessfulAlpha.delete(trackId);
        this.bestLapTimes.delete(trackId);
        this.currentSpeedKMH.delete(trackId);
        this.lastSuccessfulSpeedKMH.delete(trackId);
        this.candidateSpeeds.delete(trackId);
        this.candidateAlpha.delete(trackId);

        if (this.useDB && this.pgPool) {
            try {
                await this.pgPool.query('DELETE FROM optimized_race_profiles WHERE track_id = $1', [trackId]);
                console.log(`[DATABASE] Cleared optimized profiles for track ${trackId}`);
            } catch (err) {
                console.error(`[DATABASE ERROR] Failed to clear profiles for track ${trackId}:`, err);
            }
        }
    }

    public async saveRawTrackData(trackId: string, lapNumber: number, points: TelemetryPoint[]): Promise<boolean> {
        if (!this.useDB || !this.pgPool) {
            const err = new Error("PostgreSQL database connection pool is not initialized.");
            console.error("CRITICAL DATABASE ERROR:", err);
            throw err;
        }
        try {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM raw_track_data WHERE track_id = $1 AND lap_number = $2', [trackId, lapNumber]);
                for (const p of points) {
                    await client.query(
                        `INSERT INTO raw_track_data (track_id, lap_number, point_index, x, y, z, heading, curvature) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [trackId, lapNumber, p.pointIndex, p.x, p.y, p.z, p.heading, p.curvature]
                    );
                }
                await client.query('COMMIT');
                return true;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error("CRITICAL DATABASE ERROR:", err);
            throw err;
        }
    }

    public async getRawTrackData(trackId: string, lapNumber: number): Promise<TelemetryPoint[]> {
        if (!this.useDB || !this.pgPool) {
            return RAM_RAW_TRACK_DB[`${trackId}_lap${lapNumber}`] || [];
        }
        try {
            const res = await this.pgPool.query(
                `SELECT point_index as "pointIndex", x, y, z, heading, curvature 
                 FROM raw_track_data 
                 WHERE track_id = $1 AND lap_number = $2 
                 ORDER BY point_index ASC`,
                [trackId, lapNumber]
            );
            return res.rows;
        } catch (err) {
            return RAM_RAW_TRACK_DB[`${trackId}_lap${lapNumber}`] || [];
        }
    }

    public async saveOptimizedProfile(trackId: string, points: OptimizedPoint[], lapNumber: number): Promise<boolean> {
        if (!this.useDB || !this.pgPool) {
            RAM_OPTIMIZED_PROFILE_DB[`${trackId}_lap${lapNumber}`] = points;
            return true;
        }
        try {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM optimized_race_profiles WHERE track_id = $1 AND lap_number = $2', [trackId, lapNumber]);
                for (const p of points) {
                    await client.query(
                        `INSERT INTO optimized_race_profiles (track_id, lap_number, point_index, x, y, z, target_speed) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [trackId, lapNumber, p.pointIndex, p.x, p.y, p.z, p.targetSpeed]
                    );
                }
                await client.query('COMMIT');
                return true;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error("CRITICAL DATABASE ERROR:", err);
            throw err;
        }
    }

    public async getOptimizedProfile(trackId: string, lapNumber: number): Promise<OptimizedPoint[]> {
        if (!this.useDB || !this.pgPool) {
            return RAM_OPTIMIZED_PROFILE_DB[`${trackId}_lap${lapNumber}`] || [];
        }
        try {
            const res = await this.pgPool.query(
                `SELECT point_index as "pointIndex", x, y, z, target_speed as "targetSpeed" 
                 FROM optimized_race_profiles 
                 WHERE track_id = $1 AND lap_number = $2 
                 ORDER BY point_index ASC`,
                [trackId, lapNumber]
            );
            return res.rows;
        } catch (err) {
            return RAM_OPTIMIZED_PROFILE_DB[`${trackId}_lap${lapNumber}`] || [];
        }
    }

    public async getLatestOptimizedProfile(trackId: string): Promise<OptimizedPoint[]> {
        if (!this.useDB || !this.pgPool) {
            let maxLap = -1;
            let bestKey = '';
            for (const key of Object.keys(RAM_OPTIMIZED_PROFILE_DB)) {
                if (key.startsWith(`${trackId}_lap`)) {
                    const lNum = parseInt(key.split('_lap')[1], 10);
                    if (lNum > maxLap) {
                        maxLap = lNum;
                        bestKey = key;
                    }
                }
            }
            return bestKey ? RAM_OPTIMIZED_PROFILE_DB[bestKey] : [];
        }
        try {
            const lapRes = await this.pgPool.query(
                `SELECT COALESCE(MAX(lap_number), 0) as "maxLap" 
                 FROM optimized_race_profiles 
                 WHERE track_id = $1`,
                [trackId]
            );
            const maxLap = lapRes.rows[0]?.maxLap || 0;
            if (maxLap > 0) {
                return this.getOptimizedProfile(trackId, maxLap);
            }
            return [];
        } catch (err) {
            return [];
        }
    }

    public optimizeTrajectory(
        centerline: TrackPoint[],
        roadWidth: number = 1.0,
        carWidth: number = 0.25,
        iterations: number = 600,
        learningRate: number = 0.02
    ): TrackPoint[] {
        const N = centerline.length;
        if (N < 4) return centerline.map(p => ({ ...p }));
        const maxShift = roadWidth - (carWidth / 2.0);
        const alpha = new Float32Array(N);
        const normals: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < N; i++) {
            const prev = centerline[(i - 1 + N) % N];
            const next = centerline[(i + 1) % N];
            const tx = next.x - prev.x;
            const ty = next.y - prev.y;
            const tz = next.z - prev.z;
            const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            const tangent = { x: tx / len, y: ty / len, z: tz / len };
            const nx = -tangent.z;
            const ny = 0;
            const nz = tangent.x;
            const nLen = Math.sqrt(nx * nx + nz * nz) || 1;
            normals.push({ x: nx / nLen, y: ny / nLen, z: nz / nLen });
        }
        const lambda = 0.05;
        const getPoint = (idx: number, shift: number): TrackPoint => {
            const c = centerline[idx];
            const n = normals[idx];
            return {
                x: c.x + n.x * shift,
                y: c.y + n.y * shift,
                z: c.z + n.z * shift
            };
        };
        for (let iter = 0; iter < iterations; iter++) {
            const nextAlpha = new Float32Array(N);
            for (let i = 0; i < N; i++) {
                const prevIdx = (i - 1 + N) % N;
                const nextIdx = (i + 1) % N;
                const p_curr = getPoint(i, alpha[i]);
                const p_prev = getPoint(prevIdx, alpha[prevIdx]);
                const p_next = getPoint(nextIdx, alpha[nextIdx]);
                const d_curr = {
                    x: p_next.x - 2 * p_curr.x + p_prev.x,
                    y: p_next.y - 2 * p_curr.y + p_prev.y,
                    z: p_next.z - 2 * p_curr.z + p_prev.z
                };
                const p_prev2 = getPoint((prevIdx - 1 + N) % N, alpha[(prevIdx - 1 + N) % N]);
                const d_prev = {
                    x: p_curr.x - 2 * p_prev.x + p_prev2.x,
                    y: p_curr.y - 2 * p_prev.y + p_prev2.y,
                    z: p_curr.z - 2 * p_prev.z + p_prev2.z
                };
                const p_next2 = getPoint((nextIdx + 1) % N, alpha[(nextIdx + 1) % N]);
                const d_next = {
                    x: p_next2.x - 2 * p_next.x + p_curr.x,
                    y: p_next2.y - 2 * p_next.y + p_curr.y,
                    z: p_next2.z - 2 * p_next.z + p_curr.z
                };
                const gradVec = {
                    x: 2 * d_prev.x - 4 * d_curr.x + 2 * d_next.x,
                    y: 2 * d_prev.y - 4 * d_curr.y + 2 * d_next.y,
                    z: 2 * d_prev.z - 4 * d_curr.z + 2 * d_next.z
                };
                const normal_i = normals[i];
                const gradVal = (gradVec.x * normal_i.x + gradVec.y * normal_i.y + gradVec.z * normal_i.z) + 2.0 * lambda * alpha[i];
                let newAlpha = alpha[i] - learningRate * gradVal;
                newAlpha = Math.max(-maxShift, Math.min(maxShift, newAlpha));
                nextAlpha[i] = newAlpha;
            }
            alpha.set(nextAlpha);
        }
        return centerline.map((_, idx) => getPoint(idx, alpha[idx]));
    }

    public generateSpeedProfile(
        path: TrackPoint[],
        mu: number = 0.8,
        baseMaxSpeedKMH: number = 320,
        a_accel: number = 8.5,
        a_decel: number = 22.0
    ): number[] {
        const N = path.length;
        const velocities = new Float64Array(N);
        const maxV = baseMaxSpeedKMH / 3.6;
        const g = 9.81;
        const rawLimits = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            const prev = path[(i - 1 + N) % N];
            const curr = path[i];
            const next = path[(i + 1) % N];
            const d1 = dist(curr, prev);
            const d2 = dist(next, curr);
            const d_tot = dist(next, prev);
            let curvature = 0.0001;
            if (d1 > 0 && d2 > 0 && d_tot > 0) {
                const area = 0.5 * Math.abs(
                    (curr.x - prev.x) * (next.z - curr.z) -
                    (curr.z - prev.z) * (next.x - curr.x)
                );
                curvature = (4.0 * area) / (d1 * d2 * d_tot);
            }
            const vLimit = Math.sqrt((mu * g) / Math.max(curvature, 0.0001));
            const R = 1.0 / Math.max(curvature, 0.0001);
            const vFlip = Math.sqrt((g * R * 1.0) / (2.0 * 0.3));
            rawLimits[i] = Math.min(vLimit, vFlip, maxV);
        }
        velocities.set(rawLimits);
        for (let iter = 0; iter < 2; iter++) {
            for (let i = N - 1; i >= 0; i--) {
                const nextIdx = (i + 1) % N;
                const distance = dist(path[i], path[nextIdx]);
                const brakeCap = Math.sqrt(velocities[nextIdx] * velocities[nextIdx] + 2.0 * a_decel * distance);
                velocities[i] = Math.min(velocities[i], brakeCap);
            }
        }
        for (let iter = 0; iter < 2; iter++) {
            for (let i = 0; i < N; i++) {
                const nextIdx = (i + 1) % N;
                const distance = dist(path[i], path[nextIdx]);
                const accelCap = Math.sqrt(velocities[i] * velocities[i] + 2.0 * a_accel * distance);
                velocities[nextIdx] = Math.min(velocities[nextIdx], accelCap);
            }
        }
        return Array.from(velocities);
    }

    public async calibrateProfile(
        rawTrack: TrackPoint[],
        telemetry: VehicleTelemetry[],
        trackId: string,
        lapNumber: number,
        lapTime: number,
        wasCrash: boolean
    ): Promise<{ points: OptimizedPoint[]; nextLap: number }> {
        const N = rawTrack.length;
        if (N < 4) return { points: [], nextLap: lapNumber + 1 };

        // 1. Calculate normals, tangents, curvatures, isTurn and direction of curvature vectors
        const normals: { x: number; y: number; z: number }[] = [];
        const isTurn = new Uint8Array(N);
        const dx = new Float64Array(N);
        const dz = new Float64Array(N);

        for (let i = 0; i < N; i++) {
            const prev = rawTrack[(i - 1 + N) % N];
            const curr = rawTrack[i];
            const next = rawTrack[(i + 1) % N];
            const tx = next.x - prev.x;
            const ty = next.y - prev.y;
            const tz = next.z - prev.z;
            const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            const tangent = { x: tx / len, y: ty / len, z: tz / len };
            const nx = -tangent.z;
            const ny = 0;
            const nz = tangent.x;
            const nLen = Math.sqrt(nx * nx + nz * nz) || 1;
            normals.push({ x: nx / nLen, y: ny / nLen, z: nz / nLen });

            // Curvature calculation
            const d1 = dist(curr, prev);
            const d2 = dist(next, curr);
            const d_tot = dist(next, prev);
            let curvature = 0.0001;
            if (d1 > 0 && d2 > 0 && d_tot > 0) {
                const area = 0.5 * Math.abs(
                    (curr.x - prev.x) * (next.z - curr.z) -
                    (curr.z - prev.z) * (next.x - curr.x)
                );
                curvature = (4.0 * area) / (d1 * d2 * d_tot);
            }
            isTurn[i] = curvature > 0.015 ? 1 : 0;
            dx[i] = next.x - 2 * curr.x + prev.x;
            dz[i] = next.z - 2 * curr.z + prev.z;
        }

        const maxShift = 0.35;
        const targetSpeed = new Float64Array(N);
        const alpha = new Float32Array(N);

        // 2. Initialize or load state
        if (lapNumber === 1 || !this.lastSuccessfulSpeeds.has(trackId)) {
            const initSpeeds = new Float64Array(N).fill(30 / 3.6);
            const initAlpha = new Float32Array(N).fill(0);
            this.lastSuccessfulSpeeds.set(trackId, initSpeeds);
            this.lastSuccessfulAlpha.set(trackId, initAlpha);
            this.bestLapTimes.set(trackId, Infinity);
            this.currentSpeedKMH.set(trackId, 30);
            this.lastSuccessfulSpeedKMH.set(trackId, 30);
            this.candidateSpeeds.set(trackId, initSpeeds);
            this.candidateAlpha.set(trackId, initAlpha);

            targetSpeed.set(initSpeeds);
            alpha.set(initAlpha);
            console.log(`[OPTIMIZER] Initialized track ${trackId} baseline speed to 30 km/h.`);
        } else {
            // Load the settings used in the lap that just finished
            targetSpeed.set(this.candidateSpeeds.get(trackId)!);
            alpha.set(this.candidateAlpha.get(trackId)!);
        }

        // 3. Evaluate results of the completed lap
        const isCrashDetected = wasCrash || telemetry.some(t => t.tireSlip >= 1.0 || t.lateralG >= 5.0);
        const currentKMH = this.currentSpeedKMH.get(trackId) ?? 30;
        const bestTime = this.bestLapTimes.get(trackId) ?? Infinity;

        console.log(`[OPTIMIZER] Evaluating Lap ${lapNumber} - Current Speed: ${currentKMH} km/h, Lap Time: ${lapTime.toFixed(3)}s, Best Lap Time: ${bestTime.toFixed(3)}s, Crash: ${isCrashDetected}`);

        let success = false;
        // Don't evaluate success for lap 1, just accept it as the initial baseline
        if (lapNumber === 1) {
            success = true;
            this.bestLapTimes.set(trackId, lapTime > 0 ? lapTime : 9999);
            this.lastSuccessfulSpeeds.set(trackId, new Float64Array(targetSpeed));
            this.lastSuccessfulAlpha.set(trackId, new Float32Array(alpha));
            this.lastSuccessfulSpeedKMH.set(trackId, currentKMH);
            console.log(`[OPTIMIZER] First lap accepted. Baseline lap time set: ${(lapTime > 0 ? lapTime : 9999).toFixed(3)}s`);
        } else if (!isCrashDetected && lapTime < bestTime) {
            success = true;
            this.bestLapTimes.set(trackId, lapTime);
            this.lastSuccessfulSpeeds.set(trackId, new Float64Array(targetSpeed));
            this.lastSuccessfulAlpha.set(trackId, new Float32Array(alpha));
            this.lastSuccessfulSpeedKMH.set(trackId, currentKMH);
            console.log(`[OPTIMIZER] Improvement! New best lap time: ${lapTime.toFixed(3)}s.`);
        }

        // 4. Backtracking and recursive state transitions
        if (success && lapNumber > 1) {
            // Success: Step speed up by +5 km/h
            const nextKMH = currentKMH + 5;
            this.currentSpeedKMH.set(trackId, nextKMH);
            targetSpeed.fill(nextKMH / 3.6);

            // Shift trajectory outward slightly in all turns to prepare for higher speed
            for (let i = 0; i < N; i++) {
                if (isTurn[i]) {
                    const dot = dx[i] * normals[i].x + dz[i] * normals[i].z;
                    if (dot > 0) {
                        alpha[i] -= 0.015; // Shift outward by 0.015m
                    } else {
                        alpha[i] += 0.015; // Shift outward by 0.015m
                    }
                }
            }
            console.log(`[OPTIMIZER] Speed stepped up to ${nextKMH} km/h. Adjusted turn trajectory.`);
        } else if (!success && lapNumber > 1) {
            // Failure (crash or worse lap time): Roll back speed to previous success
            const prevKMH = this.lastSuccessfulSpeedKMH.get(trackId) || 30;
            this.currentSpeedKMH.set(trackId, prevKMH);

            // Revert speeds and alphas to the last successful baseline
            targetSpeed.set(this.lastSuccessfulSpeeds.get(trackId)!);
            alpha.set(this.lastSuccessfulAlpha.get(trackId)!);

            console.log(`[OPTIMIZER] Failure. Rolling back to speed: ${prevKMH} km/h.`);

            // Shift trajectory outward around the problem area (crash or highest slip index)
            let failIdx = -1;
            let maxTireSlip = 0;
            for (const t of telemetry) {
                if (t.tireSlip > maxTireSlip) {
                    maxTireSlip = t.tireSlip;
                    failIdx = t.pointIndex;
                }
            }
            if (failIdx === -1 || maxTireSlip < 0.5) {
                let maxLat = 0;
                for (const t of telemetry) {
                    if (Math.abs(t.lateralG) > maxLat) {
                        maxLat = Math.abs(t.lateralG);
                        failIdx = t.pointIndex;
                    }
                }
            }

            if (failIdx !== -1) {
                console.log(`[OPTIMIZER] Shifting trajectory outward by 0.03m around failure point (index ${failIdx}).`);
                for (let offset = -3; offset <= 3; offset++) {
                    const idx = (failIdx + offset + N) % N;
                    const dot = dx[idx] * normals[idx].x + dz[idx] * normals[idx].z;
                    if (dot > 0) {
                        alpha[idx] -= 0.03;
                    } else {
                        alpha[idx] += 0.03;
                    }
                }
            } else {
                console.log(`[OPTIMIZER] Shifting trajectory outward by 0.02m at all turns.`);
                for (let i = 0; i < N; i++) {
                    if (isTurn[i]) {
                        const dot = dx[i] * normals[i].x + dz[i] * normals[i].z;
                        if (dot > 0) {
                            alpha[i] -= 0.02;
                        } else {
                            alpha[i] += 0.02;
                        }
                    }
                }
            }
        }

        // 5. Enforce boundary constraints
        for (let i = 0; i < N; i++) {
            alpha[i] = Math.max(-maxShift, Math.min(maxShift, alpha[i]));
        }

        // Save current generated settings as candidate for the next lap run
        this.candidateSpeeds.set(trackId, new Float64Array(targetSpeed));
        this.candidateAlpha.set(trackId, new Float32Array(alpha));

        // 6. Generate 3D coordinates based on optimized alpha offsets
        const getPoint = (idx: number, shift: number): TrackPoint => {
            const c = rawTrack[idx];
            const n = normals[idx];
            return {
                x: c.x + n.x * shift,
                y: c.y + n.y * shift,
                z: c.z + n.z * shift
            };
        };

        const optPoints = rawTrack.map((_, idx) => getPoint(idx, alpha[idx]));

        // 7. Calculate dynamic velocity limits under mechanical forces (curvature, lateral Gs)
        const velocities = new Float64Array(N);
        const maxV = 320 / 3.6;
        const g = 9.81;
        const mu = 0.8;
        for (let i = 0; i < N; i++) {
            const prev = optPoints[(i - 1 + N) % N];
            const curr = optPoints[i];
            const next = optPoints[(i + 1) % N];
            const d1 = dist(curr, prev);
            const d2 = dist(next, curr);
            const d_tot = dist(next, prev);
            let curvature = 0.0001;
            if (d1 > 0 && d2 > 0 && d_tot > 0) {
                const area = 0.5 * Math.abs(
                    (curr.x - prev.x) * (next.z - curr.z) -
                    (curr.z - prev.z) * (next.x - curr.x)
                );
                curvature = (4.0 * area) / (d1 * d2 * d_tot);
            }
            const vLimit = Math.sqrt((mu * g) / Math.max(curvature, 0.0001));
            const R = 1.0 / Math.max(curvature, 0.0001);
            const vFlip = Math.sqrt((g * R * 1.0) / (2.0 * 0.3));
            velocities[i] = Math.min(vLimit, vFlip, maxV, targetSpeed[i]);
        }

        // Apply braking and acceleration limits
        const a_accel_arr = new Float64Array(N).fill(8.5);
        const a_decel_arr = new Float64Array(N).fill(22.0);

        for (let iter = 0; iter < 2; iter++) {
            for (let i = N - 1; i >= 0; i--) {
                const nextIdx = (i + 1) % N;
                const distance = dist(optPoints[i], optPoints[nextIdx]);
                const brakeCap = Math.sqrt(velocities[nextIdx] * velocities[nextIdx] + 2.0 * a_decel_arr[i] * distance);
                velocities[i] = Math.min(velocities[i], brakeCap);
            }
        }
        for (let iter = 0; iter < 2; iter++) {
            for (let i = 0; i < N; i++) {
                const nextIdx = (i + 1) % N;
                const distance = dist(optPoints[i], optPoints[nextIdx]);
                const accelCap = Math.sqrt(velocities[i] * velocities[i] + 2.0 * a_accel_arr[i] * distance);
                velocities[nextIdx] = Math.min(velocities[nextIdx], accelCap);
            }
        }

        const optProfilePoints: OptimizedPoint[] = optPoints.map((p, idx) => ({
            pointIndex: idx,
            x: p.x,
            y: p.y || 0,
            z: p.z,
            targetSpeed: velocities[idx]
        }));

        const nextLap = lapNumber + 1;
        await this.saveOptimizedProfile(trackId, optProfilePoints, nextLap);
        console.log(`[DATABASE] Saved evolution pass for Lap ${nextLap}`);
        return { points: optProfilePoints, nextLap };
    }
}
