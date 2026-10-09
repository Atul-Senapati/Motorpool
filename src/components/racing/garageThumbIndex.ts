import shipped from '@/config/garageThumbs.json';

/**
 * The pictures that ship with the game: one per vehicle, shot by the
 * `/thumbs` bench into `public/garage/thumbs/<id>.webp`, small and low
 * quality on purpose — a rail card is 184 × 112. The manifest maps each id to
 * a hash of its file, which is the cache-buster: a re-shot picture has a new
 * URL, an unchanged one stays in the browser's cache.
 *
 * Its own module, with nothing in it but the list, so the garage can fill
 * the rail on its very first render — before three.js, which every renderer
 * of pictures drags in, has even started to download.
 */
const SHIPPED = (shipped as { thumbs: Record<string, string> }).thumbs;

export const shippedThumb = (id: string): string | null =>
  (SHIPPED[id] ? `/garage/thumbs/${id}.webp?v=${SHIPPED[id]}` : null);
