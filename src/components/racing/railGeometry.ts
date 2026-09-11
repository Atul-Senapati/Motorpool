/**
 * Lofts a cross-section along a centreline.
 *
 * `trackGeometry.buildRibbon` builds a flat strip: two offsets from the
 * centreline, one height. That is all the circuit and the street-running tram
 * need, because both are painted onto a surface that already exists. A railway
 * is not painted on — it is *built*, and everything it is built from has a
 * cross-section with a shape: a ballast bank is a trapezium, a bridge deck is a
 * box with a parapet up each side, a tunnel portal is a wall with a hole in it.
 *
 * So this takes a profile — a list of (offset, rise) points in the plane at
 * right angles to travel — and sweeps it along the samples. One function
 * covers every piece of the line, and each piece is then described by its
 * profile alone rather than by its own bespoke vertex loop.
 *
 * Profile coordinates may be constants or functions of the sample, because the
 * shapes are not constant: an embankment's toe sits further out the deeper the
 * fill under it, and a pier is as tall as the ground beneath it is low.
 *
 * Pure module — no React, no scene objects beyond BufferGeometry — so the
 * results can be memoised once and handed to Rapier as trimesh colliders.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { Ribbon } from './trackGeometry';

/** One centreline sample. `y` is the reference height the profile hangs off. */
export interface LoftSample {
  x: number;
  z: number;
  /** Unit normal, left of travel. The profile's `off` axis. */
  nx: number;
  nz: number;
  /** Cumulative arc length, for V coordinates. */
  arc: number;
  y: number;
}

type Dimension<S> = number | ((sample: S) => number);

/** One vertex of the cross-section: across the line, and up from `sample.y`. */
export interface ProfileVertex<S extends LoftSample = LoftSample> {
  off: Dimension<S>;
  rise: Dimension<S>;
}

export interface LoftOptions<S extends LoftSample = LoftSample> {
  /** Join the last profile vertex back to the first, closing the section. */
  closed?: boolean;
  /** Segments where this returns false are skipped — how the line is split. */
  filter?: (a: S, b: S) => boolean;
  /** Arc-length metres per texture repeat along the line. */
  vScale?: number;
}

const evaluate = <S extends LoftSample>(d: Dimension<S>, s: S) => (
  typeof d === 'function' ? d(s) : d
);

/**
 * Sweeps `profile` along `samples`.
 *
 * Which way a face points is not reasoned about, it is derived: the outward
 * side of a profile edge is fixed by the profile's own winding, which is read
 * off its signed area, and the triangle indices are then flipped if the
 * geometry they would produce disagrees with that. Getting this wrong is
 * invisible until something is lit — a deck soffit shaded as though it faced
 * the sky, an embankment black down one side — and these profiles run both
 * ways round depending on which way the loop happens to travel, so there is no
 * single convention to follow.
 *
 * Winding, not the centroid. The obvious test — outward is whichever side
 * faces away from the middle of the section — is only right for a convex
 * profile, and a bridge deck is not one: between its two parapets it is a U,
 * and the inner face of each parapet is nearer the centroid than the outer, so
 * that test turns both of them inside out.
 */
export function buildLoft<S extends LoftSample>(
  samples: S[],
  profile: ProfileVertex<S>[],
  options: LoftOptions<S> = {},
): Ribbon {
  const { closed = false, filter, vScale = 8 } = options;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const edges = closed ? profile.length : profile.length - 1;

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (filter && !filter(a, b)) continue;

    // Orientation of the section at this sample, by the shoelace formula. An
    // open profile is treated as though closed purely to get its winding; the
    // edge back to the start is never emitted unless `closed` says so.
    let shoelace = 0;
    for (let v = 0; v < profile.length; v++) {
      const p0 = profile[v];
      const p1 = profile[(v + 1) % profile.length];
      shoelace += evaluate(p0.off, a) * evaluate(p1.rise, a)
        - evaluate(p1.off, a) * evaluate(p0.rise, a);
    }
    const winding = shoelace >= 0 ? 1 : -1;

    let u = 0;
    for (let e = 0; e < edges; e++) {
      const v0 = profile[e];
      const v1 = profile[(e + 1) % profile.length];

      const a0 = [evaluate(v0.off, a), evaluate(v0.rise, a)];
      const a1 = [evaluate(v1.off, a), evaluate(v1.rise, a)];
      const b0 = [evaluate(v0.off, b), evaluate(v0.rise, b)];
      const b1 = [evaluate(v1.off, b), evaluate(v1.rise, b)];

      const edgeLength = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
      const uNext = u + edgeLength;

      // Outward in section space: the edge turned a right angle, the way its
      // winding says is outside.
      const pOff = (a1[1] - a0[1]) * winding;
      const pRise = -(a1[0] - a0[0]) * winding;
      const pLength = Math.hypot(pOff, pRise) || 1;
      const nx = (a.nx * pOff) / pLength;
      const ny = pRise / pLength;
      const nz = (a.nz * pOff) / pLength;

      const base = positions.length / 3;
      const corners: Array<[S, number[], number]> = [
        [a, a0, u], [a, a1, uNext], [b, b0, u], [b, b1, uNext],
      ];
      for (const [s, point, uCoord] of corners) {
        positions.push(s.x + s.nx * point[0], s.y + point[1], s.z + s.nz * point[0]);
        normals.push(nx, ny, nz);
        uvs.push(uCoord, s.arc / vScale);
      }

      // Flip the indices if the triangles they make face the other way.
      const ax = positions[base * 3];
      const ay = positions[base * 3 + 1];
      const az = positions[base * 3 + 2];
      const e1 = [
        positions[(base + 2) * 3] - ax,
        positions[(base + 2) * 3 + 1] - ay,
        positions[(base + 2) * 3 + 2] - az,
      ];
      const e2 = [
        positions[(base + 1) * 3] - ax,
        positions[(base + 1) * 3 + 1] - ay,
        positions[(base + 1) * 3 + 2] - az,
      ];
      const facing = (e1[1] * e2[2] - e1[2] * e2[1]) * nx
        + (e1[2] * e2[0] - e1[0] * e2[2]) * ny
        + (e1[0] * e2[1] - e1[1] * e2[0]) * nz;
      if (facing >= 0) indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      else indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);

      u = uNext;
    }
  }

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
