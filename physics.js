/**
 * RWID Vehicle Physics Engine - Direct Wheel Steering & Precision 6-Degree Rollover Edition
 * Fully synchronized with custom developer UI dashboards.
 */

class RWIDVehiclePhysics {
    constructor() {
        // Factory baseline parameters used when custom toggle is disabled
        this.DEFAULTS = {
            m: 1300.0,       // mass (kg)
            rw: 0.285,       // wheel radius (m)
            B: 1.4375,       // track width (m)
            lf: 1.4373,      // CG to front axle distance (m)
            lr: 1.2247,      // CG to rear axle distance (m)
            Iz: 1808.0,      // yaw moment of inertia (kg*m^2)
            Iw: 1.85,        // wheel inertia (kg*m^2)
            h: 0.3,          // CG height (m)
            P_max: 800000.0, // Upgraded max motor power (W) to support 350 km/h
            s_thresh: 0.15,  // ASR/ABS slip threshold
            Kp: 400.0,       // PID Proportional gain
            Ki: 15.0,        // PID Integral gain
            Kd: 5.0,         // PID Derivative gain
            Cl: 2.5          // Aerodynamic Downforce Coefficient
        };

        this.g = 9.81; // Gravity constant

        // Persistent runtime state vectors
        this.state = {
            vx: 0.1,
            yawRate: 0.0,
            heading: 0.0,
            omegaLeft: 0.0,
            omegaRight: 0.0,
            sLeft: 0.0,
            sRight: 0.0,
            kLeft: 0.0,
            kRight: 0.0,
            T_left: 0.0,
            T_right: 0.0,
            deltaT: 0.0,
            pLoss: 0.0,
            asrActive: false,
            isFlipped: false
        };

        this.speedErrorIntegral = 0.0;
        this.prevSpeedError = 0.0;
    }

