// @ts-ignore
import * as http from 'http';
// @ts-ignore
import { IncomingMessage, ServerResponse } from 'http';
import { TrajectoryOptimizer, TelemetryPoint, OptimizedPoint, TrackPoint } from './backend-optimizer';

const PORT = 3001;
const optimizer = new TrajectoryOptimizer();

console.log('[BACKEND SERVER] Starting standalone API server...');

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS for preflight and standard requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parseJsonBody = <T>(): Promise<T> => {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: any) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body) as T);
                } catch (e) {
                    reject(e);
                }
            });
        });
    };

    interface OptimizationTelemetryPayload {
        trackId: string;
        lap_number: number;
        car_coordinates: { x: number; z: number }[];
        velocity_profile: number[];
        timestamp: string;
    }

    if (req.url === '/api/telemetry' && req.method === 'POST') {
        try {
            const payload = await parseJsonBody<OptimizationTelemetryPayload>();
            const trackId = payload.trackId || 'monaco';
            const lapNumber = payload.lap_number || 1;
            
            // Map the parsed payload coordinates to TelemetryPoints
            const points: TelemetryPoint[] = payload.car_coordinates.map((coord, idx) => ({
                pointIndex: idx,
                x: coord.x,
                y: 0,
                z: coord.z,
                heading: 0,
                curvature: 0
            }));
            
            const success = await optimizer.saveRawTrackData(trackId, lapNumber, points);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success }));
        } catch (err: any) {
            console.error('[API ERROR] Failed to save telemetry:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database/Server Error', details: err?.message }));
        }
    } 
    else if (req.url === '/api/optimize' && req.method === 'POST') {
        try {
            const payload = await parseJsonBody<OptimizationTelemetryPayload>();
            const trackId = payload.trackId || 'monaco';
            const lapNumber = payload.lap_number || 1;
            
            // 1. Fetch raw centerline points from PostgreSQL database
            let centerline: TrackPoint[] = await optimizer.getRawTrackData(trackId, lapNumber);
            
            // Fallback to coordinates provided in the payload if database query returned empty
            if (!centerline || centerline.length === 0) {
                console.log(`[API SERVER] Centerline not found in database for track ${trackId}. Using payload fallback.`);
                centerline = payload.car_coordinates.map(pt => ({
                    x: pt.x,
                    y: 0,
                    z: pt.z,
                    heading: 0,
                    curvature: 0
                }));
            }

            // 2. Perform path optimization (Elastic Line Optimizer)
            const optPoints = optimizer.optimizeTrajectory(centerline, 1.0, 0.20, 600, 0.02);

            // 3. Generate speed limits (Velocity Profile)
            const speedProfile = optimizer.generateSpeedProfile(optPoints, 0.80, 320, 8.5, 22.0);

            // 4. Save optimized profile back to optimized_race_profiles table
            const optProfilePoints: OptimizedPoint[] = optPoints.map((p, idx) => ({
                pointIndex: idx,
                x: p.x,
                y: p.y,
                z: p.z,
                targetSpeed: speedProfile[idx]
            }));
            await optimizer.saveOptimizedProfile(trackId, optProfilePoints);

            // 5. Send optimized profile coordinates and velocity targets back to client
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                trackId,
                points: optProfilePoints
            }));
            console.log(`[API SERVER] Successfully optimized trajectory for track ${trackId} (${optPoints.length} points).`);
        } catch (err: any) {
            console.error('[API ERROR] Failed to run optimization:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Optimization Failed', details: err?.message }));
        }
    } 
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
    }
});

server.listen(PORT, () => {
    console.log(`[BACKEND SERVER] Standalone Node.js API server listening on http://localhost:${PORT}`);
});
