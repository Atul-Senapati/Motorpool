'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CuboidCollider, RigidBody, TrimeshCollider, type RapierRigidBody } from '@react-three/rapier';
import {
  BackSide, BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry,
  CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, PlaneGeometry, Quaternion,
  RepeatWrapping, RingGeometry, SRGBColorSpace, TorusGeometry, Vector2, Vector3, type Object3D,
  Color, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SITE } from '@/config/airportConfig';
import { DRACO_PATH } from '@/config/cityConfig';
import bikerData from '@/config/bikerData.json';
import catalogue from '@/config/vehicleCatalogue.json';
import {
  APRON, DRUM, FURNITURE, GALLERY, PARKED_CARS, PORTAL, SHOW, STAIRS, WOD_COLOURS, WOD_SITE, type Rider,
} from '@/config/wallOfDeathConfig';
import { offerPortal, requestTeleport } from '@/physics/portals';

/**
 * The Wall of Death, drawn.
 *
 * Everything that stands still is boxes, cylinders, rings and tori merged into
 * one geometry per material — fourteen draw calls for the whole attraction.
 * Everything that moves is a transform: a rider on the wall is a point on a
 * circle at a height that breathes, turned so its wheels press the timber,
 * and the wheels themselves spin about their own axles. No physics body is
 * involved in the show; see `wallOfDeathConfig` for the numbers.
 *
 * ## The player rides it too
 *
 * The inside of the drum — the curved bank and the wall — and the outside
 * skin are ONE trimesh collider, built from the same geometry that is drawn,
 * so what you see is exactly what the wheels ride, and there is no seam in it
 * anywhere: the drum is closed all the way round. The floor is not in it: the
 * slab is flush with the forecourt and the island's crown under it is the
 * ground, as it is under every other paving on the airfield.
 *
 * You get in through a portal, not a door — see `Portal` and
 * `physics/portals`. A door was tried and taken out: a slot through the bank
 * is a wall you hit once a lap, and a door that shuts behind you is a
 * mechanism where a marker on the ground does the job in one keypress.
 *
 * ## The frame
 *
 * Built about the drum's centre, `x`/`z` in the island's `along`/`across`
 * and `y` up from the crown, then placed at `WOD_SITE` inside the island's
 * group. The forecourt is at `-z`, toward the road.
 */

const P = DRUM.plinth.height;
const R = DRUM.radius;
const B = DRUM.bank;
/** The wall's angle from horizontal, radians. 90° is a true wall of death. */
const SLOPE = (DRUM.slope * Math.PI) / 180;
/**
 * Top of the bank, where the straight wall — and the ridden height — begins.
 * The bank starts at y = 0, the crown the wheels actually ride, NOT at the
 * slab's top: a bank that began 6 cm up put a lip at its foot that every car
 * hit at speed. The slab overlaps the first half-metre of it to hide the seam.
 */
const KICK_TOP = B * (1 - Math.cos(SLOPE));
/** Where the floor ends and the bank begins. */
const FLOOR_R = R - B * Math.sin(SLOPE);
/** Top of the wall, which is the gallery deck. */
const TOP = KICK_TOP + DRUM.wall;
/** How far out the wall's top stands from its foot: the flare of a leaning wall. */
const FLARE = DRUM.wall / Math.tan(SLOPE);
const TOP_R = R + FLARE;
/** The riding surface's radius at height `y`. */
const rideAt = (y: number) => (y <= KICK_TOP ? R : R + (y - KICK_TOP) / Math.tan(SLOPE));
const SKIN_R = R + DRUM.skin;
const TOP_SKIN_R = TOP_R + DRUM.skin;
const DECK_OUT = TOP_SKIN_R + GALLERY.width;
const SEG = 160;

const box = (w: number, h: number, d: number, x: number, y: number, z: number): BoxGeometry => {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

/** A flat ring in the XZ plane at height `y`, facing up (or down). */
const ring = (r0: number, r1: number, y: number, down = false): RingGeometry => {
  const g = new RingGeometry(r0, r1, SEG);
  g.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
  g.translate(0, y, 0);
  return g;
};

/** A horizontal hoop: the handrails and the LED ring under the canopy. */
const hoop = (r: number, tube: number, y: number): TorusGeometry => {
  const g = new TorusGeometry(r, tube, 8, SEG);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
};

/**
 * An open drum wall between two heights. `planks` scales the u coordinate so
 * a texture repeats that many times round the circle.
 */
function shell(rTop: number, rBottom: number, y0: number, y1: number, planks = 0): CylinderGeometry {
  const g = new CylinderGeometry(rTop, rBottom, y1 - y0, SEG, 1, true);
  g.translate(0, (y0 + y1) / 2, 0);
  if (planks) scaleU(g, planks);
  return g;
}

/** Stretch a geometry's u so a texture repeats `times` across it. */
function scaleU(g: BufferGeometry, times: number) {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * times);
  uv.needsUpdate = true;
}

const merge = (parts: BufferGeometry[], what: string): BufferGeometry | null => {
  if (!parts.length) return null;
  const out = mergeGeometries(parts, false);
  if (!out) console.error(`[wall-of-death] ${what}: ${parts.length} pieces would not merge`);
  for (const p of parts) p.dispose();
  return out;
};

/* ------------------------------------------------------------- the structure */

