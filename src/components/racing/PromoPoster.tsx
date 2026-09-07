/* eslint-disable @next/next/no-html-link-for-pages */
/*
 * Plain anchors, on purpose, for two reasons that both point the same way.
 *
 * First, correctness: `garage.ts` and `world.ts` resolve the selected vehicle
 * and world *once*, when their modules first evaluate, and `vehicleConfig`
 * freezes that into constants read from ~60 places. A client-side `Link`
 * navigation keeps the module graph alive, so a second trip into the game
 * would run the physics, cameras and HUD on whichever car was picked first.
 * The whole document has to reload; `GarageScreen` picks a vehicle the same
 * way.
 *
 * Second, reach: this file has **no `'use client'` and no hooks**, which is
 * what lets it serve two masters. Rendered from `app/promo/page.tsx` (a server
 * component) it ships zero client JavaScript; rendered from `app/page.tsx` (a
 * client component) it is simply part of that tree. A callback prop would have
 * broken the first case, so "start" is a URL, not an `onClick`.
 */
import Image from 'next/image';
import { barlow, barlowCondensed } from './garageFonts';
import { LOGO_BODY, LOGO_BOX, LOGO_FACE, LOGO_LIT } from './logoPaths';
import { DISPLAY, THEME } from './garageTheme';

/**
 * Where the poster sends you: the same document, with the flag that means
 * "skip the poster, open the picker". A full navigation rather than a state
 * change, for the module-freezing reason at the top of this file.
 */
export const GARAGE_HREF = '/?garage=1';

/**
 * The advert. A picture, four words, one button — and nothing else.
 *
 * Deliberately a **server component with no client JavaScript at all** — no
 * `'use client'`, no canvas, no model download, no hooks. One image and two
 * gradients.
 *
 * The backdrop is the whole poster: it already contains the cars, the city and
 * the weather, so nothing is composited on top of it. An earlier version put a
 * baked render of `mclaren.glb` on the right — `scripts/make-promo-art.mjs`,
 * still there, still run by `npm run promo:art` — which only works over an
 * empty road. Two sets of cars in one frame fight each other.
 *
 * **Everything is anchored to the bottom**, and the image's own composition is
 * why. Its cars sit low and centre-right, its sky fills the top, and the only
 * genuinely quiet area is the wet asphalt along the bottom edge. Copy on the
 * left — the obvious choice, and the first thing tried — lands squarely on the
 * nose of the lead car and needs a scrim heavy enough to erase the best part of
 * the picture. A dark wash rising from the bottom costs almost nothing and
 * covers only road.
 *
 * There is also no body copy, no kicker line and no stat card. Everything a
 * poster says beyond the headline is something the garage says better one
 * click later, and each line removed gave the picture more of the frame.
 *
 * The mark is inlined rather than imported from `Logo.tsx` because that
 * component calls `useId` for unique gradient ids, which a server component
 * cannot do. There is one mark here, so fixed ids are safe.
 *
 * Rendered both as the game's front door (`app/page.tsx`, before the garage)
 * and standalone at `/promo`. Nothing here imports the vehicle configs, so an
 * advert cannot drag the physics module graph — or the 148 KB of generated
 * city data — into its own bundle.
 */

/**
 * A generated image supplied for this page — not a photograph, and not a
 * render of anything in the game: the vehicles in it are not the vehicles in
 * the garage, and the lead car carries a visible manufacturer badge. Recorded
 * because an asset with no provenance is a liability later, and because that
 * badge is worth knowing about before this page goes anywhere public.
 */
const BACKDROP = '/promo/city-traffic.webp';

/**
 * The byline. Taken from the repository's own commit author rather than
 * invented, and kept as a constant so it is one edit and not a hunt through
 * markup.
 */
const DEVELOPER = 'Atul Senapati';

