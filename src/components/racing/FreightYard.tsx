'use client';

import { useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TRAIN } from '@/config/trainConfig';
import {
  CROSSINGS, DEPOT, MARKS, SIDINGS, SILOS, YARD,
} from '@/config/airportConfig';

/**
 * Halcyon East: the freight terminal's own structures.
 *
 * Everything in here stands on ground `AirportIsland` has already paved and
 * tracked — the running shed over two of its roads, the bulk terminal at the
 * head of its neck, and the lights and paint where its yard apron crosses the
 * rails. It is a separate file because the island's own is nineteen hundred
 * lines and none of this needs anything from it but numbers.
 *
 * Two things that were here are deliberately NOT: the crossing decks, which
 * are built into the island's own paving so they wear the apron's material
 * rather than one of their own, and the terminal's boundary, which is the
 * airfield's own masonry wall carried round by `PERIMETER.spur`.
 *
 * ## It is built in the airport's palette, deliberately
 *
 * A freight terminal drawn honestly is brick, soot and rust. This one is
 * sheeted in the same grey as the hangars, marked out in the same paint as
 * the taxiways and lit by the same floodlights as the cargo stand, because it
 * is a hundred metres from an airliner and has to look like it belongs to the
 * same place. The shapes are a railway's; the finish is the airfield's.
 *
 * ## Everything is a merged box
 *
 * One draw call per material, and there are seven. Nothing here is a model —
 * a shed is a slab and two pitches, a silo is a cylinder on a cone on six
 * legs, and a mesh fence is a post repeated four hundred times. Drawn as
 * separate meshes this would be most of the island's draw calls; merged it is
 * fewer than the container stacks.
 */

/** Where the railhead is, which is what a level crossing has to be flush with. */
const RAIL_TOP = SIDINGS.ballast.depth + TRAIN.sleeperHeight + TRAIN.railHeight;
/** Paint, a centimetre over whatever it is painted on. */
const PAINT = 0.072;

/**
 * Merge, and say so when it fails.
 *
 * `mergeGeometries` returns null when the set it is given disagrees about its
 * attributes or its index, and a null geometry is simply not rendered — so
 * the failure mode is a building that is not there, with nothing in the scene
 * to say why. It logs to the console, but into a stream with three hundred
 * lines of load reporting in it. Naming the group turns "index 2 of
 * something" into "the shed's cladding", which is the difference between a
 * minute and an afternoon.
 */
const merge = (parts: BufferGeometry[], what: string): BufferGeometry | null => {
  if (!parts.length) return null;
  const out = mergeGeometries(parts, false);
  if (!out) console.error(`[terminal] ${what}: ${parts.length} pieces would not merge`);
  return out;
};

/** A box by its two opposite corners in (along, across) and its height band. */
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): BoxGeometry {
  const g = new BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A flat painted strip, a centimetre over the surface under it. */
const stripe = (x0: number, x1: number, z0: number, z1: number) => (
  box(x0, x1, PAINT - 0.01, PAINT, z0, z1)
);

/**
 * A vertical panel standing in the (along, height) plane at one `across`.
 *
 * Two triangles per face and no thickness, drawn double-sided — which is all
 * a gable end is from any distance you would see one from, and saves carrying
 * a 300 mm edge round a shape that is behind a locomotive anyway.
 */
function panel(points: Array<[number, number]>, at: number): BufferGeometry {
  const g = new BufferGeometry();
  const position: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    for (const p of [points[0], points[i], points[i + 1]]) position.push(p[0], p[1], at);
  }
  const count = position.length / 3;
  g.setAttribute('position', new Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2));
  // Indexed, and not optional: `mergeGeometries` refuses a set where some
  // geometries carry an index and some do not, and it refuses it SILENTLY as
  // far as the scene is concerned — it returns null and the whole merged mesh
  // simply is not drawn. Every `BoxGeometry` beside this one is indexed, so
  // this is too, even though the index is 0..n-1 and buys nothing else.
  g.setIndex(Array.from({ length: count }, (_, i) => i));
  g.computeVertexNormals();
  return g;
}

