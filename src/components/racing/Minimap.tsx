'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CITY_NAV_IMAGE } from '@/config/cityConfig';
import { RAIL_LENGTH, railPointAt } from '@/config/railConfig';
import { JUNCTIONS } from '@/config/pointwork';
import { HELI_DECK, HELI_FORECOURT, HELI_TOWER } from '@/config/heliportConfig';
import {
  TRAIN_ISLANDS, TRAIN_LENGTH, TRAIN_LINE_ENABLED, TRAIN_POINTS,
} from '@/config/trainConfig';
import { KESTREL_PARK_ENABLED, PARK_BLOCK, POND_HOLE } from '@/config/kestrelPark';
import {
  BEACH as KESTREL_BEACH, BEACH_ENABLED as KESTREL_BEACH_ENABLED, BEACH_STAGE, FOOD_COURT_SITES, beachPoint,
} from '@/config/kestrelBeach';
import { CIVIC_BLOCK, CIVIC_ENABLED, CIVIC_SITE } from '@/config/kestrelCivic';
import { MALL_ENABLED, MALL_SITE } from '@/config/kestrelMall';
import {
  ASSEMBLY_BLOCK, ASSEMBLY_SITE, HALLS_ENABLED, PARKING_ENABLED, PARKING_LOTS, SHOP_SITES, SPORTS_BLOCK,
  SPORTS_SITE, blockCut,
} from '@/config/kestrelHalls';
import { SCHOOL_ENABLED, SCHOOL_GROUNDS, SCHOOL_SITE } from '@/config/kestrelSchool';
import kestrelStationData from '@/config/kestrelStationData.json';
import { KESTREL_ARCS, KESTREL_NODES, KESTREL_RUNS, KESTREL_SWEEPS, sweepPoints } from '@/config/kestrelRoads';
import { ROAD_NODES, ROAD_RUNS, ROAD_WIDTH } from '@/config/roadConfig';
import { HARBOUR_ROAD, QUAY } from '@/config/harbourConfig';
import { PETROL_PAVING, PETROL_SITE, pavingTop } from '@/config/petrolConfig';
import {
  BEACH, BOATHOUSE, ROAD_BRIDGES as COUNTRY_ROAD_BRIDGES, SKYLARK_FORECOURT, skylarkPoint, CAMPSITE, CASTLE_HILL, CHAPEL, CHURCH, COUNTRY_ENABLED,
  COUNTRY_NAME, HARBOUR, HILL_FARM, HOME_FARM, JUNCTIONS as COUNTRY_JUNCTIONS, LAKE_OUTLINE, LANES,
  LANE_WIDTH, LIGHTHOUSE, MILL, MINI_ROADS, OUTLINE_WORLD as COUNTRY_OUTLINE, PIER, PONDS, RAIL,
  RAIL_STATIONS, SITE as COUNTRY_SITE, STREAM, TURBINES, VIEWPOINT, VINEYARD, WATERMILL,
  armDirection, coastPoint, railAt, toWorld as countryWorld,
} from '@/config/countryConfig';
import { FIELDS as COUNTRY_FIELDS, WOOD_OUTLINE, type Crop } from '@/config/countryFields';
import {
  AIRPORT_ENABLED, BUILDINGS as AIRPORT_BUILDINGS, CAR_PARK_DECK, CONTAINERS,
  CORNER_BLOCKS, CROSSING, DECO as AIRPORT_DECO, DEPOT, HELIPAD, HELIPADS,
  PARADE_BUILDINGS, PARKED as AIRPORT_PARKED, PAVING as AIRPORT_PAVING, PERIMETER,
  RUNWAY as AIRPORT_RUNWAY, SIDINGS, SILOS, SITE as AIRPORT_SITE,
  TAXIWAY as AIRPORT_TAXIWAY, YARD, outlineWorld as airportOutline, perimeterRuns,
  crossingCurve, sidingCentre,
} from '@/config/airportConfig';
import {
  STATION_FORECOURT, connectionSamples, downLinkSamples, stationLoop, trunkCentre,
} from '@/config/islandRailConfig';
import {
  ARCADE as PARK_ARCADE, KIT as PARK_KIT, PARK_HEDGE, PARK_SURFACES,
  RIDES as PARK_RIDES, parkBoundaryRuns,
} from '@/config/parkConfig';
import parkModels from '@/config/parkModelData.json';
import airportModels from '@/config/airportModelData.json';
import paradeModels from '@/config/paradeModelData.json';
import {
  BRIDGE, CRUISE, CRUISE_BERTH, ISLAND_LINK, MAIN_LINE_TOE, PLATFORMS, ROADS, STATION,
  STATION_ENABLED,
  STATION_ISLAND, STATION_SITE, TOWN, UP_LOOP, roadLead, roadOffset, stationPoint,
} from '@/config/stationConfig';
import {
  CAR_PARK, CHUNK_FOOTPRINT, FORECOURT, RING, RING_CHAINS, STREETS, TOWN_BUILDINGS, TOWN_BUILT,
  TOWN_ENABLED,
} from '@/config/townConfig';
import {
  VILLAGE, VILLAGE_BUILDINGS, VILLAGE_ENABLED, VILLAGE_ISLAND, VILLAGE_PASTURE, VILLAGE_SITE,
  FAR_ROAD, VILLAGE_ROAD, buildingSize, facingTurn, harbourInner, harbourOuter, roadSpur,
  villagePoint, villageShore,
} from '@/config/villageConfig';
import {
  loadCityNav, toPixelX, toPixelZ, toWorldX, toWorldZ, type NavRaster,
} from '@/physics/cityNav';
import { setFullMapOpen, useFullMapOpen } from './fullMapStore';
import { findRoute } from '@/physics/roadRoute';
import type { VehicleTelemetry } from '@/types/vehicle';
import { ACCENT, HATCH, HUD, NUM, PANEL, PANEL_CUT, accentAlpha } from './hudTheme';
import { PositionFix } from './PositionFix';

/** Minimap diameter in CSS pixels. */
const SIZE = 196;
/** How much world the minimap shows across its diameter, in metres. */
const SPAN_METRES = 260;
/** Minimap redraws per second. The map only needs to feel live, not be smooth. */
const HZ = 30;

/**
 * Full-map zoom, in CSS pixels per map pixel — and a map pixel is 1.5 m.
 *
 * The map used to open at whatever the window could fit, which on this city is
 * the whole 4.9 km across a 1100 px box: every street two pixels wide and the
 * player a speck. It now opens close enough to plan a turn from, and the whole
 * map is one scroll away. The floor is below fit-the-window on purpose, so
 * zooming out always ends with the coast in view rather than stopping short.
 */
const DEFAULT_MAP_ZOOM = 0.62;
const MIN_MAP_ZOOM = 0.16;
const MAX_MAP_ZOOM = 3.2;

/**
 * How often the route is re-planned while driving, in milliseconds.
 *
 * A\* across this city is a few thousand junctions — cheap, but not free, and
 * nothing about a route changes in a sixtieth of a second. Twice a second
 * keeps the line attached to the car without putting a graph search on the
 * frame budget.
 */
const ROUTE_EVERY_MS = 500;

const COMPASS = [
  { label: 'N', x: 0, z: -1 },
  { label: 'E', x: 1, z: 0 },
  { label: 'S', x: 0, z: 1 },
  { label: 'W', x: -1, z: 0 },
];

/** Cardinal name for a heading, for the readout under the compass. */
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

interface Waypoint {
  x: number;
  z: number;
}

/**
 * Margin painted around the nav raster, in raster pixels.
 *
 * The raster covers exactly the ground the city preprocessor rasterised, and
 * the railway has since built land outside it: the bigger island now reaches
 * about 40 m past the raster's north edge, so it was drawn clipped by the top
 * of the map. Rather than regenerate the raster — it is the city's, and the
 * island is not the city's — the map is painted onto a larger canvas with the
 * raster inset, which also gives the whole map a little breathing room.
 *
 * 110 px is 165 m, and that was enough while the only thing outside the raster
 * was the railway island's 40 m overhang. It is not enough for Halcyon Field,
 * which sits in open water off the west coast and reaches 590 m past the
 * raster's west edge — drawn with a fixed margin it simply was not on the map,
 * which is a thing you only notice by opening the map and finding nothing
 * there.
 *
 * So the margin is **measured, per side, from what is actually out there**.
 * Only the side that needs room gets it: the airport adds 500-odd pixels to
 * the west and nothing anywhere else, so the canvas grows by 14% rather than
 * doubling, which a symmetric margin would have done. Move the island again
 * and the map follows it with no constant to remember.
 *
 * Everything that converts between world and map pixels has to agree about
 * these, which is what `mapX`/`mapZ` are for; the raster's own `toPixelX`/
 * `toPixelZ` are still the truth for the raster itself.
 */
const BASE_PAD = 220;
/** Slack beyond whatever sticks out, so nothing is drawn hard against the edge. */
const PAD_SLACK = 180;

export interface MapPad { left: number; top: number; right: number; bottom: number; }

const padCache = new WeakMap<NavRaster, MapPad>();

/** The margin each side of the raster needs, in map pixels. */
export function mapPad(nav: NavRaster): MapPad {
  const cached = padCache.get(nav);
  if (cached) return cached;
  const pad: MapPad = {
    left: BASE_PAD, top: BASE_PAD, right: BASE_PAD, bottom: BASE_PAD,
  };
  const grow = (outline: ReadonlyArray<readonly [number, number]>) => {
    for (const [x, z] of outline) {
      const px = toPixelX(nav, x);
      const pz = toPixelZ(nav, z);
      pad.left = Math.max(pad.left, Math.ceil(-px) + PAD_SLACK);
      pad.right = Math.max(pad.right, Math.ceil(px - nav.width) + PAD_SLACK);
      pad.top = Math.max(pad.top, Math.ceil(-pz) + PAD_SLACK);
      pad.bottom = Math.max(pad.bottom, Math.ceil(pz - nav.height) + PAD_SLACK);
    }
  };
  if (AIRPORT_ENABLED) grow(airportOutline());
  // Skylark sits south-west of the airfield, off the raster's bottom-left
  // corner, so it is the island that decides the bottom margin.
  if (COUNTRY_ENABLED) grow(COUNTRY_OUTLINE);
  padCache.set(nav, pad);
  return pad;
}

const mapX = (nav: NavRaster, x: number) => toPixelX(nav, x) + mapPad(nav).left;
const mapZ = (nav: NavRaster, z: number) => toPixelZ(nav, z) + mapPad(nav).top;
export const mapWidth = (nav: NavRaster) => nav.width + mapPad(nav).left + mapPad(nav).right;
export const mapHeight = (nav: NavRaster) => nav.height + mapPad(nav).top + mapPad(nav).bottom;

/**
 * Paint the whole nav raster into an offscreen canvas, once.
 *
 * Roads are drawn bright and everything else recedes, so at minimap size the
 * street grid is the only thing that reads. Terrain keeps a faint height ramp
 * so the hills and the coastline stay legible on the full map.
 */
export function paintFullMap(nav: NavRaster): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = mapWidth(nav);
  canvas.height = mapHeight(nav);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  // The margin is sea, which is what the raster calls void.
  ctx.fillStyle = 'rgb(12,16,26)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const image = ctx.createImageData(nav.width, nav.height);
  const out = image.data;
  const src = nav.data;

  for (let i = 0; i < nav.width * nav.height; i++) {
    const road = src[i * 4];
    const has = src[i * 4 + 3];
    const o = i * 4;
    // Pale streets on dark ground: a plain, legible road map, which is what a
    // minimap in this genre is. A cyan holographic version was tried and read
    // as a radar screen rather than as somewhere you are driving.
    //
    // Two tones, because `R` carries two levels (see `cityNav.ts`). The bright
    // one is street; the dimmer one is the rest of the paving — the yards,
    // forecourts and parking inside the blocks. Drawing only the streets left
    // the blocks hollow and the city looked like a bare grid; drawing both in
    // one tone loses the grid in a wash of white. Two tones keep the blocks
    // solid and the route through them still readable at a glance.
    if (road > 191) {
      out[o] = 226; out[o + 1] = 232; out[o + 2] = 240; out[o + 3] = 255;
    } else if (road > 127) {
      out[o] = 128; out[o + 1] = 138; out[o + 2] = 152; out[o + 3] = 255;
    } else if (has > 127) {
      // Faint height ramp: low ground dark, hilltops slightly lifted.
      const h = ((src[o + 1] << 8) | src[o + 2]) / 65535;
      const v = 26 + h * 42;
      out[o] = v * 0.62; out[o + 1] = v; out[o + 2] = v * 0.66; out[o + 3] = 255;
    } else {
      out[o] = 12; out[o + 1] = 16; out[o + 2] = 26; out[o + 3] = 255;
    }
  }
  ctx.putImageData(image, mapPad(nav).left, mapPad(nav).top);
  // Everything below is placed by world coordinates through `toPixelX`, so one
  // translate here puts the whole lot in the same frame as the inset raster.
  ctx.save();
  ctx.translate(mapPad(nav).left, mapPad(nav).top);
  // Order matters: the made land goes under the town it carries, the town under
  // the platforms and sidings that serve it, and the running line over all of
  // it — the same order these things are stacked in the world.
  paintIslands(ctx, nav);
  paintTownGround(ctx, nav);
  paintTownStreets(ctx, nav);
  paintTownBuildings(ctx, nav);
  paintVillage(ctx, nav);
  paintStation(ctx, nav, canvas);
  paintStationRoads(ctx, nav);
  paintRail(ctx, nav);
  // Over the running line, because it breaks it. See `paintTunnels`.
  paintTunnels(ctx, nav);
  paintBridge(ctx, nav);
  ctx.restore();
  return canvas;
}

/**
 * Made land: the islands the railway built itself, and the beach round each.
 *
 * The nav raster is rasterised from the city's *drivable* surfaces, so
 * everything off the coast comes back as void — the islands are land that
 * exists in the world and has never existed on the map. They are drawn here
 * instead of in the preprocessor because they are the railway's, not the
 * city's: `find-train-route.mjs` and `TrainLine` both read the same outlines
 * out of `trainSketch.json`, and this is the third reader of the same numbers
 * rather than a fourth copy of them.
 *
 * Crown in the same dark green the height ramp gives low ground, so an island
 * reads as the low land it is, and the beach in sand — which is what makes it
 * legible at minimap size, and is also simply what is there.
 */
