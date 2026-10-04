'use client';

import dynamic from 'next/dynamic';

/**
 * A bench for the rigged civilians: all twelve figures, walking, running or
 * standing, under orbit controls. Not part of the game — it is where the gait
 * is tuned before anyone is let loose on the pavements.
 */
const CivilianLab = dynamic(
  () => import('@/components/racing/CivilianLab').then((m) => m.CivilianLab),
  { ssr: false },
);

export default function PeoplePage() {
  return <CivilianLab />;
}
