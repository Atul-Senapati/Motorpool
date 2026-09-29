import { TRAIN_LENGTH } from '@/config/trainConfig';
import { trainsOnTrack, type IdentifiedTrain } from './trainRegistry';

/**
 * What the block ahead allows a train to do — the one rule every AI train on
 * the line now obeys.
 *
 * It exists because the AI trains could not see each other. Each service
 * checked `playerTrain()` and nothing else, on the reasoning that the services
 * keep station with one another for free: they all run the same speed profile,
 * so an evenly spaced set stays evenly spaced and none ever closes on the one
 * in front. That was true right up until a train appeared that ran a
 * *different* profile. A goods train pathed at 45 % of line speed shared a road
 * with expresses doing 150, and what four expresses did was overhaul it and
 * drive straight through it — which is what "a passenger train crossing over
 * the freight" is. The train in front was never in the signalling at all.
 *
 * So the rule moved out of the services and into one place that every train
 * calls with its own report, and it reads the same registry the lineside
 * signals and the level crossing already read.
 *
 * **Two aspects, not one.** Returning zero the moment anything enters the block
 * gives a following train a full-service stop, a wait, a full acceleration and
 * another stop — a lurch every twenty seconds. Caution first: inside the block
 * a train takes the speed of the one in front and *follows* it. Only inside the
 * danger fraction does it close to a stand.
 */

/**
 * How much of the block is danger rather than caution.
 *
 * A third. The block is a stopping distance plus a margin, so a third of it is
 * around 190 m — comfortably more than a train already slowed to the speed of
 * the one in front needs, and short enough that the caution zone does the work
 * and the stand is the exception.
 */
const DANGER = 1 / 3;

/**
 * How far apart two noses must be before one counts as being in front of the
 * other, metres. See the overlap case in `blockLimit`.
 */
const COINCIDENT = 1;

/**
 * Distance from `from` forward to `to`, **always positive**, in `[0, L)`.
 *
 * Not `ahead`, and that distinction is the whole of the first bug this file
 * had. `ahead` is signed and takes the *shortest way round*, which is right for
 * "is this train roughly in front of me or behind me" and catastrophically
 * wrong for measuring a train's extent. A vehicle whose nose sits just past the
 * half-loop reads at `-3310` while its own tail, a hundred metres further on,
 * reads at `+3173`: the two ends land on opposite sides of the antipode. Taking
 * the min and max of that pair gives a span that appears to straddle the
 * observer, so a train on the far side of a 6.6 km loop read as occupying the
 * block — and the whole road came to a stand at the first sample, every train
 * held by one it could not possibly reach.
 *
 * Forward-only distance has no such seam. A train behind is not a small
 * negative number, it is a number close to the loop length, which is larger
 * than any block and drops out of the comparison on its own.
 */
function forward(from: number, to: number, direction: 1 | -1): number {
  const d = (to - from) * direction;
  return ((d % TRAIN_LENGTH) + TRAIN_LENGTH) % TRAIN_LENGTH;
}

/**
 * The speed limit `self` may run at, given everything else on its road.
 *
 * `Infinity` when the road is clear, which is the common answer and the one the
 * caller folds into its other limits with a `Math.min`.
 */
export function blockLimit(self: IdentifiedTrain, block: number): number {
  let limit = Infinity;
  for (const other of trainsOnTrack(self.track, self.line ?? 'main')) {
    // Every train on the road is in this list, including this one — and near
    // a junction, the other report this same train filed (`owner`).
    if (other.id === self.id || (self.owner && other.owner === self.owner)) continue;

    // The other train's two ends as forward distances from this one's nose.
    // Both ends, because on a road being worked wrong-line — the player — the
    // other train closes nose-first from the far end instead of tail-first.
    const nose = forward(self.arc, other.arc, self.direction);
    const tail = forward(self.arc, other.arc - other.direction * other.length, self.direction);
    const near = Math.min(nose, tail);
    const far = Math.max(nose, tail);

    // The body spans `other.length`, so a pair of ends further apart than that
    // is a body wrapped through the origin — which means this train is standing
    // *inside* that one.
    const overlapping = far - near > other.length + 1;
    if (overlapping) {
      // Yield only to a train whose nose is genuinely in front of ours. The
      // follower in a rear-end overlap sees the leader's nose ahead and stops;
      // the leader sees the follower's whole body behind it and runs on, so the
      // two separate. Trains at the *same* arc — which only a misphased spawn
      // produces — see no one in front and both keep going, which is a
      // coupled pair rather than a road at a permanent stand. That is the
      // second bug this file had: two trains placed on one arc held each other
      // for ever, and everything behind them queued up and stopped too.
      if (nose > COINCIDENT && nose < TRAIN_LENGTH / 2) return 0;
      continue;
    }

    if (near >= block) continue;
    if (near < block * DANGER) return 0;
    // Caution: run no faster than the train in front.
    limit = Math.min(limit, other.speed);
  }
  return limit;
}

/**
 * Is a diamond at running-line arc `at` spoken for — by a down train that is
 * on it or could not stop short of it, or by another train's claim — as far
 * as train `self` is concerned?
 *
 * Asked by a train about to go over a junction's diamond (`diamondAhead`)
 * before it claims it. A down train that is further off than it takes to stop
 * is not a conflict: the claim will stop it.
 */
export function diamondBusy(at: number, self: string, brake: number): boolean {
  for (const other of trainsOnTrack(1)) {
    if (other.owner === self || other.id === self) continue;
    const toward = forwardSigned(other.arc, at, other.direction);
    // On it: the diamond is between its nose and its tail.
    if (toward <= 0 && toward >= -(other.length + 4)) return true;
    // Coming: it could not stop short of the diamond.
    if (toward > 0 && toward < (other.speed * other.speed) / (2 * brake) + 80) return true;
  }
  return false;
}

/** Signed distance from `from` to `to` travelling `direction`, the short way round. */
function forwardSigned(from: number, to: number, direction: 1 | -1): number {
  let d = (((to - from) * direction) % TRAIN_LENGTH + TRAIN_LENGTH) % TRAIN_LENGTH;
  if (d > TRAIN_LENGTH / 2) d -= TRAIN_LENGTH;
  return d;
}
