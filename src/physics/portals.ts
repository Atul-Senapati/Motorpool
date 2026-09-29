/**
 * Portals: the halo markers a car drives into, and the teleport they offer.
 *
 * Vice City's mission markers, in short: a glowing cylinder on the ground, a
 * prompt when you are standing in it, and pressing the key takes you
 * somewhere. The Wall of Death uses a pair — one on the forecourt that puts
 * you inside the drum, one on the drum floor that puts you back out — because
 * a drum with a door in it is a drum with a wall you hit once a lap, and a
 * drum without one needs another way in.
 *
 * This module is the seam between the marker (which knows where the player
 * is and what to offer) and the chassis (which alone may move the car, and
 * only inside its own physics step). Module-level state rather than context,
 * for the same reason `trainRegistry` is: the reader is a physics callback
 * and a per-frame HUD feed, neither of which wants a React subscription.
 */

export interface Pose {
  position: readonly [number, number, number];
  heading: number;
}

export interface PortalOffer {
  /** What the strip says, in the HUD's own words. */
  label: string;
  note: string;
}

let offer: PortalOffer | null = null;
let pending: Pose | null = null;

/** Called every frame by whoever owns a marker: the offer while the player stands in it, null otherwise. */
export function offerPortal(next: PortalOffer | null) {
  offer = next;
}

/** The current offer, for the HUD strip. */
export const portalOffer = (): PortalOffer | null => offer;

/** Ask for the car to be moved. Honoured by the chassis on its next step. */
export function requestTeleport(pose: Pose) {
  pending = pose;
}

/** The chassis takes the request, once. */
export function takeTeleport(): Pose | null {
  const p = pending;
  pending = null;
  return p;
}
