/**
 * Brake lights for vehicles that have no brake-light material.
 *
 * ## Why this exists
 *
 * `Car` lights the player's brakes by finding materials named `brakelight` or
 * `rear_lamp` and pushing their emissive up. That works, and it works for
 * exactly one vehicle: the McLaren is a bespoke model with 92 materials, two of
 * them named that. Every other drivable car — all twenty in `vehicles.glb`,
 * which are also everything the NPC traffic drives — comes out of the asset
 * pack with four materials called `Body`, `Glass`, `Optics` and `Wheel`. Not
 * one of them carries a tagged brake light, so not one of those cars has ever
 * lit up: not the player's, when the garage offers a Sedan, and not the forty
 * NPCs braking at every junction in the city.
 *
 * ## The lamps are in the model; they just are not named
 *
 * The `Optics` primitive is the lamp lenses — front and rear both, one
 * material, one mesh. `prepare-vehicles.mjs` already relies on that: it works
 * out which way round a vehicle faces partly by reading the lamp colours, on
 * the rule that the red end is the back. And it normalises every vehicle to
 * **face −Z**.
 *
 * So the rear lamps are the optics triangles whose centroid is at positive Z,
 * and that is all this module does: split the lens geometry at the axle line
 * and keep the back half. Measured across the pack, that is 38 to 318
 * triangles per vehicle — real lamp geometry, in the right place, at the right
 * size, for nothing.
 *
 * ## Drawn as an additive overlay
 *
 * The lamp lens is already being drawn by its own batch. This is a second copy
 * of that geometry laid over it with `AdditiveBlending`, which is what makes
 * the whole thing work per-instance: an instanced mesh can carry a colour per
 * instance but not an emissive per instance, and under additive blending
 * **black is invisible**. So one instanced overlay serves forty cars, each one
 * either dark (adds nothing, lens looks normal) or red (the lens glows), with
 * a single colour write per car per frame and no material churn.
 *
 * `depthWrite` is off for the same reason it is off on any glow: the overlay
 * sits a hair in front of the lens it doubles, and writing depth would have it
 * z-fight with its own source geometry.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Mesh, MeshBasicMaterial,
} from 'three';

/** What the brake lamps are lit in. Not tone-mapped: a lamp is a light, not a surface. */
export const BRAKE_COLOUR = new Color('#ff2b12');

/**
 * The rear half of a lamp lens, as its own geometry.
 *
 * Returns null when there is nothing behind the axle line — which is the
 * honest answer for a mesh that is not a lamp at all, and the caller's cue to
 * skip it rather than draw an empty overlay.
 */
export function rearLampGeometry(source: Mesh): BufferGeometry | null {
  const geometry = source.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!position) return null;

  const count = index ? index.count : position.count;
  const kept: number[] = [];
  for (let t = 0; t < count; t += 3) {
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(t + k) : t + k;
      z += position.getZ(v);
    }
    // Behind the middle of the car. The models face −Z (see the header), so
    // the back half is the positive one.
    if (z / 3 > 0) {
      for (let k = 0; k < 3; k++) kept.push(index ? index.getX(t + k) : t + k);
    }
  }
  if (kept.length < 3) return null;

  // The same vertex buffer, a different index buffer: the overlay is a subset
  // of triangles, so there is nothing to copy but the list of which ones.
  const out = new BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    out.setAttribute(name, geometry.attributes[name]);
  }
  out.setIndex(new BufferAttribute(new Uint32Array(kept), 1));
  out.computeBoundingSphere();
  return out;
}

/** The overlay material. One per mesh, because three disposes them per mesh. */
export function brakeLampMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: '#ffffff',
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    // The lens is double-sided in some of these models and single in others;
    // the overlay follows whichever way the source triangle faces, so it can
    // never end up as the only visible side.
    transparent: true,
  });
}

/**
 * How brightly the brakes are lit, 0 to 1, from what the car is doing.
 *
 * A ramp rather than a switch, and asymmetric: lamps come up in about a tenth
 * of a second and fall over a quarter, which is roughly what a filament does
 * and — more to the point — stops the whole street flickering when the AI's
 * speed controller hunts by a few centimetres a second around its target.
 */
export function rampBrake(current: number, on: boolean, delta: number): number {
  const target = on ? 1 : 0;
  const rate = on ? 14 : 6;
  return current + (target - current) * Math.min(1, delta * rate);
}
