/**
 * Vehicle sound, synthesised per sample in an AudioWorklet.
 *
 * Loaded by `useEngineSound` with `audioWorklet.addModule('/audio/engine-processor.js')`.
 * Plain JavaScript on purpose: worklet modules are fetched by the browser as-is
 * and run off the main thread, outside the bundle.
 *
 * ## Why a model and not oscillators
 *
 * An engine is not a tone; it is a train of exhaust pulses, and everything you
 * hear is what happens to those pulses on the way out. The first synthesised
 * voice was a sawtooth, a square and a sine into a lowpass — a buzzer, and at
 * a V12's 700 Hz firing frequency a buzzer whose harmonics sit exactly where
 * the ear hurts. So this fires cylinders off a modelled crank and lets the
 * exhaust do the rest.
 *
 * ## The layers
 *
 *   combustion   each cylinder, at its crank angle, kicks a pressure pulse —
 *                sharp rise, exponential fall — into its bank of the exhaust.
 *                Cylinders keep a fixed timing and strength offset each, so an
 *                uneven engine is uneven the same way every revolution: that
 *                is what a cross-plane V8's lump IS.
 *   exhaust      two banks (left and right pipes), each a set of resonators at
 *                the pipe's frequency and overtones plus a muffler — a short
 *                comb with feedback — that gives a road car its body and is
 *                nearly absent on a race exhaust. The banks go to different
 *                stereo sides, so a V8 has width.
 *   intake       a roar under load: noise through a bandpass that tracks the
 *                firing frequency, and the pulses themselves lowpassed.
 *   mechanical   a tick per firing (valvetrain), sharp and quiet — or, for a
 *                diesel, the injection knock, which is the same thing loud.
 *   blower       a supercharger whine: rotor lobes times pulley ratio times
 *                rpm, two harmonics, only under load. `blower`.
 *   turbo        boost that spools up behind the load with a lag, a whistle
 *                that climbs with it, and a blow-off hiss when the throttle
 *                shuts with boost in the pipe. `turbo`.
 *   overrun      throttle shut, revs falling: cylinders miss and the next one
 *                pops. How much depends on `pops` — a race exhaust crackles,
 *                a muffled saloon barely mutters.
 *   rattle       loose tinware, for an engine that has seen better days.
 *   road         tyre roar rising with speed, wind above it, the skid when
 *                the tyres let go (`slip`), and the brakes while the pedal
 *                is down (`brake`) — a rough rubber scrub, GTA-style.
 *   cockpit      the same engine heard from inside: exhaust muffled, intake
 *                and mechanical up. `cockpit` 0..1, from the camera mode.
 *
 * A soft clip at the end of each channel keeps a hard-driven engine loud and
 * round rather than loud and sharp. Every level is deliberately modest; the
 * main thread adds a lowpass and a limiter after this.
 *
 * Messages on the port: `{ shift: true }` on a gear change (a clunk and, on a
 * race exhaust, a crackle).
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TAU = Math.PI * 2;

/** Bandpass biquad, constant 0 dB peak, transposed direct form II. */
class Bandpass {
  constructor(freq, q) { this.z1 = 0; this.z2 = 0; this.set(freq, q); }
  set(freq, q) {
    const w = TAU * Math.min(Math.max(freq, 10), sampleRate * 0.45) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0; this.a2 = (1 - alpha) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = -this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One-pole lowpass. */
class Lowpass {
  constructor(freq) { this.y = 0; this.set(freq); }
  set(freq) { this.k = 1 - Math.exp(-TAU * Math.min(Math.max(freq, 5), sampleRate * 0.45) / sampleRate); }
  run(x) { this.y += this.k * (x - this.y); return this.y; }
}

/** One-pole highpass. */
class Highpass {
  constructor(freq) { this.lp = new Lowpass(freq); }
  set(freq) { this.lp.set(freq); }
  run(x) { return x - this.lp.run(x); }
}

/** A short delay line with feedback and a lowpass in the loop: a muffler. */
class Comb {
  constructor(maxSec) {
    this.buf = new Float32Array(Math.ceil(maxSec * sampleRate) + 2);
    this.w = 0; this.delay = 100; this.fb = 0.4; this.damp = new Lowpass(1500);
  }
  set(delaySec, fb, dampHz) { this.delay = Math.max(2, Math.min(this.buf.length - 2, Math.round(delaySec * sampleRate))); this.fb = fb; this.damp.set(dampHz); }
  run(x) {
    let r = this.w - this.delay; if (r < 0) r += this.buf.length;
    const d = this.buf[r];
    const y = x + this.damp.run(d) * this.fb;
    this.buf[this.w] = y;
    if (++this.w >= this.buf.length) this.w = 0;
    return y;
  }
}

/** One exhaust bank: a pipe. */
class Pipe {
  constructor(pipeHz, detune, muffle, brightness) {
    this.res = [
      new Bandpass(pipeHz * detune, 3),
      new Bandpass(pipeHz * detune * 2.02, 4),
      new Bandpass(pipeHz * detune * 3.1, 5),
      new Bandpass(pipeHz * detune * 4.6, 6),
    ];
    this.gain = [1, 0.6, 0.35, 0.18 * brightness];
    this.comb = new Comb(0.03);
    // A quarter wave of the pipe's own frequency; more feedback and more
    // damping the more muffled the car.
    this.comb.set(0.5 / (pipeHz * detune), 0.15 + muffle * 0.5, 2500 - muffle * 1800);
    this.tone = new Lowpass(1500);
  }
  run(x) {
    let y = x * 0.5;
    for (let k = 0; k < 4; k++) y += this.res[k].run(x) * this.gain[k];
    return this.tone.run(this.comb.run(y));
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 24000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'speed', defaultValue: 0, minValue: 0, maxValue: 200, automationRate: 'k-rate' },
      { name: 'slip', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cockpit', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'brake', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const p = Object.assign({
      cylinders: 8, pipeHz: 110, uneven: 0.3, grit: 0.4, brightness: 0.6, muffle: 0.4,
      pops: 0.4, blower: 0, turbo: 0, diesel: false, rattle: 0, idleRpm: 900, topSpeed: 60,
    }, options && options.processorOptions);
    this.p = p;

    let seed = 0x9e3779b9;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 - 0.5; };
    this.rnd = rnd;

