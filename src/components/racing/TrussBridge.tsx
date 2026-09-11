'use client';

import { useEffect, useMemo, useRef } from 'react';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { RAIL_HEAD_LIFT, TRAIN, trainTangentAt } from '@/config/trainConfig';
import { buildLoft, type LoftSample } from './railGeometry';

/**
 * A steel Pratt through-truss railway bridge with inclined end posts — the
 * river crossing in every sunset photograph.
 *
 * ## The structure, as in the photograph
 *
 * Each span is `PANELS` equal panels, the truss as tall as a panel is long, so
 * the interior panels are squares. The top chord is horizontal over the
 * interior nodes only; the END POSTS slope from the abutment up to the first
 * top node, which is the profile everyone recognises. A vertical at every
 * interior node. ONE diagonal per interior panel, sloping down towards
 * mid-span — Pratt — so the two halves mirror. Across the top, a strut at
 * every node and an X in every panel; a latticed portal frame in each end
 * post; floor beams at every bottom node with stringers under each rail; a
 * plate deck between the chords; a grated walkway with a handrail on one side;
 * bearings on concrete piers and abutments. The overhead wire hangs from the
 * top struts — no masts on the bridge.
 *
 * ## Even
 *
 * Nothing here is lofted along the alignment except the deck plate and the
 * handrail: every chord, post, diagonal and brace is a straight bar between two
 * exact node points, so panels are identical and the two trusses are mirror
 * images. That is what makes a truss read as engineered rather than drawn. The
 * crossing it sits on is straight to a tenth of a degree and level.
 */

export interface TrussSample extends LoftSample {
  y: number;
  fill: number;
  gap: number;
  truss: boolean;
}

const SLEEPER_BOTTOM = -(TRAIN.railHeight + TRAIN.sleeperHeight);
const DECK_TOP = SLEEPER_BOTTOM - 0.02;
/** Bottom chord centreline, and truss height above it. */
const CHORD_RISE = DECK_TOP + 0.36;
const HEIGHT = 10.0;
const PANELS = 6;
/** Target span; the run is divided into whole spans nearest this. */
const SPAN = 66;
/** Trusses stand this far outside each track's centre. */
const CLEAR = 3.5;
const WALK = 1.0;
/** Overhead messenger height, to hang the wire from the struts. */
const MESSENGER = 6.35;

const STEEL = { color: '#2f2b28', metalness: 0.55, roughness: 0.6 } as const;

export interface Bar { a: Vector3; b: Vector3; w: number; d: number }
export interface Block { p: Vector3; yaw: number; size: [number, number, number] }

/** A point on the alignment at `arc`, `off` left, `rise` over the rail, from the nearest sample. */
function makePointer(samples: TrussSample[]) {
  const step = samples.length > 1 ? samples[1].arc - samples[0].arc : 5;
  return (arc: number, off: number, rise: number): Vector3 => {
    const i = Math.min(samples.length - 2, Math.max(0, Math.floor(arc / step)));
    const a = samples[i];
    const b = samples[i + 1];
    const t = Math.min(1, Math.max(0, (arc - a.arc) / Math.max(b.arc - a.arc, 1e-6)));
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = a.y + (b.y - a.y) * t;
    const nx = a.nx + (b.nx - a.nx) * t;
    const nz = a.nz + (b.nz - a.nz) * t;
    // `Rail.y` is already the rail head (lift included) — see `sampleLine`.
    return new Vector3(x + nx * off, y + rise, z + nz * off);
  };
}

