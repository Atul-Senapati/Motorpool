'use client';

import { useEffect, useMemo } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';
import {
  RAIL_HEAD_LIFT, trainNormalAt, trainPointAt, trainTangentAt, trainWrap,
} from '@/config/trainConfig';
import {
  AIRPORT_BRANCH, AIRPORT_JUNCTION, BRANCH_ROUTE, JUNCTION, JUNCTION_CURVE, branchPlaceAt, type BranchJunction,
} from '@/config/pointwork';
import { secondTrackGap } from '@/config/stationConfig';
import { groundHeightAt } from '@/physics/cityNav';

/**
 * Direction signs for the junction: which way the islands are.
 *
 * From the cab the points are one railway until the blades — a driver cannot
 * see which set of rails goes where (see `PointsAhead.hand`) — so the choice is
 * signed the way a motorway signs an exit: a gantry across both tracks, a
 * panel over each, well before the points and again close to them. Kept as
 * plain as the real thing: white on railway blue, an arrow and a name. The branch leaves to the LEFT of an up train, across the down line, so
 * the left panel (over the down line, on the driver's left) is Skylark and the
 * right panel (over the up line he is on) is straight on.
 *
 * The advance gantry is as far out as the line is in the open: 364 m back from
 * the toe it is in a bore. A third board stands over the branch itself, out on
 * the viaduct, to say where it goes.
 *
 * The airport junction is signed the same way, for the train that meets its
 * points facing: a DOWN train, running down the arc, with the branch to its
 * right — so its gantries have the main line on the left panel, over the up
 * line, and Halcyon Field on the right, over the down line it is on.
 */

/** Where the gantries stand, metres before the toe. */
const GANTRIES = [330, 190];
/** Metres along the branch from its toe for the board that says where it goes. */
const BRANCH_BOARD = 420;
const AIRPORT_BOARD = 300;

/** Heights over the rail head: clear of the catenary's messenger at 6.35 m. */
const BOARD_BOTTOM = 6.9;
const BEAM = 0.4;
/** A face's height for its width: the texture's own proportions, so type is never stretched. */
const PANEL_W = 1536;
const PANEL_H = 520;
const heightFor = (width: number, panels: number) => (width * PANEL_H) / (PANEL_W * panels);

interface Panel {
  arrow: 'left' | 'up' | 'right';
  title: string;
}

const FONT = '"Helvetica Neue", Arial, system-ui, sans-serif';

/**
 * One sign face, the way real ones are: white on railway blue, a thin white
 * border, a plain arrow and the destination's name — nothing else.
 */
function signTexture(panels: Panel[]): CanvasTexture {
  const P = PANEL_W;
  const w = P * panels.length;
  const h = PANEL_H;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1b3f73';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 14;
  g.strokeRect(22, 22, w - 44, h - 44);

  panels.forEach((p, i) => {
    const x0 = i * P;
    const midY = h / 2;
    if (i > 0) {
      g.fillStyle = '#ffffff';
      g.fillRect(x0 - 5, 22, 10, h - 44);
    }
    // A plain arrow; a diverging route leans 45°.
    const right = p.arrow === 'right';
    const ax = right ? x0 + P - 190 : x0 + 190;
    g.save();
    g.translate(ax, midY);
    g.rotate(p.arrow === 'left' ? -Math.PI / 4 : right ? Math.PI / 4 : 0);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -120);
    g.lineTo(80, -30);
    g.lineTo(28, -30);
    g.lineTo(28, 115);
    g.lineTo(-28, 115);
    g.lineTo(-28, -30);
    g.lineTo(-80, -30);
    g.closePath();
    g.fill();
    g.restore();
    g.fillStyle = '#ffffff';
    g.font = `bold 150px ${FONT}`;
    g.textAlign = right ? 'right' : 'left';
    g.textBaseline = 'middle';
    g.fillText(p.title, right ? x0 + P - 340 : x0 + 340, midY + 6, P - 420);
  });

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

interface Placed {
  /** The face's centre, and its size. */
  x: number; y: number; z: number; width: number; height: number;
  /** Yaw that turns the face towards a train arriving along (tx, tz). */
  yaw: number;
  /** Posts: foot and top, each side. */
  posts: Array<{ x: number; z: number; foot: number; top: number }>;
  texture: CanvasTexture;
  /** Length of the beam across the top, where it is not just the board's. */
  beam?: number;
}

