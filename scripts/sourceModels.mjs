/**
 * Where the raw, unprocessed model downloads live.
 *
 * Every `prepare-*.mjs` script reads a Sketchfab export and writes something
 * smaller into `public/models/`. Those exports used to sit loose in the repo
 * root — 28 files and 670 MB of them by the end, which buried the actual
 * project in a list of `train_-_british_rail_class_91_power_car.glb`. They are
 * now all in `source-models/`, and this is the one place that knows that.
 *
 * `source()` rather than a string prefix at every call site, for two reasons:
 * the scripts keep their tables of plain, recognisable file names, and a name
 * that has *not* been moved yet still resolves, so a freshly downloaded file
 * dropped in the repo root works before it is filed away. It is also what lets
 * `npm run inspect -- <path>` keep taking a path of any shape.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Untracked: see `.gitignore`. Sources are downloads, not project files. */
export const SOURCE_DIR = 'source-models';

/**
 * Resolves a raw source model to a path that exists, preferring the folder.
 *
 * Throws naming both places it looked rather than letting the caller's own
 * `io.read` fail on a bare ENOENT, because "which file, and where did you
 * expect it" is the entire question when one of these scripts cannot start.
 */
export function source(file) {
  const filed = join(SOURCE_DIR, basename(file));
  if (existsSync(filed)) return filed;
  if (existsSync(file)) return file;
  throw new Error(`source model not found: looked in ${filed} and ${file}`);
}