const ISLAND_LAND = 'rgb(26,42,27)';
/** Platform slabs: paving, so they read as the built ground they are. */
const PLATFORM_FILL = 'rgb(128,138,152)';
/**
 * What the islands' own buildings and paving are drawn in.
 *
 * Matched to the two tones the raster already gives the mainland — the dimmer
 * of its road pair for yards and car parks, and a shade between that and the
 * ground for a block — so a town transplanted onto an island reads as the
 * same kind of place as the city it came from, which it literally is. The
 * quay is lighter than either: it is the only built thing standing over the
 * water and the one worth picking out now that there are boats to bring
 * alongside it.
 */
const PAVED_TONE = 'rgb(128,138,152)';
const BUILDING_TONE = 'rgb(86,94,104)';
const QUAY_TONE = 'rgb(150,132,102)';
/**
 * The airfield's own two tones.
 *
 * Runway and taxiway darker than the aprons, which is both what they look like
 * and what makes the shape read: at minimap scale an airport is two long dark
 * strips with a pale blob beside them. The aeroplanes are near-white because
 * they are the one thing on the island that says what the strips are for.
 */
const RUNWAY_TONE = 'rgb(58,62,68)';
const AIRCRAFT_TONE = 'rgb(206,212,220)';
/** The park: warmer paving than the airfield's, and a tone for the rides. */
const PARK_PAVED_TONE = 'rgb(150,143,130)';
const RIDE_TONE = 'rgb(196,120,96)';
/**
 * Halcyon East's containers: warmer than the concrete they stand on — on a map
 * a container yard is a block of colour that is not the paving, and that is
 * the only thing that says freight rather than car park. Its tracks are drawn
 * like every other railway — see `RAIL_LINE_PX`.
 */
const CONTAINER_TONE = 'rgb(132,101,86)';
/**
 * The perimeter wall: pale, and the palest thing on the island.
 *
 * It has to read over grass AND over tarmac, since it runs across both, so it
 * cannot be a mid grey — anything in the middle disappears against one of
 * them. Concrete-white against both, and thin enough that it is a line and not
 * a wall: at the usual zooms the whole airfield is about 200 px across, and a
 * boundary is the one mark that tells you which side of it you are on.
 */
const WALL_TONE = 'rgb(198,195,187)';
/**
 * Every road on the map, in the mainland's own street style.
 *
 * The city's streets come out of the nav raster pale on dark ground; the
 * islands' roads were drawn in `PAVED_TONE` — the raster's *yard* grey — with a
 * casing in the grass colour, so every island road read as a car park and its
 * edge vanished into the field. One style for all of them now: a dark casing
 * and the raster's street white for through roads, the town's minor-street
 * grey for lanes and tracks. Same two tones `paintTownStreets` already uses.
 */
const STREET_TONE = 'rgb(226,232,240)';
const LANE_TONE = 'rgb(178,187,200)';
const STREET_CASING = 'rgba(9,14,20,0.85)';
/**
 * Every railway on the map, in the main line's amber and hatching.
 *
 * Widths in map pixels, not metres: the main line is drawn at a fixed 6 px,
 * and the island and Skylark lines were scaled off their ballast instead, so
 * the same railway changed width — and on the airport island colour — the
 * moment it crossed the water. A running line is a running line; a siding is
 * a step thinner.
 */
const RAIL_LINE_PX = 6;
const RAIL_BRANCH_PX = 4.5;
const RAIL_YARD_PX = 3.5;

/** Roads as the city draws them: dark casing, pale surface, round ends. */
function strokeStreets(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  width: number,
  tone: string = STREET_TONE,
  casing = true,
  /**
   * Square-cut by default: junctions are filled by short stubs exactly a road
   * wide, and a round cap on each pushed a knob out past both kerbs.
   */
  cap: CanvasLineCap = 'butt',
) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = cap;
  const passes = casing ? [[STREET_CASING, width + 3], [tone, width]] as const : [[tone, width]] as const;
  for (const [colour, w] of passes) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = w;
    for (const path of paths) {
      ctx.beginPath();
      path.forEach(([x, z], i) => {
        const px = toPixelX(nav, x);
        const pz = toPixelZ(nav, z);
        if (i === 0) ctx.moveTo(px, pz);
        else ctx.lineTo(px, pz);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}

function fillOutline(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  outline: ReadonlyArray<readonly [number, number]>,
  colour: string,
) {
  ctx.beginPath();
  outline.forEach(([x, z], i) => {
    const px = toPixelX(nav, x);
    const pz = toPixelZ(nav, z);
    if (i === 0) ctx.moveTo(px, pz);
    else ctx.lineTo(px, pz);
  });
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

function paintIslands(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!TRAIN_LINE_ENABLED) return;
  for (const island of TRAIN_ISLANDS) {
    // One fill and no ring. The beach had one, and so did the revetment that
    // replaced it; the wall is vertical and the outline IS the coast, so the
    // island on the map is the island. Same as `paintAirport` below, which has
    // drawn its own wall this way since it was written.
    fillOutline(ctx, nav, island.outline, ISLAND_LAND);
  }
  paintCruiseQuay(ctx, nav);
  paintKestrelGround(ctx, nav);
  paintKestrelWater(ctx, nav);
  paintKestrelStreets(ctx, nav);
  paintKestrelBuildings(ctx, nav);
  paintAirport(ctx, nav);
  paintCountry(ctx, nav);
}

/**
 * Skylark's fields, at map scale.
 *
 * Muted rather than the crop's own colours: the map is dark and its land is
 * near-black, so a wheat field at full gold would be the brightest thing on
 * the whole map. Each tone is the island's green nudged toward what is grown
 * there — just enough that, zoomed in, the parish reads as a patchwork and
 * not as one blob, which is the one thing that distinguishes farmland from
 * the other islands at a glance. Rough grazing and the marsh round the lake
 * take the island's own tone and are not drawn.
 */
const CROP_TONES: Record<Crop, string | null> = {
  pasture: 'rgb(29,47,30)',
  meadow: 'rgb(35,52,29)',
  wheat: 'rgb(56,51,30)',
  barley: 'rgb(52,49,32)',
  rape: 'rgb(60,58,26)',
  maize: 'rgb(31,45,27)',
  plough: 'rgb(48,38,28)',
  stubble: 'rgb(54,50,35)',
  roots: 'rgb(31,47,31)',
  wildflower: 'rgb(40,49,31)',
  downs: 'rgb(37,53,35)',
  rough: null,
  wood: 'rgb(18,32,20)',
  water: null,
};
const WATER_TONE = 'rgb(24,50,68)';

/**
 * Skylark, drawn from `countryConfig` and `countryFields` — the same outline
 * the crown is a polar grid over, the same field polygons the painter fills,
 * the same lane samples the lofts are swept along.
 *
 * Painted in the order the ground is built: the bridge under the coast it
 * lands on, the land, the fields, the wood and the water on it, then the
 * lanes with their casings, then what stands beside them.
 */
function paintCountry(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!COUNTRY_ENABLED) return;
  const world = (p: readonly [number, number]) => countryWorld(p[0], p[1]);
  const disc = (x: number, z: number, r: number): Array<[number, number]> => Array.from(
    { length: 20 },
    (_, i) => {
      const t = (i / 20) * Math.PI * 2;
      return world([x + r * Math.cos(t), z + r * Math.sin(t)]);
    },
  );

  // The road bridges, white like every road — see `strokeStreets`. Under the
  // land here, and laid again without a casing once the lanes are down, so a
  // lane's dark edge never cuts the joint where it meets the deck.
  const bridgeRuns = COUNTRY_ROAD_BRIDGES.map((B) => ({
    path: [B.start, B.end] as Array<readonly [number, number]>,
    width: ((B.halfWidth - 0.7) * 2) / nav.metresPerPixel,
  }));
  for (const b of bridgeRuns) strokeStreets(ctx, nav, [b.path], b.width, STREET_TONE, true, 'butt');
  fillOutline(ctx, nav, COUNTRY_OUTLINE, ISLAND_LAND);
  for (const field of COUNTRY_FIELDS) {
    const tone = CROP_TONES[field.crop];
    if (tone) fillOutline(ctx, nav, field.polygon.map(world), tone);
  }
  fillOutline(ctx, nav, WOOD_OUTLINE.map(world), CROP_TONES.wood!);
  fillOutline(ctx, nav, LAKE_OUTLINE.map(world), WATER_TONE);
  for (const pond of PONDS) fillOutline(ctx, nav, disc(pond.x, pond.z, pond.r), WATER_TONE);

  const paths: Array<Array<[number, number]>> = LANES.map((road) => road.samples
    .filter((_, i, all) => i % 3 === 0 || i === all.length - 1)
    .map((sample) => world([sample.x, sample.z])));
  const stub = LANE_WIDTH / 2;
  for (const j of Object.values(COUNTRY_JUNCTIONS)) {
    for (const arm of ['px', 'nz'] as const) {
      const [dx, dz] = armDirection(j, arm);
      paths.push([world([j.x - dx * stub, j.z - dz * stub]), world([j.x + dx * stub, j.z + dz * stub])]);
    }
  }
  // A plain stroke, not `strokeRoute`: that helper hatches whatever it draws
  // with sleepers, which is right for the railway it was written for and
  // turned every lane here into a branch line.
  const metres = (m: number) => m / nav.metresPerPixel;
  const plain = (path: Array<[number, number]>, colour: string, width: number, closed = false) => {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    path.forEach(([x, z], i) => {
      const px = toPixelX(nav, x);
      const pz = toPixelZ(nav, z);
      if (i === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    });
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };
  strokeStreets(ctx, nav, paths, metres(LANE_WIDTH));
  for (const b of bridgeRuns) strokeStreets(ctx, nav, [b.path], b.width, STREET_TONE, false, 'butt');

  // The single-tracks, thinner: tarmac in the paving tone, gravel sandier.
  // Then the brook, the strand and the pier, the way each is on the ground.
  for (const road of MINI_ROADS) {
    const path = road.samples
      .filter((_, i, all) => i % 3 === 0 || i === all.length - 1)
      .map((sample) => world([sample.x, sample.z]));
    strokeStreets(ctx, nav, [road.closed ? [...path, path[0]] : path], metres(road.width + 1.2), LANE_TONE);
  }
  plain(STREAM.filter((_, i) => i % 2 === 0).map((sm) => world([sm.x, sm.z])), WATER_TONE, metres(3.5));
  {
    const strand: Array<[number, number]> = [];
    for (let k = 0; k <= 12; k++) {
      const t = BEACH.theta - BEACH.halfAngle + ((BEACH.halfAngle * 2) * k) / 12;
      strand.push(world(coastPoint(t, -4)));
    }
    for (let k = 12; k >= 0; k--) {
      const t = BEACH.theta - BEACH.halfAngle + ((BEACH.halfAngle * 2) * k) / 12;
      strand.push(world(coastPoint(t, BEACH.strand)));
    }
    fillOutline(ctx, nav, strand, 'rgb(118,108,82)');
  }
  fillOutline(ctx, nav, disc(HARBOUR.x, HARBOUR.z, HARBOUR.r - 12), PAVED_TONE);
  plain(PIER.pts.map(world), PAVED_TONE, metres(PIER.width));
  for (const ring of CASTLE_HILL.ramparts) {
    plain(disc(CASTLE_HILL.x, CASTLE_HILL.z, ring.r), 'rgb(96,102,84)', metres(4), true);
  }
  {
    const box = (r: { x: number; z: number; w: number; d: number; turn: number }, tone: string) => {
      const c = Math.cos(r.turn);
      const s = Math.sin(r.turn);
      const corner = (u: number, v: number) => world([r.x + u * c + v * s, r.z - u * s + v * c]);
      fillOutline(ctx, nav, [
        corner(-r.w / 2, -r.d / 2), corner(r.w / 2, -r.d / 2), corner(r.w / 2, r.d / 2), corner(-r.w / 2, r.d / 2),
      ], tone);
    };
    box(CAMPSITE, 'rgb(42,60,36)');
    box(VINEYARD, 'rgb(54,58,38)');
  }
  fillOutline(ctx, nav, disc(CHAPEL.x, CHAPEL.z, 5), BUILDING_TONE);
  fillOutline(ctx, nav, disc(WATERMILL.x, WATERMILL.z, 4), BUILDING_TONE);

  // The Skylark line, in the main line's own hatching — `strokeRoute` is
  // the one place that hatching is right — with a bar for each station,
  // squared to the line, in the platforms' tone.
  strokeRoute(ctx, nav, RAIL.filter((_, i) => i % 3 === 0).map((sm) => world([sm.x, sm.z])), TRAIN_COLOUR, RAIL_LINE_PX, false);
  for (const station of RAIL_STATIONS) {
    const p = railAt((station.from + station.to) / 2);
    const half = (station.to - station.from) / 2;
    fillOutline(ctx, nav, [
      world([p.x + p.tx * half + p.nx * 9, p.z + p.tz * half + p.nz * 9]),
      world([p.x - p.tx * half + p.nx * 9, p.z - p.tz * half + p.nz * 9]),
      world([p.x - p.tx * half - p.nx * 9, p.z - p.tz * half - p.nz * 9]),
      world([p.x + p.tx * half - p.nx * 9, p.z + p.tz * half - p.nz * 9]),
    ], PLATFORM_FILL);
  }
  // Skylark station's forecourt behind the built platform, and its ticket hall.
  {
    const F = SKYLARK_FORECOURT;
    const box = (s0: number, s1: number, c0: number, c1: number, colour: string) => fillOutline(ctx, nav, [
      world(skylarkPoint(s0, c0)), world(skylarkPoint(s1, c0)), world(skylarkPoint(s1, c1)), world(skylarkPoint(s0, c1)),
    ], colour);
    box(F.from, F.to, F.near, F.far, PAVED_TONE);
    box(15, 29, 7.6, 12.7, BUILDING_TONE);
  }
  fillOutline(ctx, nav, disc(PIER.pts[PIER.pts.length - 1][0], PIER.pts[PIER.pts.length - 1][1], 2.5), AIRCRAFT_TONE);

  // The yards and the car park in paving, the buildings that matter at this
  // scale in the buildings' tone, and the things that stand up — the mill,
  // the lighthouse, the four turbines — near-white, the way the aeroplanes
  // are, because they are what you would steer by.
  for (const farm of [HOME_FARM, HILL_FARM]) fillOutline(ctx, nav, disc(farm.x, farm.z, farm.r - 12), PAVED_TONE);
  fillOutline(ctx, nav, disc(VIEWPOINT.x, VIEWPOINT.z, VIEWPOINT.r - 4), PAVED_TONE);
  fillOutline(ctx, nav, disc(CHURCH.x, CHURCH.z, 9), BUILDING_TONE);
  fillOutline(ctx, nav, disc(BOATHOUSE.x, BOATHOUSE.z, 5), BUILDING_TONE);
  fillOutline(ctx, nav, disc(MILL.x, MILL.z, 4.5), AIRCRAFT_TONE);
  fillOutline(ctx, nav, disc(LIGHTHOUSE.x, LIGHTHOUSE.z, 4), AIRCRAFT_TONE);
  for (const t of TURBINES) fillOutline(ctx, nav, disc(t.x, t.z, 3), AIRCRAFT_TONE);
}

/**
 * Kestrel's street grid.
 *
 * Drawn from the same table the world is built from (`kestrelRoads`) rather
 * than from a raster, for the reason the town's streets were: the island is
 * assembled at runtime and `prepare-map.mjs` has never heard of it, so anything
 * out here that is not drawn here is simply not on the map. Two strokes per
 * road — a casing and the carriageway — which is what lifts a street off the
 * grass the way the mainland's do.
 *
 * The junctions are stroked as one-tile stubs rather than filled as squares: a
 * `junctionX` is 19 m across and so is the road through it, so a stub of road
 * in each of its arms IS the junction as far as a map at this scale cares. The
 * west crescent is no junction and no kit piece at all, so it is sampled off
 * its own ellipse — the same one the world is swept along.
 */
function paintKestrelStreets(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!STATION_ENABLED || !STATION_SITE) return;
  const at = (across: number, along: number): [number, number] => {
    const [x, , z] = stationPoint(along, across);
    return [x, z];
  };
  const paths: Array<Array<[number, number]>> = KESTREL_RUNS.map(
    (run) => [at(run.from[0], run.from[1]), at(run.to[0], run.to[1])],
  );
  // The crescent, as the ellipse it is. Sampled rather than derived from a kit
  // piece, because it is not a kit piece: `KestrelRoads` sweeps a road surface
  // along this same curve, and this reads the same table it does.
  // And the shore road's S-bends, from the same points `KestrelRoads` sweeps.
  for (const sweep of KESTREL_SWEEPS) {
    paths.push(sweepPoints(sweep, 8).map(([across, along]) => at(across, along)));
  }
  for (const arc of KESTREL_ARCS) {
    const [cx, cz] = arc.centre;
    const [ra, rb] = arc.radius;
    const line: Array<[number, number]> = [];
    for (let k = 0; k <= 48; k++) {
      const t = Math.PI * (1 - k / 48);
      line.push(at(cx + ra * Math.cos(t), cz - rb * Math.sin(t)));
    }
    paths.push(line);
  }
  const stub = ROAD_WIDTH / 2;
  for (const node of KESTREL_NODES) {
    // Every other junction as a short cross, so corners and T-bars close up.
    paths.push([at(node.across - stub, node.along), at(node.across + stub, node.along)]);
    paths.push([at(node.across, node.along - stub), at(node.across, node.along + stub)]);
  }
  // Streets, not railway: these went through `strokeRoute`, which hatched
  // every street on Kestrel with sleepers.
  strokeStreets(ctx, nav, paths, ROAD_WIDTH / nav.metresPerPixel);
}

/** Kestrel's sand: warm, and lighter than any field, so the beach reads as a beach. */
const SAND_TONE = 'rgb(150,134,100)';
/** Kept grass — the park and the school lawn — a step brighter than the island's rough. */
const LAWN_TONE = 'rgb(34,58,33)';

/** A rectangle in the station's frame, kerb lines and all, filled. */
function frameBox(
  ctx: CanvasRenderingContext2D, nav: NavRaster,
  b: { acrossFrom: number; acrossTo: number; alongFrom: number; alongTo: number }, colour: string,
) {
  fillOutline(ctx, nav, [
    stationXZ(b.alongFrom, b.acrossFrom), stationXZ(b.alongFrom, b.acrossTo),
    stationXZ(b.alongTo, b.acrossTo), stationXZ(b.alongTo, b.acrossFrom),
  ], colour);
}

/**
 * Kestrel's ground, as it is built: the beach, the paved civic blocks, the car
 * parks, the school's yards and the park's grass — each from the same config
 * its 3D component lays, so the map moves when the island does.
 *
 * Under the streets: every one of these stops at a kerb, and the street is
 * drawn over the join.
 */
function paintKestrelGround(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!STATION_SITE) return;

  // The beach: from its top edge on the crown out to the waterline, which is
  // `out` past the old shore — further than the island's own outline goes.
  if (KESTREL_BEACH_ENABLED && KESTREL_BEACH) {
    const cols = KESTREL_BEACH.columns;
    const top = cols.map((c) => { const [x, , z] = beachPoint(c, 0); return [x, z] as [number, number]; });
    const sea = cols.map((c) => { const [x, , z] = beachPoint(c, c.depth + c.out); return [x, z] as [number, number]; });
    fillOutline(ctx, nav, [...top, ...sea.reverse()], SAND_TONE);
  }

  // The park, and the pond in it (`paintKestrelWater` cuts the hole).
  if (KESTREL_PARK_ENABLED) frameBox(ctx, nav, PARK_BLOCK, LAWN_TONE);

  // The civic blocks, paved kerb to kerb — see `KestrelPlazas`. A corner on a
  // swept bend follows the bend.
  if (CIVIC_ENABLED && HALLS_ENABLED) {
    for (const b of [CIVIC_BLOCK, SPORTS_BLOCK, ASSEMBLY_BLOCK]) {
      const outline: Array<[number, number]> = [[b.acrossFrom, b.alongFrom], [b.acrossTo, b.alongFrom]];
      const cut = blockCut(b);
      if (cut) {
        for (let k = 0; k <= 16; k++) {
          const t = (k / 16) * (Math.PI / 2);
          outline.push([cut.across + Math.cos(t) * cut.radius, cut.along + Math.sin(t) * cut.radius]);
        }
      } else {
        outline.push([b.acrossTo, b.alongTo]);
      }
      outline.push([b.acrossFrom, b.alongTo]);
      fillOutline(ctx, nav, outline.map(([across, along]) => stationXZ(along, across)), PAVED_TONE);
    }
  }

  // The car parks. A lot with a curved edge is sampled down that edge.
  if (PARKING_ENABLED) {
    for (const lot of PARKING_LOTS) {
      if (!lot.edge) { frameBox(ctx, nav, lot, PAVED_TONE); continue; }
      const edge: Array<[number, number]> = [];
      for (let k = 0; k <= 16; k++) {
        const along = lot.alongFrom + ((lot.alongTo - lot.alongFrom) * k) / 16;
        edge.push(stationXZ(along, lot.edge(along)));
      }
      fillOutline(ctx, nav, [
        ...edge, stationXZ(lot.alongTo, lot.acrossTo), stationXZ(lot.alongFrom, lot.acrossTo),
      ], PAVED_TONE);
    }
  }

  // The school: lawn behind, then the yards and the plaza on the avenue.
  if (SCHOOL_ENABLED && SCHOOL_GROUNDS) {
    const G = SCHOOL_GROUNDS;
    frameBox(ctx, nav, G.lawn, LAWN_TONE);
    for (const zone of [G.zones.park, G.zones.bus]) {
      frameBox(ctx, nav, {
        acrossFrom: G.plaza.acrossFrom, acrossTo: G.bands.yardTo, alongFrom: zone.from, alongTo: zone.to,
      }, PAVED_TONE);
    }
    frameBox(ctx, nav, G.plaza, PAVED_TONE);
    frameBox(ctx, nav, G.link, PAVED_TONE);
  }

  // The station's forecourt: from the shore road's kerb up to the hall's
  // front, the hall's length and five metres either end — `IslandStation`.
  {
    const depth = KESTREL_HALL.size[2];
    const centreAcross = KESTREL_HALL_FRONT - depth / 2;
    const half = KESTREL_HALL.size[0] / 2 + 5;
    frameBox(ctx, nav, {
      acrossFrom: KESTREL_SHORE_KERB, acrossTo: centreAcross - depth / 2, alongFrom: -half, alongTo: half,
    }, PAVED_TONE);
  }
}