/**
 * The running shed.
 *
 * Two roads through it, open at both ends, and the openings are the reason
 * the whole thing is drawn rather than dropped in as a model: a shed with
 * shut doors is a box with a locomotive hidden inside it. The doorway is the
 * full width of both roads under a head beam at 5.6 m, and the gable above it
 * is one triangle.
 *
 * The frame reads through the cladding the way a real portal shed's does —
 * columns proud of the sheeting every 10 m, a ridge capping and an eaves
 * rail — and a continuous roof light runs down each pitch, which is what
 * stops a grey roof reading as a grey rectangle.
 */
function buildShed() {
  const D = DEPOT;
  const x0 = D.roads[0] - D.margin;
  const x1 = D.roads[1] + D.margin;
  const ridgeAt = (x0 + x1) / 2;
  const pitch = Math.atan2(D.ridge - D.eaves, ridgeAt - x0);
  const slope = Math.hypot(ridgeAt - x0, D.ridge - D.eaves);

  const sheet: BufferGeometry[] = [];
  const frame: BufferGeometry[] = [];
  const roof: BufferGeometry[] = [];
  const light: BufferGeometry[] = [];

  // The two long flanks, sheeted from the slab to the eaves.
  for (const face of [x0, x1] as const) {
    const side = face === x0 ? 1 : -1;
    sheet.push(box(face, face + side * 0.3, 0, D.eaves, D.from, D.to));
    // Portal columns, proud of the sheeting so the frame reads from outside.
    for (let z = D.from; z <= D.to + 0.01; z += D.bay) {
      frame.push(box(
        face - side * 0.12, face + side * (0.12 + D.column),
        0, D.eaves + 0.25, z - D.column, z + D.column,
      ));
    }
    // The eaves rail, and the lean-to's roof where there is one.
    frame.push(box(face - side * 0.2, face + side * 0.45, D.eaves - 0.35, D.eaves, D.from, D.to));
  }

  // The roof: two pitches, each a slab tilted about the across axis.
  for (const side of [-1, 1] as const) {
    const deck = new BoxGeometry(slope, 0.22, D.to - D.from);
    deck.rotateZ(side * pitch);
    deck.translate(ridgeAt - side * (ridgeAt - x0) / 2, (D.eaves + D.ridge) / 2, (D.from + D.to) / 2);
    roof.push(deck);
    // A continuous roof light a third of the way up the slope.
    const strip = new BoxGeometry(slope * D.roofLight, 0.26, (D.to - D.from) * 0.86);
    strip.rotateZ(side * pitch);
    const at = 0.52;
    strip.translate(
      ridgeAt - side * (ridgeAt - x0) * at,
      D.ridge - (D.ridge - D.eaves) * at + 0.02,
      (D.from + D.to) / 2,
    );
    light.push(strip);
  }
  // The ridge capping.
  roof.push(box(ridgeAt - 0.5, ridgeAt + 0.5, D.ridge, D.ridge + 0.28, D.from, D.to));

  // Both gables: a head beam over the opening, and the triangle above it.
  for (const end of [D.from, D.to] as const) {
    frame.push(box(x0, x1, D.head, D.head + 0.9, end - 0.16, end + 0.16));
    sheet.push(panel([
      [x0, D.head + 0.9], [x0, D.eaves], [ridgeAt, D.ridge], [x1, D.eaves], [x1, D.head + 0.9],
    ], end));
  }

  // The lean-to down the east flank: stores, mess and the fitters' shop.
  const ax = x1 + D.annexe.deep;
  sheet.push(box(x1, ax, 0, D.annexe.height, D.from, D.to));
  roof.push(box(x1, ax + 0.4, D.annexe.height, D.annexe.height + 0.2, D.from, D.to));
  for (let z = D.from + 4; z < D.to - 2; z += 7.5) {
    light.push(box(ax, ax + 0.06, 1.6, 3.1, z, z + 3.4));
  }

  return {
    sheet: merge(sheet, 'shed cladding'), frame: merge(frame, 'shed frame'),
    roof: merge(roof, 'shed roof'), light: merge(light, 'shed glazing'),
    bounds: { x0, x1: ax },
  };
}

