'use client';

import { useEffect, useMemo, useRef } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BufferAttribute, BufferGeometry, DoubleSide, InstancedMesh, Matrix4, Quaternion, Vector3,
} from 'three';
import { RAIL_HEAD_LIFT, TRAIN, trainNormalAt, trainPointAt } from '@/config/trainConfig';
import { METRO, METRO_SITE } from '@/config/stationConfig';
import { buildLoft, type LoftSample, type ProfileVertex } from './railGeometry';

/**
 * The elevated metro station on the street viaduct.
 *
 * Two kinds of geometry, deliberately. Anything that has to keep a distance
 * from a rail — the widened deck, the two platforms, the yellow line along
 * each platform's edge — is swept along the line's own samples, so the face
 * stays 1.7 m off the track whatever the line does. Everything else — the
 * vault, its ribs and purlins, the columns, the gantries and wires, the lamps,
 * the signs, the stairs — is built straight in the station's own frame, one
 * group placed at the site and turned to the line's heading. A roof does not
 * need to follow a rail, and over 108 m of a run this straight the two agree to
 * well under a metre.
 *
 * ## The vault
 *
 * A low elliptical barrel over the full width, drawn three times: a translucent
 * shell, a rib every 6 m following the same curve, and straight purlins along
 * the length at nine angles round it. Glass is what the shell reads as, and
 * the ribs and purlins are what make it read as a lattice rather than a tube —
 * the reference's whole character is that you see the structure through the
 * roof. Ends open, as they are.
 */

const EL = TRAIN.elevated;
/** Deck top, down from the rail head — `TrainLine`'s figure, restated. */
const DECK_TOP = -(TRAIN.railHeight + TRAIN.sleeperHeight);
/** Where the deck's and the platforms' midline is, left of the running line. */
const MID = EL.trackGap / 2;
/** Half the structure's width about `MID`: the platforms' outer edges. */
const HALF = MID + METRO.platformSetback + METRO.platformWidth;
/** The vault's half-span, and how much lower than a semicircle it is. */
const VAULT_RX = HALF + 0.2;
const VAULT_RY = VAULT_RX * 0.62;
const VAULT_SEGMENTS = 28;

interface Sample extends LoftSample {
  /** Metres from the station's midpoint, positive forward. */
  along: number;
}

const smooth = (t: number) => {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
};

/** How much of the widened deck exists at `along`: full over the platforms, eased off beyond. */
const widen = (s: Sample) => {
  const d = Math.abs(s.along) - METRO.platformLength / 2;
  return d <= 0 ? 1 : 1 - smooth(d / METRO.deckEase);
};
const onPlatform = (a: Sample, b: Sample) => Math.abs(a.along) <= METRO.platformLength / 2
  && Math.abs(b.along) <= METRO.platformLength / 2;

/**
 * The widened deck: a slab under the platforms, tapering back into the running
 * deck at each end. Its top sits 2 cm under the running deck's so the two
 * cannot z-fight where they overlap between the tracks.
 */
const SLAB_TOP = DECK_TOP - 0.02;
const STATION_DECK: ProfileVertex<Sample>[] = [
  { off: (s) => MID - HALF * widen(s), rise: SLAB_TOP },
  { off: (s) => MID + HALF * widen(s), rise: SLAB_TOP },
  { off: (s) => MID + HALF * widen(s), rise: SLAB_TOP - EL.deckDepth },
  { off: (s) => MID - HALF * widen(s), rise: SLAB_TOP - EL.deckDepth },
];

/** A side platform between `inner` and `outer` (signed offsets), as a closed box. */
const platform = (inner: number, outer: number): ProfileVertex<Sample>[] => [
  { off: inner, rise: METRO.platformRise },
  { off: outer, rise: METRO.platformRise },
  { off: outer, rise: DECK_TOP },
  { off: inner, rise: DECK_TOP },
];
/** The yellow tactile strip along a platform's edge, 0.45 m in from the face. */
const edgeLine = (face: number, dir: 1 | -1): ProfileVertex<Sample>[] => [
  { off: face + dir * 0.1, rise: METRO.platformRise + 0.012 },
  { off: face + dir * 0.55, rise: METRO.platformRise + 0.012 },
];