/**
 * The station hall's place, which `IslandStation` keeps to itself: its back
 * three metres behind the up platform — the relief loop, less the platform's
 * setback and width — and the shore road's kerb in front of it.
 */
const KESTREL_HALL = kestrelStationData;
const KESTREL_HALL_FRONT = UP_LOOP - 1.7 - 9 - 3;
const KESTREL_SHORE_KERB = -72 + 9.4;

/**
 * What stands on Kestrel: the hall of justice, the mall, the sports and
 * assembly halls and their shops, the school and its workshop, the station
 * hall, the beach stage and the food courts. Footprints as their configs fit
 * them — already turned into the station frame, so drawn square to it.
 */
function paintKestrelBuildings(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!STATION_SITE) return;
  const site = (s: { across: number; along: number; footprint: readonly number[] } | null) => {
    if (!s) return;
    frameRect(ctx, nav, s.across, s.along, s.footprint[0], s.footprint[1], 0);
    ctx.fillStyle = BUILDING_TONE;
    ctx.fill();
  };
  if (CIVIC_ENABLED) site(CIVIC_SITE);
  if (MALL_ENABLED) site(MALL_SITE);
  if (HALLS_ENABLED) {
    site(SPORTS_SITE);
    site(ASSEMBLY_SITE);
    for (const shop of SHOP_SITES) site(shop);
  }
  if (SCHOOL_ENABLED && SCHOOL_SITE) {
    const S = SCHOOL_SITE;
    frameBox(ctx, nav, { acrossFrom: S.front, acrossTo: S.back, alongFrom: S.alongFrom, alongTo: S.alongTo }, BUILDING_TONE);
    if (SCHOOL_GROUNDS?.workshop) site(SCHOOL_GROUNDS.workshop);
  }
  // The station hall: its length along the line, its depth across.
  {
    const depth = KESTREL_HALL.size[2];
    frameRect(ctx, nav, KESTREL_HALL_FRONT - depth / 2, 0, depth, KESTREL_HALL.size[0], 0);
    ctx.fillStyle = BUILDING_TONE;
    ctx.fill();
  }
  // On the beach: the stage, and the food courts' decks.
  if (KESTREL_BEACH_ENABLED) {
    if (BEACH_STAGE) {
      mapRect(ctx, nav, BEACH_STAGE.x, BEACH_STAGE.z, BEACH_STAGE.halfU * 2, BEACH_STAGE.halfV * 2, BEACH_STAGE.heading);
      ctx.fillStyle = BUILDING_TONE;
      ctx.fill();
    }
    for (const f of FOOD_COURT_SITES) {
      mapRect(ctx, nav, f.x, f.z, f.halfU * 2, f.halfV * 2, f.heading);
      ctx.fillStyle = PARK_PAVED_TONE;
      ctx.fill();
    }
  }
}

/**
 * Kestrel Water, in the middle of the grid.
 *
 * Drawn from `POND_HOLE`, which is the same outline the crown is cut round and
 * the basin is built to — so the map cannot disagree with the ground about
 * where the water is. `WATER_TONE`, the tone Skylark's lake already has: two
 * ponds on two islands are two ponds, and painting this one its own colour
 * would say otherwise.
 *
 * Under the streets rather than over them, because the streets are the thing
 * being navigated by and nothing here should be able to cover one.
 */
function paintKestrelWater(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!POND_HOLE) return;
  fillOutline(ctx, nav, POND_HOLE, WATER_TONE);
}

/**
 * The cruise berth's reclamation, on Kestrel's north shore.
 *
 * Drawn because it is not part of the island: the quay is a straight face laid
 * *outside* the outline with the wedge behind it filled (`CRUISE_BERTH`), so a
 * map that stops at the outline puts a 191 m ship in open water 20 m off the
 * coast. Its own tone rather than the island's, for the same reason the
 * airport's paving gets one — it is concrete, and the island is not.
 */
function paintCruiseQuay(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  const berth = CRUISE_BERTH;
  if (!berth) return;
  const outline: Array<readonly [number, number]> = [];
  // Out along the straight face, then back along the measured shore.
  for (let i = 0; i < berth.shore.length; i++) {
    const [x, , z] = stationPoint(berth.from + i * CRUISE.step, berth.face);
    outline.push([x, z]);
  }
  for (let i = berth.shore.length - 1; i >= 0; i--) {
    const [x, , z] = stationPoint(berth.from + i * CRUISE.step, berth.shore[i]);
    outline.push([x, z]);
  }
  // `PAVED_TONE`, not `QUAY_TONE`: that one is the village's timber jetty and
  // is a plank colour. This is a concrete reclamation, and the map already has
  // a word for a paved surface.
  fillOutline(ctx, nav, outline, PAVED_TONE);
}

/**
 * Halcyon Field, out west.
 *
 * Drawn from the very numbers `AirportIsland` builds from — the same outline
 * its crown is a fan over, the same `PAVING` rectangles, the same `BUILDINGS`
 * placed at the same measured sizes — so the airfield on the map is the
 * airfield in the world by construction and cannot drift from it.
 *
 * It used to be the island and one dark bar for the runway, which was the
 * whole of the airport when the airport was a runway. The island has kept
 * growing and the map has kept not growing with it — it was seventeen paved
 * rectangles, fifteen buildings and two helipads behind, and by the end the
 * map was missing a freight terminal with five roads and a running shed, a
 * container yard, a parade of twenty-one landside buildings, a multi-storey,
 * every road on the island, and 2.7 km of perimeter wall. A map that shows
 * none of that is a map of the wrong place.
 *
 * Painted in the order the ground is built: the bridge, then land, then every
 * paved surface and the yard's hardstanding, then the roads, then the runway
 * and taxiway over the top because they are the darker tarmac, then the
 * freight roads, then what stands on all of it — and the perimeter wall last
 * of all, because a boundary with something painted over it is not one.
 */
