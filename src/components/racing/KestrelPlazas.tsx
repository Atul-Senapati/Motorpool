'use client';

import { useEffect, useMemo, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import {
  BufferGeometry, CanvasTexture, Float32BufferAttribute, Mesh, MeshStandardMaterial, RepeatWrapping,
  SRGBColorSpace, type Texture,
} from 'three';
import { DRACO_PATH } from '@/config/cityConfig';
import { KERB_TOP, ROAD_REPEAT, ROAD_WIDTH } from '@/config/roadConfig';
import { STATION_SITE } from '@/config/stationConfig';
import { CIVIC_BLOCK } from '@/config/kestrelCivic';
import { ASSEMBLY_BLOCK, blockCut, SPORTS_BLOCK } from '@/config/kestrelHalls';
import { drawPlazaPattern, PLAZA_PATTERNS, type PlazaPattern } from './plazaPatterns';

const ROAD_MODEL = '/models/roads.glb';

/**
 * The civic blocks, paved: the Hall of Justice's, the sports hall's and the
 * assembly hall's, kerb to kerb.
 *
 * The three stood in lawn, so the town's civic frontage was three buildings in
 * three fields. Each block is now one plaza that carries straight on from the
 * footpath round it — the same height (`KERB_TOP`, the kit's modelled footway)
 * and the same paving.
 *
 * ## The paving is the footpath's own
 *
 * The road kit's texture is a road in section: the top 120 of its 1024 rows are
 * one row of paving slabs — the footway — then a kerbstone, then the tarmac.
 * That row is cut out once into a canvas and tiled, at the scale the footway
 * shows it: the texture's width is one `ROAD_REPEAT` along the street (six
 * slabs, 3.5 m each) and the 120 rows are 2.2 m of a 19 m road across it. The
 * slabs run along the station frame's `along`, as the avenues' footways do, so
 * a plaza's joints line up with the pavement on its long sides.
 */

/** The footway row of the kit's road texture, as a fraction of its height. */
const BAND = 120 / 1024;
/** …and in metres across the road, which is how deep one row of slabs is. */
const BAND_METRES = BAND * ROAD_WIDTH;

export const PLAZA_BLOCKS = [CIVIC_BLOCK, SPORTS_BLOCK, ASSEMBLY_BLOCK];

/**
 * Which paving: the footway's own (the default), or one of the drawn patterns
 * in `plazaPatterns`, chosen with `?plaza=herringbone|granite|bond|hex` while
 * they are being compared.
 */
function choosePattern(): PlazaPattern | 'footway' {
  if (typeof window === 'undefined') return 'footway';
  const asked = new URLSearchParams(window.location.search).get('plaza');
  return PLAZA_PATTERNS.includes(asked as PlazaPattern) ? (asked as PlazaPattern) : 'footway';
}

/** The footway row of the kit's road texture, cut out and tiled both ways. */
function footwayMaterial(scene: { getObjectByName: (n: string) => { traverse: (f: (o: unknown) => void) => void } | undefined }, anisotropy: number) {
  let map: Texture | null = null;
  scene.getObjectByName('straight2')?.traverse((child) => {
    if (!map && child instanceof Mesh) map = (child.material as MeshStandardMaterial).map;
  });
  const image = (map as Texture | null)?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!image) return new MeshStandardMaterial({ color: '#a8a59e', roughness: 0.95 });
  const rows = Math.round(image.height * BAND);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = rows;
  canvas.getContext('2d')!.drawImage(image, 0, 0, image.width, rows, 0, 0, image.width, rows);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  // The kit's texture is glTF, unflipped; keep the row the same way up.
  tex.flipY = false;
  tex.anisotropy = anisotropy;
  return new MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
}

export function KestrelPlazas() {
  const site = STATION_SITE;
  const { scene } = useGLTF(ROAD_MODEL, DRACO_PATH);
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const [pattern] = useState(choosePattern);

  /** The paving: the footway's own, or a drawn pattern, and how many metres one repeat covers. */
  const paving = useMemo(() => {
    if (pattern !== 'footway') {
      const drawn = drawPlazaPattern(pattern, maxAnisotropy);
      return {
        material: new MeshStandardMaterial({ map: drawn.texture, roughness: 0.9, metalness: 0 }),
        uMetres: drawn.metres,
        vMetres: drawn.metres,
      };
    }
    return { material: footwayMaterial(scene, maxAnisotropy), uMetres: ROAD_REPEAT, vMetres: BAND_METRES };
  }, [pattern, scene, maxAnisotropy]);
  const material = paving.material;
  useEffect(() => () => { material.map?.dispose(); material.dispose(); }, [material]);

  /** One slab per block at the footway's height; u along the block, v across. */
  const geometry = useMemo(() => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const b of PLAZA_BLOCKS) {
      // The block's outline, counter-clockwise from above. A corner cut by a
      // swept bend (`blockCut`) follows the bend's inner edge instead.
      const outline: Array<[number, number]> = [[b.acrossFrom, b.alongFrom], [b.acrossTo, b.alongFrom]];
      const cut = blockCut(b);
      if (cut) {
        for (let k = 0; k <= 16; k++) {
          const t = (k / 16) * (Math.PI / 2);
          outline.push([cut.across + Math.cos(t) * cut.radius, cut.along + Math.sin(t) * cut.radius]);
        }
      } else {
        outline.push([b.acrossTo, b.alongTo]);
      }
      outline.push([b.acrossFrom, b.alongTo]);
      // A fan from the middle: the outline is convex either way.
      const ca = outline.reduce((sum, p) => sum + p[0], 0) / outline.length;
      const cl = outline.reduce((sum, p) => sum + p[1], 0) / outline.length;
      const base = pos.length / 3;
      for (const [across, along] of [[ca, cl] as [number, number], ...outline]) {
        pos.push(across, KERB_TOP, along);
        uv.push(along / paving.uMetres, across / paving.vMetres);
      }
      for (let k = 0; k < outline.length; k++) {
        const a = base + 1 + k;
        const c = base + 1 + ((k + 1) % outline.length);
        // Up-facing with x across and z along: centre, next, this.
        idx.push(base, c, a);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [paving]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const collider = useMemo(() => [
    new Float32Array(geometry.getAttribute('position').array),
    new Uint32Array(geometry.getIndex()!.array),
  ] as [Float32Array, Uint32Array], [geometry]);

  useEffect(() => {
    console.info(`[plazas] ${PLAZA_BLOCKS.length} civic blocks paved, `
      + `${PLAZA_BLOCKS.reduce((s, b) => s + (b.acrossTo - b.acrossFrom) * (b.alongTo - b.alongFrom), 0).toFixed(0)} m²`);
  }, []);

  if (!site) return null;
  return (
    <group position={[site.centre[0], site.ground, site.centre[2]]} rotation={[0, site.heading, 0]}>
      <mesh geometry={geometry} material={material} receiveShadow />
      {/* Solid, so a car that mounts the kerb drives onto paving, not through it. */}
      <RigidBody type="fixed" colliders={false}>
        {/* The paving's own surface, so a cut corner is cut in the physics too. */}
        <TrimeshCollider args={collider} />
      </RigidBody>
    </group>
  );
}
