/**
 * Fetches the sky panorama and measures it.
 *
 *   node scripts/prepare-sky.mjs        # or: npm run prepare:sky
 *
 * The sky is a photograph rather than a gradient, and it has to be an
 * *equirectangular* one. A flat photo used as a backdrop stays pinned to the
 * screen: turn the car and the clouds turn with it, which is worse than no sky
 * at all. Unsplash is rectilinear photography, so the panorama comes from Poly
 * Haven instead — same idea, correct projection, and CC0 so nothing has to be
 * attributed or licensed.
 *
 * Downloads the tonemapped JPG (an LDR image; the .hdr would need a decoder
 * this project does not have, and a background does not need the dynamic
 * range), scales it to something shippable, and measures two things off the
 * pixels so the rest of the scene can agree with the picture:
 *
 *   - where the sun is, so the shadow-casting light matches the photographed
 *     sun instead of pointing wherever a constant happened to say
 *   - the colour of the horizon band, so the fog dissolves the city into this
 *     sky rather than into a grey that appears nowhere in it
 *
 * Emits:
 *   public/sky/<id>.jpg          the panorama
 *   src/config/skyData.json      path, sun angles, horizon colour, credit
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

/**
 * Bright blue with well-defined cumulus, chosen off a contact sheet of nine
 * candidates. The overcast and dusk options all read as gloomy behind a city
 * that is already fogged.
 */
const ID = 'kloofendal_48d_partly_cloudy_puresky';

/** Shipped width. 4096x2048 is sharp enough at the field of view a car sees. */
const WIDTH = 4096;
const HEIGHT = WIDTH / 2;

const OUT_DIR = 'public/sky';

async function main() {
  const meta = await fetch(`https://api.polyhaven.com/files/${ID}`).then((r) => {
    if (!r.ok) throw new Error(`Poly Haven metadata failed: ${r.status}`);
    return r.json();
  });

  const source = meta.tonemapped;
  if (!source?.url) throw new Error('no tonemapped JPG for this asset');
  console.log(`source ${(source.size / 1048576).toFixed(1)} MB  ${source.url}`);

  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const original = Buffer.from(await response.arrayBuffer());

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = `${OUT_DIR}/${ID}.jpg`;
  await sharp(original)
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    // 4:2:0 would smear the clean edges of the cloud tops; the file is small
    // enough at this quality that there is nothing to gain by it.
    .jpeg({ quality: 86, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outPath);

  /* ------------------------------------------------------ measure the sun */

  // Measured on a small copy: the sun is tens of degrees across in a tonemapped
  // panorama, so full resolution buys nothing and costs a 32 M pixel scan.
  const SCAN = 512;
  const { data } = await sharp(original)
    .resize(SCAN, SCAN / 2, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const scanWidth = SCAN;
  const scanHeight = SCAN / 2;
  const luminance = (o) => 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];

  // Upper half only. A pure sky mirrors the sky below the horizon, so the
  // reflected sun down there is just as bright and would drag the centroid to
  // the horizon if it were included.
  let brightest = 0;
  for (let y = 0; y < scanHeight / 2; y++) {
    for (let x = 0; x < scanWidth; x++) {
      brightest = Math.max(brightest, luminance((y * scanWidth + x) * 3));
    }
  }

  // Luminance-weighted centroid of everything near the peak. The disc clips to
  // flat white in a tonemapped image, so the single brightest pixel is an
  // arbitrary point inside a plateau; the centroid is the middle of it.
  const floor = brightest * 0.97;
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let y = 0; y < scanHeight / 2; y++) {
    for (let x = 0; x < scanWidth; x++) {
      const value = luminance((y * scanWidth + x) * 3);
      if (value < floor) continue;
      const weight = value - floor;
      sumX += x * weight;
      sumY += y * weight;
      sumWeight += weight;
    }
  }
  if (sumWeight === 0) throw new Error('no sun found in the upper hemisphere');

  const u = (sumX / sumWeight + 0.5) / scanWidth;
  const v = 1 - (sumY / sumWeight + 0.5) / scanHeight;

  // three's equirect mapping: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5.
  // Inverting gives the direction the sun is in, in the same convention the
  // scene already uses to build SUN_DIRECTION.
  const azimuth = (u - 0.5) * Math.PI * 2;
  const elevation = (v - 0.5) * Math.PI;

  /* -------------------------------------------------- measure the horizon */

  // A band just above the horizon, averaged the whole way round. Squared before
  // averaging: colour means nothing when averaged in gamma space, and a fog
  // colour mixed that way comes out noticeably darker than the sky it is
  // supposed to disappear into.
  const band = { from: Math.floor(scanHeight * 0.47), to: Math.floor(scanHeight * 0.5) };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = band.from; y < band.to; y++) {
    for (let x = 0; x < scanWidth; x++) {
      const o = (y * scanWidth + x) * 3;
      r += (data[o] / 255) ** 2;
      g += (data[o + 1] / 255) ** 2;
      b += (data[o + 2] / 255) ** 2;
      n++;
    }
  }
  const channel = (sum) => Math.round(Math.sqrt(sum / n) * 255);
  const horizon = `#${[channel(r), channel(g), channel(b)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;

  const info = await sharp(outPath).metadata();
  writeFileSync(
    'src/config/skyData.json',
    `${JSON.stringify(
      {
        image: `/sky/${ID}.jpg`,
        width: info.width,
        height: info.height,
        sun: {
          azimuth: Math.round(azimuth * 10000) / 10000,
          elevation: Math.round(elevation * 10000) / 10000,
          azimuthDeg: Math.round((azimuth * 180) / Math.PI),
          elevationDeg: Math.round((elevation * 180) / Math.PI),
        },
        horizon,
        credit: {
          id: ID,
          source: 'https://polyhaven.com/a/' + ID,
          licence: 'CC0',
        },
      },
      null,
      2,
    )}\n`,
  );

  // sharp's metadata() reports no size for a file on disk, hence the stat.
  const bytes = statSync(outPath).size;
  console.log(`wrote ${outPath} (${(bytes / 1048576).toFixed(2)} MB, ${info.width}x${info.height})`);
  console.log(
    `sun  azimuth ${((azimuth * 180) / Math.PI).toFixed(1)}deg  elevation ${((elevation * 180) / Math.PI).toFixed(1)}deg`,
  );
  console.log(`horizon ${horizon}`);
}

await main();
