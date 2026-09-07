import type { Metadata, Viewport } from 'next';
import './globals.css';

const DESCRIPTION =
  'Drive a garage of twelve vehicles through a procedural city, built with Next.js, React Three Fiber and Rapier physics.';

export const metadata: Metadata = {
  /**
   * Only used to make `opengraph-image.png` an absolute URL, which is the one
   * thing Open Graph will not resolve relatively. Set NEXT_PUBLIC_SITE_URL when
   * the game is deployed somewhere; until then previews point at the dev server,
   * which is honest about where it is running.
   */
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'Motorpool · Driving Experience',
  description: DESCRIPTION,
  // The icons themselves are the `icon`/`apple-icon`/`favicon` files in this
  // directory; Next writes the <link> tags from them. See scripts/make-logo.mjs.
  openGraph: {
    title: 'Motorpool',
    description: DESCRIPTION,
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0d10',
  // The HUD is anchored to the viewport edges, so zooming would break the layout.
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden bg-[#0b0d10] text-white">{children}</body>
    </html>
  );
}
