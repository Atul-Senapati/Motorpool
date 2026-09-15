'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { VEHICLE } from '@/config/vehicleConfig';
import { SELECTED } from '@/config/garage';
import type { VehicleTelemetry } from '@/types/vehicle';
import { HATCH, HUD, INK, INK_FILTER, NUM, PLATE, PLATE_CUT } from './hudTheme';

/* ------------------------------------------------------------------ geometry */

const R = 104;
const CENTRE = 120;
/** The dial sweeps 270°, from lower-left round the top to lower-right. */
const START = -135;
const SWEEP = 270;

/**
 * The pointer floats in the outer band instead of pivoting from the middle.
 *
 * A full needle cannot coexist with a reading in the centre — it would sweep
 * straight across the digits twice a gear. Starting it at 58 keeps it clear of
 * the speed, and a blade in the band still reads as a dial rather than as a
 * progress bar. Checked at both stops: at either end the pointer sits well
 * outside the centre stack and clear of the gear in the bottom gap.
 */
const NEEDLE_FROM = 58;
const NEEDLE_TO = 88;

/** Dial ceiling, rounded up to a whole 1000 so the last label is a round number. */
const DIAL_MAX = Math.ceil(VEHICLE.engine.maxRpm / 1000) * 1000;
const MAJORS = DIAL_MAX / 1000;

/**
 * Zone edges derived from the engine's own redline rather than fixed — the dial
 * ceiling is rounded up past `maxRpm`, so hard coding "amber from 0.6" would
 * put the redline in the wrong place on any engine whose limit is not round.
 */
const WARM_RPM = VEHICLE.engine.maxRpm * 0.62;
const HOT_RPM = VEHICLE.engine.maxRpm * 0.84;

const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
/** A point on the dial at `t` (0..1) and radius `r`. */
const at = (t: number, r: number) => {
  const a = toRad(START + t * SWEEP);
  return [CENTRE + Math.cos(a) * r, CENTRE + Math.sin(a) * r] as const;
};

const CIRC = 2 * Math.PI * R;
/** Length of the visible 270° track. The remaining quarter stays dashed away. */
const TRACK = (SWEEP / 360) * CIRC;

/**
 * The redline segment, for the flare that fires at the limiter. Only this arc,
 * not the whole track: a full-track dash made the entire ring bloom magenta and
 * washed out the sweep underneath, which reads as a fault light rather than as
 * the top of the rev range.
 */
const HOT_FROM = HOT_RPM / DIAL_MAX;
const HOT_ARC = (1 - HOT_FROM) * TRACK;

/**
 * The boost reserve fills the quarter of the ring the rev counter does not use.
 *
 * The dial sweeps 270 degrees and leaves a 90 degree gap across the bottom.
 * That gap is the one piece of the instrument that is already a ring, already
 * empty, and already where the eye goes for the gear — so the reserve reads as
 * part of the same dial rather than as a second widget bolted beside it. It
 * fills clockwise out of the end of the rev sweep, continuing the direction the
 * needle travels, which is why it is not centred on the bottom.
 *
 * Sits on the outer band radius rather than the sweep's, to stay clear of the
 * "RPM x 1000" caption that lives in the same column at the bottom.
 */
const BOOST_R = R + 9;
const BOOST_CIRC = 2 * Math.PI * BOOST_R;
/** The gap: 360 - SWEEP degrees of it. */
const BOOST_TRACK = ((360 - SWEEP) / 360) * BOOST_CIRC;
/** Where the gap begins — the sweep's own far end. */
const BOOST_START = START + SWEEP;
/** Below this the reserve is shown as spent rather than as low. */
const BOOST_LOW = 0.25;
/** Where the BOOST caption sits: a little way into the gap, in the outer band. */
const BOOST_LABEL_AT = (() => {
  const a = toRad(BOOST_START + 22);
  return [CENTRE + Math.cos(a) * (R + 22), CENTRE + Math.sin(a) * (R + 22)] as const;
})();

/** How long the ignition sweep of the needle takes, up and back. */
const SWEEP_MS = 1400;

/** Shift-light strip: how many, and the rpm at which the first one lights. */
const LED_COUNT = 10;
const LED_FROM = VEHICLE.engine.maxRpm * 0.5;

const zoneColour = (rpm: number) =>
  rpm >= HOT_RPM ? HUD.hot : rpm >= WARM_RPM ? HUD.warm : HUD.cyan;