/**
 * The bulk terminal: three silos, a head tower and the conveyor between them.
 *
 * Tall on purpose. The rest of this terminal is flat — track, concrete and
 * containers, none of it over 9 m — and a yard reads as nothing from the air
 * unless something in it has height. Twenty-six metres is the tallest thing
 * on the island bar the control tower, and from the runway it is what says
 * there is an industry at the east end rather than a car park.
 *
 * A silo is a cylinder on a discharge cone on six legs, which is exactly what
 * the geometry is: nothing here is stylised, it is just short of segments.
 */
function buildSilos() {
  const S = SILOS;
  const legTop = S.legs.height;
  const coneTop = legTop + S.cone;
  const barrelTop = coneTop + S.height;
  const top = barrelTop + S.roof + 1.4;

  const barrel: BufferGeometry[] = [];
  const cone: BufferGeometry[] = [];
  const leg: BufferGeometry[] = [];
  const gantry: BufferGeometry[] = [];
  const grate: BufferGeometry[] = [];

  for (const z of S.at) {
    const shell = new CylinderGeometry(S.radius, S.radius, S.height, 24);
    shell.translate(S.along, coneTop + S.height / 2, z);
    barrel.push(shell);
    const ring = new CylinderGeometry(S.radius + 0.16, S.radius + 0.16, 0.34, 24);
    ring.translate(S.along, barrelTop - 0.3, z);
    barrel.push(ring);
    // The roof cap, and the discharge cone under the barrel.
    const cap = new CylinderGeometry(0.9, S.radius, S.roof, 24);
    cap.translate(S.along, barrelTop + S.roof / 2, z);
    cone.push(cap);
    const hopper = new CylinderGeometry(S.radius, 0.7, S.cone, 24);
    hopper.translate(S.along, legTop + S.cone / 2, z);
    cone.push(hopper);
    for (let k = 0; k < S.legs.count; k++) {
      const a2 = (k / S.legs.count) * Math.PI * 2;
      const lx = S.along + Math.cos(a2) * S.radius * 0.82;
      const lz = z + Math.sin(a2) * S.radius * 0.82;
      leg.push(box(
        lx - S.legs.half, lx + S.legs.half, 0, legTop + S.cone * 0.4,
        lz - S.legs.half, lz + S.legs.half,
      ));
    }
  }

  // The elevator leg at the south end of the row, and its head house.
  const T = S.tower;
  leg.push(box(T.along - T.half, T.along + T.half, 0, top, T.across - T.half, T.across + T.half));
  gantry.push(box(
    T.along - T.half - 0.4, T.along + T.half + 0.4, top, top + 2.2,
    T.across - T.half - 0.4, T.across + T.half + 0.4,
  ));

  // The covered intake, from the pit beside the track to the foot of the leg.
  const I = S.intake;
  gantry.push(box(
    I.from, I.to, I.height - I.width / 2, I.height + I.width / 2,
    I.across - I.width / 2, I.across + I.width / 2,
  ));
  for (const x of [I.to - 1, (I.from + I.to) / 2] as const) {
    leg.push(box(x - 0.2, x + 0.2, 0, I.height, I.across - 0.2, I.across + 0.2));
  }

  // And the conveyor along the silo tops, off the head of the leg.
  const bridgeY = barrelTop + S.roof + 0.2;
  gantry.push(box(
    S.along - S.conveyor.width / 2, S.along + S.conveyor.width / 2,
    bridgeY, bridgeY + S.conveyor.deep, S.conveyor.from, S.conveyor.to,
  ));

  // The discharge pit: a grating between road 437's rails, flush with the rail.
  const P = S.pit;
  grate.push(box(P.road - P.half, P.road + P.half, RAIL_TOP - 0.12, RAIL_TOP, P.from, P.to));
  for (let z = P.from; z < P.to; z += 2.4) {
    grate.push(box(P.road - P.half - 0.3, P.road + P.half + 0.3, RAIL_TOP, RAIL_TOP + 0.06, z, z + 0.3));
  }

  return {
    barrel: merge(barrel, 'silo barrels'), cone: merge(cone, 'silo cones'),
    leg: merge(leg, 'silo legs'), gantry: merge(gantry, 'conveyor'),
    grate: merge(grate, 'discharge pit'), top,
  };
}

