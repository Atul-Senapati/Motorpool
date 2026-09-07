/**
 * Bakes the promo page's hero car to a PNG, so that page ships no WebGL.
 *
 * The landing poster wants one dramatic three-quarter shot of the McLaren and
 * nothing else — no canvas, no model download, no loader. Rather than add a
 * screenshot from somewhere untracked, this renders the same
 * `public/models/mclaren.glb` the game drives, with its own small software
 * rasterizer: z-buffer, interpolated normals, sampled textures, three lights.
 * That keeps the promo art honest (it *is* the car you drive) and regenerable
 * (re-run it after `npm run prepare:model`).
 *
 * It is deliberately a build-time script and not a runtime renderer. Alpha is
 * written straight through, so the car drops onto the page over whatever the
 * design puts behind it; the contact shadow is CSS on the page, not baked in,
 * because a baked one cannot follow a change of background.
 *
 * Emits: public/promo/mclaren-hero.png
 * Run with: npm run promo:art
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC = 'public/models/mclaren.glb';
const OUT = 'public/promo/mclaren-hero.png';

/** Rendered at 2x and downsampled, which is the cheapest good antialiasing. */
const OUT_W = 1800;
const SS = 2;

/**
 * Camera. A low three-quarter front view: high enough to read the roof and the
 * canopy, low enough that the car looms rather than sits. Angles in degrees,
 * distance in metres, `lookAtY` a height on the car itself.
 */
const CAM = { yaw: 34, pitch: 9, fov: 34, lookAtY: 0.62 };

/**
 * Lights. A big soft key from the front left, a cool fill from the right to
 * keep the shadow side from going black, and a rim from behind to cut the
 * silhouette off the background — the standard three-light car setup.
 */
const KEY = { dir: norm([-0.55, 0.72, 0.42]), colour: [1.0, 0.99, 0.96], power: 1.15 };
const FILL = { dir: norm([0.78, 0.32, 0.24]), colour: [0.80, 0.86, 1.0], power: 0.42 };
const RIM = { dir: norm([0.15, 0.35, -0.95]), colour: [1.0, 1.0, 1.0], power: 0.55 };
/** Sky above, bounce below — what stops unlit faces reading as holes. */
const SKY = [0.55, 0.60, 0.68];
const GROUND = [0.30, 0.31, 0.34];
const AMBIENT = 0.42;

function norm(v) {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

step(`reading ${SRC}`);
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

// ---------------------------------------------------------------------------
// Textures, decoded once into raw RGBA.
// ---------------------------------------------------------------------------
const decoded = new Map();
for (const texture of root.listTextures()) {
  const image = texture.getImage();
  if (!image) continue;
  const { data, info } = await sharp(Buffer.from(image)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  decoded.set(texture, { data, w: info.width, h: info.height, ch: info.channels });
}
step(`decoded ${decoded.size} textures`);

/**
 * Bilinear sample, wrapping — glTF's default.
 *
 * No V flip: glTF puts the texture origin at the image's *upper* left with v
 * increasing downward, which is already how the decoded rows are ordered.
 * Flipping it (the reflex from OpenGL) renders every decal on the car upside
 * down, which on this model is obvious the moment the wordmark is legible.
 */
function sample(tex, u, v) {
  const x = (((u % 1) + 1) % 1) * (tex.w - 1);
  const y = (((v % 1) + 1) % 1) * (tex.h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, tex.w - 1), y1 = Math.min(y0 + 1, tex.h - 1);
  const fx = x - x0, fy = y - y0;
  const at = (px, py) => {
    const o = (py * tex.w + px) * tex.ch;
    return [tex.data[o] / 255, tex.data[o + 1] / 255, tex.data[o + 2] / 255];
  };
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Flatten the scene: world-space triangles, with normals, UVs and a material.
// ---------------------------------------------------------------------------
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  }
  return o;
}

function nodeMatrix(node) {
  const [x, y, z, w] = node.getRotation();
  const t = node.getTranslation();
  const s = node.getScale();
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const xf = (m, p) => [
  p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12],
  p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13],
  p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14],
];
/** Normals ignore translation. Uniform scale throughout this model, so no inverse-transpose. */
const xfDir = (m, p) => norm([
  p[0] * m[0] + p[1] * m[4] + p[2] * m[8],
  p[0] * m[1] + p[1] * m[5] + p[2] * m[9],
  p[0] * m[2] + p[1] * m[6] + p[2] * m[10],
]);

const tris = [];
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

