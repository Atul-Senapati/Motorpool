import {
  Box3, BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, Vector3,
  type Material, type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Cutting a piece of the city out to stand it somewhere else.
 *
 * `cityChunks` lends whole chunks — a (material, 250 m cell) merge — which is
 * right for a row of shops but useless for one food court in the middle of a
 * cell that also holds a street, a car park and a block of flats. This takes
 * every chunk's triangles inside a box in city coordinates instead:
 *
 *  - **Things** (stalls, tables, a kiosk) are kept whole: a triangle is in if
 *    its centre is, so a table on the line is in or out, never sliced.
 *  - **Ground** — flat, low triangles, which in the merged city can be huge —
 *    is clipped to the box exactly, every attribute interpolated, so a paved
 *    floor comes out as a clean rectangle rather than a ragged one.
 *
 * The result is one geometry per material, recentred on the box (x, z) with
 * the box's floor at y = 0, ready to place. It reuses the city's materials, so
 * it is no new texture memory — only the cut triangles.
 */

export interface CropBox {
  /** City x and z limits. */
  x0: number; x1: number; z0: number; z1: number;
  /** City height of the floor (becomes y = 0) and the highest centre kept. */
  floor: number; top: number;
  /**
   * Only these parts of the box, as [x0, x1, z0, z1]: a triangle is kept if
   * its centre is in one. For trimming a site to some of what is in it —
   * the market's stalls without the square round them.
   */
  parts?: ReadonlyArray<readonly [number, number, number, number]>;
  /** Bring the ground (flat, low triangles) along: true unless set false. */
  ground?: boolean;
}

export interface CroppedPiece { geometry: BufferGeometry; material: Material }

/** A triangle this flat and this low is ground, and is clipped rather than kept whole. */
const GROUND_SPAN = 0.3;
const GROUND_HEIGHT = 1.2;

const _box = new Box3();

/**
 * Crop the loaded city `scene` to `box`. `skip(material)` leaves out whole
 * materials — roads, trees — by name.
 */
export function cropCity(scene: Object3D, box: CropBox, skip: (material: string) => boolean): CroppedPiece[] {
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  const wanted = new Box3(new Vector3(box.x0, box.floor - 1, box.z0), new Vector3(box.x1, box.top + 20, box.z1));
  const byMaterial = new Map<Material, BufferGeometry[]>();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const material = mesh.material as Material;
    if (skip(material.name)) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    _box.copy(g.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (!_box.intersectsBox(wanted)) return;
    const cut = cropGeometry(g, mesh, box, cx, cz);
    if (!cut) return;
    const list = byMaterial.get(material) ?? [];
    list.push(cut);
    byMaterial.set(material, list);
  });
  const out: CroppedPiece[] = [];
  for (const [material, list] of byMaterial) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list);
    if (!merged) continue;
    merged.computeBoundingSphere();
    out.push({ geometry: merged, material });
    if (list.length > 1) list.forEach((g) => g.dispose());
  }
  return out;
}

/** One mesh's share of the box, as a non-indexed geometry in the box's frame. */
function cropGeometry(g: BufferGeometry, mesh: Mesh, box: CropBox, cx: number, cz: number): BufferGeometry | null {
  const pos = g.getAttribute('position');
  const names = Object.keys(g.attributes).filter((n) => n === 'position' || n === 'normal' || n === 'uv' || n === 'color');
  const attrs = names.map((n) => g.getAttribute(n) as BufferAttribute);
  const out: number[][] = names.map(() => []);
  const index = g.getIndex();
  const count = index ? index.count : pos.count;
  const m = mesh.matrixWorld;
  const normalMatrix = m.clone().invert().transpose();
  const v = new Vector3();
  // A vertex, in world space, as a flat list of all its attributes.
  const vertex = (i: number) => attrs.map((a, k) => {
    if (names[k] === 'position') { v.fromBufferAttribute(a, i).applyMatrix4(m); return [v.x, v.y, v.z]; }
    if (names[k] === 'normal') { v.fromBufferAttribute(a, i).applyMatrix4(normalMatrix).normalize(); return [v.x, v.y, v.z]; }
    return Array.from({ length: a.itemSize }, (_, c) => a.getComponent(i, c));
  });
  const emit = (vs: number[][][]) => {
    for (const vert of vs) {
      vert.forEach((value, k) => {
        if (names[k] === 'position') out[k].push(value[0] - cx, value[1] - box.floor, value[2] - cz);
        else out[k].push(...value);
      });
    }
  };
  const P = names.indexOf('position');
  for (let t = 0; t + 2 < count; t += 3) {
    const ia = index ? index.getX(t) : t;
    const ib = index ? index.getX(t + 1) : t + 1;
    const ic = index ? index.getX(t + 2) : t + 2;
    const tri = [vertex(ia), vertex(ib), vertex(ic)];
    const ys = tri.map((p) => p[P][1]);
    const xs = tri.map((p) => p[P][0]);
    const zs = tri.map((p) => p[P][2]);
    const centreY = (ys[0] + ys[1] + ys[2]) / 3;
    if (centreY < box.floor - 0.5 || centreY > box.top) continue;
    const isGround = Math.max(...ys) - Math.min(...ys) < GROUND_SPAN && Math.max(...ys) < box.floor + GROUND_HEIGHT;
    if (box.ground === false && isGround) continue;
    if (box.parts) {
      const mx = (xs[0] + xs[1] + xs[2]) / 3;
      const mz = (zs[0] + zs[1] + zs[2]) / 3;
      if (!box.parts.some(([x0, x1, z0, z1]) => mx >= x0 && mx <= x1 && mz >= z0 && mz <= z1)) continue;
      emit(tri);
      continue;
    }
    const inside = (i: number) => xs[i] >= box.x0 && xs[i] <= box.x1 && zs[i] >= box.z0 && zs[i] <= box.z1;
    if (inside(0) && inside(1) && inside(2)) { emit(tri); continue; }
    if (!isGround) {
      const mx = (xs[0] + xs[1] + xs[2]) / 3;
      const mz = (zs[0] + zs[1] + zs[2]) / 3;
      if (mx >= box.x0 && mx <= box.x1 && mz >= box.z0 && mz <= box.z1) emit(tri);
      continue;
    }
    // Ground straddling the edge: clip to the box, then fan the polygon.
    let poly = tri;
    for (const [axis, limit, keepAbove] of [[0, box.x0, true], [0, box.x1, false], [2, box.z0, true], [2, box.z1, false]] as const) {
      poly = clip(poly, P, axis, limit, keepAbove);
      if (poly.length < 3) break;
    }
    for (let i = 1; i + 1 < poly.length; i++) emit([poly[0], poly[i], poly[i + 1]]);
  }
  if (out[P].length === 0) return null;
  const geometry = new BufferGeometry();
  names.forEach((n, k) => geometry.setAttribute(n, new Float32BufferAttribute(out[k], attrs[k].itemSize)));
  return geometry;
}

/** Sutherland–Hodgman against one axis-aligned line, interpolating every attribute. */
function clip(poly: number[][][], P: number, axis: 0 | 2, limit: number, keepAbove: boolean) {
  const out: number[][][] = [];
  const isIn = (p: number[][]) => (keepAbove ? p[P][axis] >= limit : p[P][axis] <= limit);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ain = isIn(a);
    const bin = isIn(b);
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (limit - a[P][axis]) / (b[P][axis] - a[P][axis]);
      out.push(a.map((value, k) => value.map((x, c) => x + (b[k][c] - x) * t)));
    }
  }
  return out;
}
