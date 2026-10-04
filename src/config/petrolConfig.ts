import { STATION_FORECOURT, trunkSamples } from './islandRailConfig';
import petrolData from './petrolData.json';

/**
 * The petrol station at the west end of Halcyon Junction's car park.
 *
 * Lifted whole out of the city (`prepare-petrol.mjs`, from world (−1125, −150))
 * and set down as part of the car park, not beside it: its lot butts onto the
 * car park's west cross aisle at x −300 with no kerb between, and the asphalt
 * carries on round it to the harbour road on the west and the railway fence on
 * the north — the whole corner between the outer road, the harbour road and
 * the trunk is one paved lot.
 *
 * ## Turned a quarter
 *
 * The lot is 48 x 64 m. Lengthwise along the railway it would put its
 * north-west corner on the trunk, which sweeps across this corner on its curve
 * down the island; turned so its 64 m runs along x, it fits with 0.7 m to spare
 * at that corner. +π/2 also puts each side where it belongs: the canopy faces
 * the harbour road, the side that faced the city's street opens onto the outer
 * road, the second pump row opens into the car park, and the verge side backs
 * onto the railway.
 */
export const PETROL = {
  model: petrolData.model,
  size: petrolData.size as [number, number, number],
  triangles: petrolData.triangles,
};

/** Island frame: the lot's centre, turn, and its footprint after the turn. */
export const PETROL_SITE = (() => {
  const turn = Math.PI / 2;
  // After the turn the model's z runs along x, and −x along z. Local extents
  // are measured off the bake (`size` is the lot, centred).
  const east = STATION_FORECOURT.park.ends[0][0];
  const south = STATION_FORECOURT.park.bottom;
  const [w, , d] = PETROL.size;
  const x = east - d / 2;
  const z = south + w / 2;
  return { x, z, turn, x0: east - d, x1: east, z0: south, z1: south + w };
})();

/** The harbour road's east kerb, which the paving runs up to. */
export const HARBOUR_KERB_X = -395 + 9.5;
/** Where the harbour road starts lifting for the crossing: the paving stops being open to it here. */
export const RAMP_FOOT_Z = 287;

/**
 * How far north the paving may run at `x`: 6 m clear of the nearer trunk
 * track's centre (the ballast toe plus a verge for the fence).
 */
const TRACKS = [...trunkSamples(-1), ...trunkSamples(1)].filter((s) => s.x > -420 && s.x < -280);
export function pavingTop(x: number): number {
  let top = Infinity;
  for (const s of TRACKS) {
    const dx = Math.abs(s.x - x);
    if (dx >= 6) continue;
    top = Math.min(top, s.z - Math.sqrt(36 - dx * dx));
  }
  return top;
}

/** The asphalt's bounds: from the outer road's kerb to the railway fence, harbour road to car park. */
export const PETROL_PAVING = {
  x0: HARBOUR_KERB_X,
  x1: PETROL_SITE.x1,
  // Right to the outer road's kerb: no verge and no hedge on this stretch.
  z0: STATION_FORECOURT.roadEdge,
};
