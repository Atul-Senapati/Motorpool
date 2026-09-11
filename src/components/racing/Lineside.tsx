'use client';

import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  CanvasTexture, Color, DoubleSide, Euler, InstancedMesh, Matrix4, Quaternion, SRGBColorSpace, Vector3,
} from 'three';
import {
  CATENARY, RAIL_HEAD_LIFT, TRAIN, TRAIN_LENGTH, TUNNEL, VIADUCT,
  trainNormalAt, trainPointAt, trainSpeedLimitAt, trainTangentAt, trainWrap,
} from '@/config/trainConfig';
import { pairCentreAt } from '@/config/trackPair';
import { trainsOnTrack } from '@/physics/trainRegistry';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The lineside: signals, boards and the overhead line.
 *
 * Everything here is placed by arc along the running line and yawed to it, on
 * the `Rail` samples `TrainLine` already has. Two tracks run the whole way
 * round — the running (up) line at 0, travelling +arc, and the down line
 * `gap` to its left, travelling -arc — and each has its own signals, boards
 * and wire. Local +z of a placed fitting is the direction it FACES (towards
 * the train that reads it), local +x its left.
 *
 * ## Signals are real
 *
 * Four-aspect colour lights every `BLOCK` metres, per track, reading block
 * occupancy from `trainRegistry`: red if the block ahead has a train in it,
 * single yellow if the next has, double yellow if the one after, green
 * otherwise. Every train — the one you drive and the AI services — reports
 * itself each physics step, so what a signal shows is what is actually on the
 * line ahead of it, and following an AI train through a section you will see
 * yellows come up and step back to green as it clears.
 *
 * ## The wire
 *
 * Masts every `MAST_PITCH` in the open on the running line's right-hand cess,
 * each carrying a boom over both tracks with a registration drop and insulator
 * per track. The contact wire runs at `CONTACT_HEIGHT`, staggered ±`STAGGER`
 * from mast to mast so the pantograph head wears evenly (that zigzag is the
 * one thing everyone recognises about a catenary); the messenger above it sags
 * between masts and the droppers hang the contact from it. Under ground the
 * catenary becomes a rigid conductor rail under the crown on short drop rods,
 * which is what tight-bore electrification uses and why the pantograph does not
 * have to fold.
 */

export interface LinesideSample extends LoftSample {
  structure: number;
  enclosed: boolean;
  cavern: boolean;
  double: boolean;
  gap: number;
  /** On the steel truss bridge, where the wire hangs from the trusses and there are no masts. */
  truss: boolean;
  /**
   * Inside the station's pointwork, where the masts give way to portals.
   *
   * A row of single-track masts down a four-road throat would put a column in
   * every cess and several of them between converging rails; the station spans
   * the lot from two masts and a lattice beam instead (`StationCatenary`). The
   * WIRES still run through — only the masts stand down.
   */
  yard: boolean;
}

const SLEEPER_BOTTOM = -(TRAIN.railHeight + TRAIN.sleeperHeight);

/* ------------------------------------------------------------- placement */

interface Placement { x: number; y: number; z: number; yaw: number }
/** A placement with a length of its own — a mast's height, a boom's span, a rod's drop. */
interface Sized extends Placement { h: number }

