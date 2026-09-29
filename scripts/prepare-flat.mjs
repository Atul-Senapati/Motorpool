/**
 * One-time preprocessor for the container flat — the fourth freight wagon.
 *
 * Unlike the other three this one has no Sketchfab source of its own. It is
 * built out of two things the project already ships:
 *
 *  1. **The tank wagon's underframe and bogies.** `wagonTank.glb` is three
 *     primitives — a frame (`Wagon`), a barrel (`Cistern`) and its ladders and
 *     walkway (`Alpha`). Drop the last two and what is left is a 12.0 m bogie
 *     flat with a deck at 1.20 m, which is precisely what a TEA tank IS under
 *     the barrel: a container flat with something else bolted on. So the frame
 *     is read out of the *prepared* GLB rather than the source — already
 *     measured, scaled, decimated, WebP'd and normalised onto the origin by
 *     `prepare-carriage.mjs`, and every one of those numbers still holds.
 *
 *  2. **The city's shipping container.** The map's freight yards, the harbour
 *     and the airport's cargo apron (`AIRFIELD_DECO`) are all stacked with
 *     `deco_container1_*`: a 12-triangle box with a 256 x 128 atlas under the
 *     `container1` material. The load on this wagon is that same box with that
 *     same atlas, so a container on a train is the container standing beside
 *     the track. The geometry is rebuilt here rather than cut out of the city,
 *     because a box is twelve triangles and copying the chunk would mean
 *     reading 18 MB to get at 48 vertices — but the UV layout is the chunk's,
 *     face for face (see `CONTAINER_UV`), and the texture is lifted from it.
 *
 * The atlas is painted blue. It is desaturated on the way through so each
 * container can be tinted through `baseColorFactor` — a grey albedo times a
 * colour is that colour, where a blue one times red is mud — and that is what
 * puts more than one operator's box on the rake.
 *
 * Two wagons come out, from one frame:
 *
 *   flat40   one 40 ft box, full deck
 *   flat20   two 20 ft boxes, two colours
 *
 * Two GLBs and not one with a switch, because `FreightTrain` resolves a unit to
 * a model path and nothing else, and the frame duplicated is 0.8 MB the two
 * rakes that use it were going to download anyway.
 *
 * Run with: npm run prepare:flat
 *
 * Writes:
 *   public/models/wagonFlat40.glb   src/config/wagonFlat40Data.json
 *   public/models/wagonFlat20.glb   src/config/wagonFlat20Data.json
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const FRAME = 'public/models/wagonTank.glb';
const FRAME_DATA = 'src/config/wagonTankData.json';
const CITY = 'public/models/city.glb';
const CONTAINER_MATERIAL = 'container1';

/** The tank wagon's primitives that are the barrel, not the frame. */
const NOT_FRAME = /cistern|alpha/i;

/**
 * Where the deck is, metres above the rail head.
 *
 * Measured off the frame: the top of the solebar and the deck plate is a band
 * of 666 vertices at 1.15–1.21 m running the full ±6.0 m, with the barrel's
 * saddles just above it. The barrel itself sat at 1.25. A box goes on at 1.21
 * — on the deck, clear of the saddle stubs, and it comes out 3.80 m over rail
 * against the tank's 3.78, which is the same loading gauge to the centimetre.
 */
const DECK = 1.21;

/**
 * ISO box dimensions, metres — 2.44 wide, 2.59 tall, and 40 ft is 12.19 long.
 *
 * Except that it is not, here: the frame is 12.0 m over buffers and a 12.19 m
 * box would hang 10 cm past each headstock. A real FEA is longer than the box
 * it carries for the same reason. So the 40 ft is trimmed to the deck and the
 * two 20 ft share it with a 20 cm gap — 1.5 % short, and nobody measures a
 * container by eye when it is on a train.
 */
const BOX_WIDTH = 2.44;
const BOX_HEIGHT = 2.59;
const TWENTY_GAP = 0.2;

/**
 * Container colours, as `baseColorFactor` over the grey atlas.
 *
 * Linear-space RGB, which is what the factor is: the sRGB paint chips these
 * came from are about twice as bright. Picked to read as *different operators*
 * at 300 m — a blue, a rust red, a green — and no two adjacent on a rake.
 */
