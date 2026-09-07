import type { Metadata } from 'next';
import { PromoPoster } from '@/components/racing/PromoPoster';

/**
 * The advert, standalone.
 *
 * The same poster is the game's front door at `/` — see `app/page.tsx`. This
 * route exists so it also has a URL of its own to send someone, and because
 * here it is a **server component**: `PromoPoster` has no `'use client'` and
 * no hooks, so rendered from this file it ships zero client JavaScript.
 */
export const metadata: Metadata = {
  title: 'Motorpool — Drive It Like It’s Real',
  description:
    'Twelve machines, a procedural city with its own traffic and a 1.44 km circuit. '
    + 'Real suspension, real grip, in the browser.',
};

export default function PromoPage() {
  return <PromoPoster />;
}
