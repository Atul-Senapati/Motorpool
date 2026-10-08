'use client';

import dynamic from 'next/dynamic';

/** A bench for the beach's quad riders — see `QuadLab`. Not part of the game. */
const QuadLab = dynamic(() => import('@/components/racing/QuadLab').then((m) => m.QuadLab), { ssr: false });

export default function QuadPage() {
  return <QuadLab />;
}