(function walk(node, parent) {
  const m = mul(parent, nodeMatrix(node));
  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION');
      if (!P) continue;
      const N = prim.getAttribute('NORMAL');
      const T = prim.getAttribute('TEXCOORD_0');
      const I = prim.getIndices();
      const mat = prim.getMaterial();
      const tex = mat?.getBaseColorTexture() ?? null;
      const surface = {
        albedo: mat ? mat.getBaseColorFactor().slice(0, 3) : [0.8, 0.8, 0.8],
        metal: mat ? mat.getMetallicFactor() : 0,
        rough: mat ? mat.getRoughnessFactor() : 0.6,
        tex: tex ? decoded.get(tex) ?? null : null,
      };
      const count = I ? I.getCount() : P.getCount();
      const p = [0, 0, 0], n = [0, 0, 0], t = [0, 0];
      for (let i = 0; i < count; i += 3) {
        const verts = [];
        for (let k = 0; k < 3; k++) {
          const idx = I ? I.getScalar(i + k) : i + k;
          P.getElement(idx, p);
          const world = xf(m, p);
          let normal = [0, 1, 0];
          if (N) { N.getElement(idx, n); normal = xfDir(m, n); }
          let uv = [0, 0];
          if (T) { T.getElement(idx, t); uv = [t[0], t[1]]; }
          for (let d = 0; d < 3; d++) {
            if (world[d] < lo[d]) lo[d] = world[d];
            if (world[d] > hi[d]) hi[d] = world[d];
          }
          verts.push({ world, normal, uv });
        }
        tris.push({ verts, surface });
      }
    }
  }
  for (const child of node.listChildren()) walk(child, m);
})({ getMesh: () => null, listChildren: () => scene.listChildren(), getRotation: () => [0, 0, 0, 1], getTranslation: () => [0, 0, 0], getScale: () => [1, 1, 1] }, IDENT);

step(`${tris.length.toLocaleString()} triangles, bounds ` +
  `${(hi[0] - lo[0]).toFixed(2)} x ${(hi[1] - lo[1]).toFixed(2)} x ${(hi[2] - lo[2]).toFixed(2)} m`);

// ---------------------------------------------------------------------------
// Camera basis.
// ---------------------------------------------------------------------------
const centre = [(lo[0] + hi[0]) / 2, lo[1] + CAM.lookAtY, (lo[2] + hi[2]) / 2];
const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
const yaw = (CAM.yaw * Math.PI) / 180;
const pitch = (CAM.pitch * Math.PI) / 180;
const fov = (CAM.fov * Math.PI) / 180;
/** Far enough back that the whole car fits the frame with a little air. */
const dist = (radius / Math.sin(fov / 2)) * 0.92;

// The car faces -Z, so the camera comes round from the front quarter.
const eye = [
  centre[0] + Math.sin(yaw) * Math.cos(pitch) * dist,
  centre[1] + Math.sin(pitch) * dist,
  centre[2] - Math.cos(yaw) * Math.cos(pitch) * dist,
];
/**
 * Camera basis, from cross products rather than by hand. The first attempt
 * wrote `right` as `[fwd.z, 0, -fwd.x]` and `up` as `right × fwd`, and both
 * came out negated — which renders the car mirrored *and* upside down, with
 * its own decals reading backwards. Right-handed and in this order, or not at
 * all: right = forward × worldUp, then up = right × forward.
 */
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const fwd = norm([centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]]);
const right = norm(cross(fwd, [0, 1, 0]));
const up = cross(right, fwd);

const W = OUT_W * SS;
const H = Math.round(W * 0.62);
const focal = (H / 2) / Math.tan(fov / 2);

function project(p) {
  const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const z = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
  if (z <= 0.01) return null;
  const x = v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
  const y = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  return [W / 2 + (x * focal) / z, H / 2 - (y * focal) / z, z];
}

// ---------------------------------------------------------------------------
// Shade and rasterize.
// ---------------------------------------------------------------------------
function shade(surface, normal, uv, point) {
  let albedo = surface.albedo;
  if (surface.tex) {
    const t = sample(surface.tex, uv[0], uv[1]);
    albedo = [albedo[0] * t[0], albedo[1] * t[1], albedo[2] * t[2]];
  }

  // Hemispheric ambient: sky from above, bounce from below.
  const sky = (normal[1] + 1) / 2;
  const amb = [
    (GROUND[0] + (SKY[0] - GROUND[0]) * sky) * AMBIENT,
    (GROUND[1] + (SKY[1] - GROUND[1]) * sky) * AMBIENT,
    (GROUND[2] + (SKY[2] - GROUND[2]) * sky) * AMBIENT,
  ];

  const view = norm([eye[0] - point[0], eye[1] - point[1], eye[2] - point[2]]);
  const gloss = Math.max(2, (1 - surface.rough) ** 2 * 220 + 6);
  const out = [amb[0], amb[1], amb[2]];

  for (const light of [KEY, FILL, RIM]) {
    const ndotl = Math.max(0, normal[0] * light.dir[0] + normal[1] * light.dir[1] + normal[2] * light.dir[2]);
    if (ndotl <= 0) continue;
    for (let k = 0; k < 3; k++) out[k] += light.colour[k] * light.power * ndotl;

    // Blinn-Phong highlight, tinted towards the albedo for metals the way a
    // metal's specular reflection actually is.
    const half = norm([light.dir[0] + view[0], light.dir[1] + view[1], light.dir[2] + view[2]]);
    const ndoth = Math.max(0, normal[0] * half[0] + normal[1] * half[1] + normal[2] * half[2]);
    const spec = Math.pow(ndoth, gloss) * light.power * (0.35 + surface.metal * 0.9);
    for (let k = 0; k < 3; k++) {
      const tint = 0.04 + (albedo[k] - 0.04) * surface.metal;
      out[k] += spec * light.colour[k] * tint * 6;
    }
  }

  return [
    Math.min(1, albedo[0] * out[0]) ** (1 / 1.05),
    Math.min(1, albedo[1] * out[1]) ** (1 / 1.05),
    Math.min(1, albedo[2] * out[2]) ** (1 / 1.05),
  ];
}

