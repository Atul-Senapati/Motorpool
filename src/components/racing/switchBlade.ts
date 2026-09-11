/**
 * Switch blades: how a diverging road's rails meet the line they join.
 *
 * ## The problem this replaces
 *
 * A road here is a lateral *offset* from the running line, and a turnout is an
 * arc where two roads' offsets are equal (`pointwork`). That is what lets a
 * 147 m rake cross over with no blending and no seam — but it also means the
 * last stretch of a diverging road is laid in the same place as the rail it is
 * joining. Drawn plainly, two rails within a few centimetres of each other for
 * tens of metres are one smeared, z-fighting rail.
 *
 * The first answer was to stop drawing the road once it had closed to
 * `bladeGap`. That removed the smear and left something worse: measured, a
 * crossover is 84 m long and only 45.5 m of it was drawn, so **19.5 m of rail
 * was missing at each end** — the diagonals floated in the four-foot, joined to
 * nothing, and the station loops broke off 13–21 m short of the down line.
 *
 * ## What this does instead
 *
 * It draws the whole road, and shapes the overlap into the thing real
 * pointwork uses there — a switch blade. Over the last `bladeGap` of
 * separation, three things happen together, and each of them is doing a job:
 *
 *   the section tapers   from full rail down to `bladeTip`, so the blade ends
 *                        in the planed point a switch rail actually has rather
 *                        than in a square-cut end
 *   it moves inside      by half a rail width plus the tip, so at the merge the
 *                        blade's outer face lies exactly on the gauge face of
 *                        the stock rail — against it, not inside it, which is
 *                        where a switch blade sits and is also what stops the
 *                        two sharing a plane
 *   the head drops       by `bladeDrop`, because a blade tip runs a little
 *                        below the stock rail head — and a difference in height
 *                        is what guarantees no z-fighting even if the first two
 *                        ever came out flush
 *
 * The rail is therefore continuous into the line at both ends, and what the eye
 * gets at the merge is a pair of blades lying against the stock rails.
 *
 * Shared by `Pointwork` (the crossovers) and `IslandStation` (the platform and
 * relief loops) so the two cannot drift: they are the same railway, and a
 * blade that tapered one way at a crossover and another way in the throat
 * would read as two different kinds of track.
 */
import { STATION } from '@/config/stationConfig';
import { TRAIN } from '@/config/trainConfig';
import type { LoftSample, ProfileVertex } from './railGeometry';

/** A centreline sample that knows how far it still is from the line it joins. */
export interface BladedSample extends LoftSample {
  /**
   * 0 where this road has merged, 1 where it stands as its own track.
   *
   * Held as a fraction rather than as the raw separation so the profile below
   * needs no knowledge of which line is being joined or how far away it was —
   * the roads measure that differently (a crossover against whichever running
   * line is nearer, a platform loop against the down line, the relief loop
   * against the up) and none of that belongs in a cross-section.
   */
  blade: number;
}

/** 0 at the merge, 1 once the road is `STATION.bladeGap` clear of the line. */
export const bladeFraction = (separation: number): number =>
  Math.min(1, Math.max(0, separation / STATION.bladeGap));

/** True where the road is its own track, and so wants its own sleepers. */
export const standsAlone = (sample: BladedSample): boolean => sample.blade >= 1;

const HALF = TRAIN.railWidth / 2;
const FOOT = -TRAIN.railHeight;

/**
 * A rail section that tapers into a switch blade as the road closes.
 *
 * `centre` is the rail's offset from the road's own centreline, so ±gauge/2 —
 * and its sign is which side of the road this rail is, which is also the
 * direction the blade has to move *away* from to get inside the gauge.
 */
export function bladedRailProfile<S extends BladedSample>(
  centre: number,
): ProfileVertex<S>[] {
  const side = Math.sign(centre) || 1;
  /** Half the section: full rail out in the open, a planed point at the merge. */
  const half = (s: S) => HALF * (STATION.bladeTip + (1 - STATION.bladeTip) * s.blade);
  /**
   * Where the blade sits. Moved toward the road's own centreline by half a
   * rail plus the tip's own half, which puts the blade's outer face exactly on
   * the stock rail's gauge face at the merge — touching it, never through it.
   */
  const at = (s: S) => centre - side * HALF * (1 + STATION.bladeTip) * (1 - s.blade);
  /** The head, dropping under the stock rail's as the blade thins. */
  const head = (s: S) => -STATION.bladeDrop * (1 - s.blade);
  return [
    { off: (s) => at(s) - half(s), rise: head },
    { off: (s) => at(s) + half(s), rise: head },
    { off: (s) => at(s) + half(s), rise: FOOT },
    { off: (s) => at(s) - half(s), rise: FOOT },
  ];
}