    /**
     * Core physics step execution handler.
     * @param {Object} controls - Includes UI inputs, sliders, and parameter dataset
     * @param {number} dt - Step duration delta (seconds)
     */
    update(controls, dt) {
        if (dt <= 0) return this.state;

        // Route parameter source depending on UI configuration switch status
        const p = controls.useCustomSettings ? controls.customParams : this.DEFAULTS;
        const Cl = p.Cl !== undefined ? p.Cl : 2.5;

        // Формула: V(км/год) = V(м/с) * 3.6
        let currentSpeedKMH = this.state.vx * 3.6;

        if (this.state.isFlipped) {
            // Формула: Omega = V_target / r_w
            this.state.omegaLeft = controls.targetSpeed / p.rw;
            this.state.omegaRight = controls.targetSpeed / p.rw;

            this.state.sLeft = 0.0;
            this.state.sRight = 0.0;
            this.state.kLeft = 0.0;
            this.state.kRight = 0.0;
            this.state.yawRate = 0.0;
            this.state.deltaT = 0.0;
            this.state.T_left = 0.0;
            this.state.T_right = 0.0;
            this.state.pLoss = 0.0;

            // Формула: F_drag = 0.5 * Cd * A * p * Vx^2
            let aerodynamicDrag = 0.5 * 0.3 * 2.0 * this.state.vx * this.state.vx;

            // Формула: F_roof = m * g * mu_roof
            let roofFrictionForce = p.m * this.g * 0.12;

            // Формула: ax = -(F_drag + F_roof) / m
            let ax = -(aerodynamicDrag + roofFrictionForce) / p.m;

            // Формула: Vx = Vx + ax * dt
            this.state.vx += ax * dt;
            if (this.state.vx < 0.1) this.state.vx = 0.1;

            return this.state;
        }
        // Формула: e = V_target - Vx
        let speedError = controls.targetSpeed - this.state.vx;

        // Формула: Integral = Integral + e * dt
        this.speedErrorIntegral += speedError * dt;
        let intLimit = 40.0;

        // Формула: Clamped_Integral = max(-40, min(40, Integral))
        this.speedErrorIntegral = Math.max(-intLimit, Math.min(intLimit, this.speedErrorIntegral));

        // Формула: de/dt = (e_current - e_previous) / dt
        let speedErrorDerivative = (speedError - this.prevSpeedError) / dt;
        this.prevSpeedError = speedError;

        // Формула: T_req = Kp * e + Ki * Integral + Kd * (de/dt)
        let T_req = p.Kp * speedError + p.Ki * this.speedErrorIntegral + p.Kd * speedErrorDerivative;

        let T_brake = 0.0;
        let brakingForceBody = 0.0;
        let isBraking = false;

        if (speedError < -2.0) {
            // Формула: T_brake = |T_req| * 2.0
            T_brake = Math.abs(T_req) * 2.0;
            T_brake = Math.min(T_brake, 8000.0);
            T_req = 0.0;
            isBraking = true;

            // Формула: F_brake_body = |e| * m * 0.45
            brakingForceBody = Math.abs(speedError) * p.m * 0.45;
            brakingForceBody = Math.min(brakingForceBody, 38000.0);
        }
        else if (speedError <= 0) {
            T_req = 0.0;
            // Формула: Integral = Integral * 0.5
            if (this.speedErrorIntegral > 0) this.speedErrorIntegral *= 0.5;
        }

        if (speedError > 0 && speedError < 4.0) {
            // Формула: factor = e / 4.0
            let approachFactor = speedError / 4.0;

            // Формула: T_req = T_req * factor^1.2
            T_req *= Math.pow(approachFactor, 1.2);
        }

        if (T_req > 0) {
            if (currentSpeedKMH < 100.0) {
                let steerFactor = Math.max(0.2, 1.0 - Math.abs(controls.steeringAngle) * 2.0);


                let launchFactor = 0.7 + (0.7 * (currentSpeedKMH / 100.0));

                // Формула: T_req = T_req * launchFactor * steerFactor
                T_req *= launchFactor * steerFactor;
            }
            else if (currentSpeedKMH >= 100.0 && currentSpeedKMH <= 250.0) {
                let steerFactor = Math.max(0.2, 1.0 - Math.abs(controls.steeringAngle) * 2.0);

                // Формула: T_req = T_req * 1.4 * steerFactor
                T_req *= 1.4 * steerFactor;
            }

            if (currentSpeedKMH > 250.0) {
                // Формула: limitFactor = max(0.12, 1.0 - (V_kmh - 250) / 100)
                let motorLimitFactor = Math.max(0.12, 1.0 - (currentSpeedKMH - 250.0) / 100.0);

                // Формула: T_req = T_req * limitFactor
                T_req *= motorLimitFactor;
            }
        }


        // Формула: L = lf + lr
        let wheelbase = p.lf + p.lr;

        // Формула: delta_effective = delta_wheels * 0.488
        let effectiveSteerRad = controls.steeringAngle * 0.488;
        let absSteerRad = Math.max(Math.abs(effectiveSteerRad), 0.0001);

        // Формула: R = L / |delta_effective|
        let turnRadius = wheelbase / absSteerRad;

        // Формула: ay = Vx^2 / R
        let ay = (this.state.vx * this.state.vx) / turnRadius; // Обчислює стаціонарне відцентрове прискорення. 

        // Формула: omega_z = (Vx / R) * sign(delta)
        this.state.yawRate = (this.state.vx / turnRadius) * Math.sign(controls.steeringAngle); // Визначає швидкість розвороту кузова боліда.

        // Формула: u_left = Vx - omega_z * (B / 2)
        let u_left = this.state.vx - this.state.yawRate * (p.B / 2.0);
        // Формула: u_right = Vx + omega_z * (B / 2)
        let u_right = this.state.vx + this.state.yawRate * (p.B / 2.0);

        // 3. Slip Ratio tracking processing
        // Формула: s = |u - omega * rw| / max(|u|, |omega * rw|, 0.001)
        this.state.sLeft = Math.abs(u_left - this.state.omegaLeft * p.rw) /
            Math.max(Math.abs(u_left), Math.abs(this.state.omegaLeft * p.rw), 0.001); // Коефіцієнт пробуксовки/блокування лівої шини.
        this.state.sRight = Math.abs(u_right - this.state.omegaRight * p.rw) /
            Math.max(Math.abs(u_right), Math.abs(this.state.omegaRight * p.rw), 0.001); // Коефіцієнт пробуксовки/блокування правої шини.

        // Формула: F_downforce = 0.5 * rho * Cl * A * Vx^2
        let F_downforce = 0.5 * 1.225 * Cl * 2.0 * this.state.vx * this.state.vx;

        // Формула: Fz_static_total = ((m * g * lr) / L) + F_downforce
        let Fz_static_total = ((p.m * this.g * p.lr) / (wheelbase)) + F_downforce;

        // Формула: Fz_static_wheel = Fz_static_total / 2
        let Fz_static_wheel = Fz_static_total / 2.0;

        // Формула: delta_Fz = (m * ay * h) / B
        let weightTransfer = (p.m * ay * p.h) / p.B;

        // Формула: ay_crit = g * B / (2 * h)
        let criticalRolloverThreshold = this.g * (p.B / (2.0 * p.h));

        // Формула: bonus = 1.0 + F_downforce / (m * g)
        let downforceBonus = 1.0 + (F_downforce / (p.m * this.g));

        // Порівняння: ay >= ay_crit * bonus
        if (ay >= (criticalRolloverThreshold * downforceBonus) && this.state.vx > 20.0) {
            this.state.isFlipped = true;
            return this.state;
        }

        // Формула: Fz_left = max(0, Fz_static_wheel - delta_Fz)
        let Fz_left = Math.max(0.0, Fz_static_wheel - weightTransfer);
        // Формула: Fz_right = max(0, Fz_static_wheel + delta_Fz)
        let Fz_right = Math.max(0.0, Fz_static_wheel + weightTransfer);
        let tireMult = 1.0;
        if (controls.tireType === 'Soft') tireMult = 1.2;
        if (controls.tireType === 'Hard') tireMult = 0.8;

        // Формула: tempFactor = max(0.5, 1.0 - 0.0004 * (T - 40)^2)
        let tempFactor = Math.max(0.5, 1.0 - 0.0004 * Math.pow(controls.trackTemp - 40.0, 2));

        // Формула: k = Fz * mu_base * mu_tire * tempFactor
        this.state.kLeft = Fz_left * controls.baseFriction * tireMult * tempFactor;
        this.state.kRight = Fz_right * controls.baseFriction * tireMult * tempFactor;

        let isTurningLeft = controls.steeringAngle < 0;
        let k_out = isTurningLeft ? this.state.kRight : this.state.kLeft;
        let k_in = isTurningLeft ? this.state.kLeft : this.state.kRight;
        let omega_out = isTurningLeft ? this.state.omegaRight : this.state.omegaLeft;
        let omega_in = isTurningLeft ? this.state.omegaLeft : this.state.omegaRight;

        let T_brake_left = T_brake / 2.0;
        let T_brake_right = T_brake / 2.0;
        let absTriggered = false;

        if (isBraking) {
            if (this.state.sLeft > p.s_thresh && this.state.omegaLeft < u_left / p.rw) {
                // Формула: T_brake_left = T_brake_left * 0.15
                T_brake_left *= 0.15;
                absTriggered = true;
            }
            if (this.state.sRight > p.s_thresh && this.state.omegaRight < u_right / p.rw) {
                // Формула: T_brake_right = T_brake_right * 0.15
                T_brake_right *= 0.15;
                absTriggered = true;
            }

            this.state.deltaT = 0.0;
            this.state.asrActive = absTriggered;

            // Формула: F_brake_body = F_brake_body * 0.8
            if (absTriggered) brakingForceBody *= 0.8;
        } else {
            if (this.state.sLeft < 0.1 && this.state.sRight < 0.1) {
                this.state.asrActive = false;

                // Формула: num = k_out * omega_in - k_in * omega_out
                let numerator = (k_out * omega_in) - (k_in * omega_out);
                // Формула: den = k_out * omega_in + k_in * omega_out
                let denominator = (k_out * omega_in) + (k_in * omega_out);

                // Формула: deltaT = (num / den) * T_req
                this.state.deltaT = denominator !== 0.0 ? (numerator / denominator) * T_req : 0.0;
            }
            else if (this.state.sLeft > p.s_thresh || this.state.sRight > p.s_thresh) {
                this.state.deltaT = 0.0;

                // Формула: T_req = T_req * 0.35
                T_req *= 0.35;
                this.state.asrActive = true;
            } else {
                let numerator = (k_out * omega_in) - (k_in * omega_out);
                let denominator = (k_out * omega_in) + (k_in * omega_out);
                this.state.deltaT = denominator !== 0.0 ? (numerator / denominator) * T_req : 0.0;
                this.state.asrActive = false;
            }

            if (isTurningLeft) {
                // Формула: T_left = T_req / 2 - deltaT,  T_right = T_req / 2 + deltaT
                this.state.T_left = (T_req / 2.0) - this.state.deltaT;
                this.state.T_right = (T_req / 2.0) + this.state.deltaT;
            } else {
                // Формула: T_left = T_req / 2 + deltaT,  T_right = T_req / 2 - deltaT
                this.state.T_left = (T_req / 2.0) + this.state.deltaT;
                this.state.T_right = (T_req / 2.0) - this.state.deltaT;
            }

            if (Math.abs(this.state.T_left * this.state.omegaLeft) > p.P_max) {
                // Формула: T_left = (P_max / |omega|) * sign(T)
                this.state.T_left = (p.P_max / Math.max(0.1, Math.abs(this.state.omegaLeft))) * Math.sign(this.state.T_left);
            }
            if (Math.abs(this.state.T_right * this.state.omegaRight) > p.P_max) {
                // Формула: T_right = (P_max / |omega|) * sign(T)
                this.state.T_right = (p.P_max / Math.max(0.1, Math.abs(this.state.omegaRight))) * Math.sign(this.state.T_right);
            }
        }

        // Формула: Fx = k * s * sign(omega * rw - u)
        let Fx_left = this.state.kLeft * this.state.sLeft * Math.sign(this.state.omegaLeft * p.rw - u_left); // Поздовжня сила штовхання лівої шини об землю.
        let Fx_right = this.state.kRight * this.state.sRight * Math.sign(this.state.omegaRight * p.rw - u_right); // Поздовжня сила штовхання правої шини об землю.

        // Формула: omegaDot = (T_motor - Fx * rw - T_brake * sign(omega)) / Iw
        let omegaDot_left = (this.state.T_left - Fx_left * p.rw - T_brake_left * Math.sign(this.state.omegaLeft)) / p.Iw; // Динаміка обертання лівого колісного диска.
        let omegaDot_right = (this.state.T_right - Fx_right * p.rw - T_brake_right * Math.sign(this.state.omegaRight)) / p.Iw; // Динаміка обертання правого колісного диска.

        // Формула: omega = omega + omegaDot * dt
        this.state.omegaLeft += omegaDot_left * dt; // Оновлює кутові оберти лівого колеса на основі балансу моментів.
        this.state.omegaRight += omegaDot_right * dt; // Оновлює кутові оберти правого колеса на основі балансу моментів.

        if (this.state.omegaLeft < 0) this.state.omegaLeft = 0;
        if (this.state.omegaRight < 0) this.state.omegaRight = 0;

        // 9. Process active energy loss tracking
        // Формула: pLoss = Fx * (omega * rw - u)
        let pLossLeft = Fx_left * (this.state.omegaLeft * p.rw - u_left);
        let pLossRight = Fx_right * (this.state.omegaRight * p.rw - u_right);

        // Формула: pLoss_total = max(0, pLossLeft + pLossRight)
        this.state.pLoss = Math.max(0.0, pLossLeft + pLossRight);

        // Формула: F_drag = 0.5 * Cd * A * p * Vx^2
        let aerodynamicDrag = 0.5 * 0.3 * 2.0 * this.state.vx * this.state.vx;

        // Формула: ax = (Fx_left + Fx_right - F_drag - F_brake_body) / m
        let ax = (Fx_left + Fx_right - aerodynamicDrag - brakingForceBody) / p.m;

        // Формула: Vx = Vx + ax * dt
        this.state.vx += ax * dt;
        if (this.state.vx < 0.1) this.state.vx = 0.1;

        // Формула: Heading = Heading + yawRate * dt
        this.state.heading += this.state.yawRate * dt;

        return this.state;
    }

    /**
     * Clear active memory cache registers during tracking state resets
     */
    reset() {
        this.speedErrorIntegral = 0.0;
        this.prevSpeedError = 0.0;
        this.state.vx = 0.1;
        this.state.yawRate = 0.0;
        this.state.heading = 0.0;
        this.state.omegaLeft = 0.0;
        this.state.omegaRight = 0.0;
        this.state.pLoss = 0.0;
        this.state.asrActive = false;
        this.state.isFlipped = false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RWIDVehiclePhysics;
}