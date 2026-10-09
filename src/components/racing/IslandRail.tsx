'use client';

import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { GeometryCollider } from './GeometryCollider';
import { BoxGeometry, BufferGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Matrix4, Quaternion, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AIRPORT_GATE, OUTLINE, PAVING } from '@/config/airportConfig';
import { BRIDGE as SKYLARK_ROAD, TRUNK_CLIMB } from '@/config/countryConfig';
import {
  BALLAST, PF1_NORTH, STATION, STATION_BUILDING, VIADUCT,
  connectionFormation, connectionSamples, crossoverSamples, downLinkSamples, linkFormation,
  pf1Spur, stationLoop, stationPlatforms, trunkCentre, trunkFormation, trunkSamples,
  type Formation, type Sample,
} from '@/config/islandRailConfig';
import { DRACO_PATH } from '@/config/cityConfig';
import { TRAIN } from '@/config/trainConfig';
import { makeBallastTexture } from './CountryRail';
import { RAIL_STEEL, buildLoft, type ProfileVertex } from './railGeometry';
import { SLEEPER_GEOMETRY, SLEEPER_MATERIAL } from './sleeper';
import { InstancedField } from './instancedField';
import { bladedRailProfile, standsAlone } from './switchBlade';
import CourierHub from './CourierHub';
import HarbourEstate from './HarbourEstate';
import StationPetrol from './StationPetrol';
import StationCanopies from './StationCanopies';
import StationForecourt from './StationForecourt';

/**
 * The island line: trunk, connection and link, laid as one railway.
 *
 * ## Why this is not part of `AirportIsland`
 *
 * Because it is not part of the airfield. The trunk begins out over the water,
 * crosses the bridge road and runs past the terminal without belonging to it —
 * and the one thing it must match is not the airfield but the RAILWAY, whose
 * sections live in `trainConfig` and whose switch blades live in `switchBlade`.
 * Drawn here, it shares those with the main line and the station by importing
 * them rather than by copying numbers into an airport's config.
 *
 * It is mounted inside the island's group all the same, so every coordinate
 * here is island-local: `x` is `along`, `z` is `across`, `y` is measured from
 * the crown.
 *
 * ## How the three tracks connect seamlessly
 *
 * Three things have to agree at a join or you can see the seam from the air.
 *
 * **The centreline.** The connection's first sample IS the down main's
 * railhead and its last sample IS a point on the trunk, tangent to it — both
 * solved in `islandRailConfig` rather than eyeballed, so there is no gap to
 * close and no kink to hide.
 *
 * **The section.** A yard road stands on 0.4 m of ballast and a running line
 * on 0.62, which is a 22 cm step in rail height. The connection ramps between
 * them over 40 m — `Sample.depth` — and every profile below reads that depth
 * off the sample rather than from a constant, so the ballast, the sleepers and
 * both rails rise together.
 *
 * **The rail.** Where the link closes onto the connection the two centrelines
 * end up centimetres apart, which drawn plainly is one smeared, z-fighting
 * rail. `bladedRailProfile` shapes the closing rail into a switch blade that
 * lies against the stock rail — tapered, moved inside the gauge face and
 * dropped a little under it. Same blade the station throat uses.
 */

const GAUGE = TRAIN.gauge / 2;
/**
 * Metres of line per texture repeat, and it is `CountryRail`'s nine rather
 * than a number of its own, because the ballast texture is imported from there
 * and bakes this into its own `repeat`. Six would have tiled the same stone
 * half again as coarse as the stone on the country line, in view of it.
 */
const V_SCALE = 9;

/** Rail base above the crown, which is a function of where you are. */
const railBase = (s: Sample) => s.depth + TRAIN.sleeperHeight;

/**
 * The formation, as wide as whatever stands on it.
 *
 * The crown reaches `crownHalf` beyond the outermost track on each side and
 * then batters out to the toe — so a corridor carrying one road is 4.6 m
 * across the crown, the trunk's pair is 9.2, and the junction is as wide as
 * the connection is far out. `lo` and `hi` do all of that; see `Formation`.
 */
const toe = (s: Formation) => BALLAST.line.crownHalf + BALLAST.line.slope * s.depth;
const formationProfile: ProfileVertex<Formation>[] = [
  { off: (s) => s.lo - toe(s), rise: 0 },
  { off: (s) => s.lo - BALLAST.line.crownHalf, rise: (s) => s.depth },
  { off: (s) => s.hi + BALLAST.line.crownHalf, rise: (s) => s.depth },
  { off: (s) => s.hi + toe(s), rise: 0 },
];

