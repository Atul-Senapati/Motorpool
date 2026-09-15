'use client';

import { TRAIN_LENGTH } from '@/config/trainConfig';
import type { StripFeed, StripMessage } from './HudStrip';
import type { VehicleTelemetry } from '@/types/vehicle';

/* ------------------------------------------------------------------ rail */

/** Deceleration the strip assumes when working out whether a restriction is news, m/s². */
const BRAKE = 4.2;
/** How much further than the braking distance still counts as worth saying. */
const NOTICE = 2.2;
/** Metres of station approach that count as arriving. */
const STATION_NOTICE = 700;

/**
 * The line ahead: a train on the road, a restriction to brake for, or the
 * station — whichever is most urgent, and nothing when the road is clear.
 *
 * One message, never a stack. Three warnings stacked is a panel again, and at
 * 250 km/h a driver reads one line or none. The order is a driver's: nothing
 * matters if there is a train in front; a restriction matters once the brake is
 * what gets you to it; the station matters on the approach.
 *
 * The restriction test is deliberately not "is there a lower limit ahead".
 * `urgency` is the distance the brake needs against the distance left, so a
 * 65 km/h corner two kilometres off is not news and the same corner at 400 m
 * is. Amber over 0.45, red over 0.85.
 */
export function railAheadFeed(
  station: { name: string; arc: number } | null,
): StripFeed {
  return (t: VehicleTelemetry): StripMessage | null => {
    const speed = t.speedKph / 3.6;

    if (t.railAheadM >= 0 && t.railAheadM < 1200) {
      const closing = t.railAheadM < 400;
      return {
        level: closing ? 'danger' : 'warn',
        icon: 'train',
        label: 'TRAIN AHEAD',
        figure: String(Math.round(t.railAheadM / 10) * 10),
        unit: 'M',
        note: closing ? 'SHUT OFF AND BRAKE' : 'ON THIS ROAD',
      };
    }

    if (t.railRestrictKph >= 0 && t.railRestrictM > 0) {
      const target = t.railRestrictKph / 3.6;
      if (speed - target > 0.5) {
        const need = (speed * speed - target * target) / (2 * BRAKE);
        const urgency = need / Math.max(t.railRestrictM, 1);
        if (urgency > 1 / NOTICE) {
          return {
            level: urgency > 0.85 ? 'danger' : 'warn',
            icon: 'limit',
            label: 'RESTRICTION',
            figure: String(t.railRestrictKph),
            unit: 'KM/H',
            note: `IN ${Math.round(t.railRestrictM / 10) * 10} M`,
          };
        }
      }
    }

    if (station) {
      const away = stationGap(t.railArc, station.arc, t.forwardSpeed);
      if (away >= 0 && away < STATION_NOTICE) {
        return {
          level: 'note',
          icon: 'station',
          label: station.name,
          figure: String(Math.round(away / 10) * 10),
          unit: 'M',
          note: 'STATION',
        };
      }
    }
    return null;
  };
}

/**
 * How far the station is, the way the train is going.
 *
 * The ring has to be walked in the direction of travel: a station 200 m behind
 * is not 9 km ahead, and reversing makes it neither.
 */
function stationGap(arc: number, stationArc: number, forwardSpeed: number): number {
  const way = forwardSpeed < -0.2 ? -1 : 1;
  let d = ((stationArc - arc) * way) % TRAIN_LENGTH;
  if (d < 0) d += TRAIN_LENGTH;
  return d;
}

/* ------------------------------------------------------------------- road */

/** How long a state notice holds before it gets out of the way, seconds. */
const NOTICE_HOLD = 2.6;
/** Wheels off the ground for this long before it is worth calling air, seconds. */
const AIR_AFTER = 0.4;
/** Below this, the car is on its side or its roof and cannot drive out of it. */
const UPRIGHT_LOST = 0.35;
/** Where the teach-once prompt remembers that it has been obeyed. */
const TAUGHT = 'motorpool.hint.boost';

/**
 * The driving hints: what the car can do that you might not know, and what has
 * just happened that you would want told.
 *
 * Three rules keep it from nagging, and they are the whole design:
 *
 *  1. **Teach once, ever.** "Press SHIFT to boost" is worth saying to somebody
 *     who has never boosted and worth saying to nobody else, so it is
 *     remembered in `localStorage` and never shown again once obeyed. A hint
 *     that repeats is not a hint, it is a nag.
 *  2. **State notices are edges, not conditions.** The reserve being full is
 *     news at the moment it fills; it is wallpaper for the five minutes
 *     afterwards. So they fire on the rising edge and hold `NOTICE_HOLD`.
 *  3. **Situations outrank both.** On its roof or in the air, the car has
 *     something more pressing to say than its reserve.
 */
