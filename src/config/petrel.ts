import cityGraph from './roadGraph.json';
import petrel from './petrel.json';
import petrelLap from './petrelLap.json';

/**
 * Petrel: the circuit lobe, an island joined to the city by two bridges.
 *
 * Its roads are edges of the city's `roadGraph.json`, by index, listed in
 * `petrel.json` — which `make-city-walks.mjs` reads too, so the traffic and
 * the footways agree on what Petrel is. Found by flood-filling the nav
 * raster's ground (−0.5 to 1.5 m, so roads and grass but neither the sea nor
 * a bridge deck) out from inside the circuit.
 *
 * - The **lap** entries are the graph's own pieces of the circuit, and the
 *   **paddock** everything else on the island — both bridges to the city
 *   (115 to the north, 315 to the east — the latter's ramp reads the ground
 *   under its deck in the raster, so cars on it were drawn falling through),
 *   the road from the north bridge, the infield links and two stubs.
 *
 * None of it is driven or walked: the traffic graph leaves all of it out and
 * puts the racers on a lap traced off the tarmac instead (`petrelLap.json`,
 * `make-petrel-lap.mjs`), and the footways skip it. The list still marks the
 * island's tarmac — `onPetrelRoad` keeps the viaduct's piers off it.
 */
export const PETREL_LAP = new Map<number, 1 | -1>(
  Object.entries(petrel.lap).map(([edge, way]) => [Number(edge), way as 1 | -1]),
);
export const PETREL_PADDOCK = new Set<number>(petrel.paddock);

/** The island's tarmac: the graph's pieces, and the traced racing lap — its track 9.5–10 m each side. */
const ROADS = [
  ...[...PETREL_LAP.keys(), ...PETREL_PADDOCK].map((i) => {
    const e = (cityGraph.edges as Array<{ p: number[][]; w: number }>)[i];
    return { pts: e.p, half: e.w / 2 };
  }),
  { pts: [...(petrelLap as number[][]), (petrelLap as number[][])[0]], half: 10 },
];

/**
 * Is (x, z) on Petrel's tarmac, or within `clear` metres of it? Against the
 * roads' own centrelines and widths — not the nav raster, which may not have
 * loaded when a structure is laid out, so that a test against it silently
 * says no road anywhere.
 */
export function onPetrelRoad(x: number, z: number, clear: number): boolean {
  for (const { pts, half } of ROADS) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      if (Math.hypot(ax + ex * t - x, az + ez * t - z) <= half + clear) return true;
    }
  }
  return false;
}
