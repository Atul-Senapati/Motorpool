import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Saves a garage thumbnail shot by the `/thumbs` bench into the repo:
 * `public/garage/thumbs/<id>.webp`, and its hash into
 * `src/config/garageThumbs.json`, which the rail reads (`GarageThumbs`).
 *
 * Development only. It writes to the source tree, which a deployed server
 * has no business doing — and in production there is nothing here at all.
 */
const DIR = path.join(process.cwd(), 'public', 'garage', 'thumbs');
const MANIFEST = path.join(process.cwd(), 'src', 'config', 'garageThumbs.json');

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  const { id, data } = (await request.json()) as { id?: string; data?: string };
  if (!id || !/^[a-z0-9_-]+$/i.test(id) || !data?.startsWith('data:image/webp;base64,')) {
    return Response.json({ error: 'expected { id, data: webp data URL }' }, { status: 400 });
  }
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, `${id}.webp`), bytes);

  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  let manifest: { thumbs: Record<string, string> } = { thumbs: {} };
  try { manifest = JSON.parse(await readFile(MANIFEST, 'utf8')); } catch { /* first one */ }
  manifest.thumbs[id] = hash;
  const sorted = Object.fromEntries(Object.entries(manifest.thumbs).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(MANIFEST, `${JSON.stringify({ thumbs: sorted }, null, 2)}\n`);
  return Response.json({ id, bytes: bytes.length, hash });
}