/**
 * A rail, tapering into a switch blade wherever the track is closing on another.
 *
 * `bladedRailProfile` works in a frame where the rail head is at 0 and the foot
 * at `-railHeight`; here the head moves with the ballast, so the whole section
 * is lifted by `railBase` and the blade shaping is left untouched.
 */
function railProfile(side: number): ProfileVertex<Sample>[] {
  const blade = bladedRailProfile<Sample>(side * GAUGE);
  const lift = (d: ProfileVertex<Sample>['rise']) => (s: Sample) => (
    (typeof d === 'function' ? d(s) : d) + railBase(s) + TRAIN.railHeight
  );
  return blade.map((v) => ({ off: v.off, rise: lift(v.rise) }));
}

const shore = OUTLINE as ReadonlyArray<readonly [number, number]>;
/** True where a point is on the island rather than over the water. */
function onLand(x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = shore.length - 1; i < shore.length; j = i++) {
    if ((shore[i][1] > z) !== (shore[j][1] > z)
      && x < ((shore[j][0] - shore[i][0]) * (z - shore[i][1])) / (shore[j][1] - shore[i][1]) + shore[i][0]) {
      hit = !hit;
    }
  }
  return hit;
}

// All non-indexed if any is: `mergeGeometries` returns null for a mix, and
// PF1's ramp wedge has no index while boxes and lofts do.
const merge = (parts: BufferGeometry[]) => {
  if (!parts.length) return null;
  const mixed = parts.some((g) => !g.index) && parts.some((g) => g.index);
  return mergeGeometries(mixed ? parts.map((g) => (g.index ? g.toNonIndexed() : g)) : parts, false);
};

/**
 * Lift a trunk-aligned list onto the climb to Skylark.
 *
 * Everything built off `trunkCentre()` is index for index with it — the two
 * roads are the centreline offset, the formation is the centreline widened —
 * so the centre's arc is the one to read the height at. From the island's tip
 * the line rises to meet the Skylark bridge at the joint; see `TRUNK_CLIMB`.
 */
function climbed<T extends { y: number }>(list: T[], centre: Sample[]): T[] {
  return list.map((q, i) => ({ ...q, y: TRUNK_CLIMB.riseAt(centre[Math.min(i, centre.length - 1)].arc) }));
}

