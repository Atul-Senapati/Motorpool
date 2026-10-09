'use client';

import { useEffect, useState } from 'react';
import type { GarageVehicle } from '@/config/garage';
import { ThumbStudio } from './garageThumbStudio';
import { shippedThumb } from './garageThumbIndex';

export { THUMB_H, THUMB_W } from './garageThumbStudio';

/**
 * Bump when the shot changes (lighting, angle, size), so stale images are
 * re-rendered rather than served from cache for ever. v4: the render gained
 * an environment map and a ground shadow — see the module doc below — and
 * the camera switched from its own ad hoc angle to the shared `frameVehicle`,
 * which is also when the tram's thumbnail stopped looking like a sliver.
 */
// v5: the tram model was replaced (G:link Flexity -> Melbourne C-class),
// so every cached picture of the old one has to be thrown away. v6: replaced
// again, back to a G:link Flexity 2 — same reason.
//
// v7: the main line gained a second class, and `train.glb` stopped being the
// Class 91 and became a Class 43. The cache key is the vehicle *id*, not the
// file, so `train` kept serving a picture of a locomotive that is no longer in
// it — and since the new `train91` entry rendered the Class 91 fresh, the
// roster showed the same locomotive twice under two names. The id surviving a
// model swap is the whole reason this constant exists.
const CACHE_VERSION = 'v8';
const key = (id: string) => `motorpool.thumb.${CACHE_VERSION}.${id}`;

/** A vehicle's picture: the shipped one, or one shot in this browser, or null. */
export function cachedThumb(id: string): string | null {
  const ship = shippedThumb(id);
  if (ship) return ship;
  try { return window.localStorage.getItem(key(id)); } catch { return null; }
}

/**
 * Pictures for the rail: shipped ones first, then this browser's cache, and
 * only for a vehicle with neither, a live shot of the one being looked at.
 *
 * **Shipped first (2026-10).** Every vehicle's picture is in the repo now
 * (`public/garage/thumbs`, see `shippedThumb`), so a first visit shows the
 * whole rail at once — plain images, no model downloads, no render. What
 * follows is the fallback for a vehicle added since the bench last ran.
 *
 * There are no vehicle images in this project — it ships models, not renders —
 * and the roster wants pictures, not names. So the pictures are made here, from
 * the same GLBs the stage uses, and kept in localStorage. On a return visit the
 * rail is populated before the first model has downloaded.
 *
 * **It used to shoot the entire roster on mount**, walking a queue of every
 * vehicle without a cached picture. One at a time, so never a stampede of
 * parallel requests — but still, opening the garage for the first time pulled
 * down all twelve models back to back whether or not you ever looked at them,
 * which is most of what made a cold garage slow, and it left every model
 * resident on a machine that may not have the memory for them.
 *
 * Now it shoots exactly one vehicle: the focused one, when it has no picture
 * yet. That makes a thumbnail **free**. The stage is already downloading that
 * model to put it on the turntable, `useGLTF` shares its cache, so the picture
 * costs a render of something already in memory and no download at all. Browse
 * the roster and the rail fills in behind you, one vehicle per vehicle you
 * actually look at, and the cache means it only ever happens once per browser.
 *
 * The trade is visible and deliberate: on a first visit the cards you have not
 * been to yet are placeholders rather than pictures. Loading twelve models to
 * fill them is the cost that was being complained about.
 *
 * The first version of this lit the scene with three flat, uncoordinated
 * lights and nothing for the vehicle to reflect or sit on — no environment
 * map, no floor, no shadow. Direct light alone does not make a PBR material
 * look like paint; paint reads from what it reflects, and metallic or
 * clearcoat surfaces with nothing to reflect read as dull plastic regardless
 * of how many lights point at them. It now shares the stage's own studio
 * environment map and gets a soft radial "ground blob" standing in for a
 * contact shadow — cheaper than a real shadow map for a canvas that renders
 * exactly one frame and is thrown away, but enough to stop the vehicle
 * looking like it is floating in a void.
 *
 * Reports cached images through `onShot` on mount as well, so the parent has a
 * single path for "here is a picture of vehicle X" and no cache logic of its own.
 */
export default function GarageThumbs({
  vehicles,
  focusedId,
  onShot,
}: {
  vehicles: GarageVehicle[];
  /** The vehicle on the turntable. The only one this will ever load. */
  focusedId: string;
  onShot: (id: string, url: string) => void;
}) {
  /*
   * The cache is read once, in a lazy initialiser rather than an effect. This
   * component is loaded with `ssr: false`, so there is no server render to
   * disagree with, and it keeps the queue derived instead of synchronised —
   * setting state from inside an effect body is the cascading-render pattern
   * the project's lint forbids.
   */
  const [cached] = useState(() => {
    const hits: Array<[string, string]> = [];
    for (const v of vehicles) {
      let hit: string | null = shippedThumb(v.id);
      if (!hit) {
        try { hit = window.localStorage.getItem(key(v.id)); } catch { /* private mode */ }
      }
      if (hit) hits.push([v.id, hit]);
    }
    return hits;
  });
  const [shot, setShot] = useState<Record<string, true>>(
    () => Object.fromEntries(cached.map(([id]) => [id, true])),
  );
  // Reporting to the parent is an effect on an external party, not our state.
  useEffect(() => { for (const [id, url] of cached) onShot(id, url); }, [cached, onShot]);

  // The one vehicle worth rendering: the one being looked at, if it has no
  // picture yet. Everything else waits until it is looked at.
  const current = shot[focusedId] ? undefined : vehicles.find((v) => v.id === focusedId);
  if (!current) return null;

  return (
    <ThumbStudio
      key={current.id}
      vehicle={current}
      onDone={(url) => {
        try { window.localStorage.setItem(key(current.id), url); } catch { /* full or private */ }
        onShot(current.id, url);
        setShot((done) => ({ ...done, [current.id]: true }));
      }}
    />
  );
}
