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
  /** Synthesised engine note. */
  audio: boolean;
  /** The picture grade, applied as a CSS filter over the canvas. */
  brightness: number;
  contrast: number;
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

/** Index of the preset the game shipped with, so "default" means something. */
const FULL = TRAFFIC_LEVELS.length - 1;

export const DEFAULT_SETTINGS: GameSettings = {
  traffic: FULL,
  trams: true,
  audio: true,
  // Matches the grade that was hard-coded before this panel existed.
  brightness: 1.03,
  contrast: 1.08,
};

export const BRIGHTNESS_RANGE = { min: 0.8, max: 1.3, step: 0.01 };
export const CONTRAST_RANGE = { min: 0.85, max: 1.35, step: 0.01 };

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
    const stored = JSON.parse(raw) as Partial<GameSettings>;
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    return {
      traffic: clamp(stored.traffic, 0, TRAFFIC_LEVELS.length - 1, DEFAULT_SETTINGS.traffic),
      trams: typeof stored.trams === 'boolean' ? stored.trams : DEFAULT_SETTINGS.trams,
      audio: typeof stored.audio === 'boolean' ? stored.audio : DEFAULT_SETTINGS.audio,
      brightness: clamp(
        stored.brightness, BRIGHTNESS_RANGE.min, BRIGHTNESS_RANGE.max, DEFAULT_SETTINGS.brightness,
      ),
      contrast: clamp(
        stored.contrast, CONTRAST_RANGE.min, CONTRAST_RANGE.max, DEFAULT_SETTINGS.contrast,
      ),
    };
  } catch {
    // Private browsing, blocked site data, or malformed JSON. Defaults are fine.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: GameSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
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