export function driveHintsFeed(): StripFeed {
  let taught = false;
  try {
    taught = typeof window !== 'undefined' && window.localStorage.getItem(TAUGHT) === '1';
  } catch {
    // A private window throws on access. Then the hint shows each session,
    // which is the harmless direction to fail in.
    taught = false;
  }
  // Both notices are latched rather than merely edge-triggered, and the
  // difference is not academic — it was a bug. `boosting` flickers when the
  // reserve is hovering at the engage floor: it cuts out, a little charge comes
  // back, it engages, it cuts out again. A plain rising edge on "stopped
  // boosting with an empty reserve" therefore re-fired every few frames, and
  // BOOST SPENT sat on screen for as long as the key was held instead of the
  // 2.6 s it was given. A notice may only fire again once the thing it reports
  // has actually gone away and come back.
  let fullArmed = true;
  let spentArmed = true;
  let wasBoosting = false;
  let notice = 0;
  let noticeMessage: StripMessage | null = null;
  let air = 0;

  return (t: VehicleTelemetry, dt: number): StripMessage | null => {
    // --- 1. situations, which outrank everything.
    if (t.upright < UPRIGHT_LOST && Math.abs(t.forwardSpeed) < 2) {
      return {
        level: 'danger', icon: 'flip', cap: 'F', label: 'RIGHT THE CAR',
        note: t.upright < -0.4 ? 'ON ITS ROOF' : 'ON ITS SIDE',
      };
    }
    const wheels = t.wheels;
    const grounded = wheels.FL.inContact || wheels.FR.inContact
      || wheels.RL.inContact || wheels.RR.inContact;
    air = grounded ? 0 : air + dt;
    if (air > AIR_AFTER) {
      return {
        level: 'note', icon: 'air', label: 'AIRBORNE',
        figure: air.toFixed(1), unit: 'S',
      };
    }

    // --- 2. the reserve, on its edges.
    const full = t.boost > 0.999;
    if (t.boosting && !taught) {
      taught = true;
      try { window.localStorage.setItem(TAUGHT, '1'); } catch { /* private window */ }
    }
    // Re-arm each notice only once its own condition has clearly reversed.
    if (!full && t.boost < 0.9) fullArmed = true;
    if (t.boost > 0.5) spentArmed = true;
    if (full && fullArmed) {
      fullArmed = false;
      notice = NOTICE_HOLD;
      noticeMessage = taught
        ? { level: 'note', icon: 'boost', cap: 'SHIFT', label: 'BOOST', note: 'FULL' }
        : { level: 'note', icon: 'boost', cap: 'SHIFT', label: 'BOOST READY', note: 'HOLD TO OVERTAKE' };
    } else if (spentArmed && wasBoosting && !t.boosting && t.boost < 0.08) {
      spentArmed = false;
      notice = NOTICE_HOLD;
      noticeMessage = { level: 'warn', icon: 'boost', label: 'BOOST SPENT', note: 'RECHARGING' };
    }
    wasBoosting = t.boosting;

    if (notice > 0) {
      notice -= dt;
      // Boosting answers the prompt, so it stops being one.
      if (t.boosting && noticeMessage?.label.startsWith('BOOST READY')) notice = 0;
      if (notice > 0) return noticeMessage;
    }
    return null;
  };
}

/**
 * The drone's notices: sport mode on its edge, the ceiling, and the ground
 * coming up. Transient like the others; the altitude itself lives in the
 * cluster's ALT figure and is not repeated here.
 */
export function flightFeed(): StripFeed {
  let wasSport = false;
  let notice = 0;
  let noticeMessage: StripMessage | null = null;
  return (t: VehicleTelemetry, dt: number): StripMessage | null => {
    // Low over something, and still going down: the one thing worth shouting.
    if (t.agl < 4 && t.forwardSpeed !== 0 && t.speedKph > 15) {
      return { level: 'warn', icon: 'air', label: 'LOW', figure: t.agl.toFixed(1), unit: 'M', note: 'OVER THE GROUND' };
    }
    if (t.y >= 399) {
      return { level: 'warn', icon: 'limit', label: 'CEILING', figure: '400', unit: 'M' };
    }
    if (t.handbrake) {
      return { level: 'note', icon: 'info', cap: 'SPACE', label: 'HOLDING' };
    }
    if (t.boosting && !wasSport) {
      notice = NOTICE_HOLD;
      noticeMessage = { level: 'note', icon: 'boost', cap: 'SHIFT', label: 'SPORT', note: '180 KM/H' };
    }
    wasSport = t.boosting;
    if (notice > 0) { notice -= dt; return noticeMessage; }
    return null;
  };
}
