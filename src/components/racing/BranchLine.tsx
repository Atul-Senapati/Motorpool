'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import { SolidParts } from './TrussBridge';
import { DoubleSide, Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { RAIL_HEAD_LIFT, TRAIN } from '@/config/trainConfig';
import {
  AIRPORT_BRANCH, BRANCH_ROADS, JUNCTION_CURVE, skylarkCentreAt, type BranchJunction,
} from '@/config/pointwork';
import { CITY_NAV_IMAGE } from '@/config/cityConfig';
import { PIER_END_LINKED, RAIL_MARKS } from '@/config/countryConfig';
import { getNav, groundHeightAt, isRoadAt, loadCityNav } from '@/physics/cityNav';
import { onPetrelRoad } from '@/config/petrel';
import { RAIL_STEEL, buildLoft, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { bladeFraction, bladedRailProfile, standsAlone, type BladedSample } from './switchBlade';

/**
 * The junctions' branches: double track off the viaduct, one to the Skylark
 * line and one to the airport trunk's north end.
 *
 * The roads themselves — where they are, how the train takes them, where it
 * stops — are `JUNCTIONS` / `BRANCH_ROADS` in `pointwork`. This draws them: the
 * inner road's rails bladed into the up line and crossing the down line flat on
 * the diamond, the outer road's bladed straight into the down line, sleepers,
 * the branch's own double-track deck from where it runs off the main one, two
 * piers either side of the highway it crosses, and a stop on each road.
 *
 * The viaduct is left as it was, bar one thing: its left parapet gives way over
 * the 20-odd metres where the branch runs out through it (`JUNCTION_MOUTH`).
 * Inside that stretch the branch deck is laid tight against the main deck's
 * edge and a shade below its top, so the two read as one slab widening out;
 * beyond it the branch has both parapets and stands clear on its own piers.
 */

const GAUGE = TRAIN.gauge / 2;
const EL = TRAIN.elevated;
/** Heights down from the rail head, as `TrainLine` measures them. */
const SLEEPER_BOTTOM = -TRAIN.railHeight - TRAIN.sleeperHeight;
/**
 * Where the branch deck overlaps the main one it sits 2 cm lower and 5 cm
 * shallower, so the overlap is buried inside the main slab and nothing is
 * coplanar with it.
 */
const DECK_TOP = SLEEPER_BOTTOM - 0.02;
const DECK_BOTTOM = DECK_TOP - (EL.deckDepth - 0.05);
const PW = EL.parapetWidth;
const PH = EL.parapetHeight;
const V_SCALE = 6;
/** Sampling pitch along the branch, metres of its own curve. */
const STEP = 1;
/** The branch's own piers: from where it leaves the main deck, at this pitch. */
const PIER_FROM = 64;
const PIER_PITCH = 24;
const PIER_ACROSS = 2.2;
const PIER_ALONG = 1.1;
/** What a pier stands on where there is no ground under it: the sea bed. */
const SEABED = -9;
/** How far past the Skylark coast the deck runs onto the shore before the abutment. */
const SHORE_RUN = 4;

/** The branch roads' centres, square to the branch: inner at 0, outer at `G`. */
const G = JUNCTION_CURVE.spec.gap;

/** The nav raster, which the piers read for roads and ground; rebuilt once it lands. */
function useNavReady() {
  const [ready, setReady] = useState(() => getNav() !== null);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    loadCityNav(CITY_NAV_IMAGE).then(() => { if (alive) setReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, [ready]);
  return ready;
}

interface BranchSample extends BladedSample {
  /** Metres past the toe, along the running line. */
  u: number;
  /** Metres left of the up line. */
  off: number;
  /** Cosine of the branch's angle to the running line. */
  cos: number;
}

/**
 * One road of a branch, sampled every metre along its own traced curve from
 * the toe to the joint with the line it runs onto.
 *
 * Near the junction each sample also knows where it is against the running
 * line — how far left of it (`off`, for the blades and the deck's join with the
 * main deck) and at what angle (`cos`). Further out those stop meaning
 * anything, and the sample reads as well clear of it.
 */
function sampleBranch(j: BranchJunction, track: 0 | 1): BranchSample[] {
  const line = j.tracks[track];
  const samples: BranchSample[] = [];
  const every = Math.round(STEP / 0.5);
  for (let i = 0; i < line.length; i += every) {
    const p = line[i];
    const b = i * 0.5;
    const u = j.uAt(b);
    const near = Number.isFinite(u);
    const off = near ? j.offsetRaw(u, track) : 1e3;
    samples.push({
      x: p.x, y: j.heightAt(b) + RAIL_HEAD_LIFT, z: p.z, arc: b, u: near ? u : Infinity, off,
      nx: p.nx, nz: p.nz,
      // Bladed against the line each road leaves: the inner road against the
      // up line only — the down line is crossed, not joined, so its rails run
      // through the diamond at full section — and the outer against the down.
      blade: bladeFraction(track ? off - G : off),
      cos: near ? j.cosAt(u) : 1,
    });
  }
  return samples;
}

/**
 * The rest of the viaduct: over what was the Skylark line's own east bridge,
 * from its old pier end back to the Skylark shore, which this viaduct now
 * carries instead (`PIER_END_LINKED`). The Skylark line's own rails and
 * sleepers run on over it; these are the inner road's positions in the
 * branch's frame, for the deck and the piers.
 *
 * Built off the Skylark centreline's DIRECTION, not its samples' `nx/nz`:
 * those are the opposite hand to the main line's convention, and the branch
 * arrives travelling the other way, so the one thing both agree on is where
 * the line goes.
 */
function approachSamples(startArc: number): BranchSample[] {
  const out: BranchSample[] = [];
  let k = 1;
  for (let a = RAIL_MARKS.pierEnd - STEP; a >= RAIL_MARKS.eastShore - SHORE_RUN; a -= STEP, k++) {
    const [cx, cy, cz] = skylarkCentreAt(a);
    // Travelling towards the shore, from the line's own direction there: the
    // railway's left normal is the travel direction turned, (dz, −dx).
    const [ax, , az] = skylarkCentreAt(a + 0.75);
    const [bx, , bz] = skylarkCentreAt(a - 0.75);
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    const lx = (bz - az) / dl;
    const lz = -(bx - ax) / dl;
    out.push({
      x: cx - lx * (G / 2), z: cz - lz * (G / 2), y: cy + RAIL_HEAD_LIFT,
      arc: startArc + k * STEP, u: Infinity, off: 1e3, nx: lx, nz: lz, blade: 1, cos: 1,
    });
  }
  return out;
}

/**
 * A branch deck's section, carrying both roads, with an inner edge that moves.
 *
 * `half` is the deck's width outside each road, `edge` the main deck's edge
 * as an offset from the running line (`mouth.edge`).
 */
function deckOf(half: number, edge: number) {
  /** Is the branch deck's inner edge clear of the main deck — does it get a parapet? */
  const clear = (s: BranchSample) => s.off - half * s.cos > edge + 0.05;
  /**
   * The deck's inner (right-hand, towards the main line) edge in the inner
   * road's frame: tucked 10 cm under the main deck's edge while the two
   * overlap, its full half-width once clear, and never so far out that the
   * slab under the outer parapet is less than 30 cm wide.
   */
  const outer = G + half;
  const inner = (s: BranchSample) => Math.min(
    outer - PW - 0.3,
    Math.max(-half, (edge - 0.1 - s.off) / s.cos),
  );
  const chamfer = (s: BranchSample) => Math.min(EL.chamfer, (outer - inner(s)) / 3);
  const innerTop = (s: BranchSample) => DECK_TOP + (clear(s) ? PH : 0.002);
  const innerFace = (s: BranchSample) => inner(s) + (clear(s) ? PW : 0.01);
  const profile: ProfileVertex<BranchSample>[] = [
    { off: inner, rise: innerTop },
    { off: innerFace, rise: innerTop },
    { off: innerFace, rise: DECK_TOP },
    { off: outer - PW, rise: DECK_TOP },
    { off: outer - PW, rise: DECK_TOP + PH },
    { off: outer, rise: DECK_TOP + PH },
    { off: outer, rise: (s) => DECK_BOTTOM + chamfer(s) },
    { off: (s) => outer - chamfer(s), rise: DECK_BOTTOM },
    { off: (s) => inner(s) + chamfer(s), rise: DECK_BOTTOM },
    { off: inner, rise: (s) => DECK_BOTTOM + chamfer(s) },
  ];
  return { profile, inner, outer };
}

interface Box {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  yaw: number;
  pitch?: number;
}

/** A point on the branch at `u`, `across` metres left of it and `up` over the rail head. */
function frameAt(samples: BranchSample[], u: number) {
  const i = Math.max(0, Math.min(samples.length - 1, Math.round((u - samples[0].u) / STEP)));
  const s = samples[i];
  const yaw = Math.atan2(-s.nz, s.nx);
  return {
    s,
    yaw,
    at: (across: number, up: number, along = 0) => ({
      x: s.x + s.nx * across - s.nz * along,
      y: s.y + up,
      z: s.z + s.nz * across + s.nx * along,
    }),
  };
}

/** Instanced unit boxes, one material. */
function Boxes({ boxes, color, emissive, roughness = 0.85, metalness = 0 }: {
  boxes: Box[]; color: string; emissive?: string; roughness?: number; metalness?: number;
}) {
  const mesh = useRef<InstancedMesh>(null);
  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const euler = new Euler(0, 0, 0, 'YXZ');
    boxes.forEach((b, i) => {
      euler.set(b.pitch ?? 0, b.yaw, 0);
      quaternion.setFromEuler(euler);
      matrix.compose(new Vector3(b.x, b.y, b.z), quaternion, new Vector3(b.sx, b.sy, b.sz));
      instanced.setMatrixAt(i, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [boxes]);
  if (!boxes.length) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, boxes.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color} roughness={roughness} metalness={metalness}
        emissive={emissive ?? '#000000'} emissiveIntensity={emissive ? 2.2 : 0}
        toneMapped={!emissive}
      />
    </instancedMesh>
  );
}

/** Sleepers under the branch wherever it stands as its own track. */
function Sleepers({ samples }: { samples: BranchSample[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const length = samples[samples.length - 1].arc;
  const count = Math.ceil(length / TRAIN.sleeperSpacing) + 2;

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const scale = new Vector3(1, 1, 1);
    let placed = 0;
    let k = 0;
    for (let at = 0; at <= length && placed < count; at += TRAIN.sleeperSpacing) {
      while (k < samples.length - 2 && samples[k + 1].arc < at) k++;
      const a = samples[k];
      const b = samples[k + 1];
      // Not under the blades: the up line's own sleepers carry them there.
      if (!standsAlone(a) || !standsAlone(b)) continue;
      const t = (at - a.arc) / Math.max(b.arc - a.arc, 1e-3);
      euler.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      quaternion.setFromEuler(euler);
      // A shade under the running lines' sleepers, which the branch's cross at
      // a shallow angle all the way out over the diamond: the lower top loses
      // cleanly instead of flickering.
      position.set(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t + SLEEPER_BOTTOM - 0.015,
        a.z + (b.z - a.z) * t,
      );
      instanced.setMatrixAt(placed++, matrix.compose(position, quaternion, scale));
    }
    instanced.count = placed;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [count, length, samples]);

  return (
    <instancedMesh
      ref={mesh} args={[undefined, undefined, count]} receiveShadow
      geometry={SLEEPER_GEOMETRY} material={SLEEPER_MATERIAL}
    />
  );
}

/**
 * One branch: rails, sleepers, its deck from where it leaves the main one to
 * the joint, and its piers. `approach` is the Skylark branch's run on over what
 * was that line's east bridge (`approachSamples`); the airport branch ends on
 * the trunk's own viaduct, flush with it, over a pier they share.
 */
function Branch({ junction, approach, navReady }: {
  junction: BranchJunction; approach: boolean; navReady: boolean;
}) {
  const built = useMemo(() => {
    const H = junction.spec.deckHalf;
    const { edge } = junction.mouth;
    const { profile, inner, outer } = deckOf(H, edge);
    const tracks = ([0, 1] as const).map((t) => sampleBranch(junction, t));
    const branch = tracks[0];
    // The deck: from where its outer parapet reaches the main deck's edge,
    // along the branch, and (Skylark) on over the old east bridge to the shore.
    const all = approach
      ? [...branch, ...approachSamples(branch[branch.length - 1].arc)]
      : branch;
    const deckEnd = all[all.length - 1].arc;
    const start = all.findIndex((s) => s.off + outer * s.cos >= edge - 0.05);
    const deck = buildLoft(all.slice(Math.max(0, start)), profile, { vScale: V_SCALE, closed: true });

    const concrete: Box[] = [];
    const steel: Box[] = [];
    const lamp: Box[] = [];

    // Piers: a shaft and a cap under the middle of the deck, every `PIER_PITCH`
    // from where the branch leaves the main deck to just short of the joint —
    // slid along a few metres where a road is under the spot, and left out
    // where none of those is clear. Over the water a pier stands on the bed.
    const footprintOnRoad = (x: number, z: number, nx: number, nz: number) => {
      for (const a of [-1, 0, 1]) for (const l of [-1, 0, 1]) {
        const px = x + nx * a * (PIER_ACROSS / 2 + 1) - nz * l * (PIER_ALONG / 2 + 1);
        const pz = z + nz * a * (PIER_ACROSS / 2 + 1) + nx * l * (PIER_ALONG / 2 + 1);
        if (isRoadAt(px, pz)) return true;
        // Petrel's circuit, by its own geometry: the raster's 1.5 m pixels let
        // a pier stand hard against the kerb, with only nine points to see it.
        if (onPetrelRoad(px, pz, 3)) return true;
      }
      return false;
    };
    const pier = (f: ReturnType<typeof frameAt>) => {
      const r = inner(f.s);
      const centre = (r + outer) / 2;
      const c = f.at(centre, 0);
      const cap = 0.9;
      const ground = groundHeightAt(c.x, c.z) ?? SEABED;
      const base = ground - TRAIN.pierEmbed;
      const shaftTop = f.s.y + DECK_BOTTOM - cap;
      concrete.push({
        ...f.at(centre, DECK_BOTTOM - cap / 2), sx: outer - r - 0.6, sy: cap, sz: 1.4, yaw: f.yaw,
      });
      concrete.push({
        x: c.x, y: (base + shaftTop) / 2, z: c.z,
        sx: PIER_ACROSS, sy: Math.max(1, shaftTop - base), sz: PIER_ALONG, yaw: f.yaw,
      });
    };
    // One viaduct from end to end now, so one pitch the whole way to the shore.
    const sites: number[] = [];
    for (let at = PIER_FROM; at < deckEnd - 8; at += PIER_PITCH) sites.push(at);
    for (const at of sites) {
      for (const slide of [0, 3, -3, 6, -6, 9, -9]) {
        const f = frameAt(all, at + slide);
        const c = f.at((inner(f.s) + outer) / 2, 0);
        if (footprintOnRoad(c.x, c.z, f.s.nx, f.s.nz)) continue;
        pier(f);
        break;
      }
    }

    if (approach) {
      // The abutment at the Skylark shore: a block under the deck's end, down
      // into the ground, so the girder finishes in the bank and not in the air.
      const f = frameAt(all, deckEnd);
      const top = f.s.y + DECK_TOP;
      const c = f.at(G / 2, 0);
      const ground = groundHeightAt(c.x, c.z) ?? f.s.y - RAIL_HEAD_LIFT - 2;
      const bottom = Math.min(ground, f.s.y + DECK_BOTTOM) - 2;
      concrete.push({
        ...f.at(G / 2, (top + bottom) / 2 - f.s.y, 1.2),
        sx: G + 2 * H + 1, sy: top - bottom, sz: 3, yaw: f.yaw,
      });
    } else {
      // The joint with the trunk's viaduct, which starts here with no pier of
      // its own for half a span: one under both deck ends.
      pier(frameAt(all, deckEnd - 0.7));
    }

    return {
      tracks,
      deck,
      rails: tracks.flatMap((track) => [
        buildLoft(track, bladedRailProfile<BranchSample>(-GAUGE), { vScale: V_SCALE, closed: true }),
        buildLoft(track, bladedRailProfile<BranchSample>(GAUGE), { vScale: V_SCALE, closed: true }),
      ]),
      concrete, steel, lamp,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- navReady is the trigger, not an input
  }, [navReady, junction, approach]);

  const solid = useMemo(() => [...built.concrete, ...built.steel].map((b) => new Matrix4().compose(
    new Vector3(b.x, b.y, b.z),
    new Quaternion().setFromEuler(new Euler(b.pitch ?? 0, b.yaw, 0, 'YXZ')),
    new Vector3(b.sx, b.sy, b.sz),
  )), [built]);

  useEffect(() => () => {
    built.deck.geometry.dispose();
    for (const rail of built.rails) rail.geometry.dispose();
  }, [built]);

  return (
    <group>
      {built.tracks.map((track, i) => <Sleepers key={i} samples={track} />)}
      {built.rails.map((rail, i) => (
        <mesh key={i} geometry={rail.geometry} material={RAIL_STEEL} castShadow receiveShadow />
      ))}
      <mesh geometry={built.deck.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#aaa59c" roughness={0.9} side={DoubleSide} />
      </mesh>
      <RigidBody type="fixed" colliders={false}>
        <TrimeshCollider args={[built.deck.vertices, built.deck.indices]} friction={0.9} />
      </RigidBody>
      {/* The piers, abutments and steelwork, solid as drawn. Not the lamps. */}
      <SolidParts matrices={[solid]} />
      <Boxes boxes={built.concrete} color="#a8a49b" roughness={0.92} />
      <Boxes boxes={built.steel} color="#3d4146" roughness={0.6} metalness={0.4} />
      <Boxes boxes={built.lamp} color="#ff2a1a" emissive="#ff2a1a" />
    </group>
  );
}

export function BranchLine() {
  const navReady = useNavReady();
  if (!BRANCH_ROADS.length) return null;
  return (
    <group>
      <Branch junction={JUNCTION_CURVE} approach={PIER_END_LINKED} navReady={navReady} />
      <Branch junction={AIRPORT_BRANCH} approach={false} navReady={navReady} />
    </group>
  );
}