/**
 * The level crossings, where the yard apron runs over the five roads.
 *
 * Three panels a road — one between the rails and one outside each — laid
 * flush with the railhead, so a wheel crosses a continuous surface and the
 * only thing standing proud is the rail itself. That flushness is the whole
 * detail: a crossing drawn as one slab over the top buries the rails, and a
 * crossing drawn as a gap in the tarmac is a trench.
 *
 * A red lamp on a post faces each approach. Nothing moves; a yard crossing
 * is worked by sight, and five sets of falling barriers across a forty-metre
 * apron would be a fence rather than a road.
 */
function buildCrossings() {
  const C = CROSSINGS;

  const paint: BufferGeometry[] = [];
  const post: BufferGeometry[] = [];
  const lamp: BufferGeometry[] = [];

  // Two approaches a band, not two a rail. Each band is one crossing — 70 m
  // of continuous deck — so it gets a stop line and a pair of lamps at either
  // end, the way a real multi-track crossing is signed. A set per rail would
  // have been ten lamp posts down the middle of a yard road.
  for (const lane of C.lanes) {
    const crossed = SIDINGS.roads.filter((r) => !lane.roads || lane.roads.includes(r.at));
    if (!crossed.length) continue;
    const ends = crossed.map((r) => r.at);
    const toes = [
      Math.min(...ends) - C.panel - C.ramp,
      Math.max(...ends) + C.panel + C.ramp,
    ] as const;

    for (const side of [-1, 1] as const) {
      const toe = side < 0 ? toes[0] : toes[1];
      const back = toe + side * (C.lamp.out + 0.6);
      paint.push(stripe(back - 0.3, back + 0.3, lane.from + 1.5, lane.to - 1.5));
      for (const at of [lane.from + 1.4, lane.to - 1.4] as const) {
        post.push(box(
          back - C.lamp.post, back + C.lamp.post, 0, C.lamp.height,
          at - C.lamp.post, at + C.lamp.post,
        ));
        lamp.push(box(back - 0.3, back + 0.3, C.lamp.height, C.lamp.height + 0.5, at - 0.22, at + 0.22));
      }
    }
  }
  return {
    paint: merge(paint, 'crossing paint'),
    post: merge(post, 'crossing posts'), lamp: merge(lamp, 'crossing lamps'),
  };
}

/**
 * The yard apron's markings, in the airfield's own two colours.
 *
 * This is what replaced the modular road kit, and it is the whole argument
 * for doing so: an airfield marks a route across a surface with paint rather
 * than building a separate road on it, so the yard apron is edged in taxiway
 * yellow with a dashed white spine, and it reads as part of the same field as
 * the apron it runs off.
 */
