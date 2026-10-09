import { AIRPORT_GATE as WEST_LINK_ALONG, SITE } from './airportConfig';

/**
 * Halcyon Heliport: a tower with the pad on its roof, and a ring at the door.
 *
 * On the open strip at the island's west end, between the coast and the west
 * link road — the road north from the airfield gate junction to the outer
 * road, where Halcyon Parade begins. Everything here is in the island's own
 * frame (`along`, `across`; see `airportConfig`), like the Wall of Death and
 * the aqua park, and drawn inside `AirportIsland`'s group.
 *
 * Drive into the ring on the forecourt and the HUD offers ENTER · FLY THE
 * HELICOPTER: Enter puts you in the helicopter, live (`setSelected`), sitting
 * on the roof pad. Land back on the roof and it offers the way back — your own
 * vehicle, in the ring, facing the road. `HeliportBoarding` does both.
 *
 * The site, measured: the island's edge is at along −458 to −464 across this
 * strip, and the west link's footway at −404.5, so there are 50 m between
 * them from across 110 to 245 with nothing standing on it. The tower takes
 * 92 m of that frontage, set back behind its forecourt.
 */

/**
 * The tower. `along`/`across` is its centre; `w` runs along (front to back —
 * the front, with the doors, faces +along, the road), `d` across. A tall
 * glazed lobby, four office floors over it, and the roof the pad stands on.
 */
export const HELI_TOWER = {
  along: -433,
  across: 168,
  w: 24,
  /** Its frontage on the road — wide, with three entrances. */
  d: 92,
  /** The double-height lobby. */
  lobby: 5.6,
  /** Floor to floor above it. */
  floor: 4,
  /** Three office floors over the lobby. */
  floors: 3,
  /** The roof's parapet. */
  parapet: 1.1,
} as const;

/** The roof slab's top, over the crown. */
export const HELI_ROOF = HELI_TOWER.lobby + HELI_TOWER.floor * HELI_TOWER.floors;

/**
 * The rooftop pad: a square steel deck on short legs over the roof, toward the
 * front, with the stair-and-lift housing behind it on the roof's back end.
 */
export const HELI_DECK = {
  /** Centre offset from the tower's centre, along (toward the front). */
  along: 1.5,
  /** Side of the square deck. */
  size: 19,
  /** Its top over the roof. */
  lift: 1.6,
  /** The touchdown circle's radius. */
  ring: 6.8,
} as const;

/** The deck's top over the crown. */
export const HELI_DECK_TOP = HELI_ROOF + HELI_DECK.lift;

/** The forecourt: paving from the tower's front out to the road, along its frontage. */
export const HELI_FORECOURT = {
  alongFrom: HELI_TOWER.along + HELI_TOWER.w / 2, alongTo: WEST_LINK_ALONG - 10.5,
  acrossFrom: HELI_TOWER.across - HELI_TOWER.d / 2 + 4, acrossTo: HELI_TOWER.across + HELI_TOWER.d / 2 - 4,
} as const;

/** The boarding ring, on the forecourt before the doors. */
export const HELI_RING = { along: -411.5, across: HELI_TOWER.across } as const;

/** Where the trees keep off: the whole site, coast to road. */
export const HELI_BOUNDS = [-462, WEST_LINK_ALONG - 9, 118, 218] as const;

/** Island frame → world XZ, as `airportConfig` turns it. */
export function heliWorld(along: number, across: number): [number, number] {
  const c = Math.cos(SITE.heading);
  const s = Math.sin(SITE.heading);
  return [SITE.centre[0] + along * c + across * s, SITE.centre[1] - along * s + across * c];
}

/** A world yaw that faces `+along` — out of the tower, toward the road. */
export const HELI_FACING = Math.atan2(Math.cos(SITE.heading), -Math.sin(SITE.heading));

export const HELI_GROUND = SITE.ground;
export const HELIPORT_ENABLED = true;