const LEFT_FACE = EL.trackGap + METRO.platformSetback;
const RIGHT_FACE = -METRO.platformSetback;

/** A point on the vault's ellipse at angle `a` (0 = right springing, PI = left). */
const vaultPoint = (a: number): [number, number] => [
  MID + Math.cos(a) * VAULT_RX, Math.sin(a) * VAULT_RY,
];

/** The shell: the ellipse swept along the station's length. */
function vaultShell(length: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= VAULT_SEGMENTS; i++) {
    const a = (i / VAULT_SEGMENTS) * Math.PI;
    const [x, y] = vaultPoint(a);
    // Outward normal of an ellipse: (cos/rx, sin/ry).
    const nx = Math.cos(a) / VAULT_RX;
    const ny = Math.sin(a) / VAULT_RY;
    const nl = Math.hypot(nx, ny) || 1;
    for (const z of [-length / 2, length / 2]) {
      positions.push(x, y, z);
      normals.push(nx / nl, ny / nl, 0);
    }
  }
  for (let i = 0; i < VAULT_SEGMENTS; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** A unit box laid between two points, for the rib segments. */
function between(
  matrix: Matrix4, a: [number, number, number], b: [number, number, number], thickness: number,
) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const position = new Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  // Rotate the unit box's Y axis onto the segment.
  const quaternion = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0), new Vector3(dx / len, dy / len, dz / len),
  );
  return matrix.compose(position, quaternion, new Vector3(thickness, len * 1.02, thickness));
}

/** The vault ribs: one curve every `ribSpacing`, as chained box segments. */
function Ribs({ length, base }: { length: number; base: number }) {
  const mesh = useRef<InstancedMesh>(null);
  const count = Math.floor(length / METRO.ribSpacing) + 1;
  const segments = 20;

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new Matrix4();
    let n = 0;
    for (let r = 0; r < count; r++) {
      const z = -length / 2 + r * METRO.ribSpacing;
      for (let i = 0; i < segments; i++) {
        const [x0, y0] = vaultPoint((i / segments) * Math.PI);
        const [x1, y1] = vaultPoint(((i + 1) / segments) * Math.PI);
        instanced.setMatrixAt(n++, between(matrix, [x0, base + y0, z], [x1, base + y1, z], 0.16));
      }
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [count, length, base]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count * segments]} castShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#3b424b" roughness={0.5} metalness={0.6} />
    </instancedMesh>
  );
}

const STEEL = { color: '#3b424b', roughness: 0.5, metalness: 0.6 } as const;