/** A gantry across the running line, `before` metres short of junction `j`'s toe, facing a train that meets its points. */
function mainGantry(j: BranchJunction, before: number, panels: Panel[]): Placed {
  const s = trainWrap(j.toe - j.dir * before);
  const [x, y, z] = trainPointAt(s);
  const [nx, nz] = trainNormalAt(s);
  const [tx, tz] = trainTangentAt(s);
  const head = y + RAIL_HEAD_LIFT;
  const gap = secondTrackGap(s);
  // Posts on the deck, inside its parapets and clear of both tracks.
  const left = gap + 2.6;
  const right = -2.6;
  const mid = (left + right) / 2;
  const at = (o: number) => ({ x: x + nx * o, z: z + nz * o });
  const width = left - right - 0.6;
  const height = heightFor(width, 2);
  return {
    ...at(mid), y: head + BOARD_BOTTOM + height / 2,
    width, height,
    yaw: Math.atan2(-j.dir * tx, -j.dir * tz),
    posts: [left, right].map((o) => ({ ...at(o), foot: head - 0.35, top: head + BOARD_BOTTOM + height + BEAM })),
    texture: signTexture(panels),
  };
}

/**
 * The board over a branch viaduct: where this line goes. `b` is metres along
 * the route (`branchPlaceAt`), `way` which way along it the train reading the
 * board is running.
 */
function branchBoard(b: number, way: 1 | -1, title: string): Placed {
  const inner = branchPlaceAt(b, 0);
  const outer = branchPlaceAt(b, 1);
  const ahead = branchPlaceAt(b + 2 * way, 0);
  const cx = (inner.x + outer.x) / 2;
  const cz = (inner.z + outer.z) / 2;
  const tx = ahead.x - inner.x;
  const tz = ahead.z - inner.z;
  const l = Math.hypot(tx, tz) || 1;
  const head = inner.y + RAIL_HEAD_LIFT;
  // Outside the deck, on the ground: the branch deck is only as wide as its pair.
  const half = 5.6;
  const width = 6.5;
  const height = heightFor(width, 1);
  const posts = [-1, 1].map((side) => {
    const x = cx + inner.nx * half * side;
    const z = cz + inner.nz * half * side;
    return { x, z, foot: (groundHeightAt(x, z) ?? -9) - 0.5, top: head + BOARD_BOTTOM + height + BEAM };
  });
  return {
    x: cx, y: head + BOARD_BOTTOM + height / 2, z: cz, width, height,
    beam: half * 2,
    yaw: Math.atan2(-tx / l, -tz / l),
    posts,
    texture: signTexture([{ arrow: 'up', title }]),
  };
}

function Sign({ sign }: { sign: Placed }) {
  const { x, y, z, width, height, yaw, posts, texture } = sign;
  const beam = sign.beam ?? width + 0.8;
  const bx = x - Math.sin(yaw) * 0.1;
  const bz = z - Math.cos(yaw) * 0.1;
  return (
    <group>
      <mesh position={[x, y, z]} rotation={[0, yaw, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial map={texture} roughness={0.6} />
      </mesh>
      {/* Galvanised steel: the back of the board, the beam and the posts. */}
      <mesh position={[bx, y, bz]} rotation={[0, yaw, 0]} castShadow>
        <boxGeometry args={[width, height, 0.15]} />
        <meshStandardMaterial color="#9aa1a8" roughness={0.55} metalness={0.5} />
      </mesh>
      <mesh position={[bx, y + height / 2 + BEAM / 2, bz]} rotation={[0, yaw, 0]} castShadow>
        <boxGeometry args={[beam, BEAM, 0.4]} />
        <meshStandardMaterial color="#9aa1a8" roughness={0.55} metalness={0.5} />
      </mesh>
      {posts.map((p, i) => (
        <mesh key={i} position={[p.x, (p.foot + p.top) / 2, p.z]} rotation={[0, yaw, 0]} castShadow>
          <boxGeometry args={[0.35, p.top - p.foot, 0.35]} />
          <meshStandardMaterial color="#9aa1a8" roughness={0.55} metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

export function JunctionSigns() {
  const signs = useMemo(() => [
    // Left of an up train is the down line's side: that is where the branch goes.
    ...GANTRIES.map((before) => mainGantry(JUNCTION_CURVE, before, [
      { arrow: 'left', title: JUNCTION.name },
      { arrow: 'up', title: 'Main Line' },
    ])),
    branchBoard(BRANCH_BOARD, 1, JUNCTION.name),
    // Right of a down train is the down line's side, and the airport branch.
    ...GANTRIES.map((before) => mainGantry(AIRPORT_BRANCH, before, [
      { arrow: 'up', title: 'Main Line' },
      { arrow: 'right', title: AIRPORT_JUNCTION.name },
    ])),
    branchBoard(BRANCH_ROUTE.length - AIRPORT_BOARD, -1, AIRPORT_JUNCTION.name),
  ], []);
  useEffect(() => () => { for (const s of signs) s.texture.dispose(); }, [signs]);
  return (
    <group>
      {signs.map((sign, i) => <Sign key={i} sign={sign} />)}
    </group>
  );
}