function runsOf(samples: TrussSample[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  samples.forEach((s, i) => {
    if (s.truss && start < 0) start = i;
    if (!s.truss && start >= 0) { runs.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) runs.push([start, samples.length - 1]);
  return runs;
}

export function TrussBridge({ samples }: { samples: TrussSample[] }) {
  const built = useMemo(() => {
    const runs = runsOf(samples);
    if (!runs.length) return null;
    const P = makePointer(samples);
    const isTruss = (a: TrussSample, b: TrussSample) => a.truss && b.truss;
    const gap = samples.find((s) => s.truss)?.gap ?? TRAIN.elevated.trackGap;
    const RIGHT = -CLEAR;
    const LEFT = gap + CLEAR;

    // Deck plate between the chords, and the walkway grating outside the right truss.
    const deck = buildLoft(samples, [
      { off: RIGHT + 0.3, rise: DECK_TOP },
      { off: LEFT - 0.3, rise: DECK_TOP },
      { off: LEFT - 0.3, rise: DECK_TOP - 0.16 },
      { off: RIGHT + 0.3, rise: DECK_TOP - 0.16 },
    ], { closed: true, filter: isTruss, vScale: 6 });
    const walkway = buildLoft(samples, [
      { off: RIGHT - 0.35, rise: DECK_TOP + 0.1 },
      { off: RIGHT - 0.35 - WALK, rise: DECK_TOP + 0.1 },
      { off: RIGHT - 0.35 - WALK, rise: DECK_TOP + 0.02 },
      { off: RIGHT - 0.35, rise: DECK_TOP + 0.02 },
    ], { closed: true, filter: isTruss, vScale: 6 });
    const handrail = (rise: number) => buildLoft(samples, [
      { off: RIGHT - 0.35 - WALK - 0.02, rise: rise - 0.02 },
      { off: RIGHT - 0.35 - WALK + 0.02, rise: rise - 0.02 },
      { off: RIGHT - 0.35 - WALK + 0.02, rise: rise + 0.02 },
      { off: RIGHT - 0.35 - WALK - 0.02, rise: rise + 0.02 },
    ], { closed: true, filter: isTruss, vScale: 6 });
    const rails = [handrail(DECK_TOP + 1.1), handrail(DECK_TOP + 0.6)];

    const bars: Bar[] = [];
    const light: Bar[] = [];
    const plates: Block[] = [];
    const concrete: Block[] = [];
    const bearings: Block[] = [];
    const bar = (a: Vector3, b: Vector3, w: number, d = w) => bars.push({ a, b, w, d });
    const rod = (a: Vector3, b: Vector3, w: number) => light.push({ a, b, w, d: w });

    for (const [from, to] of runs) {
      const startArc = samples[from].arc;
      const endArc = samples[to].arc;
      const length = endArc - startArc;
      const spans = Math.max(1, Math.round(length / SPAN));
      const spanLength = length / spans;
      const panel = spanLength / PANELS;
      const top = CHORD_RISE + HEIGHT;

      for (let sp = 0; sp < spans; sp++) {
        const s0 = startArc + sp * spanLength;
        // Node arcs 0..PANELS along this span.
        const node = (k: number) => s0 + k * panel;
        for (const side of [RIGHT, LEFT]) {
          const B = (k: number) => P(node(k), side, CHORD_RISE);
          const T = (k: number) => P(node(k), side, top);
          // Bottom chord, node to node.
          for (let k = 0; k < PANELS; k++) bar(B(k), B(k + 1), 0.5, 0.62);
          // Top chord over the interior nodes only.
          for (let k = 1; k < PANELS - 1; k++) bar(T(k), T(k + 1), 0.5, 0.62);
          // Inclined end posts.
          bar(B(0), T(1), 0.5, 0.62);
          bar(B(PANELS), T(PANELS - 1), 0.5, 0.62);
          // Verticals at every interior node.
          for (let k = 1; k < PANELS; k++) bar(B(k), T(k), 0.34, 0.44);
          // Pratt diagonals: one per interior panel, sloping DOWN towards mid-span.
          for (let k = 1; k < PANELS - 1; k++) {
            const towardsCentre = k < PANELS / 2;
            if (towardsCentre) bar(T(k), B(k + 1), 0.24, 0.3);
            else bar(T(k + 1), B(k), 0.24, 0.3);
          }
          // Gusset plates at every node.
          for (let k = 0; k <= PANELS; k++) {
            plates.push({ p: B(k), yaw: yawAt(node(k)), size: [0.14, 0.95, 0.95] });
            if (k > 0 && k < PANELS) plates.push({ p: T(k), yaw: yawAt(node(k)), size: [0.14, 0.95, 0.95] });
          }
        }
        // Across the top: strut at every interior node, X in every interior panel.
        for (let k = 1; k < PANELS; k++) bar(P(node(k), RIGHT, top), P(node(k), LEFT, top), 0.3, 0.36);
        for (let k = 1; k < PANELS - 1; k++) {
          rod(P(node(k), RIGHT, top - 0.05), P(node(k + 1), LEFT, top - 0.05), 0.11);
          rod(P(node(k), LEFT, top - 0.05), P(node(k + 1), RIGHT, top - 0.05), 0.11);
        }
        // Portal frames in the end posts: two struts and a lattice between them.
        for (const [b, t] of [[0, 1], [PANELS, PANELS - 1]] as const) {
          for (const f of [0.62, 0.86]) {
            const r = P(node(b), RIGHT, CHORD_RISE).lerp(P(node(t), RIGHT, top), f);
            const l = P(node(b), LEFT, CHORD_RISE).lerp(P(node(t), LEFT, top), f);
            bar(r, l, 0.26, 0.3);
          }
          const r1 = P(node(b), RIGHT, CHORD_RISE).lerp(P(node(t), RIGHT, top), 0.62);
          const r2 = P(node(b), RIGHT, CHORD_RISE).lerp(P(node(t), RIGHT, top), 0.86);
          const l1 = P(node(b), LEFT, CHORD_RISE).lerp(P(node(t), LEFT, top), 0.62);
          const l2 = P(node(b), LEFT, CHORD_RISE).lerp(P(node(t), LEFT, top), 0.86);
          const mid1 = r1.clone().lerp(l1, 0.5);
          const mid2 = r2.clone().lerp(l2, 0.5);
          rod(r1, mid2, 0.11); rod(mid1, l2, 0.11); rod(l1, mid2, 0.11); rod(mid1, r2, 0.11);
          // Knee braces from the upper strut down the posts.
          rod(r2, P(node(b), RIGHT, CHORD_RISE).lerp(P(node(t), RIGHT, top), 0.45), 0.12);
          rod(l2, P(node(b), LEFT, CHORD_RISE).lerp(P(node(t), LEFT, top), 0.45), 0.12);
        }
        // Floor system: a floor beam at every bottom node, stringers under each rail.
        for (let k = 0; k <= PANELS; k++) {
          bar(P(node(k), RIGHT + 0.2, DECK_TOP - 0.55), P(node(k), LEFT - 0.2, DECK_TOP - 0.55), 0.3, 0.7);
        }
        for (const x of [-TRAIN.gauge / 2, TRAIN.gauge / 2, gap - TRAIN.gauge / 2, gap + TRAIN.gauge / 2]) {
          for (let k = 0; k < PANELS; k++) bar(P(node(k), x, DECK_TOP - 0.42), P(node(k + 1), x, DECK_TOP - 0.42), 0.16, 0.5);
        }
        // The wire hangs from the top struts: a drop rod per track at every interior node.
        for (let k = 1; k < PANELS; k++) {
          for (const x of [0, gap]) rod(P(node(k), x, top - 0.18), P(node(k), x, MESSENGER + 0.05), 0.05);
        }
        // Handrail posts, every half panel.
        for (let k = 0; k <= PANELS * 2; k++) {
          const arc = s0 + (k * panel) / 2;
          rod(P(arc, RIGHT - 0.35 - WALK, DECK_TOP), P(arc, RIGHT - 0.35 - WALK, DECK_TOP + 1.12), 0.05);
        }
        // Piers and abutments under the end nodes, with a bearing under each truss.
        for (const k of sp === 0 ? [0, PANELS] : [PANELS]) {
          const arc = node(k);
          const s = samples[Math.min(samples.length - 1, Math.max(0, Math.round(arc / (samples[1].arc - samples[0].arc))))];
          const yaw = yawAt(arc);
          const bed = s.y - s.fill - RAIL_HEAD_LIFT - TRAIN.pierEmbed;
          const shelf = s.y + DECK_TOP - 0.9;
          const c = P(arc, (RIGHT + LEFT) / 2, 0);
          const isEnd = (sp === 0 && k === 0) || (sp === spans - 1 && k === PANELS);
          const width = LEFT - RIGHT + 2.0;
          concrete.push({ p: new Vector3(c.x, (shelf + bed) / 2, c.z), yaw, size: [width, Math.max(1, shelf - bed), isEnd ? 4.5 : 2.4] });
          concrete.push({ p: new Vector3(c.x, shelf + 0.2, c.z), yaw, size: [width + 0.5, 0.4, isEnd ? 5.0 : 3.0] });
          for (const side of [RIGHT, LEFT]) {
            bearings.push({ p: P(arc, side, DECK_TOP - 0.62), yaw, size: [1.0, 0.36, 1.0] });
          }
        }
      }
    }
    function yawAt(arc: number) {
      const [tx, tz] = trainTangentAt(arc);
      return Math.atan2(tx, tz);
    }
    return { deck, walkway, rails, bars, light, plates, concrete, bearings };
  }, [samples]);

  useEffect(() => () => {
    if (!built) return;
    for (const g of [built.deck, built.walkway, ...built.rails]) g.geometry.dispose();
  }, [built]);

  if (!built) return null;
  return (
    <group>
      <mesh geometry={built.deck.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#3a3633" metalness={0.4} roughness={0.7} />
      </mesh>
      <mesh geometry={built.walkway.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#4a4744" metalness={0.5} roughness={0.6} />
      </mesh>
      {built.rails.map((r, i) => (
        <mesh key={`r${i}`} geometry={r.geometry} castShadow>
          <meshStandardMaterial color="#6f7276" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      <Bars items={built.bars} {...STEEL} />
      <Bars items={built.light} color="#3a3633" metalness={0.55} roughness={0.55} />
      <Boxes items={built.plates} {...STEEL} />
      <Boxes items={built.concrete} color="#9a958c" metalness={0} roughness={0.95} />
      <Boxes items={built.bearings} color="#26262a" metalness={0.5} roughness={0.5} />
    </group>
  );
}

/**
 * Instanced rectangular bars between two world points. The bar's depth `d`
 * is kept in the plane across the bridge, so a chord reads as a built-up
 * section rather than a square stick.
 */
export function Bars({ items, color, metalness, roughness }: { items: Bar[]; color: string; metalness: number; roughness: number }) {
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
    items.forEach((m, i) => {
      dir.subVectors(m.b, m.a);
      const len = dir.length();
      quaternion.setFromUnitVectors(up, dir.normalize());
      position.addVectors(m.a, m.b).multiplyScalar(0.5);
      scale.set(m.w, Math.max(0.01, len), m.d);
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
    </instancedMesh>
  );
}

/** Instanced boxes at world points, yawed to the line, each with its own size. */
export function Boxes({ items, color, metalness, roughness }: { items: Block[]; color: string; metalness: number; roughness: number }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const axis = new Vector3(0, 1, 0);
    items.forEach((b, i) => {
      quaternion.setFromAxisAngle(axis, b.yaw);
      scale.set(b.size[0], b.size[1], b.size[2]);
      mesh.setMatrixAt(i, matrix.compose(b.p, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
    </instancedMesh>
  );
}