function paintAirport(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!AIRPORT_ENABLED) return;
  const centre = AIRPORT_SITE.centre;
  // No sand ring: this island has a wall, not a beach, so the land goes right
  // to the line the wall stands on.
  fillOutline(ctx, nav, airportOutline(), ISLAND_LAND);

  const c = Math.cos(AIRPORT_SITE.heading);
  const sn = Math.sin(AIRPORT_SITE.heading);
  /** The island's own frame to world XZ — the mapping `AirportIsland` draws in. */
  const world = (x: number, z: number) => [
    centre[0] + x * c + z * sn,
    centre[1] - x * sn + z * c,
  ] as const;
  const metres = (m: number) => m / nav.metresPerPixel;
  /** The same mapping as a mutable pair, which is what the stroke helpers take. */
  const line = (x: number, z: number): [number, number] => {
    const [wx, wz] = world(x, z);
    return [wx, wz];
  };
  /**
   * A plain polyline — NOT `strokeRoute`.
   *
   * `strokeRoute` is the railway helper: it lays a solid line and then hatches
   * dark dashes along it for sleepers. That is exactly right for the freight
   * roads below and exactly wrong for everything else, and using it for the
   * perimeter wall drew the island a second railway round its own coast.
   */
  const stroke = (path: Array<[number, number]>, colour: string, width: number) => {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    path.forEach(([x, z], i) => {
      const px = toPixelX(nav, x);
      const pz = toPixelZ(nav, z);
      if (i === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    });
    ctx.stroke();
    ctx.restore();
  };
  /** One island-frame rectangle, `[fromX, toX, fromZ, toZ]`. */
  const slab = (r: readonly [number, number, number, number], colour: string) => fillOutline(
    ctx, nav, [world(r[0], r[2]), world(r[1], r[2]), world(r[1], r[3]), world(r[0], r[3])], colour,
  );
  /** A footprint about (x, z), turned — the same box the collider gets. */
  const box = (
    x: number, z: number, turn: number, size: readonly number[], colour: string,
  ) => {
    const turned = Math.abs(Math.cos(turn)) < 0.5;
    const w = (turned ? size[2] : size[0]) / 2;
    const d = (turned ? size[0] : size[2]) / 2;
    slab([x - w, x + w, z - d, z + d], colour);
  };

  // The bridge first, so the island's own paving lands on top of it where the
  // two overlap — the deck runs 100 m inland and the outer road is drawn over
  // that stretch, which is what the joint looks like on the ground.
  //
  // Along the deck's real centreline — straight, then the arc onto the outer
  // road at the cargo junction (`crossingCurve`). A straight bar to the aim
  // point stopped in the grass short of the road the bridge actually joins.
  const crossing = (() => {
    const { run, centreAt } = crossingCurve();
    const path: Array<[number, number]> = [];
    for (let k = 0; k <= 48; k++) {
      const [x, z] = centreAt((run * k) / 48);
      path.push([x, z]);
    }
    return path;
  })();
  const crossingWidth = metres(CROSSING.curve.roadHalf * 2);
  strokeStreets(ctx, nav, [crossing], crossingWidth, STREET_TONE, true, 'butt');

  // Every paved surface, in the lighter of the two built tones. Enumerated
  // rather than listed, so a rectangle added to `PAVING` reaches the map the
  // same day it reaches the ground.
  for (const rect of Object.values(AIRPORT_PAVING)) slab(rect, PAVED_TONE);
  // Halcyon East's hardstanding, which is most of the freight terminal's area:
  // a railhead is a strip of ballast beside a slab of concrete, and the slab
  // is the part you can see from above.
  for (const key of ['hardstanding', 'headland', 'lorryPark', 'siloRoad', 'northTip'] as const) {
    slab(YARD[key], PAVED_TONE);
  }

  /*
   * The island's roads, laid the way `IslandRoads` lays them.
   *
   * Two passes, the same as Kestrel's: a verge three metres wider in the
   * land's own tone, then the carriageway. That is what gives a road an edge
   * where it crosses grass — one stroke on grass is a grey worm, and the
   * airfield's roads are the only thing joining the bridge to the terminal.
   *
   * The junctions get a short cross each so a T-bar closes up rather than
   * leaving a notch where three runs meet at a point.
   */
  {
    const paths: Array<Array<[number, number]>> = ROAD_RUNS.map(
      (run) => [line(run.from[0], run.from[1]), line(run.to[0], run.to[1])],
    );
    // The harbour road, over the trunk and along the coast to the turning circle.
    paths.push(HARBOUR_ROAD.filter((_, i) => i % 4 === 0).map((q) => line(q.x, q.z)));
    const stub = ROAD_WIDTH / 2;
    for (const node of ROAD_NODES) {
      paths.push([line(node.x - stub, node.z), line(node.x + stub, node.z)]);
      paths.push([line(node.x, node.z - stub), line(node.x, node.z + stub)]);
    }
    strokeStreets(ctx, nav, paths, metres(ROAD_WIDTH));
    strokeStreets(ctx, nav, [crossing], crossingWidth, STREET_TONE, false, 'butt');
  }

  // The harbour's quay and container terminal, a paved slab out into the sea.
  slab([QUAY.x0, QUAY.x1, QUAY.z0, QUAY.face], PAVED_TONE);

  // The station car park and the petrol station at its west end: one lot, from
  // the harbour road to the car park's far end, the railway fence its north edge.
  {
    const P = STATION_FORECOURT.park;
    slab([P.from, P.northTo, P.bottom, P.top], PAVED_TONE);
    slab([P.northTo, P.southTo, P.bottom, P.clearOfBuilding], PAVED_TONE);
    const edge: Array<readonly [number, number]> = [];
    for (let x = PETROL_PAVING.x0; x <= PETROL_PAVING.x1; x += 4) edge.push(world(x, pavingTop(Math.min(x, PETROL_PAVING.x1)) - 0.4));
    fillOutline(ctx, nav, [
      world(PETROL_PAVING.x0, PETROL_PAVING.z0), world(PETROL_PAVING.x1, PETROL_PAVING.z0),
      ...edge.reverse(),
    ], PAVED_TONE);
    // The canopy, light, and the shop and car wash under it, dark — in the
    // station's own frame turned a quarter (`PETROL_SITE`): model z runs along x.
    const S = PETROL_SITE;
    slab([S.x - 30.9, S.x - 0.7, S.z - 24.1, S.z + 15.8], WALL_TONE);
    slab([S.x + 3.6 - 7, S.x + 3.6 + 7, S.z - 23.8, S.z + 23.8], BUILDING_TONE);
  }

  // Halcyon Heliport: its forecourt in paving, the tower in the buildings'
  // tone, and the roof deck on it in the runway's — see `heliportConfig`.
  {
    const F = HELI_FORECOURT;
    const T = HELI_TOWER;
    slab([F.alongFrom, F.alongTo, F.acrossFrom, F.acrossTo], PAVED_TONE);
    slab([T.along - T.w / 2, T.along + T.w / 2, T.across - T.d / 2, T.across + T.d / 2], BUILDING_TONE);
    const dx = T.along + HELI_DECK.along;
    const h = HELI_DECK.size / 2;
    slab([dx - h, dx + h, T.across - h, T.across + h], RUNWAY_TONE);
  }

  // Runway and taxiway over the top: darker, because they are darker, and
  // because at map scale the shape of an airfield IS its two long strips.
  const R = AIRPORT_RUNWAY;
  const T = AIRPORT_TAXIWAY;
  slab([-R.half, R.half, R.centre - R.width / 2, R.centre + R.width / 2], RUNWAY_TONE);
  slab([-T.half, T.half, T.centre - T.width / 2, T.centre + T.width / 2], RUNWAY_TONE);
  for (const at of T.links) {
    slab([at - T.width / 2, at + T.width / 2, R.centre + R.width / 2, T.centre - T.width / 2],
      RUNWAY_TONE);
  }

  /*
   * Halcyon East's five freight roads — see `SIDINGS`.
   *
   * From `sidingCentre`, which is the table `AirportIsland` lofts its ballast
   * and rails along, so the throat on the map eases onto the mains exactly
   * where the throat on the ground does. Drawn at the ballast's full width
   * rather than the rails': at this scale a pair of rails is a hairline, and
   * what you actually see of a siding from above is its ballast.
   */
  {
    for (const road of SIDINGS.roads) {
      strokeRoute(ctx, nav, sidingCentre(road, 6).map(([x, z]) => line(x, z)),
        TRAIN_COLOUR, RAIL_YARD_PX, false);
    }
  }

  /*
   * The island line, drawn from the same tables `IslandRail` lofts.
   *
   * Wider than the sidings because it is a running line on a running line's
   * section — 0.62 m of ballast where the yard has 0.4 — and wider again down
   * the trunk, which is double track standing on one 9.2 m formation.
   *
   * Every third sample: the config lays them two metres apart for a loft, and
   * at map scale that is a dozen points to the pixel.
   */
  {
    const single = RAIL_BRANCH_PX;
    const pair = RAIL_LINE_PX;
    // The trunk is drawn once at the pair's width rather than twice at a
    // road's: at map scale the six-foot between two roads 4.6 m apart is a
    // third of a pixel, and two strokes that close is one stroke with a seam.
    for (const [track, width] of [
      [trunkCentre(), pair], [connectionSamples(), single], [downLinkSamples(), single],
      [stationLoop('down'), single], [stationLoop('up'), single],
    ] as Array<[ReturnType<typeof trunkCentre>, number]>) {
      strokeRoute(ctx, nav, track.filter((_, i) => i % 3 === 0).map((q) => line(q.x, q.z)),
        TRAIN_COLOUR, width, false);
    }
  }

  // What stands on it. Sizes come from the model data, so a building on the
  // map is the size of the building in the world.
  const sizeOf = (part: string) => (
    airportModels.parts as Record<string, { size: number[] }>
  )[part]?.size ?? [10, 10, 10];
  for (const b of AIRPORT_BUILDINGS) box(b.x, b.z, b.turn, sizeOf(b.part), BUILDING_TONE);
  /*
   * Halcyon Parade and the landside blocks.
   *
   * Twenty-one buildings out of `parade.glb` and a handful of city chunks,
   * which between them are the whole of the island's landside — and the map
   * had none of them, so the strip between the car park and the sea read as
   * empty ground when it is the busiest part of the island on foot.
   *
   * Two model tables because they come from two pipelines. A part with no
   * measured size is skipped rather than guessed: `deco_Obstacles` and the
   * billboards are street furniture, and street furniture on a map is noise.
   */
  const paradeSize = (part: string) => (
    paradeModels.parts as Record<string, { size: number[] }>
  )[part]?.size;
  for (const b of PARADE_BUILDINGS) {
    const size = paradeSize(b.part);
    if (size) box(b.x, b.z, b.turn, size, BUILDING_TONE);
  }
  for (const b of [...CORNER_BLOCKS, ...AIRPORT_DECO.filter((d) => d.solid)]) {
    const foot = CHUNK_FOOTPRINT[b.part];
    if (foot) box(b.x, b.z, b.turn, [foot[0], 0, foot[1]], BUILDING_TONE);
  }
  // The multi-storey, which is a landmark rather than a shed: it is the one
  // thing on the landside you can see from the far end of the runway.
  box(CAR_PARK_DECK.along, CAR_PARK_DECK.across, 0,
    [CAR_PARK_DECK.length, 0, CAR_PARK_DECK.depth], BUILDING_TONE);
  // The running shed over roads 476 and 488, and the bulk silos beside the
  // cargo road. Both are drawn from the spans they are built to, not from a
  // model — neither is a model.
  slab([DEPOT.roads[0] - DEPOT.margin, DEPOT.roads[1] + DEPOT.margin, DEPOT.from, DEPOT.to],
    BUILDING_TONE);
  for (const across of SILOS.at) {
    slab([SILOS.along - SILOS.radius, SILOS.along + SILOS.radius,
      across - SILOS.radius, across + SILOS.radius], BUILDING_TONE);
  }
  /*
   * The container bays, one block each rather than seventy-five boxes.
   *
   * A stack is 12.28 m by 2.8 and there are seventy-five of them; drawn
   * individually they are below a pixel each at any zoom you would read the
   * island at, and they cost seventy-five fills to say nothing. The bay's
   * footprint is the same rectangle the router treats as solid.
   */
  for (const bay of CONTAINERS.bays) {
    const long = bay.long * (CONTAINERS.box.long + CONTAINERS.gap.end) - CONTAINERS.gap.end;
    const wide = bay.rows * (CONTAINERS.box.wide + CONTAINERS.gap.side) - CONTAINERS.gap.side;
    // A turned bay swaps its extents, the same way `box` does for a building.
    const turned = Math.abs(Math.cos(bay.turn)) < 0.5;
    const dx = (turned ? wide : long);
    const dz = (turned ? long : wide);
    slab([bay.along, bay.along + dx, bay.across, bay.across + dz], CONTAINER_TONE);
  }
  // The parked aeroplanes, which at this scale are the clearest sign that the
  // strip is an airport and not a road.
  for (const a of AIRPORT_PARKED) box(a.x, a.z, a.turn, sizeOf(a.part), AIRCRAFT_TONE);
  // And the two pads, drawn at their deck size.
  for (const pad of HELIPADS) {
    slab([pad.x - HELIPAD.half, pad.x + HELIPAD.half, pad.z - HELIPAD.half, pad.z + HELIPAD.half],
      HELIPAD.colours.rim);
  }

  /*
   * Halcyon Pier, in the island's own frame like everything above it.
   *
   * The paths in the park's paler paving, then the rides on top in a tone of
   * their own — because on a map the thing that says *amusement park* rather
   * than *industrial estate* is a handful of large objects at odd angles, and
   * the coaster's 100 m turned across the site is the clearest of them.
   */
  for (const rect of PARK_SURFACES) slab(rect, PARK_PAVED_TONE);
  const rideSize = (part: string) => (
    parkModels.parts as Record<string, { size: number[] }>
  )[part]?.size ?? [10, 10, 10];
  for (const r of PARK_RIDES) box(r.along, r.across, r.turn, rideSize(r.part), RIDE_TONE);
  // The arcade, in the buildings' tone rather than the rides' — it is the one
  // thing in the park you go INTO rather than on.
  box(PARK_ARCADE.along, PARK_ARCADE.across, PARK_ARCADE.turn,
    rideSize(PARK_KIT.arcade), BUILDING_TONE);
  /*
   * The boundary, and the gap in it.
   *
   * Worth the four pixels it costs: rides scattered on open ground read as
   * plant on a yard, and one thin closed line round them reads as a park. The
   * break in it is the gate, and on a map a break in a boundary is the only
   * thing that says which way you get in.
   *
   * Drawn at the hedge's own depth, which at 1.8 m is about as thin as a map
   * line can be before it breaks up into dashes at the usual zooms.
   */
  const thick = PARK_HEDGE.halfDepth;
  for (const [x0, z0, x1, z1] of parkBoundaryRuns()) {
    slab([Math.min(x0, x1) - thick, Math.max(x0, x1) + thick,
      Math.min(z0, z1) - thick, Math.max(z0, z1) + thick], BUILDING_TONE);
  }

  /*
   * The perimeter wall, last, over everything it crosses.
   *
   * Last because it is a boundary and a boundary that something is painted on
   * top of stops being one: the landside run crosses the forecourt, the cargo
   * road and the freight terminal, and it has to read across all three.
   *
   * `perimeterRuns` already has the gaps cut out of it — four gates and the
   * terminal building, which stands on the line and IS the line where it does.
   * That matters more on the map than on the ground: a closed loop says you
   * cannot get airside, and you can, at exactly five places. A break in a
   * boundary is the only thing on a map that says which way you get in.
   */
  {
    // Drawn at four metres rather than its own 0.55, and floored at a pixel
    // and a half. A wall is thinner than a map line can be: at 0.55 m it is
    // sub-pixel at every zoom the island is legible at, and a sub-pixel line
    // running at 45 degrees — which this one does, because the island is
    // turned 72.8 — antialiases into a dotted one. The point of it is to be
    // continuous, so it is drawn continuous.
    const width = Math.max(1.5, metres(4));
    for (const run of perimeterRuns()) {
      stroke(run.map(([x, z]) => line(x, z)), WALL_TONE, width);
    }
    // The gate piers, so a gap reads as a gate rather than as a wall that has
    // fallen down. Two dots at the width of the run they interrupt.
    for (const g of PERIMETER.gates) {
      for (const side of [-1, 1]) {
        const at = g.at + side * (g.half + PERIMETER.pier.half);
        slab([at - PERIMETER.pier.half * 2, at + PERIMETER.pier.half * 2,
          PERIMETER.landsideAt - PERIMETER.pier.half * 2,
          PERIMETER.landsideAt + PERIMETER.pier.half * 2], WALL_TONE);
      }
    }
  }
}

