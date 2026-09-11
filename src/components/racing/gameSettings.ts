import catalogue from '@/config/vehicleCatalogue.json';
import { TRAFFIC } from '@/config/trafficConfig';

/**
 * Player-adjustable settings, and where they are kept.
 *
 * Everything here is something the running scene can change on the next frame
 * without rebuilding anything. That is the admission test: a setting that needs
 * the world torn down and re-created belongs in the garage screen or the URL,
 * not in a panel you open while driving.
 */
export interface GameSettings {
  /** Index into `TRAFFIC_LEVELS`. */
  traffic: number;
  /** Service trams on the city loop. */
  trams: boolean;
  /**
   * Scripted trains on the main line. The railway stays either way — the
   * track, its bridges and its tunnel are the ground the stations stand on,
   * and removing them would leave a station on a viaduct to nowhere. What this
   * turns off is the rolling stock, which is where the cost is: a service is
   * two locomotives and its coaches, a coach is 95 k triangles, and there is a
   * service each way. Measured in the city, with the services off, WebGL draw
   * calls per frame went from 2,154 to 1,092 — about half the frame.
   */
  train: boolean;
  /** Synthesised engine note. */
  audio: boolean;
  /** The picture grade, applied as a CSS filter over the canvas. */
  brightness: number;
  contrast: number;
  /**
   * Coaches on the main-line train, 0-10.
   *
   * It passes the admission test above by a whisker: changing it remounts eight
   * clones of two shared GLTF scenes and their kinematic bodies, which is a
   * React re-render rather than a rebuild of the world — the models are already
   * loaded and the geometry is shared, so a coach costs a draw call and a
   * matrix. The two locomotives are not counted here; they are the formation
   * (see `FORMATION` in `trainConfig`), and at zero you get them back to back.
   */
  carriages: number;
}

/**
 * Total traffic slots, which is the ceiling on the density setting.
 *
 * `Traffic` mounts one Rapier body per slot at startup and they are never
 * sleeping, so the slot count is a fixed cost paid whether or not a car is
 * using it. "Full" is therefore the population the game already had rather
 * than an increase — offering a denser-than-default option would mean carrying
 * extra always-awake bodies for everyone, and the framerate cost of that could
 * not be measured here.
 */
export const TRAFFIC_SLOTS = catalogue.vehicles.length * TRAFFIC.perType;

/** Density presets, as a cap on live cars. */
export const TRAFFIC_LEVELS: { label: string; cars: number }[] = [
  { label: 'OFF', cars: 0 },
  { label: 'LOW', cars: Math.round(TRAFFIC_SLOTS * 0.3) },
  { label: 'MEDIUM', cars: Math.round(TRAFFIC_SLOTS * 0.6) },
  { label: 'FULL', cars: TRAFFIC_SLOTS },
];

/**
 * The preset a new install gets. MEDIUM: enough cars that every street has
 * someone on it, few enough that the player is driving rather than queuing.
 * It shipped at FULL, which with the old raster-following AI was forty cars
 * weaving in a small area and read as a swarm.
 */
const MEDIUM = TRAFFIC_LEVELS.findIndex((level) => level.label === 'MEDIUM');

/**
 * Bumped when a default changes in a way an existing install should pick up.
 * A stored settings blob from before this version has its traffic level reset
 * to the new default; everything else it chose is kept.
 */
const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: GameSettings = {
  traffic: MEDIUM,
  trams: true,
  train: true,
  audio: true,
  // Matches the grade that was hard-coded before this panel existed.
  brightness: 1.03,
  contrast: 1.08,
  carriages: 5,
};

export const BRIGHTNESS_RANGE = { min: 0.8, max: 1.3, step: 0.01 };
export const CONTRAST_RANGE = { min: 0.85, max: 1.35, step: 0.01 };
/**
 * Ten is the ceiling because of what it costs, not because of the line: the
 * coach is 95 k triangles after decimation, so ten of them plus the two
 * locomotives is 1.5 M — half the city again, for one vehicle. The line itself
 * would take a much longer train.
 */
