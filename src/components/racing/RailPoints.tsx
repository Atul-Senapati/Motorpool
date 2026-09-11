'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { roadNameOf } from '@/config/pointwork';
import { HUD, INK, LABEL, NUM, PANEL, PANEL_CUT } from './hudTheme';
import type { VehicleTelemetry } from '@/types/vehicle';

/**
 * The route indicator: which road the train is on, and what the next points
 * will do to it.
 *
 * A car's HUD never needs this because a car's route is wherever it is steered.
 * A train's route is decided *before* it arrives — the whole point of the `T`
 * key is that the call stands until the points are reached — so the driver
 * needs three things the world does not tell them.
 *
 * Which of two parallel tracks they are on, which from a cab is genuinely
 * ambiguous. How far the decision is, which at 250 km/h is four seconds from
 * the moment the points come into view and is really a countdown to a brake
 * application. And — the part the view through the windscreen actively hides —
 * **which way the train is about to be sent.** Two roads that will be hundreds
 * of metres apart are, at the blades, the same piece of track; that is the
 * basis of `Road.offset` and it means the picture at the moment the decision
 * matters shows one railway, not two. So the hand of the turn comes from the
 * geometry (`PointsAhead.hand`) and is stated in words and an arrow.
 *
 * ## The strip
 *
 * Three faint label rows and then one highlighted line that says what will
 * actually happen. That split is deliberate: the first rows are reference —
 * where am I, how long have I got — and are read at leisure, while the strip is
 * the answer to the only question the driver has at the blades, and it has to
 * be readable in the corner of the eye at speed. It is the one place in this
 * HUD with a fill behind it, which is what "read this one" is spelled as when
 * everything else is unpanelled type.
 *
 * Its colour is its state, and there are four rather than two because two of
 * them are things the lever does not control: `LOCKED` (the blades are under
 * the train, `leverLocked`) and a compulsory turnout (the road simply ends, so
 * the train is diverging whether or not anybody asked). Showing those in the
 * same amber as a called route would be a lie about who is in charge.
 *
 * Same discipline as the rest of the HUD: no React state, one rAF loop writing
 * text and colour through refs, nothing painted that is not a value.
 */

/** Beyond this the points are not worth a number — they are simply somewhere ahead. */
const HORIZON = 2000;

/**
 * How far over the diverging limit counts as needing the brake.
 *
 * A couple of km/h of slop, because the guard is already braking for the
 * restriction (`pointsCeiling`) and a telltale that flickers on every rounding
 * error at the exact limit is worse than none.
 */
const OVERSPEED = 2;

/** What the strip says, and the colour it says it in. */
type Mode = 'locked' | 'forced' | 'diverge' | 'straight';

const MODE_INK: Record<Mode, string> = {
  locked: HUD.hot,
  forced: HUD.warm,
  diverge: HUD.way,
  straight: HUD.cyan,
};

/**
 * The arrow. Left and right are the driver's, not the line's — `hand` has
 * already been resolved against the direction of travel.
 */
const ARROW = { '-1': '◀', '0': '▲', '1': '▶' } as const;

