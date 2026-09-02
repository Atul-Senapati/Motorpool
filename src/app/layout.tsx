import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'McLaren F1 · Driving Experience',
  description:
    'An interactive McLaren F1 1993 driving experience built with Next.js, React Three Fiber and Rapier physics.',
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
