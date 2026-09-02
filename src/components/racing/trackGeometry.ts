/**
 * Builds every piece of track geometry from the analytic centreline.
 *
 * Pure module — no React, no three.js scene objects beyond BufferGeometry, so
 * it can be memoised once and reused for both rendering and physics colliders.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { TRACK, curvatureRadius, trackNormal, trackPoint, trackTangent } from '@/config/trackConfig';

const TAU = Math.PI * 2;

interface Ribbon {
  geometry: BufferGeometry;
  /** Flat vertex/index arrays, reusable directly as a Rapier trimesh collider. */
  vertices: Float32Array;
  indices: Uint32Array;
}

/** One sample of the centreline, precomputed so every ribbon shares the work. */
interface Sample {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** Cumulative arc length from theta = 0. */
  arc: number;
  isCorner: boolean;
}

export function sampleTrack(): Sample[] {
  const { segments } = TRACK;
  const samples: Sample[] = [];
  let arc = 0;
  let previous: [number, number] | null = null;

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * TAU;
    const [x, z] = trackPoint(theta);
    const [nx, nz] = trackNormal(theta);
    if (previous) arc += Math.hypot(x - previous[0], z - previous[1]);
    previous = [x, z];
    samples.push({
      x, z, nx, nz, arc,
      isCorner: curvatureRadius(theta) < TRACK.curbCurvatureRadius,
    });
  }

  // Dilate the corner flag so curbs start before the apex and run past it,
  // instead of popping in and out at the exact curvature threshold.
  const dilation = Math.max(2, Math.round(segments / 90));
  const raw = samples.map((s) => s.isCorner);
  for (let i = 0; i < samples.length; i++) {
    let on = false;
    for (let d = -dilation; d <= dilation && !on; d++) {
      on = raw[(i + d + samples.length) % samples.length];
    }
    samples[i].isCorner = on;
  }
  return samples;
}

/**
 * Builds a flat horizontal strip between two signed offsets from the centreline.
 *
 * @param inner  offset of the first edge (metres, along the outward normal)
 * @param outer  offset of the second edge
 * @param y      height above the ground plane
 * @param vScale arc-length metres per texture repeat
 * @param filter optional predicate — segments returning false are skipped, which
 *               is how curbs end up only in the corners
 */
export function buildRibbon(
  samples: Sample[],
  inner: number,
  outer: number,
  y: number,
  vScale: number,
  filter?: (a: Sample, b: Sample) => boolean,
): Ribbon {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Vertices are emitted per-quad rather than shared, because skipped segments
  // would otherwise leave orphaned vertices and broken UV continuity.
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (filter && !filter(a, b)) continue;

    const base = positions.length / 3;
    const corners: Array<[Sample, number]> = [[a, inner], [a, outer], [b, inner], [b, outer]];
    for (const [s, offset] of corners) {
      positions.push(s.x + s.nx * offset, y, s.z + s.nz * offset);
      normals.push(0, 1, 0);
      uvs.push(offset === inner ? 0 : 1, s.arc / vScale);
    }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  return finish(positions, normals, uvs, indices);
}

/**
 * Builds a vertical wall standing on the ground plane at a fixed offset.
 * Used for the barriers; doubles as their collider.
 */
export function buildWall(samples: Sample[], offset: number, height: number, vScale: number): Ribbon {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // The wall faces the track, so its normal points opposite the outward offset.
  const facing = offset > 0 ? -1 : 1;

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const base = positions.length / 3;

    for (const s of [a, b]) {
      const x = s.x + s.nx * offset;
      const z = s.z + s.nz * offset;
      positions.push(x, 0, z, x, height, z);
      normals.push(s.nx * facing, 0, s.nz * facing, s.nx * facing, 0, s.nz * facing);
      uvs.push(s.arc / vScale, 0, s.arc / vScale, 1);
    }
    if (facing > 0) indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    else indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  return finish(positions, normals, uvs, indices);
}

function finish(positions: number[], normals: number[], uvs: number[], indices: number[]): Ribbon {
  const vertices = new Float32Array(positions);
  const indexArray = new Uint32Array(indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  geometry.computeBoundingSphere();
  return { geometry, vertices, indices: indexArray };
}

/** The start/finish line: a single wide stripe laid across the track at theta = 0. */
export function buildStartLine(): BufferGeometry {
  const [x, z] = trackPoint(0);
  const [nx, nz] = trackNormal(0);
  const [tx, tz] = trackTangent(0);
  const halfDepth = 0.9;
  const w = TRACK.halfWidth;

  const positions: number[] = [];
  const uvs: number[] = [];
  for (const alongSign of [-1, 1]) {
    for (const acrossSign of [-1, 1]) {
      positions.push(
        x + nx * w * acrossSign + tx * halfDepth * alongSign,
        0.014,
        z + nz * w * acrossSign + tz * halfDepth * alongSign,
      );
      uvs.push(acrossSign > 0 ? 1 : 0, alongSign > 0 ? 1 : 0);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array([0, 2, 1, 1, 2, 3]), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export type { Ribbon, Sample };