const PAINT = {
  blue: [0.06, 0.16, 0.50],
  red: [0.55, 0.09, 0.05],
  green: [0.06, 0.28, 0.10],
};

const WAGONS = {
  flat40: {
    dst: 'public/models/wagonFlat40.glb',
    data: 'src/config/wagonFlat40Data.json',
    boxes: [{ length: 12.0, z: 0, paint: 'blue' }],
  },
  flat20: {
    dst: 'public/models/wagonFlat20.glb',
    data: 'src/config/wagonFlat20Data.json',
    boxes: [
      { length: (12.0 - TWENTY_GAP) / 2, z: -(12.0 + TWENTY_GAP) / 4, paint: 'red' },
      { length: (12.0 - TWENTY_GAP) / 2, z: (12.0 + TWENTY_GAP) / 4, paint: 'green' },
    ],
  },
};

/**
 * The city chunk's UV layout, one rectangle per face — `[u0, v0, u1, v1]` with
 * `u` along the face's long axis and `v` from its bottom edge.
 *
 * Read straight off `deco_container1_-1_0`: the long sides take the top band
 * of the atlas, the roof and floor the middle band, and both ends the narrow
 * strip on the right. The bottom band of the image is unused there and unused
 * here; and the ends are the same strip both ends, so the box has doors at
 * each — which is what the city's do, and not something to improve on when the
 * point is that it matches them.
 */
