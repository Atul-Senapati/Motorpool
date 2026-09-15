'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CITY_NAV_IMAGE } from '@/config/cityConfig';
import { RAIL_LENGTH, railPointAt } from '@/config/railConfig';
import {
  TRAIN_ISLANDS, TRAIN_LENGTH, TRAIN_LINE_ENABLED, TRAIN_POINTS,
} from '@/config/trainConfig';
import {
  BRIDGE, ISLAND_LINK, MAIN_LINE_TOE, PLATFORMS, ROADS, STATION, STATION_ENABLED,
  STATION_SITE, TOWN, roadLead, roadOffset, stationPoint,
} from '@/config/stationConfig';
import {
  CAR_PARK, CHUNK_FOOTPRINT, FORECOURT, RING, RING_CHAINS, STREETS, TOWN_BUILDINGS, TOWN_ENABLED,
} from '@/config/townConfig';
import {
  VILLAGE, VILLAGE_BUILDINGS, VILLAGE_ENABLED, VILLAGE_SITE, villagePoint, villageShore,
} from '@/config/villageConfig';
import {
  loadCityNav, toPixelX, toPixelZ, toWorldX, toWorldZ, type NavRaster,
} from '@/physics/cityNav';
import { findRoute } from '@/physics/roadRoute';
import type { VehicleTelemetry } from '@/types/vehicle';
import { ACCENT, HATCH, HUD, NUM, PANEL, PANEL_CUT, accentAlpha } from './hudTheme';

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
 * 110 px is 165 m. Everything that converts between world and map pixels has
 * to agree about it, which is what `mapX`/`mapZ` are for; the raster's own
 * `toPixelX`/`toPixelZ` are still the truth for the raster itself.
 */
export const MAP_PAD = 110;
const mapX = (nav: NavRaster, x: number) => toPixelX(nav, x) + MAP_PAD;
const mapZ = (nav: NavRaster, z: number) => toPixelZ(nav, z) + MAP_PAD;
export const mapWidth = (nav: NavRaster) => nav.width + MAP_PAD * 2;
export const mapHeight = (nav: NavRaster) => nav.height + MAP_PAD * 2;

/**
 * Paint the whole nav raster into an offscreen canvas, once.
 *
 * Roads are drawn bright and everything else recedes, so at minimap size the
 * street grid is the only thing that reads. Terrain keeps a faint height ramp
 * so the hills and the coastline stay legible on the full map.
 */
function paintFullMap(nav: NavRaster): HTMLCanvasElement {
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
  ctx.putImageData(image, MAP_PAD, MAP_PAD);
  // Everything below is placed by world coordinates through `toPixelX`, so one
  // translate here puts the whole lot in the same frame as the inset raster.
  ctx.save();
  ctx.translate(MAP_PAD, MAP_PAD);
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
const ISLAND_SAND = 'rgb(74,66,48)';
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
    // The beach is the outline pushed out radially, the same construction
    // `TrainLine` sweeps its sand flanks along — so the shore on the map is the
    // shore in the world rather than an approximation of it.
    const beach = island.outline.map(([x, z]) => {
      const dx = x - island.centre[0];
      const dz = z - island.centre[1];
      const len = Math.hypot(dx, dz) || 1;
      return [x + (dx / len) * island.shore, z + (dz / len) * island.shore] as const;
    });
    fillOutline(ctx, nav, beach, ISLAND_SAND);
    fillOutline(ctx, nav, island.outline, ISLAND_LAND);
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

  const { x: [x0, x1], z: [z0, z1] } = TOWN.footprint;
  // Source coordinates are read from the painted canvas, which has the raster
  // inset by `MAP_PAD` — so these are map pixels, not raster pixels. The
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
  if (!TOWN_ENABLED) return;
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
 * The village on the smaller island: its lane, its cottages and its quay.
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
  // The lane, as a stroked line of its own width.
  const lane = VILLAGE.laneAcross;
  const [ax, az] = at(-VILLAGE.laneHalfLength + VILLAGE.laneAlong, lane);
  const [bx, bz] = at(VILLAGE.laneHalfLength + VILLAGE.laneAlong, lane);
  ctx.beginPath();
  ctx.moveTo(ax, az);
  ctx.lineTo(bx, bz);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(9,14,20,0.8)';
  ctx.lineWidth = (VILLAGE.laneWidth + 2) / nav.metresPerPixel;
  ctx.stroke();
  ctx.strokeStyle = PAVED_TONE;
  ctx.lineWidth = VILLAGE.laneWidth / nav.metresPerPixel;
  ctx.stroke();

  // The cottages.
  ctx.fillStyle = BUILDING_TONE;
  for (const building of VILLAGE_BUILDINGS) {
    const size = CHUNK_FOOTPRINT[building.part];
    if (!size) continue;
    villageRect(ctx, nav, building, size, hand);
    ctx.fill();
  }

  // The quay, reaching out past the beach.
  const quay = VILLAGE.quay;
  const inner = villageShore(quay.along) - 6;
  const [qx, qz] = at(quay.along, inner);
  const [ox, oz] = at(quay.along, inner + quay.overWater + 6);
  ctx.beginPath();
  ctx.moveTo(qx, qz);
  ctx.lineTo(ox, oz);
  ctx.strokeStyle = QUAY_TONE;
  ctx.lineWidth = quay.width / nav.metresPerPixel;
  ctx.stroke();
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
    strokeRoute(ctx, nav, path, TRAIN_COLOUR, 3, false);
  }
}

