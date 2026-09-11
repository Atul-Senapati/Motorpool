/**
 * Train sound, synthesised per sample in an AudioWorklet.
 *
 * Loaded by `useTrainSound` with `audioWorklet.addModule('/audio/train-processor.js')`.
 * Plain JavaScript on purpose: worklet modules are fetched by the browser as-is
 * and run off the main thread, outside the bundle.
 *
 * ## What a train sounds like, and what games got right about it
 *
 * The rail sims that sound good — Train Sim World, Derail Valley, Densha de Go
 * — all agree on one thing the car games do not have to think about: the
 * engine is the *least* of it. A car's note tracks its wheels; a locomotive's
 * does not. A diesel-electric's prime mover sits at a notch the driver chose
 * and takes seconds to get there, an electric has no engine at all, and what
 * actually tracks speed is the **wheel on the rail**. So the layers here are
 * weighted the way those games weight them:
 *
 *   wheel and rail   the rolling roar that rises with speed, hollowed out on
 *                    a viaduct; the joint clack — every axle of the rake
 *                    striking every rail joint, so at speed a 150 m train
 *                    lays down the rhythm of its own bogie spacing; the
 *                    flange squeal on a tight curve; the clatter of a set of
 *                    points passing under each bogie in turn
 *   the prime mover  a diesel that answers the throttle with a lag, hunting
 *                    up through its notches with the turbo whistling behind it
 *                    (the Class 43's MTU V16), or an electric's transformer
 *                    hum, blowers and the inverter "singing" up through its
 *                    bands as speed builds (the Class 91, the tram)
 *   the air          brakes kept simple and clean: a smooth shoe rumble that
 *                    follows the handle and the speed, a soft hiss when the
 *                    handle comes off, and for the emergency one long dump of
 *                    air with the same rumble under it, heavier. No squeals,
 *                    no shudders — those were tried, and they were the most
 *                    annoying thing in the mix
 *   the horn         two tones, brass, on `horn`
 *   the tunnel       everything above through a short reverb as `enclosed`
 *                    rises, and dark — a bore is a big pipe
 *   the cab          exterior muffled, the machinery under the floor up
 *
 * A soft clip closes each channel so pushing everything at once gets louder
 * and rounder rather than louder and sharper, and nothing here is allowed
 * above a few kilohertz on purpose: the harsh band is the one thing every one
 * of those games keeps out of.
 *
 * Messages on the port: `{ points: true }` when the leading axle reaches a
 * turnout (each axle then clatters over it in turn, timed off the rake's own
 * geometry), `{ release: true }` when the brake handle comes off.
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

/** A feedback delay with a lowpass in the loop. */
class Comb {
  constructor(sec, fb, damp) {
    this.buf = new Float32Array(Math.max(4, Math.round(sec * sampleRate)));
    this.w = 0; this.fb = fb; this.damp = new Lowpass(damp);
  }
  run(x) {
    const d = this.buf[this.w];
    const y = x + this.damp.run(d) * this.fb;
    this.buf[this.w] = y;
    if (++this.w >= this.buf.length) this.w = 0;
    return d;
  }
}

/** Schroeder allpass, for the reverb's diffusion. */
class Allpass {
  constructor(sec, g) { this.buf = new Float32Array(Math.max(4, Math.round(sec * sampleRate))); this.w = 0; this.g = g; }
  run(x) {
    const d = this.buf[this.w];
    const y = -this.g * x + d;
    this.buf[this.w] = x + this.g * d;
    if (++this.w >= this.buf.length) this.w = 0;
    return y;
  }
}

/**
 * The tunnel. A bore is a concrete pipe a few metres across and hundreds of
 * metres long, and what that does to sound is not what a hall does:
 *
 *   slap        the walls are close, so the first thing back is a hard set of
 *               reflections a few milliseconds apart — the metallic "tube"
 *               colour every tunnel has
 *   boom        the pipe resonates low; the bass builds up and stays, so the
 *               rumble under the train swells and the tail is all bottom end
 *   long, dark  the tail runs on for a couple of seconds, and it is dark: the
 *               top is soaked up by the walls within the first reflections
 *
 * So: a short slap line, a low resonance on the way in, longer combs with
 * heavier damping than before, and an output filtered down hard.
 */