const CONTAINER_UV = {
  side: [0, 0, 0.807, 0.333],
  end: [0.999, 0, 0.807, 0.329],
  roofFloor: [0, 0.337, 0.803, 0.666],
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const step = (msg) => console.log(`  ${msg}`);

// ---------------------------------------------------------------------------
// 1. The atlas, out of the city, and to grey.
//
// `normalise` after `greyscale`: the blue paint sits low in the luminance
// range, and left there every tint would come out as a dark version of itself.
// Stretched to full range the corrugation and the door furniture keep their
// contrast and the tint sets the level.
// ---------------------------------------------------------------------------
step(`reading ${CITY} for the ${CONTAINER_MATERIAL} atlas`);
const city = await io.read(CITY);
const cityMaterial = city.getRoot().listMaterials().find((m) => m.getName() === CONTAINER_MATERIAL);
if (!cityMaterial?.getBaseColorTexture()) {
  throw new Error(`no ${CONTAINER_MATERIAL} material with a base colour texture in ${CITY}`);
}
const atlas = await sharp(Buffer.from(cityMaterial.getBaseColorTexture().getImage()))
  .greyscale()
  .normalise()
  .webp({ quality: 90 })
  .toBuffer();
step(`atlas ${mb(cityMaterial.getBaseColorTexture().getImage().byteLength)} -> ${mb(atlas.byteLength)} grey`);

const frameData = JSON.parse(readFileSync(FRAME_DATA, 'utf8'));

for (const [id, wagon] of Object.entries(WAGONS)) {
  console.log(`\n${id}`);
  const doc = await io.read(FRAME);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const buffer = root.listBuffers()[0];

  // -------------------------------------------------------------------------
  // 2. Strip the barrel. Nodes, meshes, materials and then whatever textures
  //    nothing refers to any more — `listParents` is the root plus every user,
  //    so a texture down to one parent is an orphan.
  // -------------------------------------------------------------------------
  let dropped = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh && NOT_FRAME.test(mesh.getName())) {
      dropped += mesh.listPrimitives().reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
      node.dispose();
      mesh.dispose();
    }
  }
  for (const material of root.listMaterials()) {
    if (NOT_FRAME.test(material.getName())) material.dispose();
  }
  for (const texture of root.listTextures()) {
    if (texture.listParents().length <= 1) texture.dispose();
  }
  step(`dropped the barrel: ${dropped.toLocaleString()} triangles, `
    + `${root.listTextures().length} textures kept`);

  // -------------------------------------------------------------------------
  // 3. The boxes. One material per colour, one mesh per box, hung under the
  //    same normalised `carriage` node the frame is under, so they share its
  //    (identity) transform and sit in the frame's metres.
  // -------------------------------------------------------------------------
  const carriage = scene.listChildren()[0];
  const texture = doc.createTexture(CONTAINER_MATERIAL).setImage(atlas).setMimeType('image/webp');
  const materials = new Map();
  const paintFor = (paint) => {
    if (!materials.has(paint)) {
      materials.set(paint, doc.createMaterial(`container-${paint}`)
        .setBaseColorTexture(texture)
        .setBaseColorFactor([...PAINT[paint], 1])
        .setMetallicFactor(0.2)
        .setRoughnessFactor(0.75));
    }
    return materials.get(paint);
  };

  for (const box of wagon.boxes) {
    const { positions, normals, uvs, indices } = containerBox(box.length);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
      .setMaterial(paintFor(box.paint));
    const mesh = doc.createMesh(`container-${box.paint}`).addPrimitive(prim);
    carriage.addChild(doc.createNode(`container-${box.paint}`)
      .setMesh(mesh)
      .setTranslation([0, DECK, box.z]));
  }

  const triangles = root.listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + p.getIndices().getCount() / 3, 0);

  // Re-declared rather than assumed: the frame came in Draco'd, and writing it
  // back out with new primitives wants the encoder options stated again.
  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizationVolume: 'mesh',
      quantizationBits: { POSITION: 14, NORMAL: 8, TEX_COORD: 12 },
    });
  await io.write(wagon.dst, doc);

  // The frame's own width and bogie centres; the height is now the box, and
  // the length is the deck (the box is trimmed to it, see `BOX_WIDTH`).
  const size = [frameData.size[0], +(DECK + BOX_HEIGHT).toFixed(3), frameData.size[2]];
  writeFileSync(wagon.data, `${JSON.stringify({
    model: `/${wagon.dst.replace(/^public\//, '')}`,
    /** Width (X), height (Y), length (Z), metres. */
    size,
    bogieCentres: frameData.bogieCentres,
    triangles,
  }, null, 2)}\n`);

  step(`${wagon.boxes.length} box(es), ${triangles.toLocaleString()} tris, `
    + `${size[2]} m long x ${size[1]} m tall -> ${wagon.dst} (${mb(readFileSync(wagon.dst).byteLength)})`);
}

/**
 * A closed box, `length` along Z, standing on y = 0 and centred on X and Z,
 * with the city chunk's UV layout on each face. 24 vertices and 12 triangles,
 * split per face so each face keeps its own normal and its own rectangle of
 * the atlas.
 */
function containerBox(length) {
  const hx = BOX_WIDTH / 2;
  const hz = length / 2;
  const y1 = BOX_HEIGHT;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  /**
   * One face from four corners in counter-clockwise order seen from outside,
   * given as [corner, u-fraction, v-fraction] with the fractions mapped onto
   * the face's rectangle of the atlas.
   */
  const face = (normal, rect, corners) => {
    const [u0, v0, u1, v1] = rect;
    const base = positions.length / 3;
    for (const [p, fu, fv] of corners) {
      positions.push(...p);
      normals.push(...normal);
      uvs.push(u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const { side, end, roofFloor } = CONTAINER_UV;
  // +X side, looking at it from +X: Z runs right to left.
  face([1, 0, 0], side, [
    [[hx, 0, hz], 0, 0], [[hx, 0, -hz], 1, 0], [[hx, y1, -hz], 1, 1], [[hx, y1, hz], 0, 1],
  ]);
  face([-1, 0, 0], side, [
    [[-hx, 0, -hz], 0, 0], [[-hx, 0, hz], 1, 0], [[-hx, y1, hz], 1, 1], [[-hx, y1, -hz], 0, 1],
  ]);
  face([0, 0, 1], end, [
    [[-hx, 0, hz], 0, 0], [[hx, 0, hz], 1, 0], [[hx, y1, hz], 1, 1], [[-hx, y1, hz], 0, 1],
  ]);
  face([0, 0, -1], end, [
    [[hx, 0, -hz], 0, 0], [[-hx, 0, -hz], 1, 0], [[-hx, y1, -hz], 1, 1], [[hx, y1, -hz], 0, 1],
  ]);
  face([0, 1, 0], roofFloor, [
    [[-hx, y1, hz], 0, 0], [[hx, y1, hz], 0, 1], [[hx, y1, -hz], 1, 1], [[-hx, y1, -hz], 1, 0],
  ]);
  face([0, -1, 0], roofFloor, [
    [[-hx, 0, -hz], 1, 0], [[hx, 0, -hz], 1, 1], [[hx, 0, hz], 0, 1], [[-hx, 0, hz], 0, 0],
  ]);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}