function buildStructure() {
  const plinth: BufferGeometry[] = [];
  const apron: BufferGeometry[] = [];
  const floor: BufferGeometry[] = [];
  const floorMark: BufferGeometry[] = [];
  const timber: BufferGeometry[] = [];
  const bankTimber: BufferGeometry[] = [];
  const skin: BufferGeometry[] = [];
  const skinWall: BufferGeometry[] = [];
  const brass: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const steel: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const cool: BufferGeometry[] = [];
  const canopy: BufferGeometry[] = [];
  const deck: BufferGeometry[] = [];
  const kiosk: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const signBack: BufferGeometry[] = [];

  /* The ground: plinth, riding floor and its marks, forecourt and path. */
  const plinthR = R + DRUM.plinth.margin;
  const pl = new CylinderGeometry(plinthR, plinthR, P, SEG);
  pl.translate(0, P / 2, 0);
  plinth.push(pl);
  const floorR = FLOOR_R;
  // Half a metre onto the bank, whose first centimetres are below the slab's top.
  const fl = new CircleGeometry(floorR + 0.5, SEG);
  fl.rotateX(-Math.PI / 2);
  fl.translate(0, P + 0.02, 0);
  floor.push(fl);
  floorMark.push(ring(floorR - 1.3, floorR - 1.0, P + 0.03));
  const hub = new CircleGeometry(1.1, 32);
  hub.rotateX(-Math.PI / 2);
  hub.translate(0, P + 0.03, 0);
  floorMark.push(hub);
  const apronFrom = -(plinthR);
  const apronTo = apronFrom - APRON.depth;
  apron.push(box(APRON.half * 2, APRON.top, APRON.depth, 0, APRON.top / 2, (apronFrom + apronTo) / 2));
  const pathTo = APRON.path.to - WOD_SITE.across;
  // The way in from the road — only if the forecourt does not already reach it.
  if (apronTo - pathTo > 0.3) {
    apron.push(box(
      APRON.path.half * 2, APRON.top, apronTo - pathTo, 0, APRON.top / 2, (apronTo + pathTo) / 2,
    ));
  }

  /* The drum: bank and wall inside, panelling and ribs outside, coping on top. */
  // Texture repeats round the drum: one tile is eight 18 cm boards.
  const planks = Math.round((Math.PI * 2 * R) / (0.18 * BOARDS_PER_TILE));
  /*
   * The bank: an arc from the floor, tangent to it, up to the wall, tangent
   * to that — revolved all the way round. It sweeps `SLOPE` rather than a
   * right angle, because the wall it meets is not vertical; the profile is
   * what a car's suspension has to follow, and it has no corner in it.
   * Twenty-eight steps and 160 segments, so a wheel crossing a facet edge
   * feels a fraction of a degree rather than a kerb.
   */
  const profile: Vector2[] = [];
  const BANK_STEPS = 28;
  for (let i = 0; i <= BANK_STEPS; i++) {
    const a = (i / BANK_STEPS) * SLOPE;
    profile.push(new Vector2(FLOOR_R + B * Math.sin(a), B * (1 - Math.cos(a))));
  }
  const bank = new LatheGeometry(profile, SEG);
  scaleU(bank, planks);
  bankTimber.push(bank);
  timber.push(shell(TOP_R, R, KICK_TOP, TOP, planks));
  // Two flat colours, split where the plumb foot meets the leaning wall: the
  // foot in the primary, the wall in the secondary, and the canopy in the
  // primary again to bookend it. The design is in the proportions and in
  // three lines — the ribs, the light ring, the canopy — not in the surface.
  skin.push(shell(SKIN_R, SKIN_R, P, KICK_TOP));
  skinWall.push(shell(TOP_SKIN_R, SKIN_R, KICK_TOP, TOP));
  /* What the car meets: the inside of the drum and the skin, seamless. */
  const collision = merge(
    [bank.clone(), shell(TOP_R, R, KICK_TOP, TOP), shell(SKIN_R, SKIN_R, P, KICK_TOP),
      shell(TOP_SKIN_R, SKIN_R, KICK_TOP, TOP)],
    'collision surface',
  );
  brass.push(ring(TOP_R - 0.02, TOP_SKIN_R + 0.06, TOP + 0.01));
  // Ribs: a plumb length up the drum's foot, then a length leaning with the wall.
  const wallLen = Math.hypot(TOP - KICK_TOP, FLARE);
  for (let i = 0; i < DRUM.ribs.count; i++) {
    const a = (i / DRUM.ribs.count) * Math.PI * 2;
    const foot = new BoxGeometry(DRUM.ribs.width, KICK_TOP - P, DRUM.ribs.depth);
    foot.translate(0, (P + KICK_TOP) / 2, SKIN_R + DRUM.ribs.depth / 2);
    foot.rotateY(a);
    brass.push(foot);
    const lean = new BoxGeometry(DRUM.ribs.width, wallLen, DRUM.ribs.depth);
    lean.rotateX(Math.PI / 2 - SLOPE);
    lean.translate(0, (KICK_TOP + TOP) / 2, (SKIN_R + TOP_SKIN_R) / 2 + DRUM.ribs.depth / 2);
    lean.rotateY(a);
    brass.push(lean);
  }
  // A slim moulding where the plumb foot meets the leaning wall.
  trim.push(shell(rideAt(KICK_TOP + 0.1) + DRUM.skin + 0.16, rideAt(KICK_TOP - 0.1) + DRUM.skin + 0.16, KICK_TOP - 0.1, KICK_TOP + 0.1));
  // ONE ring of light, high on the wall, at the skin's radius where it sits.
  const t = DRUM.bands.thick;
  const y = P + DRUM.bands.high;
  accent.push(shell(rideAt(y + t / 2) + DRUM.skin + 0.1, rideAt(y - t / 2) + DRUM.skin + 0.1, y - t / 2, y + t / 2));

  /* The gallery: deck, fascia, rails. */
  deck.push(ring(TOP_SKIN_R - 0.05, DECK_OUT, TOP));
  deck.push(ring(TOP_SKIN_R, DECK_OUT, TOP - GALLERY.deck, true));
  deck.push(shell(DECK_OUT, DECK_OUT, TOP - GALLERY.deck, TOP));
  const railTop = TOP + GALLERY.rail.height;
  const outerRailR = DECK_OUT - 0.08;
  const innerRailR = TOP_R + 0.12;
  steel.push(hoop(outerRailR, 0.04, railTop), hoop(outerRailR, 0.03, TOP + GALLERY.rail.height / 2));
  steel.push(hoop(innerRailR, 0.04, railTop - 0.1), hoop(innerRailR, 0.03, TOP + 0.45));
  const posts = Math.round(360 / GALLERY.rail.postEvery);
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    for (const r of [outerRailR, innerRailR]) {
      steel.push(box(0.06, GALLERY.rail.height, 0.06, r * Math.sin(a), TOP + GALLERY.rail.height / 2, r * Math.cos(a)));
    }
  }

  /* The canopy: columns, brim, edge fascia and the cool LED ring under it. */
  const C = GALLERY.canopy;
  const colR = TOP_SKIN_R + C.columnAt;
  const brimAt = (r: number) => C.lowAt + ((r - (TOP_R + C.innerAt)) / (C.outerAt - C.innerAt)) * (C.highAt - C.lowAt);
  const colH = brimAt(colR);
  for (let i = 0; i < C.columns; i++) {
    const a = (i / C.columns) * Math.PI * 2 + Math.PI / C.columns;
    const g = new BoxGeometry(0.24, colH, 0.24);
    g.rotateY(a);
    g.translate(colR * Math.sin(a), TOP + colH / 2, colR * Math.cos(a));
    brass.push(g);
  }
  canopy.push(shell(TOP_R + C.outerAt, TOP_R + C.innerAt, TOP + C.lowAt, TOP + C.highAt));
  // A plain, thin edge to the brim, in the skin's own colour.
  trim.push(shell(TOP_R + C.outerAt + 0.02, TOP_R + C.outerAt + 0.02, TOP + C.highAt - 0.3, TOP + C.highAt));
  cool.push(hoop(colR + 0.5, 0.06, TOP + brimAt(colR + 0.5) - 0.12));

  /* The stairs: treads on two stringers, a landing onto the deck, a pad below. */
  const steps = Math.ceil((TOP - P) / STAIRS.rise);
  const run = steps * STAIRS.going;
  const stairIn = DECK_OUT + 0.2;
  const stairC = stairIn + STAIRS.width / 2;
  const slope = Math.atan2(TOP - P, run);
  const stringerLen = Math.hypot(run, TOP - P) + 0.4;
  for (const phi of STAIRS.at) {
    const place = new Matrix4().makeRotationY(phi).setPosition(
      stairC * Math.sin(phi), 0, stairC * Math.cos(phi),
    );
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < steps; i++) {
      parts.push(box(STAIRS.going, 0.08, STAIRS.width, -run / 2 + (i + 0.5) * STAIRS.going, P + (i + 1) * STAIRS.rise - 0.04, 0));
    }
    for (const s of [-1, 1]) {
      const z = s * (STAIRS.width / 2 - 0.03);
      for (const [h, up] of [[0.28, 0], [0.05, 1.0]] as const) {
        const g = new BoxGeometry(stringerLen, h, 0.06);
        g.rotateZ(slope);
        g.translate(0, (P + TOP) / 2 + up, z);
        parts.push(g);
      }
      // Balusters carrying the handrail, one every fourth step.
      for (let i = 2; i < steps; i += 4) {
        const x = -run / 2 + (i + 0.5) * STAIRS.going;
        parts.push(box(0.05, 1.0, 0.05, x, P + (i + 1) * STAIRS.rise + 0.5, z));
      }
    }
    // The landing bridges from the top tread to the deck's edge.
    const landingD = STAIRS.width + 0.5;
    parts.push(box(1.9, GALLERY.deck, landingD, run / 2 + 0.95, TOP - GALLERY.deck / 2, -0.25));
    for (const s of [-1, 1]) {
      parts.push(box(0.22, TOP - GALLERY.deck - P, 0.22, run / 2 + 1.7, (P + TOP) / 2, s * (STAIRS.width / 2 - 0.1)));
    }
    // A column under the middle of the flight.
    parts.push(box(0.22, (TOP - P) / 2, 0.22, 0, P + (TOP - P) / 4, 0));
    for (const g of parts) g.applyMatrix4(place);
    steel.push(...parts);
    const pad = box(run + 3, 0.1, STAIRS.width + 1.2, 0, 0.05, 0);
    pad.applyMatrix4(place);
    apron.push(pad);
  }

  /* The sign pylon, the marquee on the front and the ticket kiosk. */
  const F = FURNITURE;
  /*
   * The totem: one slim upright slab at the forecourt's corner, the name
   * stacked down its top half and a hairline of light up one edge. It
   * replaced a 20 m pylon carrying a 9 m billboard, which was a motorway
   * hoarding on a fairground; a totem is how a modern venue signs itself.
   */
  const T = F.pylon;
  signBack.push(box(T.board.width, T.height, T.post, T.dx, APRON.top + T.height / 2, T.dz));
  accent.push(box(0.08, T.height - 0.8, T.post + 0.04, T.dx - T.board.width / 2 - 0.02, APRON.top + T.height / 2, T.dz));
  const boardY = APRON.top + T.height - T.board.height / 2 - 0.4;
  const marqueeZ = -(SKIN_R + DRUM.ribs.depth + 0.2);
  const marqueeY = P + DRUM.bands.low + F.marquee.over + F.marquee.height / 2;
  signBack.push(box(F.marquee.width + 0.3, F.marquee.height + 0.3, 0.14, 0, marqueeY, marqueeZ));

  const K = F.kiosk;
  kiosk.push(box(K.width, K.height, K.depth, K.dx, APRON.top + K.height / 2, K.dz));
  trim.push(box(K.width + 0.6, 0.16, K.depth + 0.6, K.dx, APRON.top + K.height + 0.08, K.dz));
  const win = new PlaneGeometry(K.width - 0.7, 0.9);
  win.rotateY(Math.PI);
  win.translate(K.dx, APRON.top + 1.55, K.dz - K.depth / 2 - 0.02);
  glass.push(win);
  steel.push(box(K.width - 0.5, 0.06, 0.4, K.dx, APRON.top + 1.06, K.dz - K.depth / 2 - 0.2));

  return {
    geometry: {
      plinth: merge(plinth, 'plinth'),
      apron: merge(apron, 'apron'),
      floor: merge(floor, 'floor'),
      floorMark: merge(floorMark, 'floor marks'),
      timber: merge(timber, 'timber'),
      bankTimber: merge(bankTimber, 'bank timber'),
      skin: merge(skin, 'skin'),
      skinWall: merge(skinWall, 'wall skin'),
      brass: merge(brass, 'brass'),
      trim: merge(trim, 'trim'),
      steel: merge(steel, 'steel'),
      accent: merge(accent, 'LED bands'),
      cool: merge(cool, 'canopy ring'),
      canopy: merge(canopy, 'canopy'),
      deck: merge(deck, 'deck'),
      kiosk: merge(kiosk, 'kiosk'),
      glass: merge(glass, 'glass'),
      signBack: merge(signBack, 'sign backs'),
    },
    signs: {
      board: { x: F.pylon.dx, y: boardY, z: F.pylon.dz, w: F.pylon.board.width - 0.16, h: F.pylon.board.height, depth: F.pylon.post },
      marquee: { x: 0, y: marqueeY, z: marqueeZ - 0.08, w: F.marquee.width, h: F.marquee.height },
    },
    stairs: { run, centre: stairC },
    collision: collision && trimeshOf(collision),
  };
}

