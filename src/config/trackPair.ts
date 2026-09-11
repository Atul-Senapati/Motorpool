/**
 * Where the *pair* of tracks is centred, relative to the running line.
 *
 * The running line is the alignment the route file describes and every arc
 * length is measured along it. The second track runs a fixed gap to its left
 * (`secondTrackGap`), so wherever there are two tracks the middle of the
 * railway is half that gap to the left of the running line — and that middle,
 * not the running line, is what a bore, a cutting, a portal or a deck has to be
 * centred on, or one track hugs the wall while the other has the room.
 *
 * One function so the shader that carves the terrain (`CityMap`), the lofts
 * that line it (`TrainLine`) and the headwalls all agree to the millimetre on
 * where the middle is. It lives in its own module because `trainConfig` cannot
 * import `stationConfig` (which imports it) and both of the consumers above
 * import both.
 */
import { doubleTrackAt, secondTrackGap } from './stationConfig';

/** Lateral offset, metres left of the running line, of the track pair's centre at arc `s`. */
export function pairCentreAt(s: number): number {
  return doubleTrackAt(s) ? secondTrackGap(s) / 2 : 0;
}
