/**
 * Where every train on the main line is, this frame.
 *
 * The signals need to know which blocks are occupied, and the trains that
 * occupy them live in three places — the ridden train in `TrainRide`, the AI
 * services in `TrainLine`'s `Locomotive` — none of which can see the others.
 * So each reports itself here once per physics step, and `Signals` reads the
 * lot. A module-level map, not React state: nothing re-renders, it is read in
 * a frame loop.
 */
export interface TrainReport {
  /** Arc length of the leading locomotive's centre along the running line. */
  arc: number;
  /** 0 = the running (up) line, 1 = the down line. */
  track: 0 | 1;
  /** +1 runs with increasing arc, -1 against it. */
  direction: 1 | -1;
  /** Metres of train behind the leading end. */
  length: number;
}

const trains = new Map<string, TrainReport>();

export function reportTrain(id: string, report: TrainReport): void {
  trains.set(id, report);
}

export function forgetTrain(id: string): void {
  trains.delete(id);
}

/**
 * The ridden train, if it is on a running line at all.
 *
 * Named rather than searched because the AI services need to treat it
 * differently from each other: they keep station with one another by running
 * the same speed profile, and the one train on the line that does not is the
 * one with a driver. Undefined while the player is in a loop and clear of both
 * roads — see `occupiedTrack`.
 */
export function playerTrain(): TrainReport | undefined {
  return trains.get('player');
}

export function trainsOnTrack(track: 0 | 1): TrainReport[] {
  const out: TrainReport[] = [];
  for (const t of trains.values()) if (t.track === track) out.push(t);
  return out;
}