export function PromoPoster({ startHref = GARAGE_HREF }: { startHref?: string }) {
  return (
    <main
      className={`${barlow.variable} ${barlowCondensed.variable} relative h-dvh w-full overflow-hidden`}
      style={{ fontFamily: 'var(--font-ui)', color: '#ffffff', background: '#05090c' }}
    >
      {/*
        Layered by DOM order, not by negative z-index. An earlier version put
        the image on `-z-10` so the copy would sit above it without thinking
        about it, and the whole picture vanished behind this element's own
        background colour — a flat black page, while the network panel
        cheerfully showed the image loading 200 OK.
      */}
      <Image
        src={BACKDROP}
        alt="Traffic on a city expressway"
        fill
        priority
        sizes="100vw"
        className="pointer-events-none absolute inset-0 object-cover"
        style={{ objectPosition: 'center 58%' }}
      />

      {/* The wash that makes the type legible: bottom-up, and nothing else.
          Stops tuned against this image — its road is already dark below about
          70%, so the gradient stays clear of the cars entirely. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(5,9,12,0.55) 0%, rgba(5,9,12,0.05) 18%, rgba(5,9,12,0.10) 46%, rgba(5,9,12,0.70) 74%, rgba(5,9,12,0.95) 100%)',
        }}
        aria-hidden
      />
      {/* A breath of the brand blue along the bottom, so the advert belongs to
          the same product as the garage. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%]"
        style={{ background: `linear-gradient(180deg, transparent, ${THEME.accent}26)` }}
        aria-hidden
      />

      {/* ======================= nav ======================= */}
      <header className="relative z-20 mx-auto flex w-full max-w-[1320px] items-center px-6 pt-7 sm:px-10">
        <a href="/" className="flex items-center gap-3" aria-label="Motorpool home">
          <span
            className="grid h-10 w-10 place-items-center rounded-[10px]"
            style={{
              background: `linear-gradient(180deg, ${THEME.accentHi}, ${THEME.accent})`,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 8px 22px rgba(0,0,0,0.45)',
            }}
          >
            <Mark />
          </span>
          <span
            className="text-[22px] font-extrabold italic leading-none tracking-[0.03em]"
            style={{ ...DISPLAY, textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}
          >
            MOTORPOOL
          </span>
        </a>

        <a
          href={startHref}
          className="ml-auto flex h-10 items-center gap-2 rounded-[10px] px-5 text-[11px] font-extrabold tracking-[0.18em] transition-transform hover:-translate-y-px"
          style={{
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.22)',
            backdropFilter: 'blur(10px)',
            color: '#ffffff',
          }}
        >
          PLAY FREE
          <Arrow />
        </a>
      </header>

      {/* ======================= the poster line ======================= */}
      <section className="absolute inset-x-0 bottom-0 z-10">
        <div className="mx-auto w-full max-w-[1320px] px-6 pb-14 sm:px-10 sm:pb-16">
          {/* Clamped rather than fixed: the only element big enough that a
              1280 px laptop and a 2560 px monitor need different answers. */}
          <h1
            className="max-w-[16ch] font-extrabold italic leading-[0.88] tracking-[-0.02em]"
            style={{
              ...DISPLAY,
              fontSize: 'clamp(48px, 7vw, 108px)',
              textShadow: '0 10px 44px rgba(0,0,0,0.6)',
            }}
          >
            Drive It Like <span style={{ color: THEME.accentHi }}>It’s Real</span>
          </h1>

          {/*
            The button and the byline share one baseline band: button hard left,
            credit hard right, both bottom-aligned. That is what keeps the
            credit from reading as a fifth line of copy — it balances the
            composition instead of adding to it. `flex-wrap` stacks them on a
            narrow screen, where there is no room for two things on one line.
          */}
          <div className="mt-9 flex flex-wrap items-end justify-between gap-x-8 gap-y-7">
            <a
              href={startHref}
              className="group relative inline-flex h-[58px] w-[246px] items-center justify-center gap-3 overflow-hidden text-[21px] font-extrabold italic tracking-[0.06em] transition-transform hover:-translate-y-[2px]"
              style={{
                ...DISPLAY,
                color: '#ffffff',
                clipPath: 'polygon(18px 0, 100% 0, calc(100% - 18px) 100%, 0 100%)',
                background: `linear-gradient(180deg, ${THEME.accentHi} 0%, ${THEME.accent} 60%, ${THEME.accentLo} 100%)`,
                boxShadow: `inset 0 2px 0 rgba(255,255,255,0.5), inset 0 -6px 0 ${THEME.accentLo}, 0 16px 34px rgba(0,0,0,0.5)`,
              }}
            >
              START RACING
              <Arrow />
            </a>

            {/*
              The byline, set as a title block rather than a line of small
              print: an accent rule, the role in letterspaced caps, and the
              name in the same display italic the headline uses — so it reads
              as part of the poster's own typography instead of a footer.
            */}
            <div className="text-left sm:text-right">
              <div className="mb-2 h-[2px] w-9 sm:ml-auto" style={{ background: THEME.accentHi }} />
              <p
                className="text-[9px] font-extrabold tracking-[0.34em]"
                style={{ color: THEME.accentHi, textShadow: '0 2px 10px rgba(0,0,0,0.7)' }}
              >
                GAME DEVELOPER
              </p>
              <p
                className="mt-1.5 text-[22px] font-extrabold italic leading-none tracking-[0.01em]"
                style={{ ...DISPLAY, textShadow: '0 4px 18px rgba(0,0,0,0.7)' }}
              >
                {DEVELOPER}
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/* ---------------------------------------------------------------------------- */

function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" aria-hidden>
      <path d="M5 12h13M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The Motorpool mark, inlined. Geometry comes from `logoPaths.ts`, which
 * `scripts/make-logo.mjs` writes alongside the favicon, so this is the same
 * solid as the browser tab. Fixed gradient ids because the page has one mark.
 */
function Mark() {
  return (
    <svg
      height={20}
      width={(20 * LOGO_BOX.w) / LOGO_BOX.h}
      viewBox={`${LOGO_BOX.x} ${LOGO_BOX.y} ${LOGO_BOX.w} ${LOGO_BOX.h}`}
      role="img"
      aria-label="Motorpool"
    >
      <defs>
        <linearGradient id="promoFace" x1="0" y1="0" x2="0" y2={LOGO_BOX.h} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dde8ff" />
        </linearGradient>
        <linearGradient id="promoBody" x1="0" y1="0" x2="0" y2={LOGO_BOX.h} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={THEME.accentLo} />
          <stop offset="1" stopColor="#082a8c" />
        </linearGradient>
        <clipPath id="promoClip"><path d={LOGO_FACE} /></clipPath>
      </defs>
      <path d={LOGO_BODY} fill="url(#promoBody)" />
      <path d={LOGO_FACE} fill="url(#promoFace)" />
      <g clipPath="url(#promoClip)">
        <path d={LOGO_LIT} fill="none" stroke="#ffffff" strokeWidth={10} />
      </g>
    </svg>
  );
}
