/**
 * City map, as measured by `scripts/prepare-map.mjs`.
 *
 * `cityData.json` is GENERATED — never hand-edit it. Re-run `npm run prepare:map`
 * after touching the script or replacing the source GLB and the values here
 * follow automatically.
 */
import data from './cityData.json';
import spawnData from './spawnPoints.json';

type Vec3 = [number, number, number];

/** A building/obstacle box collider: centre and half-extents, world metres. */
export interface CityBox {
  /** Centre. */
  p: number[];
  /** Half-extents. */
  h: number[];
}

export const CITY = {
  /** Source units per metre; recorded so the numbers below can be traced back. */
  unitScale: data.unitScale,
  /** Edge length of the spatial merge cells the chunks were built on. */
  cell: data.cell,
  bounds: {
    min: data.bounds.min as Vec3,
    max: data.bounds.max as Vec3,
  },
  /**
   * On a wide street near the middle of the map, facing down it. This is the
   * one the map preprocessor measures, and it is now the *fallback* — see
   * `pickCitySpawn` below for the one a drive actually starts at.
   */
  spawn: {
    position: data.spawn.position as Vec3,
    heading: data.spawn.heading,
  },
  /** Georeferencing for `cityNav.png` — see `physics/cityNav.ts`. */
  nav: data.nav,
  boxes: data.boxes as CityBox[],
} as const;

export interface CitySpawn {
  position: Vec3;
  heading: number;
}

/**
 * Somewhere different to start, every drive.
 *
 * `npm run spawns` surveys the nav raster for places a car can be dropped and
 * driven away — on pavement, flat under the footprint, with road ahead of it
 * and clear of the tram and train lines — spread at least 300 m apart across
 * the whole map, and writes them to `spawnPoints.json`. See
 * `scripts/find-spawns.mjs` for what each of those means and why.
 *
 * The choice is made *here*, once, when this module is first evaluated, and
 * not per frame or per render: `VEHICLE.spawn` is read at mount by `CarPhysics`
 * and by `vehiclePhysics`' initial state, and the reset handler falls back to
 * it, so all three have to agree for the whole session. Picking a car in the
 * garage reloads the page, which is what makes the next drive a different
 * place.
 *
 * `?spawn=<n>` pins it, for reproducing a report about one particular street.
 */
export const SPAWN_PARAM = 'spawn';

const CITY_SPAWNS: CitySpawn[] = spawnData.points.map((p) => ({
  position: p.position as Vec3,
  heading: p.heading,
}));

export function pickCitySpawn(): CitySpawn {
  if (!CITY_SPAWNS.length) return CITY.spawn;
  // Server-side there is no drive to start, and a random pick here would only
  // differ from the client's. The first one is stable and never rendered.
  if (typeof window === 'undefined') return CITY_SPAWNS[0];
  const requested = new URLSearchParams(window.location.search).get(SPAWN_PARAM);
  if (requested !== null) {
    const index = Number(requested);
    if (Number.isInteger(index) && index >= 0 && index < CITY_SPAWNS.length) {
      return CITY_SPAWNS[index];
    }
  }
  return CITY_SPAWNS[Math.floor(Math.random() * CITY_SPAWNS.length)];
}

/** Road/height raster backing the minimap, the compass and reset-onto-road. */
export const CITY_NAV_IMAGE = '/models/cityNav.png';

/** Model path, and the locally hosted Draco decoder that unpacks it. */
export const CITY_MODEL = '/models/city.glb';

/**
 * drei would otherwise pull the Draco decoder from a Google CDN. The rest of
 * this project deliberately has no runtime network dependencies (procedural
 * textures, procedural environment map, no webfont), so the decoder is vendored
 * into `public/draco/` from the copy that ships inside three.
 */
export const DRACO_PATH = '/draco/';
