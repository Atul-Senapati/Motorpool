'use client';

import dynamic from 'next/dynamic';

/**
 * Shoots every garage vehicle's thumbnail into the repo — see `ThumbBench`.
 * A development tool, not part of the game: `npm run dev`, open `/thumbs`,
 * wait for it to say done, commit `public/garage/thumbs` and the manifest.
 */
const ThumbBench = dynamic(() => import('@/components/racing/ThumbBench').then((m) => m.ThumbBench), { ssr: false });

export default function ThumbsPage() {
  return <ThumbBench />;
}
