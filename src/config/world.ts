/**
 * Which world the session drives in.
 *
 * Kept in its own module with no imports of its own: both `cityConfig` and
 * `surfaceGrip` need it, and `surfaceGrip` is imported by the city/track configs
 * in turn, so anything heavier here would close an import cycle.
 *
 * The city is the default. `?world=track` brings back the procedural circuit,
 * which is still fully wired — it is the only place the vehicle was calibrated
 * (see HANDOFF.md §4) and remains the reference for physics work.
 */
export type WorldId = 'city' | 'track';

function selectWorld(): WorldId {
  // `page.tsx` renders the scene with `ssr: false`, so this only ever runs in
  // the browser; the guard is for module evaluation during the server pass.
  if (typeof window === 'undefined') return 'city';
  return new URLSearchParams(window.location.search).get('world') === 'track' ? 'track' : 'city';
}

export const WORLD_ID: WorldId = selectWorld();