const rgba = new Uint8Array(W * H * 4);
const zbuf = new Float64Array(W * H).fill(Infinity);
let drawn = 0;

for (const tri of tris) {
  const a = project(tri.verts[0].world);
  const b = project(tri.verts[1].world);
  const c = project(tri.verts[2].world);
  if (!a || !b || !c) continue;

  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  if (minX > maxX || minY > maxY) continue;

  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (!den) continue;
  drawn++;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = ((b[1] - c[1]) * (px + 0.5 - c[0]) + (c[0] - b[0]) * (py + 0.5 - c[1])) / den;
      const w1 = ((c[1] - a[1]) * (px + 0.5 - c[0]) + (a[0] - c[0]) * (py + 0.5 - c[1])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      // Perspective-correct interpolation: barycentrics are in screen space, so
      // attributes have to be weighted by 1/z or the textures shear visibly on
      // anything at an angle to the camera — which, on a car, is everything.
      const iw = w0 / a[2] + w1 / b[2] + w2 / c[2];
      const depth = 1 / iw;
      const o = py * W + px;
      if (depth >= zbuf[o]) continue;

      const k0 = (w0 / a[2]) / iw, k1 = (w1 / b[2]) / iw, k2 = (w2 / c[2]) / iw;
      const V = tri.verts;
      const normal = norm([
        V[0].normal[0] * k0 + V[1].normal[0] * k1 + V[2].normal[0] * k2,
        V[0].normal[1] * k0 + V[1].normal[1] * k1 + V[2].normal[1] * k2,
        V[0].normal[2] * k0 + V[1].normal[2] * k1 + V[2].normal[2] * k2,
      ]);
      const uv = [
        V[0].uv[0] * k0 + V[1].uv[0] * k1 + V[2].uv[0] * k2,
        V[0].uv[1] * k0 + V[1].uv[1] * k1 + V[2].uv[1] * k2,
      ];
      const point = [
        V[0].world[0] * k0 + V[1].world[0] * k1 + V[2].world[0] * k2,
        V[0].world[1] * k0 + V[1].world[1] * k1 + V[2].world[1] * k2,
        V[0].world[2] * k0 + V[1].world[2] * k1 + V[2].world[2] * k2,
      ];

      const colour = shade(tri.surface, normal, uv, point);
      zbuf[o] = depth;
      rgba[o * 4] = Math.round(colour[0] * 255);
      rgba[o * 4 + 1] = Math.round(colour[1] * 255);
      rgba[o * 4 + 2] = Math.round(colour[2] * 255);
      rgba[o * 4 + 3] = 255;
    }
  }
}
step(`rasterized ${drawn.toLocaleString()} triangles at ${W}x${H}`);

// ---------------------------------------------------------------------------
// Trim the transparent margin, downsample, write.
// ---------------------------------------------------------------------------
/*
 * Crop to the car by scanning the alpha channel, rather than asking sharp to
 * `trim()`. Trim infers a background colour from a corner pixel and gave back
 * the full canvas untouched on a fully transparent margin, which left the car
 * occupying about half the frame and every size on the page having to
 * compensate for empty space. The alpha bounds are exact and cost one pass.
 */
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (rgba[(y * W + x) * 4 + 3] === 0) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
if (maxX < 0) throw new Error('nothing was drawn — check the camera');
const pad = Math.round(W * 0.01);
const cropX = Math.max(0, minX - pad);
const cropY = Math.max(0, minY - pad);
const cropW = Math.min(W - cropX, maxX - minX + 1 + pad * 2);
const cropH = Math.min(H - cropY, maxY - minY + 1 + pad * 2);
step(`cropped to ${cropW}x${cropH} from ${W}x${H}`);

mkdirSync('public/promo', { recursive: true });
await sharp(Buffer.from(rgba), { raw: { width: W, height: H, channels: 4 } })
  .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
  .resize({ width: OUT_W, withoutEnlargement: true })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

const meta = await sharp(OUT).metadata();
console.log(`\n--- promo art ---\n  ${OUT}  ${meta.width}x${meta.height}  ` +
  `${((meta.size ?? 0) / 1024).toFixed(0)} KB\n`);
