'use client';

import type { ReactNode } from 'react';
import { WORLD_ID } from '@/config/world';
import { SELECTED } from '@/config/garage';
import { POINTWORK_ENABLED } from '@/config/pointwork';
import { ACCENT, HUD, NUM, accentAlpha } from './hudTheme';

/**
 * The controls page: real keycaps, in columns.
 *
 * It was one long list of slanted chips, and on a laptop screen it ran off the
 * bottom of the menu. Now the groups sit in a two-column grid so the whole page
 * is visible at once, and every key is drawn as a **keycap** — a face with a
 * lit legend on a darker body with a thicker bottom edge, which is what a key
 * looks like — so W, ↑, SHIFT and SPACE are recognisably the keys under your
 * fingers rather than labels about them. The driving group opens with the
 * WASD and arrow clusters laid out as they are on the keyboard, with each
 * key's job written on it, because that is how everyone actually learns a
 * driving game's controls: by looking at the cluster, not the list.
 *
 * A rail vehicle gets a shorter list because half of these do nothing on it:
 * the rails steer, so there is no steering and nothing to flip upright — and
 * SPACE is the emergency brake there, not a handbrake.
 */

/** One binding: alternatives (outer), each a chord of caps (inner). */
interface Binding {
  keys: string[][];
  label: string;
}