export function RailPoints({ telemetry }: { telemetry: RefObject<VehicleTelemetry> }) {
  const roadRef = useRef<HTMLSpanElement>(null);
  const distanceRef = useRef<HTMLSpanElement>(null);
  const leverRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const actionRef = useRef<HTMLSpanElement>(null);
  const destRef = useRef<HTMLSpanElement>(null);
  const limitRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  const mainRef = useRef<SVGPathElement>(null);
  const branchRef = useRef<SVGPathElement>(null);
  const stopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    // Everything the loop writes is cached, so a steady state costs the reads
    // and nothing else. The strip is keyed on one string because its five
    // pieces change together — a route that turns the other way is a different
    // destination at a different limit, never a new arrow on the old words.
    let lastRoad = -1;
    let lastDistance = -2;
    let lastStrip = '';
    let lastNote = '';
    let lastStop: boolean | null = null;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;

      // The plunger. Above everything else in the cluster because when it is
      // out it is the only thing about this train that matters, and hidden
      // outright when it is not — a telltale that is always present is
      // furniture, and furniture is not read.
      if (t.railEmergency !== lastStop && stopRef.current) {
        stopRef.current.hidden = !t.railEmergency;
        lastStop = t.railEmergency;
      }

      if (t.railRoad !== lastRoad && roadRef.current) {
        roadRef.current.textContent = roadNameOf(t.railRoad);
        lastRoad = t.railRoad;
      }

      // Rounded to ten metres. A per-metre readout on an approach that closes
      // at seventy metres a second is a blur of digits, and nothing in the
      // driving depends on the last digit.
      const metres = t.railPoints < 0 ? -1
        : t.railPoints > HORIZON ? HORIZON : Math.round(t.railPoints / 10) * 10;
      if (metres !== lastDistance && distanceRef.current) {
        distanceRef.current.textContent = metres < 0 ? '—'
          : metres >= HORIZON ? '2000+ M' : `${metres} M`;
        lastDistance = metres;
      }

      // What is actually going to happen, in the order the driver needs it: is
      // the choice still mine, is it a turn, which way, onto what, how fast.
      const none = t.railNextRoad < 0;
      const diverging = !none && (t.railArmed || t.railForced);
      const mode: Mode = t.railLocked ? 'locked'
        : none ? 'straight'
        : t.railForced ? 'forced'
        : t.railArmed ? 'diverge'
        : 'straight';
      // A diverging route with no separation is a join, not a turn — leaving a
      // crossover for the line it already lies on. Calling that "LEFT" would be
      // wrong, so the arrow goes to the straight-on chevron and the words say
      // what it is.
      const hand = diverging ? (Math.sign(t.railHand) as -1 | 0 | 1) : 0;
      const action = mode === 'locked' ? 'ROUTE SET'
        : none ? 'STRAIGHT ON'
        : !diverging ? 'STRAIGHT ON'
        : hand === 0 ? 'JOIN'
        : hand < 0 ? 'DIVERGE LEFT' : 'DIVERGE RIGHT';
      // Where you end up. Staying straight means staying on the road you are
      // on, and naming it is not redundant — it is the confirmation that the
      // amber route was cancelled.
      const dest = diverging ? roadNameOf(t.railNextRoad) : roadNameOf(t.railRoad);
      const limit = diverging && t.railNextKph ? t.railNextKph : 0;
      const over = limit > 0 && t.speedKph > limit + OVERSPEED;

      const strip = `${mode}|${hand}|${action}|${dest}|${limit}|${over}`;
      if (strip !== lastStrip) {
        const ink = MODE_INK[mode];
        if (arrowRef.current) {
          arrowRef.current.textContent = ARROW[String(hand) as keyof typeof ARROW];
          arrowRef.current.style.color = ink;
        }
        if (actionRef.current) {
          actionRef.current.textContent = action;
          actionRef.current.style.color = ink;
        }
        if (destRef.current) destRef.current.textContent = dest;
        if (limitRef.current) {
          // Blank rather than "0": the through roads carry no pointwork limit
          // of their own, and a zero would read as a stop signal.
          limitRef.current.textContent = limit ? `${limit} KM/H` : '';
          limitRef.current.style.color = over ? HUD.hot : HUD.muted;
        }
        // The schematic: the through road, and the branch curving off it —
        // up for a left-hand turnout, down for right, converging for a join.
        // The road the train will take is drawn in the ink; the other is dim.
        if (branchRef.current && mainRef.current) {
          branchRef.current.style.visibility = none ? 'hidden' : 'visible';
          const dir = hand < 0 ? -1 : 1;
          branchRef.current.setAttribute('d', hand === 0
            ? `M2 ${13 - 9 * dir}C18 ${13 - 9 * dir} 26 13 40 13`
            : `M24 13C36 13 44 ${13 + 9 * dir} 62 ${13 + 9 * dir}`);
          branchRef.current.style.stroke = diverging ? ink : HUD.faint;
          mainRef.current.style.stroke = diverging && hand !== 0 ? HUD.faint : ink;
        }
        if (stripRef.current) {
          stripRef.current.style.borderLeftColor = ink;
          // The fill is the ink at low alpha rather than a fifth colour, so the
          // strip cannot disagree with its own border about what state it is in.
          stripRef.current.style.background =
            `linear-gradient(90deg, ${ink}2e 0%, ${ink}12 55%, rgba(0,0,0,0) 100%)`;
        }
        if (leverRef.current) {
          leverRef.current.textContent = t.railLocked ? 'LOCKED'
            : t.railArmed ? 'DIVERGE' : 'STRAIGHT';
          leverRef.current.style.color = t.railLocked ? HUD.hot
            : t.railArmed ? HUD.way : HUD.muted;
        }
        if (distanceRef.current) {
          distanceRef.current.style.color = diverging ? ink : HUD.cyan;
        }
        lastStrip = strip;
      }

      // The one line that explains itself. Each of these is a thing the driver
      // would otherwise have to infer from the lever not behaving as expected.
      const note = t.railLocked ? 'POINTS UNDER THE TRAIN — ROUTE ALREADY SET'
        : none ? 'NO POINTS AHEAD'
        : t.railForced ? 'ROAD ENDS — POINTS TAKEN EITHER WAY'
        : over ? 'BRAKE FOR THE DIVERGING ROUTE'
        : '';
      if (note !== lastNote && noteRef.current) {
        noteRef.current.textContent = note;
        noteRef.current.style.color = over || t.railLocked ? HUD.hot : HUD.faint;
        lastNote = note;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry]);

  const label = {
    ...LABEL, fontSize: 14, color: HUD.faint, ...INK,
  } as const;

  return (
    // In flow under the identity bar, on its own panel with the same chamfer.
    <div className="whitespace-nowrap py-3 pl-5 pr-8" style={{ ...PANEL, clipPath: PANEL_CUT }}>
      {/* The emergency brake telltale. `hidden` rather than unmounted so the
          rAF loop keeps a stable ref, same as every other value here. */}
      <div
        ref={stopRef}
        hidden
        className="mb-2.5 flex items-center gap-2.5 py-[7px] pl-3 pr-8"
        style={{
          borderLeft: `3px solid ${HUD.hot}`,
          background:
            `linear-gradient(90deg, ${HUD.hot}44 0%, ${HUD.hot}1c 55%, rgba(0,0,0,0) 100%)`,
        }}
      >
        <span
          aria-hidden
          className="leading-none"
          style={{ fontSize: 13, color: HUD.hot, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}
        >
          &#9679;
        </span>
        <span
          className="leading-none"
          style={{ ...LABEL, fontSize: 16, color: HUD.hot, ...INK }}
        >
          EMERGENCY BRAKE
        </span>
        <span
          className="leading-none"
          style={{ ...LABEL, fontSize: 12, color: HUD.muted, ...INK }}
        >
          HELD UNTIL STOPPED
        </span>
      </div>

      <div className="flex items-center gap-2.5 leading-none" style={label}>
        <span>TRACK</span>
        <span ref={roadRef} style={{ color: HUD.text, fontSize: 15 }}>UP LINE</span>
      </div>
      <div className="mt-2 flex items-center gap-2.5 leading-none" style={label}>
        <span>POINTS</span>
        <span ref={distanceRef} style={{ ...NUM, color: HUD.info, letterSpacing: '0.04em', fontSize: 15 }}>
          &mdash;
        </span>
        <span style={{ color: HUD.faint }}>&middot;</span>
        {/* The key is on the readout rather than in a help panel: it is the one
            control this vehicle has that no other vehicle has, and a driver
            reading the distance is exactly the driver who wants it. */}
        <span
          aria-hidden
          className="px-1.5 py-[3px]"
          style={{
            fontSize: 9.5, letterSpacing: '0.1em', color: HUD.text, fontWeight: 700,
            border: `1px solid rgba(255,255,255,0.4)`, background: 'rgba(0,0,0,0.45)',
            clipPath: 'polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px)',
          }}
        >
          T
        </span>
        <span ref={leverRef} style={{ color: HUD.muted, fontSize: 14 }}>STRAIGHT</span>
      </div>

      {/* The answer. See the note on the strip above for why this one is filled. */}
      <div
        ref={stripRef}
        className="mt-2.5 flex items-center gap-2.5 py-[7px] pl-3 pr-8"
        style={{
          borderLeft: `3px solid ${HUD.cyan}`,
          background:
            `linear-gradient(90deg, ${HUD.cyan}2e 0%, ${HUD.cyan}12 55%, rgba(0,0,0,0) 100%)`,
        }}
      >
        <svg width="64" height="26" viewBox="0 0 64 26" fill="none" strokeWidth="3" strokeLinecap="round" aria-hidden className="shrink-0">
          <path ref={mainRef} d="M2 13H62" stroke={HUD.cyan} />
          <path ref={branchRef} d="M24 13C36 13 44 4 62 4" stroke={HUD.faint} style={{ visibility: 'hidden' }} />
        </svg>
        <span
          ref={arrowRef}
          aria-hidden
          className="leading-none"
          style={{ fontSize: 13, color: HUD.cyan, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}
        >
          &#9650;
        </span>
        <span
          ref={actionRef}
          className="leading-none"
          style={{ ...LABEL, fontSize: 16, color: HUD.cyan, ...INK }}
        >
          STRAIGHT ON
        </span>
        <span className="leading-none" style={{ fontSize: 11, color: HUD.faint, ...INK }}>
          &rarr;
        </span>
        <span
          ref={destRef}
          className="leading-none"
          style={{ ...LABEL, fontSize: 15, color: HUD.text, ...INK }}
        >
          UP LINE
        </span>
        <span
          ref={limitRef}
          className="leading-none"
          style={{ ...NUM, fontSize: 13, letterSpacing: '0.04em', color: HUD.muted, ...INK }}
        />
      </div>

      {/* Why the lever is not doing what you expected. Empty when it is. */}
      <div className="mt-1.5 leading-none">
        <span
          ref={noteRef}
          style={{ ...LABEL, fontSize: 12, color: HUD.faint, ...INK }}
        />
      </div>
    </div>
  );
}
