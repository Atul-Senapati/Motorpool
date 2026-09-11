/**
 * The sea state: one description of the water, read by everything that touches it.
 *
 * The water started as a lighting effect — a flat plane whose NORMAL waves, so
 * that a two-triangle surface catches light like a moving one (`Environment`).
 * That was enough while nothing floated. It is not enough now: a boat has to
 * rise on the same swell you can see, or it planes across a painted picture.
 *
 * So the waves live here, as data, and three things read them:
 *
 *   the shader   builds its GLSL from this table (`seaWaveGLSL`), so what you
 *                see is this and not a second copy of it
 *   the physics  samples `seaHeightAt` under each corner of a hull, which is
 *                where heave, pitch and roll come from (`BoatRide`)
 *   the traffic  rides the same heights, so a scripted boat and a driven one
 *                sit in the same water
 *
 * A wave here is the textbook one — a travelling sine, `A sin(k·x − ωt)` — and
 * the sum of four of them. Not Gerstner: a Gerstner wave displaces water
 * horizontally as well as vertically, which sharpens crests and looks better,
 * and it also means the surface is no longer a height field. A height field is
 * what makes `seaHeightAt` a closed-form answer instead of a search, and a
 * closed-form answer is what lets the physics sample four points per hull per
 * step without thinking about it.
 *
 * ## Why these four
 *
 * Two long swells set the motion — 42 m and 27 m, a few seconds apart in
 * period, so they beat against each other and the sea never repeats visibly.
 * An 11 m cross-swell breaks up the corduroy that two waves alone produce. The
 * 4.3 m chop is there for the specular glitter and contributes four millimetres
 * of height, which is to say it is a lighting term with a token amplitude
 * rather than a wave a boat can feel.
 *
 * Total height is about ±0.46 m, so nine tenths of a metre peak to trough.
 *
 * It was twice that, and twice was too much — a 16 m yacht pitched six
 * degrees and heaved two feet in flat calm, which read as a gale rather than
 * as a sea. The visible sea barely changed when the swell was halved, because
 * what you SEE is the slope (amplitude over wavelength) and the specular
 * response to it, while what a boat FEELS is the amplitude itself. So the
 * long swells came down and the short chop, which is where most of the
 * glitter comes from, stayed.
 */
import { TRAIN } from './trainConfig';

const TAU = Math.PI * 2;

export interface SeaWave {
  /** Unit direction of travel, in world XZ. */
  dir: readonly [number, number];
  /** Wavelength, metres. */
  length: number;
  /** Phase speed, metres per second. */
  speed: number;
  /** Amplitude, metres — half the crest-to-trough height. */
  amplitude: number;
}

const unit = (x: number, z: number): readonly [number, number] => {
  const len = Math.hypot(x, z) || 1;
  return [x / len, z / len];
};

export const SEA_WAVES: ReadonlyArray<SeaWave> = [
  { dir: unit(1, 0.35), length: 42, speed: 3.1, amplitude: 0.30 },
  { dir: unit(0.2, -1), length: 27, speed: 2.4, amplitude: 0.13 },
  { dir: unit(-0.8, 0.6), length: 11, speed: 1.6, amplitude: 0.030 },
  { dir: unit(0.9, -0.4), length: 4.3, speed: 1.1, amplitude: 0.004 },
];

/** Still-water level. The waves are measured from it. */
export const SEA_LEVEL = TRAIN.seaLevel;

/**
 * The highest the sea can ever reach above still water, metres.
 *
 * Every wave at its crest at once — which never happens, but it is the bound,
 * and a bound is what a hull's freeboard has to be measured against. Summed
 * from the table rather than written down, so adding a wave cannot quietly
 * leave it stale.
 */
export const SEA_REACH = SEA_WAVES.reduce((sum, w) => sum + w.amplitude, 0);

/** The height of the water at a world point, at a moment. */
export function seaHeightAt(x: number, z: number, time: number): number {
  let h = 0;
  for (const wave of SEA_WAVES) {
    const k = TAU / wave.length;
    h += wave.amplitude * Math.sin((wave.dir[0] * x + wave.dir[1] * z) * k - time * wave.speed * k);
  }
  return SEA_LEVEL + h;
}

/**
 * The surface slope at a world point: `[dy/dx, dy/dz]`.
 *
 * The analytic derivative of the sum above, which is both exact and cheaper
 * than sampling the height twice — and it is what tilts a boat to lie along
 * the wave it is on rather than staying stubbornly level.
 */
export function seaSlopeAt(x: number, z: number, time: number): [number, number] {
  let dx = 0;
  let dz = 0;
  for (const wave of SEA_WAVES) {
    const k = TAU / wave.length;
    const phase = (wave.dir[0] * x + wave.dir[1] * z) * k - time * wave.speed * k;
    const d = wave.amplitude * k * Math.cos(phase);
    dx += wave.dir[0] * d;
    dz += wave.dir[1] * d;
  }
  return [dx, dz];
}

/**
 * The same waves as GLSL, generated from the table above.
 *
 * Returns the body of a slope sum and a height sum over `vec2 p`, for
 * injection into the sea material. Generated rather than written out because
 * the alternative is four magic numbers in a shader string that have to be
 * kept in step by hand with the four above — and the failure mode is a boat
 * floating a foot over its own reflection, which is exactly the kind of thing
 * nobody notices until it is everywhere.
 */
export function seaWaveGLSL(): { slope: string; height: string; displace: string } {
  const slope = SEA_WAVES.map((w) => (
    `  slope += waveSlope(p, vec2(${w.dir[0].toFixed(5)}, ${w.dir[1].toFixed(5)}), `
    + `${w.length.toFixed(2)}, ${w.speed.toFixed(2)}, ${w.amplitude.toFixed(4)});`
  )).join('\n');
  // The visible tint only wants the swell, so it sums the two long waves; the
  // short ones move the normal and nothing else.
  const height = SEA_WAVES.slice(0, 2).map((w) => (
    `  h += ${w.amplitude.toFixed(4)} * sin(dot(vec2(${w.dir[0].toFixed(5)}, ${w.dir[1].toFixed(5)}), p) `
    + `* (6.2831853 / ${w.length.toFixed(2)}) - uTime * ${w.speed.toFixed(2)} * (6.2831853 / ${w.length.toFixed(2)}));`
  )).join('\n');
  // Every wave, summed as a HEIGHT. This is what actually moves the vertices of
  // the patch of sea around the camera (`SeaSurface`), and it is deliberately
  // the whole table rather than the two long swells the tint uses: the point of
  // the patch is that the water you are floating in has the shape the physics
  // says it has, and `seaHeightAt` sums all four.
  const displace = SEA_WAVES.map((w) => (
    `  h += ${w.amplitude.toFixed(4)} * sin(dot(vec2(${w.dir[0].toFixed(5)}, ${w.dir[1].toFixed(5)}), p) `
    + `* (6.2831853 / ${w.length.toFixed(2)}) - uTime * ${w.speed.toFixed(2)} * (6.2831853 / ${w.length.toFixed(2)}));`
  )).join('\n');
  return { slope, height, displace };
}
