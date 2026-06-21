// @ts-ignore
import * as http from 'http';
// @ts-ignore
import { IncomingMessage, ServerResponse } from 'http';
// @ts-ignore
import { TrajectoryOptimizer } from './backend-optimizer.ts';
import type { TelemetryPoint, OptimizedPoint, TrackPoint, VehicleTelemetry } from './backend-optimizer.ts';
const PORT = 3001;
const optimizer = new TrajectoryOptimizer();

console.log('[BACKEND SERVER] Starting standalone API server...');

// @ts-ignore
const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
            // @ts-ignore
            req.on('data', (chunk: Buffer) => {
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

            // Map the incoming payload coordinates to TelemetryPoints and save to database
            const points: TelemetryPoint[] = payload.car_coordinates.map((coord, idx) => ({
                pointIndex: idx,
                x: coord.x,
                y: 0,
                z: coord.z,
                heading: 0,
                curvature: 0
            }));
            await optimizer.saveRawTrackData(trackId, lapNumber, points);

            let optProfilePoints: OptimizedPoint[] = [];
            if (lapNumber === 1) {
                console.log(`[API SERVER] Resetting optimization profile for track ${trackId} to start fresh at 30 km/h.`);
                await optimizer.resetTrackOptimizerState(trackId);
            } else {
                optProfilePoints = await optimizer.getLatestOptimizedProfile(trackId);
            }

            if (optProfilePoints.length === 0) {
                const centerline: TrackPoint[] = await optimizer.getRawTrackData(trackId, lapNumber);
                const optPoints = optimizer.optimizeTrajectory(centerline, 1.0, 0.20, 600, 0.02);
                const speedProfile = optPoints.map(() => 30 / 3.6);
                optProfilePoints = optPoints.map((p, idx) => ({
                    pointIndex: idx,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    targetSpeed: speedProfile[idx]
                }));
                await optimizer.saveOptimizedProfile(trackId, optProfilePoints, 1);
            }

            // 5. Send optimized profile coordinates and velocity targets back to client
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                trackId,
                points: optProfilePoints
            }));
            console.log(`[API SERVER] Successfully optimized trajectory for track ${trackId} (${optProfilePoints.length} points).`);
        } catch (err: any) {
            console.error('[API ERROR] Failed to run optimization:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Optimization Failed', details: err?.message }));
        }
    }
    else if (req.url === '/api/calibrate' && req.method === 'POST') {
        try {
            interface CalibrationPayload {
                trackId: string;
                lapNumber?: number;
                lap_number?: number;
                telemetry: VehicleTelemetry[];
                lapTime?: number;
                wasCrash?: boolean;
            }
            const payload = await parseJsonBody<CalibrationPayload>();
            const trackId = payload.trackId || 'monaco';
            const lapNumber = payload.lap_number !== undefined ? payload.lap_number : (payload.lapNumber || 1);
            const telemetry = payload.telemetry || [];
            const lapTime = payload.lapTime || 0;
            const wasCrash = payload.wasCrash || false;

            const centerline: TrackPoint[] = await optimizer.getRawTrackData(trackId, 1);
            const { points: calibratedPoints, nextLap } = await optimizer.calibrateProfile(
                centerline,
                telemetry,
                trackId,
                lapNumber,
                lapTime,
                wasCrash
            );

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                trackId,
                lapNumber,
                nextLap,
                points: calibratedPoints
            }));
            console.log(`[API SERVER] Iterative calibration completed for track ${trackId} (Lap ${lapNumber}).`);
        } catch (err: any) {
            console.error('[API ERROR] Iterative calibration failed:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Calibration Failed', details: err?.message }));
        }
    }
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
    }
});

server.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:3001`);
});
