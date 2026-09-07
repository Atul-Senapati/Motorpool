/**
 * Per-wheel surface grip, computed analytically.
 *
 * The obvious approach — asking the vehicle controller which collider each
 * wheel is standing on via `wheelGroundObject()` — cannot be used: that call
 * re-enters Rapier's collider set while the vehicle controller is borrowed and
 * throws "recursive use of an object detected which would lead to unsafe
 * aliasing in rust", which aborts the physics step before `updateVehicle()`
 * runs. Symptom: the car has no vehicle physics at all and simply sinks onto
 * its chassis collider.
 *
 * Since the circuit is defined analytically, distance-to-track is cheap to
 * evaluate directly: the centreline is star-shaped about the origin, so for any
 * world point the nearest centreline angle is just atan2(z, x).
 */
import { TRACK, trackRadius } from '@/config/trackConfig';
import { WORLD_ID } from '@/config/world';
import { groundHeightAt, isRoadAt } from './cityNav';

/** Fraction of tarmac grip available off-track. */
export const OFF_TRACK_GRIP = 0.42;

/** Metres beyond the curb over which grip fades, rather than switching abruptly. */
const BLEND = 1.5;

/**
 * Grip multiplier on the procedural circuit: 1 on the racing surface, falling
 * to OFF_TRACK_GRIP once fully onto the grass.
 */
function trackGrip(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const offset = Math.abs(radius - trackRadius(Math.atan2(z, x)));
  const edge = TRACK.halfWidth + TRACK.curbWidth;
  if (offset <= edge) return 1;
  const t = Math.min((offset - edge) / BLEND, 1);
  return 1 + (OFF_TRACK_GRIP - 1) * t;
}

/**
 * Grip multiplier at a world position, for whichever world is loaded.
 *
 * The city returns full grip everywhere. There is no analytic surface to test
 * against — the drivable area is 137 k arbitrary triangles rather than a curve —
 * and the honest options are a precomputed occupancy raster or nothing. Since
 * almost everything you can reach in the city is paved (streets, car parks,
 * plazas, garage floors), uniform tarmac grip is a closer approximation than
 * any cheap guess, and SkidMarks reads the same function so marks are laid
 * consistently. See HANDOFF.md for the raster sketch if this needs to change.
 */
export function gripAt(x: number, z: number): number {
  return WORLD_ID === 'track' ? trackGrip(x, z) : 1;
}

/**
 * Height of the drivable surface under a world position, or null where there is
 * none. The circuit is flat by construction; the city is not.
 *
 * This exists because anything drawn *on* the ground — tyre marks especially —
 * cannot assume y = 0. The city has 91 m of relief, so a mark pinned to the
 * origin plane is buried under the road almost everywhere and floating in the
 * air over the rest, which is why skid marks were invisible there.
 */
export function surfaceHeightAt(x: number, z: number): number | null {
  if (WORLD_ID === 'track') return 0;
  return groundHeightAt(x, z);
}

/**
 * Whether this surface takes a tyre mark, i.e. it is paved.
 *
 * Deliberately separate from `gripAt`. Grip feeds the vehicle model and changing
 * it changes how the car drives; this only decides where rubber shows. The city
 * has no analytic surface to test, but it does have the navigation raster, and
 * a mark laid across a lawn is far more obviously wrong than slightly optimistic
 * grip is.
 */
export function marksAt(x: number, z: number): boolean {
  return WORLD_ID === 'track' ? trackGrip(x, z) >= 1 : isRoadAt(x, z);
}
