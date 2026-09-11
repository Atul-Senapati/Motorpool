'use client';

import { BoxGeometry, Color, Float32BufferAttribute, MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TRAIN } from '@/config/trainConfig';

/**
 * The one sleeper. Every piece of track in the game — the main line, the
 * station's loop roads, the pointwork — instances THIS geometry, so a sleeper
 * is a sleeper wherever you see it; the station roads used to be brown boxes
 * beside grey concrete monoblocs, which is what a passenger notices first.
 *
 * Origin at the underside centre; +x across the track, +z along it. Use with
 * `meshStandardMaterial vertexColors`.
 */
/**
 * A concrete monobloc sleeper with its fastenings, as one geometry: the
 * sleeper itself (a shade wider at the foot than the top), a rail-seat pad
 * under each rail, and four spring clips a side — in vertex colours, so the
 * whole track's sleepers are one instanced draw. The clips are what make it
 * read at speed: a row of rust-brown dots either side of each rail.
 */
export const SLEEPER_GEOMETRY = (() => {
  const parts: BoxGeometry[] = [];
  const colour = (g: BoxGeometry, hex: string) => {
    const c = new Color(hex);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new Float32BufferAttribute(arr, 3));
    return g;
  };
  const L = TRAIN.sleeperHalfWidth * 2;
  const H = TRAIN.sleeperHeight;
  const T = TRAIN.sleeperLength;
  // Body: lower block full width, upper block a little narrower — the taper.
  parts.push(colour(new BoxGeometry(L, H * 0.55, T).translate(0, H * 0.275, 0), '#8c8983'));
  parts.push(colour(new BoxGeometry(L - 0.06, H * 0.45, T - 0.05).translate(0, H * 0.55 + H * 0.225, 0), '#94918a'));
  const seat = TRAIN.gauge / 2 + 0.035;
  for (const side of [-1, 1]) {
    // Rail-seat pad and baseplate.
    parts.push(colour(new BoxGeometry(0.34, 0.018, T - 0.04).translate(side * seat, H + 0.009, 0), '#3b3733'));
    // Clips: two each side of the rail foot.
    for (const k of [-1, 1]) {
      parts.push(colour(new BoxGeometry(0.07, 0.05, 0.11).translate(side * seat + k * 0.115, H + 0.04, 0), '#6b3f2b'));
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
})();

/**
 * The one sleeper material, shared.
 *
 * Shared because the sleepers are drawn as many chunks now rather than one
 * field (`InstancedField`), and a material per chunk would be a set of uniforms
 * per chunk for a surface that is identical everywhere. One material means the
 * renderer sees one program however many chunks survive the frustum.
 */
export const SLEEPER_MATERIAL = new MeshStandardMaterial({
  vertexColors: true, roughness: 0.9, metalness: 0.05,
});