export function ElevatedStation() {
  const site = METRO_SITE;

  const built = useMemo(() => {
    if (!site) return null;
    const half = METRO.platformLength / 2 + METRO.deckEase + 3;
    const pitch = 3;
    const count = Math.round((half * 2) / pitch);
    const samples: Sample[] = [];
    for (let i = 0; i <= count; i++) {
      const along = -half + (i / count) * half * 2;
      const arc = site.arc + along;
      const [x, y, z] = trainPointAt(arc);
      const [nx, nz] = trainNormalAt(arc);
      samples.push({ x, z, nx, nz, arc, y: y + RAIL_HEAD_LIFT, along });
    }
    return {
      deck: buildLoft(samples, STATION_DECK, { closed: true }),
      left: buildLoft(samples, platform(LEFT_FACE, LEFT_FACE + METRO.platformWidth),
        { closed: true, filter: onPlatform }),
      right: buildLoft(samples, platform(RIGHT_FACE, RIGHT_FACE - METRO.platformWidth),
        { closed: true, filter: onPlatform }),
      leftLine: buildLoft(samples, edgeLine(LEFT_FACE, 1), { filter: onPlatform }),
      rightLine: buildLoft(samples, edgeLine(RIGHT_FACE, -1), { filter: onPlatform }),
      shell: vaultShell(METRO.platformLength),
    };
  }, [site]);

  useEffect(() => () => {
    if (!built) return;
    for (const g of [built.deck, built.left, built.right, built.leftLine, built.rightLine]) {
      g.geometry.dispose();
    }
    built.shell.dispose();
  }, [built]);

  if (!site || !built) return null;

  const L = METRO.platformLength;
  const [cx, cy, cz] = site.centre;
  // Heights in the station frame, whose origin is the graded rail point.
  const railHead = RAIL_HEAD_LIFT;
  const platformTop = railHead + METRO.platformRise;
  const springing = platformTop + METRO.vaultRise;
  const wireY = railHead + METRO.wireHeight;
  const groundY = site.ground - cy;

  const columns = Array.from({ length: Math.floor(L / METRO.columnSpacing) + 1 }, (_, i) => (
    -L / 2 + i * METRO.columnSpacing
  ));
  const gantries = Array.from({ length: Math.floor(L / METRO.gantrySpacing) + 1 }, (_, i) => (
    -L / 2 + METRO.gantrySpacing / 2 + i * METRO.gantrySpacing
  )).filter((z) => z < L / 2);
  const lamps = Array.from({ length: Math.floor(L / METRO.lampSpacing) }, (_, i) => (
    -L / 2 + METRO.lampSpacing / 2 + i * METRO.lampSpacing
  ));
  const stairHeight = platformTop - groundY;

  return (
    <group>
      {/* Swept along the line: deck, platforms, edge lines. World space. */}
      <mesh geometry={built.deck.geometry} castShadow receiveShadow>
        <meshStandardMaterial color="#aaa59c" roughness={0.9} side={DoubleSide} />
      </mesh>
      {[built.left, built.right].map((p, i) => (
        <mesh key={i} geometry={p.geometry} castShadow receiveShadow>
          <meshStandardMaterial color="#8f8b84" roughness={0.95} side={DoubleSide} />
        </mesh>
      ))}
      {[built.leftLine, built.rightLine].map((l, i) => (
        <mesh key={i} geometry={l.geometry} receiveShadow>
          <meshStandardMaterial color="#e6b923" roughness={0.8} side={DoubleSide} />
        </mesh>
      ))}

      {/* Straight, in the station's frame. Local +X is left of travel, +Z forward. */}
      <group position={[cx, cy, cz]} rotation={[0, site.heading, 0]}>
        {/* The vault: shell, ribs, purlins, and the springing beams. */}
        <mesh geometry={built.shell} position={[0, springing, 0]}>
          <meshStandardMaterial
            color="#d6e6f3" transparent opacity={0.28} roughness={0.15} metalness={0.1}
            side={DoubleSide} depthWrite={false}
          />
        </mesh>
        <Ribs length={L} base={springing} />
        {Array.from({ length: METRO.purlins }, (_, k) => {
          const [x, y] = vaultPoint(((k + 1) / (METRO.purlins + 1)) * Math.PI);
          return (
            <mesh key={k} position={[x, springing + y, 0]} castShadow>
              <boxGeometry args={[0.12, 0.12, L]} />
              <meshStandardMaterial {...STEEL} />
            </mesh>
          );
        })}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[MID + side * VAULT_RX, springing, 0]} castShadow>
            <boxGeometry args={[0.32, 0.32, L]} />
            <meshStandardMaterial {...STEEL} />
          </mesh>
        ))}

        {/* Roof columns, 0.5 m in from each platform's outer edge. */}
        {columns.map((z) => [-1, 1].map((side) => (
          <mesh
            key={`${z}${side}`}
            position={[MID + side * (HALF - 0.5), (platformTop + springing) / 2, z]}
            castShadow
          >
            <boxGeometry args={[METRO.columnHalf * 2, springing - platformTop, METRO.columnHalf * 2]} />
            <meshStandardMaterial {...STEEL} />
          </mesh>
        )))}

        {/* Catenary: portal gantries over both tracks, and a wire over each. */}
        {gantries.map((z) => (
          <group key={z}>
            {[-1, 1].map((side) => (
              <mesh
                key={side}
                position={[MID + side * (MID + METRO.platformSetback + 0.6), (platformTop + wireY + 1.2) / 2, z]}
                castShadow
              >
                <boxGeometry args={[0.24, wireY + 1.2 - platformTop, 0.24]} />
                <meshStandardMaterial {...STEEL} />
              </mesh>
            ))}
            <mesh position={[MID, wireY + 1.1, z]} castShadow>
              <boxGeometry args={[(MID + METRO.platformSetback + 0.6) * 2, 0.22, 0.3]} />
              <meshStandardMaterial {...STEEL} />
            </mesh>
          </group>
        ))}
        {[0, EL.trackGap].map((x) => (
          <mesh key={x} position={[x, wireY, 0]}>
            <boxGeometry args={[0.035, 0.035, L + 2 * METRO.deckEase]} />
            <meshStandardMaterial color="#6d6a62" roughness={0.6} metalness={0.7} />
          </mesh>
        ))}

        {/* Lamps under the vault, over each platform, and the hanging signs. */}
        {lamps.map((z) => [-1, 1].map((side) => (
          <mesh key={`${z}${side}`} position={[MID + side * 4.8, platformTop + 3.4, z]}>
            <boxGeometry args={[0.9, 0.12, 0.26]} />
            <meshStandardMaterial color="#fff4d6" emissive="#fff2cc" emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
        )))}
        {gantries.map((z) => [-1, 1].map((side) => (
          <group key={`s${z}${side}`} position={[MID + side * 4.8, platformTop + 2.7, z + 6]}>
            <mesh castShadow>
              <boxGeometry args={[1.7, 0.5, 0.08]} />
              <meshStandardMaterial color="#1c2026" roughness={0.6} />
            </mesh>
            <mesh position={[0, 0.16, 0.05]}>
              <boxGeometry args={[1.5, 0.12, 0.01]} />
              <meshStandardMaterial color="#f2c230" emissive="#f2c230" emissiveIntensity={0.8} toneMapped={false} />
            </mesh>
          </group>
        )))}

        {/* Stairs down to the footpath, one tower per platform at the south end.
            Solid: they stand on the pavement beside a live road. */}
        {[-1, 1].map((side) => {
          const x = MID + side * (HALF + METRO.stairWidth / 2 + 0.2);
          const z = -L / 2 - METRO.stairLength / 2 - 1;
          return (
            <group key={side}>
              <mesh position={[x, groundY + stairHeight / 2, z]} castShadow receiveShadow>
                <boxGeometry args={[METRO.stairWidth, stairHeight, METRO.stairLength]} />
                <meshStandardMaterial color="#a39e95" roughness={0.9} />
              </mesh>
              <mesh position={[x, platformTop + 2.6, z]} castShadow>
                <boxGeometry args={[METRO.stairWidth + 0.4, 0.18, METRO.stairLength + 0.4]} />
                <meshStandardMaterial {...STEEL} />
              </mesh>
              {/* The landing bridge onto the platform. */}
              <mesh position={[MID + side * (HALF + 0.1), platformTop - 0.12, z + METRO.stairLength / 2 + 0.6]} castShadow>
                <boxGeometry args={[0.6, 0.24, 1.6]} />
                <meshStandardMaterial color="#8f8b84" roughness={0.95} />
              </mesh>
              <RigidBody type="fixed" colliders={false}>
                <CuboidCollider
                  args={[METRO.stairWidth / 2, stairHeight / 2, METRO.stairLength / 2]}
                  position={[x, groundY + stairHeight / 2, z]}
                />
              </RigidBody>
            </group>
          );
        })}
      </group>
    </group>
  );
}
