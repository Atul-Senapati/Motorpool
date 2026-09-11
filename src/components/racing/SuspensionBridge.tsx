'use client';

import { useEffect, useMemo } from 'react';
import { Vector3 } from 'three';
import { RAIL_HEAD_LIFT, TRAIN, trainTangentAt } from '@/config/trainConfig';
import { buildLoft, type LoftSample } from './railGeometry';
import { Bars, Boxes, type Bar, type Block } from './TrussBridge';

/**
 * A suspension bridge with three towers — the crossing from the small island to
 * the city.
 *
 * Three portal towers at the quarter points of the run, two main cables in the
 * planes of the deck's edges draped from tower saddle to tower saddle (a
 * parabola with `SAG` of the span) and down the side spans to anchor blocks on
 * each shore, hangers every `HANGER` metres from cable to deck edge, a steel
 * box-girder deck with parapets, concrete footings under the towers and
 * anchorages at the ends. The OHLE masts stay on the deck — the deck is wide
 * enough (`EDGE`) that the hangers clear them.
 *
 * Same discipline as the truss: the deck and parapets are lofts on the line's
 * samples; every cable segment, hanger, leg and beam is a straight bar between
 * two exact points, so the cable is a smooth polyline of `CABLE_STEP` segments
 * and the towers stand truly vertical.
 */

export interface SuspensionSample extends LoftSample {
  y: number;
  fill: number;
  gap: number;
  suspension: boolean;
}

const SLEEPER_BOTTOM = -(TRAIN.railHeight + TRAIN.sleeperHeight);
const DECK_TOP = SLEEPER_BOTTOM - 0.02;
const DECK_DEPTH = 2.6;
/** Deck edge (cable plane) outside each track's centre; the masts stand at 3.3. */
const EDGE = 4.5;
const PARAPET = 1.15;
const TOWER_HEIGHT = 46;
const SAG = 0.11;
const SIDE_SAG = 0.035;
const HANGER = 6;
const CABLE_STEP = 4;
const CABLE_R = 0.32;
const LEG = 2.4;

const STEEL = { color: '#c9433b', metalness: 0.45, roughness: 0.55 } as const;
const CABLE = { color: '#2b2a29', metalness: 0.5, roughness: 0.6 } as const;

function makePointer(samples: SuspensionSample[]) {
  const step = samples.length > 1 ? samples[1].arc - samples[0].arc : 5;
  return (arc: number, off: number, rise: number): Vector3 => {
    const i = Math.min(samples.length - 2, Math.max(0, Math.floor(arc / step)));
    const a = samples[i];
    const b = samples[i + 1];
    const t = Math.min(1, Math.max(0, (arc - a.arc) / Math.max(b.arc - a.arc, 1e-6)));
    // `Rail.y` is already the rail head, lift included.
    return new Vector3(
      a.x + (b.x - a.x) * t + (a.nx + (b.nx - a.nx) * t) * off,
      a.y + (b.y - a.y) * t + rise,
      a.z + (b.z - a.z) * t + (a.nz + (b.nz - a.nz) * t) * off,
    );
  };
}

