/**
 * Kestrel's people, as the NPC traffic sees them (`trafficAI` stops for anyone
 * in the road). The cars, as the people see them, are `trafficAI.liveTraffic`.
 *
 * Plain mutable arrays, written once a frame by their owner and read by the
 * other — the same pattern as `trainRegistry`. No React state: this changes
 * sixty times a second and nothing renders from it directly.
 */

export interface StreetWalker {
  x: number;
  z: number;
  /** Down on the carriageway level — crossing, or lying there. */
  onRoad: boolean;
}

/** Live people. Rewritten in place by `KestrelPeople`. */
export const STREET_WALKERS: StreetWalker[] = [];
