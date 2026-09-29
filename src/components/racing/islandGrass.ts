import {
  CanvasTexture, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace,
  Vector4, type Texture,
} from 'three';

/**
 * The turf every made island in this world is grassed with.
 *
 * This was Halcyon Field's, and only Halcyon Field's: the airport island got a
 * photographed lawn under a painted mottle, and the railway islands got a flat
 * `TOWN_PALETTE.grass`. From the air that is not two greens, it is a *material*
 * and a *colour* — one has grain that resolves as you come down to it and the
 * other stays a sheet of paint at any height, and Kestrel has a school, a park,
 * a stage and a cruise berth standing on the paint.
 *
 * So it lives here, and both use it.
 *
 * ## The two textures
 *
 * `GRASS_TILE` is grass extracted from the city map's own ground atlas
 * (`drive_for_speed_-_map.glb`, the mown lawn in `Auxiliar_texture_1024`), cut
 * square, made seamless and saved as a 512 px WebP — so an island's turf is the
 * same grass the city's parks are made of, at a walker's scale, repeating every
 * `GRASS_REPEAT` m. On its own that is a tiled texture and reads as one from
 * the drone.
 *
 * The **mottle** is what hides the repeat: ONE grey canvas over the whole site
 * in metres, soft noise at four scales, so the value drifts gently at field
 * scale and no two tiles come out the same brightness. Painted blobs and specks
 * were tried and read as a cartoon; a brush is what you see from the air, not
 * grass.
 *
 * ## Why the UVs can come from the position
 *
 * Halcyon's crown is built with planar UVs baked into it. The railway islands'
 * crown is a triangle fan with a hole cut in it for Kestrel Water and no `uv`
 * attribute at all, and adding one would mean two places that both know what
 * the tile scale is. `planarUv` instead sets `vMapUv` from the vertex position
 * in the shader, which is the same projection one step later and works on any
 * geometry, UVs or no UVs.
 *
 * Both paths use the vertex's **local** position, so a mesh inside a
 * transformed group (Halcyon) measures in island metres and one built in world
 * XZ (the railway islands) measures in world metres. Pass the bounds in
 * whichever frame the geometry is in.
 */
export const GRASS_TILE = '/textures/island-grass.webp';
export const GRASS_REPEAT = 7;

/** Metres to mottle pixels. Two over a kilometre is a 2,000 px canvas. */
const GRASS_PX_PER_M = 2;

export interface GrassBounds { x0: number; x1: number; z0: number; z1: number }

/** The bounding box of one or more closed XZ outlines. */
export function grassBounds(
  outlines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): GrassBounds {
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const outline of outlines) {
    for (const [x, z] of outline) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  return { x0, x1, z0, z1 };
}

/**
 * A square of grey value noise, `size` cells across, in its own canvas. Drawn
 * onto the mottle at full size with smoothing on, it becomes soft light-and-
 * dark variation at the scale of `site width / size`: four cells across is the
 * drift of a whole field, a thousand is grain.
 */
function noiseSquare(size: number, seed: number, spread: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    let state = seed;
    const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xffffffff; };
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const v = Math.round(128 + (rnd() - 0.5) * spread);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/** A square of colour noise: each cell somewhere between colours `a` and `b`. */
function colourSquare(
  size: number,
  seed: number,
  a: [number, number, number],
  b: [number, number, number],
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    let state = seed;
    const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xffffffff; };
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const t = rnd();
      for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.round(a[k] + (b[k] - a[k]) * t);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/**
 * The mottle: mid grey under four octaves of soft noise and a faint colour
 * drift, over the whole site. Multiplied into the grass tile at twice its value
 * in the shader, so 128 grey leaves the tile alone, darker dims it and lighter
 * lifts it.
 */
export function makeMottle(b: GrassBounds): CanvasTexture {
  const w = Math.round((b.x1 - b.x0) * GRASS_PX_PER_M);
  const h = Math.round((b.z1 - b.z0) * GRASS_PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'overlay';
    for (const [cells, seed, spread, alpha] of [
      [5, 11, 120, 0.5], [18, 23, 110, 0.4], [70, 37, 100, 0.3], [560, 53, 90, 0.18],
    ] as const) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(noiseSquare(cells, seed, spread), 0, 0, w, h);
    }
    // A little hue drift, warm to cool, so the tint wanders across the fields.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.12;
    ctx.drawImage(colourSquare(9, 71, [150, 150, 96], [96, 138, 128]), 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** The tile, set up for tiling. Shared between islands, so done once. */
export function prepareGrassTile(tile: Texture): Texture {
  tile.wrapS = RepeatWrapping;
  tile.wrapT = RepeatWrapping;
  tile.colorSpace = SRGBColorSpace;
  tile.anisotropy = 8;
  return tile;
}

/**
 * The turf's material: the grass tile as `map`, the mottle multiplied in.
 *
 * `MeshStandardMaterial` has one colour map, so the second is added with
 * `onBeforeCompile`, the way `CityMap` cuts its tunnels: a varying carries the
 * vertex's position, the fragment stage looks the mottle up over the site's
 * bounding box and scales the diffuse by twice its grey. Six lines of shader,
 * one extra texture read per fragment.
 *
 * `cacheKey` must differ between two materials compiled from this with
 * different options, and must be the SAME for every material that shares them —
 * three caches a compiled program by it, so one key for two shaders silently
 * gives the second the first's program.
 */
export function grassMaterial(
  tile: Texture,
  mottle: Texture,
  b: GrassBounds,
  cacheKey: string,
  { planarUv = false } = {},
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ map: tile, roughness: 0.95 });
  // The mottle is this material's own canvas and nothing else holds it, so the
  // material carries it: disposing one without the other leaks a 2,000 px
  // texture, and a caller that has only the material cannot find it otherwise.
  material.userData.mottle = mottle;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMottle = { value: mottle };
    shader.uniforms.uMottleBox = { value: new Vector4(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uMottleBox;\nvarying vec2 vMottleUv;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvMottleUv = (vec2(transformed.x, transformed.z) - uMottleBox.xy) / uMottleBox.zw;');
    if (planarUv) {
      // The geometry has no UVs of its own: project the tile from the vertex
      // position, which is what a baked planar UV would have been anyway.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vec2(position.x, position.z) / ${GRASS_REPEAT.toFixed(1)};\n#endif`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMottle;\nvarying vec2 vMottleUv;')
      .replace('#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb *= texture2D(uMottle, vMottleUv).rgb * 2.0;');
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}
