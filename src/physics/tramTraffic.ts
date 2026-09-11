/**
 * Where every tram on the loop is, so none of them drives through another.
 *
 * The player's tram shares one set of rails with the service trams, and every
 * tram is a *kinematic* body — Rapier does not resolve contacts between two of
 * those, so without this they simply pass through one another. It is not a rare
 * case either: the player can out-run the service (70 km/h line speed against
 * their 50) and catch one up in about a minute, and a player who *stops* gets
 * rear-ended by the tram behind inside twenty seconds.
 *
 * That last case is why this is symmetric rather than the player alone deferring
 * to the service. Every tram asks the same question of the same registry, so a
 * queue forms behind whatever is slowest, which is what a tram line does.
 *
 * A module-level map rather than React state or a context, for the same reason
 * the nav raster is one: it is read inside the physics step, which must not
 * touch React, and there is exactly one loop in the world.
 *
 * **The crossing is the case gaps alone cannot see.** The route is a
 * figure-eight, so two trams can be a few metres apart on the ground while
 * being half a lap apart in `s` — a following distance of 900 m and a
 * collision at the same instant. Every tram therefore also asks whether
 * anything is about to occupy the crossing, and defers to whoever gets there
 * first. See `crossingBlock`.
 */
import { CROSSING_ARCS, RAIL_LENGTH, railWrap } from '@/config/railConfig';

const arcs = new Map<string, number>();

/** Called by each tram as it moves. `arc` is its centre, in metres. */
export const reportTramArc = (id: string, arc: number) => { arcs.set(id, arc); };

/** Called on unmount, so a hot reload does not leave a ghost tram on the line. */
export const forgetTramArc = (id: string) => { arcs.delete(id); };

/** Signed gap from `from` to `to` around the loop, in (-L/2, L/2]. */
function loopGap(from: number, to: number): number {
  const d = railWrap(to - from);
  return d > RAIL_LENGTH / 2 ? d - RAIL_LENGTH : d;
}

/**
 * How far ahead a tram starts caring about the crossing. A Flexity brakes at
 * 1.8 m/s^2, so from the 14 m/s line speed it needs about 55 m to stop; 75 m
 * leaves room to slow rather than emergency-stop.
 */
const CONFLICT_ZONE = 75;

/**
 * How far *past* the crossing a tram still counts as fouling it. The vehicle is
 * 43.5 m long and `arc` is its centre, so its tail is only clear once the
 * centre is more than half a length beyond — plus a margin.
 */
const FOULING = 28;

/**
 * Distance at which the crossing itself should be treated as an obstacle, or
 * Infinity when the junction is clear.
 *
 * A tram approaching one of the two crossing arcs conflicts with a tram
 * approaching the *other* one; two trams heading for the same arc are simply
 * following each other and are already handled by the plain gap. Right of way
 * goes to whoever is closer to the junction, with the id as a tie-break so two
 * trams arriving together cannot both decide to yield — or both decide not to.
 */
function crossingBlock(id: string, arc: number): number {
  let best = Infinity;
  for (let mine = 0; mine < CROSSING_ARCS.length; mine++) {
    const toCrossing = railWrap(CROSSING_ARCS[mine] - arc);
    if (toCrossing > CONFLICT_ZONE) continue;

    const theirs = CROSSING_ARCS[1 - mine];
    for (const [other, otherArc] of arcs) {
      if (other === id) continue;
      // Their distance to the conflicting arc, allowing for having just cleared it.
      const raw = railWrap(theirs - otherArc);
      const theirDistance = raw > RAIL_LENGTH - FOULING ? raw - RAIL_LENGTH : raw;
      if (theirDistance > CONFLICT_ZONE) continue;

      const theyGoFirst = theirDistance < toCrossing
        || (theirDistance === toCrossing && other < id);
      if (theyGoFirst && toCrossing < best) best = toCrossing;
    }
  }
  return best;
}

/**
 * Distance to the nearest other tram ahead of `arc`, or Infinity if the line is
 * clear. `id` excludes the caller from its own reckoning.
 *
 * Also returns the distance to the crossing when another tram has claim on it,
 * so a tram queues at the junction exactly as it would behind a slower one —
 * the callers brake on this number and need no idea why it shrank.
 */
export function gapAhead(id: string, arc: number): number {
  let best = crossingBlock(id, arc);
  for (const [other, otherArc] of arcs) {
    if (other === id) continue;
    const gap = loopGap(arc, otherArc);
    if (gap > 0 && gap < best) best = gap;
  }
  return best;
}

/** Distance to the nearest other tram behind `arc`, as a positive number. */
export function gapBehind(id: string, arc: number): number {
  let best = Infinity;
  for (const [other, otherArc] of arcs) {
    if (other === id) continue;
    const gap = loopGap(arc, otherArc);
    if (gap < 0 && -gap < best) best = -gap;
  }
  return best;
}
