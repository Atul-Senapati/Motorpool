import { CuboidCollider } from '@react-three/rapier';
import boxes from '@/config/colliderBoxes.json';

/**
 * Colliders that follow a part instead of boxing the sky around it.
 *
 * Everything solid at the airport and in the park used to get ONE cuboid the
 * size of the model's bounding box. For a hangar that is honest — a hangar is
 * a box, and `prepare-colliders.mjs` measures it as 100% solid and emits one
 * box, so nothing changes for it. For everything else the bounding box was a
 * wall you could see straight through:
 *
 *   terminal   a 200 m concourse laid DIAGONALLY across its own bounds. The
 *              box was 108 x 210 m and 4% of it was building; the other 96%
 *              was forecourt you bounced off.
 *   coaster    a hundred metres of track and sky. 4% solid.
 *   deco_*     a city chunk is a grid CELL, not a building — ten blocks with
 *              streets between them, and the streets were walls.
 *
 * The boxes are measured off the geometry by `scripts/prepare-colliders.mjs`
 * and live in `colliderBoxes.json`. They come in the part's own placed frame —
 * x and z about the footprint centre, which is where `cityPartMatrix` and the
 * airport's `copy.position.set(b.x, 0, b.z)` both put their meshes.
 *
 * Only surfaces a CAR can reach are measured, so a canopy leaves its columns
 * and nothing else: you drive under it, as you always could have.
 */

interface Entry {
  size: number[];
  height: number;
  /** `[centreX, centreZ, halfX, halfZ]`, about the footprint centre. */
  boxes: number[][];
}

const TABLE = boxes as unknown as Record<string, Entry>;

/**
 * The colliders for one placement of one part.
 *
 * The turn is applied here rather than by nesting a rotated group, so each
 * collider carries its own finished transform — the same way every other box
 * in this scene is placed, and one less thing depending on how the physics
 * layer walks the tree.
 *
 * A part with no measurement falls back to its bounding box, which is what
 * everything used to get. That matters: the table is built from three model
 * files, and a part that is added to a config but not to a model should end up
 * solid-ish rather than driveable.
 */
export function partColliders(
  part: string,
  x: number,
  z: number,
  turn: number,
  size: readonly [number, number, number],
  key: string,
  /**
   * How far the mesh itself was scaled, if it was.
   *
   * Every part at the airport and in the park is placed at the size it was
   * measured at, and for those this is 1 and changes nothing. The school's
   * campus is not: it is fitted to its block (`kestrelSchool`), and a collider
   * table measured off the unscaled model would stand its walls a couple of
   * metres outside the building they belong to.
   */
  scale = 1,
) {
  const entry = TABLE[part];
  if (!entry || !entry.boxes.length) {
    return [
      <CuboidCollider
        key={key}
        args={[(size[0] / 2) * scale, (size[1] / 2) * scale, (size[2] / 2) * scale]}
        position={[x, (size[1] / 2) * scale, z]}
        rotation={[0, turn, 0]}
      />,
    ];
  }
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const half = (entry.height / 2) * scale;
  return entry.boxes.map(([cx0, cz0, hx0, hz0], i) => {
    const [cx, cz, hx, hz] = [cx0 * scale, cz0 * scale, hx0 * scale, hz0 * scale];
    return (
      <CuboidCollider
        key={`${key}-${i}`}
        args={[hx, half, hz]}
        position={[x + cx * cos + cz * sin, half, z - cx * sin + cz * cos]}
        rotation={[0, turn, 0]}
      />
    );
  });
}