/**
 * The station: its platforms, and the town's streets.
 *
 * The streets are not redrawn, they are *moved* — the same trick the world
 * uses. `IslandStation` draws a block of the city a second time under a
 * different matrix; this lifts the already-painted pixels of that same block
 * out of the map and stamps them down on the island under the matching
 * rotation, so the town on the map is the town in the world by construction and
 * cannot drift from it.
 *
 * Only the paved pixels travel. Copying the patch wholesale brought the city's
 * dark green ground with it and laid a hard-edged rectangle of it across the
 * island; masking to the two road tones leaves the streets, yards and car parks
 * standing on the island's own crown.
 */
function paintStation(
  ctx: CanvasRenderingContext2D, nav: NavRaster, painted: HTMLCanvasElement,
) {
  const site = STATION_SITE;
  if (!STATION_ENABLED || !site) return;

  // The transplanted city block, stamped on the island as a patch lifted out of
  // the painted mainland — the map's stand-in for `IslandStation`'s `Town`,
  // which the map cannot draw from geometry because it never loads the model.
  // It goes when the town does, or the island reads as clear in the world and
  // built-up on the map. The platforms below are drawn either way: they are the
  // station, not the town.
  if (TOWN_BUILT) {
    const { x: [x0, x1], z: [z0, z1] } = TOWN.footprint;
    // Source coordinates are read from the painted canvas, which has the raster
    // inset by the map's margin — so these are map pixels, not raster pixels. The
    // destination below is drawn through the caller's translate and so is not.
    const sx = Math.floor(mapX(nav, x0));
    const sz = Math.floor(mapZ(nav, z0));
    const sw = Math.ceil(mapX(nav, x1)) - sx;
    const sh = Math.ceil(mapZ(nav, z1)) - sz;
    if (sw > 0 && sh > 0) {
      const patch = document.createElement('canvas');
      patch.width = sw;
      patch.height = sh;
      const pctx = patch.getContext('2d');
      if (pctx) {
        pctx.drawImage(painted, sx, sz, sw, sh, 0, 0, sw, sh);
        // Mask to paving. `R` carries the two road levels — see `paintFullMap`.
        const image = pctx.getImageData(0, 0, sw, sh);
        const px = image.data;
        for (let i = 0; i < sw * sh; i++) {
          const o = i * 4;
          // Read the tone back, not the raster: this canvas has already been
          // painted, so a street is its pale colour rather than its source level.
          const pale = px[o] > 200 && px[o + 2] > 200;
          const dim = px[o] > 100 && px[o] < 160 && px[o + 2] > 130;
          if (!pale && !dim) px[o + 3] = 0;
        }
        pctx.putImageData(image, 0, 0);

        const across = -(MAIN_LINE_TOE + TOWN.nearGap + (z1 - z0) / 2);
        const [tx, , tz] = stationPoint(TOWN.along, across);
        // Map pixels run with world X and world Z, so a world rotation about Y
        // is a canvas rotation the other way round.
        ctx.save();
        ctx.translate(toPixelX(nav, tx), toPixelZ(nav, tz));
        ctx.rotate(-Math.atan2(-site.tangent[1], site.tangent[0]));
        ctx.drawImage(patch, -sw / 2, -sh / 2);
        ctx.restore();
      }
    }
  }

  // The platforms, as slabs the length of the platform face.
  for (const platform of PLATFORMS) {
    const half = STATION.platformLength / 2;
    fillOutline(ctx, nav, [
      stationXZ(-half, platform.from), stationXZ(half, platform.from),
      stationXZ(half, platform.to), stationXZ(-half, platform.to),
    ], PLATFORM_FILL);
  }
}

/**
 * The road bridge, and the link road it feeds on the island.
 *
 * Drawn in the street tone rather than a colour of its own: it is a road, the
 * map already has a language for roads, and the point of the bridge is that the
 * island stops being somewhere you can only look at. A casing under it lifts it
 * off the water the way the raster's own coastline does for the streets.
 */
