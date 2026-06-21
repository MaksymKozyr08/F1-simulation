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

    constructor(config?: DatabaseConfig) {
        this.initializeDB(config);
    }

    private async initializeDB(config?: DatabaseConfig) {
        try {
            // @ts-ignore
            const { default: pkg } = await import('pg');
            const Pool = pkg.Pool;
            
            this.pgPool = new Pool({
                connectionString: config?.connectionString || 'postgresql://postgres:postgres@localhost:5432/f1_simulation',
                host: config?.host,
                port: config?.port,
                user: config?.user,
                password: config?.password,
                database: config?.database,
                max: 5,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });
            this.useDB = true;
            console.log('[DATABASE] PostgreSQL Pool established.');
            
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
                    point_index INT NOT NULL,
                    x DOUBLE PRECISION NOT NULL,
                    y DOUBLE PRECISION NOT NULL,
                    z DOUBLE PRECISION NOT NULL,
                    target_speed DOUBLE PRECISION NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (track_id, point_index)
                );
            `);
        } catch (err) {
            console.warn('[DATABASE] PostgreSQL init failed. Using RAM cache.', err);
            this.useDB = false;
        }
    }

    public async saveRawTrackData(trackId: string, lapNumber: number, points: TelemetryPoint[]): Promise<boolean> {
        if (!this.useDB || !this.pgPool) {
            RAM_RAW_TRACK_DB[`${trackId}_lap${lapNumber}`] = [...points];
            return true;
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
            RAM_RAW_TRACK_DB[`${trackId}_lap${lapNumber}`] = [...points];
            return false;
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

    public async saveOptimizedProfile(trackId: string, points: OptimizedPoint[]): Promise<boolean> {
        if (!this.useDB || !this.pgPool) {
            RAM_OPTIMIZED_PROFILE_DB[trackId] = [...points];
            return true;
        }
        try {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM optimized_race_profiles WHERE track_id = $1', [trackId]);
                for (const p of points) {
                    await client.query(
                        `INSERT INTO optimized_race_profiles (track_id, point_index, x, y, z, target_speed) 
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [trackId, p.pointIndex, p.x, p.y, p.z, p.targetSpeed]
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
            RAM_OPTIMIZED_PROFILE_DB[trackId] = [...points];
            return false;
        }
    }

    public async getOptimizedProfile(trackId: string): Promise<OptimizedPoint[]> {
        if (!this.useDB || !this.pgPool) {
            return RAM_OPTIMIZED_PROFILE_DB[trackId] || [];
        }
        try {
            const res = await this.pgPool.query(
                `SELECT point_index as "pointIndex", x, y, z, target_speed as "targetSpeed" 
                 FROM optimized_race_profiles 
                 WHERE track_id = $1 
                 ORDER BY point_index ASC`,
                [trackId]
            );
            return res.rows;
        } catch (err) {
            return RAM_OPTIMIZED_PROFILE_DB[trackId] || [];
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
            rawLimits[i] = Math.min(vLimit, maxV);
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
}