export const CARRIAGE_RANGE = { min: 0, max: 10, step: 1 };

const KEY = 'motorpool:settings';

/**
 * Reads stored settings, or the defaults.
 *
 * Must only be called after mount. `localStorage` is state the server cannot
 * see, so reading it while rendering makes the server and the browser disagree
 * — the same hydration error the garage's remembered-vehicle lookup threw
 * before it moved to `useSyncExternalStore`.
 *
 * Every field is validated rather than trusted: this is parsed JSON from a
 * store the user can edit, and a stale key from an older build could otherwise
 * put a `NaN` into a CSS filter or an out-of-range index into the presets.
 */
export function loadSettings(): GameSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = JSON.parse(raw) as Partial<GameSettings> & { version?: number };
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    // See SETTINGS_VERSION: an older blob's traffic level is not trusted.
    const traffic = (stored.version ?? 1) >= SETTINGS_VERSION ? stored.traffic : undefined;
    return {
      traffic: clamp(traffic, 0, TRAFFIC_LEVELS.length - 1, DEFAULT_SETTINGS.traffic),
      trams: typeof stored.trams === 'boolean' ? stored.trams : DEFAULT_SETTINGS.trams,
      // `train` arrived after SETTINGS_VERSION 2 and deliberately did not bump
      // it: an absent field falls back to its default here, which is all a new
      // setting needs, whereas bumping would reset every existing install's
      // traffic level for no reason (see SETTINGS_VERSION).
      train: typeof stored.train === 'boolean' ? stored.train : DEFAULT_SETTINGS.train,
      audio: typeof stored.audio === 'boolean' ? stored.audio : DEFAULT_SETTINGS.audio,
      brightness: clamp(
        stored.brightness, BRIGHTNESS_RANGE.min, BRIGHTNESS_RANGE.max, DEFAULT_SETTINGS.brightness,
      ),
      contrast: clamp(
        stored.contrast, CONTRAST_RANGE.min, CONTRAST_RANGE.max, DEFAULT_SETTINGS.contrast,
      ),
      // Rounded as well as clamped: this one indexes a formation, and a stored
      // 6.5 would put half a coach on the end of the train.
      carriages: Math.round(clamp(
        stored.carriages, CARRIAGE_RANGE.min, CARRIAGE_RANGE.max, DEFAULT_SETTINGS.carriages,
      )),
    };
  } catch {
    // Private browsing, blocked site data, or malformed JSON. Defaults are fine.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: GameSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch {
    // Storage unavailable. The settings still apply for this session.
  }
}

/* ----------------------------------------------------------------- the store */

/**
 * Settings live in a module-level store read through `useSyncExternalStore`,
 * not in component state seeded from an effect.
 *
 * The obvious version — `useState(DEFAULT)` plus `useEffect(() => setState(
 * loadSettings()))` — reads correctly but sets state synchronously inside an
 * effect, which is a cascading render and which the React Compiler lint rules
 * reject outright. `useSyncExternalStore` is the sanctioned way to read state
 * the server cannot see: it renders the server snapshot during hydration and
 * swaps in the real value immediately afterwards, with no mismatch. The garage
 * already reads its remembered vehicle the same way.
 */
let current: GameSettings | null = null;
const listeners = new Set<() => void>();

export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The client snapshot. Cached, because `useSyncExternalStore` compares
 * snapshots by identity — building a fresh object per call would re-render for
 * ever.
 */
export function settingsSnapshot(): GameSettings {
  current ??= loadSettings();
  return current;
}

/** Hydration reads this, so nothing touches `localStorage` during SSR. */
export function serverSettingsSnapshot(): GameSettings {
  return DEFAULT_SETTINGS;
}

export function updateSettings(next: Partial<GameSettings>) {
  current = { ...settingsSnapshot(), ...next };
  saveSettings(current);
  for (const listener of listeners) listener();
}