function paintBridge(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!BRIDGE) return;
  const site = STATION_SITE;
  const width = (BRIDGE.halfWidth * 2) / nav.metresPerPixel;
  const x = toPixelX(nav, BRIDGE.x);
  ctx.save();
  ctx.lineCap = 'butt';
  // The deck.
  ctx.beginPath();
  ctx.moveTo(x, toPixelZ(nav, BRIDGE.cityZ));
  ctx.lineTo(x, toPixelZ(nav, BRIDGE.islandZ));
  ctx.strokeStyle = 'rgba(9,14,20,0.9)';
  ctx.lineWidth = width + 4;
  ctx.stroke();
  ctx.strokeStyle = 'rgb(226,232,240)';
  ctx.lineWidth = width;
  ctx.stroke();

  // The link road up to the town. Its far end is measured off the model at
  // load, which the map cannot do, so it is drawn to the block's stated depth —
  // the same figure `TOWN.footprint` carries and for the same reason.
  if (site) {
    const depth = TOWN.footprint.z[1] - TOWN.footprint.z[0];
    const [, , townZ] = stationPoint(TOWN.along, -(MAIN_LINE_TOE + TOWN.nearGap + depth / 2));
    ctx.beginPath();
    ctx.moveTo(x, toPixelZ(nav, BRIDGE.islandZ));
    ctx.lineTo(x, toPixelZ(nav, townZ + depth / 2));
    ctx.strokeStyle = 'rgb(226,232,240)';
    ctx.lineWidth = (ISLAND_LINK.halfWidth * 2) / nav.metresPerPixel;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The island town's streets.
 *
 * Drawn as vectors rather than read out of the raster, because they are not IN
 * the raster: the town is built at runtime from `townConfig` and the PNG only
 * knows `city.glb` (see `townNav`, which rasterises the same streets for the
 * traffic). Vectors also come out crisper at minimap zoom than 1.5 m pixels do.
 *
 * The two shore roads are drawn first and as ONE path with two subpaths. They
 * are the roads whose shape you have to be able to read at a glance — they are
 * how you get anywhere on the island — and stroking them segment by segment
 * would print each segment's dark casing over the last segment's carriageway,
 * which at minimap scale turns a road into a dotted line.
 *
 * The same two tones the raster gets: a dark casing under each street so it
 * lifts off the island, then the street tone, with the lanes a shade dimmer
 * than the through streets — which is what makes the ring legible as a route
 * rather than as a grid of identical lines.
 */
function paintTownStreets(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!TOWN_ENABLED || !STREETS.length) return;
  ctx.save();
  ctx.lineCap = 'butt';
  // The ring road first, and as one stroked path rather than 200 segments, so
  // its casing does not print over its own carriageway at every joint.
  if (RING_CHAINS.length) {
    const lap = new Path2D();
    for (const chain of RING_CHAINS) {
      chain.forEach((sample, i) => {
        const [x, z] = stationXZ(sample.along, sample.across);
        const px = toPixelX(nav, x);
        const pz = toPixelZ(nav, z);
        if (i === 0) lap.moveTo(px, pz);
        else lap.lineTo(px, pz);
      });
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(9,14,20,0.85)';
    ctx.lineWidth = (RING.width + RING.verge * 2) / nav.metresPerPixel + 3;
    ctx.stroke(lap);
    ctx.strokeStyle = 'rgb(226,232,240)';
    ctx.lineWidth = (RING.width + RING.verge * 2) / nav.metresPerPixel;
    ctx.stroke(lap);
  }
  for (const pass of ['casing', 'street'] as const) {
    for (const street of STREETS) {
      const end = (at: number): [number, number] => (street.axis === 'along'
        ? stationXZ(at, street.at)
        : stationXZ(street.at, at));
      const [x0, z0] = end(street.from);
      const [x1, z1] = end(street.to);
      const width = (street.width + street.footway * 2) / nav.metresPerPixel;
      ctx.beginPath();
      ctx.moveTo(toPixelX(nav, x0), toPixelZ(nav, z0));
      ctx.lineTo(toPixelX(nav, x1), toPixelZ(nav, z1));
      if (pass === 'casing') {
        ctx.strokeStyle = 'rgba(9,14,20,0.85)';
        ctx.lineWidth = width + 3;
      } else {
        ctx.strokeStyle = street.centreLine ? 'rgb(226,232,240)' : 'rgb(178,187,200)';
        ctx.lineWidth = width;
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * The paved ground on the island that is not a street: the forecourt and the
 * car park.
 *
 * Drawn in the dimmer of the two road tones, which is exactly what the raster
 * gives the city's own yards and car parks — so the island's paving reads as
 * the same kind of surface as the mainland's rather than as another road.
 */
function paintTownGround(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  // `TOWN_BUILT` as well as `TOWN_ENABLED`: the streets and the buildings empty
  // themselves when the town is stripped, but these two are rectangles of their
  // own and would have printed a forecourt and a car park on a map of a field.
  if (!TOWN_ENABLED || !TOWN_BUILT) return;
  ctx.save();
  ctx.fillStyle = PAVED_TONE;
  for (const area of [FORECOURT, CAR_PARK]) {
    frameRect(ctx, nav,
      (area.fromAcross + area.toAcross) / 2, (area.fromAlong + area.toAlong) / 2,
      area.toAcross - area.fromAcross, area.toAlong - area.fromAlong, 0);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The town's buildings.
 *
 * Without them the island reads as a road layout drawn on a field, which is
 * what it was before there were any: the city's blocks come to the map for
 * free in the raster, and everything transplanted onto the island has to be
 * drawn here or it is simply not on the map. Their footprints are measured
 * (`CHUNK_FOOTPRINT`) rather than guessed, so a block that is 94 m by 62 m in
 * the world is 94 m by 62 m here.
 */
function paintTownBuildings(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!TOWN_ENABLED) return;
  ctx.save();
  ctx.fillStyle = BUILDING_TONE;
  for (const building of TOWN_BUILDINGS) {
    const size = CHUNK_FOOTPRINT[building.part];
    if (!size) continue;
    frameRect(ctx, nav, building.across, building.along, size[0], size[1], building.turn);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The village on the smaller island: its two lanes, its cottages, the
 * farmstead across the line, the playground, the quay, the lighthouse on the
 * tip and the windmill on the far one.
 *
 * The same argument as the town's buildings — none of it exists in the raster
 * — with one addition worth drawing for its own sake. The quay is the only
 * built thing on the map that reaches out over the water, and now that there
 * are boats to bring alongside it, it is the one feature out here that tells
 * you where you can land.
 */
function paintVillage(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!VILLAGE_ENABLED) return;
  const hand = VILLAGE_SITE ? VILLAGE_SITE.hand : 1;
  /** The village's own frame to the map, the way `villagePoint` places it. */
  const at = (along: number, across: number) => {
    const [x, , z] = villagePoint(along, across * hand);
    return [toPixelX(nav, x), toPixelZ(nav, z)] as const;
  };

  ctx.save();
  // The harbour front and the lane, as the paved outline they are.
  const H = VILLAGE.harbour;
  ctx.fillStyle = PAVED_TONE;
  ctx.beginPath();
  for (let along = H.from; along <= H.to; along += H.step) {
    const [px, pz] = at(along, harbourOuter(along));
    if (along === H.from) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
  }
  for (let along = H.to; along >= H.from; along -= H.step) {
    const [px, pz] = at(along, harbourInner(along) ?? 0);
    ctx.lineTo(px, pz);
  }
  ctx.closePath();
  ctx.fill();
  // The lane, and its spur down to the square.
  // In the street style — see `strokeStreets` — casing first, then the lane.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Each lane at its own width: the far one is a metre narrower.
  const lanes: Array<[ReadonlyArray<readonly [number, number]>, number]> = [
    [VILLAGE_ROAD, VILLAGE.road.width],
    [FAR_ROAD, VILLAGE.farRoad.width],
  ];
  const [sa, s0, s1] = roadSpur();
  for (const [colour, extra] of [[STREET_CASING, 3], [LANE_TONE, 0]] as const) {
    ctx.strokeStyle = colour;
    for (const [line, width] of lanes) {
      ctx.lineWidth = width / nav.metresPerPixel + extra;
      ctx.beginPath();
      line.forEach(([along, across], i) => {
        const [px, pz] = at(along, across);
        if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
      });
      ctx.stroke();
    }
    ctx.lineWidth = VILLAGE.road.width / nav.metresPerPixel + extra;
    ctx.beginPath();
    const [p0x, p0z] = at(sa, s0);
    const [p1x, p1z] = at(sa, s1);
    ctx.moveTo(p0x, p0z);
    ctx.lineTo(p1x, p1z);
    ctx.stroke();
  }

  // The playground, a paved patch between the harbour houses and the church
  // — the footprint the village keeps clear for it.
  const P = VILLAGE.playground;
  ctx.fillStyle = PARK_PAVED_TONE;
  villageRect(ctx, nav, { along: P.along, across: P.across, turn: 0 }, [9, 12], hand);
  ctx.fill();

  // The houses.
  ctx.fillStyle = BUILDING_TONE;
  for (const building of VILLAGE_BUILDINGS) {
    villageRect(ctx, nav, { along: building.along, across: building.across, turn: facingTurn(building.facing, hand as 1 | -1) },
      buildingSize(building), hand);
    ctx.fill();
  }

  // The jetty, reaching out past the stone edge.
  const quay = VILLAGE.quay;
  const inner = harbourOuter(quay.along) - quay.inland;
  const [qx, qz] = at(quay.along, inner);
  const [ox, oz] = at(quay.along, villageShore(quay.along) + quay.overWater);
  ctx.beginPath();
  ctx.moveTo(qx, qz);
  ctx.lineTo(ox, oz);
  ctx.strokeStyle = QUAY_TONE;
  ctx.lineWidth = quay.width / nav.metresPerPixel;
  ctx.stroke();

  // The lighthouse on the seaward tip, sited as `IslandVillage`'s beacon is:
  // a pale disc with a dark rim, the size of its base.
  const B = VILLAGE.beacon;
  const [bx, bz] = at(B.along, Math.max(6, villageShore(B.along) - B.inset));
  const radius = Math.max(2.5, (B.baseRadius + 0.6) / nav.metresPerPixel);
  ctx.beginPath();
  ctx.arc(bx, bz, radius, 0, Math.PI * 2);
  ctx.fillStyle = WALL_TONE;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = BUILDING_TONE;
  ctx.stroke();

  // The windmill on the far tip: its round tower, in the buildings' tone.
  const mill = VILLAGE_PASTURE.mill;
  if (mill) {
    const [x, , z] = villagePoint(mill.along, mill.across);
    ctx.beginPath();
    ctx.arc(toPixelX(nav, x), toPixelZ(nav, z), Math.max(2.5, 3.2 / nav.metresPerPixel), 0, Math.PI * 2);
    ctx.fillStyle = BUILDING_TONE;
    ctx.fill();
  }
  ctx.restore();
}

/** One of the village's buildings, in its own rotated frame. */
function villageRect(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  building: { along: number; across: number; turn: number },
  size: readonly [number, number],
  hand: number,
) {
  const [x, , z] = villagePoint(building.along, building.across * hand);
  const heading = VILLAGE_SITE ? VILLAGE_SITE.heading : 0;
  mapRect(ctx, nav, x, z, size[0], size[1], heading + building.turn);
}

/**
 * A rectangle laid out in the STATION's frame — `across`/`along` metres, with
 * an extra turn — put onto the map.
 */
function frameRect(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  across: number,
  along: number,
  width: number,
  depth: number,
  turn: number,
) {
  const [x, , z] = stationPoint(along, across);
  const heading = STATION_SITE ? STATION_SITE.heading : 0;
  mapRect(ctx, nav, x, z, width, depth, heading + turn);
}

/** A rotated rectangle at a world point, as a path ready to fill. */
function mapRect(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  x: number,
  z: number,
  width: number,
  depth: number,
  heading: number,
) {
  // The frame's own axes, in the world: +X across, +Z along, turned by the
  // heading — the same mapping the groups these things are drawn in use.
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const halfW = width / 2;
  const halfD = depth / 2;
  ctx.beginPath();
  [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]].forEach(([u, v], i) => {
    const wx = x + u * cos + v * sin;
    const wz = z - u * sin + v * cos;
    const px = toPixelX(nav, wx);
    const pz = toPixelZ(nav, wz);
    if (i === 0) ctx.moveTo(px, pz);
    else ctx.lineTo(px, pz);
  });
  ctx.closePath();
}

/** A station-frame point as the XZ pair `fillOutline` and `strokeRoute` want. */
function stationXZ(along: number, across: number): [number, number] {
  const [x, , z] = stationPoint(along, across);
  return [x, z];
}

/** The three station roads, drawn as railway rather than as street. */
function paintStationRoads(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  const site = STATION_SITE;
  if (!STATION_ENABLED || !site) return;
  for (const road of ROADS.slice(1)) {
    // End to end, both throats included: these are loop lines off the down
    // line now rather than sidings, so each one is drawn over its own extent
    // (`roadLead`). Open-ended, because a closed path would draw a return leg
    // back down the middle of the station.
    const to = roadLead(road);
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) {
      const along = -to + ((to * 2) * i) / 60;
      path.push(stationXZ(along, roadOffset(road, along)));
    }
    strokeRoute(ctx, nav, path, TRAIN_COLOUR, RAIL_BRANCH_PX, false);
  }
}

/** Tram line colour, shared by the map line and the legend swatch. */
export const RAIL_COLOUR = '#5ad1c8';
/** Main line colour. Warmer than the tram's, so the two read as two railways. */
export const TRAIN_COLOUR = '#f0a84a';

/**
 * The route and its destination.
 *
 * Green, and specifically *not* the waypoint amber it started as: `HUD.way` is
 * `#ffb020` and the main line is `#f0a84a`, near enough the same hue that the
 * planned route read as another railway laid across the city. The three things
 * a player has to tell apart on this map are the tram loop (teal), the main
 * line (amber) and where they are going — so where they are going is the one
 * colour neither railway uses, and the one every navigation screen already
 * means "this way".
 */
export const ROUTE_COLOUR = '#2fe36a';

/**
 * Strokes both railways over the painted map.
 *
 * Baked into the prepainted canvas rather than drawn per frame, so it costs
 * nothing at runtime and comes along for free in both the minimap blit (where
 * it rotates with the world) and the M-key full map.
 *
 * Two passes each: a solid line for the route, then a dashed overlay on top so
 * it reads as rail rather than as one more street — which matters most for the
 * tram, whose loop runs down streets that are themselves drawn on the map.
 */
function strokeRoute(
  ctx: CanvasRenderingContext2D,
  nav: NavRaster,
  path: Array<[number, number]>,
  colour: string,
  width: number,
  closed = true,
) {
  ctx.save();
  ctx.beginPath();
  path.forEach(([x, z], i) => {
    const px = toPixelX(nav, x);
    const pz = toPixelZ(nav, z);
    if (i === 0) ctx.moveTo(px, pz);
    else ctx.lineTo(px, pz);
  });
  if (closed) ctx.closePath();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();

  // Sleeper hatching.
  ctx.strokeStyle = 'rgba(8,14,20,0.7)';
  ctx.lineWidth = width * 0.42;
  ctx.setLineDash([4, 9]);
  ctx.stroke();
  ctx.restore();
}

/**
 * The tunnels, numbered along the route.
 *
 * One entry per *enclosed* stretch, not per bore. The route has four bores but
 * only three tunnels: two of them are joined by a short gallery across a gap,
 * and a driver goes underground once and comes out once — so calling those
 * `T1` and `T2` would number something nobody experiences as two tunnels. It
 * is `enclosed` that means "covered from here to there", which is why the route
 * file reports the two counts separately.
 *
 * Numbered in the direction of travel from the arc-length origin, so the
 * numbering is stable: it changes only if the route itself changes.
 *
 * Computed here rather than in `trainConfig` because numbering is a map
 * concern — nothing in the world cares what a tunnel is called.
 */
interface MapTunnel {
  label: string;
  /** Midpoint of the run, and the line's normal there, for the label. */
  x: number;
  z: number;
  nx: number;
  nz: number;
  length: number;
}

const TUNNELS: MapTunnel[] = (() => {
  if (!TRAIN_LINE_ENABLED || !TRAIN_POINTS.length) return [];
  const n = TRAIN_POINTS.length;
  const runs: number[][] = [];
  for (let i = 0; i < n; i++) {
    // A run starts where an enclosed point follows an open one. Read as a ring:
    // a tunnel that straddles the arc-length origin is one tunnel.
    const previous = TRAIN_POINTS[(i - 1 + n) % n];
    if (!TRAIN_POINTS[i].enclosed || previous.enclosed) continue;
    const run: number[] = [];
    for (let k = 0; k < n; k++) {
      const at = (i + k) % n;
      if (!TRAIN_POINTS[at].enclosed) break;
      run.push(at);
    }
    runs.push(run);
  }
  return runs.map((run, index) => {
    const mid = run[Math.floor(run.length / 2)];
    const a = TRAIN_POINTS[run[0]];
    const b = TRAIN_POINTS[run[run.length - 1]];
    const point = TRAIN_POINTS[mid];
    const before = TRAIN_POINTS[(mid - 1 + n) % n];
    const after = TRAIN_POINTS[(mid + 1) % n];
    const tx = after.x - before.x;
    const tz = after.z - before.z;
    const len = Math.hypot(tx, tz) || 1;
    // Length round the ring, so a run through the origin measures correctly.
    const span = b.arc >= a.arc ? b.arc - a.arc : TRAIN_LENGTH - a.arc + b.arc;
    return {
      label: `T${index + 1}`,
      x: point.x,
      z: point.z,
      nx: tz / len,
      nz: -tx / len,
      length: span,
    };
  });
})();

/**
 * Draws the tunnels as tunnels: the solid line broken, and a dashed one
 * through the gap.
 *
 * The map convention, and the reason it is worth the twenty lines: a numbered
 * label pointing at a stretch of line drawn exactly like every other stretch
 * says nothing about why that stretch has a name. Casing first, in the dark of
 * the ground, to cut the running line; then long dashes over it, so the route
 * still reads as continuous — which underground it is.
 */
function paintTunnels(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  if (!TRAIN_LINE_ENABLED) return;
  const n = TRAIN_POINTS.length;
  for (let i = 0; i < n; i++) {
    const previous = TRAIN_POINTS[(i - 1 + n) % n];
    if (!TRAIN_POINTS[i].enclosed || previous.enclosed) continue;
    const path: Array<[number, number]> = [];
    for (let k = 0; k < n; k++) {
      const at = (i + k) % n;
      if (!TRAIN_POINTS[at].enclosed) break;
      path.push([TRAIN_POINTS[at].x, TRAIN_POINTS[at].z]);
    }
    if (path.length < 2) continue;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    path.forEach(([x, z], k) => {
      const px = toPixelX(nav, x);
      const pz = toPixelZ(nav, z);
      if (k === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    });
    ctx.strokeStyle = 'rgba(9,14,20,0.92)';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = TRAIN_COLOUR;
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 9]);
    ctx.stroke();
    ctx.restore();
  }
}

function paintRail(ctx: CanvasRenderingContext2D, nav: NavRaster) {
  // The tram loop is analytic, so it is sampled; the main line is already a
  // polyline and is drawn as one.
  const steps = 512;
  strokeRoute(ctx, nav, Array.from({ length: steps + 1 }, (_, i) => (
    railPointAt((i / steps) * RAIL_LENGTH)
  )), RAIL_COLOUR, RAIL_LINE_PX);
  if (TRAIN_LINE_ENABLED) {
    // The two junctions' branches, off the main viaduct down to the Skylark
    // line and to the airport trunk — the same tracks `BranchLine` lays. Left
    // out, both lines ended in open water on the map.
    for (const junction of JUNCTIONS) {
      for (const track of junction.tracks) {
        strokeRoute(ctx, nav, track.map((q) => [q.x, q.z]), TRAIN_COLOUR, RAIL_BRANCH_PX, false);
      }
    }
    strokeRoute(ctx, nav, TRAIN_POINTS.map((p) => [p.x, p.z]), TRAIN_COLOUR, RAIL_LINE_PX);
  }
}

interface MinimapProps {
  telemetry: RefObject<VehicleTelemetry>;
}

export function Minimap({ telemetry }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waypointRef = useRef<Waypoint | null>(null);
  const headingLabelRef = useRef<HTMLDivElement>(null);
  const distanceLabelRef = useRef<HTMLDivElement>(null);
  /** The pin sits beside the reading, so the row hides as a unit when unset. */
  const distanceRowRef = useRef<HTMLDivElement>(null);

  // The raster and its prepainted canvas are state, not refs: they are read
  // during render to decide what to mount, and they settle exactly once.
  const [nav, setNav] = useState<NavRaster | null>(null);
  const [fullMap, setFullMap] = useState<HTMLCanvasElement | null>(null);
  // Shared with the pause menu's MAP page (`fullMapStore`).
  const expanded = useFullMapOpen();
  // Mirrors waypointRef purely so the header can re-render when it changes;
  // the draw loop always reads the ref.
  const [hasWaypoint, setHasWaypoint] = useState(false);
  /** The planned route, read by both maps' draw loops. */
  const routeRef = useRef<Float64Array | null>(null);
  /** Its length, for the header. State because it is read during render. */
  const [routeMetres, setRouteMetres] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCityNav(CITY_NAV_IMAGE)
      .then((raster) => {
        if (cancelled) return;
        setNav(raster);
        setFullMap(paintFullMap(raster));
      })
      .catch((error) => console.error('[minimap] failed to build map', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'KeyM') setFullMapOpen((open) => !open);
      if (event.code === 'Escape') setFullMapOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- the live minimap -----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const full = fullMap;
    if (!canvas || !nav || !full) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const centre = SIZE / 2;
    const radius = centre - 3;
    // Device pixels per raster pixel.
    const zoom = SIZE / (SPAN_METRES / nav.metresPerPixel);

    let frame = 0;
    let last = 0;
    let lastCardinal = '';
    let lastDistance = '';

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / HZ) return;
      last = now;

      const t = telemetry.current;
      if (!t) return;

      // `mapX`/`mapZ`, not `toPixelX`: the prepainted canvas has the raster
      // inset by the map's margin, and this samples that canvas.
      const px = mapX(nav, t.x);
      const pz = mapZ(nav, t.z);
      // Rotating the map by +heading puts the car's forward direction at screen
      // up: forward is (-sin h, -cos h) in map space, which rotates to (0, -1).
      const rot = t.heading;

      ctx.save();
      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = '#0c1019';
      ctx.fillRect(0, 0, SIZE, SIZE);

      ctx.translate(centre, centre);
      ctx.rotate(rot);
      // Only the rotated square that can cover the disc is sampled, rather than
      // transforming the whole 2931x1467 map every frame.
      const half = (centre / zoom) * Math.SQRT2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        full,
        px - half, pz - half, half * 2, half * 2,
        -half * zoom, -half * zoom, half * 2 * zoom, half * 2 * zoom,
      );

      /**
       * The planned route, drawn under the marker and clipped to the disc.
       *
       * The same line the full map draws, in the rotated frame — which is what
       * makes the minimap answer "which way at this junction" instead of only
       * "roughly over there". Drawn straight from world metres through the
       * same transform as the map underneath it, so it sits on the roads.
       */
      const route = routeRef.current;
      if (route && route.length >= 4) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          const rx = (mapX(nav, route[i]) - px) * zoom;
          const rz = (mapZ(nav, route[i + 1]) - pz) * zoom;
          if (i === 0) ctx.moveTo(rx, rz); else ctx.lineTo(rx, rz);
        }
        ctx.strokeStyle = 'rgba(7,12,20,0.7)';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = ROUTE_COLOUR;
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Waypoint, drawn in map space so it rotates with the world.
      const wp = waypointRef.current;
      if (wp) {
        // `mapX`/`mapZ`, matching `px`/`pz` above. These read `toPixelX`, which
        // is the *unpadded* raster pixel, while the player's position is the
        // padded map pixel — so the marker sat a whole margin off, about 124 px on a
        // 196 px dial, which is more than the dial's radius. It was pinned to
        // the rim in roughly the same wrong direction whatever you set.
        const wx = (mapX(nav, wp.x) - px) * zoom;
        const wz = (mapZ(nav, wp.z) - pz) * zoom;
        const dist = Math.hypot(wx, wz);
        // Held a little further off the rim than before, because the marker
        // it is clamping is now bigger than the gap it was leaving.
        const clamped = dist > radius - 22 ? (radius - 22) / dist : 1;
        ctx.save();
        ctx.translate(wx * clamped, wz * clamped);
        ctx.rotate(-rot); // keep the marker upright regardless of map rotation
        drawWaypointMarker(ctx, 0.46);
        ctx.restore();
      }
      ctx.restore();

      // --- overlays that do not rotate ---
      ctx.save();
      ctx.translate(centre, centre);

      // Player, always pointing up — the minimap turns, the car does not.
      drawPlayerMarker(ctx, 0.5);

      // Compass letters ride the rim, so N really points north.
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const c of COMPASS) {
        const dx = c.x * Math.cos(rot) - c.z * Math.sin(rot);
        const dz = c.x * Math.sin(rot) + c.z * Math.cos(rot);
        ctx.fillStyle = c.label === 'N' ? '#ff6b5e' : 'rgba(255,255,255,0.6)';
        ctx.fillText(c.label, dx * (radius - 9), dz * (radius - 9));
      }
      ctx.restore();

      // Ring.
      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // --- text readouts, only touched when they change ---
      // Two modulos, not one. `x + 360` normalises a heading that has wrapped
      // once; the drone's yaw accumulates, so spin it a full turn one way and
      // the result is still negative, `Math.round(deg / 45) % 8` is negative
      // too, and the readout becomes "undefined -272°".
      const degrees = ((((t.heading * 180) / Math.PI) % 360) + 360) % 360;
      const cardinal = `${CARDINALS[Math.round(degrees / 45) % 8]} ${Math.round(degrees).toString().padStart(3, '0')}°`;
      if (cardinal !== lastCardinal && headingLabelRef.current) {
        headingLabelRef.current.textContent = cardinal;
        lastCardinal = cardinal;
      }

      let distanceText = '';
      if (wp) {
        const metres = Math.hypot(wp.x - t.x, wp.z - t.z);
        distanceText = metres >= 1000 ? `${(metres / 1000).toFixed(2)} KM` : `${Math.round(metres)} M`;
      }
      if (distanceText !== lastDistance) {
        if (distanceLabelRef.current) distanceLabelRef.current.textContent = distanceText;
        if (distanceRowRef.current) distanceRowRef.current.style.opacity = distanceText ? '1' : '0';
        lastDistance = distanceText;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [nav, fullMap, telemetry]);

  const setWaypoint = useCallback((x: number, z: number) => {
    waypointRef.current = { x, z };
    setHasWaypoint(true);
  }, []);

  const clearWaypoint = useCallback(() => {
    waypointRef.current = null;
    routeRef.current = null;
    setRouteMetres(null);
    setHasWaypoint(false);
  }, []);

  /**
   * The driving route to the pin, re-planned on a timer.
   *
   * On a timer rather than once, because the useful thing about a route is
   * that it starts where the car *is*: plan it once and it becomes a line
   * back to where you were. `findRoute` walks the same graph the traffic
   * drives, so the line goes round the bay rather than across it — which is
   * the whole reason this replaced a straight dashed line.
   */
  useEffect(() => {
    if (!hasWaypoint) return;
    let cancelled = false;
    const plan = () => {
      const t = telemetry.current;
      const wp = waypointRef.current;
      if (cancelled || !t || !wp) return;
      try {
        const route = findRoute({ x: t.x, z: t.z }, wp);
        routeRef.current = route?.points ?? null;
        setRouteMetres(route ? route.metres : null);
      } catch (error) {
        // A route is a convenience; the pin and the straight-line distance
        // still work without one.
        console.warn('[minimap] could not plan a route', error);
        routeRef.current = null;
      }
    };
    plan();
    const timer = window.setInterval(plan, ROUTE_EVERY_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hasWaypoint, telemetry]);

  if (!nav || !fullMap) return null;

  return (
    <>
      <div
        className="absolute bottom-7 left-7 flex flex-col items-center gap-2"
        style={{ animation: 'hud-in 520ms cubic-bezier(0.2, 0.7, 0.2, 1) 200ms both' }}
      >
        {/* A ring in the accent — thin, and the only colour on the disc's edge. */}
        <div
          className="relative rounded-full p-[4px]"
          style={{ border: `2px solid ${accentAlpha(0.55)}`, boxShadow: `0 0 18px ${accentAlpha(0.25)}, inset 0 0 0 1px rgba(0,0,0,0.5)` }}
        >
          {/* Held at 82% and feathered in so the map sits in the scene rather
              than on it. The feather stops short of the compass letters, which
              the canvas draws 9 px inside the edge. */}
          <canvas
            ref={canvasRef}
            style={{
              width: SIZE,
              height: SIZE,
              opacity: 0.82,
              maskImage: 'radial-gradient(circle, #000 88%, transparent 100%)',
              WebkitMaskImage: 'radial-gradient(circle, #000 88%, transparent 100%)',
            }}
            className="rounded-full"
          />
          {/* The lubber line: a notch at the top of the ring, where the car is
              always pointing. The map rotates; this does not. */}
          <span
            aria-hidden
            className="absolute left-1/2 top-[-3px] h-[10px] w-[4px] -translate-x-1/2"
            style={{ background: ACCENT, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
          />
        </div>

        {/* Heading and waypoint distance in one angled tab under the disc. */}
        <div
          className="-mt-4 flex items-center gap-4 px-5 py-2"
          style={{ ...PANEL, clipPath: PANEL_CUT, borderBottom: `2px solid ${accentAlpha(0.7)}` }}
        >
          <div
            ref={headingLabelRef}
            style={{ ...NUM, fontSize: 14, fontWeight: 700, letterSpacing: '0.14em', color: HUD.text }}
          >
            N 000°
          </div>

          {/* Distance to the waypoint, with the reference's map pin. Hidden
              rather than unmounted, so the tab never changes width. */}
          <div
            ref={distanceRowRef}
            className="flex items-center gap-1.5 pr-2 transition-opacity duration-200"
            style={{ opacity: 0 }}
          >
            <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden>
              <path
                d="M4.5 0C2 0 0 2 0 4.5C0 7.5 4.5 12 4.5 12S9 7.5 9 4.5C9 2 7 0 4.5 0Z"
                fill={ROUTE_COLOUR}
              />
              <circle cx="4.5" cy="4.4" r="1.6" fill="rgba(7,13,20,0.85)" />
            </svg>
            <div
              ref={distanceLabelRef}
              style={{ ...NUM, fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', color: ROUTE_COLOUR }}
            />
          </div>
          <span aria-hidden className="-mr-3 h-6 w-[10px] shrink-0" style={HATCH} />
        </div>

        {/* Where that disc is centred, in world metres — the map's own
            coordinate, under the map. See `PositionFix`. */}
        <PositionFix telemetry={telemetry} />
      </div>

      {expanded && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm p-6">
          <div className="flex w-full max-w-[1100px] items-center justify-between text-[10px] tracking-[0.22em] text-white/50">
            <span className="flex items-center gap-4">
              CITY MAP · CLICK TO PIN · DRAG TO PAN · SCROLL TO ZOOM
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-5 rounded-full" style={{ background: RAIL_COLOUR }} />
                TRAM LOOP
              </span>
              {TRAIN_LINE_ENABLED && (
                <span className="flex items-center gap-1.5">
                  <span className="h-[3px] w-5 rounded-full" style={{ background: TRAIN_COLOUR }} />
                  MAIN LINE
                </span>
              )}
              {/* The tunnels keep their broken line; what they lost is the
                  `T1`/`T2` badges pinned to them on the map, which numbered
                  something nobody experiences as a numbered list and left two
                  labels sitting on the one part of the map you most want to
                  read. The dash pattern says "tunnel" on its own. */}
              {TUNNELS.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-[3px] w-5"
                    style={{
                      background: `repeating-linear-gradient(90deg, ${TRAIN_COLOUR} 0 5px,`
                        + ' transparent 5px 9px)',
                    }}
                  />
                  TUNNEL
                </span>
              )}
              {routeMetres !== null && (
                <span className="flex items-center gap-1.5" style={{ color: ROUTE_COLOUR }}>
                  <span className="h-[3px] w-5 rounded-full" style={{ background: ROUTE_COLOUR }} />
                  {routeMetres >= 1000
                    ? `${(routeMetres / 1000).toFixed(1)} KM BY ROAD`
                    : `${Math.round(routeMetres)} M BY ROAD`}
                </span>
              )}
            </span>
            <span className="flex gap-4">
              {hasWaypoint && (
                <button onClick={clearWaypoint} className="tracking-[0.22em] hover:text-white" style={{ color: ROUTE_COLOUR }}>
                  CLEAR
                </button>
              )}
              <button onClick={() => setFullMapOpen(false)} className="tracking-[0.22em] hover:text-white">
                CLOSE · ESC
              </button>
            </span>
          </div>
          <FullMap
            fullMap={fullMap}
            nav={nav}
            telemetry={telemetry}
            waypointRef={waypointRef}
            routeRef={routeRef}
            onPick={setWaypoint}
          />
        </div>
      )}
    </>
  );
}

/**
 * The M-key map. Redrawn on its own rAF loop while open so the player marker
 * tracks the car; the base map is a single blit of the prepainted canvas.
 */
function FullMap({
  fullMap, nav, telemetry, waypointRef, routeRef, onPick,
}: {
  fullMap: HTMLCanvasElement | null;
  nav: NavRaster | null;
  telemetry: RefObject<VehicleTelemetry>;
  waypointRef: RefObject<Waypoint | null>;
  routeRef: RefObject<Float64Array | null>;
  onPick: (worldX: number, worldZ: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  /**
   * The view, in a ref rather than state.
   *
   * Panning is a pointermove away from a React render — at sixty of those a
   * second the map would re-render the whole overlay to move a picture it is
   * already redrawing itself on its own rAF loop. `follow` is what makes the
   * map track the car until the moment the player drags it, and stop until
   * they ask for it back.
   */
  const view = useRef({ zoom: 0, cx: 0, cz: 0, follow: true });
  const [panned, setPanned] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !nav || !fullMap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /** Map pixels per metre at zoom 1 is one raster pixel; this is the range. */
    const fitZoom = () => Math.min(
      canvas.clientWidth / mapWidth(nav), canvas.clientHeight / mapHeight(nav),
    );

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

      const px = mapX(nav, t.x);
      const pz = mapZ(nav, t.z);

      const v = view.current;
      // Seeded on the first frame, once the element has a size to seed from:
      // close enough to read street names off, not so close that you cannot
      // see the next junction. The whole map is always a scroll away.
      if (!v.zoom) {
        v.zoom = Math.max(fitZoom() * 2.6, DEFAULT_MAP_ZOOM);
        v.cx = px;
        v.cz = pz;
      }
      if (v.follow) { v.cx = px; v.cz = pz; }

      const scale = v.zoom * dpr;
      // Keep the view on the map: at a zoom that shows everything there is
      // nothing to pan to, so it locks to the centre rather than drifting off.
      const halfW = W / 2 / scale, halfH = H / 2 / scale;
      v.cx = mapWidth(nav) <= halfW * 2
        ? mapWidth(nav) / 2 : Math.min(Math.max(v.cx, halfW), mapWidth(nav) - halfW);
      v.cz = mapHeight(nav) <= halfH * 2
        ? mapHeight(nav) / 2 : Math.min(Math.max(v.cz, halfH), mapHeight(nav) - halfH);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#070b12';
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(scale, 0, 0, scale, W / 2 - v.cx * scale, H / 2 - v.cz * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fullMap, 0, 0);

      // Everything from here is drawn at a fixed size on screen rather than a
      // fixed size on the map, so a pin is a pin at every zoom.
      const s = 1 / scale;

      const route = routeRef.current;
      if (route && route.length >= 4) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        // A casing under the line, so it reads over pale roads as well as dark
        // water — the same trick the rail lines use.
        ctx.strokeStyle = 'rgba(7,12,20,0.75)';
        ctx.lineWidth = 9 * s;
        ctx.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          const rx = mapX(nav, route[i]), rz = mapZ(nav, route[i + 1]);
          if (i === 0) ctx.moveTo(rx, rz); else ctx.lineTo(rx, rz);
        }
        ctx.stroke();
        ctx.strokeStyle = ROUTE_COLOUR;
        ctx.lineWidth = 5 * s;
        ctx.stroke();
      }

      const wp = waypointRef.current;
      if (wp) {
        ctx.save();
        ctx.translate(mapX(nav, wp.x), mapZ(nav, wp.z));
        ctx.scale(s, s);
        drawWaypointMarker(ctx, 1);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(px, pz);
      ctx.scale(s, s);
      ctx.rotate(-t.heading);
      drawPlayerMarker(ctx, 1);
      ctx.restore();

      // --- overlays, in screen space -------------------------------------
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The islands' names, at the middle of each — see `MAP_PLACES`. Skipped
      // rather than clipped when one is off the view, so a label never costs a
      // measure and a stroke for text nobody can see.
      for (const place of MAP_PLACES) {
        const lx = (W / 2 + (mapX(nav, place.at[0]) - v.cx) * scale) / dpr;
        const ly = (H / 2 + (mapZ(nav, place.at[1]) - v.cz) * scale) / dpr;
        if (lx < -90 || ly < -20 || lx > canvas.clientWidth + 90 || ly > canvas.clientHeight + 20) {
          continue;
        }
        drawPlaceLabel(ctx, lx, ly, place);
      }
      drawCompass(ctx, canvas.clientWidth - 46, 46);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fullMap, nav, telemetry, waypointRef, routeRef]);

  /** Canvas-relative CSS pixels -> world metres, through the live view. */
  const toWorld = (event: { clientX: number; clientY: number }) => {
    const canvas = ref.current;
    if (!canvas || !nav) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const v = view.current;
    const scale = v.zoom;
    const mx = v.cx + ((event.clientX - rect.left) - rect.width / 2) / scale;
    const mz = v.cz + ((event.clientY - rect.top) - rect.height / 2) / scale;
    void dpr;
    return {
      x: toWorldX(nav, mx - mapPad(nav).left),
      z: toWorldZ(nav, mz - mapPad(nav).top),
      mx,
      mz,
    };
  };

  // A drag that moves is a pan; a drag that does not is a click. Without that
  // distinction every pan ends by dropping a waypoint where you let go.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  return (
    <div className="relative w-full max-w-[1100px]">
      <canvas
        ref={ref}
        // `active:` rather than a ref read during render: the cursor is a
        // presentational detail and the lint is right that a ref is not state.
        className="h-[70vh] w-full touch-none cursor-crosshair rounded-lg border border-white/10 active:cursor-grabbing" 
        onPointerDown={(event) => {
          (event.target as HTMLElement).setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const dx = event.clientX - d.x;
          const dy = event.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          d.x = event.clientX;
          d.y = event.clientY;
          const v = view.current;
          v.cx -= dx / v.zoom;
          v.cz -= dy / v.zoom;
          if (v.follow) { v.follow = false; setPanned(true); }
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved) return;
          const hit = toWorld(event);
          if (hit) onPick(hit.x, hit.z);
        }}
        onWheel={(event) => {
          const hit = toWorld(event);
          const v = view.current;
          const next = Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM,
            v.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18)));
          // Zoom about the cursor: the point under the pointer stays under it,
          // which is the difference between zooming a map and zooming a photo.
          if (hit) {
            const rect = ref.current!.getBoundingClientRect();
            const ox = (event.clientX - rect.left) - rect.width / 2;
            const oy = (event.clientY - rect.top) - rect.height / 2;
            v.cx = hit.mx - ox / next;
            v.cz = hit.mz - oy / next;
            if (v.follow) { v.follow = false; setPanned(true); }
          }
          v.zoom = next;
        }}
      />

      {/* Gamified, but only where it earns it: two chips, bottom right, in the
          HUD's own type. They are also the only discoverable clue that the map
          zooms at all. */}
      <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-2">
        {panned && (
          <button
            type="button"
            onClick={() => { view.current.follow = true; setPanned(false); }}
            className="rounded-md px-2.5 py-1.5 text-[10px] font-bold tracking-[0.2em] transition-colors"
            style={{ background: 'rgba(7,12,20,0.82)', border: `1px solid ${ROUTE_COLOUR}66`, color: ROUTE_COLOUR }}
          >
            RECENTRE
          </button>
        )}
        <div className="flex overflow-hidden rounded-md" style={{ border: '1px solid rgba(255,255,255,0.14)' }}>
          {([['−', 1 / 1.35], ['+', 1.35]] as const).map(([label, factor]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                const v = view.current;
                v.zoom = Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, v.zoom * factor));
              }}
              className="grid h-8 w-8 place-items-center text-[15px] font-bold text-white/80 transition-colors hover:bg-white/10"
              style={{ background: 'rgba(7,12,20,0.82)' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


/**
 * The two markers that matter, drawn the same way on both maps.
 *
 * They were a flat 13 px chevron and a flat teardrop, and at map scale they
 * disappeared into a city drawn in the same greys — "small, less popping, not
 * visually clear", which was fair. What they were missing is not size so much
 * as *separation*: a marker has to survive being over pale streets, dark water
 * and a green park, and a single flat colour cannot do that. So each is built
 * in layers — a soft glow, a dark disc, a light ring, then the shape — which
 * means there is always contrast against whatever is underneath.
 *
 * `scale` lets the 196 px minimap use the same drawing at a fraction of the
 * size rather than a second, slightly different marker.
 *
 * Nothing here moves. An earlier version had the rings swell and the pin bob
 * on a shared clock, on the theory that the only moving thing on a still map
 * is the first thing the eye finds. It is — which is the problem: a map you
 * are reading at speed should not have something on it demanding attention it
 * has already been given. Contrast does the work instead.
 */
function drawPlayerMarker(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.save();
  ctx.scale(scale, scale);

  /**
   * A cone showing which way the car is pointing.
   *
   * The arrow alone says heading only once you are close enough to see which
   * way it is turned; a beam says it from across the map, and heading is the
   * one thing this marker carries that the route line does not.
   */
  const beam = ctx.createLinearGradient(0, 0, 0, -66);
  beam.addColorStop(0, 'rgba(92,176,255,0.38)');
  beam.addColorStop(1, 'rgba(92,176,255,0)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 66, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
  ctx.closePath();
  ctx.fill();

  // A halo, so a blue arrow still separates from blue water.
  const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 42);
  glow.addColorStop(0, 'rgba(92,176,255,0.55)');
  glow.addColorStop(1, 'rgba(92,176,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 42, 0, Math.PI * 2);
  ctx.fill();

  /**
   * The arrow. Blue, big, and with its contrast built into the shape rather
   * than into anything behind it: a dark shadow underneath holds it off pale
   * streets, a white edge holds it off dark water, and a lighter leading face
   * gives it a front and a back so it reads as pointing.
   */
  ctx.shadowColor = 'rgba(5,9,16,0.8)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#2f8fe8';
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8.5);
  ctx.lineTo(-16, 16);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#7cc2ff';
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8.5);
  ctx.lineTo(-16, 16);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawWaypointMarker(ctx: CanvasRenderingContext2D, scale: number) {
  ctx.save();
  ctx.scale(scale, scale);

  // Two fixed rings on the ground, marking the exact spot the pin points at.
  ctx.strokeStyle = 'rgba(47,227,122,0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(47,227,122,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.stroke();

  // A column of light above the pin: a destination should be findable by
  // sweeping the map rather than by reading it.
  const column = ctx.createLinearGradient(0, -34, 0, -96);
  column.addColorStop(0, 'rgba(47,227,122,0.30)');
  column.addColorStop(1, 'rgba(47,227,122,0)');
  ctx.fillStyle = column;
  ctx.beginPath();
  ctx.moveTo(-7, -34);
  ctx.lineTo(7, -34);
  ctx.lineTo(4, -96);
  ctx.lineTo(-4, -96);
  ctx.closePath();
  ctx.fill();

  const glow = ctx.createRadialGradient(0, -22, 3, 0, -22, 42);
  glow.addColorStop(0, 'rgba(47,227,122,0.45)');
  glow.addColorStop(1, 'rgba(47,227,122,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, -22, 42, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(7,12,20,0.5)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 9, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = ROUTE_COLOUR;
  ctx.strokeStyle = 'rgba(7,12,20,0.95)';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-19, -24, -16, -47, 0, -47);
  ctx.bezierCurveTo(16, -47, 19, -24, 0, 0);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = 'rgba(7,12,20,0.92)';
  ctx.beginPath();
  ctx.arc(0, -30, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(0, -30, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A compass rose, drawn in the corner of the full map.
 *
 * The map is north-up and never rotates, so this does not move — which is the
 * point of it. The minimap's ring spins with the car and is the one you read
 * while driving; this one is here so that the two views are not silently
 * different conventions, and so a glance at the map tells you which way north
 * is without having to remember that it is "up".
 */
/**
 * The places the map names, and what each one is for.
 *
 * There are three islands out there and until now not one of them was labelled,
 * so the only way to talk about any of them was to point at it. They have all
 * had names in the code from the start — the railway's two are traced under
 * that name in `trainSketch.json`, and the airfield has been Halcyon Field
 * since it was built — so this writes down what is already true rather than
 * inventing a set of names that only the map would know.
 *
 * Which railway island carries which place is deliberately NOT decided here.
 * `stationConfig` takes the larger of the two by area and `villageConfig` the
 * smaller, and both now say which one they took; asking them is what keeps the
 * label attached to the buildings. Re-deciding it here by area would be a
 * second copy of that rule, free to disagree with the first the moment either
 * island is redrawn.
 */
interface MapPlace {
  name: string;
  /** What is on it, under the name, in half the size. */
  role: string;
  /** World XZ of the middle of the thing being named. */
  at: readonly [number, number];
}

function islandRole(name: string): string {
  // The subtitle has to follow `TOWN_BUILT`: with the town stripped the island
  // is a station on grass, and a map that still labels it "STATION & TOWN" is
  // the map lying about the one thing it is for.
  if (name === STATION_ISLAND) return TOWN_BUILT ? 'STATION & TOWN' : 'STATION';
  if (name === VILLAGE_ISLAND) return 'VILLAGE';
  return 'ISLAND';
}

/**
 * The mainland's own outlying lobes.
 *
 * These read as islands on the map and are not: all three are joined to the
 * city, two of them by a single road across the water and the third by a neck
 * of its own ground. Flood-filling the nav raster finds exactly one landmass,
 * which is why none of them has an outline in any config to hang a name off —
 * they are parts of `city.glb`, not built by us — and why their anchors are
 * plain world coordinates here rather than a centre computed from a shape.
 *
 * Each anchor is the centroid of that lobe's land in the raster, measured
 * rather than eyeballed. The headland's is taken from south of z 960 only —
 * the neck the railway bores through — because everything north of that is
 * the city's own shoreline and including it dragged the name off the
 * headland and onto the water above it.
 *
 * The names are new, and they follow the ones already out there — Kestrel,
 * Gannet, and Halcyon, which is a kingfisher. The role under each says what it
 * actually is, because "island" for something you can drive to is the kind of
 * label that sends you looking for a bridge that was never needed.
 */
const MAINLAND_PLACES: MapPlace[] = [
  { name: 'CURLEW', role: 'WEST DISTRICT', at: [-1821, -509] },
  { name: 'PETREL', role: 'CIRCUIT', at: [-1683, 642] },
  { name: 'SHEARWATER', role: 'SOUTH HEADLAND', at: [-1040, 1178] },
];

const MAP_PLACES: MapPlace[] = [
  ...(TRAIN_LINE_ENABLED ? TRAIN_ISLANDS.map((island) => ({
    name: island.name.toUpperCase(),
    role: islandRole(island.name),
    at: island.centre,
  })) : []),
  ...(AIRPORT_ENABLED
    ? [{ name: 'HALCYON FIELD', role: 'AIRPORT', at: AIRPORT_SITE.centre }] : []),
  // Skylark, the bird of open farmland, as the rest are the birds of their
  // coasts. Its centre is the middle of the parish: the hamlet is north of it
  // and the downs south, and the name belongs to neither more than the other.
  ...(COUNTRY_ENABLED
    ? [{ name: COUNTRY_NAME.toUpperCase(), role: 'COUNTRYSIDE', at: COUNTRY_SITE.centre }] : []),
  ...MAINLAND_PLACES,
];

/**
 * One place name, written over the map.
 *
 * Drawn in screen space rather than map space, which is the whole reason it is
 * here and not painted into `paintFullMap` with the land: a label that scales
 * with the map is a smudge zoomed out and a banner zoomed in, and a name's job
 * is to be the same quiet size at every zoom.
 *
 * No plate behind it. The HUD's rule is marks on glass (`hudTheme`), and what
 * carries the contrast instead is a dark stroke round every glyph — which is
 * what lets the same label sit on a white apron and on black water without
 * either one being a special case.
 */
function drawPlaceLabel(ctx: CanvasRenderingContext2D, x: number, y: number, place: MapPlace) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(5,9,16,0.88)';

  ctx.font = '700 11px system-ui, sans-serif';
  ctx.lineWidth = 3.5;
  ctx.strokeText(place.name, x, y);
  ctx.fillStyle = 'rgba(234,242,251,0.95)';
  ctx.fillText(place.name, x, y);

  ctx.font = '600 8px system-ui, sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeText(place.role, x, y + 11);
  ctx.fillStyle = accentAlpha(0.8);
  ctx.fillText(place.role, x, y + 11);
  ctx.restore();
}

function drawCompass(ctx: CanvasRenderingContext2D, cx: number, cz: number) {
  const r = 26;
  ctx.save();
  ctx.translate(cx, cz);

  ctx.fillStyle = 'rgba(7,12,20,0.8)';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Ticks at the quarters, longest at north.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const inner = i % 2 === 0 ? r - 7 : r - 4;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
    ctx.lineTo(Math.sin(a) * (r - 2), -Math.cos(a) * (r - 2));
    ctx.stroke();
  }

  // The needle: red to the north, pale to the south, split down the middle so
  // it reads as one arrow rather than two triangles.
  ctx.beginPath();
  ctx.moveTo(0, -r + 8);
  ctx.lineTo(5.5, 3);
  ctx.lineTo(0, 0.5);
  ctx.closePath();
  ctx.fillStyle = '#ff6b5e';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -r + 8);
  ctx.lineTo(-5.5, 3);
  ctx.lineTo(0, 0.5);
  ctx.closePath();
  ctx.fillStyle = '#d8402f';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, r - 8);
  ctx.lineTo(5.5, -3);
  ctx.lineTo(0, -0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, r - 8);
  ctx.lineTo(-5.5, -3);
  ctx.lineTo(0, -0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();

  ctx.fillStyle = '#ff6b5e';
  ctx.font = '700 9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', 0, -r + 3.5);
  ctx.restore();
}