function build() {
  const centre = climbed(trunkCentre(), trunkCentre());
  const down = climbed(trunkSamples(-1), centre);
  const up = climbed(trunkSamples(1), centre);
  const crossover = crossoverSamples();

  // Ballast is laid where nothing else carries the track: not over the water,
  // where the viaduct does, and not across the road, where the crossing deck
  // does. A ballast shoulder battering out onto a carriageway is the thing the
  // crossing exists to prevent.
  /*
   * There is no level crossing any more.
   *
   * The line passes UNDER the bridge now, so it crosses no road at grade: the
   * outer road runs to `along` 420 and the trunk only reaches its band of
   * `across` out at 590 and beyond, over the water. Left in, the crossing deck
   * was being lofted out at sea.
   */
  const clearOfRoad = () => true;
  const carried = (a: Formation, b: Formation) => (
    onLand(a.x, a.z) && onLand(b.x, b.z) && clearOfRoad()
  );

  // Three corridors, three beds — not six tracks and six beds. See `Formation`.
  /*
   * The trunk, the yard connection and the down main's link.
   *
   * The connection is back. It was drawn out of the scene while it met the
   * trunk at ninety degrees — two tracks touching, which is a crossing and not
   * a junction, and blades laid into that join nothing. It is solved now and
   * arrives along the trunk rather than across it; see `TURNOUT`.
   */
  const connection = connectionSamples();
  const link = downLinkSamples();
  // The station's up and down loops, one outside each main on the straight —
  // see `STATION`. Level ground, so no climb to apply.
  const downLoop = stationLoop('down');
  const upLoop = stationLoop('up');
  // PF1's spur, straight on from the down loop to a buffer stop by the Wall of Death.
  const spur = pf1Spur();
  const formations: Array<[Formation[], (a: Formation, b: Formation) => boolean]> = [
    [climbed(trunkFormation(), centre), carried],
    [connectionFormation(), carried],
    [linkFormation(), carried],
  ];
  // Everything that runs on it. The centreline is a corridor, not a road.
  const tracks: Sample[][] = [down, up, crossover, connection, link, downLoop, upLoop, spur];

  const ballast: BufferGeometry[] = [];
  const rails: BufferGeometry[] = [];
  const sleepers: Array<{ x: number; z: number; y: number; turn: number }> = [];

  for (const [samples, filter] of formations) {
    const laid = buildLoft(samples, formationProfile, { vScale: V_SCALE, filter });
    if (laid.geometry.getAttribute('position').count) ballast.push(laid.geometry);
    else laid.geometry.dispose();
  }

  for (const samples of tracks) {
    for (const side of [-1, 1]) {
      rails.push(buildLoft(samples, railProfile(side), { vScale: V_SCALE, closed: true }).geometry);
    }
    // Sleepers at the railway's own spacing, square to the track — and none
    // where the track has closed onto another, because there the two are
    // sharing the stock rail's sleepers, which is what a turnout does.
    let next = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      while (next <= b.arc) {
        const t = (next - a.arc) / ((b.arc - a.arc) || 1);
        next += TRAIN.sleeperSpacing;
        if (!standsAlone(a)) continue;
        sleepers.push({
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
          // `SLEEPER_GEOMETRY`'s origin is its UNDERSIDE, so this is the top of
          // the ballast — not `railBase`, which is the top of the sleeper and
          // put every sleeper in the line a full 0.22 m too high, standing
          // over its own rails instead of under them.
          y: a.y + (b.y - a.y) * t + a.depth,
          turn: Math.atan2(b.x - a.x, b.z - a.z),
        });
      }
    }
  }

  /* ------------------------------------------------------------ the viaduct -- */
  /*
   * The 106 m off the north-east corner, on the main line's own deck.
   *
   * The deck's top is set so the sleepers sit on it at exactly the height the
   * ballasted track holds them — `railBase` of a running-line section — so a
   * train crossing the shore does not step up or down. Piers stand on the
   * seabed at the line's own spacing.
   */
  const deckTop = BALLAST.line.depth;
  const deckProfile: ProfileVertex<Sample>[] = [
    { off: -VIADUCT.deckHalf, rise: deckTop - VIADUCT.deckThickness },
    { off: -VIADUCT.deckHalf, rise: deckTop + VIADUCT.parapetHeight },
    { off: -VIADUCT.deckHalf + VIADUCT.parapetWidth, rise: deckTop + VIADUCT.parapetHeight },
    { off: -VIADUCT.deckHalf + VIADUCT.parapetWidth, rise: deckTop },
    { off: VIADUCT.deckHalf - VIADUCT.parapetWidth, rise: deckTop },
    { off: VIADUCT.deckHalf - VIADUCT.parapetWidth, rise: deckTop + VIADUCT.parapetHeight },
    { off: VIADUCT.deckHalf, rise: deckTop + VIADUCT.parapetHeight },
    { off: VIADUCT.deckHalf, rise: deckTop - VIADUCT.deckThickness },
  ];
  const overWater = (a: Sample, b: Sample) => !onLand(a.x, a.z) || !onLand(b.x, b.z);
  const deck = buildLoft(centre, deckProfile, { vScale: V_SCALE, closed: true, filter: overWater });

  const piers: BufferGeometry[] = [];
  const soffit = deckTop - VIADUCT.deckThickness;
  for (let arc = VIADUCT.pierSpacing / 2; arc < centre[centre.length - 1].arc; arc += VIADUCT.pierSpacing) {
    const s = centre.find((q) => q.arc >= arc);
    if (!s || onLand(s.x, s.z)) continue;
    const height = s.y + soffit - VIADUCT.seabed;
    const pier = new BoxGeometry(VIADUCT.pierHalf * 2, height, VIADUCT.pierHalf * 2);
    pier.translate(s.x, VIADUCT.seabed + height / 2, s.z);
    piers.push(pier);
  }

  /* ---------------------------------------------------------- the crossing -- */
  /*
   * One crossing, two tracks. Three panels a track — between the rails and
   * outside each — laid flush with the rail head so a wheel crosses a
   * continuous surface and only the rail stands proud. The same detail the
   * yard's crossings use, and the same reason: a slab over the top buries the
   * rails and a gap in the tarmac is a trench.
   */
  const panels: BufferGeometry[] = [];
  /*
   * The trunk's crossing of the Skylark road, at the island's tip.
   *
   * The road's deck is raised to the rail head there (`TRUNK_ROAD_CROSSING` in
   * `countryConfig`), and on a plain grey deck two rails standing 2 cm proud
   * read as a track that goes UNDER the road. So each track gets the panels
   * the airfield's crossings have — one between the rails, one outside each —
   * a centimetre over the deck and just under the rail head, over the stretch
   * where the track is on the carriageway.
   */
  const roadZ = (PAVING.outerRoad[2] + PAVING.outerRoad[3]) / 2;
  const deckStart = AIRPORT_GATE - SKYLARK_ROAD.halfWidth;
  const onSkylarkRoad = (q: Sample) => q.x <= deckStart + 0.5 && Math.abs(q.z - roadZ) <= SKYLARK_ROAD.halfWidth + 0.6;
  const panelTop = (q: Sample) => railBase(q) + TRAIN.railHeight - 0.008;
  const strip = (from: number, to: number): ProfileVertex<Sample>[] => [
    { off: from, rise: (q) => panelTop(q) - 0.06 }, { off: from, rise: panelTop },
    { off: to, rise: panelTop }, { off: to, rise: (q) => panelTop(q) - 0.06 },
  ];
  const HEAD = 0.04;
  for (const track of [down, up]) {
    for (const [from, to] of [[-GAUGE + HEAD, GAUGE - HEAD], [GAUGE + HEAD, GAUGE + 1.1], [-GAUGE - 1.1, -GAUGE - HEAD]] as const) {
      const laid = buildLoft(track, strip(from, to), {
        vScale: V_SCALE, closed: true, filter: (a, b) => onSkylarkRoad(a) && onSkylarkRoad(b),
      });
      if (laid.geometry.getAttribute('position').count) panels.push(laid.geometry);
      else laid.geometry.dispose();
    }
  }
  /*
   * ONE deck, and it follows the same edges the bed does.
   *
   * There were three — the pair's, the connection's and the link's — and where
   * they overlapped the road grew a plateau of coplanar slabs. The corridor
   * already knows how wide it is here, so the deck is that width: the crossing
   * and the formation cannot disagree because they read the same `lo` and `hi`.
   */

  /* --------------------------------------------------------- the platforms -- */
  /*
   * Four platforms — a side platform outside each loop and an island between
   * each loop and its main — so every track has a face. See `STATION`. Each has
   * a body, a coping and yellow line on every face that meets a track, ramps
   * at both ends, end walls, and lamps; nothing else stands on them, because
   * the station building is the user's.
   *
   * Each is lofted along the line it is laid off (`stationPlatforms`), whose
   * straight runs the platform's whole length, so a face is exactly `edge`
   * off its track. Heights are `CountryRail`'s: 0.92 m over the rail head,
   * dropping 0.7 over the last `ramp` metres.
   */
  const P = STATION.platform;
  const head = (q: Sample) => q.depth + TRAIN.sleeperHeight + TRAIN.railHeight;
  const concrete: BufferGeometry[] = [];
  const coping: BufferGeometry[] = [];
  const yellow: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const bloom: BufferGeometry[] = [];
  /** The spur's buffer stop beam: red and white. */
  const buffer: BufferGeometry[] = [];
  /** PF1's parcel deck and ramp surface: dark, like roadway. */
  const parcelDeck: BufferGeometry[] = [];
  const colliders: Array<{ centre: [number, number, number]; half: [number, number, number]; rotation?: [number, number, number] }> = [];
  /** Where the loops stop being straight: past here a platform laid off one bends with it. */
  const straightTo = STATION.centre + P.length / 2 + STATION.margin;
  for (const plat of stationPlatforms()) {
    // Each platform's own ends: PF1 runs on north (`PF1_NORTH`).
    const onPlatform = (q: Sample) => q.x >= plat.x0 - 0.1 && q.x <= plat.x1 + 0.1;
    const along = (a: Sample, b: Sample) => onPlatform(a) && onPlatform(b);
    const topAt = (q: Sample) => {
      const d = Math.min(q.x - plat.x0, plat.x1 - q.x);
      return head(q) + P.top - 0.7 * Math.max(0, 1 - d / P.ramp);
    };
    const dir = plat.dir;
    const box = (a: number, b: number, lo: ProfileVertex<Sample>['rise'], hi: ProfileVertex<Sample>['rise']): ProfileVertex<Sample>[] => [
      { off: dir * a, rise: lo }, { off: dir * b, rise: lo }, { off: dir * b, rise: hi }, { off: dir * a, rise: hi },
    ];
    const line = plat.line.filter(onPlatform);
    const width = plat.to - plat.from;
    concrete.push(buildLoft(line, box(plat.from, plat.to, -0.35, topAt), { closed: true, filter: along, vScale: 4 }).geometry);
    // A face meets a track on the near side always, and on the far side for
    // an island — the side platform's back is a wall onto the field.
    const island = plat.island;
    const faces: Array<[number, number, number, number]> = [
      [plat.from, plat.from + P.coping, plat.from + 0.72, plat.from + 0.84],
      ...(island ? [[plat.to - P.coping, plat.to, plat.to - 0.84, plat.to - 0.72] as [number, number, number, number]] : []),
    ];
    for (const [c0, c1, y0, y1] of faces) {
      coping.push(buildLoft(line, box(c0, c1, (q) => topAt(q) - 0.01, (q) => topAt(q) + 0.025), { closed: true, filter: along }).geometry);
      yellow.push(buildLoft(line, box(y0, y1, (q) => topAt(q) + 0.02, (q) => topAt(q) + 0.034), { closed: true, filter: along }).geometry);
    }
    const nearest = (x: number) => line.reduce((m, q) => (Math.abs(q.x - x) < Math.abs(m.x - x) ? q : m));
    /** The platform's middle, and a point `off` across it, at `x` — the line may have bent by then. */
    const across = (q: Sample, off: number): [number, number] => [q.x + q.nx * dir * off, q.z + q.nz * dir * off];
    const ref = nearest(STATION.centre);
    const mid = across(ref, (plat.from + plat.to) / 2)[1];
    const platformTop = head(ref) + P.top;
    const endHeight = platformTop - 0.7 + 0.35;
    for (const x of [plat.x0, plat.x1]) {
      const q = nearest(x);
      const [ex, ez] = across(q, (plat.from + plat.to) / 2);
      concrete.push(new BoxGeometry(0.24, endHeight, width).rotateY(Math.atan2(q.nx, q.nz)).translate(ex, -0.35 + endHeight / 2, ez));
    }
    // No lamp posts: the user took them off every platform; the canopies' light strips light them.
    // The straight run is one axis-aligned box; where the line bends (PF1's
    // north end) a box per stretch, turned with it.
    // PF1 runs straight on along its spur, so all of it is the straight run.
    const straightEnd = plat.label === 'PF1' ? plat.x1 : Math.min(plat.x1, straightTo);
    colliders.push({
      centre: [(plat.x0 + straightEnd) / 2, (platformTop - 0.35) / 2, mid],
      half: [(straightEnd - plat.x0) / 2, (platformTop + 0.35) / 2, width / 2],
    });
    const bent = line.filter((q) => q.x >= straightEnd - 1);
    for (let k = 1; k < bent.length; k++) {
      const a = bent[k - 1];
      const b = bent[k];
      const [ax, az] = across(a, (plat.from + plat.to) / 2);
      const [bx, bz] = across(b, (plat.from + plat.to) / 2);
      const len = Math.hypot(bx - ax, bz - az);
      colliders.push({
        centre: [(ax + bx) / 2, (platformTop - 0.35) / 2, (az + bz) / 2],
        half: [len / 2 + 0.05, (platformTop + 0.35) / 2, width / 2],
        rotation: [0, -Math.atan2(bz - az, bx - ax), 0],
      });
    }
    /*
     * PF1's parcel deck and ramp (`PF1_NORTH`). The platform is broadened
     * back toward the road into a drive-on deck, following its back edge as
     * the line bends, and a wide ramp comes down off the deck's back edge
     * into the parcel hub's yard. Deck and ramp are surfaced dark, like
     * roadway; the deck has yellow lines at its drop edges and guard rails
     * wherever it drops to the yard; the ramp has concrete kerbs and
     * handrails and no paint.
     */
    if (plat.label === 'PF1') {
      const Dk = PF1_NORTH.deck;
      const R = PF1_NORTH.ramps[0];
      const h = platformTop;
      const edgeAt = (x: number, off: number) => across(nearest(x), off)[1];
      /** A flat polygon between `z = Dk.back` and the platform line `off` across, from Dk.from to Dk.to, `thick` deep with its top at `y`. */
      const slabTo = (off: number, y: number, thick: number) => {
        const shape = new Shape();
        shape.moveTo(Dk.from, Dk.back);
        shape.lineTo(Dk.to, Dk.back);
        for (let x = Dk.to; x >= Dk.from - 0.01; x -= 2) shape.lineTo(x, edgeAt(x, off));
        return new ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, y, 0);
      };
      concrete.push(slabTo(plat.to - 0.02, h - 0.005, h + 0.35));
      parcelDeck.push(slabTo(plat.from + P.coping, h + 0.012, 0.02));
      // Yellow lines: along the deck's back edge either side of the ramp, and across its two ends.
      for (const [x0, x1] of [[Dk.from, R.from], [R.to, Dk.to]]) {
        yellow.push(new BoxGeometry(x1 - x0, 0.012, 0.15).translate((x0 + x1) / 2, h + 0.024, Dk.back - dir * 0.35));
      }
      // Guard rails where the deck drops to the yard.
      const rail = (x0: number, z0: number, x1: number, z1: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const turn = -Math.atan2(z1 - z0, x1 - x0);
        for (const y of [0.55, 1.05]) steel.push(new BoxGeometry(len, 0.06, 0.06).rotateY(turn).translate((x0 + x1) / 2, h + y, (z0 + z1) / 2));
        const posts = Math.max(1, Math.round(len / 2));
        for (let k = 0; k <= posts; k++) {
          steel.push(new BoxGeometry(0.07, 1.1, 0.07).translate(x0 + ((x1 - x0) * k) / posts, h + 0.55, z0 + ((z1 - z0) * k) / posts));
        }
      };
      const lip = Dk.back - dir * 0.12;
      rail(Dk.from, lip, R.from, lip);
      rail(R.to, lip, Dk.to, lip);
      rail(Dk.from + 0.12, lip, Dk.from + 0.12, edgeAt(Dk.from, plat.to - 0.1));
      rail(Dk.to - 0.12, lip, Dk.to - 0.12, edgeAt(Dk.to, plat.to - 0.1));
      colliders.push({
        centre: [(Dk.from + Dk.to) / 2, (h - 0.35) / 2, (Dk.back + edgeAt(Dk.from, plat.to)) / 2],
        half: [(Dk.to - Dk.from) / 2, (h + 0.35) / 2, Math.abs(edgeAt(Dk.from, plat.to) - Dk.back) / 2],
      });

      // Guard rails along PF1's own back edge past the deck, where it drops
      // to the yard, broken at each ramp that hangs off it.
      {
        const gaps = PF1_NORTH.ramps.filter((r) => !r.onDeck).map((r) => [r.from, r.to] as [number, number]);
        let x0 = Dk.to;
        for (const [g0, g1] of [...gaps, [plat.x1 - 0.3, plat.x1] as [number, number]]) {
          if (g0 > x0 + 1) rail(x0, edgeAt(x0, plat.to - 0.12), g0, edgeAt(g0, plat.to - 0.12));
          x0 = g1;
        }
      }

      // The ramps: solid wedges, their slopes surfaced dark.
      for (const R of PF1_NORTH.ramps) {
        const back = R.onDeck ? Dk.back : edgeAt((R.from + R.to) / 2, plat.to - 0.02);
        const foot = back + dir * R.length;
        const w = R.to - R.from;
        const xc = (R.from + R.to) / 2;
        const slope = Math.atan2(h, R.length);
        const hyp = Math.hypot(h, R.length);
        concrete.push(wedge(R.from, R.to, back, foot, h));
        // Rising toward the platform, which is at −dir from the foot: a
        // positive angle lifts the −z end, so the sign is `dir`'s.
        const tilt = slope * dir;
        parcelDeck.push(new BoxGeometry(w - 0.5, 0.02, hyp).rotateX(tilt).translate(xc, h / 2 + 0.012, (back + foot) / 2));
        for (const k of [-1, 1]) {
          // A plain concrete kerb up each side — no yellow on the ramp, which
          // the user found did not look right — and a handrail on posts.
          const kx = xc + k * (w / 2 - 0.12);
          coping.push(new BoxGeometry(0.24, 0.22, hyp).rotateX(tilt).translate(kx, h / 2 + 0.11, (back + foot) / 2));
          steel.push(new BoxGeometry(0.06, 0.06, hyp).rotateX(tilt).translate(kx, h / 2 + 1.05, (back + foot) / 2));
          for (let q = 0; q <= 8; q++) {
            const t = q / 8;
            steel.push(new BoxGeometry(0.07, 1.0, 0.07).translate(kx, h * (1 - t) + 0.5, back + (foot - back) * t));
          }
        }
        colliders.push({ centre: [xc, h / 2 - 0.15, (back + foot) / 2], half: [w / 2, 0.15, hyp / 2], rotation: [tilt, 0, 0] });
      }
    }
  }

  // No buffer stop: the spur runs on into the down main ahead (`PF1_SPUR.join`).

  return {
    platform: {
      concrete: merge(concrete), coping: merge(coping), yellow: merge(yellow), steel: merge(steel), bloom: merge(bloom),
      deckTop: merge(parcelDeck), buffer: merge(buffer),
      colliders,
    },
    ballast: merge(ballast),
    rails: merge(rails),
    deck: deck.geometry.getAttribute('position').count ? deck.geometry : null,
    piers: merge(piers),
    panels: merge(panels),
    sleepers,
    stats: {
      trunk: centre[centre.length - 1].arc,
      crossover: crossover[crossover.length - 1].arc,
      viaduct: (centre.find((s) => onLand(s.x, s.z))?.arc ?? 0),
    },
  };
}

