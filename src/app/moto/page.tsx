'use client';

import dynamic from 'next/dynamic';

/** A bench for the Firehawk and its rider — see `MotoLab`. Not part of the game. */
const MotoLab = dynamic(() => import('@/components/racing/MotoLab').then((m) => m.MotoLab), { ssr: false });

export default function MotoPage() {
  return <MotoLab />;
}