/** Tram line colour, shared by the map line and the legend swatch. */
export const RAIL_COLOUR = '#5ad1c8';
/** Main line colour. Warmer than the tram's, so the two read as two railways. */
export const TRAIN_COLOUR = '#f0a84a';

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
  )), RAIL_COLOUR, 6);
  if (TRAIN_LINE_ENABLED) {
    strokeRoute(ctx, nav, TRAIN_POINTS.map((p) => [p.x, p.z]), TRAIN_COLOUR, 6);
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
  const [expanded, setExpanded] = useState(false);
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
      if (event.code === 'KeyM') setExpanded((open) => !open);
      if (event.code === 'Escape') setExpanded(false);
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

      const beat = (now % 1600) / 1600;
      const pulse = beat < 0.5 ? beat * 2 : 2 - beat * 2;

      // `mapX`/`mapZ`, not `toPixelX`: the prepainted canvas has the raster
      // inset by `MAP_PAD`, and this samples that canvas.
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
        ctx.strokeStyle = HUD.way;
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Waypoint, drawn in map space so it rotates with the world.
      const wp = waypointRef.current;
      if (wp) {
        // `mapX`/`mapZ`, matching `px`/`pz` above. These read `toPixelX`, which
        // is the *unpadded* raster pixel, while the player's position is the
        // padded map pixel — so the marker sat `MAP_PAD` off, about 124 px on a
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
        drawWaypointMarker(ctx, 0.46, pulse);
        ctx.restore();
      }
      ctx.restore();

      // --- overlays that do not rotate ---
      ctx.save();
      ctx.translate(centre, centre);

      // Player, always pointing up — the minimap turns, the car does not.
      drawPlayerMarker(ctx, 0.5, pulse);

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
      const degrees = ((t.heading * 180) / Math.PI + 360) % 360;
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
                fill={HUD.way}
              />
              <circle cx="4.5" cy="4.4" r="1.6" fill="rgba(7,13,20,0.85)" />
            </svg>
            <div
              ref={distanceLabelRef}
              style={{ ...NUM, fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', color: HUD.way }}
            />
          </div>
          <span aria-hidden className="-mr-3 h-6 w-[10px] shrink-0" style={HATCH} />
        </div>
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
                <span className="flex items-center gap-1.5" style={{ color: HUD.way }}>
                  <span className="h-[3px] w-5 rounded-full" style={{ background: HUD.way }} />
                  {routeMetres >= 1000
                    ? `${(routeMetres / 1000).toFixed(1)} KM BY ROAD`
                    : `${Math.round(routeMetres)} M BY ROAD`}
                </span>
              )}
            </span>
            <span className="flex gap-4">
              {hasWaypoint && (
                <button onClick={clearWaypoint} className="tracking-[0.22em] text-[#ffb020] hover:text-white">
                  CLEAR
                </button>
              )}
              <button onClick={() => setExpanded(false)} className="tracking-[0.22em] hover:text-white">
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
        ctx.strokeStyle = HUD.way;
        ctx.lineWidth = 5 * s;
        ctx.stroke();
      }

      // A triangle wave, not a sine: it spends less time at the extremes, so
      // the ring reads as a beat rather than as a slow breath.
      const beat = (performance.now() % 1600) / 1600;
      const pulse = beat < 0.5 ? beat * 2 : 2 - beat * 2;

      const wp = waypointRef.current;
      if (wp) {
        ctx.save();
        ctx.translate(mapX(nav, wp.x), mapZ(nav, wp.z));
        ctx.scale(s, s);
        drawWaypointMarker(ctx, 1, pulse);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(px, pz);
      ctx.scale(s, s);
      ctx.rotate(-t.heading);
      drawPlayerMarker(ctx, 1, pulse);
      ctx.restore();

      // --- overlays, in screen space -------------------------------------
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      x: toWorldX(nav, mx - MAP_PAD),
      z: toWorldZ(nav, mz - MAP_PAD),
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
            style={{ background: 'rgba(7,12,20,0.82)', border: `1px solid ${HUD.way}66`, color: HUD.way }}
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
 * `scale` lets the 196 px minimap use the same drawing at three quarters the
 * size rather than a second, slightly different marker; `pulse` is a 0..1
 * triangle wave from the caller's clock, so both maps breathe in time.
 */
function drawPlayerMarker(ctx: CanvasRenderingContext2D, scale: number, pulse: number) {
  ctx.save();
  ctx.scale(scale, scale);

  /**
   * A cone showing which way the car is pointing.
   *
   * The arrow alone says heading only once you are close enough to see which
   * way it is turned. A beam says it from across the map, and heading is the
   * one thing this marker exists to carry that the route line does not.
   */
  const beam = ctx.createLinearGradient(0, 0, 0, -66);
  beam.addColorStop(0, 'rgba(92,176,255,0.34)');
  beam.addColorStop(1, 'rgba(92,176,255,0)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 66, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
  ctx.closePath();
  ctx.fill();

  const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 44);
  glow.addColorStop(0, 'rgba(92,176,255,0.55)');
  glow.addColorStop(1, 'rgba(92,176,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 44, 0, Math.PI * 2);
  ctx.fill();

  // A ring that swells and fades. The only moving thing on a still map, so the
  // eye finds the car before it finds anything else.
  ctx.strokeStyle = `rgba(92,176,255,${0.6 * (1 - pulse)})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 22 + pulse * 13, 0, Math.PI * 2);
  ctx.stroke();

  /**
   * The arrow, and nothing behind it.
   *
   * There was a dark disc with a white ring under this — the usual way to make
   * a marker survive any background — and it read as a black blob with a
   * speck of blue in it, which is not what the player is. Contrast now comes
   * from a soft shadow cast by the arrow itself and a white edge on it: the
   * shadow holds it off pale streets, the edge holds it off dark water, and
   * the silhouette stays a blue arrow at every zoom.
   */
  ctx.shadowColor = 'rgba(5,9,16,0.85)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#4fa8ff';
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8.5);
  ctx.lineTo(-16, 16);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // A lighter leading face, so the arrow has a front and a back rather than
  // being a flat silhouette.
  ctx.fillStyle = '#9fd0ff';
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2.4;
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

function drawWaypointMarker(ctx: CanvasRenderingContext2D, scale: number, pulse: number) {
  ctx.save();
  ctx.scale(scale, scale);

  // Two rings on the ground: one fixed, so the exact spot is always marked,
  // and one that expands and fades out of it.
  ctx.strokeStyle = 'rgba(255,176,32,0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,176,32,${0.75 * (1 - pulse)})`;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(0, 0, 11 + pulse * 20, 0, Math.PI * 2);
  ctx.stroke();

  // A column of light above the pin. A destination should be findable by
  // sweeping the map rather than by reading it.
  const column = ctx.createLinearGradient(0, -34, 0, -96);
  column.addColorStop(0, 'rgba(255,176,32,0.30)');
  column.addColorStop(1, 'rgba(255,176,32,0)');
  ctx.fillStyle = column;
  ctx.beginPath();
  ctx.moveTo(-7, -34);
  ctx.lineTo(7, -34);
  ctx.lineTo(4, -96);
  ctx.lineTo(-4, -96);
  ctx.closePath();
  ctx.fill();

  const glow = ctx.createRadialGradient(0, -22, 3, 0, -22, 42);
  glow.addColorStop(0, 'rgba(255,176,32,0.45)');
  glow.addColorStop(1, 'rgba(255,176,32,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, -22, 42, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(7,12,20,0.5)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 9, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // The pin floats, a couple of pixels, in time with the rings. Enough to read
  // as alive; not enough to make you doubt where it is pointing.
  const bob = -2 + pulse * 2;
  ctx.translate(0, bob);

  ctx.fillStyle = HUD.way;
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