/** An arc of the dial as a path, for the coloured scale bands. */
function band(from: number, to: number, r: number) {
  const [x0, y0] = at(from, r);
  const [x1, y1] = at(to, r);
  const large = (to - from) * SWEEP > 180 ? 1 : 0;
  return `M${x0} ${y0}A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/* ------------------------------------------------------------------ component */

/**
 * The instrument cluster: one dial, with the speed read from its middle.
 *
 * Just the dial. A small grip arc sat beside it for a while, reading the rear
 * axle's slip in the slot a nitrous gauge would take; it was accurate and it
 * was one more thing to ignore, so it is gone.
 *
 * Speed sits inside the ring rather than in a box beside it, so there is a
 * single place to look — the number you steer by at the centre, the engine's
 * state as the ring around it, read peripherally without moving your eyes off
 * the road.
 *
 * Runs its own animation frame and writes straight into DOM nodes, the contract
 * the rest of the HUD keeps — telemetry changes every frame and React must
 * never see it. Each frame touches at most six properties, and only when the
 * displayed value has actually changed.
 *
 * A rail vehicle has no engine, so `TramRide` feeds a traction reading down the
 * same channel; the dial is relabelled for it rather than pretending the tram
 * has a crankshaft.
 */
export function RacingTacho({
  telemetry, distanceRef, unitRef, bestRef,
}: {
  telemetry: RefObject<VehicleTelemetry>;
  /** Trip readouts, written by the HUD's own loop; this only gives them a home. */
  distanceRef: RefObject<HTMLSpanElement | null>;
  unitRef: RefObject<HTMLSpanElement | null>;
  bestRef: RefObject<HTMLSpanElement | null>;
}) {
  const needleRef = useRef<SVGGElement>(null);
  const sweepRef = useRef<SVGCircleElement>(null);
  const gearRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const ledRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const boostRef = useRef<SVGCircleElement>(null);
  const boostFlareRef = useRef<SVGCircleElement>(null);
  const boostLabelRef = useRef<SVGTextElement>(null);

  useEffect(() => {
    let frame = 0;
    let lastSpeed = -1;
    let lastGear = '';
    let lastDeg = -999;
    let lastHot = false;
    let lastLeds = -1;
    let lastFlash = false;
    let lastCharge = -1;
    let lastBoosting = false;
    // The gauge sweep: for the first moment after the cluster appears the
    // needle runs to the redline and back, the self-test every car does at
    // ignition. It is theatre, and it is the theatre that tells you the
    // instrument is alive. `t0` is taken on the first frame so a slow load
    // does not eat it.
    let t0 = -1;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const t = telemetry.current;
      if (!t) return;
      if (t0 < 0) t0 = performance.now();
      const sweep = (performance.now() - t0) / SWEEP_MS;

      const speed = Math.round(t.speedKph);
      if (speed !== lastSpeed && speedRef.current) {
        speedRef.current.textContent = String(speed);
        lastSpeed = speed;
      }

      const gear = t.reversing ? 'R' : SELECTED.rail || SELECTED.air ? '—' : String(t.gear);
      if (gear !== lastGear && gearRef.current) {
        gearRef.current.textContent = gear;
        lastGear = gear;
      }

      const live = Math.min(1, Math.max(0, t.rpm / DIAL_MAX));
      // Up and back on a sine, then hand over to the engine.
      const ratio = sweep < 1 ? Math.max(live, Math.sin(sweep * Math.PI)) : live;
      // Quantised to a tenth of a degree: the pointer is smooth to the eye long
      // before it is smooth in the DOM, and this drops most frames' writes.
      const deg = Math.round((START + ratio * SWEEP) * 10) / 10;
      if (deg !== lastDeg) {
        if (needleRef.current) {
          needleRef.current.setAttribute('transform', `rotate(${deg} ${CENTRE} ${CENTRE})`);
        }
        if (sweepRef.current) {
          sweepRef.current.style.strokeDasharray = `${ratio * TRACK} ${CIRC}`;
          sweepRef.current.style.stroke = zoneColour(t.rpm);
        }
        lastDeg = deg;
      }

      // The redline segment flares — the one moment the HUD is allowed to draw
      // the eye away from the road.
      const hot = t.rpm >= HOT_RPM;
      if (hot !== lastHot && glowRef.current) {
        glowRef.current.style.opacity = hot ? '1' : '0';
        lastHot = hot;
      }

      // Boost reserve. Quantised to a hundredth for the same reason the pointer
      // is quantised to a tenth of a degree — the arc is smooth to the eye long
      // before it is smooth in the DOM. A rail vehicle has no reserve; its ring
      // stays empty and its caption dim.
      const charge = SELECTED.rail ? 0 : Math.round(Math.max(0, Math.min(1, t.boost)) * 100) / 100;
      const boosting = t.boosting;
      if (charge !== lastCharge || boosting !== lastBoosting) {
        // Spent reads differently from low: violet while there is a boost in
        // there to take, magenta once there is not, so the glance that matters
        // — is there anything left — needs no comparison against a scale.
        const colour = charge <= 0.001 ? HUD.hot : charge < BOOST_LOW ? HUD.warm : HUD.boost;
        if (boostRef.current) {
          boostRef.current.style.strokeDasharray = `${charge * BOOST_TRACK} ${BOOST_CIRC}`;
          boostRef.current.style.stroke = colour;
        }
        if (boostFlareRef.current) boostFlareRef.current.style.opacity = boosting ? '1' : '0';
        if (boostLabelRef.current) {
          boostLabelRef.current.style.fill = boosting ? '#ffffff' : colour;
          boostLabelRef.current.style.opacity = charge <= 0.001 && !boosting ? '0.45' : '1';
        }
        lastCharge = charge;
        lastBoosting = boosting;
      }

      // Shift lights: dark until the engine is working, then filling left to
      // right through the amber zone, and all flashing at the limiter — the
      // strip on the wheel of every race car, and the fastest thing on this
      // display to read out of the corner of an eye.
      const ledT = (t.rpm - LED_FROM) / (HOT_RPM - LED_FROM);
      const leds = hot ? LED_COUNT : Math.max(0, Math.min(LED_COUNT, Math.round(ledT * LED_COUNT)));
      const flash = hot && Math.floor(performance.now() / 110) % 2 === 0;
      if (leds !== lastLeds || flash !== lastFlash) {
        for (let i = 0; i < LED_COUNT; i++) {
          const led = ledRefs.current[i];
          if (!led) continue;
          const on = i < leds && !(hot && flash);
          const colour = hot ? HUD.hot : i >= LED_COUNT * 0.75 ? HUD.hot : i >= LED_COUNT * 0.45 ? HUD.warm : HUD.cyan;
          led.style.background = on ? colour : 'rgba(255,255,255,0.08)';
          led.style.boxShadow = on ? `0 0 8px ${colour}` : 'none';
        }
        lastLeds = leds;
        lastFlash = flash;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [telemetry]);

  return (
    // Scaled rather than reflowed on smaller viewports: a dial that has been
    // re-laid-out is a different instrument, whereas a smaller one is the same
    // instrument.
    <div
      className="absolute bottom-6 right-6 origin-bottom-right scale-[0.66] md:scale-[0.8] xl:scale-100"
      style={{ animation: 'hud-in 520ms cubic-bezier(0.2, 0.7, 0.2, 1) 280ms both' }}
    >
      {/* The dial, with the shift lights above it. */}
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex gap-[5px]" aria-hidden>
          {Array.from({ length: LED_COUNT }, (_, i) => (
            <span
              key={i}
              ref={(el) => { ledRefs.current[i] = el; }}
              className="h-[6px] w-[13px] transition-[background,box-shadow] duration-75"
              style={{
                clipPath: 'polygon(2px 0, 100% 0, calc(100% - 2px) 100%, 0 100%)',
                background: 'rgba(255,255,255,0.08)',
              }}
            />
          ))}
        </div>
      <div className="relative">
        <svg width="240" height="240" viewBox="0 0 240 240" className="block">
          {/* The dial's own plate. Round rather than rectangular: a box behind
              a circular instrument reads as a mistake, and the numbers only
              need lifting where they actually sit. */}
          <circle cx={CENTRE} cy={CENTRE} r={R + 13} fill="rgba(0,0,0,0.44)" />
          {/* Scale bands: the dial's colour zones, dim until the sweep reaches
              them. Three arcs rather than a conic gradient, which SVG has no
              way to lay along a stroke. */}
          <g fill="none" strokeWidth="3" strokeLinecap="butt" opacity="0.4"
             style={{ filter: INK_FILTER }}>
            <path d={band(0, WARM_RPM / DIAL_MAX, R + 9)} stroke={HUD.cyan} />
            <path d={band(WARM_RPM / DIAL_MAX, HOT_RPM / DIAL_MAX, R + 9)} stroke={HUD.warm} />
            <path d={band(HOT_RPM / DIAL_MAX, 1, R + 9)} stroke={HUD.hot} />
          </g>

          {/* Track and the live sweep. */}
          <circle
            cx={CENTRE} cy={CENTRE} r={R} fill="none"
            stroke={HUD.line} strokeWidth="6"
            strokeDasharray={`${TRACK} ${CIRC}`}
            transform={`rotate(${START - 90} ${CENTRE} ${CENTRE})`}
            style={{ filter: INK_FILTER }}
          />
          <circle
            ref={sweepRef}
            cx={CENTRE} cy={CENTRE} r={R} fill="none"
            stroke={HUD.cyan} strokeWidth="6" strokeLinecap="butt"
            strokeDasharray={`0 ${CIRC}`}
            transform={`rotate(${START - 90} ${CENTRE} ${CENTRE})`}
            style={{ filter: `drop-shadow(0 0 6px ${HUD.cyan}66)` }}
          />
          {/* Redline flare, opacity-driven, over its own segment only. */}
          <circle
            ref={glowRef}
            cx={CENTRE} cy={CENTRE} r={R} fill="none"
            stroke={HUD.hot} strokeWidth="10"
            strokeDasharray={`${HOT_ARC} ${CIRC}`}
            transform={`rotate(${START + HOT_FROM * SWEEP - 90} ${CENTRE} ${CENTRE})`}
            style={{
              opacity: 0, transition: 'opacity 120ms linear',
              filter: `blur(6px) drop-shadow(0 0 10px ${HUD.hot})`,
            }}
          />

          {/* The boost reserve, in the bottom gap. Track, fill, and a flare
              that lights while the reserve is being spent. */}
          {!SELECTED.rail && (
            <>
              <circle
                cx={CENTRE} cy={CENTRE} r={BOOST_R} fill="none"
                stroke={HUD.line} strokeWidth="3"
                strokeDasharray={`${BOOST_TRACK} ${BOOST_CIRC}`}
                transform={`rotate(${BOOST_START - 90} ${CENTRE} ${CENTRE})`}
                style={{ filter: INK_FILTER }}
              />
              <circle
                ref={boostRef}
                cx={CENTRE} cy={CENTRE} r={BOOST_R} fill="none"
                stroke={HUD.boost} strokeWidth="3" strokeLinecap="butt"
                strokeDasharray={`${BOOST_TRACK} ${BOOST_CIRC}`}
                transform={`rotate(${BOOST_START - 90} ${CENTRE} ${CENTRE})`}
                style={{ filter: `drop-shadow(0 0 5px ${HUD.boost}99)` }}
              />
              <circle
                ref={boostFlareRef}
                cx={CENTRE} cy={CENTRE} r={BOOST_R} fill="none"
                stroke={HUD.boost} strokeWidth="8"
                strokeDasharray={`${BOOST_TRACK} ${BOOST_CIRC}`}
                transform={`rotate(${BOOST_START - 90} ${CENTRE} ${CENTRE})`}
                style={{
                  opacity: 0, transition: 'opacity 120ms linear',
                  filter: `blur(5px) drop-shadow(0 0 8px ${HUD.boost})`,
                }}
              />
              <text
                ref={boostLabelRef}
                x={BOOST_LABEL_AT[0]} y={BOOST_LABEL_AT[1]}
                textAnchor="middle" dominantBaseline="central"
                fontSize="7.5" fontWeight="700" letterSpacing="1.6"
                fill={HUD.boost}
                style={{ filter: INK_FILTER }}
              >
                BOOST
              </text>
            </>
          )}

          {/* Ticks. */}
          {Array.from({ length: MAJORS * 2 + 1 }, (_, i) => {
            const rpm = i * 500;
            const t = rpm / DIAL_MAX;
            const major = i % 2 === 0;
            const [x0, y0] = at(t, R - 9);
            const [x1, y1] = at(t, R - (major ? 20 : 15));
            return (
              <line
                key={i} x1={x0} y1={y0} x2={x1} y2={y1}
                stroke={zoneColour(rpm)} strokeWidth={major ? 2.4 : 1.2}
                opacity={major ? 0.9 : 0.42} strokeLinecap="round"
                style={{ filter: INK_FILTER }}
              />
            );
          })}

          {/* Numerals, in the display face like every other number here. */}
          {Array.from({ length: MAJORS + 1 }, (_, i) => {
            const [x, y] = at((i * 1000) / DIAL_MAX, R - 34);
            return (
              <text
                key={i} x={x} y={y} textAnchor="middle" dominantBaseline="central"
                fontSize="14" fontWeight="500"
                fill={i * 1000 >= HOT_RPM ? HUD.hot : '#ffffff'}
                style={{ fontFamily: 'var(--font-hud)', filter: INK_FILTER }}
              >
                {i}
              </text>
            );
          })}

          {/* The pointer: a blade in the outer band, no hub. */}
          <g ref={needleRef} transform={`rotate(${START} ${CENTRE} ${CENTRE})`}>
            <path
              d={`M${CENTRE - 3.6} ${CENTRE - NEEDLE_FROM}L${CENTRE} ${CENTRE - NEEDLE_TO}L${CENTRE + 3.6} ${CENTRE - NEEDLE_FROM}Z`}
              fill={HUD.way}
              style={{ filter: `drop-shadow(0 0 7px ${HUD.way}cc)` }}
            />
          </g>
        </svg>

        {/* Centre stack: the speed you steer by, then its unit. Real DOM text
            laid over the SVG so it takes a text shadow and the display face. */}
        <div
          className="pointer-events-none absolute flex -translate-x-1/2 flex-col items-center"
          style={{ left: CENTRE, top: CENTRE - 46 }}
        >
          {/* Plain and centred. A fixed three-digit field with dimmed leading
              zeros was tried here to stop the reading re-centring at 9 -> 10;
              it fixed that and cost more than it saved, because every display
              face draws a squarish zero and "000" at a standstill reads as a
              row of blocks. The re-centring is mild and is what a centred
              readout is supposed to do. */}
          <div
            ref={speedRef}
            className="leading-none"
            style={{ ...NUM, ...INK, fontSize: 52, fontWeight: 700, color: HUD.text }}
          >
            0
          </div>
          <div
            className="mt-1.5"
            style={{ fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: '0.24em', color: HUD.cyan, fontWeight: 700 }}
          >
            KM/H
          </div>
        </div>

        {/* Bottom gap: gear, and what the ring is measuring. The sweep stops at
            ±135°, so this wedge is the one part of the face the pointer never
            crosses. */}
        <div
          className="pointer-events-none absolute flex -translate-x-1/2 flex-col items-center"
          style={{ left: CENTRE, top: CENTRE + 54 }}
        >
          <div
            ref={gearRef}
            className="flex h-[30px] min-w-[30px] items-center justify-center px-2 leading-none"
            style={{
              ...NUM, ...INK, fontSize: 22, fontWeight: 700, color: HUD.way,
              clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)',
              background: 'rgba(255,176,32,0.14)',
              boxShadow: 'inset 0 0 0 1px rgba(255,176,32,0.45)',
            }}
          >
            1
          </div>
          <div
            className="mt-1"
            style={{ fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: '0.18em', color: HUD.muted, fontWeight: 700 }}
          >
            {SELECTED.air ? 'MOTORS' : SELECTED.rail ? 'LOAD %' : 'RPM × 1000'}
          </div>
        </div>
      </div>

      {/* Odometer strip: trip and best speed, under the dial where a car keeps
          them. They spent a while as a column in the top-right corner, which
          put the least important numbers on screen in the most prominent
          position it has. */}
      <div
        className="mt-1 flex items-stretch"
        style={{ ...PLATE, clipPath: PLATE_CUT }}
      >
        <Odo label="TRIP">
          <span ref={distanceRef} style={{ ...NUM, fontSize: 17, fontWeight: 700, color: HUD.cyan }}>0</span>
          <span ref={unitRef} style={{ fontSize: 8.5, letterSpacing: '0.12em', fontWeight: 700, color: HUD.cyan }}>M</span>
        </Odo>
        <span aria-hidden className="my-2 w-px self-stretch" style={{ background: 'rgba(255,255,255,0.14)' }} />
        <Odo label={SELECTED.air ? 'ALT' : 'BEST'}>
          <span ref={bestRef} style={{ ...NUM, fontSize: 17, fontWeight: 700, color: HUD.text }}>0</span>
          <span style={{ fontSize: 8.5, letterSpacing: '0.12em', fontWeight: 700, color: HUD.muted }}>
            {SELECTED.air ? 'M' : 'KM/H'}
          </span>
        </Odo>
        <span aria-hidden className="w-[12px] shrink-0" style={HATCH} />
      </div>
      </div>
    </div>
  );
}

/** One odometer cell: a tiny label over a figure and its unit. */
function Odo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start px-3.5 py-1.5 pr-6 leading-none">
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: '0.2em', fontWeight: 700, color: HUD.faint }}>{label}</span>
      <span className="mt-1 flex items-baseline gap-1" style={INK}>{children}</span>
    </div>
  );
}