function runsOf(samples: SuspensionSample[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  samples.forEach((s, i) => {
    if (s.suspension && start < 0) start = i;
    if (!s.suspension && start >= 0) { runs.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) runs.push([start, samples.length - 1]);
  return runs;
}

export function SuspensionBridge({ samples }: { samples: SuspensionSample[] }) {
  const built = useMemo(() => {
    const runs = runsOf(samples);
    if (!runs.length) return null;
    const P = makePointer(samples);
    const on = (a: SuspensionSample, b: SuspensionSample) => a.suspension && b.suspension;
    const gap = samples.find((s) => s.suspension)?.gap ?? TRAIN.elevated.trackGap;
    const RIGHT = -EDGE;
    const LEFT = gap + EDGE;

    // Box girder: flat top under the tracks, chamfered soffit.
    const deck = buildLoft(samples, [
      { off: RIGHT - 0.3, rise: DECK_TOP },
      { off: LEFT + 0.3, rise: DECK_TOP },
      { off: LEFT + 0.3, rise: DECK_TOP - 0.9 },
      { off: LEFT - 1.6, rise: DECK_TOP - DECK_DEPTH },
      { off: RIGHT + 1.6, rise: DECK_TOP - DECK_DEPTH },
      { off: RIGHT - 0.3, rise: DECK_TOP - 0.9 },
    ], { closed: true, filter: on, vScale: 8 });
    // Kerb plus an open railing: two rails on posts, the way a railway bridge
    // is fenced, instead of a solid slab.
    const kerb = (edge: number, sign: number) => buildLoft(samples, [
      { off: edge, rise: DECK_TOP },
      { off: edge + sign * 0.35, rise: DECK_TOP },
      { off: edge + sign * 0.35, rise: DECK_TOP + 0.22 },
      { off: edge, rise: DECK_TOP + 0.22 },
    ], { closed: true, filter: on, vScale: 8 });
    const rail = (edge: number, rise: number) => buildLoft(samples, [
      { off: edge - 0.03, rise: rise - 0.03 },
      { off: edge + 0.03, rise: rise - 0.03 },
      { off: edge + 0.03, rise: rise + 0.03 },
      { off: edge - 0.03, rise: rise + 0.03 },
    ], { closed: true, filter: on, vScale: 8 });
    const parapets = [
      kerb(RIGHT - 0.3, 1), kerb(LEFT + 0.3, -1),
      rail(RIGHT - 0.15, DECK_TOP + PARAPET), rail(RIGHT - 0.15, DECK_TOP + 0.65),
      rail(LEFT + 0.15, DECK_TOP + PARAPET), rail(LEFT + 0.15, DECK_TOP + 0.65),
    ];

    const bars: Bar[] = [];
    const dark: Bar[] = [];
    const cables: Bar[] = [];
    const hangers: Bar[] = [];
    const concrete: Block[] = [];
    const saddles: Block[] = [];
    const clamps: Block[] = [];
    const lights: Block[] = [];
    const yawAt = (arc: number) => { const [tx, tz] = trainTangentAt(arc); return Math.atan2(tx, tz); };
    const step = samples.length > 1 ? samples[1].arc - samples[0].arc : 5;
    const sampleAt = (arc: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.round(arc / step)))];

    for (const [from, to] of runs) {
      const startArc = samples[from].arc;
      const endArc = samples[to].arc;
      const L = endArc - startArc;
      // Three towers at the quarter points; the cable runs anchor → T1 → T2 → T3 → anchor.
      const towers = [0.25, 0.5, 0.75].map((f) => startArc + f * L);
      const supports = [startArc, ...towers, endArc];
      const supportRise = (i: number) => (i === 0 || i === supports.length - 1 ? DECK_TOP + 2.0 : DECK_TOP + TOWER_HEIGHT);

      for (const edge of [RIGHT, LEFT]) {
        // The cable, span by span, as a parabola between its two supports.
        for (let i = 0; i < supports.length - 1; i++) {
          const a = supports[i];
          const b = supports[i + 1];
          const span = b - a;
          const side = i === 0 || i === supports.length - 2;
          const sag = (side ? SIDE_SAG : SAG) * span;
          const ra = supportRise(i);
          const rb = supportRise(i + 1);
          const riseAt = (u: number) => ra + (rb - ra) * u - 4 * sag * u * (1 - u);
          const n = Math.max(2, Math.round(span / CABLE_STEP));
          let prev = P(a, edge, riseAt(0));
          for (let k = 1; k <= n; k++) {
            const u = k / n;
            const next = P(a + span * u, edge, riseAt(u));
            cables.push({ a: prev, b: next, w: CABLE_R, d: CABLE_R });
            prev = next;
          }
          // Hangers: a pair of ropes at every band, a cable band round the main
          // cable above them and a clamp on the kerb below.
          for (let h = HANGER; h < span - HANGER / 2; h += HANGER) {
            const u = h / span;
            const arcH = a + h;
            const top = P(arcH, edge, riseAt(u));
            const bottom = P(arcH, edge, DECK_TOP + 0.22);
            if (top.y - bottom.y < 0.8) continue;
            const yaw = yawAt(arcH);
            const along = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(0.14);
            hangers.push({ a: top.clone().add(along), b: bottom.clone().add(along), w: 0.045, d: 0.045 });
            hangers.push({ a: top.clone().sub(along), b: bottom.clone().sub(along), w: 0.045, d: 0.045 });
            clamps.push({ p: top, yaw, size: [0.75, 0.75, 0.6] });
            clamps.push({ p: bottom.clone().setY(bottom.y + 0.15), yaw, size: [0.5, 0.3, 0.6] });
          }
        }
      }
      // Under the deck: a stiffening lattice along each edge (chords are the
      // girder's own edges; diagonals zigzag between them) and a cross girder
      // at every hanger — what keeps a suspended railway deck from twisting,
      // and what you see from the water.
      for (let h = 0; h + HANGER <= L + 1e-6; h += HANGER) {
        const a0 = startArc + h;
        const a1 = Math.min(endArc, a0 + HANGER);
        for (const edge of [RIGHT, LEFT]) {
          const inner = edge + (edge < 0 ? 1.55 : -1.55);
          const even = Math.round(h / HANGER) % 2 === 0;
          dark.push({
            a: P(a0, even ? edge - (edge < 0 ? 0.1 : -0.1) : inner, even ? DECK_TOP - 0.7 : DECK_TOP - DECK_DEPTH + 0.15),
            b: P(a1, even ? inner : edge - (edge < 0 ? 0.1 : -0.1), even ? DECK_TOP - DECK_DEPTH + 0.15 : DECK_TOP - 0.7),
            w: 0.2, d: 0.2,
          });
        }
        dark.push({ a: P(a0, RIGHT + 0.6, DECK_TOP - DECK_DEPTH + 0.25), b: P(a0, LEFT - 0.6, DECK_TOP - DECK_DEPTH + 0.25), w: 0.3, d: 0.45 });
        // Railing posts at every hanger and half way between; a lamp post every fourth.
        for (const arcP of [a0, a0 + HANGER / 2]) {
          if (arcP > endArc) continue;
          for (const edge of [RIGHT - 0.15, LEFT + 0.15]) {
            dark.push({ a: P(arcP, edge, DECK_TOP + 0.2), b: P(arcP, edge, DECK_TOP + PARAPET + 0.05), w: 0.06, d: 0.06 });
          }
        }
        if (Math.round(h / HANGER) % 4 === 2) {
          for (const edge of [RIGHT - 0.6, LEFT + 0.6]) {
            const foot = P(a0, edge, DECK_TOP + 0.2);
            const head = P(a0, edge, DECK_TOP + 5.2);
            dark.push({ a: foot, b: head, w: 0.12, d: 0.12 });
            lights.push({ p: P(a0, edge, DECK_TOP + 5.35), yaw: yawAt(a0), size: [0.5, 0.25, 0.5] });
          }
        }
      }
      // Towers: two legs outside the deck edges, portal beams, saddles, footings.
      for (const arc of towers) {
        const s = sampleAt(arc);
        const yaw = yawAt(arc);
        const bed = s.y - s.fill - RAIL_HEAD_LIFT - TRAIN.pierEmbed;
        const top = s.y + DECK_TOP + TOWER_HEIGHT;
        for (const edge of [RIGHT, LEFT]) {
          const legOff = edge + (edge < 0 ? -1 : 1) * (LEG / 2 + 0.5);
          const foot = P(arc, legOff, 0); foot.y = bed;
          const head = P(arc, legOff, DECK_TOP + TOWER_HEIGHT + 0.6);
          bars.push({ a: foot, b: head, w: LEG, d: LEG });
          // Riveted plating: recessed dark panels up each face of the leg, a
          // pedestal at the deck, and a cap.
          for (let r = DECK_TOP + 3; r < TOWER_HEIGHT - 3; r += 4.2) {
            clamps.push({ p: P(arc, legOff, r), yaw, size: [LEG + 0.08, 0.35, LEG + 0.08] });
          }
          concrete.push({ p: P(arc, legOff, DECK_TOP - 1.2), yaw, size: [LEG + 1.4, 2.4, LEG + 1.4] });
          // Saddle housing over the cable plane, and the navigation light on it.
          saddles.push({ p: P(arc, edge, DECK_TOP + TOWER_HEIGHT + 0.9), yaw, size: [1.9, 1.7, 2.6] });
          saddles.push({ p: P(arc, legOff, DECK_TOP + TOWER_HEIGHT + 1.15), yaw, size: [LEG + 0.5, 0.5, LEG + 0.5] });
          lights.push({ p: P(arc, legOff, DECK_TOP + TOWER_HEIGHT + 1.7), yaw, size: [0.45, 0.6, 0.45] });
          // Cross-strut from leg to saddle.
          bars.push({ a: P(arc, legOff, DECK_TOP + TOWER_HEIGHT + 0.6), b: P(arc, edge, DECK_TOP + TOWER_HEIGHT + 0.6), w: 1.2, d: 1.6 });
        }
        // Portal beams: over the deck (clear of the wire), at mid-height, and at the top.
        const lo = P(arc, RIGHT, 0); const ro = P(arc, LEFT, 0);
        void lo; void ro;
        const beams = [DECK_TOP + 9.5, DECK_TOP + TOWER_HEIGHT * 0.62, DECK_TOP + TOWER_HEIGHT + 0.6];
        for (const rise of beams) {
          bars.push({ a: P(arc, RIGHT - LEG / 2 - 0.5, rise), b: P(arc, LEFT + LEG / 2 + 0.5, rise), w: 1.8, d: 2.0 });
        }
        // X-bracing between the legs in the two upper bays.
        const legR = RIGHT - LEG / 2 - 0.5;
        const legL = LEFT + LEG / 2 + 0.5;
        for (let i = 0; i < beams.length - 1; i++) {
          bars.push({ a: P(arc, legR, beams[i] + 1.0), b: P(arc, legL, beams[i + 1] - 1.0), w: 0.55, d: 0.7 });
          bars.push({ a: P(arc, legL, beams[i] + 1.0), b: P(arc, legR, beams[i + 1] - 1.0), w: 0.55, d: 0.7 });
        }
        // Footing: a plinth from the bed up to just under the deck, the deck resting on it.
        const c = P(arc, (RIGHT + LEFT) / 2, 0);
        const plinthTop = s.y + DECK_TOP - DECK_DEPTH - 0.6;
        concrete.push({ p: new Vector3(c.x, (plinthTop + bed) / 2, c.z), yaw, size: [LEFT - RIGHT + 2 * LEG + 3.5, Math.max(2, plinthTop - bed), 7] });
        concrete.push({ p: new Vector3(c.x, plinthTop + 0.3, c.z), yaw, size: [LEFT - RIGHT + 2 * LEG + 4.5, 0.6, 8] });
        // Fenders round the plinth at the waterline.
        const water = Math.max(bed + 1, Math.min(plinthTop - 1, -3.2));
        clamps.push({ p: new Vector3(c.x, water, c.z), yaw, size: [LEFT - RIGHT + 2 * LEG + 4.2, 1.2, 7.6] });
        void top;
      }
      // Anchorages on each shore: one block per cable, OUTBOARD of the deck so
      // nothing stands over the track, stepped, with a splay saddle on top
      // where the cable turns down into it.
      for (const arc of [startArc - 6, endArc + 6]) {
        const s = sampleAt(Math.min(Math.max(arc, samples[0].arc), samples[samples.length - 1].arc));
        const yaw = yawAt(arc);
        const base = s.y - Math.max(s.fill, 0) - RAIL_HEAD_LIFT - 2;
        for (const edge of [RIGHT, LEFT]) {
          const out = edge < 0 ? -1 : 1;
          const c = P(arc, edge + out * 1.6, 0);
          const lowTop = s.y + DECK_TOP - 0.4;
          const highTop = s.y + DECK_TOP + 1.6;
          concrete.push({ p: new Vector3(c.x, (lowTop + base) / 2, c.z), yaw, size: [5.2, Math.max(2, lowTop - base), 11] });
          const c2 = P(arc, edge + out * 2.2, 0);
          concrete.push({ p: new Vector3(c2.x, (highTop + lowTop) / 2, c2.z), yaw, size: [4.0, highTop - lowTop, 8] });
          saddles.push({ p: P(arc + (arc < startArc ? 4 : -4), edge, DECK_TOP + 1.9), yaw, size: [1.2, 0.8, 1.6] });
        }
      }
    }
    return { deck, parapets, bars, dark, cables, hangers, concrete, saddles, clamps, lights };
  }, [samples]);

  useEffect(() => () => {
    if (!built) return;
    for (const g of [built.deck, ...built.parapets]) g.geometry.dispose();
  }, [built]);

  if (!built) return null;
  return (
    <group>
      <mesh geometry={built.deck.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#8e9196" metalness={0.5} roughness={0.5} />
      </mesh>
      {built.parapets.map((p, i) => (
        <mesh key={i} geometry={p.geometry} castShadow receiveShadow>
          <meshStandardMaterial {...STEEL} />
        </mesh>
      ))}
      <Bars items={built.bars} {...STEEL} />
      <Bars items={built.dark} color="#4a4c50" metalness={0.55} roughness={0.5} />
      <Boxes items={built.saddles} color="#8e9196" metalness={0.5} roughness={0.5} />
      <Boxes items={built.clamps} color="#2a2928" metalness={0.5} roughness={0.6} />
      <Bars items={built.cables} {...CABLE} />
      <Bars items={built.hangers} color="#3a3938" metalness={0.5} roughness={0.55} />
      <Boxes items={built.concrete} color="#9a958c" metalness={0} roughness={0.95} />
      {built.lights.map((l, i) => (
        <mesh key={i} position={[l.p.x, l.p.y, l.p.z]} rotation={[0, l.yaw, 0]}>
          <boxGeometry args={l.size} />
          <meshBasicMaterial color={l.size[1] > 0.5 ? '#ff3b2f' : '#fff0c8'} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
