'use client';

import { Matrix4, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import { Mesh } from 'three';

/**
 * Borrowing pieces of the city to build somewhere else.
 *
 * `prepare-map.mjs` merges `city.glb` into chunks of (material, 250 m cell),
 * with every node transform baked into the vertices. A chunk is therefore a
 * plain world-space mesh sharing one material, and drawing it a second time
 * somewhere else costs one matrix and one draw call against geometry and
 * textures that are already resident. A row of shops is 3,120 triangles; the
 * same row laid five times down a street is five draw calls and no new asset.
 *
 * That is how the island's village and the station's town are built, and how
 * `IslandTown` builds the rest of the town around the station. This module is
 * the shared part: finding the chunks by name, and placing them.
 *
 * ## The geometry is in CITY coordinates
 *
 * A chunk's vertices are where that building stands in the city, hundreds of
 * metres away. So every placement is two nested groups: an outer one at the
 * target carrying the rotation, and an inner one that shifts the chunk back by
 * its own centre. Rotating before centring would swing the block around a
 * point most of a kilometre away. `CityPart.offset` is that shift, and it
 * stands the chunk on its own lowest vertex rather than centring it in Y, so a
 * building placed on the island crown has its footings at the crown instead of
 * half buried or hovering.
 */

export interface CityPart {
  geometry: BufferGeometry;
  material: Material | Material[];
  /** Brings the chunk's own XZ centre to the origin and its base to y = 0. */
  offset: [number, number, number];
  /** Size of the chunk in its own axes, metres. */
  size: [number, number, number];
}

/**
 * Finds named chunks in the already-loaded city scene.
 *
 * Names are the preprocessor's: `<role>_<surface>_<cellX>_<cellZ>`, e.g.
 * `deco_Building_-5_-1`. The cell survives three's name sanitising because it
 * is digits and underscores, which is the only reason chunks can be addressed
 * by name at all.
 */
export function collectCityParts(
  scene: Object3D | null, names: Iterable<string>,
): Map<string, CityPart> {
  const wanted = new Set(names);
  const found = new Map<string, CityPart>();
  if (!scene) return found;
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if (!wanted.has(object.name) || found.has(object.name)) return;
    const geometry = object.geometry as BufferGeometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return;
    found.set(object.name, {
      geometry,
      material: object.material as Material | Material[],
      offset: [-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2],
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    });
  });
  return found;
}

/**
 * The matrix that places one copy of `part` at (x, y, z) turned by `turn`,
 * with the chunk's recentring applied FIRST.
 *
 * For instanced placements, which have no group to nest. Composed and then
 * multiplied rather than composed in one go, because the offset is in the
 * chunk's own space and has to be applied before the rotation that turns it.
 */
export function cityPartMatrix(
  part: CityPart, x: number, y: number, z: number, turn: number, out = new Matrix4(),
): Matrix4 {
  const place = new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), turn),
    new Vector3(1, 1, 1),
  );
  const centre = new Matrix4().makeTranslation(part.offset[0], part.offset[1], part.offset[2]);
  return out.multiplyMatrices(place, centre);
}
