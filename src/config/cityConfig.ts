/**
 * City map, as measured by `scripts/prepare-map.mjs`.
 *
 * `cityData.json` is GENERATED — never hand-edit it. Re-run `npm run prepare:map`
 * after touching the script or replacing the source GLB and the values here
 * follow automatically.
 */
import data from './cityData.json';

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
  /** On a wide street near the middle of the map, facing down it. */
  spawn: {
    position: data.spawn.position as Vec3,
    heading: data.spawn.heading,
  },
  /** Georeferencing for `cityNav.png` — see `physics/cityNav.ts`. */
  nav: data.nav,
  boxes: data.boxes as CityBox[],
} as const;

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
