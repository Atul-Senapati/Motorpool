/**
 * One budget for everything driven by the world rather than the player.
 *
 * Road traffic (`Traffic`: the city's cars and the two bikers), the small
 * craft at sea (`SeaTraffic`: tugs, sailing boats, cruisers, yachts) and the
 * beach's riders (`BeachRiders`: quad bikes and the monster truck) share a
 * single cap of `NPC_TOTAL` live at once (or the lower traffic setting's),
 * so the world's moving-thing count — and its cost — is the same wherever you
 * are: in town it is all cars, out by the water up to `SEA_SHARE` of it is
 * boats instead. The big scripted ships
 * (the ferry, the harbour's cargo ship, the cruise liners) are scenery, not
 * part of it.
 *
 * The two systems meet only through this object, once a step each:
 *
 *  - `SeaTraffic` writes how many boats are live and how many it WANTS — the
 *    small craft whose routes are in range of the player, up to `seaShare`.
 *  - `Traffic` writes the total from the density setting, caps its cars at
 *    the total minus the larger of the two, so
 *    as the player nears the sea cars retire (out of sight) to make room, and
 *    writes how many cars are live.
 *  - `SeaTraffic` and `BeachRiders` spawn only into whatever the cars leave;
 *    the beach asks the same way the sea does (`beachWant`).
 */
export const NPC_TOTAL = 40;
/** The most of the total the sea may take, as a share. */
export const SEA_SHARE = 0.3;

export const NPC_BUDGET = {
  /**
   * The cap right now: `NPC_TOTAL`, or less on a lower traffic setting —
   * `Traffic` writes it from the density preset, so OFF empties the sea too.
   */
  total: NPC_TOTAL,
  /** Cars and bikes live on the roads. */
  cars: 0,
  /** Boats live at sea. */
  boats: 0,
  /** Boats the sea would like to have, given where the player is. */
  boatWant: 0,
  /** Quads and the monster truck live on the beach, and how many it wants. */
  beach: 0,
  beachWant: 0,
};

/** What the sea and the beach hold or are asking for, whichever is more of each. */
const offRoad = () => Math.max(NPC_BUDGET.boats, NPC_BUDGET.boatWant) + Math.max(NPC_BUDGET.beach, NPC_BUDGET.beachWant);

/** The most road vehicles allowed live right now. */
export function roadLimit() {
  return Math.max(0, NPC_BUDGET.total - offRoad());
}

/** The most boats the sea may ask for: its share of the total. */
export function seaShare() {
  return Math.round(NPC_BUDGET.total * SEA_SHARE);
}

/** The most boats allowed live right now. */
export function seaLimit() {
  return Math.max(0, Math.min(NPC_BUDGET.boatWant, NPC_BUDGET.total - NPC_BUDGET.cars - NPC_BUDGET.beach));
}

/** The most beach riders allowed live right now. */
export function beachLimit() {
  return Math.max(0, Math.min(NPC_BUDGET.beachWant, NPC_BUDGET.total - NPC_BUDGET.cars - NPC_BUDGET.boats));
}