    // Cylinders: firing angle as a fraction of the four-stroke cycle, a bank,
    // and a fixed personality. Firing order alternates banks, as a V does.
    this.cyl = [];
    for (let i = 0; i < p.cylinders; i++) {
      this.cyl.push({
        angle: i / p.cylinders + rnd() * 0.03 * p.uneven,
        gain: 1 + rnd() * 1.0 * p.uneven,
        bank: p.cylinders > 4 ? i % 2 : 0,
        pulse: 0, env: 0, // active pressure pulse: envelope and its decay state
      });
    }
    this.phase = 0;
    this.lastRpm = p.idleRpm;

    // Exhaust: two pipes, a shade apart so they beat.
    this.pipeA = new Pipe(p.pipeHz, 1.0, p.muffle, p.brightness);
    this.pipeB = new Pipe(p.pipeHz, 1.035, p.muffle, p.brightness);

    // Intake.
    this.intakeBp = new Bandpass(300, 1.5);
    this.intakeLp = new Lowpass(250);
    // Mechanical.
    this.tickHp = new Highpass(1800);
    // Everything that is not the exhaust shares one bus, and the bus is kept
    // out of the top: hiss, ticks and whine all live below here.
    this.centreLp = new Lowpass(2800);
    this.tickEnv = 0;
    this.knock = new Bandpass(p.diesel ? 1900 : 3200, 6);
    // Noise sources.
    this.pink = new Lowpass(1600);
    this.pinkHp = new Highpass(80);
    // Blower and turbo.
    this.blowerPhase = 0;
    this.boost = 0;         // 0..1, lags load
    this.turboPhase = 0;
    this.blowOff = 0;       // hiss envelope
    this.blowOffBp = new Bandpass(2200, 2);
    // Overrun and misfire.
    this.misfire = 0;
    this.crackle = 0;       // extra pop chance after a shift, seconds
    // Rattle.
    this.rattleEnv = 0; this.rattleBp = new Bandpass(3100, 8);
    // Road.
    this.tyreLp = new Lowpass(500);
    this.windBp = new Bandpass(700, 0.8);
    this.skidBp = new Bandpass(1100, 5);
    this.skidWob = 0;
    // Brakes, the arcade way: not a pad squeal (a narrow bandpass on noise is
    // a whistle, and it was) but the tyre — a rough, stuttering rubber scrub
    // in the low mids, the sound every GTA brake makes. Wide bandpass for the
    // body, a lowpass for the weight, and a slow noise to make it judder.
    this.brakeBp = new Bandpass(820, 1.1);
    this.brakeLp = new Lowpass(260);
    this.brakeFlutter = new Lowpass(38);
    this.brakeWob = 0;
    // Shift clunk.
    this.clunk = 0; this.clunkLp = new Lowpass(160);
    // Cockpit muffling of the exhaust.
    this.cabinL = new Lowpass(900); this.cabinR = new Lowpass(900);

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.shift) { this.clunk = 1; this.crackle = 0.25 * p.pops; }
    };
  }

  process(inputs, outputs, params) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outL;
    if (!outL) return true;
    const p = this.p;
    const rpm = Math.max(0, params.rpm[0]);
    const load = Math.min(1, Math.max(0, params.load[0]));
    const speed = Math.max(0, params.speed[0]);
    const slip = Math.min(1, Math.max(0, params.slip[0]));
    const cockpit = Math.min(1, Math.max(0, params.cockpit[0]));
    const brake = Math.min(1, Math.max(0, params.brake[0]));
    const n = outL.length;
    const dt = 1 / sampleRate;

    const cycleHz = rpm / 60 / 2;                // a cylinder fires once per two turns
    const firingHz = cycleHz * p.cylinders;
    const dPhase = cycleHz / sampleRate;

    // Combustion pulse: a fast rise, then a decay that shortens with rpm so
    // pulses stay separate until they merge into a tone on their own.
    const decaySec = Math.min(0.004, 0.45 / Math.max(firingHz, 1));
    const decay = Math.exp(-dt / decaySec);
    const attack = 1 - Math.exp(-dt / 0.0006);

    // Overrun: throttle shut with revs falling. Race pipes crackle.
    const falling = rpm < this.lastRpm - 0.3;
    this.lastRpm = rpm;
    const overrun = load < 0.1 && rpm > p.idleRpm * 1.6 && falling;
    const missChance = overrun ? 0.12 + 0.3 * p.pops : (this.crackle > 0 ? 0.35 * p.pops : 0);
    this.crackle = Math.max(0, this.crackle - n * dt);

    // Turbo: boost lags load and needs revs; blow-off when it collapses.
    if (p.turbo > 0) {
      const target = load * Math.min(1, rpm / 4000);
      const rate = target > this.boost ? 1.4 : 4.5;
      const next = this.boost + (target - this.boost) * Math.min(1, rate * n * dt);
      if (this.boost - next > 0.012 && this.boost > 0.4) this.blowOff = Math.max(this.blowOff, this.boost);
      this.boost = next;
    }

    // Tone. Brighter under load; diesels stay dark; cockpit shuts it down.
    // Capped well under 3 kHz: what opens above that is not "bright", it is
    // the band the ear is most sensitive to, and it was the whole complaint.
    const open = 700 + load * p.brightness * (p.diesel ? 1000 : 1900);
    this.pipeA.tone.set(open); this.pipeB.tone.set(open);
    this.cabinL.set(900 - cockpit * 350); this.cabinR.set(900 - cockpit * 350);
    this.intakeBp.set(Math.max(80, firingHz * 0.5), 1.5);

    // Levels.
    const exhaustLevel = (0.5 + load * 0.5) * (1 - cockpit * 0.55);
    const intakeLevel = (0.04 + load * 0.5) * p.grit * (1 + cockpit * 0.8);
    const tickLevel = (p.diesel ? 0.3 : 0.02 + 0.02 * p.grit) * (1 + cockpit * 0.6) * Math.min(1, rpm / 1500);
    const gritLevel = p.grit * (0.02 + load * 0.08);
    const speedRatio = Math.min(1, speed / Math.max(p.topSpeed, 1));
    const tyreLevel = Math.sqrt(speedRatio) * 0.09 * (1 - cockpit * 0.4);
    const windLevel = speedRatio * speedRatio * 0.16 * (1 - cockpit * 0.6);
    this.windBp.set(400 + speedRatio * 1200, 0.8);
    const skidLevel = slip * slip * 0.35 * (1 - cockpit * 0.3);
    // Gone at a standstill; full from a brisk jog up.
    const brakeLevel = brake * Math.min(1, speed / 9) * 0.5 * (1 - cockpit * 0.25);
    const blowerHz = rpm / 60 * 2.6 * 3;         // pulley ratio x lobes
    const blowerLevel = p.blower * (0.02 + load * 0.09) * Math.min(1, rpm / 2000);
    const turboHz = 600 + this.boost * 1900;
    const turboLevel = p.turbo * this.boost * 0.05;
    const level = 0.32 + load * 0.28 + Math.min(0.1, rpm / 70000);
    const drive = 1.3 + load * 1.2;

    for (let i = 0; i < n; i++) {
      // --- crank: fire whatever we pass -----------------------------------
      const before = this.phase;
      this.phase += dPhase;
      const wrapped = this.phase >= 1;
      if (wrapped) this.phase -= 1;
      let kick = 0; // for the valvetrain tick
      for (const c of this.cyl) {
        const hit = wrapped ? (c.angle >= before || c.angle < this.phase) : (c.angle >= before && c.angle < this.phase);
        if (hit) {
          if (missChance > 0 && Math.random() < missChance) { this.misfire = Math.min(2, this.misfire + 1); kick = 0.3; }
          else {
            const pop = this.misfire > 0 ? 1.6 + 0.6 * this.misfire : 1;
            this.misfire = 0;
            c.pulse = (0.5 + load * 0.5) * c.gain * pop * (1 + (Math.random() - 0.5) * 0.15);
            c.env = 0;
            kick = 1;
          }
        }
        // Pressure envelope: rise toward the pulse, then fall.
        if (c.pulse > 0) {
          c.env += (c.pulse - c.env) * attack;
          c.pulse *= decay;
          if (c.pulse < 1e-4) { c.pulse = 0; c.env = 0; }
        }
      }
      let bankA = 0, bankB = 0;
      for (const c of this.cyl) { if (c.bank) bankB += c.env; else bankA += c.env; }
      if (kick) this.tickEnv = Math.max(this.tickEnv, kick);

      // --- noise sources -------------------------------------------------
      const white = Math.random() * 2 - 1;
      const pink = this.pinkHp.run(this.pink.run(white));

      // --- exhaust, two pipes -------------------------------------------
      let exL = this.pipeA.run(bankA) * exhaustLevel;
      let exR = this.pipeB.run(bankB) * exhaustLevel;
      if (cockpit > 0) { exL = this.cabinL.run(exL); exR = this.cabinR.run(exR); }

      // --- intake and mechanical -------------------------------------------
      const intake = this.intakeBp.run(white) * intakeLevel + this.intakeLp.run(bankA + bankB) * load * 0.3 * p.grit;
      this.tickEnv *= 0.994;
      const tick = (p.diesel ? this.knock.run(white) : this.tickHp.run(white)) * this.tickEnv * tickLevel;
      const grit = pink * gritLevel;

      // --- blower and turbo -----------------------------------------------
      let forced = 0;
      if (blowerLevel > 0) {
        this.blowerPhase += blowerHz * dt; if (this.blowerPhase > 1) this.blowerPhase -= 1;
        forced += (Math.sin(TAU * this.blowerPhase) + 0.4 * Math.sin(TAU * 2 * this.blowerPhase)) * blowerLevel;
      }
      if (p.turbo > 0) {
        this.turboPhase += turboHz * dt; if (this.turboPhase > 1) this.turboPhase -= 1;
        forced += Math.sin(TAU * this.turboPhase) * turboLevel;
        if (this.blowOff > 0.001) { forced += this.blowOffBp.run(white) * this.blowOff * 0.25 * p.turbo; this.blowOff *= 0.9994; }
      }

      // --- rattle --------------------------------------------------------
      let rattle = 0;
      if (p.rattle > 0) {
        if (Math.random() < 0.0004 * p.rattle * Math.min(2, rpm / 1500)) this.rattleEnv = 1;
        this.rattleEnv *= 0.997;
        rattle = this.rattleBp.run(white) * this.rattleEnv * 0.12 * p.rattle;
      }

      // --- road ----------------------------------------------------------
      const tyre = this.tyreLp.run(white) * tyreLevel;
      const wind = this.windBp.run(white) * windLevel;
      this.skidWob += 0.00015; if (this.skidWob > 1) this.skidWob -= 1;
      if (skidLevel > 0) this.skidBp.set(1000 + Math.sin(TAU * this.skidWob) * 120 + slip * 250, 5);
      const skid = skidLevel > 0 ? this.skidBp.run(white) * skidLevel : 0;
      // Brake: the rubber scrub. The centre wanders a little so it does not
      // sit on one note, and the judder is a slow noise clamped to 0.3..1.
      let brakeSound = 0;
      if (brakeLevel > 0.001) {
        this.brakeWob += 2.3 * dt; if (this.brakeWob > 1) this.brakeWob -= 1;
        this.brakeBp.set(780 + Math.sin(TAU * this.brakeWob) * 90 + brake * 120, 1.1);
        const judder = 0.65 + 0.35 * Math.tanh(this.brakeFlutter.run(white) * 40);
        brakeSound = (this.brakeBp.run(white) * 2.2 + this.brakeLp.run(white) * 0.9) * judder * brakeLevel;
      }

      // --- shift clunk ---------------------------------------------------
      let clunk = 0;
      if (this.clunk > 0.001) { clunk = this.clunkLp.run(white) * this.clunk * 0.9; this.clunk *= 0.9992; }

      // --- mix -----------------------------------------------------------
      const centre = this.centreLp.run(intake + tick + grit + forced + rattle + tyre + wind + skid + brakeSound + clunk);
      const l = exL * 0.85 + exR * 0.35 + centre;
      const r = exR * 0.85 + exL * 0.35 + centre;
      outL[i] = Math.tanh(l * drive) * level;
      outR[i] = Math.tanh(r * drive) * level;
    }
    return true;
  }
}

registerProcessor('engine', EngineProcessor);
