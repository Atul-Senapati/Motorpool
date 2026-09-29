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
  /**
   * How fast it is going, m/s, always positive along its own `direction`.
   *
   * Added for the block working in `trainSignalling`, which needs more than
   * "something is there": a train that stops dead the moment anything enters
   * the block ahead of it stutters, where one that falls in behind at the
   * speed of the train in front follows it. Nothing else reads it, and the
   * signals and the barriers care only that the block is occupied.
   */
  speed: number;
  /**
   * Which railway `arc` is on: the running line (the default), or the branch
   * loop through Skylark and the airport trunk, where `arc` is metres along the
   * loop from the Skylark toe and `track` is the loop's own up (0) or down (1)
   * road. Near a junction one train is filed in both — see `trainSpaces`.
   */
  line?: 'main' | 'loop';
  /** The train a report belongs to, where one train files several. */
  owner?: string;
}

/**
 * A report with the key it was filed under.
 *
 * `trainsOnTrack` has to hand the id back now that trains read each other:
 * every train on a road is in that list including the one asking, and a train
 * that blocks on its own report never moves again.
 */
export type IdentifiedTrain = TrainReport & { id: string };

const trains = new Map<string, IdentifiedTrain>();

export function reportTrain(id: string, report: TrainReport): void {
  trains.set(id, { ...report, id });
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
export function playerTrain(): IdentifiedTrain | undefined {
  return trains.get('player');
}

export function trainsOnTrack(track: 0 | 1, line: 'main' | 'loop' = 'main'): IdentifiedTrain[] {
  const out: IdentifiedTrain[] = [];
  for (const t of trains.values()) if (t.track === track && (t.line ?? 'main') === line) out.push(t);
  return out;
}

/** Every train out on the branch loop, either road — for the Skylark line's level crossings. */
export function trainsOnLoop(): IdentifiedTrain[] {
  const out: IdentifiedTrain[] = [];
  for (const t of trains.values()) if (t.line === 'loop') out.push(t);
  return out;
}