function buildYardPaint() {
  const yellow: BufferGeometry[] = [];
  const white: BufferGeometry[] = [];
  const W = MARKS.edgeWidth;
  const road = CROSSINGS.lanes[0];

  /*
   * The lorry route, edged in taxiway yellow.
   *
   * Three legs and they join up: the yard road east along the terminal's
   * south side, the aisle north through the container stacks, and the north
   * apron at the head of it. Edging the whole route rather than each apron
   * separately is the point — it is what turns four paved rectangles into one
   * way through that a driver can follow without being told where the next
   * one starts. The silo road up the west side is edged with them because it
   * is the same kind of thing, even though it is a spur rather than part of
   * the run.
   */
  const AISLE = [496, 514] as const;
  const legs: Array<readonly [number, number, number, number]> = [
    [YARD.headland[0], YARD.lorryPark[1], road.from, road.to],
    [AISLE[0], AISLE[1], YARD.hardstanding[2], YARD.hardstanding[3]],
    [YARD.siloRoad[0], YARD.siloRoad[1], YARD.siloRoad[2], YARD.siloRoad[3]],
  ];
  for (const [x0, x1, z0, z1] of legs) {
    const long = x1 - x0 > z1 - z0;
    for (const at of long ? [z0 + 1.5, z1 - 1.5] : [x0 + 1.5, x1 - 1.5]) {
      yellow.push(long
        ? stripe(x0, x1, at - W / 2, at + W / 2)
        : stripe(at - W / 2, at + W / 2, z0, z1));
    }
  }

  // The yard road's dashed spine, broken over the crossing — a centre line is
  // not painted across a railway anywhere.
  const spine = (road.from + road.to) / 2;
  const ends = SIDINGS.roads.map((r) => r.at);
  const deck = [
    Math.min(...ends) - CROSSINGS.panel - CROSSINGS.ramp,
    Math.max(...ends) + CROSSINGS.panel + CROSSINGS.ramp,
  ];
  const x0 = YARD.headland[0];
  const x1 = YARD.lorryPark[1];
  for (let x = x0 + 4; x < x1 - 4; x += MARKS.centreDash / 2 + MARKS.centreGap / 2) {
    const to = Math.min(x + MARKS.centreDash / 2, x1 - 4);
    if (to > deck[0] - 3 && x < deck[1] + 3) continue;
    white.push(stripe(x, to, spine - MARKS.centreWidth / 2, spine + MARKS.centreWidth / 2));
  }

  /*
   * No turning ring any more: the apron it was painted on has gone.
   *
   * It marked a circle a lorry drove round instead of reversing, and it was on
   * the north apron — which sat at across 152..192 and fell outside the wall
   * once the boundary came back off the bridge to (520, 138). The turn it
   * existed for moved to the head of the hardstanding, which is inside the
   * wall and already surfaced.
   */

  // Bay markings down the container hardstanding, one line per stack lane.
  const [, hx1, hz0, hz1] = YARD.hardstanding;
  for (let x = AISLE[1] + 4; x < hx1 - 4; x += 16) yellow.push(stripe(x, x + 0.4, hz0 + 3, hz1 - 3));

  // The lorry park: bays across the apron's east end, and a head line to
  // reverse up to. White, because these are road markings rather than
  // aircraft guidance and the field's yellow means something specific.
  const P = CROSSINGS.park;
  for (let x = P.from; x <= P.to + 0.01; x += P.bay) {
    white.push(stripe(x - 0.16, x + 0.16, P.at, P.at + P.deep));
  }
  white.push(stripe(P.from, P.to, P.at + P.deep - 0.32, P.at + P.deep));
  return { yellow: merge(yellow, 'yard paint, yellow'), white: merge(white, 'yard paint, white') };
}

