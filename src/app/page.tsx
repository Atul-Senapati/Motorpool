'use client';

import dynamic from 'next/dynamic';

/**
 * The scene is client-only: it builds canvas-backed textures during render and
 * touches WebGL immediately, neither of which can run on the server.
 */
const RacingScene = dynamic(
  () => import('@/components/racing/RacingScene').then((m) => m.RacingScene),
  { ssr: false },
);

export default function Page() {
  return (
    <main className="h-dvh w-full overflow-hidden bg-[#0b0d10]">
      <RacingScene />
    </main>
  );
}