/**
 * A solid wedge from `top` metres high along `z = back` to the ground along
 * `z = foot`, between `x0` and `x1`: PF1's vehicle ramp.
 */
function wedge(x0: number, x1: number, back: number, foot: number, top: number): BufferGeometry {
  const v = [
    [x0, 0, back], [x1, 0, back], [x1, top, back], [x0, top, back], [x0, 0, foot], [x1, 0, foot],
  ];
  // Slope, back wall, bottom, two sides — wound either way; the material is double-sided.
  const tris = [[3, 2, 5], [3, 5, 4], [0, 1, 2], [0, 2, 3], [0, 4, 5], [0, 5, 1], [0, 3, 4], [1, 5, 2]];
  const g = new BufferGeometry();
  const pos = tris.flat().flatMap((i) => v[i]);
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  // UVs too, so it merges with the boxes and lofts, which have them.
  g.setAttribute('uv', new Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.computeVertexNormals();
  return g;
}

/**
 * The sleepers, instanced — there are several thousand of them.
 *
 * Through `InstancedField`, like every other piece of track in the game, and
 * not as one bare `instancedMesh`. That is not tidiness: an `InstancedMesh`
 * with no bounding sphere of its own is culled against its GEOMETRY's sphere —
 * one sleeper, about a metre across, sitting at the world origin — while this
 * line is off at x ≈ -2700. So the whole line's sleepers were drawn only when
 * the camera happened to have the origin in frustum and vanished the moment it
 * looked away, which is exactly what "the sleepers disappear at certain angles"
 * is. The rails and the ballast are ordinary merged meshes with honest bounds,
 * so they never blinked and the track looked like bare rail on stone.
 *
 * `InstancedField` computes a sphere per chunk, which fixes the disappearing
 * and culls the far end of the line into the bargain.
 */
function Sleepers({ at }: { at: Array<{ x: number; z: number; y: number; turn: number }> }) {
  const matrices = useMemo(() => {
    const position = new Vector3();
    const quaternion = new Quaternion();
    const axis = new Vector3(0, 1, 0);
    const scale = new Vector3(1, 1, 1);
    return at.map((s) => {
      quaternion.setFromAxisAngle(axis, s.turn);
      position.set(s.x, s.y, s.z);
      return new Matrix4().compose(position, quaternion, scale);
    });
  }, [at]);
  if (!matrices.length) return null;
  return (
    <InstancedField
      matrices={matrices}
      geometry={SLEEPER_GEOMETRY}
      material={SLEEPER_MATERIAL}
      castShadow
    />
  );
}

useGLTF.preload(STATION_BUILDING.model, DRACO_PATH);

/**
 * The station building, the user's model, behind PF1 — see `STATION_BUILDING`.
 * Solid to a box the size of its footprint: nothing drives into it and nothing
 * goes inside, so a box is the whole of what the collider needs to be.
 */
function StationBuilding() {
  const { scene } = useGLTF(STATION_BUILDING.model, DRACO_PATH);
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => { if ('isMesh' in o && o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return copy;
  }, [scene]);
  const B = STATION_BUILDING;
  // One clone per copy: a primitive can only be mounted once.
  const copies = useMemo(() => B.copies.map(() => model.clone(true)), [model, B.copies]);
  return (
    <group position={[B.along, 0, B.across]} rotation={[0, B.turn, 0]}>
      {B.copies.map((c, i) => (
        // A negative scale mirrors it; three flips the winding for a mirrored
        // matrix, and the baked materials are double-sided besides.
        <group key={i} position={[c.dx, 0, 0]} scale={[(c.mirror ? -1 : 1) * B.scale, B.scale, B.scale]}>
          <primitive object={copies[i]} />
        </group>
      ))}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[B.span / 2, B.height / 2, B.depth / 2]} position={[0, B.height / 2, 0]} />
      </RigidBody>
    </group>
  );
}