export function FreightYard() {
  const built = useMemo(() => ({
    shed: buildShed(),
    silos: buildSilos(),
    crossings: buildCrossings(),
    paint: buildYardPaint(),
  }), []);

  useEffect(() => {
    console.info(`[terminal] running shed ${DEPOT.to - DEPOT.from} m over roads `
      + `${DEPOT.roads.join(' & ')}, ${SILOS.at.length} silos to `
      + `${built.silos.top.toFixed(1)} m, ${SIDINGS.roads.length} level crossings`);
  }, [built]);

  useEffect(() => () => {
    for (const group of Object.values(built)) {
      for (const g of Object.values(group)) {
        if (g && typeof g === 'object' && 'dispose' in g) (g as BufferGeometry).dispose();
      }
    }
  }, [built]);

  const D = DEPOT;
  const S = SILOS;

  return (
    <>
      {/* The running shed, over roads 476 and 488 — see `DEPOT`. */}
      {built.shed.sheet && (
        <mesh geometry={built.shed.sheet} castShadow receiveShadow>
          <meshStandardMaterial color={D.colours.sheet} roughness={0.72} metalness={0.12} side={DoubleSide} />
        </mesh>
      )}
      {built.shed.frame && (
        <mesh geometry={built.shed.frame} castShadow receiveShadow>
          <meshStandardMaterial color={D.colours.frame} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {built.shed.roof && (
        <mesh geometry={built.shed.roof} castShadow receiveShadow>
          <meshStandardMaterial color={D.colours.roof} roughness={0.8} metalness={0.15} />
        </mesh>
      )}
      {built.shed.light && (
        <mesh geometry={built.shed.light}>
          <meshStandardMaterial
            color={D.colours.light}
            emissive={D.colours.light}
            emissiveIntensity={0.16}
            roughness={0.35}
          />
        </mesh>
      )}

      {/* The bulk terminal at the head of the neck — see `SILOS`. */}
      {built.silos.barrel && (
        <mesh geometry={built.silos.barrel} castShadow receiveShadow>
          <meshStandardMaterial color={S.colours.barrel} roughness={0.62} metalness={0.3} />
        </mesh>
      )}
      {built.silos.cone && (
        <mesh geometry={built.silos.cone} castShadow receiveShadow>
          <meshStandardMaterial color={S.colours.cone} roughness={0.68} metalness={0.28} />
        </mesh>
      )}
      {built.silos.leg && (
        <mesh geometry={built.silos.leg} castShadow receiveShadow>
          <meshStandardMaterial color={S.colours.leg} roughness={0.7} metalness={0.3} />
        </mesh>
      )}
      {built.silos.gantry && (
        <mesh geometry={built.silos.gantry} castShadow receiveShadow>
          <meshStandardMaterial color={S.colours.gantry} roughness={0.65} metalness={0.3} />
        </mesh>
      )}
      {built.silos.grate && (
        <mesh geometry={built.silos.grate} receiveShadow>
          <meshStandardMaterial color={S.colours.grate} roughness={0.85} metalness={0.4} />
        </mesh>
      )}

      {/* The level crossings' lights and paint. The decks themselves are laid
          with the island's own paving, so they wear the apron's material —
          see `buildYardTrack`. */}
      {built.crossings.post && (
        <mesh geometry={built.crossings.post} castShadow receiveShadow>
          <meshStandardMaterial color={CROSSINGS.colours.post} roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      {built.crossings.lamp && (
        <mesh geometry={built.crossings.lamp}>
          <meshStandardMaterial
            color={CROSSINGS.colours.lamp}
            emissive={CROSSINGS.colours.lamp}
            emissiveIntensity={0.7}
            roughness={0.4}
          />
        </mesh>
      )}
      {built.crossings.paint && (
        <mesh geometry={built.crossings.paint}>
          <meshStandardMaterial color={MARKS.colour} roughness={0.8} />
        </mesh>
      )}

      {/* The yard apron's own markings, in the airfield's two colours. */}
      {built.paint.yellow && (
        <mesh geometry={built.paint.yellow}>
          <meshStandardMaterial color={MARKS.taxiColour} roughness={0.8} />
        </mesh>
      )}
      {built.paint.white && (
        <mesh geometry={built.paint.white}>
          <meshStandardMaterial color={MARKS.colour} roughness={0.8} />
        </mesh>
      )}

      {/*
        What a car meets. The shed is its two flanks and its lean-to — the
        doorways are left open, because the whole point of them is that you
        can drive a locomotive through. The silos are their legs and the
        elevator leg is solid. The boundary is not here: it is the airfield's
        own wall, and `AirportIsland` already gives every run of it a box.
      */}
      <RigidBody type="fixed" colliders={false}>
        {[built.shed.bounds.x0, D.roads[1] + D.margin].map((face, i) => (
          <CuboidCollider
            key={`shed-${i}`}
            args={[0.35, D.eaves / 2, (D.to - D.from) / 2]}
            position={[face, D.eaves / 2, (D.from + D.to) / 2]}
          />
        ))}
        <CuboidCollider
          args={[D.annexe.deep / 2, D.annexe.height / 2, (D.to - D.from) / 2]}
          position={[
            D.roads[1] + D.margin + D.annexe.deep / 2,
            D.annexe.height / 2,
            (D.from + D.to) / 2,
          ]}
        />
        {SILOS.at.map((z) => (
          <CuboidCollider
            key={`silo-${z}`}
            args={[SILOS.radius * 0.8, (SILOS.legs.height + SILOS.cone) / 2, SILOS.radius * 0.8]}
            position={[SILOS.along, (SILOS.legs.height + SILOS.cone) / 2, z]}
          />
        ))}
        <CuboidCollider
          args={[SILOS.tower.half, built.silos.top / 2, SILOS.tower.half]}
          position={[SILOS.tower.along, built.silos.top / 2, SILOS.tower.across]}
        />

      </RigidBody>
    </>
  );
}
