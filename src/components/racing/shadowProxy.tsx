'use client';

import { useMemo } from 'react';
import { BoxGeometry, MeshBasicMaterial } from 'three';

/**
 * A vehicle's shadow, cast by a box instead of by the vehicle.
 *
 * Measured on the main line: the rail stock was **353 of the shadow pass's 504
 * draw calls** — 70% of it, and 19% of every draw call in the frame — because
 * each of the 3,080 meshes that make up the trains is a caster of its own. A
 * coach is around a hundred primitives split by material, and every one of them
 * is a separate submission to the shadow map: the seats, the door handles, the
 * `Button_Silver` at 28 k triangles. None of that is visible in a shadow. The
 * *interior* ones cannot be visible in a shadow at all, since they are inside a
 * box.
 *
 * So the vehicles stop casting and one box per vehicle casts for them. A train
 * is very nearly a box, and at shadow-map resolution the difference between its
 * silhouette and its bounding box is nothing you can find.
 *
 * ## Why it has to be drawn at all
 *
 * The obvious trick — put the proxy on a layer the camera does not see and the
 * light does — does not work here. Three's shadow pass tests
 * `object.layers.test( camera.layers )` against the **scene camera**, not
 * against the light (`three.module.js`, `renderObject`), so a proxy the camera
 * cannot see is a proxy that casts nothing. `material.visible = false` fails for
 * the same reason a line further down: the shadow pass checks it too.
 *
 * What is left is `colorWrite: false` — the proxy IS drawn in the colour pass,
 * costing one call, but writes no pixels and no depth. So the trade is one
 * no-op call per vehicle against a hundred real ones, which is the whole point.
 */
const PROXY_MATERIAL = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

/** One box geometry per distinct vehicle size, shared across every copy. */
const boxes = new Map<string, BoxGeometry>();
function proxyBox(width: number, height: number, length: number): BoxGeometry {
  const key = `${width}:${height}:${length}`;
  let box = boxes.get(key);
  if (!box) {
    box = new BoxGeometry(width, height, length);
    boxes.set(key, box);
  }
  return box;
}

/**
 * `size` is the body's own — width, height over the roof, length. The height is
 * the ROOF height and not the measured one: the measurement takes in a
 * pantograph or a roof aerial, and a shadow box that tall reads as a train with
 * a container on it.
 */
export function ShadowProxy({ size }: { size: readonly [number, number, number] }) {
  const geometry = useMemo(() => proxyBox(size[0], size[1], size[2]), [size]);
  // The vehicle's own origin has its wheels on y = 0 (see `prepare-train.mjs`),
  // so the body stands from there up.
  return (
    <mesh geometry={geometry} material={PROXY_MATERIAL} position={[0, size[1] / 2, 0]} castShadow />
  );
}