export default function IslandRail() {
  const built = useMemo(() => build(), []);
  /*
   * The main line's own stone, imported rather than mixed here.
   *
   * It was a flat `#6b6259` and from the lineside that reads as a poured
   * concrete strip, not as ballast. `CountryRail` already draws the tile the
   * rest of the world's track stands on — the country line, the mine's
   * sidings — so this takes the same one, and `V_SCALE` matches its nine so
   * the stone is the same size in both.
   */
  const stone = useMemo(() => makeBallastTexture(), []);

  useEffect(() => {
    const s = built.stats;
    console.info(
      `[island line] ${s.trunk.toFixed(0)} m of double track (${s.viaduct.toFixed(0)} m on viaduct), `
      + `${s.crossover.toFixed(0)} m crossover; both ends open, yard not yet joined`,
    );
    return () => {
      stone.dispose();
      built.ballast?.dispose();
      built.rails?.dispose();
      built.deck?.dispose();
      built.piers?.dispose();
      built.panels?.dispose();
      for (const g of [built.platform.concrete, built.platform.coping, built.platform.yellow, built.platform.steel, built.platform.bloom, built.platform.deckTop, built.platform.buffer]) g?.dispose();
    };
  }, [built, stone]);

  return (
    <group>
      {built.ballast && (
        <mesh geometry={built.ballast} receiveShadow castShadow>
          <meshStandardMaterial map={stone} roughness={0.95} side={DoubleSide} />
        </mesh>
      )}
      <GeometryCollider geometry={built.ballast} />
      {built.deck && (
        <mesh geometry={built.deck} receiveShadow castShadow>
          <meshStandardMaterial color="#b9b6ae" roughness={0.9} side={DoubleSide} />
        </mesh>
      )}
      {built.piers && (
        <mesh geometry={built.piers} receiveShadow castShadow>
          <meshStandardMaterial color="#a8a59d" roughness={0.92} />
        </mesh>
      )}
      {/* The viaduct out over the water to the Skylark line — deck, parapets
          and piers — solid as drawn. It was only ever drawn. */}
      <GeometryCollider geometry={[built.deck, built.piers]} />
      {built.panels && (
        <mesh geometry={built.panels} receiveShadow>
          {/* Concrete, not asphalt grey: on a tarmac deck a panel the colour
              of the road is invisible, and the crossing read as a track that
              went under the road rather than across it. */}
          <meshStandardMaterial color="#a8a59c" roughness={0.92} />
        </mesh>
      )}
      {/* The station's island platform — see `STATION`. Same finishes as
          Skylark's platforms, so the two railways read as one. */}
      {built.platform.concrete && (
        <mesh geometry={built.platform.concrete} castShadow receiveShadow>
          {/* The body's faces and ramps: mid concrete, darker than the paving on top (`StationCanopies`). */}
          <meshStandardMaterial color="#908d86" roughness={0.92} side={DoubleSide} />
        </mesh>
      )}
      {built.platform.coping && (
        <mesh geometry={built.platform.coping} receiveShadow>
          <meshStandardMaterial color="#ece8de" roughness={0.8} side={DoubleSide} />
        </mesh>
      )}
      {built.platform.yellow && (
        <mesh geometry={built.platform.yellow}>
          <meshStandardMaterial color="#e6c227" roughness={0.6} side={DoubleSide} />
        </mesh>
      )}
      {built.platform.buffer && (
        <mesh geometry={built.platform.buffer} castShadow>
          <meshStandardMaterial color="#c8281e" roughness={0.5} />
        </mesh>
      )}
      {built.platform.deckTop && (
        <mesh geometry={built.platform.deckTop} receiveShadow>
          <meshStandardMaterial color="#4a4d52" roughness={0.9} side={DoubleSide} />
        </mesh>
      )}
      {built.platform.steel && (
        <mesh geometry={built.platform.steel} castShadow>
          <meshStandardMaterial color="#6d7378" roughness={0.45} metalness={0.5} />
        </mesh>
      )}
      {built.platform.bloom && (
        <mesh geometry={built.platform.bloom}>
          <meshStandardMaterial color="#fff3d6" emissive="#ffe2a8" emissiveIntensity={0.6} />
        </mesh>
      )}
      <RigidBody type="fixed" colliders={false}>
        {built.platform.colliders.map((c, i) => (
          <CuboidCollider key={i} args={c.half} position={c.centre} rotation={c.rotation} friction={1} />
        ))}
      </RigidBody>
      <StationBuilding />
      <StationForecourt />
      <StationCanopies />
      <CourierHub />
      <HarbourEstate />
      <StationPetrol />
      <Sleepers at={built.sleepers} />
      {built.rails && <mesh geometry={built.rails} material={RAIL_STEEL} castShadow receiveShadow />}
    </group>
  );
}
