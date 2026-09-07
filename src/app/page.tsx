'use client';

import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { GarageScreen, urlForVehicle } from '@/components/racing/GarageScreen';
import { PromoPoster } from '@/components/racing/PromoPoster';
import { CAR_PARAM, GARAGE } from '@/config/garage';

/**
 * The scene is client-only: it builds canvas-backed textures during render and
 * touches WebGL immediately, neither of which can run on the server.
 */
const RacingScene = dynamic(
  () => import('@/components/racing/RacingScene').then((m) => m.RacingScene),
  { ssr: false },
);

/** Set by the poster's own button — see `GARAGE_HREF` in `PromoPoster`. */
const GARAGE_PARAM = 'garage';

/**
 * Poster, then the garage, then the drive — all three at this one URL, chosen
 * from the query string rather than from state.
 *
 * That is deliberate and it is the same reason the garage reloads the page when
 * you pick a car: `garage.ts` resolves `SELECTED` when its module first
 * evaluates and `vehicleConfig` freezes it into constants read from ~60 places,
 * so the URL is the only honest place for "which car". Keeping the *screen* in
 * the URL too means every step is linkable and the back button works through
 * the whole flow — poster → picker → drive — instead of trapping someone in
 * the scene.
 *
 * A deep link with `?car=` skips both screens on purpose: someone sent a link
 * to a specific vehicle wants to drive it, not to read an advert first.
 */
function Chooser() {
  const params = useSearchParams();
  const chosen = GARAGE.some((vehicle) => vehicle.id === params.get(CAR_PARAM));

  if (chosen) return <RacingScene />;
  if (!params.has(GARAGE_PARAM)) return <PromoPoster />;
  return (
    <GarageScreen onPick={(vehicle) => { window.location.href = urlForVehicle(vehicle.id); }} />
  );
}

export default function Page() {
  return (
    <main className="h-dvh w-full overflow-hidden bg-[#0b0d10]">
      {/* `useSearchParams` suspends during the static pass. */}
      <Suspense fallback={<div className="h-dvh w-full bg-[#0b0d10]" />}>
        <Chooser />
      </Suspense>
    </main>
  );
}
