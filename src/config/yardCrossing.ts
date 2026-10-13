import { CROSSINGS, SIDINGS } from './airportConfig';
import { TRAIN } from './trainConfig';

/**
 * The freight yard's level crossing, as a height: what `AirportIsland` builds
 * as the deck and its two ramps (`buildYard`), given back as a function of
 * where you are, so the ground fleet can drive over it rather than through it.
 *
 * The deck stands at railhead height from the first road's west panel to the
 * last road's east one; a `CROSSINGS.ramp` of 1 in 15 runs down off each end.
 * Everywhere else the yard is at ground level, which for the fleet is 0.
 */
const TOP = SIDINGS.ballast.depth + TRAIN.sleeperHeight + TRAIN.railHeight;
const ENDS = SIDINGS.roads.map((r) => r.at);
const DECK_FROM = Math.min(...ENDS) - CROSSINGS.panel;
const DECK_TO = Math.max(...ENDS) + CROSSINGS.panel;

/** Height over the island's ground at island (`along`, `across`). */
export function crossingHeightAt(along: number, across: number): number {
  for (const lane of CROSSINGS.lanes) {
    if (across < lane.from || across > lane.to) continue;
    if (along >= DECK_FROM && along <= DECK_TO) return TOP;
    if (along > DECK_FROM - CROSSINGS.ramp && along < DECK_FROM) return TOP * (1 - (DECK_FROM - along) / CROSSINGS.ramp);
    if (along > DECK_TO && along < DECK_TO + CROSSINGS.ramp) return TOP * (1 - (along - DECK_TO) / CROSSINGS.ramp);
  }
  return 0;
}
