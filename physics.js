/**
 * RWID Vehicle Physics Engine - Steady-State Cornering & Analytical Rollover Edition
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

        // Поточна швидкість у км/год
        let currentSpeedKMH = this.state.vx * 3.6;

        // =====================================================================
        // ПРАВИЛО ЛОГІКИ АВАРІЇ (Машина перевернута, колеса обертаються в повітрі)
        // =====================================================================
        if (this.state.isFlipped) {
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

            // Інерційне сповільнення кузова на даху об повітря та асфальт
            let aerodynamicDrag = 0.5 * 0.3 * 2.0 * this.state.vx * this.state.vx;
            let roofFrictionForce = p.m * this.g * 0.12;

            let ax = -(aerodynamicDrag + roofFrictionForce) / p.m;
            this.state.vx += ax * dt;
            if (this.state.vx < 0.1) this.state.vx = 0.1;

            return this.state;
        }

        // 1. РОЗРАХУНОК ВОДІЯ ТА СИСТЕМИ КРУЇЗ-КОНТРОЛЮ (PID & Smart Governor)
        let speedError = controls.targetSpeed - this.state.vx;

        this.speedErrorIntegral += speedError * dt;
        let intLimit = 40.0;
        this.speedErrorIntegral = Math.max(-intLimit, Math.min(intLimit, this.speedErrorIntegral));

        let speedErrorDerivative = (speedError - this.prevSpeedError) / dt;
        this.prevSpeedError = speedError;

        let T_req = p.Kp * speedError + p.Ki * this.speedErrorIntegral + p.Kd * speedErrorDerivative;

        let T_brake = 0.0;
        let brakingForceBody = 0.0;
        let isBraking = false;

        if (speedError < -2.0) {
            T_brake = Math.abs(T_req) * 2.0;
            T_brake = Math.min(T_brake, 8000.0);
            T_req = 0.0;
            isBraking = true;

            brakingForceBody = Math.abs(speedError) * p.m * 0.45;
            brakingForceBody = Math.min(brakingForceBody, 38000.0);
        }
        else if (speedError <= 0) {
            T_req = 0.0;
            if (this.speedErrorIntegral > 0) this.speedErrorIntegral *= 0.5;
        }

        if (speedError > 0 && speedError < 4.0) {
            let approachFactor = speedError / 4.0;
            T_req *= Math.pow(approachFactor, 1.2);
        }

        if (T_req > 0) {
            if (currentSpeedKMH < 100.0) {
                T_req *= 0.45;
            } else if (currentSpeedKMH >= 100.0 && currentSpeedKMH <= 200.0) {
                let steerFactor = Math.max(0.2, 1.0 - Math.abs(controls.steeringAngle) * 2.0);
                T_req *= 1.4 * steerFactor;
            }

            if (currentSpeedKMH > 300.0) {
                let motorLimitFactor = Math.max(0.15, 1.0 - (currentSpeedKMH - 300.0) / 50.0);
                T_req *= motorLimitFactor;
            }
        }

        // 2. СТАЦІОНАРНА КІНЕМАТИКА ПОВОРОТУ ТА БІЧНОГО ПРИСКОРЕННЯ (Steady-State Dynamics)
        // Вираховуємо радіус повороту на основі геометрії колісної бази та кута керма
        let wheelbase = p.lf + p.lr;
        let absSteerRad = Math.max(Math.abs(controls.steeringAngle), 0.0001);
        let turnRadius = wheelbase / absSteerRad;

        // Чисте відцентрове прискорення за формулою Ньютона (vx^2 / R) - стабільне, без накопичення!
        let ay = (this.state.vx * this.state.vx) / turnRadius;

        // Напрямок кутового обертання рискання (Yaw Rate) тепер жорстко прив'язаний до радіуса
        this.state.yawRate = (this.state.vx / turnRadius) * Math.sign(controls.steeringAngle);

        let u_left = this.state.vx - this.state.yawRate * (p.B / 2.0);
        let u_right = this.state.vx + this.state.yawRate * (p.B / 2.0);

        // 3. Slip Ratio tracking processing
        this.state.sLeft = Math.abs(u_left - this.state.omegaLeft * p.rw) /
            Math.max(Math.abs(u_left), Math.abs(this.state.omegaLeft * p.rw), 0.001);
        this.state.sRight = Math.abs(u_right - this.state.omegaRight * p.rw) /
            Math.max(Math.abs(u_right), Math.abs(this.state.omegaRight * p.rw), 0.001);

        // 4. АЕРОДИНАМІЧНА ПРИТИСКНА СИЛА ТА АНАЛІТИЧНИЙ РОЗРАХУНОК rollover
        let F_downforce = 0.5 * 1.225 * Cl * 2.0 * this.state.vx * this.state.vx;
        let Fz_static_total = ((p.m * this.g * p.lr) / (wheelbase)) + F_downforce;
        let Fz_static_wheel = Fz_static_total / 2.0;

        // Динамічне перенесення ваги від стабільного відцентрового прискорення
        let weightTransfer = (p.m * ay * p.h) / p.B;

        // ПРАВИЛО: Статичний інженерний ліміт перевертання (Static Rollover Threshold)
        // Машина робить кульбіт тільки якщо чисте центробіжне прискорення ay пробиває поріг утримання колії (g * B / 2h)
        let criticalRolloverThreshold = this.g * (p.B / (2.0 * p.h)); // ~23.5 м/с^2 для базового шасі

        // Модифікуємо поріг з урахуванням притискної сили (Downforce міцніше тримає болід на швидкості)
        let downforceBonus = 1.0 + (F_downforce / (p.m * this.g));

        if (ay >= (criticalRolloverThreshold * downforceBonus) && this.state.vx > 20.0) {
            this.state.isFlipped = true;
            return this.state; // Перевертаємося миттєво
        }

        // Розрахунок реального зчеплення з дорогою (Normal Forces)
        let Fz_left = Math.max(0.0, Fz_static_wheel - weightTransfer);
        let Fz_right = Math.max(0.0, Fz_static_wheel + weightTransfer);

        // Корекція тертя
        let tireMult = 1.0;
        if (controls.tireType === 'Soft') tireMult = 1.2;
        if (controls.tireType === 'Hard') tireMult = 0.8;
        let tempFactor = Math.max(0.5, 1.0 - 0.0004 * Math.pow(controls.trackTemp - 40.0, 2));

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

        // 5. АКТИВНА СТАБІЛІЗАЦІЯ, АНТИБУКС (ASR) ТА АНТИБЛОКУВАЛЬНА СИСТЕМА (ABS)
        if (isBraking) {
            if (this.state.sLeft > p.s_thresh && this.state.omegaLeft < u_left / p.rw) {
                T_brake_left *= 0.15;
                absTriggered = true;
            }
            if (this.state.sRight > p.s_thresh && this.state.omegaRight < u_right / p.rw) {
                T_brake_right *= 0.15;
                absTriggered = true;
            }

            this.state.deltaT = 0.0;
            this.state.asrActive = absTriggered;
            if (absTriggered) brakingForceBody *= 0.8;
        } else {
            if (this.state.sLeft < 0.1 && this.state.sRight < 0.1) {
                this.state.asrActive = false;
                let numerator = (k_out * omega_in) - (k_in * omega_out);
                let denominator = (k_out * omega_in) + (k_in * omega_out);
                this.state.deltaT = denominator !== 0.0 ? (numerator / denominator) * T_req : 0.0;
            }
            else if (this.state.sLeft > p.s_thresh || this.state.sRight > p.s_thresh) {
                this.state.deltaT = 0.0;
                T_req *= 0.35;
                this.state.asrActive = true;
            } else {
                let numerator = (k_out * omega_in) - (k_in * omega_out);
                let denominator = (k_out * omega_in) + (k_in * omega_out);
                this.state.deltaT = denominator !== 0.0 ? (numerator / denominator) * T_req : 0.0;
                this.state.asrActive = false;
            }

            if (isTurningLeft) {
                this.state.T_left = (T_req / 2.0) - this.state.deltaT;
                this.state.T_right = (T_req / 2.0) + this.state.deltaT;
            } else {
                this.state.T_left = (T_req / 2.0) + this.state.deltaT;
                this.state.T_right = (T_req / 2.0) - this.state.deltaT;
            }

            if (Math.abs(this.state.T_left * this.state.omegaLeft) > p.P_max) {
                this.state.T_left = (p.P_max / Math.max(0.1, Math.abs(this.state.omegaLeft))) * Math.sign(this.state.T_left);
            }
            if (Math.abs(this.state.T_right * this.state.omegaRight) > p.P_max) {
                this.state.T_right = (p.P_max / Math.max(0.1, Math.abs(this.state.omegaRight))) * Math.sign(this.state.T_right);
            }
        }

        // 7. Output dynamic road contact tractive forces
        let Fx_left = this.state.kLeft * this.state.sLeft * Math.sign(this.state.omegaLeft * p.rw - u_left);
        let Fx_right = this.state.kRight * this.state.sRight * Math.sign(this.state.omegaRight * p.rw - u_right);

        // 8. РОЗРАХУНОК КУТОВИХ ШВИДКОСТЕЙ КОЛЕС
        let omegaDot_left = (this.state.T_left - Fx_left * p.rw - T_brake_left * Math.sign(this.state.omegaLeft)) / p.Iw;
        let omegaDot_right = (this.state.T_right - Fx_right * p.rw - T_brake_right * Math.sign(this.state.omegaRight)) / p.Iw;

        this.state.omegaLeft += omegaDot_left * dt;
        this.state.omegaRight += omegaDot_right * dt;

        if (this.state.omegaLeft < 0) this.state.omegaLeft = 0;
        if (this.state.omegaRight < 0) this.state.omegaRight = 0;

        // 9. Process active energy loss tracking
        let pLossLeft = Fx_left * (this.state.omegaLeft * p.rw - u_left);
        let pLossRight = Fx_right * (this.state.omegaRight * p.rw - u_right);
        this.state.pLoss = Math.max(0.0, pLossLeft + pLossRight);

        // 10. РУХ КУЗОВА: ВІДНІМАННЯ ОПОРУ ПОВІТРЯ ТА СИЛИ КОЛОДОК
        let aerodynamicDrag = 0.5 * 0.3 * 2.0 * this.state.vx * this.state.vx;

        let ax = (Fx_left + Fx_right - aerodynamicDrag - brakingForceBody) / p.m;
        this.state.vx += ax * dt;
        if (this.state.vx < 0.1) this.state.vx = 0.1;

        // Оновлення курсу на основі стабільної швидкості розвороту
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