/** A point `off` metres left of the running line at `arc`, `rise` over the rail, facing `face` (+1 = +arc). */
function placeAt(arc: number, off: number, rise: number, face: 1 | -1): Placement {
  const s = trainWrap(arc);
  const [x, y, z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const [tx, tz] = trainTangentAt(s);
  return {
    x: x + nx * off, y: y + RAIL_HEAD_LIFT + rise, z: z + nz * off,
    yaw: Math.atan2(face * tx, face * tz),
  };
}

function sampleAt(samples: LinesideSample[], arc: number): LinesideSample {
  const step = TRAIN_LENGTH / (samples.length - 1);
  const i = Math.min(samples.length - 1, Math.max(0, Math.round(trainWrap(arc) / step)));
  return samples[i];
}

/** Instanced boxes at placements, optionally with a per-instance colour. */
function Instances({ items, size, offset = [0, 0, 0], color, emissive, emissiveIntensity = 0, metalness = 0.2, roughness = 0.7, basic = false }: {
  items: Placement[];
  size: [number, number, number];
  /** Local offset of the box from the placement, in the fitting's frame. */
  offset?: [number, number, number];
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  basic?: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const euler = new Euler();
    const local = new Vector3();
    items.forEach((p, i) => {
      euler.set(0, p.yaw, 0);
      quaternion.setFromEuler(euler);
      local.set(offset[0], offset[1], offset[2]).applyQuaternion(quaternion);
      position.set(p.x + local.x, p.y + local.y, p.z + local.z);
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    instanced.instanceMatrix.needsUpdate = true;
  }, [items, offset]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow receiveShadow>
      <boxGeometry args={size} />
      {basic
        ? <meshBasicMaterial color={color} toneMapped={false} />
        : <meshStandardMaterial color={color} emissive={emissive ?? '#000000'} emissiveIntensity={emissiveIntensity} metalness={metalness} roughness={roughness} />}
    </instancedMesh>
  );
}

/* --------------------------------------------------------------- signals */

/** Block length: a signal every this far along each track. */
const BLOCK = 450;
/** Signals stand in the cess, this far off their own track, clear of the vehicle and the wire masts. */
const SIGNAL_OFF = 2.7;
const POST_HEIGHT = 4.2;
const HEAD_H = 1.5;
const LAMP_R = 0.13;
/** Lamp order up the head: red, yellow, green, yellow — the standard four-aspect head. */
const LAMP_RISES = [0.25, 0.62, 0.99, 1.36].map((r) => POST_HEIGHT - HEAD_H + r);
const LIT = { red: new Color('#ff2418'), yellow: new Color('#ffb31a'), green: new Color('#22e05a') };
const UNLIT = new Color('#16171a');

interface Signal extends Placement { track: 0 | 1; direction: 1 | -1; entry: number }

function Signals({ samples }: { samples: LinesideSample[] }) {
  const signals = useMemo(() => {
    const out: Signal[] = [];
    for (const track of [0, 1] as const) {
      const direction: 1 | -1 = track === 0 ? 1 : -1;
      // Stagger the two tracks' blocks by half a block so the posts do not pair up.
      const phase = track === 0 ? 0 : BLOCK / 2;
      for (let entry = phase; entry < TRAIN_LENGTH; entry += BLOCK) {
        // Slide the signal a little off a portal or the hall if it lands in one.
        let arc = entry;
        let s = sampleAt(samples, arc);
        for (let tries = 0; tries < 12 && (s.enclosed || s.cavern); tries++) {
          arc -= direction * 15;
          s = sampleAt(samples, arc);
        }
        if (s.enclosed || s.cavern) continue;
        const off = track === 0 ? -SIGNAL_OFF : s.gap + SIGNAL_OFF;
        // Faces the approaching train: against its direction of travel.
        out.push({ ...placeAt(arc, off, SLEEPER_BOTTOM - 0.3, direction === 1 ? -1 : 1), track, direction, entry: arc });
      }
    }
    return out;
  }, [samples]);

  const lamps = useRef<(InstancedMesh | null)[]>([]);
  const clock = useRef(0);

  useFrame((_, delta) => {
    clock.current += delta;
    if (clock.current < 0.15) return;
    clock.current = 0;
    for (const track of [0, 1] as const) {
      const trains = trainsOnTrack(track);
      const occupied = (from: number, to: number) => trains.some((t) => {
        // The train's extent along the line: the leading end and its rake behind.
        const head = t.arc;
        const tail = t.arc - t.direction * t.length;
        const lo = Math.min(head, tail);
        const hi = Math.max(head, tail);
        // Ring-aware overlap of [lo, hi] with [from, to].
        for (const shift of [-TRAIN_LENGTH, 0, TRAIN_LENGTH]) {
          if (lo + shift < to && hi + shift > from) return true;
        }
        return false;
      });
      signals.forEach((sig, i) => {
        if (sig.track !== track) return;
        const d = sig.direction;
        const block = (n: number): [number, number] => {
          const a = sig.entry + d * n * BLOCK;
          const b = sig.entry + d * (n + 1) * BLOCK;
          return [Math.min(a, b), Math.max(a, b)];
        };
        const aspect = occupied(...block(0)) ? 0 : occupied(...block(1)) ? 1 : occupied(...block(2)) ? 2 : 3;
        // 0 red, 1 single yellow, 2 double yellow, 3 green.
        const colours = [
          aspect === 0 ? LIT.red : UNLIT,
          aspect === 1 || aspect === 2 ? LIT.yellow : UNLIT,
          aspect === 3 ? LIT.green : UNLIT,
          aspect === 2 ? LIT.yellow : UNLIT,
        ];
        colours.forEach((c, k) => {
          const mesh = lamps.current[k];
          if (!mesh) return;
          mesh.setColorAt(i, c);
        });
      });
    }
    for (const mesh of lamps.current) if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  // Lamp discs: one instanced mesh per position up the head, coloured per signal.
  const lampMeshes = LAMP_RISES.map((rise, k) => (
    <LampDisc key={k} items={signals} rise={rise} ref={(m) => { lamps.current[k] = m; }} />
  ));

  return (
    <group>
      <Instances items={signals} size={[0.12, POST_HEIGHT, 0.12]} offset={[0, POST_HEIGHT / 2, -0.2]} color="#7d8288" metalness={0.5} roughness={0.5} />
      <Instances items={signals} size={[0.4, HEAD_H, 0.28]} offset={[0, POST_HEIGHT - HEAD_H / 2 + 0.1, -0.02]} color="#101214" roughness={0.6} />
      {/* Hoods over each lamp, and the identification plate. */}
      {LAMP_RISES.map((rise, k) => (
        <Instances key={k} items={signals} size={[0.34, 0.03, 0.18]} offset={[0, rise + LAMP_R + 0.04, 0.2]} color="#101214" roughness={0.6} />
      ))}
      <Instances items={signals} size={[0.22, 0.14, 0.01]} offset={[0.0, 1.5, 0.13]} color="#f2f2ea" basic />
      {lampMeshes}
      {/* A ladder/cable up the back of the post. */}
      <Instances items={signals} size={[0.03, POST_HEIGHT - 0.4, 0.03]} offset={[0.1, POST_HEIGHT / 2, -0.28]} color="#3a3c40" metalness={0.5} />
    </group>
  );
}

const LampDisc = forwardRef<InstancedMesh, { items: Placement[]; rise: number }>(function LampDisc({ items, rise }, ref) {
  const inner = useRef<InstancedMesh | null>(null);
  useEffect(() => {
    const instanced = inner.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const euler = new Euler();
    const local = new Vector3();
    items.forEach((p, i) => {
      euler.set(0, p.yaw, 0);
      quaternion.setFromEuler(euler);
      local.set(0, rise, 0.15).applyQuaternion(quaternion);
      position.set(p.x + local.x, p.y + local.y, p.z + local.z);
      instanced.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      instanced.setColorAt(i, UNLIT);
    });
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  }, [items, rise]);
  if (!items.length) return null;
  return (
    <instancedMesh
      ref={(m) => { inner.current = m; if (typeof ref === 'function') ref(m); else if (ref) ref.current = m; }}
      args={[undefined, undefined, items.length]} frustumCulled={false}
    >
      <circleGeometry args={[LAMP_R, 18]} />
      <meshBasicMaterial toneMapped={false} side={DoubleSide} />
    </instancedMesh>
  );
});

/* ---------------------------------------------------------------- boards */

function textPlate(lines: string[], w: number, h: number, bg: string, fg: string, border?: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.round(w * 0.06);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.floor((h / lines.length) * 0.72);
  ctx.font = `bold ${size}px "Helvetica Neue", Arial, sans-serif`;
  lines.forEach((line, i) => ctx.fillText(line, w / 2, (h / lines.length) * (i + 0.5)));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

interface Board { place: Placement; texture: CanvasTexture; width: number; height: number; post: number }

const BOARD_OFF = 2.7;

function Boards({ samples }: { samples: LinesideSample[] }) {
  const boards = useMemo(() => {
    const out: Board[] = [];
    const speedTex = new Map<number, CanvasTexture>();
    const speedPlate = (kph: number) => {
      let t = speedTex.get(kph);
      if (!t) { t = textPlate([String(kph)], 128, 128, '#f4f2ea', '#111111', '#c8102e'); speedTex.set(kph, t); }
      return t;
    };
    const kph = (arc: number) => Math.round((trainSpeedLimitAt(trainWrap(arc)) * 3.6) / 10) * 10;
    // Speed boards: at the start of each PLATEAU of permissible speed, read in
    // the direction of travel, for each track, in its cess, facing its trains.
    // The limit in the route file is interpolated between points, so it ramps
    // through every 10 km/h on the way from one value to the next; a board at
    // every change would be a board every ten metres up the ramp. A plateau is
    // a stretch of at least PLATEAU metres at one value, and its first metre in
    // the direction of travel is where the board goes.
    const PLATEAU = 150;
    const STEP = 10;
    const values: number[] = [];
    for (let arc = 0; arc < TRAIN_LENGTH; arc += STEP) values.push(kph(arc));
    const n = values.length;
    for (const track of [0, 1] as const) {
      const direction: 1 | -1 = track === 0 ? 1 : -1;
      const face: 1 | -1 = direction === 1 ? -1 : 1;
      let i = 0;
      let placedValue = -1;
      while (i < n) {
        // Run of equal values starting at i, walking in the direction of travel.
        const v = values[((direction === 1 ? i : n - 1 - i) % n + n) % n];
        let run = 1;
        while (run < n && values[(((direction === 1 ? i + run : n - 1 - i - run) % n) + n) % n] === v) run++;
        if (run * STEP >= PLATEAU && v !== placedValue) {
          const startIndex = ((direction === 1 ? i : n - 1 - i) % n + n) % n;
          const arc = startIndex * STEP;
          const s = sampleAt(samples, arc);
          if (!s.enclosed && !s.cavern) {
            const off = track === 0 ? -BOARD_OFF : s.gap + BOARD_OFF;
            out.push({ place: placeAt(arc, off, SLEEPER_BOTTOM - 0.3, face), texture: speedPlate(v), width: 0.6, height: 0.6, post: 2.3 });
          }
          placedValue = v;
        }
        i += run;
      }
    }
    // Kilometre posts every 500 m, on the running line's right, both faces.
    for (let arc = 0; arc < TRAIN_LENGTH; arc += 500) {
      const s = sampleAt(samples, arc);
      if (s.enclosed || s.cavern) continue;
      const km = (arc / 1000).toFixed(1);
      out.push({ place: placeAt(arc + 7, -BOARD_OFF - 0.4, SLEEPER_BOTTOM - 0.3, -1), texture: textPlate([km], 96, 128, '#f4f2ea', '#111111'), width: 0.3, height: 0.4, post: 1.0 });
    }
    // Tunnel boards 150 m before each portal, per direction.
    for (const track of [0, 1] as const) {
      const direction: 1 | -1 = track === 0 ? 1 : -1;
      const face: 1 | -1 = direction === 1 ? -1 : 1;
      const step = TRAIN_LENGTH / (samples.length - 1);
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        // Entering an enclosed stretch in this direction.
        const enters = direction === 1 ? (!a.enclosed && b.enclosed) : (a.enclosed && !b.enclosed);
        if (!enters || a.structure !== TUNNEL && b.structure !== TUNNEL) continue;
        const portal = (direction === 1 ? b : a).arc;
        const arc = portal - direction * 150;
        const s = sampleAt(samples, arc);
        if (s.enclosed || s.cavern) continue;
        const off = track === 0 ? -BOARD_OFF : s.gap + BOARD_OFF;
        out.push({ place: placeAt(arc, off, SLEEPER_BOTTOM - 0.3, face), texture: textPlate(['TUNNEL', `${Math.round(150 / step) * step} m`], 192, 128, '#f4f2ea', '#111111', '#111111'), width: 0.75, height: 0.5, post: 2.0 });
      }
    }
    return out;
  }, [samples]);

  useEffect(() => () => { for (const b of boards) b.texture.dispose(); }, [boards]);

  return (
    <group>
      {boards.map((b, i) => (
        <group key={i} position={[b.place.x, b.place.y, b.place.z]} rotation={[0, b.place.yaw, 0]}>
          <mesh position={[0, b.post / 2, -0.03]} castShadow>
            <boxGeometry args={[0.07, b.post, 0.07]} />
            <meshStandardMaterial color="#7d8288" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, b.post + b.height / 2 - 0.05, 0.02]} castShadow>
            <boxGeometry args={[b.width, b.height, 0.03]} />
            <meshStandardMaterial color="#2a2a2c" roughness={0.6} />
          </mesh>
          <mesh position={[0, b.post + b.height / 2 - 0.05, 0.04]}>
            <planeGeometry args={[b.width - 0.02, b.height - 0.02]} />
            <meshBasicMaterial map={b.texture} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------- catenary */

// The dimensions live in `CATENARY` so the station can wire its loops to the
// same heights — see the note there.
const MAST_PITCH = CATENARY.mastPitch;
const CONTACT_HEIGHT = CATENARY.contact;
const MESSENGER_HEIGHT = CATENARY.messenger;
const MESSENGER_SAG = CATENARY.sag;
const STAGGER = CATENARY.stagger;
const MAST_TOP = CATENARY.mastTop;
const MAST_OFF = CATENARY.mastOff;
const DROPPER_PITCH = CATENARY.dropperPitch;
/** The rigid conductor rail under ground, and its drop rods. */
const CONDUCTOR_HEIGHT = 5.05;
const ROD_PITCH = 10;

/** Which mast bay `arc` is in, and how far through it (0..1). */
const bay = (arc: number) => {
  const k = Math.floor(arc / MAST_PITCH);
  return { k, u: (arc - k * MAST_PITCH) / MAST_PITCH };
};
/** The contact wire's lateral zigzag: ±STAGGER at the masts, straight between. */
const stagger = (arc: number) => {
  const { k, u } = bay(arc);
  const a = k % 2 === 0 ? STAGGER : -STAGGER;
  return a + (-a - a) * u;
};
const sag = (arc: number) => {
  const { u } = bay(arc);
  return MESSENGER_SAG * 4 * u * (1 - u);
};

const wire = (track: 0 | 1, rise: (s: LinesideSample) => number, lateral: (s: LinesideSample) => number, half: number): ProfileVertex<LinesideSample>[] => {
  const off = (s: LinesideSample) => (track === 0 ? 0 : s.gap) + lateral(s);
  return [
    { off: (s) => off(s) - half, rise: (s) => rise(s) - half },
    { off: (s) => off(s) + half, rise: (s) => rise(s) - half },
    { off: (s) => off(s) + half, rise: (s) => rise(s) + half },
    { off: (s) => off(s) - half, rise: (s) => rise(s) + half },
  ];
};

/** A straight tube between two world points, with a radius. */
interface Tube { a: Vector3; b: Vector3; r: number }
/** World point `off` metres left of the running line at `arc`, `rise` over the rail. */
function worldAt(arc: number, off: number, rise: number): Vector3 {
  const s = trainWrap(arc);
  const [x, y, z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  return new Vector3(x + nx * off, y + RAIL_HEAD_LIFT + rise, z + nz * off);
}

/**
 * The overhead line, Indian Railways fashion: an independent mast for every
 * track in its own cess, each with a swivelling cantilever — bracket tube
 * sloping down from the mast top to the messenger, a stay tube holding it, a
 * registration tube out to the steady arm that sets the contact wire's stagger
 * — on stem insulators where the tubes leave the mast. No portals: on a
 * two-track line that is a row of masts down BOTH sides, which is the picture
 * everyone has of an electrified main line in India.
 */
function Catenary({ samples }: { samples: LinesideSample[] }) {
  const built = useMemo(() => {
    const open = (a: LinesideSample, b: LinesideSample) => !a.enclosed && !b.enclosed;
    const under = (a: LinesideSample, b: LinesideSample) => a.enclosed || b.enclosed;
    const lofts = ([0, 1] as const).flatMap((track) => [
      buildLoft(samples, wire(track, () => CONTACT_HEIGHT, (s) => stagger(s.arc), 0.016), { closed: true, filter: open }),
      buildLoft(samples, wire(track, (s) => MESSENGER_HEIGHT - sag(s.arc), () => 0, 0.013), { closed: true, filter: open }),
    ]);
    const conductors = ([0, 1] as const).map((track) => (
      buildLoft(samples, [
        { off: (s) => (track === 0 ? 0 : s.gap) - 0.06, rise: CONDUCTOR_HEIGHT - 0.05 },
        { off: (s) => (track === 0 ? 0 : s.gap) + 0.06, rise: CONDUCTOR_HEIGHT - 0.05 },
        { off: (s) => (track === 0 ? 0 : s.gap) + 0.06, rise: CONDUCTOR_HEIGHT + 0.05 },
        { off: (s) => (track === 0 ? 0 : s.gap) - 0.06, rise: CONDUCTOR_HEIGHT + 0.05 },
      ], { closed: true, filter: under })
    ));

    const masts: Sized[] = [];
    const plates: Placement[] = [];
    const steel: Tube[] = [];
    const insulators: Tube[] = [];
    const droppers: Tube[] = [];
    const rods: Tube[] = [];
    for (let arc = MAST_PITCH / 2; arc < TRAIN_LENGTH; arc += MAST_PITCH) {
      const s = sampleAt(samples, arc);
      if (s.enclosed || s.cavern || s.truss || s.yard) continue;
      // Foot: on the ballast shoulder, or on the deck where the line is a bridge.
      const foot = s.structure === VIADUCT ? SLEEPER_BOTTOM : SLEEPER_BOTTOM - 0.65;
      for (const track of [0, 1] as const) {
        const centre = track === 0 ? 0 : s.gap;
        // The mast is outboard of its track: right of the running line, left of the down line.
        const side = track === 0 ? -1 : 1;
        const mastOff = centre + side * MAST_OFF;
        const mast = placeAt(arc, mastOff, foot, 1);
        masts.push({ ...mast, y: mast.y + (MAST_TOP - foot) / 2, h: MAST_TOP - foot });
        plates.push(placeAt(arc, mastOff - side * 0.16, 3.6, track === 0 ? -1 : 1));
        const st = stagger(arc);
        const wireX = centre + st;
        // Cantilever. The bracket leaves the mast high and slopes down to the
        // messenger; the stay leaves lower and meets the bracket part way; the
        // registration tube runs out level to the steady arm, which sets the
        // contact wire's stagger.
        const root = mastOff - side * 0.14;
        const bracketTop = worldAt(arc, root, MAST_TOP - 0.55);
        const messengerPt = worldAt(arc, wireX, MESSENGER_HEIGHT + 0.06);
        const bracketEnd = messengerPt.clone().add(worldAt(arc, wireX, MESSENGER_HEIGHT + 0.06).sub(bracketTop).normalize().multiplyScalar(0.5));
        steel.push({ a: bracketTop, b: bracketEnd, r: 0.035 });
        const stayRoot = worldAt(arc, root, MESSENGER_HEIGHT - 0.9);
        const stayEnd = bracketTop.clone().lerp(messengerPt, 0.62);
        steel.push({ a: stayRoot, b: stayEnd, r: 0.03 });
        const regRoot = worldAt(arc, root, CONTACT_HEIGHT + 0.42);
        const regEnd = worldAt(arc, wireX - side * 0.85, CONTACT_HEIGHT + 0.38);
        steel.push({ a: regRoot, b: regEnd, r: 0.03 });
        // Steady arm: from the registration tube's end back to the contact wire.
        steel.push({ a: regEnd, b: worldAt(arc, wireX, CONTACT_HEIGHT + 0.05), r: 0.022 });
        // The messenger hangs off the bracket end: a short link.
        steel.push({ a: bracketEnd, b: messengerPt, r: 0.02 });
        // Stem insulators where the tubes leave the mast.
        for (const [rootPt, endPt] of [[bracketTop, bracketEnd], [stayRoot, stayEnd], [regRoot, regEnd]] as const) {
          const dir = endPt.clone().sub(rootPt).normalize();
          insulators.push({ a: rootPt.clone().add(dir.clone().multiplyScalar(0.12)), b: rootPt.clone().add(dir.clone().multiplyScalar(0.62)), r: 0.075 });
        }
      }
    }
    // Droppers between messenger and contact wire.
    for (let arc = DROPPER_PITCH / 2; arc < TRAIN_LENGTH; arc += DROPPER_PITCH) {
      const s = sampleAt(samples, arc);
      if (s.enclosed) continue;
      for (const track of [0, 1] as const) {
        const centre = track === 0 ? 0 : s.gap;
        const x = centre + stagger(arc);
        droppers.push({ a: worldAt(arc, x, MESSENGER_HEIGHT - sag(arc)), b: worldAt(arc, x, CONTACT_HEIGHT + 0.02), r: 0.011 });
      }
    }
    // Drop rods for the conductor rail, from the crown.
    for (let arc = 0; arc < TRAIN_LENGTH; arc += ROD_PITCH) {
      const s = sampleAt(samples, arc);
      if (!s.enclosed) continue;
      for (const track of [0, 1] as const) {
        const centre = track === 0 ? 0 : s.gap;
        const dx = centre - pairCentreAt(arc);
        const archTop = s.cavern ? 8.85 : TRAIN.boreWall + Math.sqrt(Math.max(0, TRAIN.boreHalf ** 2 - dx * dx)) - 0.1;
        rods.push({ a: worldAt(arc, centre, archTop), b: worldAt(arc, centre, CONDUCTOR_HEIGHT + 0.05), r: 0.03 });
      }
    }
    return { lofts, conductors, masts, plates, steel, insulators, droppers, rods };
  }, [samples]);

  useEffect(() => () => {
    for (const l of [...built.lofts, ...built.conductors]) l.geometry.dispose();
  }, [built]);

  return (
    <group>
      {built.lofts.map((l, i) => (
        <mesh key={`w${i}`} geometry={l.geometry}>
          <meshStandardMaterial color={i % 2 === 0 ? '#5c3f2e' : '#6f7276'} metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
      {built.conductors.map((c, i) => (
        <mesh key={`c${i}`} geometry={c.geometry}>
          <meshStandardMaterial color="#8f9398" emissive="#2a2b2e" emissiveIntensity={0.4} metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* H-section masts: web and two flanges, each scaled to its own height. */}
      <Scaled items={built.masts} size={(h) => [0.05, h, 0.22]} color="#7d8288" />
      <Scaled items={built.masts} size={(h) => [0.24, h, 0.03]} offset={[0, 0, 0.11]} color="#7d8288" />
      <Scaled items={built.masts} size={(h) => [0.24, h, 0.03]} offset={[0, 0, -0.11]} color="#7d8288" />
      {/* Mast number plates. */}
      <Instances items={built.plates} size={[0.02, 0.28, 0.2]} color="#f2f0e6" basic />
      <Tubes items={built.steel} color="#8a8f94" metalness={0.6} roughness={0.4} />
      <Tubes items={built.insulators} color="#5b3a2a" metalness={0.1} roughness={0.55} />
      <Tubes items={built.droppers} color="#55585c" metalness={0.6} roughness={0.4} />
      <Tubes items={built.rods} color="#6a6d70" metalness={0.6} roughness={0.4} />
    </group>
  );
}

/** Instanced cylinders from `a` to `b`, radius `r` — tubes, insulators, droppers, rods. */
function Tubes({ items, color, metalness = 0.5, roughness = 0.5 }: { items: Tube[]; color: string; metalness?: number; roughness?: number }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    const dir = new Vector3();
    items.forEach((t, i) => {
      dir.subVectors(t.b, t.a);
      const len = dir.length();
      dir.normalize();
      quaternion.setFromUnitVectors(up, dir);
      position.addVectors(t.a, t.b).multiplyScalar(0.5);
      scale.set(t.r, Math.max(0.01, len), t.r);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow>
      <cylinderGeometry args={[1, 1, 1, 8]} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
    </instancedMesh>
  );
}

/** Instanced steel boxes, each scaled by its own `h` through `size`. */
function Scaled({ items, size, offset = [0, 0, 0], color = '#8a8f94' }: {
  items: Sized[]; size: (h: number) => [number, number, number]; offset?: [number, number, number]; color?: string;
}) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const euler = new Euler();
    items.forEach((p, i) => {
      euler.set(0, p.yaw, 0);
      quaternion.setFromEuler(euler);
      const local = new Vector3(offset[0], offset[1], offset[2]).applyQuaternion(quaternion);
      position.set(p.x + local.x, p.y + local.y, p.z + local.z);
      const [sx, sy, sz] = size(p.h);
      scale.set(sx, sy, sz);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items, size, offset]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} metalness={0.55} roughness={0.45} />
    </instancedMesh>
  );
}

export function Lineside({ samples }: { samples: LinesideSample[] }) {
  return (
    <group>
      <Signals samples={samples} />
      <Boards samples={samples} />
      <Catenary samples={samples} />
    </group>
  );
}
