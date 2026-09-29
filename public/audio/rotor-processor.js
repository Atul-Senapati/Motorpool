/**
 * Rotorcraft sound, synthesised per sample in an AudioWorklet.
 *
 * Loaded by `useRotorSound` with `audioWorklet.addModule('/audio/rotor-processor.js')`.
 * Plain JavaScript on purpose: worklet modules are fetched by the browser as-is
 * and run off the main thread, outside the bundle.
 *
 * ## What a helicopter sounds like
 *
 * Not an engine. Stand under one and the engines are the quietest thing about
 * it; what you hear, and feel in your chest, is the **rotor** — and the rotor
 * is two sounds at once, which is the thing a first attempt here got wrong by
 * making it one. It is a broadband roar (the whole disc shoving air) whose
 * loudness is *chopped* by each blade passing, four times a revolution, 395
 * times a minute on an EC135 — so a 26 Hz modulation of noise, not a 26 Hz
 * tone. And under that, each pass lands a pressure pulse a few milliseconds
 * wide: not a click and not a drum, a "whop" with its energy between 60 and
 * 600 Hz, shaped by the airframe it is heard through. Blade-vortex
 * interaction — a blade cutting the wake the one before it left — sharpens
 * that pulse, which is why a helicopter banking or descending sounds *angrier*
 * than one flying level at the same power. And none of it is steady: the air
 * the disc is working is turbulent, so the whole thing swells and sags by a
 * fifth over a second or two. Everything else sits on top of that:
 *
 *   tail rotor   two blades at 3,500 rpm: a 117 Hz buzz with a zing to it.
 *                The EC135's is a shrouded fenestron, which is quieter and
 *                higher than an open tail rotor, so it is kept modest
 *   turbines     two of them, a whine a few kilohertz up — but a whine made
 *                of NOISE squeezed through a narrow band, wobbling a little,
 *                because a compressor is ten thousand blades tearing air and
 *                a sine wave is a tuning fork. The two never turn at quite the
 *                same speed, so the pair shimmers against each other
 *   gearbox      a steady tone around a kilohertz, under the turbines
 *   wind         the airframe through the air, rising with the square of
 *                speed, and buffeting the cabin in the goggles view
 *   the cabin    from inside, the slap becomes a thump in the floor, the
 *                turbines and gearbox come up, and the outside is muffled
 *
 * The drone is the same processor with `kind: 'drone'`: four small props at
 * thousands of rpm are a chord of motor whines that rises with effort, a
 * whoosh of prop noise, and the wind — no slap, nothing below 100 Hz.
 *
 * A soft clip closes each channel, and nothing here is allowed above five
 * kilohertz on purpose: that band is where synthesis stops sounding like a
 * machine and starts sounding like a synthesiser.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TAU = Math.PI * 2;

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

class Lowpass {
  constructor(freq) { this.y = 0; this.set(freq); }
  set(freq) { this.k = 1 - Math.exp(-TAU * Math.min(Math.max(freq, 5), sampleRate * 0.45) / sampleRate); }
  run(x) { this.y += this.k * (x - this.y); return this.y; }
}

class Highpass {
  constructor(freq) { this.lp = new Lowpass(freq); }
  set(freq) { this.lp.set(freq); }
  run(x) { return x - this.lp.run(x); }
}

/** A short exponential envelope, retriggered. */
class Pulse {
  constructor(decaySec) { this.env = 0; this.k = Math.exp(-1 / (decaySec * sampleRate)); }
  fire(level) { this.env = Math.max(this.env, level); }
  run() { const e = this.env; this.env *= this.k; return e; }
}

/** A plain delay line, for widening a mono source into two ears. */
class Delay {
  constructor(sec) { this.buf = new Float32Array(Math.max(2, Math.round(sec * sampleRate))); this.w = 0; }
  run(x) { const d = this.buf[this.w]; this.buf[this.w] = x; if (++this.w >= this.buf.length) this.w = 0; return d; }
}

/**
 * A raised-cosine bump of the given width, 0..1 of phase, centred on 0.
 * The blade's pressure pulse is this shape rather than a click: a click has
 * energy to the top of the band and sounds like a stick on a box; the real
 * pulse is a few milliseconds wide and lives below a kilohertz.
 */
const bump = (phase, width) => {
  const d = phase < 0.5 ? phase : phase - 1;
  const x = d / width;
  return Math.abs(x) < 0.5 ? 0.5 + 0.5 * Math.cos(TAU * x) : 0;
};

class RotorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      /** How hard the machine is working, 0..1. Drives roar, slap, turbine and pitch. */
      { name: 'effort', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      /** Airspeed, m/s. */
      { name: 'speed', defaultValue: 0, minValue: 0, maxValue: 120, automationRate: 'k-rate' },
      /** Rotor speed as a share of flight rpm — 0 stopped, 1 turning. For the wind-up. */
      { name: 'rate', defaultValue: 1, minValue: 0, maxValue: 1.2, automationRate: 'k-rate' },
      /** Blade-vortex interaction, 0..1: banking and descending make the slap bite. */
      { name: 'bite', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      /** Metres over the ground, for ground effect: the slap comes back off a roof. */
      { name: 'agl', defaultValue: 100, minValue: 0, maxValue: 1000, automationRate: 'k-rate' },
      /** The goggles / cabin view. */
      { name: 'cockpit', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const p = Object.assign({
      kind: 'helicopter',           // 'helicopter' | 'drone'
      /** Main rotor: rpm at flight speed, and blades. EC135: 395 rpm, 4 blades. */
      rotorRpm: 395, blades: 4,
      /** Tail rotor rpm and blades. The fenestron: ~3,500 rpm, drawn as two. */
      tailRpm: 3500, tailBlades: 2,
      /** Turbine whine, Hz, and how far the second engine sits off the first. */
      turbineHz: 2400, beatHz: 2.3,
    }, options.processorOptions || {});
    this.p = p;

    this.rotorPhase = 0;     // one revolution
    this.spikeLevel = 0;
    this.tailPhase = 0;      // one tail blade pass
    this.gearA = 0; this.gearB = 0;
    this.motors = [0, 0, 0, 0];

    // The roar: broadband, pinkish, chopped by the blades.
    this.roarLp = new Lowpass(1600);
    this.roarHp = new Highpass(40);
    this.roarBody = new Bandpass(160, 0.6);
    // The pulse: a sharp asymmetric pressure spike per pass, through a
    // resonant lowpass — one broad resonance, not three narrow ones, because
    // narrow ones ring and a ringing pulse is a drum.
    this.spike = 0; this.spikeRise = 0;
    this.slapSpike = 0; this.slapDue = -1;
    this.pulseRes = new Bandpass(150, 0.8);
    this.pulseLp = new Lowpass(900);
    this.pulseLp2 = new Lowpass(420);
    // Turbulence, and a slower drift under it.
    this.turbLfo = new Lowpass(1.4);
    this.driftLfo = new Lowpass(0.25);
    // Ground effect: the rotor back off the ground, a little late and duller.
    this.echo = new Delay(0.026);
    this.echoLp = new Lowpass(500);

    // Fenestron: ten shrouded blades, a whistle with harmonics, not a buzz.
    this.fenPhase = 0;
    this.fenBp = new Bandpass(1250, 1.6);
    this.fenWhistle = new Bandpass(1750, 9);
    this.fenLp = new Lowpass(3200);

    // Turbines: mostly hiss, with a weak wandering tone in it.
    this.hissLp = new Lowpass(4200);
    this.hissHp = new Highpass(1400);
    this.toneBp = new Bandpass(3000, 10);
    this.wobble = new Lowpass(0.3);
    this.gearBp = new Bandpass(1050, 6);

    // Wind, two ears.
    this.windLpL = new Lowpass(400);
    this.windLpR = new Lowpass(400);
    this.buffetBp = new Bandpass(110, 1.1);
    this.buffetLfo = new Lowpass(6);

    // Width: the rotor arrives at the two ears a few samples apart.
    this.wide = new Delay(0.0007);

    // Cabin.
    this.cabLpL = new Lowpass(650);
    this.cabLpR = new Lowpass(650);
    this.cabThumpLp = new Lowpass(70);

    // Slow, smoothed controls so a stick jab does not click the mix.
    this.effortLp = new Lowpass(4);
    this.speedLp = new Lowpass(3);
    this.rateLp = new Lowpass(2);
    this.biteLp = new Lowpass(3);

    // Drone.
    this.propBp = new Bandpass(950, 1.4);
    this.motorHp = new Highpass(120);
  }

  process(inputs, outputs, params) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outL;
    if (!outL) return true;
    const p = this.p;
    const n = outL.length;
    const dt = 1 / sampleRate;
    const heli = p.kind === 'helicopter';

    const effortIn = Math.min(1, Math.max(0, params.effort[0]));
    const speedIn = Math.max(0, params.speed[0]);
    const rateIn = Math.max(0, params.rate[0]);
    const biteIn = Math.min(1, Math.max(0, params.bite[0]));
    const agl = Math.max(0, params.agl[0]);
    const cockpit = Math.min(1, Math.max(0, params.cockpit[0]));

    // Ground effect: full within a rotor diameter of the ground, gone by five.
    const ground = heli ? Math.min(1, Math.max(0, (50 - agl) / 40)) : 0;

    for (let i = 0; i < n; i++) {
      const effort = this.effortLp.run(effortIn);
      const speed = this.speedLp.run(speedIn);
      const rate = this.rateLp.run(rateIn);
      const bite = this.biteLp.run(biteIn);
      const v01 = Math.min(1, speed / 70);
      const white = Math.random() * 2 - 1;
      const white2 = Math.random() * 2 - 1;
      const white3 = Math.random() * 2 - 1;

      let l = 0;
      let r = 0;

      if (heli) {
        // The air the disc is working is never steady: a swell of a fifth
        // over a second or two, and a slower drift under it.
        const turb = 1 + this.turbLfo.run(white3) * 4.5 + this.driftLfo.run(white2) * 6;

        // -------------------------------------------------------- the rotor
        const rotorHz = (p.rotorRpm / 60) * rate;
        const prev = this.rotorPhase;
        this.rotorPhase += rotorHz * dt;
        if (this.rotorPhase >= 1) this.rotorPhase -= 1;
        const bladePhase = (this.rotorPhase * p.blades) % 1;
        const bladeIndex = Math.floor(this.rotorPhase * p.blades);
        // No four blades track alike. Alternate blades hit harder, which puts
        // a two-per-rev beat under the four-per-rev hum — the 13 Hz wop-wop
        // that is what "helicopter" means to an ear, on top of the 26 Hz that
        // is what this one actually does. A once-per-rev lilt under that.
        const weight = (bladeIndex % 2 === 0 ? 1 : 0.5) * (1 + 0.15 * Math.sin(TAU * this.rotorPhase));

        // A blade has just passed: fire the spike. It rises in half a
        // millisecond and falls in three — a pressure pulse, not a click and
        // not a drum. BVI adds a second, sharper crack a few ms behind it.
        const passed = Math.floor(prev * p.blades) !== bladeIndex || prev > this.rotorPhase;
        if (passed) {
          this.spikeRise = 1;
          this.spikeLevel = weight * (0.55 + effort * 0.45);
          if (bite > 0.05) this.slapDue = Math.round((0.0025 + Math.random() * 0.002) * sampleRate);
        }
        if (this.slapDue >= 0 && this.slapDue-- === 0) this.slapSpike = weight * bite * 1.4;
        // Rise: exponential toward the level; fall: exponential away.
        if (this.spikeRise > 0) {
          this.spike += (this.spikeLevel - this.spike) * 0.12;
          if (this.spike > this.spikeLevel * 0.95) this.spikeRise = 0;
        } else {
          this.spike *= 0.9935;
        }
        this.slapSpike *= 0.985;
        const pressure = this.spike - this.spikeLevel * 0.35 * Math.exp(-this.spike) // a sag after the crest
          + this.slapSpike * (0.6 + white * 0.7);
        const pulse = this.pulseLp2.run(this.pulseLp.run(pressure * 0.9 + this.pulseRes.run(pressure) * 0.6));

        // The roar, chopped. The loud part of each pass is short and the
        // quiet part long — the "wop" has a gap after it — and the chop
        // deepens as the disc loads and as BVI bites. Same alternate-blade
        // weighting, so the roar breathes at 13 Hz too.
        const chopDepth = 0.4 + effort * 0.2 + bite * 0.3;
        const c = 0.5 + 0.5 * Math.cos(TAU * bladePhase);
        const chop = (1 - chopDepth) + chopDepth * c * c * (0.6 + 0.4 * weight);
        const roarLevel = (0.2 + effort * 0.3 + v01 * 0.2) * turb;
        const roarSrc = this.roarHp.run(this.roarLp.run(white));
        const roar = (roarSrc * 0.8 + this.roarBody.run(white2) * 0.5) * chop * roarLevel;

        let rotor = roar + pulse * (0.7 + bite * 0.5) * turb;
        // Off the ground and back, a little late and a little duller.
        rotor += this.echoLp.run(this.echo.run(rotor)) * ground * 0.6;

        // -------------------------------------------------------- fenestron
        // Ten blades, unevenly spaced on the real thing so the tone smears:
        // a jittered pulse train through a broad band, and a whistle on top.
        const fenHz = (p.tailRpm / 60) * 10 * rate;
        this.fenPhase += fenHz * dt * (1 + (Math.floor(this.fenPhase * 2) % 2 ? 0.06 : -0.06));
        if (this.fenPhase >= 1) this.fenPhase -= 1;
        const fenPulse = bump(this.fenPhase, 0.28) - 0.14;
        const fen = this.fenLp.run(this.fenBp.run(fenPulse + white3 * 0.2) * 0.8 + this.fenWhistle.run(white) * 0.9)
          * (0.03 + effort * 0.035) * Math.min(1, rate * 1.2);

        // --------------------------------------------------------- turbines
        // From outside, at the distance a camera stands, a turbine is hiss
        // with the faint suggestion of a tone in it — not a whine.
        const hiss = this.hissHp.run(this.hissLp.run(white2)) * (0.035 + effort * 0.04);
        const wob = 1 + this.wobble.run(white) * 0.5;
        if ((i & 127) === 0) this.toneBp.set(3000 * (0.95 + effort * 0.08) * wob * Math.max(0.3, Math.min(1, rate)), 10);
        const tone = this.toneBp.run(white3) * (0.04 + effort * 0.04);
        const turbine = (hiss + tone) * Math.min(1, rate * 1.5);
        this.gearA += 1040 * rate * dt; if (this.gearA >= 1) this.gearA -= 1;
        const gearbox = this.gearBp.run(Math.sin(TAU * this.gearA) * 0.5 + white * 0.6) * 0.02 * Math.min(1, rate);

        // ------------------------------------------------------------- wind
        const windHz = 300 + speed * 45;
        this.windLpL.set(windHz); this.windLpR.set(windHz);
        const windLevel = 0.02 + v01 * v01 * 0.3;
        const windL = this.windLpL.run(white) * windLevel;
        const windR = this.windLpR.run(white2) * windLevel;

        // -------------------------------------------------------------- mix
        const rotorR = this.wide.run(rotor);
        const machinery = turbine + gearbox;
        l = rotor + fen + windL + machinery;
        r = rotorR + fen * 0.9 + windR + machinery;
        if (cockpit > 0.01) {
          const gust = 0.5 + 0.5 * this.buffetLfo.run(white);
          const buffet = this.buffetBp.run(white) * v01 * 0.12 * gust;
          const floor = this.cabThumpLp.run(pulse) * 2.4;
          const inside = floor + machinery * 2.4 + fen * 1.5 + buffet;
          l = this.cabLpL.run(l) * (1 - cockpit * 0.45) + inside * cockpit;
          r = this.cabLpR.run(r) * (1 - cockpit * 0.45) + inside * cockpit;
        }
      } else {
        // ------------------------------------------------------- the drone
        // Four motors, each a little off the others, all climbing with effort.
        const base = (150 + effort * 140) * Math.min(1, rate);
        let chord = 0;
        for (let m = 0; m < 4; m++) {
          const hz = base * (1 + (m - 1.5) * 0.012);
          this.motors[m] += hz * dt; if (this.motors[m] >= 1) this.motors[m] -= 1;
          const ph = this.motors[m];
          chord += Math.sin(TAU * ph) * 0.5 + Math.sin(TAU * ph * 2) * 0.35 + Math.sin(TAU * ph * 3) * 0.2 + Math.sin(TAU * ph * 5) * 0.08;
        }
        chord = this.motorHp.run(chord * 0.03 * (0.5 + effort * 0.7));
        const prop = this.propBp.run(white) * (0.05 + effort * 0.09);
        const windHz = 350 + speed * 60;
        this.windLpL.set(windHz); this.windLpR.set(windHz);
        const windLevel = 0.02 + Math.min(1, speed / 50) ** 2 * 0.3;
        l = chord + prop + this.windLpL.run(white) * windLevel;
        r = chord + prop + this.windLpR.run(white2) * windLevel;
        if (cockpit > 0.01) {
          const buffet = this.buffetBp.run(white) * Math.min(1, speed / 50) * 0.1;
          l += buffet * cockpit;
          r += buffet * cockpit;
        }
      }

      // The clip is a safety, not a colour: full effort and full bite reach
      // it, cruise does not. Measured offline — see the check in HANDOFF.
      const drive = heli ? 0.7 : 1.6;
      outL[i] = Math.tanh(l * drive) * 0.95;
      outR[i] = Math.tanh(r * drive) * 0.95;
    }
    return true;
  }
}

registerProcessor('rotor', RotorProcessor);