class Reverb {
  constructor() {
    this.slap = new Float32Array(Math.round(sampleRate * 0.032)); this.sw = 0;
    this.taps = [0.0068, 0.0121, 0.0189, 0.0263].map((t) => Math.round(t * sampleRate));
    this.boom = new Bandpass(78, 2.2); this.boom2 = new Bandpass(118, 3);
    this.combs = [new Comb(0.0631, 0.84, 700), new Comb(0.0743, 0.83, 640), new Comb(0.0899, 0.82, 580), new Comb(0.1031, 0.81, 520)];
    this.aps = [new Allpass(0.0071, 0.5), new Allpass(0.0023, 0.5)];
    this.dark = new Lowpass(1100);
    this.slapDark = new Lowpass(2400);
  }
  run(x) {
    // The slap: four early echoes off the walls, alternating sign like the
    // pressure flips off a hard surface.
    this.slap[this.sw] = x;
    let early = 0;
    for (let k = 0; k < 4; k++) {
      let idx = this.sw - this.taps[k]; if (idx < 0) idx += this.slap.length;
      early += this.slap[idx] * (k % 2 ? -0.45 : 0.55);
    }
    if (++this.sw >= this.slap.length) this.sw = 0;
    early = this.slapDark.run(early);
    // The tail, fed by the input and the early slap, with the pipe's boom
    // pushed in on the way.
    const feed = x + early * 0.4 + (this.boom.run(x) * 1.1 + this.boom2.run(x) * 0.6);
    let y = 0;
    for (const c of this.combs) y += c.run(feed);
    y *= 0.25;
    for (const a of this.aps) y = a.run(y);
    return this.dark.run(y) * 0.55 + early * 0.5;
  }
}

/** A brass horn tone: harmonic-rich, through a formant. */
class HornTone {
  constructor(freq) { this.freq = freq; this.phase = 0; this.formant = new Bandpass(freq * 2.2, 1.4); this.env = 0; }
  run(on, dt) {
    // Attack ~80 ms, release ~220 ms.
    const target = on ? 1 : 0;
    this.env += (target - this.env) * (1 - Math.exp(-dt / (on ? 0.08 : 0.22)));
    if (this.env < 0.001) return 0;
    this.phase += this.freq * dt; if (this.phase > 1) this.phase -= 1;
    // Six harmonics falling as 1/n: a brassy reed rather than a pure tone.
    let s = 0;
    for (let n = 1; n <= 6; n++) s += Math.sin(TAU * this.phase * n) / n;
    return this.formant.run(s) * this.env;
  }
}

class TrainProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 0, minValue: 0, maxValue: 120, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'brake', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'curve', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'enclosed', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cockpit', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'horn', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      /** The emergency brake is applied. Its onset arrives as a message; this holds the heavier rumble. */
      { name: 'emergency', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      /** 0 ballast, 1 viaduct, 2 tunnel, 3 cutting — what the rail is bolted to. */
      { name: 'surface', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const p = Object.assign({
      kind: 'diesel',                 // 'diesel' | 'electric' | 'tram'
      cylinders: 16, idleRpm: 600, maxRpm: 1500, spoolSec: 3.2,
      /** Every axle, as metres behind the leading axle. */
      axles: [0, 2.6, 10.4, 13],
      /** Rail joint pitch, metres. Jointed track; welded would be silent here. */
      jointPitch: 18.3,
      hornHz: [330, 415],
    }, options && options.processorOptions);
    this.p = p;

    // --- prime mover ---
    this.rpm = p.idleRpm;
    this.phase = 0;
    this.cyl = [];
    let seed = 0x1234567;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 - 0.5; };
    // A big slow engine is an UNEVEN engine: the two banks of a V do not
    // fire alike, the cylinders differ a good deal more than a car's, and a
    // few are simply lazy. That unevenness is what puts the throb at half and
    // quarter the firing rate — the thing you feel in your chest beside a
    // locomotive and never beside a sports car.
    for (let i = 0; i < p.cylinders; i++) {
      const bank = i % 2 ? 0.78 : 1;
      this.cyl.push({ angle: i / p.cylinders + rnd() * 0.018, gain: (1 + rnd() * 0.7) * bank, pulse: 0, env: 0, chuff: 0 });
    }
    // The exhaust stack: a big lossy pipe. Low, broad resonances, and a lid
    // over the top that barely lifts with the notch — a locomotive at full
    // power gets LOUDER, it does not get higher.
    this.stack = [new Bandpass(34, 1.4), new Bandpass(68, 1.8), new Bandpass(104, 2.0), new Bandpass(165, 2.2)];
    this.stackGain = [1.1, 0.7, 0.4, 0.18];
    this.stackTone = new Lowpass(500); this.stackSmooth = new Lowpass(420);
    // The chuff: every firing also blows a puff of hot gas up the stack, and
    // that is noise, not tone. It is what makes an exhaust rasp.
    this.chuffBp = new Bandpass(380, 1.1); this.chuffLp = new Lowpass(900);
    // The mechanicals: injectors and valve gear clattering at the firing
    // rate, loudest at idle when nothing else is covering them.
    this.clatterBp = new Bandpass(1300, 2.4); this.clatterLp = new Lowpass(2200); this.clatter = 0;
    // An idling diesel hunts a little; a perfectly steady one sounds looped.
    this.huntLp = new Lowpass(0.4);
    // The engine room under the drone: a low steady mechanical rumble.
    this.roomLp = new Lowpass(95); this.roomBp = new Bandpass(58, 1.6);
    this.boost = 0; this.turboPhase = 0; this.turboBp = new Bandpass(1200, 3);
    this.fanLp = new Lowpass(420);
    // Electric: hum, blowers, motor, inverter.
    this.humPhase = 0; this.motorPhase = 0; this.invPhase = 0; this.invBand = -1; this.invGlide = 0;
    this.blowerBp = new Bandpass(380, 1.2);
    this.sizzleHp = new Highpass(2500); this.sizzle = 0;

    // --- wheel and rail ---
    this.pink = new Lowpass(1400); this.pinkHp = new Highpass(60);
    // The roar is three things that together read as steel on steel and none
    // of which does alone: a deep rumble, a broad mid band, and a faint hiss
    // that only arrives at speed. Each breathes on its own slow noise, because
    // a constant band of noise is the single most fatiguing sound a game can
    // make and the real thing never holds still.
    this.rumbleLp = new Lowpass(110);
    this.rollBp = new Bandpass(380, 0.5); this.rollLp = new Lowpass(1400);
    this.hissLp = new Lowpass(2200); this.hissHp = new Highpass(900);
    this.breathA = new Lowpass(0.9); this.breathB = new Lowpass(1.7); this.breathC = new Lowpass(0.5);
    // A second, independent noise chain for the right channel: the same roar
    // in both ears sits inside the head; two uncorrelated ones are a railway
    // either side of you.
    this.pinkR = new Lowpass(1400); this.pinkHpR = new Highpass(60);
    this.rumbleLpR = new Lowpass(110);
    this.rollBpR = new Bandpass(380, 0.5); this.rollLpR = new Lowpass(1400);
    this.windBpL = new Bandpass(500, 0.8); this.windBpR = new Bandpass(560, 0.8);
    this.hollow = new Bandpass(175, 6);          // the viaduct's deck ringing
    this.dist = 0;                                 // metres travelled, for the joints
    this.jointIndex = new Int32Array(p.axles.length).fill(-1);
    this.clacks = [];                              // active joint strikes
    this.thumpLpL = new Lowpass(320); this.thumpLpR = new Lowpass(320);
    // Far axles are not heard as strikes; they feed a slow swell in the roar.
    this.farSwell = 0;
    this.squealBp = new Bandpass(1400, 12); this.squealGate = new Lowpass(3); this.squealWob = 0;
    this.pointsQueue = [];                         // [secondsUntil, axleIndex]
    this.clatter = [];                             // active points strikes

    // --- air ---
    this.shoeBp = new Bandpass(300, 0.9); this.shoeLp = new Lowpass(650);
    this.hiss = 0; this.releaseHp = new Highpass(700); this.releaseLp = new Lowpass(1800);
    // The emergency: the brake pipe dumping to atmosphere, once, softly
    // falling away; the rumble under it is the ordinary brake's, heavier.
    this.dump = 0;                                  // air-dump envelope
    this.dumpBp = new Bandpass(1400, 0.6); this.dumpLp = new Lowpass(1800); this.dumpRoar = new Lowpass(300);

    // --- horn, room, cab ---
    this.horns = p.hornHz.map((f) => new HornTone(f));
    this.reverb = new Reverb();
    // The air a train shoves through a bore: a roar of pressure that rises
    // with speed, wobbling as the pockets of it slap past.
    this.pistonLp = new Lowpass(240); this.pistonBp = new Bandpass(160, 0.8); this.pistonWob = new Lowpass(1.7);
    this.cabLpL = new Lowpass(700); this.cabLpR = new Lowpass(700);
    this.cabAir = new Bandpass(600, 0.6);
    this.centreLp = new Lowpass(3200);
    // The joint ticks are white-noise bursts: without this they are the only
    // thing in the mix with energy above 3 kHz, and at speed there are fifty
    // of them a second. A tick with its top taken off still reads as a tick.
    this.tickLpL = new Lowpass(2600); this.tickLpR = new Lowpass(2600);

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.points) {
        // Every axle takes the points in turn: the leading one now, the rest
        // as they arrive, which is their distance behind divided by speed.
        const v = Math.max(this.lastSpeed, 1);
        for (let i = 0; i < p.axles.length; i++) this.pointsQueue.push([p.axles[i] / v, i]);
      }
      if (m.release) this.hiss = 1;
      if (m.emergency) this.dump = 1;
    };
    this.lastSpeed = 0;
  }

  /**
   * A joint strike: a soft double thump — the wheel dropping onto the far
   * rail end — with a whisper of a tick, decaying over `len` samples.
   * Amplitude wanders a third either way, so two strikes never sound stamped
   * from the same die.
   */
  strike(gain, pan, bright) {
    const wander = 0.7 + Math.random() * 0.6;
    this.clacks.push({ t: 0, len: Math.round(sampleRate * 0.09), gain: gain * wander, pan, bright });
    if (this.clacks.length > 24) this.clacks.shift();
  }

  process(inputs, outputs, params) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outL;
    if (!outL) return true;
    const p = this.p;
    const dt = 1 / sampleRate;
    const n = outL.length;
    const speed = Math.max(0, params.speed[0]);
    const load = Math.min(1, Math.max(0, params.load[0]));
    const brake = Math.min(1, Math.max(0, params.brake[0]));
    const emergency = params.emergency[0] > 0.5 ? 1 : 0;
    const curve = Math.min(1, Math.max(0, params.curve[0]));
    const enclosed = Math.min(1, Math.max(0, params.enclosed[0]));
    const cockpit = Math.min(1, Math.max(0, params.cockpit[0]));
    const hornOn = params.horn[0] > 0.5;
    const surface = Math.round(params.surface[0]);
    this.lastSpeed = speed;

    const electric = p.kind !== 'diesel';
    const v01 = Math.min(1, speed / 60);           // 0 at rest, 1 at 216 km/h

    // ---------------------------------------------------------- prime mover
    // A diesel answers the notch with a lag: up in `spoolSec`, down in half
    // again as long. The engine is NOT tied to the wheels.
    const hunt = 1 + this.huntLp.run(Math.random() * 2 - 1) * 40 * 0.012 * (1 - load);
    const targetRpm = (p.idleRpm + (p.maxRpm - p.idleRpm) * load) * hunt;
    const rate = (p.maxRpm - p.idleRpm) / (targetRpm > this.rpm ? p.spoolSec : p.spoolSec * 1.5);
    const step = rate * n * dt;
    this.rpm += Math.max(-step, Math.min(step, targetRpm - this.rpm));
    const cycleHz = this.rpm / 60 / 2;
    const firingHz = cycleHz * p.cylinders;
    const dPhase = cycleHz / sampleRate;
    // Long, heavy pulses: each firing hangs on for most of the gap to the
    // next, so the stack thuds rather than ticks.
    const decaySec = Math.min(0.012, 0.6 / Math.max(firingHz, 1));
    const decay = Math.exp(-dt / decaySec);
    const attack = 1 - Math.exp(-dt / 0.0015);
    const chuffDecay = Math.exp(-dt / Math.min(0.009, 0.4 / Math.max(firingHz, 1)));
    const revs = (this.rpm - p.idleRpm) / (p.maxRpm - p.idleRpm);
    // Turbo boost trails the engine by a second and a half.
    this.boost += (revs * load - this.boost) * Math.min(1, n * dt / 1.5);
    this.stackTone.set(380 + revs * 260);
    const dieselLevel = electric ? 0 : 0.6 + revs * 0.55;
    const chuffLevel = electric ? 0 : 0.05 + revs * 0.13 + load * 0.05;
    const clatterLevel = electric ? 0 : 0.012 * (1 - revs * 0.55);
    // The turbo is air, and it is behind the engine, not on top of it.
    const turboHz = 600 + this.boost * 1100;
    const turboLevel = electric ? 0 : this.boost * 0.011;
    const fanLevel = electric ? 0 : 0.03 + revs * revs * 0.1;
    // Electric: a 100 Hz transformer hum (50 Hz mains, both half-cycles),
    // blowers that rise with load, a traction motor whine that follows speed
    // and an inverter that steps up through its bands and sings between them.
    const humLevel = electric ? 0.035 + load * 0.02 : 0;
    const blowerLevel = electric ? 0.02 + load * 0.09 : 0;
    const motorHz = electric ? 40 + speed * (p.kind === 'tram' ? 30 : 18) : 0;
    const motorLevel = electric ? Math.min(0.05, speed * 0.002) * (0.4 + load * 0.6) : 0;
    const bands = p.kind === 'tram' ? [4, 9, 15, 24] : [8, 17, 28, 42];
    let band = 0; while (band < bands.length && speed > bands[band]) band++;
    if (band !== this.invBand) { this.invBand = band; this.invGlide = 0; }
    this.invGlide = Math.min(1, this.invGlide + n * dt / 0.6);
    const invBase = [420, 640, 880, 1180, 1500][Math.min(band, 4)];
    const invHz = invBase * (0.92 + 0.08 * this.invGlide);
    const invLevel = electric && speed > 0.5 ? load * 0.022 * (1 - 0.35 * v01) : 0;

    // ---------------------------------------------------------- wheel and rail
    // Gentle at low speed, and never dominant: the roar is the floor the
    // details sit on, not the sound itself.
    const rollLevel = Math.pow(v01, 1.15) * 0.26;
    const rumbleLevel = Math.pow(v01, 0.9) * 0.22;
    const hissLevel = Math.max(0, v01 - 0.35) * 0.05;
    this.rollBp.set(320 + v01 * 160, 0.5); this.rollBpR.set(340 + v01 * 160, 0.5);
    // Wind over the body from about 100 km/h: what the open-air cameras hear.
    const windLevel = Math.pow(Math.max(0, v01 - 0.4), 1.4) * 0.14;
    const hollowLevel = surface === 1 ? rollLevel * 0.8 : surface === 2 ? rollLevel * 0.4 : rollLevel * 0.1;
    // The clack. Loud enough to be a rhythm at 30-40 m/s, then it FADES as the
    // roar takes over — above about 45 m/s jointed track is a texture, not a
    // beat, and a rhythm you can still count at 200 km/h is the annoying kind.
    const clackGain = Math.min(1, Math.pow(speed / 30, 0.7)) * 0.32 * Math.max(0.25, 1 - Math.max(0, speed - 45) / 40);
    // Only the axles the listener is near are heard as strikes — the lead
    // locomotive's own four, which is the "ta-tak ... ta-tak" of one vehicle
    // and about six strikes a second at 30 m/s. Everything further back is a
    // swell in the roar, not a click track: with the whole 28-axle rake heard
    // as strikes it was forty-six a second, which is a machine gun.
    const LISTEN = 22;
    // Squeal only on a real curve, only when moving, and rarely: a flange
    // that squeals the whole way round a bend is a tyre, not a wheel.
    const squealLevel = Math.max(0, curve - 0.35) * Math.min(1, speed / 12) * 0.045;
    // Brakes: one smooth shoe rumble, nothing tonal.
    // One smooth rumble, following the handle and the speed; the emergency
    // is the same rumble, heavier. Nothing tonal.
    const shoeLevel = Math.max(brake, emergency * 1.6) * Math.min(1, speed / 12) * 0.16;
    // The dump falls away over about a second and a half, its tone falling
    // with it as the pressure goes — and it stays soft: air, not a whistle.
    this.dumpLp.set(700 + this.dump * 1100);

    // Cab: exterior down and dark, machinery up.
    const exteriorMix = 1 - cockpit * 0.55;
    const cabLp = 3200 - cockpit * 2400;
    this.cabLpL.set(cabLp); this.cabLpR.set(cabLp);
    // A bore is louder than the open, and heavier: the reverb is mixed IN,
    // the dry comes down, and the wheel roar comes UP because the walls throw
    // it straight back at the cab.
    const wet = enclosed * 0.5;
    const pistonLevel = enclosed * Math.pow(v01, 1.2) * 0.2;
    const level = 0.42 + load * 0.12;
    const drive = 1.25;

    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      const pink = this.pinkHp.run(this.pink.run(white));

      // --- diesel --------------------------------------------------------
      let engine = 0;
      if (!electric) {
        const before = this.phase;
        this.phase += dPhase;
        const wrapped = this.phase >= 1;
        if (wrapped) this.phase -= 1;
        let x = 0;
        let chuffEnv = 0;
        for (const c of this.cyl) {
          const hit = wrapped ? (c.angle >= before || c.angle < this.phase) : (c.angle >= before && c.angle < this.phase);
          if (hit) {
            // Each firing a little different, and under load a lot harder.
            const punch = (0.4 + revs * 0.6) * c.gain * (1 + (Math.random() - 0.5) * 0.3);
            c.pulse = punch; c.env = 0; c.chuff = punch;
            // The clatter of the gear that fired it.
            this.clatter = Math.max(this.clatter, 0.6 + Math.random() * 0.4);
          }
          if (c.pulse > 0) { c.env += (c.pulse - c.env) * attack; c.pulse *= decay; if (c.pulse < 1e-4) { c.pulse = 0; c.env = 0; } x += c.env; }
          if (c.chuff > 0) { chuffEnv += c.chuff; c.chuff *= chuffDecay; if (c.chuff < 1e-4) c.chuff = 0; }
        }
        let y = x * 0.35;
        for (let k = 0; k < 4; k++) y += this.stack[k].run(x) * this.stackGain[k];
        engine = this.stackSmooth.run(this.stackTone.run(y)) * dieselLevel * 0.95;
        // The chuff rides the pulses: gas noise gated by the firings.
        engine += this.chuffLp.run(this.chuffBp.run(white) * 2.2) * chuffEnv * chuffLevel;
        // The clatter is its own little burst per firing.
        if (this.clatter > 0.001) { engine += this.clatterLp.run(this.clatterBp.run(white) * 3) * this.clatter * clatterLevel; this.clatter *= 0.9975; }
        // The engine room under everything: a heavy floor that thickens with
        // the notch, and a hum at the block's own resonance.
        engine += this.roomLp.run(white) * (0.09 + revs * 0.12) + this.roomBp.run(white) * (0.05 + revs * 0.05);
        // The turbo: air through a band that rises with boost — and only air.
        this.turboBp.set(turboHz, 2.2);
        engine += this.turboBp.run(white) * 3.5 * turboLevel;
        engine += this.fanLp.run(white) * fanLevel;
      } else {
        // --- electric ------------------------------------------------------
        this.humPhase += 100 * dt; if (this.humPhase > 1) this.humPhase -= 1;
        engine += (Math.sin(TAU * this.humPhase) + 0.5 * Math.sin(TAU * 2 * this.humPhase)) * humLevel;
        engine += this.blowerBp.run(white) * blowerLevel;
        this.motorPhase += motorHz * dt; if (this.motorPhase > 1) this.motorPhase -= 1;
        engine += (Math.sin(TAU * this.motorPhase) + 0.3 * Math.sin(TAU * 2 * this.motorPhase)) * motorLevel;
        this.invPhase += invHz * dt; if (this.invPhase > 1) this.invPhase -= 1;
        // Softened: a second harmonic and a slow wobble so it is a machine
        // singing, not a test tone.
        engine += (Math.sin(TAU * this.invPhase) + 0.4 * Math.sin(TAU * 2 * this.invPhase)) * invLevel * (0.8 + 0.2 * Math.sin(TAU * this.humPhase * 0.03));
        // Pantograph: a rare crackle at speed.
        if (Math.random() < 0.00002 * v01) this.sizzle = 1;
        if (this.sizzle > 0.001) { engine += this.sizzleHp.run(white) * this.sizzle * 0.06; this.sizzle *= 0.9985; }
      }

      // --- rolling ----------------------------------------------------------
      // Each layer breathes: slow noise, rectified into 0.6..1.
      const bA = 0.8 + 0.2 * Math.tanh(this.breathA.run(white) * 40);
      const bB = 0.8 + 0.2 * Math.tanh(this.breathB.run(white) * 40);
      const bC = 0.75 + 0.25 * Math.tanh(this.breathC.run(white) * 40);
      this.farSwell *= 0.9995;
      const swell = 1 + this.farSwell;
      const whiteR = Math.random() * 2 - 1;
      const pinkR = this.pinkHpR.run(this.pinkR.run(whiteR));
      const hiss = this.hissLp.run(this.hissHp.run(white)) * hissLevel * bC;
      const rollL = this.rollLp.run(this.rollBp.run(pink) * 1.8) * rollLevel * bB * swell * (1 + enclosed * 0.6)
        + this.rumbleLp.run(white) * rumbleLevel * 1.6 * bA * swell + hiss
        + this.windBpL.run(white) * windLevel;
      const rollR = this.rollLpR.run(this.rollBpR.run(pinkR) * 1.8) * rollLevel * bB * swell * (1 + enclosed * 0.6)
        + this.rumbleLpR.run(whiteR) * rumbleLevel * 1.6 * bA * swell + hiss
        + this.windBpR.run(whiteR) * windLevel;
      const hollow = this.hollow.run(pink) * hollowLevel * 2.2 * bA;

      // --- rail joints --------------------------------------------------------
      this.dist += speed * dt;
      if (speed > 0.3) {
        for (let a = 0; a < p.axles.length; a++) {
          const k = Math.floor((this.dist - p.axles[a]) / p.jointPitch);
          if (k !== this.jointIndex[a]) {
            if (this.jointIndex[a] !== -1) {
              if (p.axles[a] <= LISTEN) {
                // Nearer axles are louder from where the camera stands (the
                // lead locomotive); left and right rails alternate sides.
                const near = 1 - p.axles[a] / (LISTEN * 1.6);
                this.strike(clackGain * near, a % 2 === 0 ? -0.3 : 0.3, 0.15 + 0.35 * near);
              } else {
                // Somewhere down the train a wheel found a joint: the roar swells.
                this.farSwell = Math.min(0.5, this.farSwell + 0.04);
              }
            }
            this.jointIndex[a] = k;
          }
        }
      }
      // --- points --------------------------------------------------------------
      if (this.pointsQueue.length) {
        for (let q = this.pointsQueue.length - 1; q >= 0; q--) {
          this.pointsQueue[q][0] -= dt;
          if (this.pointsQueue[q][0] <= 0) {
            const a = this.pointsQueue[q][1];
            const near = 1 / (1 + p.axles[a] / 60);
            // A turnout is two blades, a frog and a check rail: a heavier,
            // doubled clatter than a joint.
            this.strike(Math.min(1, clackGain * 1.6 + 0.08) * near, a % 2 === 0 ? -0.3 : 0.3, 0.4);
            this.clacks.push({ t: -Math.round(sampleRate * 0.04), len: Math.round(sampleRate * 0.1), gain: Math.min(1, clackGain * 1.2 + 0.08) * near, pan: 0, bright: 0.25 });
            this.pointsQueue.splice(q, 1);
          }
        }
      }
      let clackL = 0, clackR = 0;
      for (let c = this.clacks.length - 1; c >= 0; c--) {
        const s = this.clacks[c];
        s.t++;
        if (s.t < 0) continue;
        if (s.t >= s.len) { this.clacks.splice(c, 1); continue; }
        const u = s.t / s.len;
        // Two soft thumps — the wheel meeting the joint and dropping onto the
        // far rail — and a faint tick on the first. No hard edges anywhere.
        const env = Math.exp(-u * 9) + 0.55 * Math.exp(-Math.pow((u - 0.28) * 9, 2));
        const thump = pink * env * 2.6;
        const tick = white * Math.exp(-u * 60) * s.bright * 0.35;
        const v = (thump + tick) * s.gain;
        clackL += v * (1 - Math.max(0, s.pan)); clackR += v * (1 + Math.min(0, s.pan));
      }
      // The thumps themselves are kept below the mid band: they are felt through
      // the floor before they are heard.
      clackL = this.thumpLpL.run(clackL) * 1.4 + clackL * 0.25;
      clackR = this.thumpLpR.run(clackR) * 1.4 + clackR * 0.25;

      // --- squeal and brakes ---------------------------------------------------
      let squeal = 0;
      if (squealLevel > 0.001) {
        this.squealWob += 1.3 * dt; if (this.squealWob > 1) this.squealWob -= 1;
        this.squealBp.set(1250 + Math.sin(TAU * this.squealWob) * 220 + curve * 250, 12);
        // Gated hard: it must spend most of its time silent.
        const gate = Math.max(0, this.squealGate.run(white) * 60 - 0.45);
        squeal = this.squealBp.run(white) * squealLevel * Math.min(1, gate * 2) * 14;
      }
      let air = 0;
      if (shoeLevel > 0.001) air += this.shoeLp.run(this.shoeBp.run(pink) * 2.2) * shoeLevel;
      if (this.hiss > 0.001) { air += this.releaseLp.run(this.releaseHp.run(white)) * this.hiss * 0.16; this.hiss *= 0.99984; }
      // --- the emergency's dump ------------------------------------------------
      if (this.dump > 0.001) {
        const d = this.dump;
        air += (this.dumpLp.run(this.dumpBp.run(white)) * 1.2 + this.dumpRoar.run(white) * 0.7) * d * 0.4;
        this.dump *= 0.99996;
      }

      // --- horn -----------------------------------------------------------------
      let horn = 0;
      for (const h of this.horns) horn += h.run(hornOn, dt);
      horn *= 0.22;

      // --- mix, room, cab -------------------------------------------------------
      const shared = hollow + squeal + air + horn;
      const eng = this.centreLp.run(engine * (1 + cockpit * 0.6));
      let l = eng + (rollL + shared + this.tickLpL.run(clackL)) * exteriorMix;
      let r = eng + (rollR + shared + this.tickLpR.run(clackR)) * exteriorMix;
      if (wet > 0.002) {
        const wob = 0.75 + 0.25 * Math.tanh(this.pistonWob.run(white) * 30);
        const piston = (this.pistonLp.run(white) * 0.9 + this.pistonBp.run(white) * 0.8) * pistonLevel * wob;
        const rv = this.reverb.run((l + r) * 0.5 + piston);
        l = l * (1 - wet * 0.75) + rv * wet + piston * 0.5;
        r = r * (1 - wet * 0.75) + rv * wet + piston * 0.5;
      }
      if (cockpit > 0.01) {
        l = this.cabLpL.run(l) + this.cabAir.run(white) * 0.015 * cockpit;
        r = this.cabLpR.run(r) + this.cabAir.run(white) * 0.015 * cockpit;
      }
      outL[i] = Math.tanh(l * drive) * level;
      outR[i] = Math.tanh(r * drive) * level;
    }
    return true;
  }
}

registerProcessor('train', TrainProcessor);