/** A geometry as the two arrays a `TrimeshCollider` takes. */
const trimeshOf = (g: BufferGeometry) => ({
  vertices: new Float32Array(g.getAttribute('position').array),
  indices: new Uint32Array(g.getIndex()!.array),
});

/* ----------------------------------------------------------------- portals */

/** A halo's glow: solid at the foot, gone at the top. */
function makeHalo(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 128, 0, 0);
    // Strong at the foot, gone by two thirds of the way up: the chase camera
    // rides at about 2.5 m, and a glow that still has body there tints the
    // whole frame orange the moment the car is in the marker.
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.3)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 128);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * One halo marker, and the teleport it offers.
 *
 * A glowing open cylinder on the ground that breathes, with a ring at its
 * foot. Every frame it reads the player's chassis, turns the position into the
 * drum's frame, and while the car's centre is inside `PORTAL.radius` it puts
 * the offer up on the HUD strip and listens for Enter. Enter asks the chassis
 * to move the car to `landing` — see `physics/portals` — and the marker then
 * ignores the car for `PORTAL.cooldown` seconds so the halo it lands in does
 * not fire straight back.
 *
 * The player's world position is read here, not in the parent, because there
 * are two of these and each only cares about its own zone.
 */
function Portal({ at, colour, offer, landing, playerBodyRef, halo }: {
  at: readonly [number, number];
  colour: string;
  offer: { label: string; note: string };
  /** Where Enter puts the car, in the drum's frame: x, z and the way it faces (radians, `+x` is 0). */
  landing: { x: number; z: number; face: number };
  playerBodyRef?: RefObject<RapierRigidBody | null>;
  halo: CanvasTexture;
}) {
  const glow = useRef<Mesh>(null);
  const inside = useRef(false);
  const cooldown = useRef(0);
  // Offset by where the marker stands, so the two halos do not breathe in step.
  const phase = useRef(at[0] * 0.7 + at[1] * 0.3);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Enter' || !inside.current || cooldown.current > 0) return;
      const h = SITE.heading;
      const turn = WOD_SITE.turn;
      // Drum → island → world, the inverse of the read below.
      const ax = landing.x * Math.cos(turn) + landing.z * Math.sin(turn) + WOD_SITE.along;
      const az = -landing.x * Math.sin(turn) + landing.z * Math.cos(turn) + WOD_SITE.across;
      const wx = SITE.centre[0] + ax * Math.cos(h) + az * Math.sin(h);
      const wz = SITE.centre[1] - ax * Math.sin(h) + az * Math.cos(h);
      // The facing, as a world direction, then as the chassis's yaw: the
      // vehicle convention is `atan2(dx, dz)` aiming +Z along travel.
      const fx = Math.cos(landing.face + turn);
      const fz = -Math.sin(landing.face + turn);
      const dx = fx * Math.cos(h) + fz * Math.sin(h);
      const dz = -fx * Math.sin(h) + fz * Math.cos(h);
      requestTeleport({ position: [wx, SITE.ground + 0.6, wz], heading: Math.atan2(dx, dz) });
      cooldown.current = PORTAL.cooldown;
      inside.current = false;
      offerPortal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [landing]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    phase.current += delta;
    if (glow.current) {
      const s = 1 + 0.04 * Math.sin(phase.current * 2.2);
      glow.current.scale.set(s, 1, s);
      glow.current.rotation.y += delta * 0.3;
    }
    if (cooldown.current > 0) cooldown.current -= delta;
    const body = playerBodyRef?.current;
    if (!body) return;
    const t = body.translation();
    const h = SITE.heading;
    const dx = t.x - SITE.centre[0];
    const dz = t.z - SITE.centre[1];
    // World → island (along, across) → the drum's own frame.
    const ax = dx * Math.cos(h) - dz * Math.sin(h) - WOD_SITE.along;
    const az = dx * Math.sin(h) + dz * Math.cos(h) - WOD_SITE.across;
    const turn = WOD_SITE.turn;
    const x = ax * Math.cos(turn) - az * Math.sin(turn);
    const z = ax * Math.sin(turn) + az * Math.cos(turn);
    const near = cooldown.current <= 0
      && Math.hypot(x - at[0], z - at[1]) < PORTAL.radius
      && t.y - SITE.ground < 3;
    if (near !== inside.current) {
      inside.current = near;
      offerPortal(near ? offer : null);
    }
  });

  return (
    <group position={[at[0], APRON.top, at[1]]}>
      <mesh ref={glow} position={[0, PORTAL.height / 2, 0]}>
        <cylinderGeometry args={[PORTAL.radius, PORTAL.radius, PORTAL.height, 48, 1, true]} />
        {/* Plain alpha, not additive: additive glow disappears against a
            sunlit concrete forecourt and only showed up against the dark
            drum, where it read as a doorway. */}
        <meshBasicMaterial
          color={colour}
          map={halo}
          transparent
          opacity={0.55}
          side={DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[PORTAL.radius - 0.35, PORTAL.radius, 64]} />
        <meshBasicMaterial color={colour} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* --------------------------------------------------------------- textures */

/** How many boards one repeat of the timber texture carries. */
const BOARDS_PER_TILE = 16;

/**
 * The riding surface: vertical boards, eight to a tile, each its own tone.
 *
 * A wall of death is built of boards because a curve can be, and the boards
 * are what you see — no two the same colour, a dark seam between each pair,
 * and grain running the long way. So the tile draws eight of them from a
 * small palette of honey-to-walnut tones, lays long wavering grain lines over
 * each, and darkens the seams. `scuffed` adds the band of rubber the riders
 * leave: on the wall it sits where the tyres run, and it is the one thing
 * that says the wall is ridden rather than just built.
 */
function makeTimber(scuffed: boolean): CanvasTexture {
  const W = 1024;
  const HGT = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = HGT;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = scuffed ? 7 : 19;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    const tones = ['#c48d55', '#b57d48', '#a96f3d', '#cd9862', '#9f6636', '#bb8650', '#b0764a', '#c9905a'];
    const bw = W / BOARDS_PER_TILE;
    for (let b = 0; b < BOARDS_PER_TILE; b++) {
      const x0 = b * bw;
      ctx.fillStyle = tones[Math.floor(rnd() * tones.length)];
      ctx.fillRect(x0, 0, bw, HGT);
      // Grain: long, slightly wandering lines, lighter and darker than the board.
      for (let g = 0; g < 26; g++) {
        const dark = rnd() < 0.55;
        ctx.strokeStyle = dark ? `rgba(60,32,10,${0.10 + rnd() * 0.18})` : `rgba(255,225,170,${0.06 + rnd() * 0.12})`;
        ctx.lineWidth = 0.6 + rnd() * 1.6;
        const gx = x0 + 3 + rnd() * (bw - 6);
        const wander = (rnd() - 0.5) * 6;
        ctx.beginPath();
        ctx.moveTo(gx, -10);
        ctx.bezierCurveTo(gx + wander, HGT * 0.33, gx - wander, HGT * 0.66, gx + wander * 0.5, HGT + 10);
        ctx.stroke();
      }
      // A knot or two, now and then.
      if (rnd() < 0.35) {
        const kx = x0 + 8 + rnd() * (bw - 16);
        const ky = rnd() * HGT;
        const kr = 3 + rnd() * 5;
        const knot = ctx.createRadialGradient(kx, ky, 0, kx, ky, kr * 2.2);
        knot.addColorStop(0, 'rgba(70,38,14,0.75)');
        knot.addColorStop(0.5, 'rgba(90,50,20,0.35)');
        knot.addColorStop(1, 'rgba(90,50,20,0)');
        ctx.fillStyle = knot;
        ctx.fillRect(kx - kr * 3, ky - kr * 3, kr * 6, kr * 6);
      }
      // The seam: a dark gap with a lit edge, so the boards read as boards.
      ctx.fillStyle = 'rgba(40,22,8,0.85)';
      ctx.fillRect(x0, 0, 2.5, HGT);
      ctx.fillStyle = 'rgba(255,235,200,0.18)';
      ctx.fillRect(x0 + 2.5, 0, 1.5, HGT);
    }
    // Rubber: a soft dark band across the boards where the tyres run, with
    // streaks along the direction of travel — horizontal on this tile, which
    // is round the drum.
    if (scuffed) {
      const band = ctx.createLinearGradient(0, HGT * 0.22, 0, HGT * 0.78);
      band.addColorStop(0, 'rgba(30,26,24,0)');
      band.addColorStop(0.3, 'rgba(30,26,24,0.2)');
      band.addColorStop(0.55, 'rgba(30,26,24,0.28)');
      band.addColorStop(1, 'rgba(30,26,24,0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, HGT * 0.22, W, HGT * 0.56);
      // Drawn twice, a tile apart, so a streak that runs off the right edge
      // comes back in on the left and the tile has no seam in it.
      for (let k = 0; k < 110; k++) {
        const y = HGT * (0.3 + rnd() * 0.42);
        ctx.strokeStyle = `rgba(20,18,18,${0.05 + rnd() * 0.16})`;
        ctx.lineWidth = 0.8 + rnd() * 2.2;
        const x = rnd() * W;
        const len = 60 + rnd() * 420;
        const dy = (rnd() - 0.5) * 3;
        for (const off of [0, -W]) {
          ctx.beginPath();
          ctx.moveTo(x + off, y);
          ctx.lineTo(x + off + len, y + dy);
          ctx.stroke();
        }
      }
    } else {
      // The bank collects dust at its foot rather than rubber.
      const dust = ctx.createLinearGradient(0, 0, 0, HGT * 0.35);
      dust.addColorStop(0, 'rgba(120,105,80,0.28)');
      dust.addColorStop(1, 'rgba(120,105,80,0)');
      ctx.fillStyle = dust;
      ctx.fillRect(0, 0, W, HGT * 0.35);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A lit sign: the title, and a subtitle when there is room for one. */
function makeSign(w: number, h: number, title: string, sub?: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round((1024 * h) / w);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const H = canvas.height;
    ctx.fillStyle = WOD_COLOURS.sign.back;
    ctx.fillRect(0, 0, 1024, H);
    ctx.strokeStyle = WOD_COLOURS.sign.sub;
    ctx.lineWidth = 10;
    ctx.strokeRect(14, 14, 996, H - 28);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = WOD_COLOURS.sign.text;
    const titleSize = sub ? H * 0.42 : H * 0.62;
    ctx.font = `900 ${titleSize}px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif`;
    ctx.fillText(title, 512, sub ? H * 0.36 : H * 0.52);
    if (sub) {
      ctx.fillStyle = WOD_COLOURS.sign.sub;
      ctx.font = `700 ${H * 0.24}px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif`;
      ctx.fillText(sub, 512, H * 0.75);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The totem's face: the name stacked in three words, a rule, the name in its
 * own tongue small beneath, and nothing else. Portrait, so it is drawn at a
 * fixed width and as tall as the slab's proportions ask.
 */
function makeTotem(w: number, h: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const H = canvas.height;
    ctx.fillStyle = WOD_COLOURS.sign.back;
    ctx.fillRect(0, 0, 512, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = WOD_COLOURS.sign.text;
    ctx.font = `900 190px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif`;
    const line = 205;
    const top = H * 0.16;
    for (const [i, word] of ['WALL', 'OF', 'DEATH'].entries()) ctx.fillText(word, 256, top + i * line);
    ctx.fillStyle = WOD_COLOURS.sign.sub;
    ctx.fillRect(96, top + 3 * line - 60, 320, 8);
    ctx.font = `700 58px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif`;
    ctx.fillText('MAUT KA KUAN', 256, top + 3 * line + 20);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ riders */

const BIKERS_MODEL = '/models/bikers.glb';
const VEHICLES_MODEL = '/models/vehicles.glb';
useGLTF.preload(BIKERS_MODEL, DRACO_PATH);
useGLTF.preload(VEHICLES_MODEL, DRACO_PATH);

/** A rider's machine: the drawn object, its wheels to spin, and the tyre radius. */
export interface Machine {
  root: Object3D;
  wheels: Object3D[];
  wheelRadius: number;
}

/**
 * One of the two bikers, from `bikers.glb` — see `prepare-bikers.mjs`. The
 * node arrives facing −Z with its origin at the tyre contact between the
 * wheels and each wheel on its own axle node, which is everything the ride
 * needs from it.
 */
function bikerMachine(scene: Object3D, who: 'male' | 'female'): Machine {
  const src = scene.getObjectByName(who);
  const root = src ? src.clone(true) : new Group();
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  const wheels = ['wheelFront', 'wheelRear']
    .map((n) => root.getObjectByName(n))
    .filter((o): o is Object3D => !!o);
  return { root, wheels, wheelRadius: bikerData[who].wheelRadius };
}

/**
 * One of the city's traffic cars, as a single drawn object.
 *
 * `vehicles.glb` is tagged the way `Traffic` reads it — `userData.vehicle`
 * and `userData.part` on every mesh, `body` once and `wheel` once — and the
 * catalogue carries the hubs. Body at the origin, the one wheel mesh cloned
 * to each hub, so this is the same car the city drives, standing still.
 */
export function trafficMachine(scene: Object3D, name: string, tint?: string): Machine {
  const entry = (catalogue.vehicles as Array<{
    name: string; wheelRadius: number; hubs: number[][];
  }>).find((v) => v.name === name);
  const root = new Group();
  const wheels: Object3D[] = [];
  let wheelSource: Mesh | null = null;
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const tag = o.userData as { vehicle?: string; part?: string };
    if (tag.vehicle !== name) return;
    if (tag.part === 'body') {
      // A repaint clones the bodywork's materials and recolours them; the
      // glass and the lamps keep their own.
      const material = tint ? repaint(o.material, tint) : o.material;
      const m = new Mesh(o.geometry, material);
      m.castShadow = true;
      m.receiveShadow = true;
      root.add(m);
    } else if (tag.part === 'wheel') {
      wheelSource = o;
    }
  });
  if (wheelSource && entry) {
    for (const hub of entry.hubs) {
      const w = new Mesh((wheelSource as Mesh).geometry, (wheelSource as Mesh).material);
      w.position.set(hub[0], hub[1], hub[2]);
      w.castShadow = true;
      root.add(w);
      wheels.push(w);
    }
  }
  return { root, wheels, wheelRadius: entry?.wheelRadius ?? 0.33 };
}

/** The pack's materials in a new colour, except the ones that are not paint. */
function repaint(material: Material | Material[], tint: string): Material | Material[] {
  const one = (m: Material): Material => {
    if (/glass|optic|window|light|lamp|chrome|tyre|tire|wheel/i.test(m.name)) return m;
    const copy = m.clone();
    if ('color' in copy && copy.color instanceof Color) copy.color.set(tint);
    return copy;
  };
  return Array.isArray(material) ? material.map(one) : one(material);
}

/** A traffic car's footprint, from the catalogue: width, height, length. */
export function vehicleSize(name: string): [number, number, number] {
  const entry = (catalogue.vehicles as Array<{ name: string; size: number[] }>).find((v) => v.name === name);
  const size = entry?.size ?? [1.8, 1.5, 4.4];
  return [size[0], size[1], size[2]];
}

/** Standard gravity, for the lean. */
const G = 9.81;

/**
 * One rider on the wall, with the physics a wall-of-death rider actually has.
 *
 * On a vertical wall the tyres carry the machine's weight sideways: the wall
 * pushes in with `m v² / R` and friction holds the weight up. In the rider's
 * own frame the two add to ONE apparent gravity, pointing into the wall and
 * down, and the rider sits along it exactly as a road rider sits along real
 * gravity. So the machine's up is the negative of
 *
 *     g_app = (0, −g, 0) + (v² / R) · u_outward
 *
 * which leans it up the wall by `atan(g R / v²)` from the wall's normal — a
 * third of a right angle at 65 km/h on this drum, which is what the real
 * shows look like, and the reason a slow rider falls: as `v` drops the lean
 * goes past horizontal and there is no wall under the wheels any more.
 *
 * The contact patch is the model's origin, so the tyres ride at radius `R`
 * and the body leans inward from there. The height follows the rider's own
 * wave, a pitch about the axles tips the nose up by the wave's slope, and
 * the wheels spin at `v / r`.
 */
function WallRider({ rider, machine, clock }: {
  rider: Rider; machine: Machine; clock: RefObject<number>;
}) {
  const group = useRef<Group>(null);
  const scratch = useMemo(() => ({
    m: new Matrix4(), q: new Quaternion(), p: new Quaternion(),
    x: new Vector3(), up: new Vector3(), z: new Vector3(), axle: new Vector3(1, 0, 0),
  }), []);
  const omega = rider.speed / rideAt(KICK_TOP + (rider.band.low + rider.band.high) / 2);

  useFrame((_, rawDelta) => {
    const g = group.current;
    if (!g) return;
    const delta = Math.min(rawDelta, 1 / 20);
    const time = clock.current;
    const theta = rider.phase + omega * time;
    const w = (Math.PI * 2) / rider.wave.period;
    const mid = (rider.band.low + rider.band.high) / 2;
    const amp = (rider.band.high - rider.band.low) / 2;
    const h = KICK_TOP + mid + amp * Math.sin(w * time + rider.wave.phase);
    const dh = amp * w * Math.cos(w * time + rider.wave.phase);
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    // The tyres ride the surface, which stands further out the higher you go.
    const r = rideAt(h);
    g.position.set(r * s, h, r * c);
    const { m, q, p, x, up, z, axle } = scratch;
    // Apparent gravity: real gravity plus the centrifugal term, outward.
    const centrifugal = (rider.speed * rider.speed) / r;
    up.set(-centrifugal * s, G, -centrifugal * c).normalize();
    // Travel is +theta; the model faces −Z, so −Z goes along the tangent.
    z.set(-c, 0, s);
    x.crossVectors(up, z).normalize();
    m.makeBasis(x, up, z);
    q.setFromRotationMatrix(m);
    p.setFromAxisAngle(axle, Math.atan2(dh, rider.speed));
    q.multiply(p);
    g.quaternion.copy(q);
    const spin = (rider.speed / machine.wheelRadius) * delta;
    for (const wheel of machine.wheels) wheel.rotation.x -= spin;
  });

  return (
    <group ref={group}>
      <primitive object={machine.root} />
    </group>
  );
}

/* --------------------------------------------------------------------- lot */

export function WallOfDeath({ playerBodyRef }: { playerBodyRef?: RefObject<RapierRigidBody | null> }) {
  const built = useMemo(() => buildStructure(), []);
  const bikers = useGLTF(BIKERS_MODEL, DRACO_PATH).scene;
  const vehicles = useGLTF(VEHICLES_MODEL, DRACO_PATH).scene;
  // One machine per rider, cloned from the loaded scenes — two bikers and
  // the city's own hatchback — plus a bike standing by the kiosk.
  const machines = useMemo(() => SHOW.riders.map((r) => (
    r.kind === 'car' ? trafficMachine(vehicles, r.car ?? SHOW.trafficCar, r.tint) : bikerMachine(bikers, r.kind)
  )), [bikers, vehicles]);
  const parked = useMemo(() => bikerMachine(bikers, SHOW.parked.who), [bikers]);
  const parkedCars = useMemo(() => PARKED_CARS.map((c) => trafficMachine(vehicles, c.name, c.tint)), [vehicles]);
  const timber = useMemo(() => makeTimber(true), []);
  const bankWood = useMemo(() => makeTimber(false), []);
  const board = useMemo(() => makeTotem(FURNITURE.pylon.board.width, FURNITURE.pylon.board.height), []);
  const marquee = useMemo(() => makeSign(FURNITURE.marquee.width, FURNITURE.marquee.height, 'WALL OF DEATH'), []);
  const clock = useRef(0);

  useFrame((_, rawDelta) => { clock.current += Math.min(rawDelta, 1 / 20); });

  useEffect(() => {
    const drawn = machines.filter((m) => m.root.children.length > 0).length;
    console.info(`[wall-of-death] ${R * 2} m drum, ${DRUM.wall} m wall at (${WOD_SITE.along}, ${WOD_SITE.across}), `
      + `${SHOW.riders.length} riders on the wall`
      + (drawn < machines.length ? ` — ${machines.length - drawn} MISSING a model` : ''));
  }, [machines]);

  const halo = useMemo(() => makeHalo(), []);

  useEffect(() => () => {
    for (const g of Object.values(built.geometry)) g?.dispose();
    halo.dispose();
    timber.dispose();
    bankWood.dispose();
    board.dispose();
    marquee.dispose();
  }, [built, timber, bankWood, board, marquee, halo]);

  const GEO = built.geometry;
  const S = built.signs;
  const stairHalf = built.stairs.run / 2 + 1.6;

  return (
    <group position={[WOD_SITE.along, 0, WOD_SITE.across]} rotation={[0, WOD_SITE.turn, 0]}>
      {GEO.plinth && (
        <mesh geometry={GEO.plinth} receiveShadow castShadow>
          <meshStandardMaterial color={WOD_COLOURS.plinth} roughness={0.9} />
        </mesh>
      )}
      {/* The grey forecourt slab is no longer drawn: `DromeGrounds` paves the
          whole plot round the drum in Halcyon Pier's flagstones instead. */}
      {GEO.floor && (
        <mesh geometry={GEO.floor} receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.floor} roughness={0.85} />
        </mesh>
      )}
      {GEO.floorMark && (
        <mesh geometry={GEO.floorMark}>
          <meshStandardMaterial color={WOD_COLOURS.floorMark} roughness={0.8} />
        </mesh>
      )}
      {GEO.timber && (
        <mesh geometry={GEO.timber} receiveShadow>
          <meshStandardMaterial map={timber} roughness={0.58} metalness={0.04} side={BackSide} />
        </mesh>
      )}
      {GEO.bankTimber && (
        <mesh geometry={GEO.bankTimber} receiveShadow>
          <meshStandardMaterial map={bankWood} roughness={0.62} metalness={0.04} side={BackSide} />
        </mesh>
      )}
      {GEO.skin && (
        <mesh geometry={GEO.skin} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.skin} roughness={0.6} metalness={0.1} />
        </mesh>
      )}
      {GEO.skinWall && (
        <mesh geometry={GEO.skinWall} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.skinWall} roughness={0.7} />
        </mesh>
      )}
      {GEO.brass && (
        <mesh geometry={GEO.brass} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.ribs} roughness={0.5} metalness={0.4} />
        </mesh>
      )}
      {GEO.trim && (
        <mesh geometry={GEO.trim} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.trim} roughness={0.6} />
        </mesh>
      )}
      {GEO.steel && (
        <mesh geometry={GEO.steel} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.steel} roughness={0.4} metalness={0.65} />
        </mesh>
      )}
      {GEO.deck && (
        <mesh geometry={GEO.deck} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.deck} roughness={0.8} side={DoubleSide} />
        </mesh>
      )}
      {GEO.canopy && (
        <mesh geometry={GEO.canopy} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.canopy} roughness={0.6} side={DoubleSide} />
        </mesh>
      )}
      {GEO.accent && (
        <mesh geometry={GEO.accent}>
          <meshStandardMaterial
            color={WOD_COLOURS.accent}
            emissive={WOD_COLOURS.accent}
            emissiveIntensity={1.3}
            roughness={0.4}
          />
        </mesh>
      )}
      {GEO.cool && (
        <mesh geometry={GEO.cool}>
          <meshStandardMaterial
            color={WOD_COLOURS.cool}
            emissive={WOD_COLOURS.cool}
            emissiveIntensity={1.4}
            roughness={0.4}
          />
        </mesh>
      )}
      {GEO.kiosk && (
        <mesh geometry={GEO.kiosk} castShadow receiveShadow>
          <meshStandardMaterial color={WOD_COLOURS.kiosk} roughness={0.85} />
        </mesh>
      )}
      {GEO.glass && (
        <mesh geometry={GEO.glass}>
          <meshStandardMaterial color={WOD_COLOURS.glass} transparent opacity={0.55} roughness={0.15} metalness={0.1} />
        </mesh>
      )}
      {GEO.signBack && (
        <mesh geometry={GEO.signBack} castShadow>
          <meshStandardMaterial color={WOD_COLOURS.sign.back} roughness={0.6} />
        </mesh>
      )}
      {/* The lit faces: both sides of the pylon board, and the marquee on the front. */}
      {[-1, 1].map((side) => (
        <mesh
          key={`board-${side}`}
          position={[S.board.x, S.board.y, S.board.z + side * (S.board.depth / 2 + 0.01)]}
          rotation={[0, side < 0 ? Math.PI : 0, 0]}
        >
          <planeGeometry args={[S.board.w, S.board.h]} />
          <meshStandardMaterial map={board} emissive="#ffffff" emissiveMap={board} emissiveIntensity={0.55} roughness={0.5} />
        </mesh>
      ))}
      <mesh position={[S.marquee.x, S.marquee.y, S.marquee.z]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[S.marquee.w, S.marquee.h]} />
        <meshStandardMaterial map={marquee} emissive="#ffffff" emissiveMap={marquee} emissiveIntensity={0.9} roughness={0.5} />
      </mesh>

      {/* The way in and the way out — see `Portal`. Inside, you land at the
          centre with the whole floor to build speed on. */}
      <Portal
        at={[0, PORTAL.entry.dz]}
        colour={PORTAL.colours.entry}
        offer={{ label: 'WALL OF DEATH', note: 'RIDE THE WALL' }}
        landing={{ x: 0, z: 0, face: 0 }}
        playerBodyRef={playerBodyRef}
        halo={halo}
      />
      <Portal
        at={[0, 0]}
        colour={PORTAL.colours.exit}
        offer={{ label: 'LEAVE THE DROME', note: 'BACK TO THE FORECOURT' }}
        landing={{ x: PORTAL.exit.dx, z: PORTAL.exit.dz, face: -Math.PI / 2 }}
        playerBodyRef={playerBodyRef}
        halo={halo}
      />

      {/* The show. */}
      {SHOW.riders.map((rider, i) => (
        <WallRider key={i} rider={rider} machine={machines[i]} clock={clock} />
      ))}
      {/* A bike standing by the kiosk. */}
      <group position={[SHOW.parked.dx, APRON.top, SHOW.parked.dz]} rotation={[0, SHOW.parked.turn, 0]}>
        <primitive object={parked.root} />
      </group>
      {/* The crowd's cars, along the forecourt's edges — see `PARKED_CARS`. */}
      {PARKED_CARS.map((c, i) => (
        <group key={`parked-${i}`} position={[c.dx, APRON.top, c.dz]} rotation={[0, c.turn, 0]}>
          <primitive object={parkedCars[i].root} />
        </group>
      ))}

      {/* What a car meets: the inside and outside of the drum as one seamless
          trimesh, the two stairs, the kiosk and the pylon. The NPC riders get
          nothing — they are scenery, and a collider on them would sweep the wall. */}
      <RigidBody type="fixed" colliders={false}>
        {built.collision && (
          <TrimeshCollider args={[built.collision.vertices, built.collision.indices]} />
        )}
        {STAIRS.at.map((phi) => (
          <CuboidCollider
            key={phi}
            args={[stairHalf, TOP / 2, STAIRS.width / 2 + 0.2]}
            position={[built.stairs.centre * Math.sin(phi), TOP / 2, built.stairs.centre * Math.cos(phi)]}
            rotation={[0, phi, 0]}
          />
        ))}
        <CuboidCollider
          args={[FURNITURE.kiosk.width / 2 + 0.3, FURNITURE.kiosk.height / 2, FURNITURE.kiosk.depth / 2 + 0.3]}
          position={[FURNITURE.kiosk.dx, FURNITURE.kiosk.height / 2, FURNITURE.kiosk.dz]}
        />
        <CuboidCollider
          args={[FURNITURE.pylon.post / 2, FURNITURE.pylon.height / 2, FURNITURE.pylon.post / 2]}
          position={[FURNITURE.pylon.dx, FURNITURE.pylon.height / 2, FURNITURE.pylon.dz]}
        />
        {PARKED_CARS.map((c, i) => {
          const size = vehicleSize(c.name);
          return (
            <CuboidCollider
              key={`parked-box-${i}`}
              args={[size[0] / 2, size[1] / 2, size[2] / 2]}
              position={[c.dx, APRON.top + size[1] / 2, c.dz]}
              rotation={[0, c.turn, 0]}
            />
          );
        })}
      </RigidBody>
    </group>
  );
}
