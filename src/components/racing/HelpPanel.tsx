'use client';

import { WORLD_ID } from '@/config/world';
import { SELECTED } from '@/config/garage';
import { HUD } from './hudTheme';

/**
 * The controls, grouped by what they are for.
 *
 * A rail vehicle gets a shorter list because half of these do nothing on it:
 * the rails steer, so there is no steering, no handbrake and nothing to flip
 * upright. Showing keys that are dead on the current vehicle is worse than
 * showing none.
 */
function groups(): { title: string; keys: [string, string][] }[] {
  if (SELECTED.rail) {
    return [
      { title: 'DRIVING', keys: [['W / ↑', 'Power'], ['S / ↓', 'Brake']] },
      {
        title: 'VIEW',
        keys: [
          ['C', 'Camera'],
          ...(WORLD_ID === 'city' ? [['M', 'Map · waypoint'] as [string, string]] : []),
        ],
      },
      { title: 'GAME', keys: [['K', 'Mute'], ['G', 'Garage'], ['H', 'This panel']] },
    ];
  }

  return [
    {
      title: 'DRIVING',
      keys: [
        ['W / ↑', 'Accelerate'],
        ['S / ↓', 'Brake · Reverse'],
        ['A D / ← →', 'Steer'],
        ['SPACE', 'Handbrake'],
      ],
    },
    {
      title: 'RECOVERY',
      keys: [['R', 'Reset to road'], ['F', 'Flip upright']],
    },
    {
      title: 'VIEW',
      keys: [
        ['C', 'Camera'],
        ...(WORLD_ID === 'city' ? [['M', 'Map · waypoint'] as [string, string]] : []),
      ],
    },
    {
      title: 'GAME',
      keys: [['K', 'Mute'], ['G', 'Garage'], ['H', 'This panel']],
    },
  ];
}

/** The controls list. A page of the pause menu. */
export function ControlsList() {
  return (
    <div>
      {groups().map((group) => (
        <section key={group.title} className="mb-4 last:mb-0">
          <div
            className="mb-2"
            style={{ fontSize: 8.5, letterSpacing: '0.32em', color: HUD.cyan, fontWeight: 700 }}
          >
            {group.title}
          </div>
          <dl className="grid gap-y-1.5">
            {group.keys.map(([key, label]) => (
              <div key={key} className="flex items-baseline gap-3">
                <dt
                  className="w-[92px] shrink-0 rounded px-1.5 py-1 text-center"
                  style={{
                    fontSize: 9.5, letterSpacing: '0.06em', fontWeight: 700, color: HUD.cyan,
                    background: 'rgba(79,219,232,0.10)', border: `1px solid rgba(79,219,232,0.28)`,
                  }}
                >
                  {key}
                </dt>
                <dd style={{ fontSize: 10.5, color: HUD.muted }}>{label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