function groups(): { title: string; bindings: Binding[] }[] {
  if (SELECTED.rail) {
    return [
      {
        title: 'DRIVING',
        bindings: [
          { keys: [['W'], ['↑']], label: 'Power' },
          { keys: [['S'], ['↓']], label: 'Brake' },
          { keys: [['SPACE']], label: 'Emergency brake · holds until stopped' },
          // Only the main line has anything to change to. The tram's rails are
          // a single loop through the streets.
          ...(SELECTED.rail === 'main' && POINTWORK_ENABLED
            ? [{ keys: [['T']], label: 'Points · toggle the diverging route' }]
            : []),
        ],
      },
      { title: 'RECOVERY', bindings: [{ keys: [['R']], label: 'Back to the start' }] },
      {
        title: 'VIEW',
        bindings: [
          { keys: [['C']], label: 'Camera' },
          ...(WORLD_ID === 'city' ? [{ keys: [['M']], label: 'Map · waypoint' }] : []),
        ],
      },
      {
        title: 'GAME',
        bindings: [
          { keys: [['K']], label: 'Mute' },
          { keys: [['G']], label: 'Garage' },
          { keys: [['H']], label: 'This panel' },
          { keys: [['ESC']], label: 'Pause' },
        ],
      },
    ];
  }

  return [
    {
      title: 'DRIVING',
      bindings: [
        { keys: [['W'], ['↑']], label: 'Accelerate' },
        { keys: [['S'], ['↓']], label: 'Brake · Reverse' },
        { keys: [['A', 'D'], ['←', '→']], label: 'Steer' },
        { keys: [['SHIFT']], label: 'Boost' },
        { keys: [['SPACE']], label: 'Handbrake' },
      ],
    },
    {
      title: 'RECOVERY',
      bindings: [
        { keys: [['R']], label: 'Reset to road' },
        { keys: [['F']], label: 'Flip upright' },
      ],
    },
    {
      title: 'VIEW',
      bindings: [
        { keys: [['C']], label: 'Camera' },
        ...(WORLD_ID === 'city' ? [{ keys: [['M']], label: 'Map · waypoint' }] : []),
      ],
    },
    {
      title: 'GAME',
      bindings: [
        { keys: [['K']], label: 'Mute' },
        { keys: [['G']], label: 'Garage' },
        { keys: [['H']], label: 'This panel' },
        { keys: [['ESC']], label: 'Pause' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ keycaps */

/**
 * A keycap. The body is the darker block; the face sits on it 3 px short of
 * the bottom, so the bottom edge reads as the key's side — the one cue that
 * turns a rectangle into a key. `wide` for the modifier and bar keys.
 */
function Key({ children, wide, small, lit = true }: {
  children: ReactNode; wide?: boolean; small?: boolean; lit?: boolean;
}) {
  const h = small ? 28 : 34;
  return (
    <span
      className="inline-flex shrink-0 items-start"
      style={{
        height: h,
        minWidth: wide ? undefined : h,
        borderRadius: 5,
        background: 'rgba(0,0,0,0.85)',
        boxShadow: `inset 0 0 0 1px ${lit ? accentAlpha(0.35) : 'rgba(255,255,255,0.14)'}`,
      }}
    >
      <span
        className="flex h-full w-full items-center justify-center"
        style={{
          height: h - 3,
          minWidth: wide ? undefined : h,
          padding: wide ? '0 14px' : '0 6px',
          borderRadius: 4,
          background: lit
            ? `linear-gradient(180deg, ${accentAlpha(0.28)} 0%, ${accentAlpha(0.12)} 100%)`
            : 'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.06) 100%)',
          ...NUM,
          fontSize: small ? 11 : 13,
          fontWeight: 700,
          letterSpacing: '0.06em',
          color: lit ? '#dffbff' : HUD.muted,
        }}
      >
        {children}
      </span>
    </span>
  );
}

const WIDE = new Set(['SPACE', 'SHIFT', 'ESC', 'BACKSPACE', 'ENTER']);

/** The caps for one binding: chords side by side, alternatives joined by "or". */
function Caps({ keys }: { keys: string[][] }) {
  return (
    <span className="flex items-center gap-2">
      {keys.map((chord, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span style={{ fontSize: 10, letterSpacing: '0.1em', color: HUD.faint }}>or</span>}
          <span className="flex items-center gap-1">
            {chord.map((k) => <Key key={k} wide={WIDE.has(k)}>{k}</Key>)}
          </span>
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ cluster */

/**
 * The WASD block and the arrow block, drawn as they sit on the keyboard, with
 * each key's job under it. The picture of the controls, before the list.
 */
function Cluster({ keys, roles }: { keys: [string, string, string, string]; roles: [string, string, string] }) {
  const [up, left, down, right] = keys;
  const [goRole, stopRole, steerRole] = roles;
  const cell = 'flex flex-col items-center gap-1';
  const role = { fontSize: 8.5, letterSpacing: '0.16em', color: HUD.faint, fontWeight: 700 } as const;
  const hasSteer = left !== '';
  return (
    <div className="grid grid-cols-3 gap-x-1.5 gap-y-1">
      <span />
      <span className={cell}><Key>{up}</Key></span>
      <span />
      <span className={cell}>{hasSteer ? <Key>{left}</Key> : <span style={{ width: 38 }} />}</span>
      <span className={cell}><Key>{down}</Key></span>
      <span className={cell}>{hasSteer ? <Key>{right}</Key> : <span style={{ width: 38 }} />}</span>
      {/* The jobs, one under each column of keys, on the same grid so they
          cannot collide however long the words are. */}
      <span className="mt-1 text-center" style={role}>{hasSteer ? steerRole : ''}</span>
      <span className="mt-1 flex flex-col items-center leading-tight" style={{ ...role, color: ACCENT }}>
        <span>{goRole}</span>
        <span style={role}>{stopRole}</span>
      </span>
      <span className="mt-1 text-center" style={role}>{hasSteer ? steerRole : ''}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

/** The controls page of the pause menu. */
export function ControlsList() {
  const rail = Boolean(SELECTED.rail);
  const roles: [string, string, string] = rail
    ? ['POWER', 'BRAKE', '']
    : ['THROTTLE', 'BRAKE', 'STEER'];
  return (
    // Three columns on a full screen: the clusters own the first, the four
    // groups fill a 2×2 in the other two, and the page fits 720 px without a
    // scrollbar. Two columns on a laptop, one on a phone.
    <div className="grid gap-x-10 gap-y-7 md:grid-cols-2 lg:grid-cols-3">
      {/* The clusters: side by side when they span the top, stacked when they
          own a column. */}
      <div className="flex flex-wrap items-start gap-8 md:col-span-2 lg:col-span-1 lg:row-span-2 lg:flex-col">
        <Cluster keys={rail ? ['W', '', 'S', ''] : ['W', 'A', 'S', 'D']} roles={roles} />
        <Cluster keys={rail ? ['↑', '', '↓', ''] : ['↑', '←', '↓', '→']} roles={roles} />
      </div>

      {groups().map((group) => (
        <section key={group.title}>
          <div className="mb-3">
            <div style={{ fontSize: 10, letterSpacing: '0.34em', color: ACCENT, fontWeight: 700 }}>
              {group.title}
            </div>
            <div className="mt-1.5 h-px w-10" style={{ background: accentAlpha(0.6) }} />
          </div>
          <dl className="grid gap-y-2.5">
            {group.bindings.map((b) => (
              <div key={b.label} className="flex items-center gap-4">
                <dt className="min-w-[132px] shrink-0"><Caps keys={b.keys} /></dt>
                <dd style={{ fontSize: 13, color: HUD.text }}>{b.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
