/**
 * Turns the dropped animated crowd into eighteen clean, separately usable
 * pedestrians that share one walk clip.
 *
 *     npm run prepare:crowd
 *
 * `low_detail_animated_crowd.glb`: eighteen ~570-triangle people in modern
 * casual clothes, all on one 512² texture atlas and one material, each with its
 * own 16-joint Mixamo skeleton, standing in a 6 × 3 grid. One animation, `Scene`,
 * plays the **same 1.2 s walk on the spot** on all eighteen (the keyframes are
 * identical per joint; only the joint names differ).
 *
 * As exported it is awkward to use: every figure sits under three transforms
 * that cancel out (a Sketchfab Z-up flip, an FBX node at 1/100 scale turned
 * 180°, an armature turned back again), joint names carry per-figure numeric
 * suffixes (`mixamorig:Hips_04`, `…Hips_019`), a couple of skins point at a
 * neighbouring figure's forearm, and the one clip has 437 channels that drive
 * all eighteen at once.
 *
 * This pass rebuilds it:
 *
 *  - one root node per figure, `crowd0`…`crowd17`, carrying the figure's whole
 *    old transform chain (centimetre bones → metres) plus a shift that puts
 *    its hips over the origin and feet on y = 0, and a yaw to face **+Z** (the civilians'
 *    convention; see `prepare-civilians.mjs`);
 *  - joints renamed to plain Mixamo names (`Hips`, `LeftUpLeg`, …) and every
 *    skin pointed only at its own figure's joints;
 *  - one clip, `walk`, driving `crowd0`'s joints: rotations for every joint,
 *    translation for `Hips` only (the bob and sway). The other figures play it
 *    by name — GLTFLoader suffixes repeated names, so the runtime strips them.
 *
 * `src/config/crowdData.json` records each figure's height and the clip's
 * length and the ground it covers per loop, so a walker's speed can match its
 * feet.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { source } from './sourceModels.mjs';

const SRC = source('low_detail_animated_crowd.glb');
const DST = 'public/models/crowd.glb';
const DATA = 'src/config/crowdData.json';
// Column-major 4×4 helpers, glTF order.
const mat = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const trs = (t, [x, y, z, w]) => [
  1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
  2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
  2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
  t[0], t[1], t[2], 1,
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);
const root = doc.getRoot();

const generic = (name) => {
  const bare = name.replace('mixamorig:', '').replace(/_\d+$/, '');
  return bare === '_rootJoint' ? 'Root' : bare;
};
const subtree = (node, out = []) => {
  out.push(node);
  for (const child of node.listChildren()) subtree(child, out);
  return out;
};

// ---- Source figures: armature → its joints by name, its skinned mesh. ----
const armatures = root.listNodes()
  .filter((n) => /^Armature\.\d+$/.test(n.getName()))
  .sort((a, b) => {
    // Grid order, front row first then left to right, so indices are stable.
    const [ax, ay] = a.getTranslation();
    const [bx, by] = b.getTranslation();
    return Math.round(ay / 100) - Math.round(by / 100) || ax - bx;
  });
const figures = armatures.map((armature) => {
  const nodes = subtree(armature);
  const joints = new Map();
  for (const n of nodes) if (n.getName() === '_rootJoint' || n.getName().startsWith('mixamorig:')) joints.set(generic(n.getName()), n);
  const meshNode = nodes.find((n) => n.getSkin());
  return { armature, joints, meshNode };
});

// ---- The clip: identical on every figure, so read it off the first. ----
const clip = root.listAnimations()[0];
const firstNames = new Map([...figures[0].joints].map(([name, node]) => [node, name]));
const tracks = [];
for (const channel of clip.listChannels()) {
  const name = firstNames.get(channel.getTargetNode());
  if (!name) continue;
  const path = channel.getTargetPath();
  if (path === 'translation' && name !== 'Hips') continue;
  if (path === 'scale') continue;
  const s = channel.getSampler();
  tracks.push({
    name, path,
    input: s.getInput().getArray().slice(),
    output: s.getOutput().getArray().slice(),
    interpolation: s.getInterpolation(),
  });
}
const duration = Math.max(...tracks.map((t) => t.input[t.input.length - 1]));

// ---- Output. ----
const out = new Document();
out.createBuffer();
const buffer = out.getRoot().listBuffers()[0];
const scene = out.createScene('crowd');

const srcMaterial = root.listMaterials()[0];
const srcImage = srcMaterial.getBaseColorTexture().getImage();
const texture = out.createTexture('crowd')
  .setImage(await sharp(Buffer.from(srcImage)).webp({ quality: 90 }).toBuffer())
  .setMimeType('image/webp');
const material = out.createMaterial('crowd')
  .setBaseColorTexture(texture)
  .setMetallicFactor(0)
  .setRoughnessFactor(0.9);

const copy = (accessor, type) => out.createAccessor()
  .setType(type ?? accessor.getType())
  .setArray(accessor.getArray().slice())
  .setNormalized(accessor.getNormalized())
  .setBuffer(buffer);

const data = [];
let firstJoints = null;
for (const [fi, fig] of figures.entries()) {
  const prim = fig.meshNode.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const count = pos.getCount();

  // Rest shape in world metres. The vertices are in their own frame (metres,
  // Z up, still at the figure's grid position); a joint's world matrix times
  // its inverse bind matrix is the same mesh→world map for every joint in the
  // rest pose, so the hips' gives it.
  const srcSkin = fig.meshNode.getSkin();
  const hipsNode = fig.joints.get('Hips');
  const hipsIndex = srcSkin.listJoints().findIndex((j) => generic(j.getName()) === 'Hips');
  const toWorld = mat(hipsNode.getWorldMatrix(), srcSkin.getInverseBindMatrices().getElement(hipsIndex, []));
  const world = [];
  const v = [0, 0, 0];
  for (let i = 0; i < count; i++) world.push(apply(toWorld, pos.getElement(i, v)));
  const lo = [0, 1, 2].map((k) => Math.min(...world.map((q) => q[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...world.map((q) => q[k])));
  const hipsW = apply(hipsNode.getWorldMatrix(), [0, 0, 0]);
  // T-pose: the arms span one horizontal axis; the other is front-to-back.
  const fwdK = hi[0] - lo[0] > hi[2] - lo[2] ? 2 : 0;
  const feet = world.filter((q) => q[1] - lo[1] < 0.04);
  const toe = Math.max(...feet.map((q) => q[fwdK])) - hipsW[fwdK];
  const heel = hipsW[fwdK] - Math.min(...feet.map((q) => q[fwdK]));
  const fwd = [0, 0, 0];
  fwd[fwdK] = toe > heel ? 1 : -1;
  // Yaw that turns `fwd` onto +Z.
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const q = [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)];
  const placed = mat(
    trs([0, 0, 0], q),
    mat(trs([-hipsW[0], -lo[1], -hipsW[2]], [0, 0, 0, 1]), fig.joints.get('Root').getParentNode().getWorldMatrix()),
  );

  const figNode = out.createNode(`crowd${fi}`).setMatrix(placed);
  scene.addChild(figNode);
  const minY = lo[1];
  const maxY = hi[1];

  // Joints, rebuilt from this figure's own hierarchy.
  const made = new Map();
  const build = (src, parent) => {
    const name = generic(src.getName());
    const node = out.createNode(name)
      .setTranslation(src.getTranslation())
      .setRotation(src.getRotation())
      .setScale(src.getScale());
    parent.addChild(node);
    made.set(name, node);
    for (const child of src.listChildren()) if (fig.joints.has(generic(child.getName()))) build(child, node);
  };
  build(fig.joints.get('Root'), figNode);
  if (fi === 0) firstJoints = made;

  const skin = out.createSkin(`crowd${fi}`)
    .setSkeleton(made.get('Root'))
    .setInverseBindMatrices(copy(srcSkin.getInverseBindMatrices()));
  for (const j of srcSkin.listJoints()) skin.addJoint(made.get(generic(j.getName())));

  const p = out.createPrimitive().setMaterial(material);
  for (const semantic of prim.listSemantics()) p.setAttribute(semantic, copy(prim.getAttribute(semantic)));
  // Narrow types, as the civilians use: sixteen joints fit a byte, ~600
  // vertices fit a short.
  p.setAttribute('JOINTS_0', out.createAccessor().setType('VEC4')
    .setArray(Uint8Array.from(prim.getAttribute('JOINTS_0').getArray())).setBuffer(buffer));
  p.setIndices(out.createAccessor().setType('SCALAR')
    .setArray(Uint16Array.from(prim.getIndices().getArray())).setBuffer(buffer));
  const mesh = out.createMesh(`crowd${fi}`).addPrimitive(p);
  figNode.addChild(out.createNode(`crowd${fi}_mesh`).setMesh(mesh).setSkin(skin));

  data.push({
    name: `crowd${fi}`,
    height: +(maxY - minY).toFixed(3),
    hipHeight: +(hipsW[1] - minY).toFixed(3),
    triangles: prim.getIndices().getCount() / 3,
  });
  console.log(
    `crowd${fi}  ${fig.armature.getName().padEnd(13)} ${(maxY - minY).toFixed(2)} m`
    + `  hips ${(hipsW[1] - minY).toFixed(2)}  faced ${fwd[fwdK] > 0 ? '+' : '−'}${'XYZ'[fwdK]}`,
  );
}

const anim = out.createAnimation('walk');
for (const t of tracks) {
  const sampler = out.createAnimationSampler()
    .setInput(out.createAccessor().setType('SCALAR').setArray(t.input).setBuffer(buffer))
    .setOutput(out.createAccessor().setType(t.path === 'rotation' ? 'VEC4' : 'VEC3').setArray(t.output).setBuffer(buffer))
    .setInterpolation(t.interpolation);
  anim.addSampler(sampler).addChannel(
    out.createAnimationChannel().setTargetNode(firstJoints.get(t.name)).setTargetPath(t.path).setSampler(sampler),
  );
}

await io.write(DST, out);
writeFileSync(DATA, JSON.stringify({ clip: 'walk', duration: +duration.toFixed(3), figures: data }, null, 2) + '\n');
console.log(`${figures.length} figures, clip ${duration.toFixed(2)} s / ${tracks.length} tracks → ${DST}`);
